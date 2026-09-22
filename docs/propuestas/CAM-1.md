# CAM-1 · Lista y ficha de campaña — plan y lo que Rasheed tiene que saber

Escrito para: Rasheed (dueño de `packages/db/src/client.ts`, `schema/`,
`db/seed/0002`, `lib/auth/` y `lib/workspace/`) y quien revise el PR de
CAM-1. Fecha: 22 de septiembre de 2026. Rama `nicolas/CAM-1-ficha-campana`,
sobre `origin/main` (bc72a12).

---

## 0. Plan (escrito antes de tocar código)

### 0.1 Archivos

| Qué | Dónde | Estado |
|---|---|---|
| Máquina de estados, etiquetas y reglas puras de campaña | `packages/core/src/campanas.ts` + `test/campanas.test.ts` | nuevo, mío |
| Consultas del módulo, todas con `WorkspaceTx` | `packages/db/src/queries/campanas.ts` + `test/campanas.test.ts` | nuevo, mío |
| Exportación del paquete | `packages/db/src/index.ts`, `package.json` (`exports`) | una línea cada uno |
| Conexión provisional compartida entre módulos | `apps/web/lib/db/index.ts`, `apps/web/lib/db/workspace.ts` | nuevo, mío (movido desde `finanzas/_lib/`) |
| Finanzas reexporta | `apps/web/app/(app)/finanzas/_lib/db.ts` (reexport), `_lib/workspace.ts` (se borra: solo lo importaba `db.ts`) | sin cambio de comportamiento |
| Lista | `apps/web/app/(app)/campanas/page.tsx`, `_lib/estado.ts`, `_lib/filtro-estado.tsx` (cliente) | reemplaza el `ModulePlan` |
| Ficha | `apps/web/app/(app)/campanas/[id]/page.tsx`, `actions.ts`, `copiar.tsx`, `editar-form.tsx` (SeguimientoForm y DatosForm), `asociar.tsx`, `transicion.tsx` (cliente los últimos cuatro) | nuevo |
| Pastilla de red con el color de la plataforma | `apps/web/components/ui/platform-pill.tsx` + test + fila en README + sección en `/kit` | componente nuevo del kit (permitido sin PR) |
| Estado de la historia | `apps/web/content/backlog.ts` (solo CAM-1) | |
| Esta propuesta | `docs/propuestas/CAM-1.md` | |

No toco `db/migrations/`, `db/seed/0003` (no hace falta: ya trae todo),
`lib/auth/`, `lib/workspace/`, nada de Rasheed.

### 0.2 Decisiones

1. **Conexión provisional compartida.** `getDb()` y `withWorkspace()`
   pasan de `finanzas/_lib/db.ts` a `apps/web/lib/db/index.ts`, con el
   singleton en `globalThis.__mcDb` (antes `__mcFinanzasDb`); el
   workspace provisional (`MC_WORKSPACE_ID` o el del seed) pasa a
   `lib/db/workspace.ts`. `finanzas/_lib/db.ts` queda como reexport para
   no tocar las páginas de Finanzas; `finanzas/_lib/workspace.ts` se
   borra porque solo lo importaba `db.ts`. Descartado: duplicar los dos
   archivos en `campanas/_lib/` (dos Postgres embebidos en modo demo,
   dos avisos por consola, dos sitios que cambiar en CIM-2/CIM-3).
   Descartado: ponerlo en `lib/workspace/` (es de Rasheed).
2. **Contrato de consultas** (`queries/campanas.ts`), todas con
   `WorkspaceTx`, dinero como string, fechas `date` como `YYYY-MM-DD`,
   `timestamptz` como ISO UTC:
   - `listCampaigns(tx, { status? })` → `CampaignListRow[]` con
     `postsCount`, `viewsTotal` (suma de `post_metrics_latest.views`;
     **null** si ningún post tiene snapshot), `dataAsOf` (máximo
     `captured_at`; null sin snapshots) y `hasInvoice` (alguna factura no
     anulada). `views` es `bigint` y los drivers no coinciden (pglite lo
     da como number, node-postgres como string): se pide `::text` y se
     convierte con `Number()` en un solo sitio (`intOrNull`). No es
     dinero, así que `number` está bien.
   - `getCampaign(tx, id)` → `CampaignDetail | null`: la campaña,
     `agreed` (desde `quote`, null sin cotización), `deliverables`
     (`quote_item` si hay cotización con ítems; si no, los `deliverable`
     de `campaign_post` agrupados; `source` dice de dónde salió),
     `invoices` (id, número, estado, total) y los mismos agregados que la
     lista. Las listas anidadas viajan como `jsonb_agg` para no hacer
     cuatro consultas por ficha.
   - `listCampaignPosts(tx, id)` desde `creator_post_board` unido a
     `campaign_post` **y a `campaign`** (la que tiene RLS) más
     `post_metrics_latest.captured_at` para «datos hasta».
   - `listLinkablePosts(tx, { campaignId, q? })`: posts del workspace
     (RLS en `post`) no asociados a ESA campaña, `ILIKE` sobre título y
     caption con los comodines escapados, 50 como máximo. Un post ya
     asociado a otra campaña sí aparece (una historia puede servir a dos
     campañas; la PK es por campaña).
   - `suggestPosts(tx, campaignId)`: candidatos por SQL (publicados
     entre `starts_on − 2` y `ends_on + 2`, no asociados aún) y el motivo
     en TypeScript en el mismo archivo, probado: mención al handle de la
     marca (`company.socials`, cualquier valor, con o sin `@`), nombre de
     la empresa en la caption o el título, o `tracking_code`. Sin fechas
     en la campaña no hay ventana y no hay sugerencias (no se inventa una).
   - `linkPost`, `unlinkPost`, `setPrimaryPost`: `campaign_post` no
     tiene `workspace_id` ni política RLS (0010); la FK a `campaign` no
     distingue workspaces. Antes de escribir se comprueba que la campaña
     y el post existan **en este workspace** (RLS los oculta si no), y
     todo `UPDATE`/`DELETE` sobre `campaign_post` va unido a `campaign`.
     `linkPost` es idempotente por la PK (`ON CONFLICT DO UPDATE` que
     conserva lo que no venga). Solo un post principal por campaña:
     marcar uno desmarca los demás.
   - `updateCampaign` (name, brief, startsOn, endsOn, trackingCode,
     trackingUrl; `null` limpia, `undefined` conserva) y
     `transitionCampaign(id, to)`, ambos con `FOR UPDATE` y la validación
     en core antes de escribir.
   - Errores tipados (`CampaignNotFoundError`, `PostNotFoundError`,
     `CampaignPostNotFoundError`, más `InvalidDatesError` e
     `InvalidCampaignTransition` de core), todos con `messageEs`, para
     que las Server Actions los muestren tal cual.
3. **Máquina de estados en core**, pura: `planned → live → measuring →
   reported → closed`; `cancelled` desde `planned` o `live`; nada sale
   de `closed` ni de `cancelled`. `CAMPAIGN_STATUS_META` da etiqueta y
   `kind` de pastilla en un solo sitio (`planned` neutral «Planeada»,
   `live` good «En curso», `measuring` warn «Midiendo», `reported` good
   «Reporte listo», `closed` neutral «Cerrada», `cancelled` bad
   «Cancelada»). `transitionCampaign()` devuelve también el
   `brandBaselineFrom` que hay que persistir: al pasar a `live`, si está
   vacío y hay `starts_on`, `starts_on − 14` (`BRAND_BASELINE_DAYS`,
   aritmética sobre `YYYY-MM-DD` con `addDays`, sin `Date` local). Las
   fechas se validan con `assertCampaignDates` (ISO y `endsOn ≥
   startsOn`), que CAM-2 reutiliza.
   **DECISIÓN PENDIENTE DE NICOLÁS:** una campaña `closed` o `cancelled`
   no admite asociar, quitar, marcar principal ni editar
   (`canEditCampaign`). Tomé la opción conservadora porque el reporte
   (CAM-6) se congela al cerrar; si prefieres permitirlo, es quitar una
   comprobación en `queries/campanas.ts`.
4. **Pantallas.**
   - `/campanas`: **sin fila de KPIs**. Los seis KPIs del mock
     (`kpis-camp`) están debajo del título «Café Alma · lanzamiento cold
     brew»: son el resultado de UNA campaña (`campaign_result`), que es
     CAM-5, no cifras de la lista. No invento otros. **DECISIÓN
     PENDIENTE DE NICOLÁS** si quieres que la lista los muestre igual
     leyendo `campaign_result`. Lo que hay: filtro por estado
     (`Segmented`, cliente, que escribe `?estado=` en la URL para que la
     página siga siendo Server Component), tabla Marca · Campaña ·
     Estado · Fechas · Posts · Views · Monto · Acción, con `DataAsOf` bajo
     las views y «—» (no cero) donde no hay snapshot, y `EmptyState`.
     Cuatro campañas, no tres: el seed 0003 trae también Hogar Lindo
     (`ca0004`, sin posts), y así la lista es la del mock.
   - `/campanas/[id]`: cabecera (nombre, marca, pastilla, fechas, monto,
     «Facturar» con `facturarCampana` o el enlace a la factura si ya
     existe); «Acordado antes de publicar» desde la cotización o
     `EmptyState` «Sin cotización: esta campaña se creó a mano»;
     entregables; seguimiento (código y enlace con botón copiar y
     edición inline); posts asociados con miniatura, red (`PlatformPill`
     con `--s-<red>`), fecha, views, reach, guardados, principal,
     entregable y quitar, con `DataAsOf`; «Asociar post» con pestañas
     Sugeridos (con motivo) y Buscar; transiciones como botones con
     confirmación; «Resultado» y «Seguidores de la marca» solo como
     `EmptyState` («Llega con la medición», sin cifras) para CAM-5 y
     CAM-3. Server Components por defecto; cliente en el copiador, el
     buscador, los formularios y el botón de confirmación. Nada de
     funciones de servidor como props salvo Server Actions (que sí
     cruzan la frontera).
   - `PlatformPill` entra al kit porque `Pill` no admite color por red y
     forzarlo con `className` dejaría el resultado a merced del orden de
     las utilidades de Tailwind.
5. **Server Actions** en `campanas/[id]/actions.ts`, con zod y mensajes
   en español: `asociarPost` (`useActionState`, errores por campo),
   `quitarPost`, `marcarPrincipal`, `cambiarEstadoCampana` (con `bind`, el
   error vuelve por `?error=` como en Finanzas), `editarCampana`
   (`useActionState`), `buscarPosts` (consulta para la pestaña Buscar).
   `revalidatePath` de la lista y de la ficha en cada escritura.

### 0.3 Dudas que resolví solo

- El prompt dice «tres campañas» y el seed trae cuatro; la lista y la
  prueba usan las cuatro del mock.
- `creator_post_board` no expone `captured_at`; se une
  `post_metrics_latest` para el «datos hasta» de cada post.
- `brand_accounts` del seed usa `{ platform, handle }`; CAM-1 no lo
  escribe ni lo lee. Lo resuelve CAM-2 (que sí lo escribe) y queda
  anotado allí.

---

## 1. Lo que necesito de ti (CIM-2, CIM-3, CIM-6)

### 1.1 CIM-2 · esquema Drizzle y cliente

`queries/campanas.ts` usa SQL con parámetros sobre `WorkspaceTx`
(la misma interfaz provisional de FIN-1: `{ workspaceId; query(text,
params) }`). Cuando exista `client.ts`, el cambio es la importación.
Tablas y vistas que toca, con las columnas tal como están (nada nuevo,
ninguna migración):

- `campaign`: todas. `amount` → **string** (`numeric`), `starts_on`,
  `ends_on`, `brand_baseline_from` → `'YYYY-MM-DD'` (no `Date`),
  `status` con el union de `CampaignStatus` (core), `utm` y
  `brand_accounts` como `jsonb`.
- `campaign_post` (**sin `workspace_id` ni RLS**: se lee siempre unida a
  `campaign` y se escribe después de comprobar campaña y post en el
  workspace; si en CIM-2 le agregas política vía `campaign`, mejor, y
  estas consultas siguen valiendo).
- `post` (`caption`, `title`, `hashtags`, `mentions`, `published_at`) y
  la vista `creator_post_board` (`pgView`, solo lectura) para los posts
  asociados y asociables; `post_metrics_latest` para `captured_at`
  («datos hasta») y la suma de views.
- `quote` (`number`, `status`, `agreed_metrics`, `report_cuts_hours`,
  `usage_rights_days`, `exclusivity_days`, `exclusivity_scope`,
  `payment_terms_days`) y `quote_item` (`deliverable`, `platform_id`,
  `description`, `quantity`, `position`) para «Acordado antes de
  publicar» y los entregables.
- `company` (`name`, `socials`) para la marca y la detección por
  mención; `invoice` (`id`, `number`, `status`, `total`, `currency`,
  `campaign_id`) para el panel de facturas.

`views`, `reach`, `saves`, `shares` son `bigint`: node-postgres los da
como string y pglite como number. Pido `::text` y convierto una sola vez
(`intOrNull`). Si Drizzle los expone con `{ mode: "number" }`, se quita
esa conversión.

### 1.2 CIM-3 · workspace de la sesión

`apps/web/lib/db/workspace.ts` es el único sitio que conoce el
workspace (antes `finanzas/_lib/workspace.ts`). Cuando `lib/workspace/`
exista, `lib/db/index.ts` lo importa de ahí y se borra ese archivo.
Nada más cambia: las consultas reciben el workspace dentro de la
transacción.

### 1.3 CIM-6 · seed 0002

- Los ids fijos de la sección 0 del seed 0003 (`docs/propuestas/CIM-8.md`
  §1) son los que usan las pruebas de `packages/db/test/campanas.test.ts`
  y `test/helpers/base.ts` (`POST_D01_REEL_CAFE_ALMA`…). Si 0002 usa
  otros, hay que cambiarlos ahí.
- **Forma de `company.socials`** para la detección por mención: un
  objeto `{ "<red>": "<handle sin @>" }` (`{"instagram": "cafealma",
  "tiktok": "cafealma.co"}` como en 0003). `handlesFromSocials()` toma
  cualquier valor de texto, con o sin `@`; si 0002 guarda URLs o
  objetos por red, hay que decírmelo para ampliar esa función.
- La detección también usa `post.mentions` (sin `@`) y `post.hashtags`;
  0002 debería llenarlos como los llenará el conector (CON-1).

## 2. Decisiones de dominio

1. **Estados.** `planned → live → measuring → reported → closed`;
   `cancelled` solo desde `planned` o `live`; nada sale de `closed` ni
   de `cancelled`. Etiqueta, color y verbo del botón en
   `CAMPAIGN_STATUS_META` (core), un solo sitio. Al pasar a `live`,
   `brand_baseline_from = starts_on − 14` si estaba vacío
   (`transitionCampaign` en core devuelve qué persistir; la consulta lo
   escribe). Una campaña `closed` o `cancelled` no admite asociar,
   quitar, marcar principal ni editar (**decisión pendiente de
   Nicolás**, ver §0.2.3).
2. **Aislamiento con `campaign_post`.** No tiene `workspace_id` ni
   política RLS (0010) y su FK a `campaign` no distingue workspaces.
   Regla en `queries/campanas.ts`: toda lectura va `FROM campaign c JOIN
   campaign_post cp`; toda escritura pasa antes por
   `lockEditableCampaign` (`SELECT … FROM campaign … FOR UPDATE`, que
   RLS deja vacío si la campaña es ajena) y, al asociar, por `SELECT 1
   FROM post WHERE id = $1` (RLS en `post`). La prueba negativa usa un
   segundo workspace fijado con su propia campaña: desde él, la campaña
   de Laura «no existe» y el post de Laura «no existe».
3. **Un solo post principal por campaña.** `is_primary` no tiene
   restricción en la base; `linkPost(isPrimary: true)` y
   `setPrimaryPost` desmarcan los demás en la misma transacción.
4. **Sugerencias.** Ventana `starts_on − 2` a `ends_on + 2` en SQL;
   motivo en TypeScript (`suggestionReasons`, core, probado): mención
   (`mentions`, `@handle` en la caption con frontera de palabra, o el
   handle como hashtag), código (`tracking_code` en el texto) y nombre
   de la empresa (sin tildes ni mayúsculas). Un post ya asociado no se
   sugiere. Sin fechas, lista vacía: no se inventa ventana.
5. **Sin KPIs en la lista.** Los del mock son `campaign_result` de Café
   Alma (CAM-5). Ver §0.2.4.
6. **Cuatro campañas.** El seed 0003 trae Hogar Lindo sin posts; la lista
   dice «0» posts (es un hecho) y «Sin datos» en views (no hay
   snapshot: no es un cero).
7. **Entregables.** Si hay cotización con ítems, salen de `quote_item`;
   si no, se agrupan los `deliverable` de `campaign_post`. La lista
   canónica (`DELIVERABLES` en core: reel, tiktok, historia, short,
   dedicado, integracion) sale del comentario de `rate_card_item` en
   0008 más el tarifario del mock; un valor fuera de la lista se muestra
   tal cual.

## 3. Verificación

- `pnpm --filter @mc/core test`: 33 pruebas de `campanas.ts` (56 en
  total con facturación y scoring).
- `pnpm --filter @mc/db test`: 13 pruebas de campañas en Postgres
  embebido con el seed 0003 (27 en total con finanzas): la lista da las
  cuatro campañas del mock (Café Alma 712 K con dos posts 412 K +
  300 K, Fresko 265 K, Nutrivé 58 K, Hogar Lindo sin datos); asociar a
  Fresko un post de Nutrivé y quitarlo; asociar dos veces no duplica;
  un post o una campaña de otro workspace no se pueden asociar; las
  sugerencias de Café Alma encuentran sus posts por mención y código y
  no los de Nutrivé; transiciones válidas e inválidas con la línea base
  fijada al iniciar; `updateCampaign` rechaza fin anterior a inicio;
  una campaña cerrada no admite cambios.
- `pnpm --filter @mc/web test`: 104 pruebas (19 nuevas: pills y
  filtros, copiador, formulario de asociar y su búsqueda, formularios
  de edición, `PlatformPill`). `typecheck`, `lint` y `build` en verde.
- En dev sin `DATABASE_URL` (modo demo): `/campanas` y
  `/campanas/00000003-0000-4000-8000-000000ca0001` responden 200 con el
  contenido esperado; las Server Actions se ejercitaron por HTTP con
  los campos ocultos de sus formularios (sin JavaScript): quitar el
  TikTok de Café Alma (303 y la ficha con un post), verlo aparecer en
  Sugeridos con «Menciona a @cafealma.co», asociarlo de nuevo como
  TikTok (la ficha vuelve a dos posts, 412.000 y 300.000 con «hasta el
  23 sep» y «hasta el 26 sep»), asociar el video de Nutrivé a Fresko
  como principal y quitarlo, Fresko a «Reporte listo» y a «Cerrada»
  (desaparecen Quitar y Asociar), editar el seguimiento con datos
  válidos e inválidos (los inválidos no escriben). Capturas con Chrome
  sin cabeza a 1440 px y, dentro de un iframe de 390 px (Chrome no baja
  de 500 px de ventana), sin desborde horizontal.

## 4. Pendiente de ti

- [ ] CIM-2: el esquema de §1.1. Yo cambio las importaciones.
- [ ] CIM-3: `lib/workspace/`. Yo borro `lib/db/workspace.ts`.
- [ ] CIM-6: ids fijos y forma de `company.socials` (§1.3).
- [ ] Opcional, en 0010 o en una migración nueva: política RLS para
      `campaign_post` vía `EXISTS (SELECT 1 FROM campaign …)`. Las
      consultas ya se protegen solas, pero la base quedaría cerrada
      también para quien escriba SQL a mano.

## 5. Revisión (/code-review, nivel alto)

Diez hallazgos; nueve resueltos en el commit «Revisión», uno justificado:

| Hallazgo | Qué se hizo |
|---|---|
| Buscar: un post recién asociado seguía en los resultados | La búsqueda se repite cuando la ficha se revalida (`initial` en las dependencias) |
| Buscar: una respuesta lenta pisaba a la nueva | Número de secuencia por búsqueda; una respuesta vieja se descarta |
| «Facturar» visible en campañas canceladas | Se oculta en `cancelled`; el panel de facturas lo dice |
| Fechas del formulario de datos sobrevivían a Cancelar | Viven en `DateFields`, que se desmonta con el formulario |
| La consulta de detalle corría cuatro veces por petición | `cache()` entre `generateMetadata` y la página; `suggestPosts` y `listLinkablePosts` comprueban la campaña con consultas ligeras; los agregados van en un `LEFT JOIN LATERAL` |
| `isPlatformId` con `in` aceptaba `constructor` | `Object.hasOwn` |
| `buscarPosts` no validaba el tipo de `q` | Se valida y se recorta |
| `UUID_RE`, `firstErrors` y el estado de acción duplicados | `apps/web/lib/forms.ts`; el esquema usa `isIsoDate` de core (rechaza 2026-02-30). Finanzas migra a `lib/forms` en su próxima historia (FIN-2), para no tocarlo en esta |
| `finanzas/_lib/db.ts` como reexport en vez de cambiar cuatro importaciones | **Se mantiene**: el prompt de CAM-1 lo pide así y evita tocar páginas de Finanzas en esta historia; se borra al llegar CIM-2 |
| Identificadores en español en la capa web | Componentes y hooks renombrados en inglés. Las Server Actions conservan el nombre en español (`asociarPost`, `editarCampana`…) por el precedente de FIN-1 (`crearFactura`, `facturarCampana`, que este módulo importa): son la «API» que ve la pantalla, en el idioma de la interfaz. **Decisión pendiente de Nicolás** si quiere unificar |

## 6. QA en producción (22 de septiembre de 2026, fa4a499)

Sobre https://on-cue-web.vercel.app, con Supabase como base (sin modo
demo).

**Rutas y respuestas.** `/campanas`, los seis filtros de estado y las
cuatro fichas del seed responden 200 entre 0,37 y 0,61 s; un id
inexistente o malformado y `/kit` responden 404; `/finanzas` y el
detalle de FV-2026-010 siguen en 200. `Cache-Control: private,
no-store` y `noindex, nofollow`, como corresponde a una app privada.

**Contenido.** La lista muestra las cuatro campañas con las cifras del
mock (Fresko 265.000, Café Alma 712.000, Nutrivé 58.000, Hogar Lindo
«Sin datos»), pastillas y fechas en es-CO; cada ficha muestra el
«Facturar» resuelto como enlace a su factura, lo acordado como
EmptyState honesto, entregables, seguimiento con copiar y edición,
posts con views y «datos hasta», transiciones según el estado (Nutrivé
cerrada: «no cambia de estado», sin Quitar ni Asociar) y las secciones de
CAM-3 y CAM-5 como EmptyState.

**Accesibilidad y rendimiento.** Lighthouse sobre la ficha de Café Alma:
rendimiento 98, accesibilidad 100, buenas prácticas 100, SEO 60 (solo
por el `noindex` intencional y el `no-store`). axe-core sobre el HTML de
lista y fichas: ninguna violación propia del módulo; la única marcada
(`landmark-unique`) es del shell, que pinta las dos barras de navegación
con `aria-label="Principal"` y la de escritorio va oculta por CSS: en
un navegador real no se da. Un `h1` por página, ningún `img` sin `alt`,
ningún botón sin nombre accesible, enlaces externos con `rel`.

**Escrituras.** No se ejercitaron contra producción (datos reales del
seed compartido). Se verificó por SQL de solo lectura que `mc_app` tiene
SELECT/INSERT/UPDATE/DELETE sobre `campaign`, `campaign_post`, `post`,
`quote`, `quote_item`, `invoice` y las vistas, y que las políticas RLS
existen donde se esperaba (`campaign`, `post`, `quote`, `invoice`; no en
`campaign_post` ni `quote_item`, que el código protege por sus joins).
Las mismas acciones se ejercitaron en dev por HTTP contra la base
embebida (§3).

**Hallazgos.**

| # | Qué | Gravedad | Dónde se resuelve |
|---|---|---|---|
| 1 | Los snapshots del seed 0003 tienen `captured_at` en el futuro (Fresko «datos hasta el 6 oct», Café Alma «26 sep») porque se fijaron a 30 días de la publicación. En una demo del 22 de septiembre desconcierta. | Baja · datos de demo | CIM-8 (seed, mío): fijar `captured_at` a una fecha pasada con su `age_hours` real. En Supabase hay que borrar las filas viejas porque la tabla es append-only y `post_metrics_latest` toma la más reciente. **Decisión de Nicolás.** |
| 2 | Vercel avisa en el build que `DATABASE_URL` no está declarada en `turbo.json` (`env`). En tiempo de ejecución sí llega (la app lee Supabase), pero el aviso es real y la caché de Turbo no la tiene en cuenta. | Baja | `turbo.json` es de CIM-1/CIM-7 (Rasheed): `"build": { "env": ["DATABASE_URL"] }`. |
| 3 | «Creada 22 de septiembre de 2026» en las cuatro campañas: es la fecha en que el seed insertó las filas, no la de la campaña. Es cierto, pero engaña en la demo. | Cosmética | Se puede quitar el dato del panel o cambiar la etiqueta a «Registrada». Decisión de Nicolás. |
| 4 | Migración 0015 pendiente en Supabase (última aplicada: 0014). | Media para CAM-2, nula para la web | `make db.migrate` (Nicolás). |

Ninguno de los cuatro rompe un criterio de terminado ni un punto de la
rúbrica del módulo.

## 7. Contraste con el plan: ¿queda el módulo listo para lo que sigue?

| Lo que sigue | Qué necesita de CAM-1/CAM-2 | Estado |
|---|---|---|
| COT-4 (Rasheed, sprint 4) | `createCampaignFromQuote()` con contrato escrito | Listo: firma, errores, garantías y guion de prueba conjunta en `CAM-2.md`. Falta aplicar 0015. |
| CAM-3 · Seguidores de la marca | `brand_baseline_from` fijado al iniciar, `brand_accounts` con una sola forma, sitio en la ficha | Listo: la transición a `live` lo fija, la forma es `[{ platform_id, handle }]` en seed y función, y la sección «Seguidores de la marca» ya existe como EmptyState con el handle y la fecha. Falta crear `apps/worker/src/jobs/campanas/` (§3.2 del backlog), que hoy no existe. |
| CAM-4 · Lo que aporta la marca | Un sitio en la ficha para canjes, pedidos y CSV | Parcial: la ficha no tiene sección para `campaign_brand_input`; CAM-4 la agrega junto a «Resultado». No hay nada que deshacer. |
| CAM-5 · Resultado | `campaign_result` y la sección «Resultado» | Listo el sitio (EmptyState con los seis KPIs nombrados); la lista sigue sin fila de KPIs a propósito (§0.2.4). |
| CAM-6 · Reporte | Lo acordado y los posts con sus cortes | Listo lo acordado (desde `quote`) y los posts con views actuales; los cortes a 7 y 30 días salen de `post_metrics_at_cut`, que la ficha aún no lee. |
| FIN-2 · Pagos | Nada de Campañas; `lib/forms.ts` para unificar validaciones | Listo. |
| CIM-2 / CIM-3 (Rasheed) | Reemplazo del cliente y del workspace provisionales | Un solo sitio (`lib/db/`), documentado en §1. |

Veredicto: el módulo cumple los dos «terminado cuando» del sprint 2 y
deja preparados los puntos de anclaje de CAM-3, CAM-5 y CAM-6; CAM-4
tendrá que abrir su propia sección. Lo único que bloquea a alguien es
la migración 0015 para COT-4, y es un comando de Nicolás.
