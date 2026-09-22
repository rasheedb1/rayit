# CIM-6 · Seed de ventas y métricas — cifras, decisiones y cómo se verifica

Escrito para: quien revise el PR de CIM-6, y para quien construya
Resumen (RES-1), Mis videos y Ventas (VEN-*) sobre estos datos.
Fecha: 22 de septiembre de 2026.

Archivo: `platform/db/seed/0002_demo_ventas_metricas.sql`.
Verificación: `platform/db/seed/verify/0002.sql` con el runner genérico
`platform/db/seed/verify/run.mjs` (`make db.seed.check`).

---

## 1. Qué deja el seed

Una creadora (Laura Méndez, `@laura.cocinafacil`, COP, `America/Bogota`)
con cuatro redes conectadas y todo lo que Resumen, Mis videos y Ventas
necesitan para parecerse al mock (`dashboard/local/app.js`):

| Bloque | Filas | De dónde salen las cifras |
|---|---|---|
| `social_connection` | 4 (TikTok, Instagram, YouTube, Facebook) | `secret_ref = seed://…`, `status = active`, sincronizadas hace 2–6 h. YouTube y TikTok con el acceso a punto de vencer, para que `connection_health` tenga algo que decir. |
| `post` | 60 en 120 días (21 · 17 · 12 · 10) | Los doce de la tabla "Mis videos" del mock con sus views, guardados, no seguidores y salto a 3 s; los cinco de las campañas de 0003 (ids `d01..d05`, texto y fechas idénticos); 43 más con títulos de cocina fácil. |
| `post_metric_snapshot` | ≈ 2 600 (crece con la edad de los videos) | Curva acumulada por video: lecturas a 1, 3, 6, 12, 24, 48 y 72 h y luego diarias hasta 90 días. `age_hours` exacta por construcción. |
| `account_metric_snapshot` | 360 (4 × 90 días) | Seguidores de los valores de hace 90 días a `FOLLOWERS_NOW` (214 000 · 128 000 · 49 000 · 21 000 = 412 000) con el salto de TikTok de la semana 9 y el empujón de Instagram; views diarias de la base semanal del mock. |
| `audience_breakdown` | 60 (4 × 15 buckets) | Edad, género y país. Instagram es la base del media kit (71 % entre 18 y 34, 64 % mujeres, Colombia 71 %); cada red se desvía unos puntos y sigue sumando 1. |
| `creator_baseline` | 16 (4 redes × 4 cortes) | **Calculada** sobre las lecturas con la regla de `scoring.ts`. Todas `is_reliable`. |
| `post_score` | 59 (todo video con ≥ 24 h) | **Calculado** contra la línea base de su red en el mayor corte alcanzado. |
| `company` / `company_link` | 8 / 8 | Las cuatro de 0003 (Café Alma, Fresko Market, Hogar Lindo, Nutrivé) y cuatro del radar (Sabores Caseros, Granos del Valle, Vitalé, Olla Fácil). |
| `contact` | 12, uno con `opted_out` | Procedencia obligatoria; Mateo Giraldo pidió la baja y el disparador de `outbound_touch` lo protege. |
| `signal` | 12 (6 aceptadas con deal, 4 por revisar, 1 duplicada, 1 descartada) | Fuentes del catálogo; `dedupe_key` única. |
| `deal` | 15 (8 abiertos, 4 ganados, 3 perdidos) | Ver §2. |
| `deal_stage_history` / `activity` | 50 / 36 | La línea de tiempo de Fresko Market es la del mock (`COMPANIES`), fecha por fecha. |
| `outbound_brief` / `outbound_policy` | 1 / 1 | El tarifario del mock como entregables; la política conservadora del esquema, explícita. |
| `campaign` + `campaign_result` | 2 reportadas | Mismos ids y cifras que 0003, enlazadas a su deal ganado. |

## 2. Mapa de cifras: mock → seed → consulta que lo verifica

Todas las consultas están en `verify/0002.sql`, con su letra, y cada
una trae una columna `ok` que el runner evalúa.

| Cifra del mock | Seed | Consulta | Resultado |
|---|---|---|---|
| Seguidores en total **412 K** | último `account_metric_snapshot` por red | (b), (b2) | 214 000 + 128 000 + 49 000 + 21 000; +3,4 % a 30 días; ningún día en baja |
| Views en 30 días **≈ 2,6 M** | views diarias de la cuenta; views actuales de los 27 videos de la ventana | (c) | 3,4 M en cuenta (2,8 M el mes anterior); 3,0 M en videos |
| "La arepa que se hace sin plancha" 412 K · **4,6×** | `v_ref = 412 000` a 96 h, cut 72 contra la mediana de TikTok | (d) | 396 K hoy · **3,7×** · outlier |
| "Tres desayunos" 168 K · 3,1× | Instagram, cut 168 | (d) | 167 K · 2,7× · outlier |
| "El error que arruina tu arroz" 240 K · 2,7× | TikTok, cut 168 | (d) | 239 K · 2,0× · outlier |
| "Pasta cremosa" 96 K · 2,2× | YouTube, cut 72 | (d) | 92 K · 2,4× · outlier |
| "Sopa de la abuela" 58 K · 0,7× · "Respondo sus preguntas" 12 K · 0,5× | cut 168 / 720 | (d) | 0,47× y 0,56× · under |
| Views promedio TikTok **138 K** (tarifario) | mediana de TikTok a 30 días | (e) | 118 000 (p25 98 K, p75 145 K) |
| Deals abiertos **17 · COP 129,3 M · ponderado 49,4 M** | 8 abiertos con ocho marcas | (i) | **8 · COP 80 M · ponderado 36,6 M** (ver §3.1) |
| Seguimientos vencidos | Granos del Valle (−2 d) y Vitalé (−1 d) | (i) | 2 vencidos, 2 para hoy, 1 sin fecha |
| Ganado en Q3 **COP 12,8 M · 3 deals** | Fresko 5,2 · Nutrivé 4,5 · Café Alma 3,1 | (i) | 12 800 000 |
| Señales por revisar | 4 pending | (j) | 4 · 6 · 1 · 1 |
| Café Alma: 712 K views, +1 240 seguidores, 318 canjes | `campaign_result` de `ca0001`, enlazada al deal ganado y a la señal de prensa | (k) | la cadena completa, con la factura de 0003 |
| Media kit: 71 % entre 18 y 34, 64 % mujeres, Colombia 71 % | `audience_breakdown` de Instagram | (h2) | exacto |

Invariantes que también se comprueban: las curvas nunca bajan y a las
72 h llevan el 80 % de lo que hay a 30 días (f); `views_vs_median` es
`views_at_cut / median_views` a tres decimales y el nivel sigue los
umbrales de `scoring.ts` en los 59 puntajes (e2); los posts de campaña
llegan a las views de 30 días que 0003 usa (g); con otro workspace no
se ve ninguna fila (m).

## 3. Los casos ambiguos, decididos

1. **Ocho marcas contra los veinte deals del mock.** El prompt fijó
   ocho empresas, doce señales y quince deals, y el "terminado cuando"
   pide deals abiertos y cierre ponderado *del orden* del mock. Con ocho
   marcas caben ocho deals abiertos (COP 80 M, ponderado 36,6 M), no
   diecisiete; el resto son ganados (los tres del "Ganado en Q3" más el
   de Hogar Lindo de junio, que es la factura en mora de 0003) y tres
   perdidos con motivo, para que `perdido` también tenga filas. Lo que
   cede: el "17 deals abiertos · COP 129,3 M" literal del mock.
2. **Fechas relativas o fijas.** Lo que la demo mira hoy va relativo a
   `CURRENT_DATE`: los videos recientes y sus lecturas, los 90 días de
   la cuenta, la bandeja del radar y las próximas acciones. En dos meses
   Resumen sigue teniendo views en 30 días y Ventas sigue teniendo dos
   seguimientos vencidos. Lo que ya pasó y se cita en un reporte o una
   factura va fijo: los cinco posts de campaña de 0003, los cierres,
   los correos y llamadas. Consecuencia: `post_metric_snapshot` crece un
   poco cada día (una lectura diaria por video con menos de 90 días),
   y el conteo exacto se documenta con su fecha.
3. **Línea base y puntaje calculados, no escritos.** Se insertan con
   `percentile_cont` sobre `post_metrics_at_cut`, igual que lo haría el
   job de CON-6. Así el puntaje es coherente con las lecturas por
   construcción, y cuando el job real corra dará lo mismo. `computed_at`
   es la medianoche UTC del día: idempotente dentro del día, y una
   corrida en otro día no crea una segunda línea base (el id fijo por
   red y corte lo impide).
4. **El reel del cold brew es el breakout, no la arepa.** El mock pone
   la arepa (4,6×) como el mejor video, pero el reel de Café Alma tiene
   412 K views en una cuenta de Instagram cuya mediana a 7 días es 62 K:
   sale 6,1×, `breakout`. Es coherente con la historia que el mock
   cuenta en Campañas (712 K views, "12× su ritmo normal"), así que se
   deja. La arepa queda en 3,7× porque la mediana de TikTok a 72 h
   (107 K) sale de los otros veinte videos, y bajarla haría mentir el
   tarifario ("138 K views promedio").
5. **"Postre sin horno" sale `under`, no 0,8×.** El mock le da 44 K
   views y 0,8×; contra la propia mediana de Instagram del seed (62 K a
   7 días) 44 K es 0,66×. Se respetan las views del mock y se acepta el
   nivel. Igual con "Huevo perfecto": 1,6× en el mock, 0,98× aquí, con
   sus 92 K views a dos días contra una mediana de TikTok a 24 h de 68 K.
6. **Las dos campañas reportadas van en 0002 con los ids de 0003.**
   0003 las reafirma con `DO UPDATE` sobre todo menos `deal_id`, que es
   lo que 0002 añade: la cadena señal → deal → campaña → factura → cobro
   se recorre completa desde Café Alma. Los deals ganados de Fresko
   (`dea09`) y Nutrivé (`dea10`) no quedan enlazados a `ca0002` y
   `ca0003` porque esas campañas las escribe 0003; basta con que 0003
   añada `deal_id` a sus filas (ids en la cabecera de 0002).
7. **La sección 0 de 0003 queda en no-op**, como pedía CIM-8 §1: 0002
   usa exactamente sus ids. Diferencias deliberadas donde 0002 manda por
   correr antes: `app_user` es `demo@multicampaign.test` (el prompt de
   CIM-6), `secret_ref` es `seed://…` y TikTok es cuenta `business`
   (la personal no da demografía por API).
8. **Sin tablas de trabajo.** El rol migrador no tiene `TEMP` en
   Postgres embebido, así que la lista de videos, la curva, el `INSERT`
   del post y el de sus lecturas van en una sola sentencia con CTEs. El
   seed no crea ningún objeto.
9. **Demografía con id fijo.** `audience_breakdown` no tiene clave
   natural; el id fijo (`…-0000ad` + red y bucket) es la clave de
   idempotencia, y la foto queda fechada el día en que el seed corrió
   por primera vez.

## 4. Idempotencia y conteos

`node db/seed/verify/run.mjs` (Postgres embebido, migraciones como
`mc_migrator_test` sin `BYPASSRLS`, los tres seeds dos veces): la
segunda pasada no cambia ningún conteo. Los de 0002 están al final del
propio archivo; `make db.check` y `node db/migrate.mjs --pglite --seed`
pasan, y `packages/db` (que carga los seeds en sus pruebas) sigue en
verde.

## 5. Contrato con quien lea estos datos

- **Resumen (RES-1).** Seguidores: último `account_metric_snapshot`
  por conexión; la serie de 90 días está completa y sin huecos. Views
  en 30 días: `account_metric_snapshot.views` es la lectura diaria de
  la cuenta (no acumulada); las views por video están en
  `post_metrics_latest` y su delta diario en `post_metrics_daily_delta`.
  Demografía: `audience_breakdown` con `scope = 'account'`,
  `population = 'followers'` y el día más reciente.
- **Mis videos.** `creator_post_board` ya trae views, `× mediana`,
  nivel, guardados por mil, no seguidores y salto a 3 s. Los cortes
  canónicos están en `post_metrics_at_cut` y la línea base en
  `creator_baseline` (la fila más reciente por red y corte).
- **Ventas.** `deal_pipeline` da etapa, ponderado y `due_state`; las
  señales por revisar son `signal.status = 'pending'`; la ficha de
  empresa se arma con `company_link`, `contact`, `activity` y
  `deal_stage_history`. Todo está bajo RLS: sin `app.workspace_id`
  fijado por el cliente de base, cero filas.
