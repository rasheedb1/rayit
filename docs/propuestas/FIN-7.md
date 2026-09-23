# FIN-7 · Ingresos de plataformas — plan y lo que necesita Rasheed

Escrito para: Nicolás (las decisiones marcadas) y Rasheed (dueño de
`db/migrations/`, del despliegue y de la cola de migraciones).
Fecha: 23 de septiembre de 2026. Rama `nicolas/FIN-7-ingresos-plataformas`,
worktree `rayit-fin7`. Creada desde `origin/main` en 29460e3 y con
`origin/main` integrado después, cuando entraron **ACC-1** (permisos),
**ACC-2** (bitácora) y **FIN-6** (flujo de caja). Lo que ese merge
cambió del plan está en §0.6.

---

## 0. Plan (fase 1)

### 0.1 Lo que se comprobó antes de diseñar

| Qué | Dónde se miró | Resultado |
|---|---|---|
| `platform_payout` | `db/migrations/0008_quotes_campaigns_finance.sql:337` | Existe con `creator_id`, `platform_id`, `period_start`, `period_end`, `amount numeric(14,2)`, `currency char(3)`, `source IN ('api','csv_import','manual')`. **No tiene ningún índice ni UNIQUE.** |
| RLS de `platform_payout` | `db/migrations/0010_views_rls.sql:242` | Está en la lista: `ENABLE` + `FORCE` + política `workspace_id = current_workspace_id()`. `mc_app` conserva los cuatro privilegios (no está en `PRIVILEGIOS_DE_LA_APP`, así que no se le revocó nada en 0024/0025). |
| Esquema Drizzle | `packages/db/src/schema/finanzas.ts:75` | `platformPayout` ya está declarado y `schema.test.ts` solo compara columnas, no índices. |
| `packages/core/src/flujo-caja.ts` | `git ls-tree` sobre todas las ramas | Al escribir el plan no existía. **Mientras se implementaba FIN-7, FIN-6 entró en `main`** con su propio `flujo-caja.ts` (`projectCashflow`), su pantalla `/finanzas/flujo` y su `getCashflowInputs`. Ver 0.6. |
| Parser de CSV | `apps/web/lib/csv.ts`, `app/(app)/resumen/importar/_lib/csv.ts` y `_lib/formatos.ts` | `decodificarCsv` (UTF-8 estricto → Windows-1252), `leerCsv` (Papaparse, delimitador autodetectado, `MAX_FILAS`), `aNumero` (miles/decimales de hoja de cálculo), `normalizar` (encabezado → clave comparable). Se **reutilizan**, no se copian. |
| Número de migración libre | `git fetch` + `git ls-tree` en TODAS las ramas, dos veces (antes y después del merge) | La primera vez el más alto era `0033`; la segunda, `0035` (`0034_access_control` ya en `main`, `0035_membership_scope` en ACC-6 y `0035_brand_snapshot_por_campana` en CAM-3). La migración de FIN-7 es **0036**. `0023` sigue reservado por la propuesta ACC y no se recicla. |
| Permisos y bitácora | `packages/core/src/permisos.ts`, `packages/db/src/audit.ts`, `packages/db/test/accesos.test.ts` | ACC-1 y ACC-2 ya están en `main`, así que FIN-7 no lleva ningún `TODO(ACC-…)`. El catálogo de permisos viaja en la semilla de `0034_access_control` y `accesos.test.ts` exige que esa semilla sea, línea por línea, la salida del script de ACC-1: **añadir un permiso obligaría a editar una migración ya escrita en `main`**. Ver 0.5.9. |

### 0.2 Lo que dice la documentación oficial de los dos formatos

Consultado el 23 de septiembre de 2026.

- **AdSense.** La [lista de métricas y dimensiones de la AdSense
  Management API](https://developers.google.com/adsense/management/metrics-dimensions)
  fija el formato de las dimensiones de tiempo: `DATE` es `YYYY-MM-DD`,
  `MONTH` es `YYYY-MM` y `WEEK` es el `YYYY-MM-DD` del primer día de la
  semana. La métrica de ingresos es `ESTIMATED_EARNINGS` («Ingresos
  estimados» / «Estimated earnings»), y **la moneda no va en una
  columna**: la documentación repite «see headers in the response for
  the currency». La descarga desde el panel
  ([Exportar o descargar un informe](https://support.google.com/adsense/answer/9830628))
  ofrece CSV, XLSX y Hojas de cálculo, y **no publica los nombres de
  columna**, que además salen en el idioma de la cuenta.
- **TikTok Creator Rewards.** El
  [soporte de TikTok](https://support.tiktok.com/en/business-and-creator/creator-rewards-program/how-rewards-work)
  describe un panel de *estimated rewards* que se consolida en un
  **balance mensual** el día 1 y se paga el 15 si supera 10 USD o su
  equivalente local. **No documenta ninguna exportación CSV**: lo único
  descargable es la factura de una transacción suelta.

**Conclusión, y es la misma que ya dejó escrita RES-2** en
`apps/web/test/fixtures/csv/README.md`: no hay un contrato de columnas
contra el que programar. Por eso el lector **no exige una firma exacta**:
detecta por alias (español e inglés), y lo que no reconoce cae al
formato genérico, que sí está bajo nuestro control porque lo
documentamos nosotros.

### 0.3 Qué se construye

```
platform/db/migrations/0036_platform_payout_unico.sql      UNIQUE natural (idempotencia del import)

platform/packages/core/src/ingresos-plataformas.ts         NUEVO. promedioMensual(), proyeccionDePlataformas()
platform/packages/core/src/index.ts                        + export
platform/packages/core/test/ingresos-plataformas.test.ts
platform/packages/core/src/flujo-caja.ts                   (FIN-6) + otrosIngresosMensual de entrada y
                                                             otrosIngresos por semana en la salida
platform/packages/core/test/flujo-caja.test.ts             + describe «otros ingresos»

platform/packages/db/src/audit.ts                          + platform_payout.created / .imported
platform/packages/db/src/queries/finanzas.ts               + listPlatformPayouts, getPlatformPayoutMonths,
                                                             getPlatformPayoutKpis, listPayoutPlatforms,
                                                             importPlatformPayouts, createPlatformPayout;
                                                             getCashflowInputs alimenta otrosIngresosMensual
platform/packages/db/test/finanzas.test.ts                 + describe «ingresos de plataformas»

platform/apps/web/app/(app)/finanzas/flujo/page.tsx        (FIN-6) columna, barra y nota de «Otros ingresos»
platform/apps/web/app/(app)/finanzas/_lib/messages.ts      + flujo.otrosIngresos y tabla.otros

platform/apps/web/app/(app)/finanzas/ingresos/
  page.tsx  loading.tsx  error.tsx  actions.ts
  _lib/csv.ts            lector: detección por cabecera, 3 formatos, códigos (no frases)
  _lib/csv.test.ts
  _lib/messages.ts       TODOS los textos del submódulo
  importar/page.tsx + form.tsx
  nuevo/page.tsx + form.tsx
  integracion.test.ts    el «terminado cuando», de punta a punta contra pglite

platform/apps/web/test/fixtures/csv/ingresos/              un fixture por formato + README
platform/apps/web/app/(app)/finanzas/page.tsx              + botón «Ingresos»
platform/apps/web/content/backlog.ts                       estado y nota de FIN-7 (solo mi entrada)
docs/propuestas/FIN-7.md                                   este archivo
```

### 0.4 Formatos soportados y cómo se detectan

La detección mira **los encabezados ya normalizados** (`normalizar()` de
`resumen/importar/_lib/formatos.ts`: sin mayúsculas, sin tildes, sin
puntuación). Gana el formato con más encabezados característicos; en
empate, el genérico.

| Formato | Lo delata | Periodo | Monto | Moneda |
|---|---|---|---|---|
| `adsense` | una columna de mes o fecha **y** una de ingresos estimados (`estimated earnings`, `ingresos estimados`, `earnings`, `ganancias`) | `YYYY-MM` → mes entero; `YYYY-MM-DD` → **se suman las filas del mismo mes** | la columna de ingresos | columna `currency`/`moneda` si la hay; si no, el paréntesis del encabezado (`Estimated earnings (USD)`); si no, la del espacio |
| `tiktok_rewards` | una columna de mes o fecha **y** una de recompensas (`estimated rewards`, `rewards`, `recompensas`, `ingresos estimados`) | igual que AdSense | la columna de recompensas | igual que AdSense |
| `generico` | `plataforma`, `inicio`, `fin`, `monto` (y opcional `moneda`) | `inicio`..`fin` tal cual | `monto` | `moneda`, o la del espacio |

La plataforma de un archivo de AdSense es `youtube` y la de Creator
Rewards es `tiktok` (fijas por formato); el genérico la lee de la fila y
la valida contra el catálogo `platform` (`tiktok`, `instagram`,
`facebook`, `youtube`).

**Por qué AdSense es `youtube` y no una plataforma nueva:** el catálogo
`platform` de 0002 tiene cuatro filas y es un catálogo global que solo
toca una migración. Una fila `adsense` sería una migración de catálogo y
una decisión de producto («¿AdSense es una red?»), no parte de esta
historia. Un pago de AdSense de un creador de On Cue viene de su canal
de YouTube. **DECISIÓN PENDIENTE DE NICOLÁS** si quieres separarlas.

### 0.5 Decisiones

1. **Filas duplicadas: UNIQUE natural en la base, no en el código.**
   `0036` crea
   `platform_payout_natural_uidx` sobre
   `(workspace_id, platform_id, coalesce(creator_id, uuid cero), period_start, period_end, currency, amount)`
   y el import escribe con `ON CONFLICT DO NOTHING`. Es lo que pide la
   historia (plataforma + periodo + monto) más `workspace_id` (sin él
   sería un único global, que la guardia de `packages/db/src/esquema.ts`
   rechaza con razón), `currency` (dos monedas distintas no son la misma
   fila) y `creator_id` **normalizado con `coalesce`**: un índice único
   trata dos `NULL` como distintos, así que sin el `coalesce` dos
   importaciones seguidas de un pago sin creador se duplicarían, que es
   exactamente lo que la historia pide evitar. No se usa
   `NULLS NOT DISTINCT` porque es de PostgreSQL 15+ y la prueba corre
   sobre pglite; el `coalesce` funciona en cualquier versión.
   *Descartado:* deduplicar leyendo antes y comparando en TypeScript —
   es una condición de carrera con dos pestañas abiertas, y la
   idempotencia de dinero no puede depender de que nadie pulse dos veces.
2. **El monto SÍ entra en la clave, y el cambio de monto se avisa.** Con
   el monto dentro, volver a subir el mismo archivo no escribe nada
   (el «terminado cuando»), pero un archivo **corregido** crearía una
   segunda fila del mismo mes y el mes valdría el doble, en silencio.
   Por eso el import, antes de escribir, mira qué periodos ya existen
   con **otro** monto y los deja fuera con un aviso con nombre
   (`montoDistinto`), en vez de insertarlos o de sobrescribirlos.
   Corregir un monto ya cargado no está en esta historia (no hay editar
   ni borrar): ver 0.7.
3. **Moneda distinta: fuera, con aviso.** Una fila cuya moneda no es la
   del espacio no se escribe y sale contada en el resumen con su moneda.
   Sumar dos monedas necesita una tasa de cambio con fecha, que no está
   en el esquema y que es una historia aparte. Si el archivo **no dice**
   la moneda por ningún lado, se toma la del espacio y el resumen lo
   dice con esa frase; no se adivina en silencio.
4. **El promedio de tres meses es del espacio y en su moneda.** Solo
   entran los meses **cerrados** (el mes en curso no, porque está a
   medias y hundiría el promedio) y solo los pagos en la moneda del
   espacio. Con cero meses con datos el estimado es **`null`, no cero**:
   la pantalla escribe «Todavía no hay meses cerrados con ingresos de
   plataformas» y no una cifra.
   *Descartado:* rellenar con ceros los meses sin datos — convertiría
   «no sabemos» en «no entró nada», que es la regla del repositorio que
   más veces se ha roto.
5. **Sin editar ni borrar.** La historia es «carga manual o por CSV,
   lista por mes y entrada al flujo de caja». Un `platform_payout`
   equivocado se corrige hoy por SQL. Ver 0.7.
6. **El import es una Server Action con el archivo, no un route
   handler.** RES-6 le puso un route handler propio a Resumen porque su
   lote son 5 MB; un CSV de pagos de plataforma son doce filas. El techo
   aquí es **256 KB** (por debajo del 1 MB por defecto de las Server
   Actions de Next), y por encima se rechaza con su frase.
7. **Un solo paso, sin asistente de tres pasos.** El de Resumen existe
   porque hay catorce campos que mapear a mano. Aquí hay tres
   (periodo, monto, moneda) y el archivo o se entiende o no. El
   resultado se cuenta después de escribir: cuántas entraron, cuántas ya
   estaban, cuántas quedaron fuera y por qué.

8. **El estimado NO entra en la base de la reserva de impuestos.** En
   `projectCashflow`, `impuestos` se calcula sobre los cobros a marcas,
   cuya retención y cuyo IVA conocemos (FIN-1, FIN-8). Lo que paga una
   plataforma extranjera tributa de otra forma, y apartar un porcentaje
   sobre una cifra **estimada** sería inventar dos veces. La nota del
   gráfico lo dice con esas palabras. **DECISIÓN PENDIENTE DE NICOLÁS**
   si quieres que sí entre.
9. **Permisos: se reutilizan, no se inventan.** Ver
   `/finanzas/ingresos` pide `finanzas.flujo.ver` y escribir pide
   `finanzas.pago.registrar`. Lo natural sería un par
   `finanzas.ingreso.ver` / `finanzas.ingreso.registrar`, pero el
   catálogo viaja en la semilla de `0034_access_control`, que ya está en
   `main`, y `packages/db/test/accesos.test.ts` exige que esa semilla
   sea **línea por línea** la salida del script de ACC-1: añadir dos
   permisos obligaría a editar una migración escrita y aplicada. Lo que
   haría falta está en §1.2. Con los que se usan, el reparto sale
   correcto igual: el **Contador** los tiene (lleva todo Finanzas) y el
   **Mánager** no (decisión E), que es lo que se quiere.
   **DECISIÓN PENDIENTE DE NICOLÁS.**
10. **Un periodo que no ha cerrado no se carga.** El mes en curso es
   «lo que va del mes», no un pago: contarlo entero hundiría el promedio
   y la lista lo enseñaría como cerrado. En el CSV es un **aviso** por
   mes (no por fila: treinta días de septiembre son un mes abierto, no
   treinta avisos) y en el formulario es un error de campo. La
   comprobación usa el día del espacio, y el lector la salta si no se le
   pasa ese día, para seguir siendo puro.
11. **`today` sale de la zona del ESPACIO, no de `CURRENT_DATE`.** Es la
   regla que ya fijó FIN-6 (`(now() AT TIME ZONE w.timezone)::date`): a
   las 02:00 UTC en Bogotá todavía es ayer, y con dos relojes distintos
   el promedio y la proyección hablarían de meses distintos.

### 0.6 FIN-6 llegó a mitad de camino: qué cambió

Cuando se escribió §0, `packages/core/src/flujo-caja.ts` no existía en
ninguna rama y el plan era crearlo con solo la parte de FIN-7. Mientras
se implementaba, **FIN-6 entró en `main`** con ese archivo, su pantalla
`/finanzas/flujo` y `getCashflowInputs`. Lo que se hizo entonces:

- **El core de FIN-7 se mudó a `packages/core/src/ingresos-plataformas.ts`.**
  `flujo-caja.ts` es la proyección semanal (cobros, gastos, reserva) y
  esto es la entrada de «otros ingresos» a esa proyección: dos cosas, dos
  archivos, un dueño por archivo y ningún conflicto de fusión. `mesDe` se
  llama aquí `mesDelPeriodo` porque el barril de `@mc/core` aplana los
  módulos en un espacio de nombres y `flujo-caja.ts` ya tiene su `mesDe`.
- **`projectCashflow` aceptó un parámetro nuevo y opcional**,
  `otrosIngresosMensual: Decimal | null`. Sin él se comporta exactamente
  igual que antes —las 30 pruebas de FIN-6 pasan sin tocarlas—, y con él
  cada semana gana `otrosIngresos` (`× 12 ÷ 52`, la misma
  `semanalDeMensual` que ya usaban los gastos) y el neto lo suma.
- **`getCashflowInputs` lo rellena** con una CTE más, en la misma
  consulta, y expone en `otrosIngresos` de dónde sale el número
  (cuántos meses se promediaron) para que la pantalla lo escriba.
- **`/finanzas/flujo` pinta la fila de verdad**: una columna «Otros
  ingresos», una barra en el gráfico y una frase en la nota. Las tres
  solo aparecen si HAY estimado: una columna de ceros diría «no entra
  nada» cuando lo cierto es «todavía no lo sabemos».
- **`/finanzas/ingresos` sigue enseñando la cifra** en su tarjeta
  «Entrada al flujo de caja», con el mismo texto y la misma función:
  quien acaba de subir un CSV quiere ver el efecto sin cambiar de
  pantalla. Y un botón lleva al flujo.

Con esto, el tercer «terminado cuando» —«el flujo de caja muestra la
fila *ingresos de plataformas (estimado)*»— se cumple donde dice, y ya
no hace falta la salida provisional que proponía §0 original.

### 0.7 Fuera de alcance (con su historia)

| Qué | A dónde va |
|---|---|
| Lectura por API de AdSense y de TikTok (`source = 'api'`) | Fase 2, como dice la historia |
| Editar o borrar un `platform_payout` ya cargado | Historia nueva de Finanzas; hoy se corrige por SQL |
| Conversión entre monedas (tasa con fecha) | Historia nueva; hoy la moneda distinta se avisa y se deja fuera |
| Asignar el pago a un creador concreto (`creator_id`) | Con varios creadores por espacio (AGE-1); hoy entra `null` |
| `adsense` como fila propia del catálogo `platform` | Decisión de producto pendiente (0.4) |
| Los permisos `finanzas.ingreso.*` | Necesitan tocar la semilla de 0034: §1.2 |

### 0.8 Dudas para Nicolás

1. ¿AdSense se guarda como `youtube` o quieres una plataforma aparte? (0.4)
2. ¿Tres meses es la ventana correcta, o prefieres seis? (0.5.4)
3. ¿El estimado de plataformas entra en la base de la reserva de
   impuestos? Hoy NO. (0.5.8)
5. ¿Rechazar el mes en curso es lo que quieres, o prefieres cargarlo y
   marcarlo como parcial? Hoy se rechaza. (0.5.10)
4. ¿Se crean los permisos `finanzas.ingreso.*` o se quedan los
   reutilizados? (0.5.9, §1.2)

---

## 1. Lo que necesita Rasheed

### 1.1 Aplicar la migración (bloqueante para producción)

| # | Qué | Por qué | Bloquea |
|---|---|---|---|
| 1 | Aplicar **`0036_platform_payout_unico.sql`** en Supabase, detrás de `0034_access_control` y de las `0035` que estén en cola | Sin el UNIQUE, el `ON CONFLICT DO NOTHING` del import falla con `42P10` y **repetir la importación duplica el dinero** | `/finanzas/ingresos/importar` en producción |

La migración es re-ejecutable (`CREATE UNIQUE INDEX IF NOT EXISTS`) y no
toca ninguna fila existente. No hay filas de `platform_payout` en
`db/seed/` ni en Supabase, así que no puede fallar por datos previos.
No depende de ninguna otra migración salvo `0008` (la tabla), así que se
puede renumerar si otra área eligió también `0036`.

No hay variables de entorno nuevas, ni roles, ni permisos de Postgres, ni
nada que tocar en `lib/auth/`, `lib/workspace/` ni
`packages/db/src/{client,schema}`.

### 1.2 Si Nicolás quiere los permisos propios (no bloqueante)

Hoy `/finanzas/ingresos` se mira con `finanzas.flujo.ver` y se escribe
con `finanzas.pago.registrar` (0.5.9). Para tener
`finanzas.ingreso.ver` y `finanzas.ingreso.registrar` hacen falta tres
cosas, y **ninguna la puede hacer FIN-7 sola** porque la tercera cambia
una prueba que es de ACC-3:

1. Dos entradas en `PERMISOS` de `packages/core/src/permisos.ts` y el
   snapshot regenerado
   (`pnpm --filter @mc/core permisos:sql > test/snapshots/permisos.sql`),
   más el conteo de `permisos-sql.test.ts`.
2. Una migración nueva con los dos `INSERT INTO permission` y sus
   `role_permission` para los roles que llevan todo Finanzas (Dueño,
   Administrador de agencia, Contador de las dos), con
   `ON CONFLICT DO NOTHING`. **No** se edita `0034`.
3. Relajar `packages/db/test/accesos.test.ts` §«la semilla de 0034 §4
   es, línea por línea, la salida del script de ACC-1»: hoy compara el
   catálogo ENTERO contra la migración, así que un permiso añadido
   después la rompe aunque su migración exista. Lo que debería
   comprobar es que la base tiene **todos** los permisos del catálogo
   (venga cada uno de la migración que venga), no que una migración
   concreta sea el catálogo completo de hoy.

El punto 3 es el que hay que decidir con Rasheed: mientras esa prueba
exija igualdad exacta, **ningún módulo puede añadir un permiso** sin
editar una migración aplicada.
