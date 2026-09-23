# CON-6 · Línea base y puntaje — plan, contrato de lectura y lo que necesita Rasheed

Escrito para: Rasheed (dueño de `db/migrations/`, de los seeds `0001` y
`0002`, y de RES-3 y VEN-11, que leen lo que este job escribe) y
Nicolás (decisiones de producto marcadas abajo).

Fecha: 23 de septiembre de 2026. Rama `nicolas/CON-6-linea-base-puntaje`,
worktree `rayit-con6`, desde `origin/main` (29460e3).

**Qué entrega.** Los dos jobs nocturnos que producen el número central
del producto: `compute.baseline` (cron `40 5`) escribe la mediana propia
del creador por red y corte de edad en `creator_baseline`, y
`compute.post_score` (cron `45 5`) compara cada video contra esa mediana
y deja `post_score` con `views_vs_median`, `outlier_tier` y la
notificación de outlier o breakout, una sola vez por video y nivel.

**No toca migraciones.** Las tablas (`creator_baseline`, `post_score`),
la vista (`post_metrics_at_cut`), los `job_definition` y los `kind` de
`notification` ya existen desde `0003`, `0009` y `0010`.

---

## 0. Plan (fase 1)

### 0.1 Lo que se comprobó antes de diseñar

| Qué | Resultado | Consecuencia |
|---|---|---|
| ¿Está CON-5 (el recolector) en alguna rama? | No: `nicolas/CON-5-recolector-posts` existe pero no tiene ni un commit sobre `main` | CON-6 no puede esperar a que alguien llene `post_metric_snapshot` en vivo. Se construye y se prueba sobre lo que **ya** llena esa tabla: el seed `0002` (2 658 lecturas de 60 videos) y el CSV de RES-2. El día que CON-5 exista, estos jobs no cambian: leen la tabla, no el recolector. |
| ¿Qué hay en el seed `0002`? | 60 videos de una creadora en 4 redes (TikTok 21, Instagram 17, YouTube 12, Facebook 10), 2 658 lecturas, 0 borrados; 59 han pasado las 24 h, 35 las 720 h | Alcanza para los seis casos de prueba sin inventar datos. |
| ¿El seed ya calcula línea base y puntaje? | **Sí**: su sección 7 calcula las 16 filas de `creator_baseline` y las 60 de `post_score` en SQL, con la misma regla que `scoring.ts` (y `packages/core/test/seed-umbrales.test.ts` ata los umbrales) | El job **tiene que dar exactamente lo mismo** sobre los mismos datos. Es la verificación más fuerte que hay disponible, y se usa en la fase 4. |
| ¿La demo ya tiene un outlier y un breakout? | Sí: `d01` con 5,971× (breakout) y otros cuatro ≥ 2× (outlier) | **No hace falta tocar `db/seed/0002`** (era una de las preguntas de la historia). Detalle en §3. |
| ¿`creator_post_board` ya une `post_score`? | Sí (`0010`, líneas 70-103): trae `views_vs_median`, `outlier_tier` e `is_outlier` y excluye los borrados | RES-3 y VEN-11 no necesitan una vista nueva. Confirmado en §2. |
| ¿Cuánto cuesta recalcular todo? | Ver §0.3 · decisión 4 | Se recalcula siempre. |

### 0.2 Qué se construye

```
packages/core/src/scoring.ts       medianOf / percentileOf (null, no cero, con lista vacía),
                                   interactionsOf, engagementRate, savesPer1k, isOutlier
packages/core/test/scoring.test.ts sus pruebas
apps/worker/package.json           @mc/core como dependencia de workspace (no es un paquete nuevo de npm)
apps/worker/src/jobs/conexiones/compute-baseline.ts     compute.baseline
apps/worker/src/jobs/conexiones/compute-post-score.ts   compute.post_score
apps/worker/src/jobs/conexiones/index.ts                los suma a conexionesJobs
apps/worker/test/compute-baseline.test.ts               pruebas en el arnés (pglite + migraciones reales)
apps/worker/test/compute-post-score.test.ts
apps/worker/README.md              los dos jobs nuevos
apps/web/content/backlog.ts        estado de CON-6 (solo mi entrada)
docs/propuestas/CON-6.md           este archivo
```

Ninguna pantalla en esta historia: «Mis videos» es fase 2 y RES-3,
VEN-11 y CAM-5 son sus propias historias.

### 0.3 Decisiones

**1 · Qué corte manda para `post_score`: el mayor que el video ya
alcanzó.** Un video de 3 días se puntúa a 72 h contra la línea base de
72 h; uno de 40 días, a 720 h. `age_hours_cut` queda escrito en la fila
para que ninguna pantalla tenga que adivinarlo. Un video de menos de
24 h **no** recibe fila: no hay corte alcanzado y cualquier número
sería una comparación entre edades distintas, que es justo el error que
`scoring.ts` existe para evitar.

Si el corte no tiene línea base fiable (`sample_size < 8`), la fila **sí
se escribe**, con `views_at_cut` y `age_hours_cut` reales y
`views_vs_median = NULL`, `outlier_tier = NULL`, `is_outlier = false`.
Un cero diría «te fue pésimo» cuando la verdad es «todavía no sabemos».
`is_outlier` es `NOT NULL` en `0003`, así que el «no sabemos» vive en
`views_vs_median` y en `outlier_tier`, y la pantalla lee esos dos.

Descartado: puntuar cada video en **todos** los cortes que alcanzó.
`post_score` tiene `PRIMARY KEY (post_id)` — es el puntaje vigente, no
un histórico—, así que no cabe sin una migración, y la historia no toca
migraciones.

**2 · Ventana de la línea base: los últimos 20 videos que de verdad
llegaron al corte.** Por (workspace, creador, red, corte): los 20 más
recientes por `published_at` que (a) ya cumplieron la edad del corte
(`published_at <= ahora − corte`), (b) tienen una lectura en
`post_metrics_at_cut` para ese corte y (c) no están marcados
`deleted_on_platform`. El 20 no es un número mágico: es
`creator_baseline.window_posts`, cuyo `DEFAULT` en `0003` es 20, y se
escribe en la fila.

Las dos condiciones (a) y (b) hacen falta las dos: la vista da «la
última lectura con `age_hours <= corte`», así que un video de 10 horas
con una lectura a las 6 aparecería en el corte de 24 h con un valor
inmaduro y bajaría la mediana de todos los demás.

- **Videos que entraron por CSV** (RES-2, `source = 'csv_import'`):
  entran. Son datos del creador y su lectura vive en la misma tabla; la
  regla mira la edad, no de dónde vino el número.
- **`media_type` distinto de `video`**: entran, separados solo por
  plataforma. Es lo que hace hoy el seed y lo que espera `0003` (la
  línea base es por creador y red, sin columna de `surface`). **Queda
  anotado**: una historia (foto) y un reel comparten mediana, y eso
  ensucia la comparación en cuanto una cuenta publique las dos cosas en
  volumen. Separar por `surface` pide una columna nueva en
  `creator_baseline` → migración → fase 2.
- **Borrados**: fuera de la ventana (regla de la historia), igual que
  `creator_post_board` los excluye. Diferencia anotada con el seed, que
  no los filtra porque no tiene ninguno.

**3 · Engagement y guardados, en `@mc/core`.**
`engagementRate = total_interactions / views`, y cuando
`total_interactions` es nulo, `likes + comments + shares + saves` de lo
que haya. `savesPer1k = saves / views × 1000`. Los dos devuelven `null`
si `views` es nulo o cero, y `null` (no cero) si no hay ninguna
interacción que sumar. Van en `scoring.ts` con prueba, no en el job:
el día que CAM-5 o VEN-11 necesiten el mismo número, lo llaman.

Junto con ellas entran `medianOf` y `percentileOf`, que devuelven `null`
con la lista vacía. `median([])` devuelve `0` y eso, escrito en
`median_completion`, sería una cifra inventada: YouTube no da
`skip_rate_3s` y TikTok no da `saves`, así que la lista vacía es el caso
normal, no el raro.

**4 · Cuándo recalcular: siempre.** Medido sobre el seed en Postgres
embebido: las 16 líneas base (4 redes × 4 cortes, 60 videos, 2 658
lecturas) salen de **una** consulta; el job entero cierra en menos de un
segundo. La salida real está en §4.

Descartado «solo si hay lecturas nuevas desde `computed_at`»: sería
incorrecto, no solo prudente. La ventana cambia **con el paso del
tiempo**, sin que llegue una lectura nueva: un video publicado hace
seis días y medio entra en el corte de 168 h mañana con la lectura que
ya tiene guardada. Un job que se saltara el recálculo dejaría medianas
viejas en cuentas que no publican a diario, que son la mayoría.

`creator_baseline` es append-only (su `UNIQUE` incluye `computed_at`):
cada corrida deja su fila y la anterior queda como historia. Son 16
filas al día por creador con cuatro redes: ~5 800 al año. `post_score`
tiene `PRIMARY KEY (post_id)`: se reemplaza.

**5 · La notificación, una por video y por nivel.** Cuando un video
llega a `outlier` (≥ 2×) se crea una fila en `notification` con
`kind = 'outlier'`; si más adelante sube a `breakout` (≥ 5×), se crea
**otra** con `kind = 'breakout'`. Nunca una segunda del mismo nivel para
el mismo video, aunque el job corra todas las noches.

El registro de «ya avisé» **no** es `post_score.notified_at` —que es una
sola fecha y no sabe de qué nivel— sino la propia tabla `notification`:
antes de insertar se comprueba si ya existe una con
`(workspace_id, kind, entity_type = 'post', entity_id = post_id)`. Es
exacto, sobrevive a cualquier recálculo y no pide columna nueva.
`notified_at` guarda **la última** notificación enviada, que es lo que
dice su comentario en `0003`.

La fila: `severity = 'success'` (es una buena noticia),
`title_es`/`body_es` en español con el múltiplo formateado en el
`locale` del workspace (`workspace.locale`, que ya existe; nunca
`'es-CO'` a mano), `entity_type = 'post'`, `entity_id` = el video,
`action_url = '/resumen'` (RES-3 es quien la muestra), `user_id = NULL`
= para todo el workspace, como hace `oauth.refresh` con
`connection_error`.

**6 · Contrato de lectura para RES-3, VEN-11 y CAM-5:** §2 de este
documento. No hace falta vista nueva.

**7 · La aritmética sale de `@mc/core`, aunque el seed la repita en
SQL.** El job trae las filas y calcula con `medianOf`, `percentileOf`,
`versusMedian`, `outlierTier`, `engagementRate` y `savesPer1k`. Es más
código que un `INSERT … SELECT percentile_cont(…)`, y es la regla del
repositorio: si el dashboard y el job nocturno clasifican distinto, el
producto pierde la credibilidad el primer día que un creador compare
dos pantallas. La atadura con el SQL del seed ya existe
(`packages/core/test/seed-umbrales.test.ts`) y la verificación de la
fase 4 compara fila por fila lo que escribe el job contra lo que escribe
el seed.

**8 · Aislamiento.** `ctx.db` corre como `mc_worker`, que se salta RLS:
cada `SELECT`, `INSERT` y `UPDATE` de los dos jobs lleva `workspace_id`
explícito, y el agrupamiento es por `(workspace_id, creator_id,
platform_id, corte)`, nunca por creador suelto. Prueba negativa con dos
workspaces en el arnés.

**9 · Concurrencia y reloj.** Los grupos se procesan con `mapLimit` y
`ctx.definition.maxConcurrency` (2 en `0009`), el mismo patrón de
`oauth-refresh.ts`; aquí acota transacciones abiertas, no llamadas a una
API. El reloj es `ctx.now()`. Se respeta `ctx.signal`. Los dos jobs son
idempotentes: correr `compute.post_score` dos veces no duplica
notificaciones ni baja el corte de un video.

### 0.4 Dudas y decisiones pendientes

1. **DECISIÓN PENDIENTE DE NICOLÁS · una mediana por red, no por
   formato.** Hoy un reel, una foto y una historia de Instagram
   comparten mediana (decisión 2). Con el seed no se nota —son 60
   videos— pero en una cuenta real hunde la mediana. Se toma la opción
   conservadora (como el seed y como `0003`) y separar por `surface`
   queda anotado para fase 2, porque pide columna nueva.
2. **DECISIÓN PENDIENTE DE NICOLÁS · a quién le llega la
   notificación.** `user_id = NULL` (todo el workspace) es lo que hace
   hoy `oauth.refresh`. Cuando ACC-1 reparta roles habrá que decidir si
   un mánager con rol de solo lectura recibe el aviso de outlier. No
   bloquea: RES-3 filtra por workspace.
3. **Para Rasheed, no bloqueante:** los dos jobs leen
   `post_metrics_at_cut`, una vista. Ver §5.

---

## 1. Qué escribe cada job

### `compute.baseline` (cron `40 5`, cola `compute`)

Una fila de `creator_baseline` por `(workspace, creador, red, corte)`
con lo que salga de la ventana de la decisión 2:

| Columna | De dónde sale |
|---|---|
| `window_posts` | 20 (`creator_baseline.window_posts`, `0003`) |
| `age_hours_cut` | uno de `AGE_CUTS_HOURS` (24, 72, 168, 720) |
| `sample_size` | videos de la ventana |
| `median_views`, `p25_views`, `p75_views` | `medianOf` / `percentileOf` sobre las views a ese corte |
| `median_reach`, `median_engagement`, `median_saves_per_1k`, `median_completion`, `median_skip_3s` | mediana de lo que **hay**; `NULL` si la red no da esa métrica |
| `is_reliable` | `sample_size >= MIN_SAMPLE_FOR_BASELINE` (8) |
| `computed_at` | `ctx.now()` |

Payload opcional: `{ workspaceId?, creatorId?, platformId? }`.

### `compute.post_score` (cron `45 5`, cola `compute`)

Una fila por video que ya alcanzó un corte, con el mayor que alcanzó,
contra la línea base **más reciente** de su red en ese corte.

`ON CONFLICT (post_id) DO UPDATE … WHERE post_score.age_hours_cut <=
EXCLUDED.age_hours_cut`: el corte **nunca baja** (un reloj torcido o un
`published_at` corregido no reescriben un puntaje por otro medido a
menos edad), pero el mismo corte **sí se refresca** cada noche contra la
mediana de hoy. `notified_at` no se toca en ese `UPDATE`: sobrevive al
recálculo.

Payload opcional: `{ workspaceId?, postId? }` (puntuar un solo video
después de una recolección).

---

## 2. Contrato de lectura (RES-3, VEN-11, CAM-5) — para Rasheed

**No hace falta ninguna vista nueva.** `creator_post_board` (`0010`) ya
une `post_score` y ya excluye los borrados:

```sql
-- Los cinco videos que más hicieron sobre su propia mediana.
SELECT post_id, platform_id, title, url, published_at,
       views, views_vs_median, outlier_tier, is_outlier
  FROM creator_post_board
 WHERE views_vs_median IS NOT NULL
 ORDER BY views_vs_median DESC
 LIMIT 5;
```

Reglas de lectura, las tres que importan:

1. **`views_vs_median IS NULL` significa «todavía no sabemos»**, no
   cero: o el video no ha cumplido 24 h, o su red todavía no tiene ocho
   videos en ese corte. En pantalla es una frase («aún no hay suficientes
   videos para comparar»), nunca un guion mudo ni un `0,0×`.
2. **`age_hours_cut` es parte del número.** «2,4×» sin «a los 7 días» no
   se entiende. La columna está en `post_score`; si se necesita en la
   vista, es una migración (hoy `creator_post_board` no la trae).
   `views` de la vista es la **última** lectura (`post_metrics_latest`),
   no `views_at_cut`: para enseñar el par «views a los 7 días · 2,4×»
   hay que leer `post_score.views_at_cut`.
3. **La confiabilidad vive en `creator_baseline.is_reliable`**, y
   `post_score.baseline_id` apunta a la fila exacta contra la que se
   comparó ese video ese día. Para VEN-11 («cada cifra lleva a su
   origen») ese `baseline_id` es el origen.

Para RES-3, las notificaciones ya vienen listas:

```sql
SELECT id, kind, severity, title_es, body_es, entity_type, entity_id, action_url, created_at
  FROM notification
 WHERE kind IN ('outlier','breakout') AND read_at IS NULL AND dismissed_at IS NULL
 ORDER BY created_at DESC;
```

Para CAM-5, el `views_vs_median` de los videos de una campaña sale de
`post_score` por `campaign_post.post_id`; no hace falta recalcular nada.

---

## 3. `db/seed/0002` — no hace falta tocarlo

La historia preguntaba si el seed necesita un video outlier para la
demo. **No.** Su sección 7 ya deja cinco videos en 2× o más, con un
breakout:

| Video | Corte | Views al corte | × mediana | Nivel |
|---|---|---|---|---|
| `…0d01` | 720 h | 412 000 | 5,971 | `breakout` |
| `…0d06` | 72 h | 395 810 | 3,710 | `outlier` |
| `…0d18` | 168 h | 165 485 | 2,662 | `outlier` |
| `…0d02` | 720 h | 300 000 | 2,469 | `outlier` |
| `…0d28` | 72 h | 77 095 | 2,359 | `outlier` |

Lo único que el seed **no** trae es la notificación: `notification` está
vacía. Eso es correcto —la escribe el job, no el seed— y significa que
la demo de RES-3 necesita una corrida de `compute.post_score`, o que
`0002` siembre las filas de `notification` el día que RES-3 se
construya. Es decisión de Rasheed, dueño de `0002` y de RES-3; los dos
caminos funcionan y el job no duplica la notificación si el seed ya la
sembró con el mismo `kind` y `entity_id`.

---

## 5. Lo que necesita Rasheed

1. **`0024_aislamiento_por_defecto.sql` es prerrequisito de estos dos
   jobs en Supabase.** Los dos leen `post_metrics_at_cut`, y una vista
   sin `security_invoker` corre con los privilegios de su dueño: el
   worker, que se salta RLS por rol, **no** se la salta a través de la
   vista y vería cero filas. `0024` pone `security_invoker = on` en
   todas las vistas (línea 592). Está en `main` y pendiente de aplicar,
   en la cola única de la nota de CIM-2. Hasta que se aplique, estos
   jobs dan `0 procesados` contra Supabase (en las pruebas y en la demo
   embebida corren las 33 migraciones, así que ahí funcionan).
2. **Nada de migraciones nuevas.** CON-6 no pide ninguna.
3. **Cuando llegue RES-3**, leer §2 antes de escribir la consulta: la
   regla 1 (`NULL` no es cero) es la que rompe la pantalla si se ignora.
4. **`job_definition` ya tiene las dos filas** (`compute.baseline`,
   `compute.post_score`, migración `0009`): al arrancar el worker con
   estos jobs registrados dejan de aparecer como `skipped`.
