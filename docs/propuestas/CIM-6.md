# CIM-6 · Seed de ventas y métricas — cifras, decisiones y cómo se verifica

Escrito para: quien revise el PR de CIM-6, y para quien construya
Resumen (RES-1), Mis videos y Ventas (VEN-*) sobre estos datos.
Fecha: 22 de septiembre de 2026 (ronda 5: resuelve los doce hallazgos
de la cuarta revisión; los cambios de esta ronda están marcados
**[r5]**, los de las anteriores **[r2]**, **[r3]** y **[r4]**).

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
| `post` | 60 en 120 días (21 · 17 · 12 · 10) | Los doce de la tabla "Mis videos" del mock con sus views, guardados, no seguidores y salto a 3 s; los cinco de las campañas de 0003 (ids `d01..d05`, texto idéntico); 43 más con títulos de cocina fácil. **[r2]** `published_at` de los 55 relativos se congela en la primera corrida. **[r5]** Y la parrilla se mantiene viva: al volver a sembrar entra un video cada dos días desde el último guardado hasta ayer (sección 3b del seed, §3.20). |
| `post_metric_snapshot` | 2 650 el 22-sep sembrando 0001 + 0002 (2 653 con las tres lecturas manuales de 0003; crece una lectura diaria por video con menos de 90 días) | Curva acumulada por video: lecturas a 1, 3, 6, 12, 24, 48 y 72 h y luego diarias hasta 90 días, medidas contra el reloj del seed (medianoche UTC). `age_hours` exacta por construcción. **[r2]** `captured_at` sale del `published_at` guardado, así que sembrar otro día solo añade lo que la curva alcanzó. |
| `account_metric_snapshot` | 360 (4 × 90 días) | Seguidores de los valores de hace 90 días a `FOLLOWERS_NOW` (214 000 · 128 000 · 49 000 · 21 000 = 412 000) con el salto de TikTok de la semana 9 y el empujón de Instagram; views diarias calibradas para que los últimos 30 días sumen ≈ 2,6 M. **[r2]** El día 0 se ancla al primer día guardado. **[r4]** Y la serie se extiende hasta ayer: volver a sembrar N días después añade esos N días (+4·N filas) en vez de dejar la gráfica congelada. **[r3]** El último día es ayer (día 0 = hoy − 90), porque el job nocturno solo tiene cerrado el día anterior; `captured_at` es las 05:00 UTC del día siguiente, siempre en el pasado. |
| `audience_breakdown` | 60 (4 × 15 buckets) | Edad, género y país. Instagram es la base del media kit (71 % entre 18 y 34, 64 % mujeres, Colombia 71 %); cada red se desvía unos puntos y sigue sumando 1. **[r5]** El *share* es estructural y se congela; las **personas** salen del último día de la serie de la cuenta y se refrescan, para que no contradigan al KPI de Resumen (§3.26). |
| `creator_baseline` | 16 (4 redes × 4 cortes) por día de cálculo | **Calculada** sobre las lecturas con la regla de `scoring.ts`. Todas `is_reliable`. **[r4]** El id lleva el día, así que cada siembra deja una línea base nueva y el puntaje de hoy se mide contra la mediana de hoy. |
| `post_score` | 59 (todo video con ≥ 24 h por el reloj del seed) | **Calculado** contra la línea base más reciente de su red en el mayor corte alcanzado. **[r2]** Una corrida posterior puntúa al video que cumplió 24 h desde entonces. **[r5]** Y sube de corte: es el puntaje **vigente** del video, no un registro append-only (§3.21). |
| `company` / `company_link` | 8 / 8 | Las cuatro de 0003 (Café Alma, Fresko Market, Hogar Lindo, Nutrivé) y cuatro del radar (Sabores Caseros, Granos del Valle, Vitalé, Olla Fácil). |
| `contact` | 12, uno con `opted_out` | Procedencia obligatoria; Mateo Giraldo pidió la baja. **[r2]** La consulta (o) de la verificación intenta programar y enviar un toque a Mateo por `email`, `linkedin` e `instagram_dm` y exige que el disparador de `outbound_touch` lo rechace con `check_violation` las seis veces. |
| `signal` | 13 (6 aceptadas con deal, **5 por revisar**, 1 duplicada, 1 descartada) | Fuentes del catálogo; `dedupe_key` única. **[r2]** En las filas relativas, titular, `evidence.since` y `dedupe_key` se derivan de la misma `CURRENT_DATE`. **[r5]** Cinco pendientes, no cuatro: es el número que el Resumen del mock cita con todas las letras (§3.30). |
| `deal` | 15 (**10 abiertos**, 4 ganados, 1 perdido) | Ver §2 y §3.1. |
| `deal_stage_history` / `activity` | 47 / 47 | La línea de tiempo de Fresko Market es la del mock (`COMPANIES`), fecha por fecha. **[r5]** Las 38 históricas se congelan y se añaden **nueve de seguimiento**, una por deal abierto ya contactado, ancladas a `CURRENT_DATE`: sin ellas la línea de tiempo moría seis semanas antes de la próxima acción (§3.25). |
| `outbound_brief` / `outbound_policy` | 1 / 1 | El tarifario del mock como entregables; la política conservadora del esquema, explícita. |
| `campaign` + `campaign_result` | 4 campañas, 2 con resultado | Mismos ids y cifras que 0003. **[r4]** Las **cuatro** llevan su `deal_id`, no solo Café Alma y Hogar Lindo: 0003 no toca esa columna, así que Fresko y Nutrivé se quedaban sin deal para siempre (§3.16). **[r2]** Café Alma del 10 al 17 de agosto (ver §3.10). |

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
| Deals abiertos **17 · COP 129,3 M · ponderado 49,4 M** | 10 abiertos con ocho marcas | (i) `i_pipeline_cifras` | **10 · COP 95,5 M · ponderado 43,15 M** (§3.1) |
| Seguimientos vencidos | Granos del Valle (−2 d) y Vitalé (−1 d) | (i3) `i_pipeline_vencimientos` | 2 vencidos, 2 para hoy, 1 sin fecha. **[r4]** Consulta aparte: es lo único del pipeline que depende del reloj de la vista, y así las cifras de arriba no se toleran con `--dias` (§3.17) |
| Ganado en Q3 **COP 12,8 M · 3 deals** | Fresko 5,2 · Nutrivé **4,7** · Café Alma 3,1 (con IVA) | (i) | 10 924 369,75 netos (13 000 000 con IVA). **[r4]** El mock da 4,5 M al de Nutrivé, pero es la misma venta que la campaña `ca0003` y la factura FV-2026-009 de 0003, que valen 4,7 (§3.18). **[pulido r3]** El negocio va sin IVA (§7) |
| Señales por revisar **5** | 5 pending | (j) | **5** · 6 · 1 · 1. **[r5]** §3.30 |
| Café Alma: 712 K views, +1 240 seguidores, 318 canjes | `campaign_result` de `ca0001`, enlazada al deal ganado y a la señal de prensa | (k), **[r4]** (k2) | la cadena completa, con la factura de 0003; (k2) exige que las cuatro campañas con factura tengan deal ganado y que `deal.amount = campaign.amount = invoice.total` |
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
   db.seed` otro día no desplaza fechas, no duplica lecturas
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
   mismo. Ahora sí, y la cabecera dice "mismo día UTC". **[r4]** Con
   una precisión que la ronda 3 no hacía: lo idéntico entre dos máquinas
   son las curvas, los conteos y todo lo derivado de `generate_series`.
   Nueve columnas de frescura salen de `now()` y llevan la hora exacta
   de la siembra, así que sí difieren: `social_connection.last_synced_at`,
   `.access_expires_at`, `.refresh_expires_at` y `.connected_at`,
   `app_user.last_seen_at`, `signal.detected_at` y `.reviewed_at` (las
   pendientes y la duplicada), `audience_breakdown.captured_at` y
   `company.enriched_at` (Olla Fácil). Un diff entre dos entornos que
   solo toque esas nueve es lo esperado. **[r3]** Y
   el seed lo garantiza en vez de suponerlo: `CURRENT_DATE` y
   `date_trunc('day', now())` dependen del `TimeZone` de la sesión, no
   del sistema, así que un Postgres nativo inicializado en Bogotá a las
   02:00 UTC sembraba "ayer" (2 651 lecturas en vez de 2 655 y la serie
   de la cuenta un día más corta). Ahora el seed y `verify/0002.sql`
   fijan `set_config('TimeZone', 'UTC', false)` en la misma línea en
   que fijan el workspace.
4. **Línea base y puntaje calculados, no escritos.** Se insertan con
   `percentile_cont` sobre `post_metrics_at_cut`, igual que lo haría el
   job de CON-6. Así el puntaje es coherente con las lecturas por
   construcción, y cuando el job real corra dará lo mismo. La línea
   **[r4]** La línea base ya no queda congelada: el id lleva el día del
   cálculo (`…-ba5` + red + corte + día en hexadecimal), la tabla ya
   tenía `UNIQUE (creator, red, corte, computed_at)` y el puntaje toma
   la de `max(computed_at)`. Antes, volver a sembrar seis semanas
   después dejaba `computed_at` de hace seis semanas y comparaba un
   video puntuado hoy contra la mediana de una ventana de veinte videos
   que ya no era la actual. El puntaje ya calculado no se recalcula: es
   append-only y cita la línea base con la que se midió.
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
    **[r4]** Las dos lecturas manuales "a 30 días" de los TikTok de
    Fresko vuelven a 0003, pero condicionadas: `captured_at` es las
    06:00 UTC del día siguiente a las 720 h del video (3 y 7 de octubre)
    y solo se insertan cuando esa fecha ya pasó (`WHERE v.captured_at <=
    now()`). La ronda 3 las había borrado —el razonamiento era bueno,
    una lectura "a 30 días" fechada antes de las 720 h es mentira— pero
    dejaba el comentario de encima diciendo que esas lecturas existían
    "para que Campañas funcione aunque 0002 no esté", y para Fresko ya
    no era cierto; además le restaba dos filas a la historia de Nicolás.
    Así 0003 vuelve a ser autosuficiente en cuanto la fecha llega, y
    mientras tanto las views las da la curva de 0002 (≈ 137 K + 120 K
    hoy, 265 K cuando cumplan 30 días). **Aviso para Nicolás**: son dos
    filas de `post_metric_snapshot` en su archivo. El "reporte de la campaña de
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
13. **Los planes son relativos aunque la historia sea fija.** **[r3]** La
    ronda 2 prometía "dos relojes, nunca en la misma fila" y no lo
    cumplía: Sabores Caseros, Café Alma, Nutrivé, Hogar Lindo y Fresko
    tenían `expected_close_date` fija (30 sep, 10 oct, 20 oct, 15 nov,
    30 sep) y `next_action_due` relativa, así que una base sembrada el
    1 de octubre mostraba "Enviar contrato · mañana" con cierre esperado
    "hace 2 días", y a +60 días eran 5 de 10 abiertos. La regla ahora es
    por columna: lo que ya pasó (señal, creación, etapas, actividades,
    cierres reales) sigue fijo en esos deals; lo que todavía es un plan
    (cierre esperado, próxima acción, el mes o el trimestre del nombre)
    va relativo a `CURRENT_DATE` en todos, con los mismos días que hoy
    respecto al 22 de septiembre (+8, +18, +28, +54, +8). Lo mismo con
    la señal pendiente de Fresko (e008), que envejecía en la bandeja:
    detectada anteayer, anuncia el lanzamiento del mes de `hoy + 30`, y
    titular, `evidence.month` y `dedupe_key` salen de esa fecha; con las
    notas de `company_link` y las actividades de Nutrivé que decían
    "octubre" y "Q4"; y con el brief activo, cuya ventana es el
    trimestre de `hoy + 30` (1 oct – 15 dic sembrado el 22 sep). La
    consulta (p) de `verify/0002.sql` lo prueba: cero deals abiertos con
    cierre en el pasado, cero señales pendientes de más de 14 días, cero
    briefs activos vencidos. **[r4]** La ronda 3 lo dejaba todo
    congelado en la primera corrida con `DO NOTHING`, y eso es
    exactamente lo que hacía caducar la demo: ver §3.15.
14. **La ayuda de `make db.seed` dice lo que hace.** **[r3]** Makefile,
    `platform/README.md` y `docs/base-de-datos.md` decían "carga el
    catálogo base"; desde este PR ese comando siembra en Supabase un
    workspace de demostración completo, y ahora lo dicen, con
    `make db.seed.check` al lado para verificarlo sin tocar Supabase.
    **[r4]** Y el bloque "contra Postgres local" del README vuelve a
    decir `make seed` (que usa `DB_URL`): `db.seed` va a Supabase y
    empieza exigiendo `.env.local`, así que quien seguía "si prefieres
    trabajar sin red" acababa en un error pidiéndole la frase de paso
    del vault.
15. **Volver a sembrar refresca los planes; la demo no caduca.**
    **[r4]** La ronda 3 hizo relativos los planes, pero los congelaba en
    la primera corrida con `DO NOTHING`. El reloj sigue: sembrado un
    día y mirado seis semanas después, 8 de 10 deals abiertos tienen el
    cierre en el pasado, 4 señales `pending` llevan mes y medio en la
    bandeja y la serie de seguidores termina 41 días atrás —justo los
    tres invariantes que (p) existe para impedir— mientras
    `last_synced_at` sí se refrescaba y decía "sincronizado hace 2 h".
    Y era el camino documentado: `make db.seed` contra un Supabase que
    ya tiene la demo. La regla ahora es por **naturaleza de la columna**,
    no por momento: lo que YA PASÓ (etapas, actividades, último
    contacto, cierres reales, el mes del nombre que las actividades
    citan) se congela con `DO NOTHING`; lo que la demo MIRA HOY se
    refresca con `DO UPDATE`: `expected_close_date` y `next_action_due`
    de los deals **abiertos** (`WHERE deal.stage_id NOT IN ('ganado',
    'perdido')`), el titular, la fecha, el `evidence` y la `dedupe_key`
    de las señales **pendientes**, la ventana del brief **activo**, y la
    frescura de las conexiones, que ya lo hacía. Nada de eso es una
    métrica, así que el append-only sigue intacto.
    La serie de la cuenta se arregla aparte, porque no es un `DO
    UPDATE`: el día 0 se sigue anclando al primer día guardado, pero
    ahora se generan los días que falten **hasta ayer** (`greatest(89,
    ayer − día 0)`) y el `ON CONFLICT DO NOTHING` deja fuera los que ya
    están. La clave es que el normalizador de los seguidores es la suma
    de pesos de los días 0..89, constante: los días guardados vuelven a
    dar el mismo número y los nuevos siguen subiendo por encima de
    `FOLLOWERS_NOW` en vez de dejar un escalón. Anclar la serie **por el
    final** (día 89 = ayer), que era la otra propuesta, sí deja ese
    escalón: la parte vieja ya vale 214 000 en TikTok y la nueva
    volvería a empezar en 205 000, rompiendo "la serie nunca baja"; por
    eso se descartó.
    `run.mjs` lo vigila con una **cuarta pasada**: los mismos seeds
    sobre la MISMA base con el reloj 41 días más adelante (81 con
    `--dias 40`), y después exige cero deals abiertos con cierre en el
    pasado, cero señales pendientes de más de 14 días, cero briefs
    vencidos, cero conexiones con más de 24 h sin sincronizar, cero
    bajadas en la serie de seguidores, las cuatro series llegando a ayer
    y views > 0 en los últimos 30 días. Va en las dos corridas de CI.
16. **Las cuatro campañas con su `deal_id`.** **[r4]** 0002 enlazaba
    `ca0001` (Café Alma) y `ca0004` (Hogar Lindo), y 0003 hace `DO
    UPDATE` sobre todo **menos** `deal_id`: `ca0002` (Fresko) y `ca0003`
    (Nutrivé) quedaban con `deal_id` NULL para siempre, aunque sus deals
    ganados existen y se llaman igual (`dea09`, `dea10`). La cadena
    señal → deal → campaña → factura → cobro, que es el argumento
    comercial de la demo, solo se recorría en Café Alma —y la consulta
    (k) medía precisamente ese único caso, por eso no lo veía—. Ahora
    0002 crea las cuatro con su deal (0003 las reafirma sin pisar la
    columna) y (k2) exige que ninguna campaña con factura se quede sin
    deal y que ese deal esté ganado. Los entregables y el resto de las
    cifras de `ca0002` y `ca0003` siguen siendo de 0003, que es su dueño.
17. **Las cifras del pipeline no se toleran con `--dias`.** **[r4]**
    `i_pipeline` afirmaba en el mismo `ok` las cifras del mock y los
    estados de vencimiento, y estaba entera en `TOLERADAS_CON_DIAS`: en
    la corrida de CI `--dias 40` —la que se anuncia como "la demo es la
    misma sembrada dentro de 40 días"— una regresión en el ponderado o
    en el total del pipeline salía como "tolerada" y CI quedaba verde.
    Se partió en `i_pipeline_cifras` (conteos, montos, ponderado,
    ganados, Q3, perdidos) e `i_pipeline_vencimientos` (solo
    `due_state`), y `l_conexiones` en `l_conexiones_cuentas` (estado y
    `posts_tracked`) y `l_conexiones_frescura` (`hours_since_sync`,
    `token_expiring_soon`). Solo las dos segundas se toleran. De paso,
    `i2_tablero` era la única consulta del archivo con `true AS ok` —no
    podía fallar nunca y se leía como cobertura—: ahora exige que
    `stage_position` sea la posición de `pipeline_stage`, que
    `weighted_amount = amount × probability` en las quince filas y que
    todo deal abierto tenga próxima acción.
18. **Un solo precio para el video de Nutrivé: 4,7 M.** **[r4]** El deal
    `dea10` valía 4 500 000 (la cifra del mock) mientras la campaña
    `ca0003` y la factura FV-2026-009 de 0003 valían 4 700 000 por el
    mismo trabajo, y la actividad nº 15 de 0002 dice "FV-2026-009
    pagada" sobre ese deal. En la aplicación se veía: `/finanzas` con
    4,7 M y el tablero de Ventas con 4,5 M. Se alinea subiendo el deal
    (y la cotización que lo acompaña) a 4,7 M, no bajando la factura,
    porque tocar la factura obliga a recalcular subtotal, IVA,
    retención, el cobro y `c_cobrado` en `verify/0003.sql`, todo en
    carpeta de Nicolás. "Ganado en Q3" pasa de 12,8 a 13,0 M, que sigue
    siendo del orden del mock. Y (k2) impide que vuelva a pasar en
    cualquier cadena enlazada.
19. **Cosas pequeñas.** **[r4]** El parseo de `run.mjs` confundía el
    valor de `--dias` con un selector de archivo: `--dias 1000` imprimía
    "No existe verify/1000.sql" y no verificaba nada. Se excluye la
    posición del valor antes de filtrar y se rechaza cualquier argumento
    no reconocido en vez de ignorarlo. Los nombres de los meses en
    español estaban copiados siete veces en dos variantes; ahora se
    declaran una vez por sentencia en un CTE `meses` y se referencian
    con subconsultas escalares. `turbo.json` no invalidaba
    `@mc/worker#test` al cambiar una migración, aunque
    `apps/worker/src/runner/db-pglite.ts` migra PGlite en sus pruebas:
    tiene el mismo bloque de `inputs` que `@mc/db` y `@mc/connectors`.
    Y `createEmbeddedDb` fija `TimeZone = UTC` explícitamente, para que
    la base embebida del modo demo no dependa de que un archivo de datos
    se lo deje puesto de lado.

20. **Los videos tampoco caducan: la parrilla se rellena sola.**
    **[r5]** La ronda 4 arregló ventas, conexiones y la serie de la
    cuenta, y dejó el contenido congelado: `published_at` de los 60
    videos se toma de la fila guardada, así que al volver a sembrar la
    MISMA base 41 días después quedaban **cero** videos en los últimos
    30 días, `creator_post_board` sin una sola fila reciente y el más
    nuevo con 42 días —al lado de un radar de esta semana, unos deals
    con el cierre al día y un "sincronizado hace 3 h"—. El contraste es
    peor que tenerlo todo viejo, y contradecía la regla que este mismo
    documento enuncia: lo que la demo mira hoy va relativo a
    `CURRENT_DATE`.
    Se aplica a los videos la misma regla de **naturaleza de columna**
    que a la serie de la cuenta (§3.15): lo publicado se congela y se
    **añade** lo que falta. La sección 3b del seed genera un video cada
    dos días desde el **ancla** —el último video de la lista, que ya
    está congelado y por eso no se mueve nunca— hasta ayer, con
    `seq = 60 + n` contado desde el ancla (no desde el último generado,
    que reutilizaría ids) y el id `…-00000000 || hex(0x0d00 + seq)`:
    `0d3d`, `0d3e`, … justo detrás de los sesenta. Sembrando en limpio
    no entra ninguno —el video más nuevo de la lista es de ayer—, así
    que los conteos de una base recién sembrada siguen siendo 60. El
    texto sale de una rotación de 24 recetas nuevas y las views de una
    función cerrada de `seq`: sin `random()`, dos corridas dan lo
    mismo. Sus lecturas, su línea base y su puntaje los calculan las
    secciones 4 y 7 sin enterarse de que son distintos.
    Medido en PGlite: resembrando a +41 días quedan 15 videos en los
    últimos 30 días, 15 filas en `creator_post_board` y 2 días desde el
    último.
21. **`post_score` es el puntaje vigente, no un registro.** **[r5]** La
    tabla tiene `PRIMARY KEY (post_id)` y el job `compute.post_score` la
    recalcula cada noche: es el puntaje **de ahora**. Con
    `ON CONFLICT (post_id) DO NOTHING` se congelaba en el corte que el
    video tenía la primera vez, y al resembrar a +41 días **25 de 60**
    filas citaban un corte ya superado: "La arepa que se hace sin
    plancha" con 1 075 h de edad seguía puntuada a 72 h. Y
    `creator_post_board` junta `m.views` de `post_metrics_latest` (las
    de hoy) con `sc.views_vs_median` (de hace seis semanas, contra la
    mediana de 72 h): la pantalla enseñaba un número de views al lado de
    un `× mediana` medido a otra edad, que es exactamente el error que
    `scoring.ts` existe para evitar. Ahora es `DO UPDATE` con
    `WHERE post_score.age_hours_cut < EXCLUDED.age_hours_cut`: el corte
    solo **sube**, nunca baja, así que sigue siendo monótono y dos
    corridas del mismo día dan la misma fila.
22. **La cuarta pasada mira también el contenido.** **[r5]** La prueba
    que la ronda 4 añadió para demostrar que "la demo no caduca" estaba
    calibrada para pasar: medía `views_30d` como
    `sum(views) FROM account_metric_snapshot WHERE day > CURRENT_DATE - 31`,
    es decir la tabla que la propia sección 5 acaba de extender hasta
    ayer. Por construcción no podía dar 0, y no miraba ni un video ni un
    puntaje: por eso §3.20 y §3.21 pasaban en verde en `run.mjs`, en
    `run.mjs --dias 40` y en CI. Se añaden a
    `INVARIANTES_TRAS_RESEMBRAR` cuatro columnas que sí fallan:
    `posts_30d >= 12` (los doce de "Mis videos"), `tablero_30d >= 12`
    sobre `creator_post_board`, `dias_sin_publicar <= 7` y
    `puntajes_obsoletos = 0`. Con ellas, la cuarta pasada falla antes de
    los arreglos y pasa después; un "terminado cuando" demostrado por
    una prueba que no puede fallar no está demostrado.
23. **La verificación corre con el comando estándar.** **[r5]**
    `pnpm turbo run typecheck lint test` —el comando de la rúbrica— no
    ejecutaba `db/seed/verify/run.mjs`: `@mc/db#test` solo corre sus
    pruebas de finanzas y de la CA, que cargan los seeds pero no
    comprueban ni la idempotencia, ni los 60 videos, ni las cifras del
    pipeline. La única red estaba en CI, que no corre en la máquina de
    quien construye ni de quien revisa. Ahora el paquete raíz tiene
    `test` (`seed:check:unit && seed:check`) y `turbo.json` declara la
    tarea raíz `//#test` con sus `inputs` (`db/migrations/**`,
    `db/seed/**`): `pnpm turbo run test` falla si el seed deja de ser
    idempotente o si las cifras se mueven, y la caché se invalida al
    tocar cualquiera de los dos directorios.
24. **El reloj del harness deja de reescribir datos.** **[r5]** El
    desplazamiento se hacía con dos `replace` globales sobre el texto
    (`\bCURRENT_DATE\b` y `\bnow\(\)`), sin distinguir código de
    literales. Funcionaba porque ningún seed tenía esas cadenas entre
    comillas, pero el día que un `notes`, un `headline_es` o un `jsonb`
    llevara el texto «now()», el harness cambiaría el **dato** en vez
    del reloj y la comprobación pasaría midiendo algo distinto de lo que
    se despliega: una trampa silenciosa justo en la herramienta que
    sostiene toda la evidencia. El desplazamiento vive ahora en
    `db/seed/verify/reloj.mjs`, que parte el SQL en código, literales,
    comentarios, identificadores y bloques `$$…$$` (cuerpo de PL/pgSQL:
    se recorre por dentro): solo el código se desplaza, los comentarios
    que *nombran* `CURRENT_DATE` se dejan en paz y un literal con el
    reloj dentro **hace fallar la corrida** diciendo cuál. No toca la
    base y se prueba solo (`db/seed/verify/reloj.test.mjs`, 8 pruebas).
25. **El último contacto de un deal abierto es lo que la demo mira
    hoy.** **[r5]** El refresco de la ronda 4 tocaba
    `expected_close_date` y `next_action_due` y dejaba `last_contact_at`
    y las actividades congeladas, así que tras resembrar a +41 días un
    deal en "Negociación" decía «Enviar contrato · vence hoy» con el
    último contacto y la última actividad de hace seis semanas: para un
    tablero de ventas eso no es una historia creíble, es un deal
    abandonado. `last_contact_at` entra en el `DO UPDATE` de los
    abiertos y la sección **11b** siembra nueve actividades de
    seguimiento —una por deal abierto **ya contactado**; Olla Fácil
    sigue en "nuevo" y no ha recibido el pitch, así que se queda sin
    contacto— con id fijo, texto propio y `ON CONFLICT (id) DO UPDATE`
    sobre `occurred_at`, `subject` y `body`, ancladas a `CURRENT_DATE`.
    `occurred_at` es exactamente el `last_contact_at` de su deal, y la
    consulta (q) de `verify/0002.sql` exige esa igualdad en los nueve,
    más que ninguno lleve más de diez días sin contacto: la tarjeta del
    tablero y la ficha de empresa no pueden contar cosas distintas.
26. **La demografía cuenta las personas de hoy.** **[r5]**
    `audience_breakdown` llevaba id fijo y `DO NOTHING` con
    `absolute` calculado sobre el literal de `FOLLOWERS_NOW`: tras
    resembrar a +41 días la serie daba TikTok 220 540 y total 427 227
    mientras la demografía seguía diciendo 214 000 y 412 000, con `day`
    de hace seis semanas. Un media kit o una pantalla de audiencia que
    sumara `absolute` enseñaba 412 000 al lado del KPI de Resumen que
    decía 427 227, en la misma sesión; y el encabezado del seed listaba
    `audience_breakdown.captured_at` entre las columnas de frescura que
    nunca se refrescaban. Ahora el `share` (estructural) se conserva y
    `captured_at`, `day` y `absolute` van en el `DO UPDATE`, con
    `absolute` derivado del último `account_metric_snapshot` de esa
    conexión mediante un `LATERAL`. La consulta (h3) exige que sumar
    `absolute` por dimensión dé los seguidores de esa red (exacto en
    género; ±1 en edad y país, donde el redondeo se reparte entre seis y
    siete cubos). La bio de `creator_profile` deja de citar "412 mil" y
    dice "más de 400 mil": la escribe la creadora, no el producto.
27. **Los umbrales de `scoring.ts`, atados al SQL.** **[r5]** El seed
    repetía a mano `>= 8` (`MIN_SAMPLE_FOR_BASELINE`) cinco veces y la
    escalera 5 / 2 / 1,2 / 0,7 de `outlierTier()`, sin nada que las
    uniera: subir el mínimo de muestra a 10 o mover el umbral de "good"
    dejaba el seed puntuando con la regla vieja, con todo el verify en
    verde (`e2_puntaje_coherente` compara el seed contra sí mismo) y la
    demo enseñando etiquetas que el producto ya no produce.
    `packages/core/test/seed-umbrales.test.ts` lee el SQL como texto y
    exige que los números de la sección 7 —y los del `CASE` de
    `verify/0002.sql`— sean los que exporta `scoring.ts`, recorriendo
    los cuatro cortes de `outlierTier()` y los de `AGE_CUTS_HOURS`. Es
    fea, y es la única atadura posible entre TypeScript y SQL: falla el
    día del cambio, no seis semanas después.
28. **Qué es un deal cerrado lo dice `pipeline_stage`.** **[r5]** El
    refresco decidía con literales (`WHERE deal.stage_id NOT IN
    ('ganado', 'perdido')`) mientras la vista `deal_pipeline` y el
    propio verify usan `is_won`/`is_lost`. Añadir una etapa terminal
    (`archivado`) o renombrar una hacía que el seed reescribiera en
    silencio `expected_close_date` y `next_action_due` de deals ya
    cerrados: reescribir historia, justo lo que la sección promete no
    hacer. Ahora pregunta
    `WHERE deal.stage_id IN (SELECT id FROM pipeline_stage WHERE NOT is_won AND NOT is_lost)`.
29. **Cada seed, en su transacción.** **[r5]** `node db/migrate.mjs
    <url> --seed` —el mecanismo documentado para aplicar el seed contra
    Supabase— corría cada archivo con un `db.query(sql)` suelto: sin
    `BEGIN`/`COMMIT`, sin `ROLLBACK` y sin decir nada al fallar,
    mientras el bucle de migraciones de justo arriba hace las tres
    cosas. Con un seed de 1 400 líneas, un fallo a mitad (un timeout del
    pooler, un `CHECK` nuevo) dejaba el workspace de demostración a
    medias, en un estado que ninguna verificación cubre, y la corrida
    siguiente partía de ahí. El mecanismo es anterior a esta historia,
    pero esta historia es la primera que lo carga con volumen real: seis
    líneas y el contrato del seed no cambia.
30. **Cinco señales por revisar, como el mock.** **[r5]** El seed dejaba
    cuatro `pending` mientras el mock enseña cinco y su Resumen lo dice
    con todas las letras («Hay 5 señales por revisar en el radar y 3
    seguimientos vencidos en el pipeline»). Los **dos** vencidos vienen
    de la especificación de la historia y se quedan en dos —el texto del
    mock es prosa del mock, no un dato—, pero el 4 contra 5 de las
    señales no lo pedía nadie: era una desviación gratuita que habría
    hecho que RES-1, al copiar ese aviso, enseñara un número distinto
    del radar el primer día. Entra una señal pendiente más (Sabores
    Caseros, biblioteca de anuncios de Meta, detectada hace seis horas),
    así que `signal` pasa de 12 a 13 filas; la historia pedía "doce
    señales en estados mixtos" y las doce siguen ahí, con una decimotercera
    encima. Conteos actualizados en el seed y en (a) y (j).

## 4. Idempotencia y conteos

`node db/seed/verify/run.mjs` (Postgres embebido, migraciones como
`mc_migrator_test` sin `BYPASSRLS`): los tres seeds dos veces con los
mismos conteos; después las cifras de `verify/0002.sql` y
`verify/0003.sql`; y después **[r2]** una tercera pasada con
`CURRENT_DATE` y `now()` adelantados un día, que exige conteos idénticos
en todas las tablas salvo `post_metric_snapshot` (+58: la lectura diaria
de cada video) y `post_score` (+1: el video que cumplió 24 h), y cero
pares `(post, edad, fuente)` repetidos, cero edades incoherentes y cero
curvas que bajen.

**[r3]** La afirmación de la ronda 2 de que sembrar con el reloj a +1,
+9 y +40 días "pasa todo salvo (l)" era doblemente inexacta: venía de un
script que no estaba en el repositorio, y también falla (i) `i_pipeline`,
por la misma causa que (l): `deal_pipeline.due_state` se calcula con el
`now()` y `CURRENT_DATE` internos de la vista, igual que
`connection_health`, y el desplazamiento textual de los seeds no los
alcanza. Ahora está en CI: `node db/seed/verify/run.mjs --dias 40`
siembra una base limpia con `CURRENT_DATE` y `now()` a +40 días en los
seeds **y** en los verify (la tercera pasada va a +41), exige lo mismo
que la corrida normal y tolera solo `i_pipeline_vencimientos` y
`l_conexiones_frescura`, diciendo por qué. **[r4]** Y hay una cuarta
pasada, en las dos corridas, que vuelve a sembrar la MISMA base con el
reloj 41 días más adelante (81 con `--dias 40`) y exige que la demo siga
viva (§3.15); los conteos que ahí crecen a propósito son
`account_metric_snapshot` (+4 por día) y `creator_baseline` (+16 por día
de cálculo), y están declarados en `CRECEN_CON_EL_RELOJ`. Comprobado con `--dias 1`, `9`, `40` y `60`: pasan
todas las demás, incluida la (p) nueva. Los conteos de 0002 están al
final del propio archivo (2 650 lecturas por video sembrando 0001 +
0002; `run.mjs` muestra 2 653 porque 0003 añade tres manuales);
`node db/migrate.mjs --pglite --seed` pasa, y `packages/db` (que carga
los seeds en sus pruebas) sigue en verde.

**[r5]** Tres cosas más. Hay una **quinta pasada**: los mismos seeds
otra vez sobre la base ya envejecida y sin mover el reloj, con conteos
idénticos exigidos en todas las tablas. La idempotencia de las dos
primeras pasadas se mide sobre una base recién sembrada, donde casi
nada de lo que se añade con el tiempo existe todavía; en la quinta ya
están los videos de 3b, los días de más de la serie y los puntajes
subidos de corte, así que es la que demuestra que volver a correr
`make db.seed` sobre la demo de producción no duplica nada. La cuarta pasada ya no mira solo ventas: exige
además doce videos en los últimos 30 días, doce filas recientes en
`creator_post_board`, menos de una semana desde el último video y cero
puntajes obsoletos (§3.22), así que `post` entra en
`CRECEN_CON_EL_RELOJ` (+1 cada dos días desde la última siembra). Y
todo esto corre con el comando estándar: `pnpm turbo run test` ejecuta
la tarea raíz `//#test`, que son las ocho pruebas del reloj del harness
(`db/seed/verify/reloj.test.mjs`, sin base de datos) seguidas de
`run.mjs` completo —dos pasadas, las cifras, la de mañana y la de seis
semanas después— en unos tres segundos (§3.23). Conteos de 0002 que
cambian en esta ronda: `signal` 12 → 13 y `activity` 38 → 47.

## 5. Contrato con quien lea estos datos

- **Resumen (RES-1).** Seguidores: último `account_metric_snapshot`
  por conexión; la serie de 90 días está completa y sin huecos, y su
  último día es el anterior a la primera siembra: el job nocturno solo
  tiene cerrado ayer, y el aviso «datos hasta el {fecha}» de la
  pantalla es exactamente para eso. Views en 30 días:
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

## 6. Integración en `rasheed/integracion` (22 de septiembre)

Lo que antes vivía en la nota de CIM-6 del backlog, que debe ser corta.

- **Qué hace el seed, en una línea por pieza.** 60 videos con curvas
  ancladas a la primera corrida y una parrilla que se rellena sola (un
  video cada dos días desde el último guardado hasta ayer); la serie de
  la cuenta extendida hasta ayer; demografía cuyas personas salen de la
  última lectura de seguidores; línea base por día de cálculo y puntaje
  que sube al corte alcanzado con la regla de `scoring.ts`; y el CRM con
  8 marcas, 13 señales (5 por revisar, como el mock) y 15 deals (10
  abiertos · COP 95,5 M · ponderado 43,15 M). Volver a sembrar refresca
  lo que la demo mira hoy —cierre esperado, próxima acción y último
  contacto de los deals abiertos con su actividad de seguimiento,
  señales pendientes, ventana del brief, frescura de las conexiones,
  foto de la audiencia— y congela lo que ya pasó. Las cuatro campañas
  llevan su deal, así que la cadena señal → deal → campaña → factura se
  recorre entera.
- **Verificación.** Postgres embebido, colgada del comando estándar
  (`pnpm turbo run test` → tarea raíz `//#test`): cifras, la baja en
  `outbound_touch`, tercera pasada con el reloj a +1 y cuarta que
  resiembra la misma base a +41 exigiendo videos recientes, tablero vivo
  y cero puntajes obsoletos; más la siembra en limpio a +40 días
  (`node db/seed/verify/run.mjs [--dias 40]`, también en CI). El reloj
  del harness vive en `reloj.mjs` y no puede reescribir un dato que se
  parezca a `now()` (§4).
- **0003 (de Nicolás), tocado lo mínimo.** Línea de tiempo de Café
  Alma y las dos lecturas de Fresko condicionadas a su fecha (§3.10).
- **Supabase.** 0001, 0002 y 0003 sembrados con `make db.seed`. El
  conflicto conocido de 0003 quedó con la clave `platform_id` de `main`
  y las fechas de esta rama, y las cuatro campañas de 0002 pasaron
  también a `platform_id`. Se borraron a mano cinco lecturas manuales
  que había dejado la versión anterior de 0003 —cuatro con
  `captured_at` en el futuro, justo lo que esta historia vino a quitar—:
  un seed solo inserta, así que no podían desaparecer solas.
- **Pruebas de Nicolás.** `campanas.test.ts` y `conexiones.test.ts`,
  que estaban clavadas al seed sin 0002, pasan a afirmar la banda
  alrededor de la cifra del mock en vez del valor de hoy: la curva
  sigue midiendo hasta los 90 días y el número exacto sube cada día.

## 7. Convención de montos y Cotizar sembrado (pulido r3, 23 de septiembre)

- **Una sola convención, la de 0031 y CAM-2.** `deal.amount` es el
  **neto** (lo que la marca presupuesta, sin IVA); `campaign.amount` e
  `invoice.total` son el **total con impuesto**. El seed usaba la
  contraria en los cuatro ganados con campaña (negocio = campaña =
  total), y aceptar una cotización en la app daba el neto en el
  pipeline y el total en la campaña: el mismo acuerdo valía 5,2 M en un
  módulo y 6,18 M en otro. Ahora los cuatro ganados valen el
  **subtotal** de su factura de 0003 (Fresko 4 369 747,90 · Nutrivé
  3 949 579,83 · Café Alma 2 605 042,02 · Hogar Lindo 924 369,75), y
  una base sembrada antes se corrige sola en la siguiente corrida si
  conserva la cifra vieja. `verify/0002.sql` (k2) exige
  `deal.amount = invoice.subtotal` y `campaign.amount = invoice.total`;
  «Ganado en Q3» pasa a 10 924 369,75 (13 M con IVA).
- **Seed 0004 · Cotizar.** Un tarifario guardado (v1, con los rangos
  que da `guardarTarifario` sobre la línea base del seed), un media kit
  público congelado el 22-sep y ocho cotizaciones COT-2026-001…008:
  las cuatro aceptadas de los ganados con campaña (enlazadas por
  `campaign.quote_id`) y una enviada o vista por cada negocio en
  propuesta o negociación, con el neto que ese negocio ya tiene. Los
  slugs se sortean en la primera corrida (el repositorio es público).
  Se verifica con `verify/0004.sql`.
