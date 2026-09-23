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

### 0.4 Permiso `finanzas.flujo.ver` — cerrado

Cuando se escribió el plan, ACC-1 no estaba en `main`. Entró el mismo
día, así que la pantalla ya no lleva el `TODO(ACC-1)`: abre con

```ts
await requirePermission("finanzas.flujo.ver");
```

como **primera línea**, antes de leer nada. `getCashflowInputs` no
vuelve a comprobarlo: este paquete no conoce la sesión —su barandilla
es la RLS— y duplicarlo daría dos sitios donde equivocarse; el
comentario de la función lo dice.

Probado en `app/(app)/finanzas/flujo/page.test.tsx`:

- con `permisosDeRol('creator','manager')` la página lanza
  `SinPermisoError` con `permiso === 'finanzas.flujo.ver'`, **y
  `getCashflowInputs` no llega a llamarse**: si se leyera antes del
  permiso, un rol sin él ya habría visto pasar las cifras por el
  servidor;
- con `permisosDeRol('creator','finance')` sí abre, que es lo que hace
  la diferencia entre probar el permiso y probar el rol.

El rol se inyecta sustituyendo `lib/permisos/sesion`, el mismo archivo
que ACC-3 cambiará cuando los permisos salgan de `role_permission`: la
prueba sigue valiendo entonces.

**Lo que falta y no es de esta historia:** hoy el error cae en la
frontera del segmento (`error.tsx`). Con **ACC-5** (`requireModule`)
será un 404, para no confirmar siquiera que la pantalla existe. La
comprobación no cambia; cambia dónde se traduce el error.

### 0.5 Fuera de alcance

Ingresos de plataformas (FIN-7), escenarios optimista/pesimista (fase
2), conversión de moneda, y la pantalla de gastos (FIN-5): FIN-6 lee
`expense`, no la escribe.

### 0.6 Correcciones tras `/code-review` (nivel alto)

El plan de arriba se deja como se escribió, antes de tocar código. Estas
son las siete cosas que la revisión encontró y cómo quedaron:

1. **Una factura en borrador hacía desaparecer el negocio.** `hasInvoice`
   contaba cualquier factura que no fuera `void`, pero las que «deben
   plata» son solo `sent`, `partial` y `overdue`. Como `createInvoice`
   siempre inserta en `draft` (FIN-1), entre crear la factura y marcarla
   enviada el negocio quedaba «ya facturado» y su factura fuera de los
   cobros: el monto se evaporaba de la proyección, en el camino normal.
   Ahora `hasInvoice` es `status NOT IN ('void', 'draft')`, con su
   prueba en PGlite que además comprueba el traspaso al marcarla
   enviada.
2. **El mes en curso hundía el ritmo de gastos.** «El mes más reciente
   con recurrentes» es el mes que se está registrando: el 3 de octubre,
   con una de cinco suscripciones anotada, el ritmo caía de 3 700 000 a
   380 000 y la caja proyectada subía más de 6 M. Ahora manda el último
   mes **cerrado**, y solo si no hay ninguno en la ventana se usa el
   mes en curso (un espacio recién abierto). La nota del gráfico dice de
   qué mes salió la cifra, así que el número tiene fuente comprobable.
3. **Un negocio con fecha pero sin monto decía «sin fecha de cierre».**
   Y además imprimía «por COP 0», que es justo el cero mudo que esta
   historia no quiere. Ahora tiene su propio grupo, `excluidos.sinMonto`,
   con su frase: «no tiene monto acordado, así que no hay cifra que
   proyectar».
4. **Los gastos del seed caducan.** `db/seed/0003` los escribe con
   fechas absolutas de 2026 mientras las facturas del mismo seed van
   con `CURRENT_DATE`; la ventana de la consulta es de 120 días, así que
   alrededor de enero de 2027 se salen. La prueba ya no fija «septiembre»:
   comprueba mes a mes lo que vino, y si no viene nada falla con un
   mensaje que dice exactamente qué arreglar en el seed. **Rasheed: si
   0003 es tuyo, pasar esos gastos a fechas relativas lo resuelve de
   raíz** (ver §1.5).
5. **Un gasto recurrente en otra moneda se avisaba una vez por mes.**
   Ahora todo lo de gastos —el ritmo y lo que se deja fuera por moneda—
   se mide en el mismo mes, así que una suscripción en USD se avisa una
   vez.
6. **`aria-labelledby` apuntaba a un id que no existe**, dejando esa
   región sin nombre accesible. `ChartCard` ya es un `<article>` con su
   encabezado: se quitó.
7. **Un `<details>` dentro de un `<span>`**, que es exactamente el
   anidamiento inválido que el comentario de al lado daba como motivo
   para no usar `CellMain`. Ahora es un `<div>`, que sí cabe en un `<td>`.

Además apareció `formatMonth` en `apps/web/lib/format.ts` (con sus
pruebas): nombrar el mes del que sale el ritmo es lo que convierte
«el último mes» en una cifra con fuente.

### 0.7 Dudas

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
3. **`db/seed/0003`: los gastos con fecha absoluta.** Las facturas del
   mismo seed van con `CURRENT_DATE ± n` para que la demo no envejezca;
   los gastos, no (`DATE '2026-09-01'`). La consulta del flujo mira los
   últimos 120 días, así que hacia enero de 2027 el seed se queda sin
   gastos recurrentes y la demo enseña el flujo sin la mitad de su
   historia. **No lo cambio yo** (no es mi carpeta); la prueba avisa con
   un mensaje que lo explica. Ver §0.6.4.
4. **`expense` no tiene índice por `incurred_on`.** Igual que arriba:
   `CREATE INDEX ON expense (workspace_id, incurred_on) WHERE
   is_recurring` cuando haya volumen. Tampoco lo pido hoy.
5. **Revisar la decisión §0.2.4** (cobro bruto vs. neto de retención)
   con Nicolás antes de que FIN-2 registre pagos: si cambia, cambia
   también qué escribe FIN-2 en `tax_reserve`.

## 2. Los tres criterios, cerrados

| «Terminado cuando…» | Cómo se comprueba |
|---|---|
| El gráfico sale de la función con los datos del seed | `packages/db/test/finanzas.test.ts` §FIN-6, y en dev las ocho filas con el seed |
| Un test cubre una semana con cobro, gasto e impuesto | `packages/core/test/flujo-caja.test.ts` › «una semana con cobro, gasto e impuesto» |
| El rol Mánager no puede abrir `/finanzas/flujo` | `app/(app)/finanzas/flujo/page.test.tsx` › «el rol Mánager no abre la pantalla, y NI SIQUIERA se lee la base» (§0.4) |

Lo único que queda para ACC-5 es convertir ese `SinPermisoError` en un
404; el permiso ya se comprueba.

## 3. Si FIN-5 cambia el modelo de gastos

FIN-6 proyecta el ritmo mensual de los recurrentes (§0.2.6) porque
`expense` solo sabe **cuándo se incurrió** (`incurred_on`) y **con qué
periodicidad** (`recurrence`), no cuándo se paga el siguiente. Si FIN-5
le añade una fecha de próximo cobro, esta historia mejora sola:
`projectCashflow` pasaría a colocar cada gasto en su semana igual que
coloca un cobro, y el prorrateo se borra. El punto de cambio es una
función de veinte líneas en `packages/core/src/flujo-caja.ts`, con sus
pruebas ya escritas alrededor.
