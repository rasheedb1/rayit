# CIM-6 · Seed de ventas y métricas — cifras, decisiones y cómo se verifica

Escrito para: quien revise el PR de CIM-6, y para quien construya
Resumen (RES-1), Mis videos y Ventas (VEN-*) sobre estos datos.
Fecha: 22 de septiembre de 2026 (ronda 2: resuelve los trece hallazgos
de la revisión; los cambios de esta ronda están marcados **[r2]**).

Archivo: `platform/db/seed/0002_demo_ventas_metricas.sql`.
Verificación: `platform/db/seed/verify/0002.sql` con el runner genérico
`platform/db/seed/verify/run.mjs` (`make db.seed.check`, y en CI).

---

## 1. Qué deja el seed

Una creadora (Laura Méndez, `@laura.cocinafacil`, COP, `America/Bogota`)
con cuatro redes conectadas y todo lo que Resumen, Mis videos y Ventas
necesitan para parecerse al mock (`dashboard/local/app.js`):

| Bloque | Filas | De dónde salen las cifras |
|---|---|---|
| `social_connection` | 4 (TikTok, Instagram, YouTube, Facebook) | `secret_ref = seed://…`, `status = active`. **[r2]** La frescura (`last_synced_at` hace 2–6 h, `access_expires_at` de YouTube a 50 min y de TikTok a 20 h) se refresca con `DO UPDATE` en cada corrida: son tablas maestras, no métricas, y así `connection_health` cuenta siempre la historia pensada en vez de "token vencido" una hora después de sembrar. |
| `post` | 60 en 120 días (21 · 17 · 12 · 10) | Los doce de la tabla "Mis videos" del mock con sus views, guardados, no seguidores y salto a 3 s; los cinco de las campañas de 0003 (ids `d01..d05`, texto idéntico); 43 más con títulos de cocina fácil. **[r2]** `published_at` de los 55 relativos se congela en la primera corrida. |
| `post_metric_snapshot` | 2 653 el 22-sep (crece una lectura diaria por video con menos de 90 días) | Curva acumulada por video: lecturas a 1, 3, 6, 12, 24, 48 y 72 h y luego diarias hasta 90 días, medidas contra el reloj del seed (medianoche UTC). `age_hours` exacta por construcción. **[r2]** `captured_at` sale del `published_at` guardado, así que sembrar otro día solo añade lo que la curva alcanzó. |
| `account_metric_snapshot` | 360 (4 × 90 días) | Seguidores de los valores de hace 90 días a `FOLLOWERS_NOW` (214 000 · 128 000 · 49 000 · 21 000 = 412 000) con el salto de TikTok de la semana 9 y el empujón de Instagram; views diarias calibradas para que los últimos 30 días sumen ≈ 2,6 M. **[r2]** El día 0 se ancla al primer día guardado: sembrar otro día no añade un día plano. |
| `audience_breakdown` | 60 (4 × 15 buckets) | Edad, género y país. Instagram es la base del media kit (71 % entre 18 y 34, 64 % mujeres, Colombia 71 %); cada red se desvía unos puntos y sigue sumando 1. |
| `creator_baseline` | 16 (4 redes × 4 cortes) | **Calculada** sobre las lecturas con la regla de `scoring.ts`. Todas `is_reliable`. Congelada en la primera corrida (id fijo por red y corte). |
| `post_score` | 59 (todo video con ≥ 24 h por el reloj del seed) | **Calculado** contra la línea base más reciente de su red en el mayor corte alcanzado. **[r2]** Una corrida posterior puntúa al video que cumplió 24 h desde entonces. |
| `company` / `company_link` | 8 / 8 | Las cuatro de 0003 (Café Alma, Fresko Market, Hogar Lindo, Nutrivé) y cuatro del radar (Sabores Caseros, Granos del Valle, Vitalé, Olla Fácil). |
| `contact` | 12, uno con `opted_out` | Procedencia obligatoria; Mateo Giraldo pidió la baja. **[r2]** La consulta (o) de la verificación intenta programar y enviar un toque a Mateo por `email`, `linkedin` e `instagram_dm` y exige que el disparador de `outbound_touch` lo rechace con `check_violation` las seis veces. |
| `signal` | 12 (6 aceptadas con deal, 4 por revisar, 1 duplicada, 1 descartada) | Fuentes del catálogo; `dedupe_key` única. **[r2]** En las filas relativas, titular, `evidence.since` y `dedupe_key` se derivan de la misma `CURRENT_DATE`. |
| `deal` | 15 (**10 abiertos**, 4 ganados, 1 perdido) | Ver §2 y §3.1. |
| `deal_stage_history` / `activity` | 47 / 38 | La línea de tiempo de Fresko Market es la del mock (`COMPANIES`), fecha por fecha. |
| `outbound_brief` / `outbound_policy` | 1 / 1 | El tarifario del mock como entregables; la política conservadora del esquema, explícita. |
| `campaign` + `campaign_result` | 2 reportadas | Mismos ids y cifras que 0003, enlazadas a su deal ganado. **[r2]** Café Alma del 10 al 17 de agosto (ver §3.10). |

## 2. Mapa de cifras: mock → seed → consulta que lo verifica

Todas las consultas están en `verify/0002.sql`, con su letra, y cada
una trae una columna `ok` que el runner evalúa.

| Cifra del mock | Seed | Consulta | Resultado |
|---|---|---|---|
| Seguidores en total **412 K** | último `account_metric_snapshot` por red | (b), (b2) | 214 000 + 128 000 + 49 000 + 21 000; +3,4 % a 30 días; ningún día en baja; 90 días seguidos por conexión |
| Views en 30 días **≈ 2,6 M** | views diarias de la cuenta; views actuales de los 25 videos de la ventana | (c) | **2,60 M** en cuenta (2,17 M el mes anterior); 2,28 M en videos. **[r2]** El rango aceptado es 2,4–2,9 M |
| "La arepa que se hace sin plancha" 412 K · **4,6×** | `v_ref = 412 000` a 96 h, cut 72 contra la mediana de TikTok | (d) | 396 K hoy · **3,7×** · outlier |
| "Tres desayunos" 168 K · 3,1× | Instagram, cut 168 | (d) | 167 K · 2,7× · outlier |
| "El error que arruina tu arroz" 240 K · 2,7× | TikTok, cut 168 | (d) | 239 K · 2,0× · outlier |
| "Pasta cremosa" 96 K · 2,2× | YouTube, cut 72 | (d) | 92 K · 2,4× · outlier |
| "Huevo perfecto" 74 K · 1,6× | **[r2]** `v_ref = 74 000` a 48 h (las views del mock) | (d) | 53,7 K en su lectura de 24 h · 0,79× · normal (§3.5) |
| "Sopa de la abuela" 58 K · 0,7× · "Respondo sus preguntas" 12 K · 0,5× | cut 168 / 720 | (d) | 0,47× y 0,56× · under |
| Views promedio TikTok **138 K** (tarifario) | mediana de TikTok a 30 días | (e) | 121 500 (p25 100 K, p75 156 K) |
| Deals abiertos **17 · COP 129,3 M · ponderado 49,4 M** | 10 abiertos con ocho marcas | (i) | **10 · COP 95,5 M · ponderado 43,15 M** (§3.1) |
| Seguimientos vencidos | Granos del Valle (−2 d) y Vitalé (−1 d) | (i) | 2 vencidos, 2 para hoy, 1 sin fecha |
| Ganado en Q3 **COP 12,8 M · 3 deals** | Fresko 5,2 · Nutrivé 4,5 · Café Alma 3,1 | (i) | 12 800 000 |
| Señales por revisar | 4 pending | (j) | 4 · 6 · 1 · 1 |
| Café Alma: 712 K views, +1 240 seguidores, 318 canjes | `campaign_result` de `ca0001`, enlazada al deal ganado y a la señal de prensa | (k) | la cadena completa, con la factura de 0003 |
| Media kit: 71 % entre 18 y 34, 64 % mujeres, Colombia 71 % | `audience_breakdown` de Instagram | (h2) | exacto |

Invariantes que también se comprueban: las curvas nunca bajan y a las
72 h llevan el 79 % de lo que hay a 30 días (f); `views_vs_median` es
`views_at_cut / median_views` a tres decimales y el nivel sigue los
umbrales de `scoring.ts` en los 59 puntajes (e2); **[r2]** los cinco
posts de campaña siguen la curva por construcción: la lectura de mayor
edad de cada uno vale `round(v_ref · f(edad) / f(720))` y los que ya
cumplieron 30 días tienen la lectura de 720 h exacta, así que la
consulta (g) nunca queda vacía; con otro workspace no se ve ninguna
fila (m); **[r2]** nada está en el futuro: ni resultados de campaña, ni
actividades, ni lecturas (tampoco las manuales de 0003), ni señales,
deals o etapas, y ningún resultado se calculó antes de que sus videos
cumplieran el corte (n); **[r2]** la baja de Mateo Giraldo se respeta
en los tres canales y los dos estados que vigila el disparador (o).

## 3. Los casos ambiguos, decididos

1. **Diez deals abiertos con ocho marcas y quince deals.** **[r2]** La
   ronda 1 dejaba 8 abiertos (80 M, ponderado 36,6 M) y 3 perdidos:
   menos de la mitad de los deals del mock y un tablero de Ventas
   notoriamente más vacío. Ahora dos de los tres perdidos son deals
   abiertos: Vitalé tiene un segundo frente por su línea de snacks
   (`Paquete snacks · Q4`, contactado, 9 M, seguimiento en 3 días; es
   la misma señal pendiente de "4 anuncios nuevos · snacks") y Nutrivé
   una activación corta aparte de la serie de Q4 (`1 TikTok + 1 Short ·
   octubre`, negociación, 6,5 M, confirmar fechas en 3 días). Quedan
   10 abiertos · COP 95,5 M · ponderado 43,15 M (74 % del pipeline y
   87 % del ponderado del mock), con los mismos 2 vencidos y 2 para hoy.
   Lo que NO se hizo, y por qué: (a) convertir el deal ganado de Hogar
   Lindo (`dea12`) en propuesta, como sugería la revisión, porque es el
   deal de la campaña `ca0004` y de la factura en mora FV-2026-007 de
   0003, y un reporte enviado sobre un deal abierto no tiene sentido;
   (b) quitar el último perdido (Granos del Valle, marzo), porque es lo
   que explica la baja de Mateo Giraldo, el "segundo intento" de hoy y
   deja filas en la etapa `perdido`. Con quince deals eso da 10 y no 11
   ó 12; subir a dieciséis contradecía el enunciado.
2. **Fechas relativas o fijas, y qué pasa al volver a sembrar.** **[r2]**
   Lo que ya pasó y se cita en un reporte o una factura (los cinco
   posts de campaña de 0003, los cierres, los correos y llamadas de los
   clientes de 0003 y de Sabores Caseros) va fijo. Lo que la demo mira
   hoy (videos recientes, seguidores, bandeja del radar, próximas
   acciones, los dos seguimientos vencidos) va relativo a
   `CURRENT_DATE`, y toda la fila lo es: en Granos del Valle y Vitalé,
   señal, creación, etapas, actividades, último contacto y próxima
   acción salen de la misma fecha, y en las señales pendientes el "desde
   el 14 sep" del titular, el `evidence.since` y la `dedupe_key` también.
   Lo relativo se congela en la primera corrida: `published_at` y el día
   0 de la serie de la cuenta se toman de lo ya guardado (`COALESCE`
   sobre la fila anterior), y señales, deals y actividades usan `DO
   NOTHING`. Consecuencia: una base sembrada hoy o dentro de dos meses
   tiene la misma demo viva; una base ya sembrada que recibe `make
   db.migrate --seed` otro día no desplaza fechas, no duplica lecturas
   ni añade días planos: solo entran las lecturas que la curva alcanzó
   (58 el primer día) y el puntaje del video que cumplió 24 h. La ronda
   1 decía "correr dos veces deja los mismos conteos" y era cierto solo
   dentro del mismo día; `run.mjs` ahora lo prueba con una tercera
   pasada con el reloj adelantado.
3. **El reloj del seed es la medianoche UTC.** **[r2]** Las lecturas que
   "ya ocurrieron", los cortes que un video "ya alcanzó" y `computed_at`
   de línea base y puntaje se miden contra `date_trunc('day', now())`,
   la hora del job nocturno, y no contra `now()`. Antes, el video de
   ayer a las 19:00 UTC cruzaba las 24 h a las 19:00 de hoy y entraba en
   la línea base de TikTok, cambiando la mediana y los "× mediana" según
   la hora a la que se sembrara: dos máquinas el mismo día no daban lo
   mismo. Ahora sí, y la cabecera dice "mismo día UTC".
4. **Línea base y puntaje calculados, no escritos.** Se insertan con
   `percentile_cont` sobre `post_metrics_at_cut`, igual que lo haría el
   job de CON-6. Así el puntaje es coherente con las lecturas por
   construcción, y cuando el job real corra dará lo mismo. La línea
   base queda congelada en la primera corrida (id fijo por red y corte)
   y el puntaje se calcula contra la más reciente de su red y corte.
5. **"Huevo perfecto" con las views del mock.** **[r2]** La ronda 1 le
   había puesto 92 K (el único de los doce con una cifra que no era la
   del mock); ahora son las 74 K a 48 h del mock. Por el reloj del seed
   el video tiene 29 h y muestra su lectura de 24 h (53,7 K), que contra
   la mediana de TikTok a 24 h (68 K) da 0,79×, `normal`; el mock dice
   1,6×. Igual que con "Postre sin horno" (44 K, 0,66× contra la mediana
   de Instagram de 62 K a 7 días; el mock dice 0,8×): se respetan las
   views del mock y se acepta el nivel que salga de la propia mediana.
6. **El reel del cold brew es el breakout, no la arepa.** El mock pone
   la arepa (4,6×) como el mejor video, pero el reel de Café Alma tiene
   412 K views en una cuenta de Instagram cuya mediana a 30 días es
   69 K: sale 6,0×, `breakout`. Es coherente con la historia que el mock
   cuenta en Campañas (712 K views, "12× su ritmo normal"), así que se
   deja. La arepa queda en 3,7× porque la mediana de TikTok a 72 h
   (107 K) sale de los otros veinte videos, y bajarla haría mentir el
   tarifario ("138 K views promedio").
7. **Las dos campañas reportadas van en 0002 con los ids de 0003.**
   0003 las reafirma con `DO UPDATE` sobre todo menos `deal_id`, que es
   lo que 0002 añade: la cadena señal → deal → campaña → factura → cobro
   se recorre completa desde Café Alma.
8. **La sección 0 de 0003 queda en no-op**, como pedía CIM-8 §1: 0002
   usa exactamente sus ids. Diferencias deliberadas donde 0002 manda por
   correr antes: `app_user` es `demo@multicampaign.test`, `secret_ref`
   es `seed://…` y TikTok es cuenta `business`.
9. **Sin tablas de trabajo.** El rol migrador no tiene `TEMP` en
   Postgres embebido, así que la lista de videos, la curva, el `INSERT`
   del post y el de sus lecturas van en una sola sentencia con CTEs. El
   `published_at` guardado se lee con una subconsulta escalar dentro de
   esa misma sentencia: ve la foto previa (NULL la primera vez, el valor
   guardado después), que es exactamente lo que hace falta.
10. **Una sola línea de tiempo para Café Alma, en 0002 y 0003.** **[r2]**
    La campaña estaba del 24 al 31 de agosto, con el "reporte a 30 días"
    fechado el 15 de septiembre (a 22 días) y `campaign_result.computed_at`
    el 24 de septiembre: en el futuro respecto al día del seed. Se
    adelantó dos semanas: lanzamiento del cold brew el 22 jul, propuesta
    el 23, aceptada el 29; campaña del 10 al 17 ago (reel el 10, TikTok
    el 12; línea base de @cafealma desde el 27 jul); las 720 h del TikTok
    se cumplen el 11 sep; resultado calculado el 12 sep a las 07:30 y
    reporte enviado ese día a las 14:00, con los canjes que la marca
    reportó el 11. Para eso se tocó 0003 (Nicolás) lo mínimo: las fechas
    de los dos posts, la campaña, el día 0 del snapshot de @cafealma
    (4 jul en vez de 18 jul, misma serie), las dos lecturas manuales de
    Café Alma, los aportes de la marca, `computed_at`, el gasto de la
    grabación en la finca (6 ago) y la consulta (e) de `verify/0003.sql`.
    Y se quitaron las dos lecturas manuales "a 30 días" de los TikTok de
    Fresko fechadas el 2 y el 6 de octubre: la campaña sigue midiendo y
    las views actuales las da la curva de 0002 (≈ 137 K + 120 K hoy,
    265 K cuando cumplan 30 días). El "reporte de la campaña de
    septiembre" del 9 sep pasó a ser un avance a 7 días con las cifras
    que la curva da ese día (236 K views y 1 736 clics), y el pitch a
    Fresko del 20 ago cita el avance a 7 días de Café Alma (ya
    existente) y no un reporte de una campaña que no había empezado.
11. **Views en 30 días calibradas al mock.** **[r2]** La base diaria de
    la cuenta estaba en 87 700 views/día (la semanal del mock entre
    siete) y, con la tendencia del trimestre y los dos picos de TikTok
    dentro de la ventana, el KPI daba 3,40 M contra los ≈ 2,6 M del
    mock. Se escaló a 67 200/día (TikTok 39 400, Instagram 18 100,
    YouTube 7 400, Facebook 2 300) y el KPI queda en 2,60 M; la
    consulta (c) acepta 2,4–2,9 M en vez de 2,0–3,5 M.
12. **CI y caché de turbo.** **[r2]** CI corría `run-0003.mjs`, que
    verificaba la idempotencia de todos los seeds pero solo las cifras
    de 0003; ahora corre `node db/seed/verify/run.mjs` (todos los
    `verify/NNNN.sql`, más la tercera pasada). Y las pruebas de `@mc/db`
    cargan `db/migrations` y `db/seed` sin que turbo lo supiera: con un
    seed recién cambiado daba cache hit. `platform/turbo.json` declara
    ahora `@mc/db#test` con `$TURBO_ROOT$/db/migrations/**` y
    `$TURBO_ROOT$/db/seed/**` como inputs, y `@mc/connectors#test` con
    las migraciones (sus pruebas de cuota migran en PGlite). Comprobado
    con `turbo run test --dry=json`: 21 archivos de `db/` entran al hash
    de `@mc/db#test` y el hash cambia al tocar un seed.

## 4. Idempotencia y conteos

`node db/seed/verify/run.mjs` (Postgres embebido, migraciones como
`mc_migrator_test` sin `BYPASSRLS`): los tres seeds dos veces con los
mismos conteos; después las cifras de `verify/0002.sql` y
`verify/0003.sql`; y después **[r2]** una tercera pasada con
`CURRENT_DATE` y `now()` adelantados un día, que exige conteos idénticos
en todas las tablas salvo `post_metric_snapshot` (+58: la lectura diaria
de cada video) y `post_score` (+1: el video que cumplió 24 h), y cero
pares `(post, edad, fuente)` repetidos, cero edades incoherentes y cero
curvas que bajen. Aparte, `verify/0002.sql` se corrió entero después de
sembrar con el reloj a +1, +9 y +40 días (script ad hoc): pasa todo
salvo la frescura de las conexiones (l), que compara contra el `now()`
real de la vista y no se puede desplazar en el simulacro. Los conteos de
0002 están al final del propio archivo; `node db/migrate.mjs --pglite
--seed` pasa, y `packages/db` (que carga los seeds en sus pruebas) sigue
en verde.

## 5. Contrato con quien lea estos datos

- **Resumen (RES-1).** Seguidores: último `account_metric_snapshot`
  por conexión; la serie de 90 días está completa y sin huecos, y su
  último día es el de la primera siembra (el aviso «datos hasta el
  {fecha}» de la pantalla es exactamente para eso). Views en 30 días:
  `account_metric_snapshot.views` es la lectura diaria de la cuenta (no
  acumulada); las views por video están en `post_metrics_latest` y su
  delta diario en `post_metrics_daily_delta`. Demografía:
  `audience_breakdown` con `scope = 'account'`, `population =
  'followers'` y el día más reciente.
- **Mis videos.** `creator_post_board` ya trae views, `× mediana`,
  nivel, guardados por mil, no seguidores y salto a 3 s. Los cortes
  canónicos están en `post_metrics_at_cut` y la línea base en
  `creator_baseline` (la fila más reciente por red y corte).
- **Ventas.** `deal_pipeline` da etapa, ponderado y `due_state`; las
  señales por revisar son `signal.status = 'pending'`; la ficha de
  empresa se arma con `company_link`, `contact`, `activity` y
  `deal_stage_history`. Todo está bajo RLS: sin `app.workspace_id`
  fijado por el cliente de base, cero filas.
