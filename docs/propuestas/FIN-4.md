# FIN-4 · Recordatorios de cobro — plan y lo que necesita Rasheed

Escrito para: Nicolás (dueño de Finanzas) y Rasheed (dueño de
`db/migrations/`, del despliegue del worker y de la cola del
integrador). Fecha: 23 de septiembre de 2026. Rama
`nicolas/FIN-4-recordatorios-cobro`, worktree `rayit-fin4`.

La historia: cada día, para cada factura `sent` o `partial`, el job
`finance.reminders` decide en qué paso está respecto a `due_on`, redacta
el correo en español y lo deja como `notification` de tipo
`invoice_overdue`, listo para copiar. **No envía nada**: el envío por
SMTP es fase 2 (depende de CIM-10).

---

## 0. Plan (fase 1)

### 0.1 Lo que se comprobó antes de diseñar

| Qué | Dónde | Resultado |
|---|---|---|
| `job_definition` de `finance.reminders` | `db/migrations/0009` línea 46 | Ya existe: cola `finance`, cron `0 10 * * *`, `timeout_s` 120, `max_attempts` 1. **No hace falta migración.** |
| `invoice.reminders_sent` / `last_reminder_at` | `db/migrations/0008` líneas 294-295 | `int NOT NULL DEFAULT 0` y `timestamptz` nullable. Existen y nadie las escribe todavía. |
| `notification` | `db/migrations/0009` líneas 76-99 | `invoice_overdue` ya está en el CHECK de `kind`; hay `severity`, `entity_type`, `entity_id`, `action_url`, `read_at`, `dismissed_at`, `emailed_at`. **Ninguna columna nueva hace falta.** |
| RLS de `notification` | `db/migrations/0010` línea 242 | `notification_ws_isolation USING (workspace_id = current_workspace_id())`, sin `WITH CHECK` propio: Postgres lo usa también para el INSERT. La web lee y escribe sus propias filas y ninguna ajena. |
| Notificaciones en el seed | `db/seed/*.sql` | **Cero filas.** Ningún seed inserta en `notification`. |
| FV-2026-007 | `db/seed/0003` línea 341 | `due_on = CURRENT_DATE - 41`, `status 'sent'`, `paid_amount 0`, `reminders_sent = 2`, `last_reminder_at = now() - 3 días`. Id `00000003-0000-4000-8000-0000fac26007`, workspace Laura, empresa Hogar Lindo, campaña `…ca0004`. |
| FIN-8 (datos de pago) | `docs/backlog-mvp.md` línea 325, `docs/propuestas/` | **No existe**: ni propuesta, ni tabla, ni columnas. El texto tiene que funcionar sin datos de pago y decir cómo configurarlos. |
| ACC-1 (`requirePermission`) y ACC-2 (`audit()`) | `apps/web/lib/`, `packages/db/src/audit.ts` | **No están en main.** Van como `// TODO(ACC-1)` y `// TODO(ACC-2)`, según la regla del repositorio. |

### 0.2 Decisión 1 · Los pasos, y por qué son *tres* y no cuatro

Los cinco pasos y sus tonos:

| Paso | Día respecto a `due_on` | Tono | `severity` |
|---|---|---|---|
| 1 | −7 | recordatorio amable | `info` |
| 2 | 0 | aviso de vencimiento | `info` |
| 3 | +7 | primer aviso de mora | `warning` |
| 4 | +21 | segundo aviso de mora | `warning` |
| 5 | +45 | aviso formal | `critical` |

`pasoRecordatorio(dueOn, hoy) → 0..5` devuelve el paso más alto cuyo día
ya pasó; `0` es «todavía no toca» (faltan más de 7 días).

**El paso 1 caduca al vencer la factura.** Su texto dice «vence en N
días»; emitirlo para una factura con 41 días de mora sería decir algo
falso. La regla, en una frase: *un paso solo se emite mientras su texto
siga siendo cierto*. En código, `vigente(paso, díasHastaElVencimiento)`:
el paso 1 exige `días ≥ 1`; los demás no caducan porque su texto se
redacta con los días de mora reales, no con una constante.

Con eso, una factura vencida hace 41 días sin recordatorios previos
tiene pendientes los pasos **2 (día 0), 3 (+7) y 4 (+21)** — tres, que
es exactamente lo que dice el enunciado de la historia. El paso 5 (+45)
todavía no llegó.

### 0.3 Decisión 2 · Cuántos se emiten por corrida, y qué queda en `reminders_sent`

**DECISIÓN PENDIENTE DE NICOLÁS.** El prompt propone como opción
conservadora «solo el más reciente por corrida, pero `reminders_sent`
salta al número del paso», y afirma que con eso el «terminado cuando»
del backlog se cumple porque FV-2026-007 trae `reminders_sent = 2` y el
job emite el tercero. **Lo comprobé y esa premisa no se sostiene**, por
dos razones independientes:

1. **No hay notificaciones sembradas.** Ningún seed escribe en
   `notification` (comprobado arriba). El `reminders_sent = 2` de
   FV-2026-007 es historia ficticia sin filas detrás. Con «solo el más
   reciente» la bandeja mostraría **un** recordatorio, no tres.
2. **El número tampoco daría 3.** Con 41 días de mora el paso más
   reciente es el **4** (+21), no el 3: `reminders_sent` saltaría a 4.

El criterio de aceptación del backlog (`docs/backlog-mvp.md` línea 321 y
`content/backlog.ts` línea 550) es literal: *«Una factura vencida hace
41 días tiene sus tres recordatorios en la bandeja con reminders_sent =
3»*. Mando el criterio de aceptación, no la opción conservadora, y
elijo:

- **Se emiten todos los pasos pendientes en la misma corrida** (ponerse
  al día), no solo el más reciente. Riesgo de inundar: **ninguno hoy**,
  porque el job no envía nada — escribe borradores en una bandeja que el
  creador lee cuando quiere. La cautela de «no inundar» es real en la
  fase 2 (SMTP) y ahí sí corresponde: se envía solo el último y los
  demás quedan como historial. Lo dejo escrito en §2.
- **`reminders_sent` = cuántos recordatorios existen para esa factura**,
  y nunca baja: `GREATEST(reminders_sent, <recordatorios en la
  bandeja>)`. Es un contador, no un puntero al paso; así el número de la
  ficha y las filas de la bandeja siempre coinciden, que es lo que
  cualquiera espera al leer «Recordatorios enviados: 3».

Resultado con el seed: FV-2026-007 termina con **tres** notificaciones
(pasos 2, 3 y 4) y `reminders_sent = 3`. El criterio se cumple al pie de
la letra.

Si prefieres «solo el más reciente», es una línea:
`pasosPendientes()` ya devuelve la lista ordenada y el job tomaría
`.slice(-1)`. Está marcado con un comentario en el job.

### 0.4 Decisión 3 · Idempotencia: `action_url`, no `title_es`

Una notificación por `(factura, paso)`, **sin columna nueva**. La
búsqueda previa es por `workspace_id` + `kind = 'invoice_overdue'` +
`entity_type = 'invoice'` + `entity_id` + el paso codificado en

```
action_url = /finanzas/facturas/<id>?recordatorio=<paso>
```

Por qué `action_url` y no `title_es`: el título es texto de producto y
se va a reescribir (es lo primero que se pule). Si la idempotencia
colgara del título, cambiar una palabra reemitiría todos los
recordatorios de todas las facturas. `action_url` además ya tiene que
existir —es el enlace de la fila en la bandeja— y es legible por
máquina sin analizar prosa.

No propongo columna nueva ni migración. Lo que **sí** propongo a Rasheed
(§2) es un índice único parcial que convierta la garantía en una
invariante de la base; hoy la garantía la dan la cola `stately` (una
corrida a la vez) y un `INSERT … WHERE NOT EXISTS` dentro de la misma
transacción.

### 0.5 Decisión 4 · El texto vive en `@mc/core`, puro

`packages/core/src/recordatorios.ts` exporta
`redactarRecordatorio(input) → { asunto, cuerpo }` a partir de
`{ paso, numero, empresa, total, pendiente, vencimiento, dias, moneda,
locale, zonaHoraria, datosDePago?, nombreCreador }`. Texto plano, sin
HTML, con marcadores claros y saltos de línea; formateado con `Intl`
(que es global en Node y ya se usa en `core/zonas.ts`), con el locale y
la moneda **del workspace**, nunca `es-CO` ni `COP` a mano.

- Sin datos de pago (FIN-8 no existe): el cuerpo **no** inventa ni deja
  un hueco mudo; escribe una línea que dice que los datos de pago se
  configuran en Finanzas → Configuración (FIN-8) y que mientras tanto se
  escriben a mano. Una ausencia se explica con una frase.
- `pendiente` es el saldo (`total − paid_amount`): en una factura
  `partial` el recordatorio va **sobre el saldo**, y el texto lo dice
  con las dos cifras.
- Nunca un cero donde falta un dato: si no hay nombre de campaña, la
  frase lo omite; no escribe «campaña: —».

### 0.6 Decisión 5 · Cuándo no se hace nada

`paid`, `void` y `draft` → nada, y no se tocan `reminders_sent` ni
`last_reminder_at`. El SELECT del job ya filtra `status IN ('sent',
'partial')`, que es el mismo conjunto que `deriveStatus` considera
vencible. Una factura `partial` con saldo cero no existe (la máquina de
estados de FIN-1 la habría pasado a `paid`), pero el job la salta por si
acaso y lo cuenta en `skipped`.

### 0.7 Decisión 6 · La bandeja

`listReminders(tx)` sobre `notification` del workspace: `kind =
'invoice_overdue'`, `dismissed_at IS NULL`, ordenadas por severidad y
fecha. Devuelve también el número y la empresa de la factura (JOIN con
`invoice`), para que la fila se lea sola. **«Marcar como enviado» =
`read_at`**: es lo que ya significa la columna (lo vi, lo despaché) y
evita inventar semántica nueva; `emailed_at` se queda libre para cuando
el envío sea real (fase 2), que es su significado literal.

La bandeja sale en `/finanzas`, encima de la tabla de facturas (es lo
accionable del día), y los recordatorios de una factura concreta salen
en su detalle. A 400 px el cuerpo del correo va en un bloque con
`white-space: pre-wrap` y `overflow-wrap`, sin scroll horizontal.

### 0.8 Archivos

```
packages/core/src/recordatorios.ts          NUEVO · pasos, vigencia y redacción (puro)
packages/core/src/index.ts                  + 1 línea de reexport
packages/core/test/recordatorios.test.ts    NUEVO
apps/worker/src/jobs/finanzas/recordatorios.ts  NUEVO · el job finance.reminders
apps/worker/src/jobs/finanzas/index.ts          NUEVO
apps/worker/src/jobs/index.ts               + 1 línea (la única fuera de mi carpeta)
apps/worker/test/recordatorios.test.ts      NUEVO · arnés con pglite y el seed
packages/db/src/queries/finanzas.ts         + listReminders, listRemindersForInvoice, markReminderSent
packages/db/test/finanzas.test.ts           + pruebas de las tres
apps/web/app/(app)/finanzas/bandeja.tsx     NUEVO · la bandeja (servidor)
apps/web/app/(app)/finanzas/copiar.tsx      NUEVO · botón copiar (cliente)
apps/web/app/(app)/finanzas/recordatorios-actions.ts  NUEVO · «Marcar como enviado»
apps/web/app/(app)/finanzas/_lib/messages.ts          + los textos de la bandeja
apps/web/app/(app)/finanzas/page.tsx                  + la sección
apps/web/app/(app)/finanzas/facturas/[id]/page.tsx    + los recordatorios de la factura
apps/web/app/(app)/finanzas/loading.tsx               + el esqueleto de la bandeja
apps/worker/README.md · apps/web/README.md · content/backlog.ts
```

Sin migraciones, sin dependencias nuevas, sin variables de entorno
nuevas.

### 0.9 Dudas para Nicolás

1. La de §0.3 (todos los pasos pendientes vs. solo el más reciente).
2. `read_at` como «marcado enviado» (§0.7): si prefieres que
   «Marcar como enviado» escriba `emailed_at` aunque no haya SMTP, es un
   cambio de una línea en la query — pero entonces la fase 2 no puede
   distinguir «lo mandé yo a mano» de «lo mandó el sistema».
