# CAM-3 · Seguidores de la marca — plan y lo que necesita Rasheed

Escrito para: Nicolás (dueño de Campañas) y Rasheed (dueño de
`db/migrations/`, del despliegue y del integrador).
Fecha: 23 de septiembre de 2026. Rama `nicolas/CAM-3-seguidores-marca`
desde `origin/main` (`29460e3`), worktree `rayit-cam3`.

---

## 0. Plan (escrito antes de tocar código)

### 0.1 Archivos

| Qué | Dónde | Estado |
|---|---|---|
| Aritmética del ritmo de seguidores (`ritmoSeguidores`), ventana de lectura del job (`isBrandSnapshotDue`), razones por las que una lectura no trae cifra (`BRAND_NO_DATA_REASONS`) | `packages/core/src/campanas.ts` + `test/campanas.test.ts` | mío |
| `listBrandFollowers` (serie + ritmo, unida a `campaign`), `recordBrandSnapshot` (un INSERT para la web y para el worker) | `packages/db/src/queries/campanas.ts` + `test/campanas.test.ts` | mío |
| Privilegio de INSERT de `mc_app` sobre `brand_account_snapshot` y su política vía `EXISTS campaign` | `db/migrations/0034_brand_snapshot_desde_la_web.sql` + `packages/db/src/esquema.ts` (la fila de `PRIVILEGIOS_DE_LA_APP`) | migración nueva con precedente (0014, 0015, 0016, 0022): pasa `make db.check` y `make db.guardia`. **Ver 0.2.8** |
| Job `brand.snapshot` | `apps/worker/src/jobs/campanas/brand-snapshot.ts`, `index.ts`; una línea en `jobs/index.ts`; `test/brand-snapshot.test.ts` | carpeta nueva (§3.2 del backlog la daba por creada) |
| Sección «Seguidores de la marca» de la ficha, «Actualizar ahora» y sus textos | `apps/web/app/(app)/campanas/[id]/seguidores.tsx` (+ test), `actions.ts` (una acción nueva), `_lib/marca-service.ts` (+ test), `_lib/messages.ts` (nuevo: los textos de esta sección), `_lib/db.ts` (reexporta `withWorkspace`, como Conexiones) | mío |
| `LineChart` con varias ventanas sombreadas (`shades`, aditivo; `shade` no cambia) | `components/ui/line-chart.tsx`, `charts.test.tsx`, `README.md`, `/kit` | componente del kit (mío); solo se agrega una prop opcional |
| `formatNumber` / `f.number` («12,9») | `apps/web/lib/format.ts` + test | una función nueva, nada cambia |
| Estado de la historia | `apps/web/content/backlog.ts` (solo CAM-3) | |
| README del worker y de la web; esta propuesta | `apps/worker/README.md`, `apps/web/README.md`, `docs/propuestas/CAM-3.md` | |

No toco `lib/auth/`, `lib/workspace/`, `packages/db/src/{client,schema}`,
`db/seed/0001` ni nada de Rasheed. La migración 0034 va en
`db/migrations/` por el precedente de 0022 (Rasheed la revisa; la aplica
quien integra, nunca yo).

### 0.2 Decisiones

1. **La aritmética vive en core: `ritmoSeguidores(serie, { baselineFrom, startsOn, endsOn })`.**
   La serie son puntos `{ day: 'YYYY-MM-DD', followers: number | null }`
   ordenados por día (los `null` son días sin cifra y se ignoran).
   Devuelve `{ baselineRate, campaignRate, gained, ratio, diasDeLineaBase,
   baselineDataFrom, fiable }` con `null` en cada cifra que no se puede
   calcular. La regla, una sola y en un solo sitio:
   - El crecimiento de una ventana de días `[desde, hasta]` es
     `F(fin) − F(ancla)`, donde `fin` es la última lectura dentro de la
     ventana y `ancla` es la **última lectura anterior a `desde`** (la
     cifra con la que la ventana arranca). Si no hay ninguna lectura
     anterior, el ancla es la primera lectura de la ventana y se pierde
     un día. La tasa es ese crecimiento dividido entre los días entre
     ancla y fin.
   - Línea base: `[baselineFrom, startsOn − 1]`. Campaña:
     `[startsOn, endsOn]`. `gained` es el crecimiento de la campaña.
   - Con el seed de Café Alma (60 días desde el 4 de julio, ancla del 26
     de julio) da exactamente **181 / 14 = 12,9286** antes, **1 240 / 8 =
     155** durante, **1 240 ganados** y `ratio` 11,99 → «×12 el ritmo»,
     que son los números del mock y de la cabecera del seed.
   - `diasDeLineaBase` cuenta los días de línea base **con datos**
     (desde la primera lectura dentro de la ventana hasta la última,
     ambas incluidas); `fiable` es `diasDeLineaBase ≥ BRAND_BASELINE_DAYS`
     (14) y las dos tasas calculables. Una línea base corta se marca, no
     se inventa. Descartado: rellenar huecos por interpolación (inventa
     cifras; un hueco de un día no cambia la tasa porque es un promedio
     entre dos lecturas reales).
   - Serie vacía, o sin lecturas dentro de la ventana → `null`.
2. **Una marca en varias campañas del mismo workspace: una fila por
   campaña, la historia se lee por empresa.** La historia proponía una
   fila por `(company_id, platform_id, day)` compartida por todas las
   campañas con `campaign_id` = la que la pidió. La guardia de `@mc/db`
   lo rechaza en cuanto `mc_app` inserta: `company` tiene filas de
   catálogo (sin dueño, 0025) que ven todos los workspaces, así que ese
   único es global entre inquilinos (0026 §2: el 23505 no pasa por RLS;
   dos workspaces con campaña sobre la misma marca del catálogo
   chocarían y la lectura de uno quedaría bajo la campaña del otro,
   invisible para el primero). Por eso 0034 cambia la unicidad a
   `(campaign_id, platform_id, day)` (y `(company_id, platform_id, day)`
   solo para las filas sin campaña, las del seed). El job hace UNA
   llamada por (workspace, empresa, red, handle) y deja una fila por
   campaña en ventana; `listBrandFollowers` lee por `company_id` de la
   campaña a través de `brand_account_snapshot` (RLS por la campaña de
   cada fila) con `DISTINCT ON (platform, day)`, así que la segunda
   campaña de Café Alma ve la historia de la primera. La prueba lo
   comprueba. Descartado: declarar el único global «porque en la
   práctica cada workspace tiene su copia de la empresa» (no vale para
   las del catálogo) o escribir filas sin campaña para las marcas del
   catálogo (una fila global derivada de una campaña privada deja
   inferir quién mide a quién: `politicas.ts`, «lo global del radar sale
   de fuentes públicas»).
3. **El job no reconstruye el pasado.** `business_discovery` y
   `channels.list` dan solo el conteo de hoy, así que la línea base
   existe si la campaña se creó con tiempo. Si no, la curva empieza cuando
   empezó y la ficha lo dice («línea base desde el 3 de octubre: 4 días»
   con `baselineDataFrom` y `diasDeLineaBase`), y `fiable = false` es lo
   que CAM-5 traduce a `missing_inputs`. El día de cada fila es la fecha
   UTC de `ctx.now()` (la misma convención que `collect.account_metrics`).
4. **Cuota: las mismas reglas que CON-10/CON-1 sobre la credencial de la
   casa.** El job construye las fuentes con `ctx.connectors.core`, así que
   comparte el `QuotaManager` del proceso (Instagram 200/h con
   `connection_id` nulo = cuota de la app; YouTube 10 000 unidades/día
   persistidas en `api_quota_usage`) y deja cada llamada en
   `api_call_log`. Un error `quota` cuenta como fallo pero devuelve
   `retry: false`: el siguiente tick del cron (07:00) es el reintento.
   «Actualizar ahora» usa un `HttpCore` propio con cuota en memoria, como
   `cuentas-service.ts`, y vuelca su bitácora a `api_call_log` en la
   misma transacción.
5. **Errores.** `not_found` / `not_discoverable` / `invalid_handle` son
   definitivos: dejan una fila con `followers NULL` y `source` con la
   razón (`not_found`, `not_discoverable`), la ficha la lee y dice «no
   encontramos @x en Instagram», y el job no la cuenta como fallo (no
   hay reintento de pg-boss); mañana vuelve a mirar. Transitorio (red,
   5xx, 429) → `failed`, sin fila, pg-boss reintenta. Fuente sin
   configurar (`missing`) → la plataforma se salta, `skipped` en la
   metadata y un `warn` una vez por corrida, como CON-10.
6. **«Actualizar ahora».** Server Action que lee la fuente en el momento
   y llama a la MISMA `recordBrandSnapshot(db, input)` que el job, con
   `ON CONFLICT DO NOTHING`: la primera lectura del día queda. La función
   recibe `{ query }` (un `WorkspaceTx` en la web, `ctx.db` en el worker),
   como `EncryptedSecretStore`. El worker pasa `{ onConflict:
   'fill_missing' }`: su INSERT reemplaza una marca «sin cifra» del mismo
   día por una lectura real (nunca al revés, nunca una lectura por otra);
   `mc_app` no tiene UPDATE, así que desde la web siempre es `DO
   NOTHING`. Segunda corrida del job el mismo día → ninguna fila nueva.
7. **TikTok.** No hay fuente pública de seguidores: el job deja una fila
   con `followers NULL`, `source 'tiktok.oembed'` y el handle, y la ficha
   explica con la nota de la fuente («TikTok no publica seguidores por
   @…»). No se vuelve a llamar a oEmbed cada día para eso: la fila del
   día se escribe sin llamada. Descartado: no escribir nada (la ficha no
   podría distinguir «sin fuente» de «el job no corrió»).
8. **Migración 0034 · unicidad por campaña y `mc_app` inserta en
   `brand_account_snapshot`.** Hoy `mc_app` solo tiene SELECT (0024 §7.2,
   0029) y la política de INSERT de 0029 es `TO CURRENT_USER` (el seed).
   Sin INSERT no existe «Actualizar ahora» desde la web, que es el punto
   (6) de la historia. La migración (a) cambia la unicidad como dice la
   decisión 2, (b) da `INSERT` (no UPDATE ni DELETE: append-only como
   `account_metric_snapshot` en 0025 §5), `USAGE` sobre
   `brand_account_snapshot_id_seq` (0026 §4: USAGE solo donde inserta),
   una política `FOR INSERT TO mc_app` que exige `campaign_id NOT NULL`,
   que la campaña se vea (RLS de `campaign`) y que `company_id` sea el de
   esa campaña, y (c) engancha `assert_reference_visible` a
   `campaign_id` y `company_id` (0025 §7 solo lo puso donde `mc_app`
   escribía entonces). Re-ejecutable, con cabecera. En `esquema.ts`:
   la fila de privilegios pasa a `SELECT, INSERT` y el índice parcial de
   las filas sin campaña se declara en `UNICOS_GLOBALES_DECLARADOS` con
   su motivo (la guardia no sabe que `mc_app` no escribe esas filas).
   **DECISIÓN PENDIENTE DE NICOLÁS**: la historia decía «sin
   migraciones»; la alternativa sin migración es que «Actualizar ahora»
   no exista y la ficha solo lea lo que dejó el job, con la unicidad
   vieja. Tomé la opción con precedente (0022) y la acción degrada bien:
   si Supabase aún no tiene 0034, el INSERT falla con `42501` y la ficha
   dice que la actualización manual llega con la migración, sin romper
   nada.
9. **Ventana de lectura del job.** Campañas `planned`, `live` o
   `measuring` con `brand_accounts` no vacío y hoy dentro de
   `[coalesce(brand_baseline_from, starts_on − 14), ends_on + 30]`; sin
   `starts_on` no hay límite inferior (se mide desde que existe: más
   historia, no menos) y sin `ends_on` no hay superior. `reported`,
   `closed` y `cancelled` no se leen aunque estén en ventana. La regla
   es `isBrandSnapshotDue` en core, probada sola. `BRAND_AFTER_DAYS =
   30` con su fuente (la historia y `campaign_result.cut_hours` = 720 h).
10. **Varias redes por campaña.** `brand_accounts` es una lista; la
    sección pinta una curva por cuenta (Café Alma tiene una). Facebook no
    tiene fuente (`createPublicProfileSources` no la trae) → `skipped`.
11. **Lo que enseña la ficha.** `ChartCard` con `LineChart` (`fromZero:
    false`, `shades`: línea base en tono neutro y campaña en el acento,
    con sus etiquetas), la `Pill` («×12 el ritmo» en `good` si `fiable`;
    en `warn` con «línea base corta» si hay tasas pero no 14 días; la
    razón en `neutral` cuando no hay cifra), la frase con las tres
    cifras («12,9/día antes · 155/día en campaña · 1 240 ganados»),
    «Actualizar ahora» y `DataAsOf` con el último `captured_at`. Cifras y
    fechas por `formatterFor(await getCurrentWorkspace())`; los textos
    en `_lib/messages.ts`. Sin cifra → frase, nunca guion ni cero.
12. **Metadata de `job_run`:** día, campañas en ventana, objetivos
    (pares campaña/plataforma), listas de ids por resultado y `skipped`
    por plataforma. Sin handles ni tokens; los handles de las marcas son
    públicos pero no hacen falta ahí (van en la fila).

### 0.3 Dudas que resolví solo

- **¿Editar `brand_accounts` desde la ficha?** La historia dice «el job
  no reintenta hasta que se corrija el handle», pero hoy el handle solo
  se fija al crear la campaña (desde `company.socials`) y no hay
  formulario. Lo dejo **fuera de alcance** (§4) con la recomendación de
  un campo «Cuentas de la marca» en el formulario de datos de CAM-1; la
  ficha dice qué corregir. **DECISIÓN PENDIENTE DE NICOLÁS.**
- **¿Un día = fecha de captura?** Sí (UTC de `ctx.now()`), como CON-10.
  El seed modela la fila del día como el cierre del día (captura a las
  06:00 del siguiente); la diferencia es de un día y no cambia ninguna
  cifra de la ficha: la aritmética ancla cada ventana en la lectura
  anterior, así que funciona con las dos convenciones.
- **¿Serie desde `brand_baseline_from − 1`?** La consulta trae también
  la lectura anterior a la línea base si existe (es el ancla); la
  curva se dibuja desde `brand_baseline_from`.
