# Pulido de Cotizar (R5-COT) · 10-oct-2026

Escrito para: Rasheed y Nicolás. Cotizar (COT-1 a COT-4) está en `main`
desde la fase 2; esto es el pulido final del 28-sep y sus dos costuras.

## 1. Qué quedó hecho

| Hallazgo (pendientes-pulido-final.json) | Estado |
|---|---|
| `FechaInput` es un parche del kit (`cotizar/_ui/fecha.tsx`) | **Hecho en el kit**: `DateInput` pinta el anillo también con `focus:` (en Chromium un `<input type="date">` no casa `:focus-visible` desde su segmento); el parche y su prueba pasan a `components/ui/date-input.test.tsx`; los tres formularios importan `DateInput`. Es carpeta de Nicolás: Nicolás lo autorizó y lo mezcla él |
| El tarifario vacío solo ofrece «Ver conexiones» | **Hecho**: segundo enlace a `/resumen/importar` («O importa un CSV de tu red»), como `SinConexiones` en Resumen; prueba `(tarifario)/vacio.test.tsx` |
| Hidratación #418 en `/kit/<slug>` (una vez en nueve recorridos) | **No reproducido**: `MediaKitVista` formatea con `formatterFor` del snapshot (locale, moneda y zona congelados) y `protegido.tsx` no formatea fechas; la única fuente plausible es una diferencia de datos ICU entre Node y el navegador en `Intl` (nombres de país, `formatCountry`). Queda como observación; si vuelve a verse, envolver el nombre de país en `suppressHydrationWarning` o formatearlo en el servidor |

**Costuras.** COT-4 ↔ CAM-2 con alcance: `crearCampanaDeCotizacion`
sobre una cotización fuera del alcance redirige con `?error=ScopeError`
y el texto de pantalla es el de `ScopeError` (prueba en
`cotizar/actions.test.ts`, ya existía desde ACC-7). COT ↔ ACC-7:
`createQuote` exige el creador del negocio y del alcance (R2-ACC, dos
pruebas en `alcance-rls.test.ts`).

## 2. Decisiones pendientes de COT-1 a COT-4

Las que dejaron las propuestas siguen en sus tablas (`docs/propuestas/`
de cada historia); ninguna cambió aquí. Dos nuevas:

| Pregunta | Lo que quedó | Si se quiere lo contrario |
|---|---|---|
| ¿`DateInput` con anillo `focus:` para todo el kit o solo para Cotizar? | Para todo el kit: el defecto es del control nativo, no de Cotizar; Ventas y Finanzas lo heredan | Volver al parche local en `cotizar/_ui/` |
| ¿La fila de «Cómo verlo» del hallazgo de hidratación? | No se añade una prueba de render «sin avisos de hidratación» porque en jsdom no hay hidratación real; una prueba así pasaría siempre | Prueba de extremo a extremo con navegador (fuera del alcance del MVP) |
