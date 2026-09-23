# CAM-4 · Lo que aporta la marca — plan y lo que Rasheed tiene que saber

Escrito para: Rasheed (dueño de `db/migrations/`, `packages/db/src/schema/`
y `lib/workspace/`), Nicolás (dueño del módulo) y quien revise el PR.
Fecha: 23 de septiembre de 2026. Rama `nicolas/CAM-4-aporte-marca`, sobre
`origin/main` (29460e3).

---

## 0. Plan (escrito antes de tocar código)

### 0.1 Archivos

| Qué | Dónde | Estado |
|---|---|---|
| Semántica de cada `kind` y `source`, ventana del CSV, lectura de fechas y revisión pura de las filas | `packages/core/src/campanas.ts` (sección «Lo que aporta la marca») + `test/campanas.test.ts` | mío |
| `addBrandInput`, `importBrandCsv`, `listBrandInputs`, bitácora | `packages/db/src/queries/campanas.ts` + `test/campanas.test.ts` | mío |
| Lectura del archivo (papaparse, codificación, cabecera con alias) | `apps/web/app/(app)/campanas/[id]/_lib/csv-ventas.ts` + test | nuevo, mío |
| Textos del módulo | `apps/web/app/(app)/campanas/_lib/messages.ts` | nuevo, mío |
| Server Actions `registrarAporte`, `importarCsvVentas` | `apps/web/app/(app)/campanas/[id]/actions.ts` | mío |
| Sección «Lo que aportó la marca» y sus dos formularios | `[id]/page.tsx`, `[id]/aporte.tsx` (cliente) + `aporte.test.tsx` | mío |
| Fixtures | `apps/web/test/fixtures/csv/ventas-marca.csv`, `ventas-marca-excel.csv` y su README | mío |
| Estado de la historia | `apps/web/content/backlog.ts` (solo CAM-4) | mío |
| README de la web | `apps/web/README.md` («Dónde está cada cosa») | mío |
| Esta propuesta | `docs/propuestas/CAM-4.md` | — |

Sin migraciones: `campaign_brand_input` existe desde 0008 con
`workspace_id`, RLS (0010) e índice `(campaign_id, kind, day)`. `mc_app`
conserva INSERT y UPDATE sobre ella (0025 no la toca). Lo que pediría un
índice único va en §2.

No toco `db/migrations/`, `schema/`, `lib/auth/`, `lib/workspace/`, ni
nada de Rasheed. Reutilizo, sin editarlos, `leerCsv` y `aNumero` de
`resumen/importar/_lib/csv.ts` y `decodificarCsv` de `lib/csv.ts`.

### 0.2 Decisiones

1. **Semántica por `kind` y por `source`** (core, `brandInputSemantics`):
   - `source = 'brand_manual'` (formulario) → **total acumulado** a la
     fecha `day`. Vale para `code_redemptions`, `orders`, `revenue` y
     `signups`. El último por `received_at` manda (no se suma).
   - `source = 'brand_csv'` (CSV de ventas diarias) → **diario**, se
     suma. `csv_sales` es la columna «ventas» del CSV (dinero, en la
     moneda de la campaña). Las columnas opcionales «pedidos» y «canjes»
     se guardan con `kind = 'orders'` y `kind = 'code_redemptions'` y
     `source = 'brand_csv'`: son diarias porque lo dice la fuente, no el
     kind. Así CAM-5 no necesita un kind nuevo ni una migración.
   - Descartado: un kind por columna del CSV (`csv_orders`,
     `csv_redemptions`): el CHECK de 0008 no los tiene y sería una
     migración para decir lo que `source` ya dice.
   - `postback` e `integration` quedan fuera (fase 2); el CHECK los
     admite y las consultas los ignoran al totalizar.
2. **Formato del CSV.** Cabecera con alias en español e inglés, sin
   tildes ni mayúsculas: `día | dia | fecha | date | day`, `ventas |
   venta | ingresos | sales | revenue`, `pedidos | orders`, `canjes |
   redemptions | codigos`. Fechas `YYYY-MM-DD`, `dd/mm/aaaa` o
   `dd-mm-aaaa` (sin ambigüedad mes/día: lo fija el formato, no el
   archivo; una fecha en mes/día cae como ilegible o fuera de rango). El
   separador lo detecta papaparse (coma o punto y coma) y la codificación
   `decodificarCsv` (UTF-8 estricto, si no Windows-1252). Números como
   los escribe una hoja de cálculo (`aNumero`: «1.234,50» y «1,234.50»).
   Topes propios y más bajos que los de RES-6 porque el archivo es «una
   fila por día»: **256 KiB** y **400 filas** (la ventana más larga que
   cabe: campaña de casi un año más 67 días). Filas fuera de
   `starts_on − 7 … ends_on + 60` se rechazan con motivo; una campaña sin
   fechas no puede importar (la ventana no existe) y el mensaje lo dice.
   Un día repetido dentro del archivo se rechaza la segunda vez.
3. **Repetir no duplica.** Clave natural `(campaign_id, kind, day,
   source)`. No hay UNIQUE en 0008, así que `importBrandCsv` serializa
   por campaña con `pg_advisory_xact_lock` (el precedente de CAM-2) y
   hace `INSERT … WHERE NOT EXISTS` dentro de la transacción. Si el día
   ya estaba con el **mismo** valor, se cuenta como «sin cambios»; con
   **otro** valor, se reemplaza (UPDATE) y se cuenta como «corregida»:
   es la misma regla del formulario (lo último que reporta la marca
   manda). **DECISIÓN PENDIENTE DE NICOLÁS:** si prefieres que un día ya
   cargado no se pueda corregir por CSV, es cambiar el UPDATE por un
   rechazo con motivo `dia_ya_cargado`. El formulario también es
   idempotente: la misma alta (kind, día, valor, moneda) repetida no crea
   otra fila. El índice único que lo garantiza en la base para cualquier
   escritor va en §2 para Rasheed.
4. **Campaña cerrada o cancelada no admite aportes**: `lockEditableCampaign`
   (FOR UPDATE + `canEditCampaign`) lanza `CampaignLockedError`, el mismo
   de asociar o editar; el formulario lo muestra tal cual (`messageEs`).
5. **Moneda.** Solo `revenue` (formulario) y `csv_sales` llevan moneda.
   El formulario propone la de la campaña; si la persona elige otra se
   guarda tal cual y la respuesta avisa («Se guardó en USD; la campaña
   está en COP»). El CSV no tiene columna de moneda: usa la de la
   campaña. Los conteos van con `currency NULL`.
6. **Bitácora.** ACC-2 no está en `main`. Cada alta y cada importación
   escriben en `audit_log` desde `queries/campanas.ts` con un helper
   privado (`recordAudit`, marcado `TODO(ACC-2)` para cambiarlo por
   `audit()` de `packages/db/src/audit.ts` cuando exista):
   `action = 'campaign.brand_input.added'` (una por fila del formulario)
   y `'campaign.brand_csv.imported'` (una por importación, con los
   conteos), `entity_type = 'campaign_brand_input' | 'campaign'`,
   `actor_user_id = current_user_id()`, `after` solo con kind, día,
   valor, moneda y fuente: **nunca** `notes` (texto libre de la persona)
   ni nombres. Sin ACC-2 no hay prueba de permiso; la de bitácora sí.
7. **Permisos.** ACC-1 no está en `main`: `// TODO(ACC-1):
   campanas.aporte.registrar` como primera línea de las dos acciones, y
   `campanas.campana.ver` en la lectura de la ficha.
8. **Pantalla.** Sección nueva «Lo que aportó la marca», de ancho
   completo, justo encima de «Resultado» / «Seguidores de la marca».
   Tabla por kind (etiqueta, último total o suma, a qué fecha, fuente,
   cuántas filas), `ChartCard` de barras con las ventas diarias si hay
   CSV, y —solo si la campaña admite cambios— «Registrar aporte» y
   «Importar CSV de ventas» con el resumen (aceptadas, sin cambios,
   corregidas, rechazadas con el motivo por fila). Cifras y fechas por
   `formatterFor(await getCurrentWorkspace())`. Ausencia con frase.
9. **Lectura para CAM-5.** `listBrandInputs(tx, campaignId)` devuelve
   `totals` (uno por par kind/fuente, calculados en SQL: el último por
   `received_at` para lo manual, la suma para el CSV) y `daily` (las
   filas del CSV por día). CAM-5 toma canjes e ingresos de ahí: manda el
   CSV si existe, si no el último total manual. Contrato en §3.

### 0.3 Dudas

- ¿La lista `/campanas` debería enseñar «canjes» o «ingresos» por
  campaña? No lo hace: es CAM-5 (`campaign_result`).
- `campanas/` no tiene `error.tsx` ni `_lib/db.ts` (convenciones del
  pulido de Rasheed); no los abro en esta historia.

---

## 1. Lo hecho

| Paso | Commit | Qué |
|---|---|---|
| Plan | `c3b866f` | Esta propuesta, §0. |
| Core | `fc6e37c` | `BRAND_INPUT_KINDS`, `brandInputSemantics` (la fuente decide: formulario = total, CSV = diario), `brandCsvWindow` (inicio − 7 … fin + 60), `parseBrandCsvDay` (ISO o día/mes/año, nunca mes/día) y `reviewBrandCsvRows` (pura, con motivo por fila). |
| Consultas | `8d432fc` | `addBrandInput` (idempotente, moneda de la campaña por defecto), `importBrandCsv` (clave natural, sin duplicar, corrige un día con otra cifra), `listBrandInputs` (totales en SQL + serie diaria) y la bitácora (`recordAudit`, `TODO(ACC-2)`). Diez pruebas nuevas en pglite con el seed. |
| Pantalla | `eb4a3d9` | Sección «Lo que aportó la marca», `aporte.tsx`, `csv-ventas.ts`, `messages.ts` del módulo, las dos Server Actions y los fixtures. |
| Cierre | `78f4bf9` y siguientes | README, backlog, esta propuesta y lo que salga de la revisión. |

Decisiones que quedaron como **DECISIÓN PENDIENTE DE NICOLÁS**:

1. Un día del CSV que ya estaba con otra cifra **se corrige** (UPDATE) y el
   resumen lo cuenta como «corregido». La alternativa conservadora sería
   rechazarlo con motivo `dia_ya_cargado`; elegí corregir porque es la
   misma regla del formulario (lo último que reporta la marca manda) y
   porque sin ella una marca que se equivocó no tiene cómo arreglarlo sin
   que alguien borre filas a mano.
2. La fecha del formulario no puede ser futura (hoy en la zona del
   workspace).

## 2. Lo que necesita Rasheed

| # | Qué | Por qué | Urgencia |
|---|---|---|---|
| 1 | Índice único parcial en una migración nueva: `CREATE UNIQUE INDEX IF NOT EXISTS campaign_brand_input_csv_day ON campaign_brand_input (campaign_id, kind, day) WHERE source = 'brand_csv';` | Hoy la idempotencia la garantiza `importBrandCsv` (fila de `campaign` con `FOR UPDATE` y `WHERE NOT EXISTS` en la misma transacción). Un escritor que no pase por la función (un script, fase 2) podría duplicar un día. El índice incluye `campaign_id`, que apunta a una tabla aislada, así que cumple «la unicidad es por inquilino». Lo manual NO lleva índice: varias filas por kind son su historia. | Baja: nada lo necesita hoy. |
| 2 | Nada en `schema/`: `campaign_brand_input` no está en el esquema Drizzle y las consultas usan SQL con parámetros, como el resto de `campanas.ts`. | — | — |
| 3 | ACC-1 y ACC-2: `registrarAporte` e `importarCsvVentas` llevan `// TODO(ACC-1): requirePermission('campanas.aporte.registrar')`; la ficha, `campanas.campana.ver`. La bitácora la escribe `recordAudit` en `queries/campanas.ts` y se cambia por `audit()` en una línea cuando exista. | — | Cuando llegue ACC. |

Sin migraciones y sin variables de entorno nuevas.

## 3. Contrato de lectura para CAM-5

```ts
import { listBrandInputs } from '@mc/db';
const { totals, daily, currency } = await listBrandInputs(tx, campaignId);
```

- `totals`: una fila por par (kind, fuente) con datos.
  - `source = 'brand_manual'`, `semantics = 'total'`: `value` es el
    **último** total reportado (por `received_at`) y `asOf` su fecha.
  - `source = 'brand_csv'`, `semantics = 'daily'`: `value` es la **suma**
    de los días, `from`/`asOf` el primer y el último día.
  - `value` es un decimal en texto (`'318.00'`). Los conteos
    (`code_redemptions`, `orders`, `signups`) no llevan moneda; `revenue` y
    `csv_sales` llevan la suya en `currency`.
- `daily`: las filas del CSV por día (`sales`, `orders`, `redemptions`).
- `currency`: la de la campaña.

Regla para el resultado (CAM-5, decisión 4 de su plan):

| Qué | De dónde |
|---|---|
| `code_redemptions` | la suma de `code_redemptions` del CSV si existe; si no, el último total manual |
| `attributed_revenue` | la suma de `csv_sales` si existe; si no, el último `revenue` manual |
| ninguno de los dos | `null` y `brand_inputs` en `missing_inputs` |
| manual pero sin CSV | el manual, y `brand_csv_sales` en `missing_inputs` (es lo que dice el seed para Café Alma) |

Si hay los dos, manda el CSV y CAM-5 lo anota. Una cifra en otra moneda
que la de la campaña no se convierte: CAM-5 decide si la usa.
