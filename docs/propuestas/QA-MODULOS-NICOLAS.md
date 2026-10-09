# QA de los módulos de Nicolás · 4 y 5 de octubre de 2026

Escrito para: Nicolás (dueño de Conexiones, Campañas, Finanzas, el marco y
su parte de Accesos) y Rasheed, para cerrar el sprint.

Qué se hizo: una revisión de lectura completa de los cinco módulos (cuatro
revisores, uno por módulo), la verificación de `main` (`pnpm verificar`),
la foto real de producción y de Supabase (conexiones de Instagram y
TikTok, worker por turnos), y los arreglos de lo que impedía llegar a
9,5. Rama: `nicolas/QA-modulos-sprint` (worktree `rayit-qa`), sobre
`origin/main` 50145b34.

## 1. Estado de `main` antes y después

| | Antes (50145b34, 4-oct) | Después (esta rama) |
|---|---|---|
| core | 527 / 527 | igual |
| connectors | 304 / 304 | igual |
| db | 1447 / 1452 (**3 rojas**) | ver §6 |
| web | 2028 / 2032 (**3 rojas**, 1 todo) | ver §6 |
| worker | 420 / 423 (**3 rojas**) | ver §6 |
| typecheck + lint | verde | verde |

Las nueve rojas no eran regresiones de código: eran **deriva de
calendario**. El seed 0002 es relativo a hoy y los cinco posts de
campaña de 0003 tienen fecha fija; el 2 de octubre el TikTok de Fresko
cumplió 30 días y entró en la ventana de la mediana del creador, así que
`4,496` pasó a `4,466` en cuatro pruebas (db, worker y la de ciclo de la
web), el post de Nutrivé (15-jul) salió de los 50 asociables, y la
prueba del CSV de AdSense hacía tres `replace` encadenados que en
octubre se pisaban (la fila de junio acababa en septiembre). Se
arreglaron así:

- **Worker** (`campaign-compute`, `costuras-con`): `applyRepoSeeds(db,
  { reloj })` siembra con el reloj fijo (el mismo `desplazarReloj` de
  `make db.seed.check`) y `now` del arnés en ese día: las cifras
  literales vuelven a ser deterministas.
- **db** (`campanas.test.ts`): el múltiplo se deriva de `creator_baseline`
  (`vsMedianaDelSeed`, la fórmula de core) y los asociables se contrastan
  con los 50 más recientes de `creator_post_board`.
- **web** (`ciclo-db`): la mediana sale de la tabla; `ingresos/integracion`:
  un solo `replace` con mapa.

## 2. Conexiones: Instagram y TikTok, tal como están en producción

Producción sirve `90f76503` (= `main` menos dos commits de docs/vault) y
Supabase tiene las 77 migraciones. Comprobado el 5-oct 03:30 UTC:

| Cuenta | Cómo | Estado real | Qué significa |
|---|---|---|---|
| @nicolasduartea · Instagram | Instagram Login (CON-3) | `active`, tipo creator, 2 scopes, token vence 4-dic, consentimientos analytics + audience_demographics, snapshot del día (2.225 seguidores, 184 publicaciones), `instagram.me` y los dos canjes de token en 200 | **Funciona.** La pantalla la muestra «Autorizada · Activa · datos hasta el 5 oct» con Actualizar y Quitar. |
| @selvathegolden · TikTok | Login Kit (CON-3) | `needs_reauth` desde el 28-sep («access_token_invalid»), token de acceso vencido el 25-sep, **refresh vigente hasta sep-2027** | La pantalla ofrece «Reautorizar» con la explicación correcta. **Causa raíz: fallo nuestro**, no de TikTok (ver §3, A2). |
| @pataspeludascc · TikTok | Por @ (CON-10) | `active`, «Sin cifras por @» | Como está diseñado: TikTok no publica cifras sin ENSEMBLEDATA_TOKEN (CON-12). |
| Laura (4 cuentas del seed) | seed | `active` con 10–26 fallos seguidos | Tokens de mentira del seed: ruido esperado en el workspace demo. |

Worker por turnos (CIM-7): `pg_cron` y `pg_net` están instalados y hubo
un turno a las 00:14 UTC del 5-oct (`brand.snapshot` dejó fila). Las
lecturas diarias (`collect.*`, 05:00–05:45 UTC) todavía no habían corrido
desde que se instaló el cron; la primera prueba real es ver, el 5-oct
por la mañana, una fila nueva en `account_metric_snapshot` para
@nicolasduartea. `make cron.status` no se puede correr desde esta Mac
(falta el PAT de Supabase en el Llavero). `job_run` no es legible como
`mc_app` (RLS por workspace y las corridas van sin workspace): si quieres
verlo desde `make db.sql`, hace falta una política de lectura o mirar
`api_call_log`/snapshots, que es lo que hice.

**Lo que Nicolás tiene que hacer para que TikTok quede bien:** pulsar
«Reautorizar» en @selvathegolden (entrar como selva). Con el arreglo de
§3 no volverá a caer en `needs_reauth` por un token vencido.

## 3. Hallazgos y arreglos

Calificación de los revisores antes de los arreglos: Conexiones 7,5 ·
Campañas 7,5 · Finanzas 7,5 · CIM-4 8,0 · CIM-5 8,5 · ACC 7,0. Lo que se
arregló en esta rama (todo con prueba):

### Conexiones

- **A2 (alto, confirmado, es lo que le pasó a selva).** Los recolectores
  llamaban con el token tal cual estaba en el almacén y un 401 por token
  simplemente vencido se convertía en `needs_reauth`, aunque el refresh
  token valiera un año. Ahora `_token.ts` renueva en línea antes de leer
  (`renovarConexion`, la misma lógica de `oauth.refresh`, una renovación en
  vuelo por conexión porque TikTok rota el refresh token) en
  `collect.account_metrics`, `collect.posts`, `collect.post_metrics` y
  `collect.demographics`. Solo si la plataforma rechaza la **renovación**
  se pide reautorizar. Prueba: `apps/worker/test/token-vencido.test.ts`.
- **A1 (alto).** `oauth.refresh` solo miraba filas `active`: una cuenta en
  `error` por un fallo de lectura nunca renovaba y acababa en
  `needs_reauth`. Ahora entra `error` y conserva su estado y su detalle.
- **M1 (medio).** `collect.post_metrics` excluía las cuentas `aggregator`
  (CON-12): con ENSEMBLEDATA_TOKEN se descubrían videos que nunca se
  medían. Un `IN` corregido.
- **M2 (medio).** «Actualizar» en la web dejaba una autorizada rechazada en
  `error` (botón en bucle) en vez de `needs_reauth` (botón «Reautorizar»),
  como hace el worker. `markAccountLookupFailure` acepta `'needs_reauth'`.

### Campañas

- **A2 (alto).** `getResultInputs` leía TODA la historia de seguidores de
  la marca y el ancla del «ritmo previo» podía ser una lectura de hace
  meses (segunda campaña de la misma marca): el «×N» del resultado no
  coincidía con el de la ficha. Mismo corte que la ficha
  (`brand_baseline_from − 1`).
- **A3 (alto).** Editar el inicio no movía `brand_baseline_from`; adelantar
  el inicio invertía la ventana y la ficha decía «línea base corta».
  Ahora sigue al inicio (catorce días antes) si ya estaba fijada, con
  antes/después en la bitácora. Prueba en `packages/db/test/campanas.test.ts`.
- **B1.** Enlaces que faltaban: ficha → cotización, factura → campaña.

### Finanzas

- **M1 (medio).** Una campaña se podía facturar dos veces (doble clic en
  «Facturar»): dos borradores y «Por cobrar» duplicado. Una factura viva
  por campaña; anulada, se puede volver a facturar. Prueba en
  `packages/db/test/finanzas.test.ts`.

## 4. Lo que queda abierto (ordenado por lo que más pesa)

No son bloqueantes del sprint, pero son lo que separa 9 de 9,5. Todos
están confirmados en código por los revisores, con archivo y línea en los
informes; aquí el resumen:

1. **Producción sin Supabase Auth (crítico de despliegue, no de código).**
   Mientras no haya `NEXT_PUBLIC_SUPABASE_URL/ANON_KEY` en Vercel, cualquier
   visitante es Dueño del workspace demo: puede quitar @nicolasduartea,
   conectar su cuenta, facturar, enviar reportes. La bitácora queda como
   `system`. Decisión de Nicolás y Rasheed: poner las llaves (el código
   falla cerrado en cuanto existen) o Deployment Protection de Vercel.
2. **Finanzas A1.** «Hoy» de la vista `receivables`, la lista y el KPI del
   año es el de UTC; desde las 19:00 de Bogotá una factura que vence hoy
   sale «vencida hace 1 día». Pide migración (la vista) y usar la zona del
   workspace como ya hacen FIN-4 y el flujo.
3. **Finanzas A2 (producto).** La marca paga el neto con retención y la
   factura nunca pasa a `paid`: falta «registrar retención» o aceptar
   `pagado + retención = total`. Decisión 6 de CIERRE-FIN la dejó en bruto;
   conviene revisarla con Rasheed.
4. **Campañas A1.** Un post sin lecturas anula todo el resultado (el corte
   común exige que todos tengan lectura); asociar un post tarde baja el
   corte de 720 h a 24 h. Hay que calcular el corte con los posts que sí
   tienen lectura y listar los demás en `missing_inputs`.
5. **Campañas M1–M3.** El reporte público pinta una curva de seguidores
   distinta de la ficha (una sola cuenta, solo filas de esa campaña); la
   lista negra de teléfonos/correos se aplica al nombre de la campaña sin
   sanear («Reto +1.000.000 de views» bloquea el reporte); «Lo que aportó
   la marca» vuelca las filas crudas (correcciones y hasta 900 líneas de CSV).
6. **Marco A1.** En Campañas y en flujo/gastos/ingresos/configuración de
   Finanzas el 404 sale con HTTP 200 porque `loading.tsx` envuelve a la
   página (la regla que `no-existe.test.tsx` fija para Cotizar y Ventas).
7. **ACC A2.** `finanzas.cobro.ver` (el permiso del Mánager) no abre nada:
   la ficha de campaña decide el cobro con `finanzas.factura.ver`.
8. Menores: `?error=`/`?aviso=` reflejan texto libre (Campañas, Conexiones,
   Finanzas); mensajes crudos de Postgres en «Nueva factura» y sin tope
   de monto; botones de escritura visibles sin el permiso en el detalle de
   factura; número DIAN sin forma de editarlo; contraste de `--deemph`
   (1,5:1) en el gráfico del flujo; `INSTAGRAM_REFRESH_MIN_REMAINING_MS`
   declarada y sin usar; `start` de OAuth sin comprobar `Origin`.

## 5. Para cerrar el sprint

Las historias del sprint 1 de Nicolás (CIM-4, CIM-5, CIM-8, CON-2, FIN-1)
están hechas y en producción desde el 21-sep; lo que el tablero marca
pendiente a su nombre es CON-7 y CON-8 (bloqueadas por fuera: insights de
Instagram en vivo y llaves de Google) y CON-2d. Lo que falta para dar el
sprint por cerrado con 9,5:

1. Fusionar esta rama a `main` y desplegar (push y deploy los corre
   Nicolás). Después, `pnpm verificar` en verde sobre `main`.
2. Reautorizar @selvathegolden en /conexiones.
3. Comprobar el 5-oct por la mañana que el turno dejó snapshot de
   @nicolasduartea (y, con el permiso de insights, la demografía: desbloquea
   CON-7 en vivo).
4. Decidir el punto 1 de §4 (Auth en producción) antes de abrir la URL a
   creadores reales.
5. Programar los puntos 2–4 de §4 como historias cortas (un día cada una).

## 6. Verificación de esta rama

`pnpm verificar` sobre la rama (5-oct, 25 min con la máquina a carga 25):
typecheck y lint en verde en los cinco paquetes; core 527/527,
connectors 304/304, web 2031/2032 (1 todo) con 187 archivos; db 1450/1454 y
worker 425/426 en esa pasada. Las tres rojas que quedaban se cerraron
después y se volvieron a correr aparte:

- db: dos pruebas (`alcance-finanzas`, `finanzas-costuras`) facturaban una
  campaña del seed que ya tiene factura y ahora chocan con la guarda nueva;
  se adaptaron para desatar y volver a atar la factura dentro de la misma
  transacción. Corridas aparte: 84/84.
- worker: `recordatorios.test.ts` se agotó por tiempo (16 min, timeout de
  pglite con la máquina saturada); sola, 9/9.
- Las pruebas nuevas: `token-vencido.test.ts` 3/3; `campanas.test.ts`
  (db) 56/56; `finanzas.test.ts` (db) y la web de Conexiones 128/128.

| Paquete | Pruebas | Resultado |
|---|---|---|
| core | 527 | verde |
| connectors | 304 | verde |
| db | 1454 | verde (dos corregidas y recorridas aparte) |
| web | 2032 | verde (1 todo) |
| worker | 426 | verde (una recorrida aparte por timeout de carga) |

Lo que no se pudo verificar desde esta máquina: `make cron.status` (sin
PAT), `job_run` (RLS), y la lectura diaria de @nicolasduartea por el
turno, que toca el 5-oct a las 05:00 UTC.

## 7. Segunda parte (5-oct): todos los datos de las cuentas de Instagram en pantalla

Lo que pasó el 5-oct, comprobado en Supabase: el turno sí leyó
@nicolasduartea (seguidores y publicaciones a las 05:10, cuatro llamadas
de demografía en 200 a las 05:20 con 100 filas en `audience_breakdown`,
publicaciones descubiertas a las 06:00, 12:00 y 18:00). Aun así la
pantalla decía «Vistas: Sin dato» y no enseñaba la demografía por dos
huecos del producto:

1. El job de cuenta solo pedía `/me`. El conector ya tenía
   `accountInsights` (`/me/insights`) y nadie lo llamaba.
2. La demografía no tenía pantalla: RES-4 (Rasheed, sprint 6) dependía de
   que CON-7 tuviera una cuenta real con permiso de insights, y la primera
   es justamente esta.

Lo hecho en esta rama:

- **Worker · `collect.account_metrics`.** Para una cuenta de Instagram
  autorizada pide además `/me/insights` del último día cerrado (ayer, UTC)
  y guarda el snapshot con la fecha de ESE día: vistas, alcance,
  interacciones, cuentas que interactuaron, visitas al perfil, altas y
  clics. Se piden las métricas documentadas más `profile_views`; si Meta
  rechaza la lista (error 100), se repite con la base; si tampoco, la
  cuenta se guarda igual con seguidores y publicaciones. Prueba:
  `apps/worker/test/instagram-insights.test.ts`.
- **Web · «Actualizar»** hace lo mismo que el worker para Instagram.
- **db · `getAccountMetricsHistory`**: la serie de la cuenta (30 días, una
  fila por día, con las cifras del día) dentro del alcance. Prueba en
  `packages/db/test/demografia.test.ts`.
- **Web · ficha de la cuenta `/conexiones/[id]`**: KPIs del último día
  (seguidores con variación a 7 días, publicaciones, vistas, alcance,
  interacciones, visitas al perfil), gráfico de 30 días de seguidores y
  vistas, y «Quién la sigue»: edad, género, país y ciudad con el kit
  (barras, «datos hasta», hasta diez tramos y «y N más»), más los huecos
  de la red con su frase. El nombre de cada cuenta en la tabla enlaza a
  su ficha. El 404 lo decide un `layout.tsx` propio, antes del
  `loading.tsx` del módulo. Pruebas: `[id]/audiencia.test.tsx`.

Qué verá Nicolás: la demografía de @nicolasduartea ya está en la ficha.
Las vistas y el alcance de la cuenta aparecen con la primera pasada del
worker tras desplegar (05:10 UTC) o al pulsar «Actualizar». Las vistas por
publicación llegan con `collect.post_metrics` (05:00 UTC), que hoy corrió
antes de que existieran las 26 publicaciones.

Para Rasheed: RES-4 puede leer `getAccountAudience` /
`listAccountAudience` y `getAccountMetricsHistory` de `@mc/db` tal cual;
la ficha de Conexiones es el primer consumidor.

### 7.1 Lo que apareció al revisar producción el 9-oct

Cuatro días después, producción (todavía sin esta rama) tenía demografía
diaria de @nicolasduartea (100 filas cada mañana) y seguidores diarios,
pero **cero lecturas por publicación**: `collect.post_metrics` llamaba a
`/{media}/insights` y Meta respondía 400, código 100, «does not support
the metrics: reposts». La lista documentada para feed y carruseles traía
`reposts`, y Meta rechaza la llamada entera si una métrica no aplica.
Arreglo en `@mc/connectors`:

- `reposts` sale de la lista de feed.
- `InstagramClient.mediaInsights` y `accountInsights` leen las métricas
  que Meta nombra en el error (`PlatformApiError.platformMessage`, nuevo)
  y repiten una sola vez sin ellas; si el error no nombra ninguna de las
  pedidas, o las nombra todas, se propaga. Prueba:
  `packages/connectors/test/instagram-metricas-rechazadas.test.ts`.

Con esto, las vistas por publicación de los 25 carruseles y el reel
llegan con la primera pasada de `collect.post_metrics` tras desplegar
(05:00 UTC), y la ficha y Resumen dejan de ver «Sin dato» en vistas.
