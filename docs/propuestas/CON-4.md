# CON-4 · Pantalla Conexiones — plan y lo que necesita Rasheed

Escrito para: Nicolás (dueño del módulo) y Rasheed (dueño de
`db/migrations/`, del despliegue y de los trámites).
Fecha: 23 de septiembre de 2026. Rama `nicolas/CON-4-pantalla-conexiones`,
worktree `rayit-con4`.

**Condición de apertura, y por qué se construye igual.** La fila de
CON-4 en `docs/backlog-mvp.md` §5 pide CON-3 *probada en vivo*
(CON-3.md §5) y `OAUTH_CONNECT=1` con credenciales en el vault. Eso
sigue **sin ocurrir**: no hay sandbox de TikTok ni app de Instagram en
modo desarrollo, y `oauth_connect` está apagada en producción (decisión
del 22-sep). Lo que se construye aquí es la pantalla, no el flujo: el
flujo ya está escrito y probado con respuestas grabadas en CON-3. La
pantalla se escribe para que **con la bandera apagada** sea la de
CON-10 (mejorada) y **con la bandera encendida** aparezcan «Conectar»,
«Reautorizar» y el paso manual. Así la prueba en vivo del día que
existan las credenciales es abrir la pantalla, no escribirla.

---

## 0. Plan (fase 1)

### 0.1 Qué se construye y dónde

| Archivo | Qué |
|---|---|
| `apps/web/app/(app)/conexiones/_lib/estado.ts` | **Nuevo.** Funciones puras: `claseDeAcceso(row)`, `estadoDeCuenta(row, now)` y `frescura(horas)`. Ninguna pantalla decide el color ni el texto con un `if` suelto. |
| `apps/web/app/(app)/conexiones/_lib/estado.test.ts` | **Nuevo.** Las tres funciones, caso por caso, en milisegundos. |
| `apps/web/app/(app)/conexiones/_lib/messages.ts` | **Nuevo.** Los textos del módulo en un solo sitio (convención de los pulidos de Rasheed). |
| `apps/web/app/(app)/conexiones/error.tsx` | **Nuevo.** El módulo no tenía frontera de error: caía en la de `(app)`. Ahora dice «No pudimos leer tus cuentas». |
| `apps/web/app/(app)/conexiones/loading.tsx` | Cambia: del esqueleto genérico al del módulo (formulario + tabla). |
| `apps/web/app/(app)/conexiones/conectar.tsx` | **Nuevo.** La sección «Conectar una cuenta autorizada», detrás de `oauth_connect`: un `ConnectDialog` por red con su motivo cuando falta configuración. |
| `apps/web/app/(app)/conexiones/pasos-manuales.tsx` | **Nuevo.** El panel del paso manual, con el `message_es` de `tt.insights.optin` leído de la base. |
| `apps/web/app/(app)/conexiones/connect-dialog.tsx` | Cambia: acepta `variant: "danger"` (el «Reautorizar» en rojo) y un título propio del diálogo. |
| `apps/web/app/(app)/conexiones/page.tsx` | Cambia: una sola tabla con las dos clases de fila, columna «Acceso», columna «Última lectura» con las horas, estado derivado y acciones por fila. |
| `apps/web/app/(app)/conexiones/actions.ts` | Cambia: los `TODO(ACC-1)`/`TODO(ACC-2)` de cada acción (ACC-1 no está en `main`). |
| `apps/web/app/(app)/conexiones/pagina.test.tsx` | **Nuevo.** La página entera contra Postgres embebido con el escenario del `--demo` del worker. |
| `packages/db/src/queries/conexiones.ts` | Cambia: `getMetricRequirement(tx, id)` sobre el catálogo `metric_requirement` (0011). |
| `apps/web/content/backlog.ts` | Cambia: **solo** mi fila CON-4. |
| `docs/backlog-mvp.md` | Cambia: **solo** la fila CON-4 de §5. |

No se toca ninguna migración, ningún archivo de Rasheed y ninguna
dependencia nueva.

### 0.2 Decisiones

**1. Una tabla, no dos.** La historia lo pide («una sola tabla sobre
`connection_health` con las dos clases de fila») y la base lo permite:
`listAccounts` ya devuelve las dos, porque `connection_health` es
`social_connection` viva sin distinguir `access_mode`.
*Descartado:* dos tablas («Cuentas por @» y «Cuentas autorizadas»).
Leen mejor por separado, pero rompen la pregunta que una creadora se
hace de verdad —«¿de dónde salen las cifras de esta cuenta?»— y
duplicarían el estado vacío, el orden y las acciones.

**2. Cómo se distinguen a simple vista: una columna «Acceso», no un
color de fila.** Una pastilla por fila: «Por @» en tono neutro,
«Autorizada» en el tono de acento. Texto distinto **y** color distinto
(AA en los dos temas), porque el color nunca puede ser el único
indicador.
*Descartado:* sangrar o teñir la fila entera (se pierde al hacer scroll
horizontal, que es lo que pasa a 400 px) y un icono de candado sin
texto (no se lee en voz alta y no dice cuál es cuál).

**3. El estado se deriva; no se copia `status`.** `social_connection
.status` es lo que el worker dejó la última vez. Un token que **ya
venció** puede seguir con `status = 'active'` si `oauth.refresh` no ha
corrido (en producción todavía no corre: CIM-7). `estadoDeCuenta`
compara `accessExpiresAt` con el reloj y devuelve «Vencida» en rojo con
el botón de reautorizar aunque la columna diga `active`. Los casos:

| Situación | Pastilla | Acción |
|---|---|---|
| `status = 'needs_reauth'` | rojo · «Necesita reautorizar» | Reautorizar |
| `status = 'expired'` **o** `access_expires_at <= ahora` | rojo · «Vencida» | Reautorizar |
| `status = 'revoked'` | rojo · «Revocada» | Reautorizar |
| `status = 'error'` | rojo · «No se pudo leer» | Actualizar (no es un problema de permiso) |
| `status = 'disabled'` | neutro · «Quitada» | — |
| activa y `token_expiring_soon` | ámbar · «Vence pronto» | Actualizar |
| activa | verde · «Activa» | Actualizar |

Una cuenta **por @** no tiene token: nunca vence y nunca ofrece
reautorizar. Sus únicos estados son «Activa», «No se pudo leer» y
«Quitada».
*Descartado:* mostrar `status` tal cual. Es lo que hacía CON-10 y es
justo lo que el «terminado cuando» de CON-4 prohíbe: con el token
vencido y el worker parado, la fila se veía verde.

**4. Las horas desde `last_synced_at` se leen en la vista, no se
calculan en React.** `connection_health.hours_since_sync` ya viene de
0010 y `listConnections` ya la trae. `frescura(horas)` solo la pone en
palabras: «hace 3 horas», «hace 2 días», «hace un momento». Sin
lectura, una frase —«Sin leer todavía»—, nunca un guion ni un cero.

**5. «Conectar» va en su propia sección, no en la cabecera de la
tabla.** Conectar una cuenta autorizada es empezar un flujo con
consentimiento: necesita su título, su explicación y un botón por red.
Va **debajo** del formulario «Agregar cuenta» (el camino del MVP) y
**encima** de la tabla, y solo existe con `oauth_connect`.
*Descartado:* un botón «Conectar» en la barra de la tabla: no cabe el
diálogo ni el motivo de «sin configurar» a 400 px.

**6. Qué redes ofrecen «Conectar»: TikTok e Instagram.** Son los dos
proveedores de CON-3 pensados para el creador. `tiktok-business` (la
Accounts API, «analítica avanzada») se queda fuera de esta pantalla:
depende de un trámite que no está hecho (CON-9) y, presentada como una
cuarta «red», haría que una creadora eligiera entre dos TikToks.
YouTube no tiene OAuth todavía (CON-8, pospuesta) y sigue por @.
*Consecuencia:* si una red está en `oauth_connect` pero sin variables,
el botón sale deshabilitado diciendo exactamente qué falta
(`loadOAuthApps().missing`), nunca desaparece en silencio.

**7. «Reautorizar» reusa el mismo `POST …/start`.** No hay ruta nueva:
el callback de CON-3 hace `upsertConnection`, que por el UNIQUE
`(platform_id, external_account_id, workspace_id)` **reactiva** la fila
—`status = 'active'`, `status_detail = NULL`, `consecutive_failures = 0`,
`secret_ref` reutilizada— en vez de crear otra. Lo único que cambia es
el botón: `variant="danger"`, el texto «Reautorizar» y un diálogo que
dice que el permiso caducó. Una cuenta de TikTok agregada por @ que ya
se había autorizado vuelve por `findPublicAccountByHandle` a la misma
fila (CON-10 §7).

**8. El paso manual se lee de la base.** El texto de «Activa Analytics
en TikTok» es `metric_requirement.message_es` de `tt.insights.optin`
(0011), un catálogo global de solo lectura para `mc_app` (0024 §7.1).
Se lee con `getMetricRequirement(tx, 'tt.insights.optin')` dentro de la
misma transacción de workspace. Sin números ni textos mágicos.
*Descartado:* copiar la frase a `messages.ts`. Sería una segunda fuente
de verdad de algo que la base ya tiene y que CON-7 volverá a leer.
*Dónde se ve:* un panel debajo de la tabla, solo si hay al menos una
cuenta de TikTok **autorizada** (sin token no hay API que desbloquear).

**9. Permisos y bitácora: marcadores, no invención.** ACC-1 no está en
`main` (no existe `packages/core/src/permisos.ts` en ninguna rama
remota). Cada Server Action y la ruta `start` llevan
`// TODO(ACC-1): conexiones.cuenta.<ver|conectar|desconectar>` en la
primera línea, y las escrituras de cuenta conectada,
`// TODO(ACC-2): audit(...)`. Inventar aquí un `requirePermission`
propio sería construir el catálogo de ACC-1 desde el módulo equivocado.

**10. Formato por `formatterFor`.** La pantalla de CON-10 usaba
`formatInt`/`formatDelta` sueltos, con el locale por omisión. Pasa a
`formatterFor(await getCurrentWorkspace())`, como el resto del
producto: un workspace en otro país ve sus cifras y sus fechas.

### 0.3 Decisiones pendientes de Nicolás (se tomó la opción conservadora)

1. **DECISIÓN PENDIENTE DE NICOLÁS · ¿«Reautorizar» debería poder
   quitar la cuenta rota?** Hoy, junto a «Reautorizar» queda «Quitar»,
   que revoca los consentimientos y borra el ciphertext. No se añade
   ningún «Olvidar y volver a empezar» porque reautorizar sobre la
   misma fila conserva el historial, que es lo que vale. Si prefieres
   el camino destructivo visible, es un botón más.
2. **DECISIÓN PENDIENTE DE NICOLÁS · ¿Se avisa de «Vence pronto»?**
   `token_expiring_soon` es cierto 24 h antes. Se muestra en ámbar,
   pero **no** se manda notificación ni correo: eso es del worker
   (`oauth.refresh` ya crea `notification`) y no de esta pantalla.
3. **DECISIÓN PENDIENTE DE NICOLÁS · ¿`tiktok-business` en la
   pantalla?** Se deja fuera (decisión 6). Si el trámite de CON-9 sale
   antes de lo previsto, entra con una línea.

### 0.4 Fuera de alcance (y a qué historia va)

- Videos y métricas por video de una cuenta autorizada → **CON-5**.
- Demografía y el resto de `metric_requirement` → **CON-7**.
- OAuth de YouTube → **CON-8**.
- Notificaciones de token por vencer → ya las crea **CON-2**
  (`oauth.refresh`); la bandeja es de otra historia.
- `requirePermission` y `audit()` reales → **ACC-1** y **ACC-2**.
- Desplegar con `OAUTH_CONNECT=1` y la prueba en vivo → **CON-3 §5**.

---

## 1. Lo que necesita Rasheed

**Nada que aplicar.** Esta historia no trae migración, no toca
`db/migrations/`, ni `lib/auth/`, ni `lib/workspace/`, ni
`packages/db/src/{client,schema}`, ni ningún seed. Lo único que pide es
lo que ya estaba pedido:

1. **Las migraciones 0024 a 0033 siguen pendientes de aplicar** en
   Supabase (cola única del integrador). La pantalla no las necesita:
   lee `connection_health` (0010), `social_connection` (0002),
   `account_metric_snapshot` (0002/0022) y `metric_requirement` (0011),
   todas aplicadas.
2. **Para encender la pantalla completa** hacen falta, en Vercel y en
   el vault, las variables de CON-3 §3 y `OAUTH_CONNECT=1`. Son de
   Nicolás; aquí solo se anotan los nombres, nunca los valores.
