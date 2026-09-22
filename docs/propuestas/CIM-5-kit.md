# CIM-5 · Kit de interfaz compartido — investigación y propuesta de API

> Documento temporal de trabajo. No se commitea: cuando la API esté
> aprobada, lo que valga pasa a `apps/web/components/ui/README.md`.
> Fecha: 21 de septiembre de 2026.

## Fase 1 · Qué hay en el mock (`dashboard/local`)

Archivos leídos: `index.html` (374 líneas), `app.js` (812), `styles.css`
(410). `theme-signal.css` y `theme-studio.css` existen (401 y 387 líneas)
pero son las dos direcciones descartadas en la decisión 1; no se toman.

### Patrones que se repiten

| Patrón | Dónde | Qué me llevo | Qué descarto |
|---|---|---|---|
| `kpis(el, defs)` | app.js:83-100 | La forma: label, value ya formateado, `delta` relativo con flecha y texto, `note` cuando no hay delta, sparkline opcional. La rejilla `1px` de `--border` como separador (styles.css:196). | `defs` sin tipos; el `vs` por defecto "vs. 30 días antes" (mejor explícito). Flechas ▲▼ como texto → SVG con `aria-hidden` y el signo en el texto. |
| `sparkline(values)` | app.js:72-82 | Trazo en `--deemph`, último tramo y punto en `--accent`. `aria-hidden`. | Ancho fijo 150×30 → `viewBox` y `width: 100%`. |
| `lineChart(box, opt)` | app.js:102-154 | Márgenes, `niceTicks`, ejes con `--grid`/`--axis`, etiquetas en `--muted`, ventana sombreada `--accent-wash` con etiqueta, punto final por serie, nombres de serie al final de la línea sin solaparse, crosshair, tooltip con todas las series, tabla derivada de las mismas `series+labels`. | `box.clientWidth` en el render (no sirve en SSR): el SVG se dibuja con `viewBox` y ancho lógico fijo. Tabla con `stride` de 14 filas: la tabla del kit trae todas las filas (es la fuente accesible). Tooltip `position: fixed` global: pasa a estar dentro del `ChartCard`. |
| `barChart(box, opt)` | app.js:155-201 | `mode` stack/group, barras con tope redondeado (`roundedTop`), hueco de 2 px entre segmentos, etiqueta de categoría cada 2 si hay más de 8, fila "Total" en stack. | Igual que arriba: `clientWidth`, tooltip global. |
| `pairedBars` | app.js:203-225 | Nada por ahora. | No está en la lista de CIM-5; si Resumen lo necesita, se agrega después como componente nuevo. |
| `legend(el, series, kind)` | app.js:52-58 | `swatch-line` (14×2) para líneas, `swatch-rect` (9×9) para barras. | Se genera dentro de `ChartCard` desde `series`, no es prop aparte. |
| `pillEl(text, kind)` | app.js:427; styles.css:259-265 | Punto de color con `currentColor`, `kind` good/warn/bad y wash correspondiente, `neutral` con borde. | `accent` y `muted` del mock: el kit deja `neutral`; si alguien necesita `accent`, se propone en PR. |
| Toggle "Ver tabla / Ver gráfico" | app.js:785; index.html:61 | Botón único que alterna, texto cambia, el gráfico y la tabla son el mismo dato. | `hidden` sobre nodos con id: en React es estado local del `ChartCard`. Añado `aria-pressed`/`aria-controls`. |
| Tablas `cell-main`/`cell-sub`/`num` | styles.css:239-256; app.js:740 | Cabecera `--muted` 12px, celda `num` a la derecha en mono, hover `--surface-2`, `table-scroll` para desbordar. | `cell-sub` como `<td>` aparte: en el kit una celda puede tener principal y secundario vía `render`. |
| Listas de checks ✓/· | app.js:622, 725; styles.css:358-363 | Caja 18px, `on` con `--good-wash`, `off` con `--warn-wash`, texto + `small`. | Sale del alcance de CIM-5 (no está en la lista). Lo anoto como candidato `CheckList` para Campañas (CAM-1, "Acordado antes de publicar"). |
| `showTooltip` | app.js:27-41 | Estructura: título, filas con swatch + valor mono + etiqueta. Colores `--tooltip-bg/-ink/-ink-2`. | Nodo global por id. |
| `.btn`, `.btn-primary` | styles.css:218-226 | Altura, borde `--border`, hover `--hover`, primario `--accent`/`--accent-ink`. | `opacity: .88` en hover del primario → cambio de tono, no de opacidad. |
| `input[type=text]`, `.seg` | styles.css:187-193 | Borde `--border`, hover `--axis`, placeholder `--muted`. | `.seg` (segmentado) no está en la lista. |

### Tokens de `styles.css` y cómo cambian en oscuro

Claro (`:root`, styles.css:3-37) y oscuro (`:root[data-theme="dark"]`,
styles.css:73-105, más el mismo bloque bajo `prefers-color-scheme: dark`
para quien no eligió):

| Token | Claro | Oscuro | Uso en el kit |
|---|---|---|---|
| `--bg` | #ffffff | #000000 | fondo de página |
| `--surface` / `--surface-2` | #ffffff / #fafafa | #0a0a0a / #111111 | tarjetas, hover de fila |
| `--hover` | #f4f4f4 | (no definido en oscuro: hereda) | hover de botón |
| `--ink` / `--ink-2` / `--muted` | #171717 / #525252 / #8a8a8a | #ededed / #a1a1a1 / #7d7d7d | texto principal, secundario, etiquetas |
| `--border` / `--grid` / `--axis` | #eaeaea / #f0f0f0 / #d4d4d4 | #262626 / #1f1f1f / #333333 | bordes, rejilla y eje de gráficos |
| `--accent` / `--accent-ink` / `--accent-wash` | #171717 / #ffffff / rgba(0,0,0,.05) | #ededed / #0a0a0a / rgba(255,255,255,.08) | primario, ventana sombreada |
| `--deemph` | #d4d4d4 | #404040 | serie secundaria, sparkline |
| `--good` / `--good-wash` | #15803d / #f0fdf4 | #4ade80 / rgba(74,222,128,.12) | delta positivo, pill |
| `--warn` / `--warn-wash` | #b45309 / #fffbeb | #fbbf24 / rgba(251,191,36,.12) | pill |
| `--bad` / `--bad-wash` | #dc2626 / #fef2f2 | #f87171 / rgba(248,113,113,.12) | delta negativo, pill |
| `--s-tiktok` / `--s-instagram` / `--s-facebook` / `--s-youtube` | #2a78d6 / #eb6834 / #1baf7a / #eda100 | #3987e5 / #d95926 / #199e70 / #c98500 | series por red |
| `--tooltip-bg` / `--tooltip-ink` / `--tooltip-ink-2` | #171717 / #ffffff / #a3a3a3 | #ededed / #0a0a0a / #525252 | tooltip |
| `--sans` / `--mono` | Geist / Geist Mono | igual | tipografía |
| `--role-*` | 4 colores | 4 colores | descartado: son de la historia de miniclips |

Hoy `apps/web/app/globals.css` no tiene ninguno de `--surface`, `--ink`,
`--muted`, `--grid`, `--axis`, `--deemph`, `--good/--warn/--bad` con
`-wash`, `--s-*` ni `--tooltip-*`. Eso lo cierra CIM-4 (criterio 5) antes
de empezar CIM-5; el kit solo consume tokens.

### Cómo formatea el mock

| Función | app.js | Comportamiento | En el kit |
|---|---|---|---|
| `cop(v)` | :11 | `>= 1e6` → `COP 5,2 M` (1 decimal, coma); si no, `COP 850.000` con `Intl es-CO`. Recibe number. | `formatMoney(amountDecimal: string, currency, { mode })`: mismo resultado, pero entra string decimal y la moneda es parámetro. |
| `fmtInt` | :6 | `Intl.NumberFormat('es-CO')` → `1.234.567`. | `formatInt(n)` igual. |
| `nf(v)` | :8 | compacto `es` con 1 decimal → `214 mil`, `1,2 M`. | `formatCompact(n)` para ejes. |
| `pct(v, d)` | :9 | `(v*100).toFixed(d)` con coma → `31 %` (espacio antes de %). | `formatPct(ratio, digits)`; `formatDelta` añade signo. |
| `dec(v, d)` | :10 | decimal con coma. | interno. |
| `fmtDate(d)` | :12 | `Intl 'es'` día + mes corto → `20 sept`. Sin zona horaria: depende del navegador. | `formatDate(iso, style)` con `es-CO` y `timeZone: "UTC"` (regla del repo: fechas en UTC). `es-CO` da `20 sept`; si prefieres `20 sep` lo recorto a tres letras (dime). |

---

## Fase 2 · Propuesta de API (espera aprobación)

Reglas que aplican a todo: solo props, sin datos ni fetch; Server
Components salvo donde se indica `"use client"`; colores por token;
`aria-label` obligatorio en gráficos; cifras con `tabular-nums`.

Convenciones:
- `className?: string` en la raíz de cada componente, siempre al final.
- Todo texto visible viene por props (el kit no traduce ni decide copy),
  salvo los literales fijos del kit: "Ver tabla", "Ver gráfico", "datos
  hasta", "Cargando".
- Los nombres de token se pasan como `"accent" | "deemph" | "tiktok" |
  "instagram" | "facebook" | "youtube" | "good" | "warn" | "bad"` y el
  componente los convierte a `var(--…)`. Así nadie escribe un color.

### 11 · `lib/format.ts` (primero, porque todo lo usa)

```ts
export type MoneyMode = "compact" | "full";

/** "5200000.00" + "COP" → compact "COP 5,2 M" · full "COP 5.200.000".
 *  Bajo 1 M compact == full. Decimales solo si no son cero: "COP 5.200.000,50".
 *  Negativos: "−COP 1,1 M" (signo menos tipográfico U+2212). Lanza si el string no es decimal. */
export function formatMoney(amountDecimal: string, currency: string, opts?: { mode?: MoneyMode }): string;
/** 1234567 → "1.234.567" */
export function formatInt(n: number): string;
/** 214000 → "214 mil" · 1200000 → "1,2 M" (ejes y sparkline) */
export function formatCompact(n: number): string;
/** 0.31 → "31 %" · digits=1 → "31,0 %" */
export function formatPct(ratio: number, digits?: number): string;
/** 0.31 → "+31 %" · −0.05 → "−5 %" · 0 → "0 %" (nunca solo color) */
export function formatDelta(ratio: number, digits?: number): string;
/** ISO → es-CO, UTC. short "20 sept" · long "20 de septiembre de 2026" · range(a, b) "24–31 ago" */
export function formatDate(iso: string, style?: "short" | "long"): string;
export function formatDateRange(fromIso: string, toIso: string): string;
```

Pruebas: 0, negativos, 1e9 (`COP 1.000,0 M` en compact → decido `COP 1.000 M`; dime si prefieres `COP 1,0 mil M`), `"5200000.50"`, `USD`.

### 10 · `Button`

```ts
type ButtonProps = {
  variant?: "primary" | "secondary" | "ghost" | "danger"; // secondary por defecto
  size?: "sm" | "md";                                     // md por defecto
  loading?: boolean;      // spinner + aria-busy + disabled; conserva el ancho
  disabled?: boolean;
  href?: string;          // si viene, renderiza next/link con el mismo estilo
  type?: "button" | "submit";
  icon?: ReactNode;       // a la izquierda, aria-hidden
  children: ReactNode;    // texto obligatorio
  onClick?: () => void;
  className?: string;
};
```
Estados: normal, hover, foco visible, disabled, loading. `"use client"`
solo si `onClick` o `loading` (lo resuelvo con un wrapper cliente
`ButtonClient` que el `Button` servidor usa cuando hace falta; si te
parece excesivo, `Button` entero es cliente: pesa lo mismo).
Decisión: `href` en vez de `asChild` (evita la dependencia de Slot).

Ejemplo: `<Button variant="primary" loading={saving} type="submit">Guardar cotización</Button>`

### 6 · `Pill`

```ts
type PillProps = { kind: "good" | "warn" | "bad" | "neutral"; children: string; className?: string };
```
Punto de color + texto. Estados: los cuatro `kind`. Servidor.
Ejemplo: `<Pill kind="bad">Vencida · 41 días</Pill>`

### 9 · Formulario: `Field`, `Input`, `Select`, `Textarea`, `MoneyInput`, `DateInput`

```ts
type FieldProps = {
  label: string; help?: string; error?: string; required?: boolean;
  htmlFor?: string;           // si no viene, Field genera el id con useId y lo pasa por contexto
  children: ReactNode; className?: string;
};
// Input/Select/Textarea: envoltorios finos sobre el elemento nativo; heredan id,
// aria-describedby (help/error) y aria-invalid desde Field. Todas las props nativas pasan.
type InputProps = InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };
type SelectProps = SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[]; placeholder?: string; invalid?: boolean };
type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

type MoneyInputProps = {                     // "use client"
  value: string;                             // decimal "5200000.50"; "" = vacío
  currency: string;                          // se muestra como prefijo fijo "COP"
  onChange: (value: string, currency: string) => void; // emite "5200000.50" (siempre 2 decimales)
  id?: string; name?: string; placeholder?: string; disabled?: boolean; invalid?: boolean;
  className?: string;
};
// type="text" inputmode="decimal"; muestra 5.200.000,50 (es-CO); acepta pegar "5.200.000,50",
// "5200000.5", "5,200,000.50" → normaliza; al perder foco re-formatea. Nunca number.

type DateInputProps = InputHTMLAttributes<HTMLInputElement> & {
  value: string;                             // "2026-09-20" (solo fecha, sin hora)
  onChange: (isoDate: string) => void;
  invalid?: boolean;
};
// Nativo type="date"; el consumidor convierte a timestamptz UTC en el borde (regla del repo).
```
Estados: normal, con ayuda, con error (borde `--bad`, mensaje bajo el
campo, `aria-invalid`), requerido (asterisco con `aria-hidden` + texto
"obligatorio" en `aria-label`), disabled. Validación con zod del lado
del formulario; el kit solo pinta `error`.
Ejemplo:
```tsx
<Field label="Monto" help="Sin IVA" error={errors.amount} required>
  <MoneyInput value={amount} currency="COP" onChange={(v) => setAmount(v)} />
</Field>
```

### 7 · `EmptyState`

```ts
type EmptyStateProps = {
  title: string; description?: string;
  action?: { label: string; href: string } | { label: string; onClick: () => void };
  icon?: ReactNode;      // un solo tono (currentColor), 24px; por defecto un círculo punteado
  className?: string;
};
```
Servidor; si `action.onClick`, el botón interno es el `Button` cliente.
Ejemplo: `<EmptyState title="Sin conexiones" description="Conecta una red para ver datos." action={{ label: "Conectar", href: "/conexiones" }} />`

### 8 · `DataAsOf`

```ts
type DataAsOfProps = { date: string /* ISO */; source?: string; className?: string };
// → "datos hasta el 20 sept · Instagram". <time dateTime={date}>. Intl es-CO, timeZone UTC.
```
Servidor. Ejemplo: `<DataAsOf date="2026-09-20T00:00:00Z" source="Instagram" />`

### 1 · `Kpi` / `KpiRow`

```ts
type KpiProps = {
  label: string;
  value: string;                 // ya formateado
  note?: string;                 // "3 facturas"; se muestra si no hay delta, o debajo si hay ambos
  delta?: number;                // relativo: 0.31
  deltaLabel?: string;           // "vs. mismo período 2025"
  trend?: "up" | "down" | "flat";// si falta, del signo de delta (|delta| < 0.0005 = flat)
  sparkline?: number[];          // SVG, aria-hidden; el valor ya está en texto
  href?: string;                 // toda la tarjeta es enlace
  loading?: boolean;             // esqueleto del mismo tamaño, aria-busy
  className?: string;
};
type KpiRowProps = { children: ReactNode; className?: string };
// grid: 1 col <640, 2 cols <1024, 4 cols ≥1024; separador 1px --border como el mock
```
Servidor. Delta: flecha SVG + `formatDelta` + `deltaLabel` en `--muted`;
color `--good`/`--bad`, nunca solo. Estados: normal, con delta, con note,
con sparkline, enlace, loading, valor largo (`COP 1.234.567.890` no se
corta: baja de tamaño con `text-wrap: balance` y `min-width: 0`).
Ejemplo:
```tsx
<KpiRow>
  <Kpi label="Cobrado en 2026" value="COP 38,6 M" delta={0.31} deltaLabel="vs. mismo período 2025" />
  <Kpi label="Vencido" value="COP 1,1 M" note="1 factura · 41 días" href="/finanzas?estado=vencido" />
</KpiRow>
```

### 5 · `DataTable`

```ts
type Align = "left" | "num";
type Column<Row> = {
  key: string; header: string; align?: Align;   // num: derecha, mono, tabular-nums, nowrap
  render?: (row: Row) => ReactNode;             // si falta, muestra String(row[key])
  width?: string;                               // "12rem" opcional
  sortable?: boolean;                           // previsto, sin efecto este sprint
};
type DataTableProps<Row> = {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  caption: string;                              // <caption> visualmente oculto salvo showCaption
  showCaption?: boolean;
  emptyState: ReactNode;                        // normalmente <EmptyState/>; se pinta en una fila que ocupa todo
  onRowClick?: (row: Row) => void;              // fila con role="button"/tabIndex y Enter (parte cliente)
  density?: "compact" | "normal";               // compact por defecto
  stickyHeader?: boolean;                       // true por defecto; el scroll vive en el envoltorio
  loading?: boolean;                            // 5 filas esqueleto, aria-busy
  sort?: { key: string; dir: "asc" | "desc" }; onSortChange?: (s) => void; // previsto, sin UI este sprint
  page?: { index: number; size: number; total: number }; onPageChange?: (i: number) => void; // previsto
  className?: string;
};
// Celdas con principal/secundario: render={(r) => <CellMain sub={r.campaign}>{r.brand}</CellMain>}
```
Servidor por defecto; cuando llega `onRowClick` el `<tbody>` se envuelve
en una parte cliente. `<th scope="col">`. Envoltorio con `overflow-x:
auto` para 390 px. Estados: normal, vacío, loading, con click.

### 2 · `LineChart` (`"use client"`)

```ts
type SeriesColor = "accent" | "deemph" | "tiktok" | "instagram" | "facebook" | "youtube" | "good" | "warn" | "bad";
type Series = { name: string; data: number[]; color?: SeriesColor; dashed?: boolean };
type LineChartProps = {
  series: Series[];
  labels: string[];                       // misma longitud que cada data
  ariaLabel: string;                      // obligatorio
  fromZero?: boolean;                     // true por defecto
  shade?: { from: number; to: number; label: string }; // índices en labels
  formatValue?: (v: number) => string;    // tooltip; por defecto formatCompact
  formatAxis?: (v: number) => string;     // eje y; por defecto formatValue
  height?: number;                        // lógico, 260 por defecto; ancho 100% con viewBox
  maxXLabels?: number;                    // 6 por defecto
  endLabels?: boolean;                    // nombre de la serie al final de la línea (mock); true
  className?: string;
};
```
Colores sin `color` se asignan en orden: accent, deemph, tiktok, instagram,
facebook, youtube. Tooltip: `pointermove` sobre una capa transparente,
crosshair, todas las series del índice. Teclado: la capa es `tabIndex=0`,
flechas mueven el índice, el tooltip se lee por `aria-live="polite"`;
la descripción completa está en la tabla del `ChartCard`. Estados:
normal, una sola serie, 90 puntos (etiquetas cada N), vacío (`data: []` →
mensaje "Sin datos" dentro del área), `prefers-reduced-motion` sin
transiciones.

### 3 · `BarChart` (`"use client"`)

```ts
type BarChartProps = {
  cats: string[];
  series: Series[];
  mode?: "group" | "stack";               // stack por defecto, como el mock
  ariaLabel: string;
  formatValue?: (v: number) => string;
  formatAxis?: (v: number) => string;
  height?: number;
  showTotal?: boolean;                    // en stack, fila/tooltip "Total"; true
  className?: string;
};
```
Mismos formatters, tooltip y teclado que `LineChart`.

### 4 · `ChartCard`

```ts
type ChartCardProps = {
  title: string; subtitle?: string;
  series: Series[];
  labels: string[];                        // labels (línea) o cats (barras): el mismo campo
  chart: "line" | "bar";
  chartProps?: Omit<LineChartProps, "series" | "labels" | "ariaLabel"> | Omit<BarChartProps, "series" | "cats" | "ariaLabel">;
  ariaLabel: string;
  formatValue?: (v: number) => string;     // se pasa al gráfico y a la tabla (una sola fuente)
  labelsHeader?: string;                   // cabecera de la primera columna: "Fecha" / "Semana"
  asOf?: { date: string; source?: string };// pinta <DataAsOf/>
  note?: ReactNode;                        // texto bajo el gráfico (chart-note del mock)
  legend?: boolean;                        // true; se genera de series
  defaultView?: "chart" | "table";
  loading?: boolean; emptyState?: ReactNode;
  className?: string;
};
```
Cliente solo el interruptor (estado `view`) y el gráfico; el resto es
servidor. La tabla se construye de `series+labels` con `<caption>`
(= title), `<th scope="col">`, primera columna las etiquetas, una columna
por serie, "Total" si stack; `labels.length` filas. Botón "Ver tabla /
Ver gráfico" con `aria-pressed` y `aria-controls`.
Ejemplo (Campañas):
```tsx
<ChartCard
  title="Seguidores de @cafealma durante la campaña" subtitle="Snapshot diario público"
  chart="line" series={[{ name: "Seguidores", data, color: "accent" }]} labels={days}
  chartProps={{ fromZero: false, shade: { from: 14, to: 21, label: "Campaña 24–31 ago" } }}
  ariaLabel="Seguidores de @cafealma por día, con la ventana de campaña" formatValue={formatInt}
  asOf={{ date: "2026-09-20T00:00:00Z", source: "Instagram" }}
/>
```

### Galería `/kit`

`app/(app)/kit/page.tsx` detrás de la bandera `kit` (encendida en
desarrollo, apagada en producción: `kit: process.env.NODE_ENV !==
"production"` en `flags.ts`). Una sección por componente con ancla,
uso mínimo en `<pre>`, y las variantes que pide la historia (normal,
vacío, cargando, error, valores largos, serie de 90 puntos). El toggle
de tema es el del shell, que ya está en la misma página.

---

## Decisiones que necesito de ti antes de codificar

1. **Tokens.** El kit necesita los tokens del mock en `globals.css`. Los
   agrego en CIM-4 (criterio 5) conservando los nombres actuales de
   Rasheed (`--fg`, `--line`…) como alias hasta que él migre. ¿De acuerdo
   con que `globals.css` cuente como archivo de CIM-4 (tema)? No está en
   la tabla de dueños.
2. **Dependencias nuevas** (ninguna en runtime salvo zod, que la usa el
   consumidor, no el kit):
   - `vitest` (~3 MB instalado) + `@testing-library/react` (~0,4 MB) +
     `@testing-library/jest-dom` + `jsdom` (~6 MB) para pruebas. Solo dev.
   - `zod` (~0,6 MB) la agregará quien haga el primer formulario; el kit
     no la importa. Si prefieres que la agregue yo ahora, dímelo.
   - Nada para gráficos: SVG propio alcanza, como en el mock.
3. **`Button`: `href` en vez de `asChild`.** Sin Radix Slot. ¿Ok?
4. **Fecha corta.** `es-CO` da "20 sept"; la historia dice "20 sep".
   ¿Recorto a tres letras?
5. **Compact de 1e9.** ¿`COP 1.000 M` o `COP 1,0 mil M`? Propongo la
   primera.
6. **`Kpi` con `loading`, `DataTable` con `loading`/`sort`/`page`
   previstos.** No estaban en la lista; los dejo en la API sin
   implementarlos para que Rasheed no tenga que cambiar la firma en la
   semana 2. Si sobra, los quito.
