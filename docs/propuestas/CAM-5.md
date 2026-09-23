# CAM-5 · Resultado de campaña — plan y lo que Rasheed tiene que saber

Escrito para: Rasheed (dueño de `db/migrations/`, de `esquema.ts` y de
VEN-6, que leerá `campaign_result`), Nicolás (dueño del módulo) y quien
revise el PR. Fecha: 23 de septiembre de 2026. Rama
`nicolas/CAM-5-resultado-campana`, **encadenada sobre
`nicolas/CAM-4-aporte-marca`** (CAM-4 sin mergear) y con el commit de
core de CAM-3 (`ritmoSeguidores`, cherry-pick de `4af946a`, que está en
la rama local de CAM-3 y no en `origin`).

---

## 0. Plan (escrito antes de tocar código)

### 0.1 Lo que encontré antes de decidir

| Qué | Dónde | Consecuencia |
|---|---|---|
| `mc_app` solo tiene `SELECT` sobre `campaign_result` | 0025 §5 (`REVOKE INSERT, UPDATE, DELETE`), `esquema.ts` (`PRIVILEGIOS_DE_LA_APP`) | El botón «Recalcular» no puede escribir como `mc_app`. |
| La web no llega a la cola | pg-boss vive en el esquema `pgboss`, sin privilegios para `mc_app`; el worker no está desplegado (CIM-7) | «El botón encola» no tiene camino hoy. |
| Dos lecturas a 720 h por post en el seed | 0002 (curva, `source api`) y 0003 (lectura manual, capturada después) | A igual edad manda la capturada más tarde: es la corrección. Con eso el alcance de Café Alma es 486 000, el del seed. |
| `post_metrics_at_cut` no trae `link_clicks` ni `reach_non_followers` | 0010 | El corte se lee de `post_metric_snapshot` con la misma regla («el más cercano sin pasarse») más el desempate de arriba. |
| `creator_baseline` tiene filas fiables | seed 0002 (por red y corte, `is_reliable`) | `views_vs_median` se calcula leyendo la tabla, que es el contrato de CON-6; no hace falta el código de CON-6. |
| Fresko no llega a 720 h | sus posts van por 480 y 384 h | Su resultado sale parcial, a 7 días. |
| La serie de @cafealma está en `main` | seed 0003 §2 | `ritmoSeguidores` (CAM-3) da 1 240, 12,9286 y 155. |

### 0.2 Archivos

| Qué | Dónde |
|---|---|
| `calcularResultado(entradas)` pura, los nombres de `missing_inputs`, el corte, la aritmética de dinero en centavos | `packages/core/src/campanas.ts` + `test/campanas.test.ts` |
| `getResultInputs`, `upsertResult`, `getCampaignResult`, `listCampaignsToCompute`, `canRecomputeResult` | `packages/db/src/queries/campanas.ts` + `test/campanas.test.ts` |
| Job `campaign.compute` | `apps/worker/src/jobs/campanas/campaign-compute.ts`, `index.ts`, y una línea en `jobs/index.ts` + `test/campaign-compute.test.ts` |
| Sección «Resultado» y acción `recalcularResultado` | `apps/web/app/(app)/campanas/[id]/page.tsx`, `resultado.tsx`, `actions.ts`, `_lib/messages.ts` |

Sin migraciones.

### 0.3 Decisiones

1. **Corte.** 720 h si todos los posts lo alcanzaron; si no, el mayor de
   `AGE_CUTS_HOURS` que todos alcanzaron. Un post alcanza el corte C si
   tiene una lectura con `age_hours ≤ C` y otra con `age_hours ≥ C` (sin
   la segunda, el valor «a C» todavía puede crecer). A igual edad, la
   capturada más tarde. Sin ningún corte común: cifras nulas y `posts` en
   `missing_inputs`. Un resultado por debajo de 720 h se marca «parcial,
   a 7 días» y el job lo recalcula cada mañana hasta llegar a 30 días.
   Descartado: el mayor corte de cada post por separado (sumaría views a
   30 días de uno con views a 7 días de otro).
2. **`views_vs_median`.** Por post, views al corte ÷ mediana de su red al
   mismo corte (la línea base más reciente del creador, fiable y con
   muestra ≥ 8), y el promedio ponderado por views. Si algún post no
   tiene línea base fiable: null y `baseline`.
3. **`reach_non_followers_pct`** = Σ no seguidores ÷ Σ alcance sobre los
   posts que traen los dos. Las sumas de cifras (views, alcance, clics…)
   exigen el dato en **todos** los posts: si falta en uno, la suma es
   null, no una suma incompleta.
4. **Canjes e ingresos** (contrato de CAM-4): la suma del CSV si existe;
   si no, el último total manual. Si hay los dos manda el CSV, y la ficha
   lo dice. Ingresos manuales en otra moneda que la de la campaña no se
   atribuyen (null). Sin ningún aporte: `brand_inputs`. Con aportes pero
   sin CSV de ventas: `brand_csv_sales` (lo que dice el seed de Café Alma).
5. **Tipos.** Dinero y CPM/CPA en `Decimal` (texto) calculados con
   centavos en `BigInt`, redondeo mitad hacia arriba; conteos en enteros;
   porcentaje con 5 decimales, `vs_median` con 3, ritmos con 4 (las
   escalas de 0008). Ninguna división por cero: null.
6. **Quién escribe.** El job como `mc_worker`, con `workspace_id`
   explícito en cada SELECT y en el UPSERT (`ON CONFLICT (campaign_id) DO
   UPDATE … WHERE campaign_result.workspace_id = EXCLUDED.workspace_id`),
   con `computed_at`. Es un materializado: se reemplaza.
   **El botón**: `mc_app` no tiene INSERT ni UPDATE, y la web no puede
   encolar. **DECISIÓN PENDIENTE DE NICOLÁS**, opción conservadora
   tomada: no hay migración; el GRANT va propuesto en §2 para Rasheed; la
   acción `recalcularResultado` existe y escribe como `mc_app` dentro de
   `withWorkspace`, y la ficha solo enseña el botón si la base lo permite
   (`has_table_privilege` en la misma lectura). Hasta el GRANT, la ficha
   dice «Se recalcula cada mañana». Así el día que se aplique el GRANT el
   botón aparece solo. Descartado: escribir la migración (la historia
   dice «sin migraciones» y el reparto de privilegios de 0025 es de
   Rasheed); encolar desde la web (no hay camino).
7. **Transición.** Con `missing_inputs` vacío y corte 720 en una campaña
   `measuring`, la ficha sugiere «Resultado completo: marca el reporte
   listo»; el cambio lo hace la persona con el botón de CAM-1.
8. **EMV** siempre null (**DECISIÓN PENDIENTE DE NICOLÁS**: no hay
   fórmula acordada).
9. **Qué recalcula el job.** Campañas `live`, `measuring` y `reported`.
   `closed` y `cancelled` no se tocan: su resultado queda congelado.
10. **Seguidores de la marca.** `ritmoSeguidores` de CAM-3 por cada red
    de `brand_accounts` con serie; ganados y ritmos se suman entre redes.
    Sin serie: `brand_followers`. Con ritmo pero línea base de menos de
    14 días: `brand_followers_baseline_short`.

### 0.4 Números que el seed tiene que dar (y los del mock que no)

| Campaña | Cifra | Esperado | El seed (mock) decía |
|---|---|---|---|
| Café Alma | views · alcance · interacciones | 712 000 · 486 000 · 57 530 | 57 630 |
| Café Alma | no seguidores | 0,58025 | 0,58000 |
| Café Alma | ganados · ritmos | 1 240 · 12,9286 · 155,0000 | igual |
| Café Alma | canjes · ingresos | 318 · 8 400 000,00 | igual |
| Café Alma | CPM · costo por seguidor · CPA | 4 353,93 · 2 500,00 · 9 748,43 | 11 800 · 2 500 · 26 400 |
| Café Alma | vs mediana | 4,496 (Instagram 412 000 / 69 000 y TikTok 300 000 / 121 500, ponderado) | null |
| Café Alma | falta | `brand_csv_sales` | igual |
| Nutrivé | falta | `brand_inputs`, `brand_followers` | igual |
| Hogar Lindo | views · CPA · falta | null · 26 190,48 · `posts`, `brand_followers`, `brand_csv_sales` | 94 000 · igual · `brand_followers` |

Los 57 530 salen de las interacciones de las dos lecturas manuales
(34 710 + 22 820); el mock tenía 57 630.

### 0.5 Dudas

- La línea base se toma «la más reciente» del creador. Si CON-6 decide
  que se compara contra la línea base vigente al publicar, cambia una
  consulta.
- Con el GRANT sin aplicar, en producción `campaign_result` sigue con las
  cifras del mock hasta que el worker corra contra Supabase (CIM-7).

---

## 1. Lo hecho

| Paso | Commit | Qué |
|---|---|---|
| Dependencia | `a9c9790` | Cherry-pick del core de CAM-3 (`ritmoSeguidores`), con conflicto resuelto a mano: CAM-4 y CAM-3 añadían secciones al final de los mismos dos archivos. Al integrar CAM-3 puede volver a pedir esa misma resolución (conservar las dos secciones). |
| Plan | `a33819b` | §0 de esta propuesta. |
| Core | `a3d3c4f` | `calcularResultado`, `MISSING_INPUTS`, `followerRateMultiple`, `isResultComplete`. |
| Consultas | `f280e7e` | `getResultInputs`, `upsertResult`, `computeCampaignResult`, `listCampaignsToCompute`, `getCampaignResult`, `canRecomputeResult`. |
| Job | `f88f633` | `campaign.compute` y su prueba en el arnés con los seeds reales. |
| Pantalla | `8099cf6`, `55f9cff` | Sección «Resultado» y acción `recalcularResultado`. |
| Revisión | `ea43637` | Los ocho hallazgos corregidos de §4. |

Una nota de producto que sale de aquí: con el seed, **Café Alma
recalculada tiene `views_vs_median` 4,496** (el seed lo dejaba null) y
las interacciones pasan de 57 630 (mock) a 57 530 (la suma real de las
lecturas manuales).

## 2. Lo que necesita Rasheed

| # | Qué | Por qué | Urgencia |
|---|---|---|---|
| 1 | **DECISIÓN PENDIENTE DE NICOLÁS, y luego Rasheed**: una migración con `GRANT INSERT, UPDATE ON campaign_result TO mc_app;` y el cambio de `campaign_result` en `PRIVILEGIOS_DE_LA_APP` (`packages/db/src/esquema.ts`) de `['SELECT']` a `['SELECT', 'INSERT', 'UPDATE']` con el motivo «el botón Recalcular de CAM-5». Sin DELETE. La política `campaign_result_ws_isolation` ya aísla la escritura (USING sirve de WITH CHECK). | 0025 le quitó a `mc_app` la escritura porque «lo consolida el worker», pero el worker no está desplegado (CIM-7) y la web no llega a la cola. Sin esto, en producción `campaign_result` conserva las cifras del mock (CPM 11 800) hasta CIM-7. Con esto, «Recalcular» aparece solo en la ficha: no hay que tocar código. Probado en PGlite (`packages/db/test/campanas.test.ts`, bloque «con el GRANT propuesto») y en dev con el GRANT en un seed local no commiteado. | Alta si se quiere el resultado real antes de CIM-7. |
| 2 | Nada de esquema: `campaign_result` ya tiene todas las columnas. | — | — |
| 3 | El GRANT del worker (`mc_worker` sobre `campaign_result`) ya está en 0014. | — | — |

| 4 | Permiso nuevo `campanas.resultado.calcular` en `packages/core/src/permisos.ts` (44 permisos, 225 filas de la matriz; snapshot `test/snapshots/permisos.sql` regenerado). Cuando ACC-3 aplique la semilla, entra con `pnpm --filter @mc/core permisos:sql`. `docs/propuestas/ACC-1.md` sigue diciendo 43: es la foto de ACC-1. | El botón «Recalcular» abre con `requirePermission`. | Con ACC-3. |

Sin migraciones en esta rama y sin variables nuevas.

## 3. Contrato de lectura para CAM-6 y VEN-6

`campaign_result` es una fila por campaña, reemplazada cada mañana (y
por «Recalcular»). Se lee con `getCampaignResult(tx, campaignId)` de
`@mc/db` o por SQL con RLS:

| Columna | Qué es | null significa |
|---|---|---|
| `computed_at` | cuándo se calculó | — |
| `cut_hours` | 720 si todos los posts llegaron a 30 días; si no, el mayor corte que todos alcanzaron (168, 72, 24) | — (**sin sentido si `missing_inputs` trae `posts`**: queda en 720 porque la columna es NOT NULL) |
| `views`, `reach`, `interactions`, `saves`, `shares`, `link_clicks` | suma de los posts al corte | algún post no trae el dato, o no hay posts medidos |
| `reach_non_followers_pct` | 0..1, sobre los posts que traen alcance y no seguidores | ningún post lo trae |
| `views_vs_median` | promedio ponderado por views de views ÷ mediana del creador en la red y el corte | falta línea base fiable (`baseline`) |
| `brand_followers_gained`, `…_baseline_rate`, `…_campaign_rate` | seguidores de la marca y sus ritmos (por día), sumados entre las redes que tienen los dos ritmos | no hay serie (`brand_followers`); con `brand_followers_baseline_short`, el «×N» no se presenta |
| `code_redemptions`, `attributed_revenue` | del CSV de ventas si existe; si no, el último total manual (CAM-4) | la marca no lo reportó; ingresos manuales en otra moneda no se atribuyen |
| `cpm`, `cost_per_follower`, `cpa` | monto ÷ views × 1000, ÷ ganados, ÷ canjes, al centavo | falta el monto o el divisor es 0 o null |
| `emv` | siempre null (DECISIÓN PENDIENTE DE NICOLÁS) | — |
| `missing_inputs` | qué falta, con los nombres de `MISSING_INPUTS` en core | — |

Para VEN-6 (pitch con cifras trazables): cada cifra enlaza a la
campaña y a `computed_at`; si `missing_inputs` no está vacío, el pitch
no debería presentar esa campaña como «completa». Para CAM-6: el
payload congelado copia la fila y `missing_inputs` tal cual.

## 4. Revisión (`/code-review` en nivel alto)

Diez hallazgos. Ocho corregidos con su prueba, dos justificados.

| # | Hallazgo | Qué se hizo |
|---|---|---|
| 1 | `views_vs_median` sin tope desbordaba `numeric(8,3)` y el UPSERT fallaba siempre. | **Corregido.** Topes de las tres escalas de 0008. Prueba «una razón que no cabe…». |
| 2 | Los ritmos de la marca se sumaban sobre redes distintas (el «×N» se inflaba). | **Corregido.** Solo las redes con los dos ritmos. Prueba «los dos ritmos se suman sobre las mismas redes». |
| 3 | El «×N» se enseñaba con línea base corta. | **Corregido.** Dice «línea base corta: sin ritmo comparable». Prueba de la sección. |
| 4 | Sin posts medidos, la ficha decía «a 30 días». | **Corregido.** Dice «sin posts medidos», y el contrato de §3 lo advierte para `cut_hours`. |
| 5 | La frase «salen del CSV» no seguía la elección real por concepto. | **Corregido.** `brandFigures` en core decide para la cuenta y para la frase. Pruebas en core y en la sección. |
| 6 | La nota del CPA culpaba a la marca aunque faltara el monto. | **Corregido.** Tres causas con su frase. |
| 7 | Ingresos en otra moneda se descartaban sin decirlo. | **Corregido** en la ficha (frase con la moneda). No hay nombre en `missing_inputs` porque la lista es fija por la historia. Un conteo no entero no puede entrar por CAM-4 (formulario y CSV solo aceptan enteros). |
| 8 | Un post sin lecturas deja a toda la campaña sin cifras. | **Justificado.** Es la regla de la historia («el mayor corte que TODOS alcanzaron»): sumar los que sí tienen daría una cifra de campaña que no lo es. El texto de «Falta» ahora dice «asocia los posts o espera su primera lectura». |
| 9 | `computeCampaignResult` ignoraba un UPSERT que no escribió. | **Corregido.** `ResultNotWrittenError`. |
| 10 | Limpieza: `mapLimit` importado del job de otro módulo; serie armada con copias; `versusMedian` no reutilizado. | **Corregido** lo primero (`runner/concurrency.ts`) y lo segundo. **Justificado** lo tercero: `versusMedian` redondea cada post a tres decimales antes de ponderar y exige la muestra aparte; la ponderación necesita la razón sin redondear. |
