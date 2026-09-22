# Kit de interfaz (`components/ui/`)

Componentes compartidos de MultiCampaign. Galería en `/kit` (bandera `kit`, encendida en desarrollo).

**Solo props, sin datos.** Ningún componente consulta la base ni conoce las consultas: recibe todo por props, ya formateado cuando es texto. Los colores son tokens del tema (`text-good`, `bg-surface`, `var(--s-tiktok)`), nunca un valor literal. Server Components por defecto; `"use client"` solo donde hay estado o eventos.

| Componente | Archivo | Una línea |
|---|---|---|
| `Button` | `button.tsx` | Acción con variant, size, loading (aria-busy) y `href` para enlaces. Cliente. |
| `Pill` | `pill.tsx` | Estado corto con punto de color: good, warn, bad, neutral. Texto obligatorio. |
| `Field`, `Input`, `Select`, `Textarea` | `field.tsx` | Etiqueta, ayuda y error; el control toma id, aria-describedby y aria-invalid por contexto. La validación la hace el formulario (zod). Cliente. |
| `MoneyInput` | `money-input.tsx` | Dinero como string decimal + moneda; miles es-CO, acepta pegar «5.200.000,50»; nunca `type=number`. Cliente. |
| `DateInput` | `date-input.tsx` | Fecha nativa con valor ISO de solo fecha. Cliente. |
| `Segmented` | `segmented.tsx` | Grupo de opciones excluyentes con aria-pressed y flechas: el filtro por red de Resumen. Cliente. |
| `EmptyState` | `empty-state.tsx` | Título, descripción y acción cuando no hay datos. |
| `DataAsOf` | `data-as-of.tsx` | «datos hasta el 20 sep · Instagram», con `<time>` y fecha en UTC. |
| `Kpi`, `KpiRow` | `kpi.tsx` | Cifra con nota, delta (signo en el texto), sparkline, enlace y esqueleto. Cuatro por fila en escritorio. |
| `DataTable`, `CellMain` | `data-table.tsx` | Columnas con align num, caption, vacío, carga, error, fila clicable. Cabecera fija con `maxHeight` (scroll interno). `sort` y `page` previstos sin implementar. |
| `LineChart` | `line-chart.tsx` | Líneas SVG con ventana sombreada, tooltip y teclado. `ariaLabel` obligatorio. Cliente. |
| `BarChart` | `bar-chart.tsx` | Barras apiladas o agrupadas, con Total. Cliente. |
| `ChartCard` | `chart-card.tsx` | Título, leyenda, «Ver tabla / Ver gráfico» (tabla derivada del mismo dato), nota, DataAsOf, carga y error. |
| `chart-utils.ts` | — | Colores por nombre de token y formato por nombre (`int`, `compact`, `pct`, `money`, `money-full`), para que crucen la frontera servidor → cliente. |

Contraste: los tokens cumplen AA en los dos temas; tres valores del tema claro se apartan del mock por eso (ver el comentario en `app/globals.css`).

Formato de cifras y fechas: `lib/format.ts` (`formatMoney`, `formatInt`, `formatCompact`, `formatPct`, `formatDelta`, `formatDate`, `formatDateRange`). Todo con Intl y es-CO.

## Agregar un componente

1. `components/ui/<nombre>.tsx` con sus props tipadas y exportadas, y `"use client"` solo si hace falta.
2. `<nombre>.test.tsx` con al menos el estado normal y el vacío.
3. Una `Section` en `app/(app)/kit/page.tsx` con uso mínimo y variantes: normal, vacío, cargando, error, valores largos.
4. Una fila en esta tabla.

## Regla del plan

Agregar un componente es libre. Cambiar la API de uno existente pide PR revisado por Nicolás: una vez que Resumen, Ventas o Cotizar lo usan, cambiarlo cuesta dos PR.
