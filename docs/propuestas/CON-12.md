# CON-12 · Proveedor de datos de TikTok por @ — plan, costo y lo que necesita Rasheed

Escrito para: Nicolás (la decisión de proveedor y el costo mensual) y
Rasheed (despliegue y variables de entorno; aquí **no** hay migración).
Fecha: 23 de septiembre de 2026. Rama `nicolas/CON-12-proveedor-tiktok`,
worktree `rayit-con12`, desde `origin/main` (29460e3).

> **Condición de apertura no cumplida.** La historia dice: «decisión mía
> con el costo mensual aprobado y la variable del proveedor en el vault».
> Hoy no hay plan contratado ni variable. Por eso todo lo que sigue queda
> **inerte sin la variable**: sin `ENSEMBLEDATA_TOKEN`, TikTok sigue
> exactamente como en CON-10 (identidad por oEmbed, cifras «pendientes de
> fuente»), la pantalla dice qué falta y ni un byte sale a la red del
> proveedor. La variable **es** el interruptor: el día que Nicolás apruebe
> el gasto y la meta en el vault, TikTok empieza a dejar seguidores y
> vistas sin tocar una línea de código.

---

## 0. Plan (fase 1)

### 0.1 La decisión: EnsembleData

Los tres candidatos de la historia, comparados por lo que pide el
criterio de terminado (seguidores + vistas + lista de videos) y por
precio por mil consultas. Todo leído el 23-sep-2026.

| | **EnsembleData** (elegido) | Apify | Phyllo |
|---|---|---|---|
| Seguidores por @ | Sí, `/tt/user/info` → `stats.followerCount` | Sí, según el actor | Sí, pero pidiendo al creador que conecte |
| Vistas | Suma de `play_count` de la lista de videos | Igual | Sí, con cuenta conectada |
| Lista de videos | Sí, `/tt/user/posts`, 10 por unidad, con cursor | Sí | Sí |
| Precio publicado | Sí, autoservicio: $100–$1 400/mes | Sí, por actor: $0,20–$1,00 / 1 000 resultados | No: cotización a medida desde ~$199/mes |
| Precio por mil consultas | $2,22 (Wood) a $0,93 (Platinum) | $0,20–$1,00 por mil **resultados** (≠ consultas) | Desconocido sin hablar con ventas |
| Forma de llamada | HTTP síncrono, una petición una respuesta | Asíncrono: lanzar un *run*, esperar, leer el *dataset* | HTTP síncrono |
| Quién responde | La empresa, con SDK propio y códigos de error documentados | El autor del *actor* (terceros de la comunidad) | La empresa |

**Por qué EnsembleData y no los otros dos:**

- **Apify sale más barato por resultado, y aun así se descarta.** Los
  actores de TikTok son de terceros de la comunidad: cambian de precio,
  de forma de salida y pueden desaparecer, y no hay un contrato con
  Apify por el contenido. Además el modelo es asíncrono (lanzar un run,
  hacer *polling*, leer el dataset), que no encaja con `HttpCore`
  —una petición, una respuesta, una fila en `api_call_log`, reintentos y
  cuota— sin construir un segundo camino entero solo para esto.
- **Phyllo se descarta porque cobra por lo que ya tenemos gratis.** Su
  producto es la conexión autorizada del creador: exactamente lo que
  CON-3 hace sin costo con el OAuth oficial de TikTok. Pagar desde
  ~$199/mes, y con cotización a medida (no se puede anotar un costo sin
  una llamada de ventas), por una capacidad que el repositorio ya tiene
  es el peor de los tres tratos.
- **EnsembleData gana por lo aburrido:** precio publicado sin hablar con
  nadie, un token y ya; todos los endpoints de TikTok a 1 unidad;
  taxonomía de errores documentada con códigos propios (491 token
  inválido, 493 suscripción vencida, 495 unidades agotadas, 473 usuario
  no encontrado, 472 usuario privado…), que es justo lo que necesita el
  clasificador de `http/errors.ts` para no confundir «la cuenta no
  existe» con «se acabó el plan».

### 0.2 El costo mensual (lo que hay que aprobar)

Planes publicados en ensembledata.com/pricing (23-sep-2026). Las unidades
son **diarias** y se reinician a las 00:00 UTC; lo que no se usa no se
acumula.

| Plan | USD/mes | Unidades/día | Unidades/mes (30 d) | **USD por mil unidades** |
|---|---:|---:|---:|---:|
| Prueba gratis | 0 | 50 | 1 500 | — |
| Wood | 100 | 1 500 | 45 000 | **2,22** |
| Bronze | 200 | 5 000 | 150 000 | 1,33 |
| Silver | 400 | 11 000 | 330 000 | 1,21 |
| Gold | 800 | 25 000 | 750 000 | 1,07 |
| Platinum | 1 400 | 50 000 | 1 500 000 | 0,93 |

**Lo que gasta una cuenta de TikTok al día en On Cue:**

```
1 unidad   (tt/user/info: seguidores, seguidos, número de videos)
+ ceil(videos / 10) unidades   (tt/user/posts: la lista, 10 videos por unidad)
```

| Videos del creador | Unidades/día | Cuentas que caben en Wood (1 500/día) | Costo/cuenta/mes |
|---|---:|---:|---:|
| 30 | 4 | 375 | $0,27 |
| 120 | 13 | 115 | $0,87 |
| 200 (el tope por defecto) | 21 | 71 | $1,41 |

**La recomendación: empezar en Wood, $100/mes.** Cubre unas 70–115
cuentas de TikTok leídas todos los días, que es más de lo que el MVP va
a tener. Si se queda corto, Bronze ($200) multiplica por 3,3 las
unidades y baja el precio por mil a $1,33.

**DECISIÓN PENDIENTE DE NICOLÁS:** aprobar el plan (recomendado: Wood,
$100/mes) y meter `ENSEMBLEDATA_TOKEN` al vault. Mientras tanto queda
todo apagado, y el código no asume ningún plan: el presupuesto diario
es `null` (§0.5).

### 0.3 Qué se construye

```
packages/connectors/src/public/tiktok-aggregator.ts
    EnsembleDataClient (userInfo, userPosts) sobre HttpCore
    createTikTokAggregatorSource(core, env): PublicProfileSource con
    accessMode 'aggregator' y snapshotSource 'aggregator'
packages/connectors/src/public/types.ts
    PublicProfileSource gana accessMode y snapshotSource; PublicProfile
    gana coverage (videos leídos / videos que dice el perfil)
packages/connectors/src/public/index.ts
    tiktok = agregador SI está configurado; si no, el oEmbed de CON-10
packages/connectors/src/quota/limits.ts
    familia 'ensembledata' con su fuente, su costo por endpoint y su
    presupuesto diario
packages/connectors/src/http/errors.ts
    los códigos del proveedor en AUTH_CODES / QUOTA_CODES / TRANSIENT_CODES
packages/connectors/src/testing/fixture-fetch.ts
    'token' entra a SECRET_QUERY_KEYS (el proveedor autentica por query)
packages/connectors/fixtures/ensembledata/*.json
    user.info.{ok,nulls}, user.posts.{ok,paginated,empty}, y los errores
    (invalid_token, units_depleted, user_not_found, private_user,
    rate_limited, server_error_then_ok, forma_cambiada)
packages/db/src/queries/conexiones.ts
    addPublicAccount recibe accessMode; AGGREGATOR_SNAPSHOT_SOURCE;
    ACCOUNT_SNAPSHOT_SOURCES lo incluye; setAccountAccessMode
apps/web/app/(app)/conexiones/_lib/cuentas-service.ts
    usa source.accessMode / source.snapshotSource; texto de TikTok
apps/web/app/(app)/conexiones/page.tsx
    'aggregator' se puede Actualizar y dice «Por proveedor de datos»
apps/worker/src/jobs/conexiones/collect-account-metrics.ts
    'aggregator' entra al filtro de access_mode y al source del snapshot
```

**No hay migración.** `access_mode = 'aggregator'` ya está en el CHECK
desde 0002 (y sobrevive a 0022), y `account_metric_snapshot.source` es
`text` sin CHECK, con su UNIQUE `(connection_id, day, source)`. Nada que
pedirle a Rasheed en `db/migrations/`.

### 0.4 Decisiones

1. **La variable es el interruptor, no una bandera nueva.** El patrón de
   CON-10 (`missing: readonly string[]`) ya expresa «esta fuente no está
   configurada» y la pantalla ya lo pinta. Una bandera en `content/flags.ts`
   sería un segundo interruptor que hay que acordarse de encender.
   Descartado.
2. **Las vistas son la suma del catálogo completo, o son `null`.** TikTok
   no publica vistas acumuladas de una cuenta por ningún camino; el
   equivalente honesto es sumar `play_count` de todos sus videos, igual
   que hace cualquier analítica de TikTok, y su diferencia diaria son las
   vistas del día. Si el catálogo **no** cupo en el tope (`maxPosts`, 200
   por defecto) o algún video vino sin `play_count`, las vistas quedan en
   `null` con la frase que lo explica: nunca un número a medias. Los
   seguidores sí se guardan igual, porque salen de otra llamada.
   **DECISIÓN PENDIENTE DE NICOLÁS:** el tope de 200 videos (21
   unidades/día/cuenta). Subirlo cubre creadores más grandes y cuesta
   proporcionalmente; se cambia con `ENSEMBLEDATA_MAX_POSTS` sin tocar
   código.
3. **Si el proveedor cambia de forma: error definitivo con mensaje, nunca
   datos a medias.** El parseo es tolerante en lo que no importa (campos
   extra, orden, `heartCount` que aparece o no) y estricto en lo que sí:
   si la respuesta es 200 pero no trae `data.user` con un `uniqueId`, o
   no trae `data.stats` con un `followerCount` numérico, se lanza un
   error **permanente** (`not_discoverable`) que dice en español que el
   proveedor cambió el formato y hay que revisar el conector. Un
   `followerCount` ausente no se convierte en cero, y una lista de videos
   que llega a medias no produce un total de vistas. El fixture
   `user.info.forma_cambiada.json` fija esa conducta en una prueba.
4. **Una cuenta que ya existía por @ se convierte, no se duplica.** Las
   cuentas de TikTok dadas de alta con CON-10 son `public_profile` y **no
   tienen ningún snapshot** (el oEmbed no da cifras), así que al
   encenderse el proveedor la fila pasa a `access_mode = 'aggregator'`
   conservando su id, su consentimiento y su historia. Instagram y
   YouTube no se tocan: siguen siendo `public_profile`.
5. **Presupuesto diario `null`, consumo persistido.** El código no asume
   ningún plan: `daily.units = null` (existe pero no se conoce) y
   `persist: true`, así `api_quota_usage` acumula lo gastado de verdad y
   Nicolás puede ver el consumo real antes de decidir si Wood alcanza.
   Cuando el plan esté aprobado, su número entra por
   `ENSEMBLEDATA_DAILY_UNITS` (o por `platform.limits`) y el
   `QuotaManager` corta **antes** de llamar en vez de esperar al 495 del
   proveedor. El 495 se clasifica igual como `quota`, así que nunca se
   gasta de más en silencio.
6. **Ventana de llamadas conservadora.** El proveedor dice que «no impone
   límites de tasa», pero su propio SDK reconoce un 429. Se aplica una
   ventana de 60 llamadas/minuto a escala de app, marcada como
   **DECISIÓN PENDIENTE DE NICOLÁS** igual que las de CON-1: es nuestra,
   no de su documentación.
7. **`collect.posts` no se construye aquí.** La lista de videos ya se lee
   y se normaliza (`listPosts` de la fuente devuelve `NormalizedVideo[]`),
   pero el job que los guarda en `post` y `post_metric_snapshot` es
   **CON-5**. Construirlo aquí sería hacer otra historia.

### 0.5 Las variables (las mete Nicolás en el vault)

| Variable | Obligatoria | Qué es |
|---|---|---|
| `ENSEMBLEDATA_TOKEN` | Sí | El token del panel de EnsembleData. Sin ella, TikTok sigue como en CON-10. |
| `ENSEMBLEDATA_MAX_POSTS` | No (200) | Tope de videos que se leen para sumar las vistas. |
| `ENSEMBLEDATA_DAILY_UNITS` | No (sin tope) | Unidades/día del plan contratado, para cortar antes de gastarlas. |

Las tres van al entorno de la web (Vercel) **y** al del worker (CIM-7).

### 0.6 Fuera de alcance

- `collect.posts` y `collect.post_metrics` con `source 'aggregator'`:
  **CON-5**, sobre el `listPosts` que esta historia deja listo.
- Demografía de audiencia por proveedor: **CON-7**.
- Instagram y YouTube por proveedor: no hacen falta, tienen camino
  oficial y gratuito (CON-10).

---

## 1. Cómo se ve, antes y después de la variable

**Hoy (sin `ENSEMBLEDATA_TOKEN`)** `/conexiones` no cambia ni un píxel:
la tarjeta de TikTok sigue diciendo «Confirmamos la cuenta; TikTok no
publica seguidores ni vistas por @ (métricas pendientes de fuente)», la
fila de una cuenta de TikTok sigue con «Sin cifras por @» y el botón
«Autorizar cifras» de CON-3.

**Con la variable**, en la misma pantalla y sin desplegar nada nuevo:

- la tarjeta de TikTok pasa a «Seguidores, vistas acumuladas y número de
  videos, por el proveedor de datos contratado»;
- una cuenta de TikTok que ya estaba por @ se convierte a `aggregator`
  la primera vez que se lee (con «Actualizar», o con el barrido diario
  de las 05:10 UTC), **conservando su id, su consentimiento y su
  historial**, y su fila muestra seguidores, publicaciones, vistas y
  «datos hasta el …»;
- la columna «Cifras» dice «Por proveedor de datos» en vez de ofrecer
  «Autorizar cifras»;
- un @ nuevo de TikTok entra directamente como `aggregator` con las
  cifras del día.

Si el proveedor falla, cada caso tiene su frase y ninguna se parece a
otra: «No encontramos @x en TikTok», «la cuenta es privada o está
restringida», «rechazó la credencial de On Cue; hay que revisar
ENSEMBLEDATA_TOKEN», «la suscripción está vencida», «se agotaron las
unidades del día». Y si el proveedor cambia de formato, sale un error
definitivo que lo dice, en vez de guardar una cuenta a medias.

## 2. Lo que necesita Rasheed

**Nada en `db/migrations/`.** `access_mode = 'aggregator'` ya está en el
CHECK de `social_connection` desde la migración 0002, y
`account_metric_snapshot.source` es `text` libre con su
`UNIQUE (connection_id, day, source)`. Esta historia no toca el esquema.

Lo único que hay que sumar al entorno cuando Nicolás apruebe el plan
(§0.5): `ENSEMBLEDATA_TOKEN` en Vercel **y** en el entorno del worker
(CIM-7), y, si se quieren afinar, `ENSEMBLEDATA_MAX_POSTS` y el
presupuesto diario por `platform.limits`.

`.env.example` (archivo compartido, no lo toco): faltan
`INSTAGRAM_HOUSE_TOKEN` y `GOOGLE_API_KEY` de CON-10, y ahora
`ENSEMBLEDATA_TOKEN` y `ENSEMBLEDATA_MAX_POSTS`.

## 3. Cuando llegue el token, esto es lo que hay que confirmar

Los fixtures salen de la documentación (`meta.source: "docs"`), que es
la convención del repositorio hasta que haya una credencial real. Con el
token en la mano, tres cosas se comprueban en una tarde y se regraban:

1. **La forma de `tt/user/info`.** La guía del proveedor muestra
   `data.user` + `data.stats`, y su SDK expone `units_charged` en la
   raíz; el parseo tolera las dos. Confirmar cuál es.
2. **Si `tt/user/posts` cobra una unidad por llamada o una por bloque de
   diez.** El código declara `units = depth` (lo caro), que es el
   supuesto conservador; si resulta ser una por llamada, el costo real
   baja mucho y el tope de 200 videos se puede subir sin pensarlo.
3. **Si existe un campo de vistas acumuladas de cuenta** en algún
   endpoint (por ejemplo un «user detailed info»). Si existe, las vistas
   dejan de necesitar el catálogo entero y el costo por cuenta cae a una
   o dos unidades al día.

Para regrabarlos: `pnpm --filter @mc/connectors record -- --platform
ensembledata --ref env:ENSEMBLEDATA_TOKEN` (el script anonimiza ids y
handles, y no guarda cabeceras de petición).

## 4. Verificación (23 de septiembre)

- `pnpm --filter @mc/connectors test`: **194** (14 nuevas de CON-12:
  la fuente apagada sin la variable, seguidores y vistas del catálogo
  completo, nulos que no son ceros, catálogo paginado, forma anidada,
  catálogo truncado, video sin `play_count`, dos formas cambiadas, los
  cinco códigos del proveedor con su frase, 429 y 500 transitorios, la
  cuota por familia, `listPosts` para CON-5, y el @ mal escrito que no
  gasta una unidad).
- `pnpm --filter @mc/db test`: **605** (3 nuevas: alta con `aggregator`
  y su snapshot, contratar y dar de baja el proveedor conservando id e
  historia, y la cuenta autorizada que no se degrada).
- `pnpm --filter @mc/worker test`: `collect-account-metrics` en verde con
  una prueba nueva: con `ENSEMBLEDATA_TOKEN`, la fila de TikTok pasa a
  `aggregator`, deja seguidores 128 400 y vistas 65 401 con
  `source = 'aggregator'`, la cuenta inexistente queda en `error` con el
  mensaje del proveedor, y el token no aparece en ninguna columna de
  texto, ni en `api_call_log`, ni en los logs del worker.
- `pnpm --filter @mc/web test`: 9 en `cuentas-service` (4 nuevas de
  CON-12, incluida la R4 del token del proveedor).

**Nota del entorno:** con la máquina cargada por varias sesiones a la
vez (carga media por encima de 100), las pruebas de `@mc/db` y las de la
web se cancelan por tiempo *antes* de llegar a correr —le pasa igual a
archivos que esta historia no toca. Con la máquina tranquila, todo va en
verde.
