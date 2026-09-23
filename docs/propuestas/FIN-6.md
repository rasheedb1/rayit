# FIN-6 · Flujo de caja proyectado — plan, decisiones y lo que necesito de Rasheed

Escrito para: Rasheed (dueño de `db/migrations/`, `lib/workspace/` y de
Ventas) y quien revise el PR. Fecha: 23 de septiembre de 2026. Rama
`nicolas/FIN-6-flujo-caja`, sobre `origin/main` (29460e3).

---

## 0. Plan (escrito antes de tocar código)

### 0.0 Lo primero: las dependencias que el encargo daba por hechas

El encargo dice «depende de FIN-2, FIN-5 (main) y VEN-3 (main)». Al
mirar `origin/main`:

| Historia | Qué prometía | Estado real en `origin/main` |
|---|---|---|
| VEN-3 | `deal` con etapa y `expected_close_date` | **Está.** Migración 0007, vista `deal_pipeline` (0010), seed 0002 con cuatro ganados. |
| FIN-2 | Pagos parciales y `tax_reserve` | **No está.** No hay pantalla ni consulta de pagos. Sí están las TABLAS `payment` y `tax_reserve` (0008) y `invoice.paid_amount`, y el seed 0003 las llena. |
| FIN-5 | Gastos con recibo, recurrentes, deducibles | **No está.** No hay `packages/core/src/flujo-caja.ts` en ninguna rama (`git ls-tree` sobre todas las remotas), ni pantalla de gastos. Sí está la TABLA `expense` (0008) con `is_recurring` y `recurrence`, y el seed 0003 la llena con cinco recurrentes mensuales de julio, agosto y septiembre. |

Conclusión: **FIN-6 se puede hacer entera** sin FIN-2 ni FIN-5, porque
lo que necesita de ellas es el esquema (que está desde 0008) y los
datos del seed (que están desde 0003), no sus pantallas. Lo que cambia:

- `flujo-caja.ts` lo **crea** esta historia; no lo hereda de FIN-5.
- Los cobros pendientes salen de `invoice.total − invoice.paid_amount`,
  que es lo que FIN-2 mantendrá cuando llegue. FIN-6 no lo escribe.
- No se leen `payment` ni `tax_reserve`: la reserva de FIN-6 es
  **proyectada** (lo que habrá que apartar), no la ya apartada (que es
  el cuarto KPI de `/finanzas`, de FIN-1).

**ACC-1 no está en `origin/main`** (vive sin empujar en la rama local
`nicolas/ACC-1-catalogo-permisos`). Así que, por la regla del repo, va
`// TODO(ACC-1): finanzas.flujo.ver` donde iría `requirePermission`. Ver
§0.4.

### 0.1 Archivos

| Qué | Dónde |
|---|---|
| La función pura y sus tipos | `platform/packages/core/src/flujo-caja.ts` (nuevo) |
| Exportarla | `platform/packages/core/src/index.ts` (una línea) |
| Pruebas de la función | `platform/packages/core/test/flujo-caja.test.ts` (nuevo) |
| `getCashflowInputs(tx)` | `platform/packages/db/src/queries/finanzas.ts` (sección nueva al final) |
| Pruebas en PGlite con el seed + RLS negativa | `platform/packages/db/test/finanzas.test.ts` (bloque nuevo) |
| Pantalla | `platform/apps/web/app/(app)/finanzas/flujo/{page.tsx,loading.tsx,error.tsx,vista.tsx}` (nuevos) |
| Textos | `platform/apps/web/app/(app)/finanzas/_lib/messages.ts` (bloque `flujo`) |
| Prueba de pantalla | `platform/apps/web/app/(app)/finanzas/flujo/page.test.tsx` (nueva) |
| Enlace desde `/finanzas` | `platform/apps/web/app/(app)/finanzas/page.tsx` (un botón) |
| Estado de la historia | `platform/apps/web/content/backlog.ts` (solo FIN-6) |
| Documentación | `platform/packages/db/README.md` no cambia; este archivo |

No toco `db/migrations/` (la historia no lleva migración), ni
`lib/workspace/`, ni `queries/ventas.ts`, ni nada de Ventas.

### 0.2 Decisiones

1. **La semana empieza el lunes, en la zona del workspace, y las fechas
   son `'YYYY-MM-DD'` puras.** `hoy` lo calcula la consulta con
   `hoyEnZona(ws.timezone)` de `@mc/core/zonas` —no `CURRENT_DATE`, que
   es la fecha del servidor de base—, y de ahí en adelante la función
   solo hace aritmética de calendario sobre cadenas: nunca construye un
   `Date` con hora local. La ventana es `[lunes de esta semana, +56
   días)`: ocho semanas, y la semana en curso es la primera.
   *Descartado:* semanas que empiezan hoy (los rangos no casarían con
   «S38, S39…» ni con cómo mira el calendario un creador), y `date_trunc('week')`
   en SQL (ata la semana a la zona del servidor de base, no a la del
   workspace).

2. **Las facturas vencidas NO entran en ninguna semana; se cuentan y se
   explican.** Es la opción conservadora: la proyección es un piso, y
   una factura con 41 días de mora y dos recordatorios enviados no es
   plata con fecha. No desaparece: sale en `excluidos.vencidas` y la
   pantalla lo dice con una frase bajo la tabla, con enlace a
   `/finanzas?estado=por_cobrar`. *Descartado:* meterla en la semana 1
   con la marca «vencida» —infla el KPI «Caja proyectada» con dinero
   que ya falló una vez, y el gráfico la pinta igual que un cobro
   sano—.

3. **Negocios ganados sin factura.** Se toman los `deal` cuya etapa
   tiene `is_won` (nunca el literal `'ganado'`: lo dice la vista
   `deal_pipeline` y el propio seed) y que **no** tienen ninguna
   `invoice` colgando de su campaña (`invoice.campaign_id →
   campaign.deal_id`) ni de su cotización (`invoice.quote_id →
   quote.deal_id`). El cobro se espera en `expected_close_date +
   plazo_dias` del workspace. Sin `expected_close_date`, fuera, contado
   en `excluidos.sinFecha` («N negocios por X»). *Por qué importa:* en
   el seed los cuatro ganados están enlazados a su campaña y su
   factura; sin ese `NOT EXISTS` la proyección contaría 9,4 M dos
   veces.

4. **La reserva de impuestos.** `impuestos =
   reserva_pct × cobros de la semana`, con
   `workspace.settings.finanzas.reserva_pct` (11 % en el seed) y
   `mulRateHalfUp`. La retención en la fuente **no** se resta del
   cobro: es un anticipo del mismo impuesto de renta que la reserva
   aparta, y descontarla además sería apartar dos veces por el mismo
   tributo. Por eso el cobro esperado de una factura es
   `total − paid_amount` (lo que la marca debe), que además es la cifra
   que enseñan el mock, `/finanzas` y la vista `receivables`.
   **DECISIÓN PENDIENTE DE NICOLÁS:** la alternativa es tomar como
   cobro el neto que entra al banco (`total − withholding −
   paid_amount`) y aplicar la reserva sobre él; es ~10 % más
   conservadora y más fiel a la caja, pero deja el gráfico sin cuadrar
   con los montos de las facturas. Cambiarlo es una línea en
   `queries/finanzas.ts` (`outstanding`) y dos pruebas.

5. **Monedas.** Todo lo que no venga en la moneda del workspace queda
   fuera y se cuenta en `excluidos.otraMoneda`, con la lista de
   monedas, y la pantalla lo dice con una frase. No hay conversión en
   el MVP (fuera de alcance, §0.5).

6. **Los gastos recurrentes.** Se proyecta el **ritmo mensual** de los
   recurrentes (`is_recurring`), repartido por semana:
   `semanal = mensual × 12 / 52`, en centavos y con redondeo mitad
   hacia arriba (3 700 000,00 → 853 846,15). El «mensual» es la suma de
   los recurrentes del **mes más reciente que tenga alguno** —en el
   seed, septiembre: 3 700 000— y no la suma de todos, porque el seed
   (y FIN-5) registran la misma suscripción una vez por mes: sumarlos
   todos daría 11,1 M/mes. *Descartado:* proyectar cada gasto en su
   aniversario mensual (`incurred_on + n meses`). Deja seis de ocho
   semanas en cero y dos con 3,7 M, que no es «entre 1,1 y 1,7 M por
   semana» como dicen el mock y el comentario del propio seed 0003; y
   `incurred_on` es cuándo se incurrió, no cuándo se paga, así que el
   aniversario sería una invención. *Descartado también:* promedio de
   los últimos tres meses (un gasto que se dio de baja seguiría
   proyectándose un trimestre).

7. **La forma del resultado.**
   `{ semanas: [{ inicio, fin, cobros, gastos, impuestos, neto,
   acumulado, detalle }], excluidos, proyectado, semanaMasAjustada,
   gastoMensual, gastoSemanal, reservaRate, vacio }`. **Todo el dinero
   es `Decimal` (string).** Ni un `number` sale de la función; los
   `number` aparecen solo en la pantalla, al convertir para los píxeles
   del gráfico, que es lo que el kit pide (`Series.data: number[]`).

8. **Gráfico: barras agrupadas, dos series.** «Cobros esperados»
   (accent) y «Gastos e impuestos» (deemph), como el mock
   (`dashboard/local/app.js`, `mode: 'group'`) y como la propia galería
   del kit, que ya trae este gráfico con el nombre «Flujo de caja
   proyectado» (`app/(app)/kit/page.tsx`). *Descartado:* apiladas —
   apilar cobros sobre gastos produce un total que no significa nada—;
   y `LineChart` del acumulado — la pregunta semanal es «¿entra más de
   lo que sale?», que se lee de un vistazo con dos barras al lado; el
   acumulado va en su columna de la tabla y en el KPI, que es donde una
   sola cifra basta. A 400 px caben dos barras por semana, no tres: por
   eso gastos e impuestos van sumados en el gráfico y separados en la
   tabla.

9. **El detalle por semana, sin tocar la API del kit.** Una columna
   «Detalle» con un `<details>/<summary>` nativo dentro de la celda:
   `DataTable` no tiene filas expandibles y cambiarle la API pide un PR
   aparte (regla de `components/ui/README.md`). Sin JavaScript, sin
   estado, accesible y legible a 400 px.

10. **`getCashflowInputs(tx)` es UNA consulta.** Un solo `tx.query` con
    cuatro CTE (workspace, facturas, negocios, gastos) que devuelve las
    filas en bruto; toda la clasificación —vencida, ya facturado, sin
    fecha, otra moneda, fuera de ventana— la hace la función pura, que
    es la que se puede probar en milisegundos. La consulta no devuelve
    ningún id `bigserial` (CIM-2 §3); `expense.id` y las demás son
    `uuid`.

### 0.3 Aislamiento

Todo pasa por `withWorkspace`: RLS filtra `invoice`, `deal`, `campaign`,
`quote`, `expense` y `workspace`. La prueba negativa abre la misma
consulta con un workspace ajeno y exige cero filas y cero cobros.

### 0.4 Permiso `finanzas.flujo.ver`

ACC-1 no está en `origin/main`, así que la pantalla abre con
`// TODO(ACC-1): finanzas.flujo.ver` y `getCashflowInputs` lleva el
mismo comentario. Cuando ACC-1 entre a `main`, el cambio es una línea
en `app/(app)/finanzas/flujo/page.tsx`:

```ts
await requirePermission("finanzas.flujo.ver");   // ACC-1 + ACC-5
```

Lo que **sí** queda probado hoy es el aislamiento por workspace (§0.3).
Lo que **no** se puede probar hoy es que el rol «Mánager» reciba 404:
`permisosDeRol('creator','manager')` vive en la rama de ACC-1 y
`requirePermission` todavía no existe en ninguna (es ACC-5/ACC-6).
Queda anotado en §2 como el único criterio abierto de esta historia.

### 0.5 Fuera de alcance

Ingresos de plataformas (FIN-7), escenarios optimista/pesimista (fase
2), conversión de moneda, y la pantalla de gastos (FIN-5): FIN-6 lee
`expense`, no la escribe.

### 0.6 Dudas

- La de §0.2.4 (cobro bruto vs. neto de retención).
- Si FIN-5 acaba dando a `expense` una columna «próximo cobro»
  (`next_due_on`), la decisión §0.2.6 se cae sola y el prorrateo se
  reemplaza por esa fecha. Lo anoto en §3.

---

## 1. Lo que necesito de Rasheed

**Nada bloqueante.** FIN-6 no lleva migración, no toca `db/migrations/`,
ni `lib/workspace/`, ni `lib/auth/`, ni `packages/db/src/{client,schema}`,
ni `queries/ventas.ts`. Lo que sí le pido, por orden de urgencia:

1. **Nada de Ventas hace falta hoy.** `deal` ya trae `amount`,
   `currency`, `stage_id` y `expected_close_date`, y
   `pipeline_stage.is_won` es lo que distingue un ganado. La consulta
   del flujo vive en `queries/finanzas.ts` y **no importa** nada de
   `queries/ventas.ts`: solo se leyó para copiar el criterio.
2. **Un índice, cuando el volumen lo pida.** La consulta filtra
   `deal` por `st.is_won` con un JOIN, y hoy `deal` solo tiene
   `(workspace_id, stage_id)`. Con un puñado de negocios por espacio
   sobra; si el piloto crece, el índice que ayudaría es
   `CREATE INDEX ON deal (workspace_id, expected_close_date) WHERE
   won_at IS NOT NULL`. **No lo pido todavía**: sería optimizar sin
   medir.
3. **`expense` no tiene índice por `incurred_on`.** Igual que arriba:
   `CREATE INDEX ON expense (workspace_id, incurred_on) WHERE
   is_recurring` cuando haya volumen. Tampoco lo pido hoy.
4. **Revisar la decisión §0.2.4** (cobro bruto vs. neto de retención)
   con Nicolás antes de que FIN-2 registre pagos: si cambia, cambia
   también qué escribe FIN-2 en `tax_reserve`.

## 2. El criterio que queda abierto

«El rol Mánager no puede abrir `/finanzas/flujo`». Hoy no se puede
cerrar y no es por esta historia:

- `ACC-1` (el catálogo con `finanzas.flujo.ver` y los roles de fábrica)
  no está en `origin/main`.
- `requirePermission` no existe todavía en ninguna rama: es `ACC-5` /
  `ACC-6`.

Lo que hay en su lugar: `// TODO(ACC-1): finanzas.flujo.ver` en
`app/(app)/finanzas/flujo/page.tsx` y en `getCashflowInputs`, y el
aislamiento por workspace sí probado (`packages/db/test/finanzas.test.ts`,
«desde otro workspace no hay facturas, ni negocios, ni gastos»). Cuando
ACC-1 y ACC-5 entren a `main`, cerrar el criterio es una línea y una
prueba.

## 3. Si FIN-5 cambia el modelo de gastos

FIN-6 proyecta el ritmo mensual de los recurrentes (§0.2.6) porque
`expense` solo sabe **cuándo se incurrió** (`incurred_on`) y **con qué
periodicidad** (`recurrence`), no cuándo se paga el siguiente. Si FIN-5
le añade una fecha de próximo cobro, esta historia mejora sola:
`projectCashflow` pasaría a colocar cada gasto en su semana igual que
coloca un cobro, y el prorrateo se borra. El punto de cambio es una
función de veinte líneas en `packages/core/src/flujo-caja.ts`, con sus
pruebas ya escritas alrededor.
