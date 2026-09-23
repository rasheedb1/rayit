# FIN-5 · Gastos — plan, decisiones y lo que necesita Rasheed

Escrito para: Rasheed (integrador de migraciones y de la cola de
Supabase) y quien revise el PR de FIN-5. Fecha: 23 de septiembre de
2026. Rama `nicolas/FIN-5-gastos`, sobre `origin/main` (29460e3).

**Resumen para quien solo lea esto:** FIN-5 **no trae migración**.
`expense` existe desde 0008 con su índice `(workspace_id, incurred_on
DESC)` y su política de RLS desde 0010. No hay nada que aplicar en
Supabase por esta historia.

---

## 0. Plan (escrito antes de tocar código)

### 0.1 Archivos

| Qué | Dónde |
|---|---|
| `proyectarGastosRecurrentes`, `CATEGORIAS_GASTO`, `RECURRENCIAS` y sus tipos | `packages/core/src/flujo-caja.ts` (**nuevo**, mío; FIN-6 lo completa) |
| Export del módulo nuevo | `packages/core/src/index.ts` (una línea) |
| Pruebas puras del proyector | `packages/core/test/flujo-caja.test.ts` (**nuevo**) |
| Consultas de gastos (`getExpenseMonth`, `listRecurringExpenses`, `getExpense`, `createExpense`, `updateExpense`) | `packages/db/src/queries/finanzas.ts` (sección nueva «Gastos», al final) |
| Pruebas en Postgres embebido | `packages/db/test/finanzas.test.ts` (bloque nuevo `describe('gastos')`) |
| Pantalla, formulario, acciones, textos, carga y error | `apps/web/app/(app)/finanzas/gastos/` (**nueva**) |
| Textos del módulo | `apps/web/app/(app)/finanzas/_lib/messages.ts` (sección `gastos`) |
| Enlace «Gastos» desde `/finanzas` | `apps/web/app/(app)/finanzas/page.tsx` (dos líneas en `aside`) |
| Mes en el locale del espacio (`f.month`) | `apps/web/lib/format.ts` (función nueva, no cambia ninguna existente) |
| Estado de la historia | `apps/web/content/backlog.ts` (solo mi fila FIN-5) |
| Este documento | `docs/propuestas/FIN-5.md` |

No toco `db/migrations/`, `db/seed/`, `lib/auth/`, `lib/workspace/`,
`packages/db/src/{client,schema}` ni nada de Ventas, Cotizar o Resumen.

### 0.2 Decisiones

1. **Categorías y recurrencias, listas cerradas en core.**
   `CATEGORIAS_GASTO` en `packages/core/src/flujo-caja.ts` con `id` y
   `labelEs`: `edicion`, `software`, `equipo`, `contabilidad`,
   `servicios`, `viajes` —los seis del seed 0003 §7— más `otros`.
   `RECURRENCIAS = ['monthly']` con `labelEs`. zod valida con
   `z.enum(CATEGORIA_IDS)`, sin ningún cast sobre su salida.
   La columna `expense.category` sigue siendo texto libre (0008): la
   lista cierra **lo que el formulario escribe**, no lo que la base
   admite. Por eso la lectura nunca valida: `labelCategoria(c)` devuelve
   la etiqueta conocida o el valor crudo, y una fila importada con una
   categoría que no está en la lista se ve y se suma igual, en vez de
   romper la pantalla. Descartado: `z.string()` libre (la lista por
   categoría se llena de sinónimos en un mes) y un `CHECK` nuevo en la
   base (es una migración que no necesita esta historia y que congela un
   vocabulario que todavía no conocemos).
   **DECISIÓN PENDIENTE DE NICOLÁS:** `otros` no está en el seed. Lo
   agrego porque una lista cerrada sin salida obliga a mentir en la
   primera factura de la contadora que no encaje. Si prefieres seis y
   que lo que no encaje se llame `servicios`, es borrar una línea de
   `CATEGORIAS_GASTO`.
   **DECISIÓN PENDIENTE DE NICOLÁS:** el permiso. El enunciado de la
   historia dice `finanzas.gasto.crear`, pero el catálogo de ACC-1
   (rama `nicolas/ACC-1-catalogo-permisos`,
   `packages/core/src/permisos.ts`) ya tiene `finanzas.gasto.ver` y
   **`finanzas.gasto.registrar`**. Uso los del catálogo para no crear
   una tercera clave; editar usa también `finanzas.gasto.registrar`
   (ACC-1 no distingue crear de editar en gastos).

2. **Qué es «recurrente»: la fila es la plantilla.** No se crean filas
   futuras. `proyectarGastosRecurrentes` repite el gasto **el mismo día
   de cada mes siguiente** (k ≥ 1 meses desde `incurred_on`), y el día
   31 cae al último día del mes que no lo tiene (31-ene + 1 mes =
   28-feb; +2 = 31-mar, siempre contado desde el original, no desde el
   anterior). La ocurrencia k = 0 —la fila misma— **no** se proyecta:
   ya está registrada y contarla otra vez la duplicaría en FIN-6.
   Descartado: materializar filas futuras (un cambio de monto obliga a
   corregir N filas, y el «terminado cuando» se cumple sin ellas).

3. **Una serie, una plantilla.** El seed tiene la MISMA suscripción
   registrada en julio, agosto y septiembre, las tres con
   `is_recurring`. Proyectar las tres triplicaría el gasto. Como
   `expense` no tiene columna de serie, `proyectarGastosRecurrentes`
   agrupa por **clave de serie = (category, vendor, recurrence,
   currency)** y se queda con la fila de `incurred_on` más reciente
   (desempate por `id`, para que el resultado sea determinista). El
   monto que proyecta es el de esa fila, no un promedio. Con el seed:
   cinco series, las de septiembre, 3 700 000/mes.
   Límite conocido y documentado en el JSDoc: dos gastos recurrentes
   **de verdad distintos** con el mismo proveedor, categoría y
   recurrencia se funden en uno. La solución es una columna
   `series_id`, y va en FIN-6 (§3 de este documento), no aquí.
   Descartado: dejar la deduplicación en el SQL (FIN-6 vuelve a
   necesitarla y la regla acabaría escrita dos veces, solo una probada).

4. **Ventana: ocho semanas exactas desde el lunes.** La ventana empieza
   el **lunes de la semana de `desde`** y dura `semanas × 7` días. Cada
   semana devuelve `{ desde, hasta, total, ocurrencias[] }` con `hasta`
   = domingo. Se cuentan solo las ocurrencias con fecha **≥ `desde`**:
   lo de esta semana que ya pasó no es una proyección. Las semanas sin
   nada devuelven `total: '0.00'` y `ocurrencias: []` —una semana sin
   gastos recurrentes sí es un cero de verdad, no una ausencia—, y el
   caso «no hay ninguna plantilla» lo dice la pantalla con una frase.

5. **Una sola moneda.** `getExpenseMonth` y `listRecurringExpenses`
   devuelven la moneda del espacio y **cuentan aparte** las filas en
   otra (`omitidosPorMoneda`): sumar dos monedas sin convertir es lo
   único peor que no sumar. El proyector es defensivo: si recibe filas
   de dos monedas lanza `GastosEnVariasMonedas` (con `messageEs`). El
   formulario escribe siempre la moneda del espacio, igual que FIN-1.

6. **El mes va en la URL:** `/finanzas/gastos?mes=2026-09`. Sin `mes`,
   el mes de `CURRENT_DATE` (de SQL, como FIN-1, no del reloj del
   proceso). Un `mes` mal formado cae al mes actual, no a un 500. La
   navegación anterior/siguiente son dos enlaces `<Link>` (funcionan sin
   JavaScript y se pueden compartir). El total del mes, el recurrente,
   el deducible y el desglose por categoría salen de **un GROUP BY en
   SQL**; la pantalla no suma nada.

7. **Editar sí, eliminar no.** Editar deja bitácora `before`/`after` con
   los campos que cambian. No hay borrado en el MVP: un gasto es un
   hecho contable y la contadora necesita que el rastro exista;
   corregir un error es editarlo, y anotar que fue un error es escribirlo
   en la descripción. Además `mc_app` no tiene DELETE sobre `audit_log`
   (0025): borrar la fila dejaría la bitácora apuntando a algo que ya no
   está. Si algún día hace falta, se hace con una columna `voided_at`
   (historia nueva), no con un DELETE.

8. **Bitácora, hoy.** ACC-2 (`packages/db/src/audit.ts`) **no está en
   `main`** todavía. Como «cada alta y edición deja bitácora» es un
   criterio de terminado de ESTA historia, escribo un helper local en
   `queries/finanzas.ts` —`anotarGasto()`— con exactamente el mismo
   INSERT que `audit()` de la rama ACC-2 (workspace por
   `current_workspace_id()`, actor por `current_user_id()`, `actor_kind`
   `'user'`/`'system'`, `before`/`after` construidos a mano campo por
   campo, nunca `...row`), marcado `// TODO(ACC-2)`. Cuando ACC-2
   entre son dos líneas: importar `audit` y borrar el helper. ACC-2
   tendrá que agregar `expense.created` y `expense.updated` a
   `AUDIT_ACTIONS` (§3).

9. **El recibo es un enlace, no un archivo.** `receipt_url` acepta una
   URL `http(s)` (Drive, Dropbox, el correo del proveedor). No hay
   almacenamiento de archivos en la plataforma y el laboratorio de video
   es fase 2: subir la foto del recibo es una **historia nueva** (§3).
   El campo se valida como URL absoluta con esquema http/https —para que
   no entre un `javascript:` en un `<a>`— y el enlace se pinta con
   `rel="noreferrer noopener"` y `target="_blank"`.

10. **Sin migración.** `expense` (0008) ya tiene columnas para todo lo
    que la historia pide y el índice `(workspace_id, incurred_on DESC)`,
    que es exactamente el de la lista por mes. No hay nada que proponer.

### 0.3 Dudas

- Si mañana quieres gastos en varias monedas por espacio, la conversión
  necesita una tabla de tasas y eso es una historia propia; hoy se
  cuentan y se dicen, no se suman.
- `otros` y la clave del permiso (§0.2.1) son las dos decisiones que
  marqué pendientes.

---
