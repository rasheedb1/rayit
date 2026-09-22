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
| Ficha | `apps/web/app/(app)/campanas/[id]/page.tsx`, `actions.ts`, `copiar.tsx`, `seguimiento-form.tsx`, `datos-form.tsx`, `asociar.tsx`, `transicion.tsx` (cliente los últimos cinco) | nuevo |
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
