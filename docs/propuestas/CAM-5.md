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

(Se completa al cerrar.)

## 2. Lo que necesita Rasheed

(Se completa al cerrar.)

## 3. Contrato de lectura para CAM-6 y VEN-6

(Se completa al cerrar.)
