# Kit de interfaz (`components/ui/`)

Dueño: Nicolás (CIM-5). Este directorio nació en FIN-1 con el subconjunto
que Finanzas necesita, con las **mismas props que propone CIM-5** para
que la galería `/kit` los absorba sin cambiar ninguna firma.

## Principio: solo props, sin datos

Ningún componente consulta la base, hace fetch ni conoce el workspace.
Recibe valores ya formateados (`formatMoney`, `formatDate` de
`lib/format.ts`) y pinta. Server Components por defecto; `"use client"`
solo donde hay estado o eventos (los controles de formulario).

Colores solo por tokens del tema (`bg-bg`, `text-fg`, `border-line`,
`text-ok`, `text-warn`, `text-danger` y sus `-bg`). Nada hardcodeado.
Cifras con `tabular-nums` y Geist Mono.

## Componentes

| Componente | Archivo | Qué hace | Cliente |
|---|---|---|---|
| `Button` | `button.tsx` | `variant` primary/secondary/ghost/danger, `size`, `loading` (spinner + aria-busy), `href` renderiza un enlace | no |
| `Pill` | `pill.tsx` | `kind` good/warn/bad/neutral, texto obligatorio | no |
| `Field` | `field.tsx` | label + control + `help` + `error`; genera el id y pasa `aria-describedby`/`aria-invalid` por contexto | sí |
| `Input`, `Select`, `Textarea` | `input.tsx` | envoltorios finos del elemento nativo; heredan del `Field` | sí |
| `MoneyInput` | `money-input.tsx` | recibe y emite string decimal (`"5200000.50"`); muestra `5.200.000,50`; nunca `type="number"` | sí |
| `DateInput` | `date-input.tsx` | `type="date"`, entra y sale `YYYY-MM-DD` | sí |
| `EmptyState` | `empty-state.tsx` | `title`, `description`, `action` con `href` u `onClick` | no |
| `Kpi`, `KpiRow` | `kpi.tsx` | valor formateado, `note`, `delta` con flecha y signo en texto, `href`, `loading`; 1/2/4 columnas | no |
| `DataTable`, `CellMain` | `data-table.tsx` | `columns` con `align: "num"` y `render`, `rowKey`, `caption`, `emptyState`, `loading`, cabecera pegajosa | no |

Pendientes de CIM-5 (no están aquí): `LineChart`, `BarChart`, `ChartCard`,
`DataAsOf`, `DataTable.onRowClick`, ordenamiento y paginación.

## Cómo agregar uno

1. Un archivo por componente, props tipadas y exportadas, `className?`
   al final.
2. Sin datos ni fetch; el texto visible entra por props.
3. Accesible de fábrica: labels asociados, `aria-*`, foco visible, y el
   color nunca como único indicador.
4. Agrégalo a la tabla de arriba y, cuando exista, a `/kit`.

## Regla del plan

Agregar un componente es libre. **Cambiar uno existente pide PR revisado
por Nicolás**: una vez que Resumen, Ventas o Cotizar lo usan, cambiar la
API cuesta dos PR.
