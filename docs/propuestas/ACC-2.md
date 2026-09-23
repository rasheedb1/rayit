# ACC-2 · Bitácora obligatoria — `audit()` en @mc/db

Escrito para: Rasheed, que revisa `packages/db/src/audit.ts` (archivo
nuevo junto a `queries/`) y decide sobre los privilegios de `audit_log`;
y quien revise el PR de ACC-2. Fecha: 23 de septiembre de 2026. Rama
`nicolas/ACC-2-bitacora-obligatoria`, sobre `origin/main` (29460e3).

---

## 0. Plan (escrito antes de tocar código)

### 0.1 Lo que se comprobó antes de diseñar

| Qué | Dónde | Resultado |
|---|---|---|
| `audit_log` existe con `id bigserial`, `workspace_id`, `actor_user_id → app_user`, `actor_kind` CHECK (`user`, `system`, `job`, `webhook`), `action`, `entity_type`, `entity_id uuid`, `before`/`after jsonb`, `ip inet`, `created_at` | `db/migrations/0001_base_tenancy.sql:152` | Sirve tal cual. `entity_id` es uuid: las entidades que audito (factura, campaña, conexión, consentimiento) tienen uuid. |
| RLS por workspace | `0010_views_rls.sql:242` (`audit_log` en la lista; política `audit_log_ws_isolation USING (workspace_id = current_workspace_id())`) | Una política solo con USING aplica también al INSERT (WITH CHECK hereda USING): insertar con `current_workspace_id()` pasa; con otro id, falla. |
| Privilegios de mc_app | `0025_referencias_visibles.sql:284` (`REVOKE UPDATE, DELETE ON audit_log FROM mc_app`), `0026` (USAGE sobre `audit_log_id_seq`) | SELECT + INSERT. La guardia lo exige: `src/esquema.ts:714` (`audit_log: { permite: ['SELECT', 'INSERT'] }`) y `test/rls.test.ts:1800` prueba que UPDATE y DELETE fallan. |
| mc_app ya inserta en `audit_log` | `test/rls.test.ts:2223` (`INSERT INTO audit_log (workspace_id, action, entity_type) VALUES (current_workspace_id(), …)`) | Funciona: **sin migración**. |
| Privilegios de mc_worker | `0014_worker_grants.sql:20` (`INSERT` sobre todas las tablas de `public`) | El worker puede escribir la bitácora con `workspace_id` explícito. |
| `current_user_id()` | `0019:45` (`nullif(current_setting('app.user_id', true), '')::uuid`); lo fija `withWorkspace(id, fn, identity)` (`client.ts` → `applyIdentity`) y la web lo pasa siempre que hay sesión (`lib/db/index.ts` → `getCurrentContext`) | El actor sale de la base, no de un parámetro. Sin sesión (copia de desarrollo sin llaves, pruebas) es NULL. |
| `redactSecrets` | `packages/connectors/src/redact.ts` | Tapa tokens, secretos, contraseñas, `authorization`, `apiKey` por nombre de llave y `OAuthTokens` por forma. **No** tapa `secret_ref` a propósito (es una referencia). ACC-2 exige que `secret_ref` tampoco llegue a la bitácora: hace falta una segunda lista, propia. |
| `dumpTextColumns` / `findSecretInDump` | `packages/connectors/src/testing/dump-text.ts`, exportados por el barril | Sirven tal cual sobre `tx.query` (RLS deja ver solo el workspace de la prueba, que es lo que se comprueba). |
| `@mc/db` no depende de `@mc/connectors`; `@mc/connectors` no depende de nada del workspace | `packages/*/package.json` | Agregar `@mc/connectors` a `@mc/db` no crea ciclo. Ver decisión 3. |
| Escrituras hoy en mis tres archivos de consultas | `queries/finanzas.ts`, `campanas.ts`, `conexiones.ts` | Listadas en 0.4. `createCampaign` (CAM-1) **no existe** como función: la campaña nace solo de una cotización (`createCampaignFromQuote`) o del seed. `removePublicAccount` tampoco: quitar una cuenta por @ es `disconnectConnection`. |
| Llamadores | `finanzas/facturas/actions.ts`, `campanas/[id]/actions.ts`, `conexiones/_lib/{oauth-handlers,cuentas-service}.ts`, `cotizar/actions.ts` (COT-4 → `createCampaignFromQuote`) | Todos abren `withWorkspace` de la web, que fija identidad. Ninguna Server Action cambia: la bitácora vive en la consulta. |
| Ninguna Server Action tiene `// TODO(ACC-2)` | `grep` en `apps/web/app` | Nada que sustituir. |

### 0.2 Archivos

| Qué | Dónde |
|---|---|
| `audit()` (web) y `auditAsJob()` (worker), tipos, lista de claves prohibidas, errores | `packages/db/src/audit.ts` (NUEVO) |
| Exportación por la raíz | `packages/db/src/index.ts` (`export { audit, auditAsJob, … } from './audit.ts'`) |
| Pruebas del contrato: misma transacción y rollback, actor web/sin sesión/job, redacción con `dumpTextColumns`, id no expuesto, aislamiento, sin UPDATE/DELETE | `packages/db/test/audit.test.ts` (NUEVO) |
| La prueba que hace cumplir la convención (estática) | `packages/db/test/audit-convencion.test.ts` (NUEVO) |
| Las escrituras que auditan | `packages/db/src/queries/{finanzas,campanas,conexiones}.ts` (un commit por archivo) |
| Las pruebas existentes comprueban la fila | `packages/db/test/{finanzas,campanas,conexiones,cuentas-publicas}.test.ts` |
| El camino real de la web (lib/db con identidad) deja la fila | `apps/web/lib/db/index.test.ts` (bloque nuevo) |
| Dependencia nueva de workspace | `packages/db/package.json`, `pnpm-lock.yaml` (importer `packages/db`) |
| README de @mc/db: uso 7, «Bitácora» | `packages/db/README.md` |
| Estado de la historia | `apps/web/content/backlog.ts` (solo ACC-2) |
| Esta propuesta | `docs/propuestas/ACC-2.md` |

No toco `client.ts`, `schema/`, `db/migrations/`, `lib/auth/`,
`lib/workspace/` ni las consultas de Rasheed (`ventas.ts`, `cotizar.ts`,
`resumen.ts`, `identidad.ts`, `cimientos.ts`): lo que deberían auditar
va en §3 de este documento.

### 0.3 Decisiones

1. **Firma: `audit(tx, entrada)` dentro de la transacción de la
   escritura, no un `withAudit(fn)` que la envuelva.**
   `audit(tx: WorkspaceTx, { action, entityType, entityId, before?,
   after? }): Promise<void>`. Se llama desde la función de consulta que
   escribe, con el mismo `tx`, después del INSERT/UPDATE y antes de
   devolver. Si la escritura hace rollback (una excepción después, una
   validación que falla, la transición que core rechaza), la bitácora
   se va con ella: es una fila más de la misma transacción.
   Descartado el `withAudit(session, accion, fn)` de la propuesta ACC
   (fase 6): (a) tendría que envolver a las consultas existentes, que
   ya reciben `tx` y devuelven un resultado, y cambiar la firma de once
   funciones que llaman cuatro módulos —COT-4 incluido, que es de
   Rasheed—; (b) el `before` real solo lo conoce la función que hace el
   `SELECT … FOR UPDATE` (estado anterior de la factura, de la campaña),
   y un wrapper genérico tendría que volver a leer la fila o
   conformarse con no tenerlo; (c) un wrapper anota UNA acción por
   llamada, y `disconnectConnection` o `upsertConnection` deciden el
   evento (`added` vs `reconnected`) con lo que la base devuelve
   (`xmax = 0`); (d) con la bitácora dentro de la consulta, quien la
   llame audita igual sin saberlo —hoy COT-4, mañana un job—, que es lo
   que la hace obligatoria de verdad. La convención se hace cumplir con
   la prueba estática de la decisión 5, no con el tipo.
2. **Actor.** Desde la web, `actor_user_id = current_user_id()` y
   `actor_kind = 'user'`, resueltos **en SQL** dentro del INSERT: es lo
   que fijó `withWorkspace(…, identity)` y nada que venga por parámetro
   puede cambiarlo. Si `current_user_id()` es NULL (copia de desarrollo
   sin llaves con `DEMO_WORKSPACE_ID`, pruebas sin identidad), la fila
   queda con `actor_user_id NULL` y `actor_kind = 'system'`: decir
   `'user'` sin saber cuál sería mentir en la bitácora, y con Supabase
   Auth configurado la web nunca abre una transacción sin identidad
   (`lib/workspace/current.ts` manda a `/login`). Desde el worker,
   `auditAsJob(exec, { workspaceId, job: { id, runId }, …entrada })`:
   `actor_kind = 'job'`, `actor_user_id NULL`, `workspace_id` explícito
   (mc_worker salta RLS, regla del worker), y el job va en
   `after._job = { id: 'collect.account_metrics', runId }`. `runId` es
   el bigserial de `job_run`: queda DENTRO de la base, en jsonb, y no
   lo devuelve ninguna consulta a la web (CIM-2 §3). `'delegate'` y
   `on_behalf_of_workspace_id` son de ACC-3/AGE-2 y no se tocan. `ip` no
   se escribe: una IP es PII y la evidencia de consentimiento ya la
   guarda donde toca (`data_consent.evidence`).
3. **Redacción: dos capas, ambas obligatorias, antes de serializar.**
   Primero `redactSecrets` de `@mc/connectors` (tokens, secretos,
   contraseñas, `authorization`, `apiKey`, `OAuthTokens` por forma).
   Después la lista propia de ACC-2, `CLAVES_PROHIBIDAS_EN_BITACORA`,
   que **elimina** la clave (no la sustituye: una bitácora no necesita
   saber que el campo existía) a cualquier profundidad, comparando el
   nombre en minúsculas y sin `_`/`-`: `secretref`, `email`, `emails`,
   `phone`, `telefono`, `whatsapp`, `ip`, `useragent`, `evidence`,
   `raw`, `cookie`, `sessionid`, `authuserid`. Por qué eliminar y no
   tapar: `redactSecrets` deja `secret_ref` a propósito (para depurar
   el almacén), y ACC-2 dice que en `audit_log` no va ni la referencia;
   los correos y teléfonos de terceros son PII de `contact`; `evidence`
   y `raw` son los dos jsonb que traen IP, user agent y la respuesta
   cruda de una API. La prueba lo demuestra con `dumpTextColumns` sobre
   `audit_log` (precedente `dump-text.ts` de CON-3). Y la tercera capa
   es de diseño: cada llamada construye `before`/`after` **a mano** con
   los campos permitidos de SU entidad —nunca `...row`—, así que un
   monto de otra entidad no entra porque nadie lo pone. Para reutilizar
   `redactSecrets` sin copiarlo, `@mc/db` pasa a depender de
   `@mc/connectors` (`workspace:*`, cero bytes nuevos en
   `node_modules`, sin ciclo: connectors no depende de nada del
   workspace). Descartado copiar la lista de llaves a `@mc/db` (dos
   listas divergen; el prompt pide reutilizar) y moverla a `@mc/core`
   (`redact.ts` depende de `looksLikeOAuthTokens` de connectors y
   tocaría un paquete de dueño por archivo). **DECISIÓN PENDIENTE DE
   NICOLÁS:** confirmar la dependencia `@mc/db → @mc/connectors`; si
   no, la alternativa es mover `redact.ts` + `looksLikeOAuthTokens` a
   `@mc/core/src/redactar.ts` y reexportarlos desde connectors (un
   commit, sin cambio de comportamiento).
4. **Forma de `action`:** `<entidad>.<evento>`, minúsculas y guion
   bajo, validada con `/^[a-z][a-z_]*\.[a-z][a-z_]*$/`; otra cosa lanza
   `InvalidAuditActionError` antes de tocar la base. `entity_type` es
   el nombre de la tabla (`invoice`, `campaign`, `social_connection`,
   `data_consent`). Los nombres quedan en `AUDIT_ACTIONS` (constante
   tipada en `audit.ts`) para que dos módulos no inventen dos formas del
   mismo evento y para que la pantalla de bitácora (fase 2) tenga una
   lista cerrada que etiquetar en español.
5. **La prueba que hace cumplir la convención** (`audit-convencion.test.ts`):
   lee `queries/{finanzas,campanas,conexiones}.ts`, parte el fuente por
   declaración de función (exportada o no: un helper privado que
   escribe también cuenta), y para cada función cuyo cuerpo contiene
   `INSERT INTO`, `UPDATE <tabla> SET`, `DELETE FROM` o
   `tx.db.insert|update|delete(` exige que contenga `audit(` o
   `auditAsJob(`, salvo que esté en `SIN_BITACORA_DECLARADAS` con su
   motivo (el patrón de `EXCEPCIONES_SIN_AISLAMIENTO`). Una función que
   sobre en esa lista también falla. Es una prueba de texto, no de
   tipos, a propósito: un `audit` olvidado no es un error de compilación.
   Más la prueba dinámica: crear una factura y agregar una cuenta por @
   dejan su fila con actor, `before null` y `after` solo con los campos
   permitidos (`deepEqual` contra el objeto esperado).

### 0.4 Qué escrituras auditan hoy, y con qué acción

| Función | Acción | `entity_type` / `entity_id` | `before` | `after` |
|---|---|---|---|---|
| `createInvoice` (y por ella `createInvoiceFromCampaign`) | `invoice.created` | `invoice` / id | null | number, companyId, campaignId, quoteId, currency, subtotal, tax, withholding, total, issuedOn, dueOn, status, externalRef |
| `transitionInvoice` | por destino: `sent → invoice.sent`, `partial → invoice.payment_recorded`, `paid → invoice.paid`, `void → invoice.voided`, `draft → invoice.reopened`, `overdue → invoice.marked_overdue` | `invoice` / id | status, paidAmount | status, paidAmount, paidAt |
| `linkPost` | `campaign.post_linked` | `campaign` / campaignId | null | postId, deliverable, isPrimary |
| `unlinkPost` (solo si quitó algo) | `campaign.post_unlinked` | `campaign` / campaignId | postId | null |
| `setPrimaryPost` | `campaign.primary_post_set` | `campaign` / campaignId | null | postId |
| `updateCampaign` | `campaign.updated` | `campaign` / id | name, brief, startsOn, endsOn, trackingCode, trackingUrl (lo anterior) | los mismos, después |
| `transitionCampaign` | `campaign.status_changed` | `campaign` / id | status, brandBaselineFrom | status, brandBaselineFrom |
| `createCampaignFromQuote` (solo si creó) | `campaign.created` | `campaign` / id | null | quoteId, companyId, creatorId, dealId, name, amount, currency, startsOn, endsOn, status |
| `upsertConnection` | `connection.added` si la fila es nueva, `connection.reconnected` si se reactivó | `social_connection` / id | null | platformId, externalAccountId, handle, accountType, accessMode, scopes, accessExpiresAt |
| `recordConsent` | `consent.recorded` | `data_consent` / id | null | connectionId, purpose, policyVersion |
| `disconnectConnection` | `connection.disconnected` | `social_connection` / id | status | status |
| `addPublicAccount` | `connection.added` / `connection.reconnected` | `social_connection` / id | null | platformId, externalAccountId, handle, accountType, accessMode |
| `upgradePublicAccountToOAuth` | `connection.authorized` | `social_connection` / id | accessMode | accessMode, externalAccountId, handle, scopes, accessExpiresAt |

Y las que vengan: FIN-2 (`invoice.payment_recorded`, `payment.*`), FIN-5,
FIN-8, CAM-4, CAM-6 (`campaign.report_sent`).

**Qué no audita, declarado en `SIN_BITACORA_DECLARADAS` con motivo:**

- `recordAccountSnapshot`: métrica append-only; la tabla es su propia
  bitácora (0025 §5: mc_app ni la corrige ni la borra). El UPDATE de
  `last_synced_at` que la acompaña es frescura del dato, no un hecho
  del negocio.
- `markAccountLookupFailure`: salud técnica de la lectura pública
  (`consecutive_failures`, `status_detail`, `status = 'error'` si es
  definitivo). Lo mismo que anota el recolector como `mc_worker` sin
  bitácora; el estado visible sale de `connection_health`.
- Lecturas y `getDefaultCreatorId`: no escriben.

### 0.5 Dudas que resolví solo

- **Sin sesión, `'system'` y no `'user'`** (decisión 2). Si Rasheed
  prefiere `'user'` con id nulo, es cambiar un `CASE` en el INSERT.
- **`unlinkPost` devuelve `false` si no había nada** y en ese caso no
  audita: no hubo escritura. `createCampaignFromQuote` con
  `created: false` tampoco: devuelve la campaña existente sin tocar
  nada.
- **`upsertConnection` guarda `scopes`**: son los permisos que el
  creador otorgó, no un secreto, y son exactamente lo que una bitácora
  de cuenta conectada debe recordar.
- **El brief de la campaña** entra en `campaign.updated` (antes y
  después): es texto del propio workspace sobre su propia campaña, no
  PII de un tercero; sin él, «qué cambió» no se puede responder.
- **El worker no audita todavía** ninguna escritura: hoy el único job
  que cambia una cuenta conectada es `oauth.refresh` (renueva tokens y
  marca `needs_reauth`) y `collect.account_metrics` (métricas). Renovar
  un token no es un hecho del negocio; `needs_reauth` sí es un cambio
  visible de la cuenta, pero lo decide una API externa, no una persona,
  y `connection_health` + la notificación ya lo cuentan. Queda
  `auditAsJob` listo y probado para CON-5/CON-6 y para el día que un job
  publique o cobre. Si Nicolás quiere `connection.needs_reauth` desde el
  worker, es una llamada en `markNeedsReauth` de `oauth-refresh.ts`.

---

## 1. La firma

```ts
import { audit, auditAsJob, AUDIT_ACTIONS, type AuditAction, type AuditEntry } from '@mc/db';

interface AuditEntry {
  action: AuditAction;                       // '<entidad>.<evento>', lista cerrada
  entityType: string;                        // la tabla: 'invoice', 'campaign', 'social_connection', 'data_consent'
  entityId: string | null;                   // uuid de la fila
  before?: Record<string, unknown> | null;   // solo lo que cambia, de ESTA entidad
  after?: Record<string, unknown> | null;
}

audit(tx: WorkspaceTx, entry: AuditEntry): Promise<void>;   // web: actor desde current_user_id()
auditAsJob(exec: { query(text, params?) }, entry: AuditEntry & {
  workspaceId: string;                       // explícito: mc_worker salta RLS
  job: { id: string; runId: number };        // va en after._job
}): Promise<void>;                            // worker: actor_kind 'job', actor_user_id null
```

- Se llama **dentro** de la función de consulta que escribe, con el
  mismo `tx`, después del INSERT/UPDATE y antes de devolver. Nunca
  desde la Server Action.
- No devuelve nada. No hay función que lea la bitácora.
- `before`/`after` pasan por `sanitizeForAudit` (redacción, §0.3.3) y
  se guardan como `jsonb`; un `before` omitido es SQL `NULL`.
- Una acción fuera de `AUDIT_ACTIONS` lanza `InvalidAuditActionError`
  antes de tocar la base, aunque llegue con un cast.
- Contrato completo con ejemplo: `packages/db/README.md`, uso 7.

## 2. Lo que necesito de ti (Rasheed)

### 2.1 Revisar `packages/db/src/audit.ts`

La propuesta ACC (fase 6) daba `withAudit` a tu columna de §3.1. Lo
escribí yo como archivo NUEVO junto a `queries/` —no toca `client.ts`
ni `schema/`— con la firma `audit(tx, entrada)` en vez del wrapper
(§0.3.1 explica por qué). **DECISIÓN PENDIENTE DE NICOLÁS / a
confirmar contigo**: si prefieres que el archivo pase a tu columna en
§3.1, es una línea en el backlog; el código no cambia.

### 2.2 Privilegios de `audit_log`: nada que aplicar

Ya están bien y la guardia los exige:

| Rol | Tiene | Dónde |
|---|---|---|
| `mc_app` | SELECT + INSERT; sin UPDATE ni DELETE; USAGE sobre `audit_log_id_seq` (sin SELECT: `last_value` es volumen de toda la plataforma) | 0025 §5, 0026 §4; `src/esquema.ts` `PRIVILEGIOS_DE_LA_APP.audit_log` |
| `mc_worker` | SELECT/INSERT/UPDATE/DELETE por 0014 (BYPASSRLS) | `auditAsJob` solo INSERT; que el worker pueda editar la bitácora es lo mismo que pueda editar cualquier tabla: no es un privilegio nuevo |
| RLS | `audit_log_ws_isolation USING (workspace_id = current_workspace_id())` aplica a INSERT (WITH CHECK hereda USING) | 0010 |

Sin migración en esta historia. Lo comprobé antes de diseñar (§0.1) y
`test/audit.test.ts` («mc_app no corrige ni borra la bitácora») lo
prueba además de `rls.test.ts:1800`.

### 2.3 Lo que sí cambia después, y en qué historia

| Qué | Historia | Nota |
|---|---|---|
| `audit_log.id` bigserial → uuid | **CIM-11** (tuya) | Mientras tanto ninguna consulta lo devuelve; `audit()` no devuelve nada y `auditAsJob` guarda `job_run.id` dentro de `after._job` (no sale de la base). Cuando `job_run.id` pase a uuid, `runId` pasa a `string`: un cambio de tipo en `JobAuditEntry`. |
| `actor_kind` + `'delegate'`, `on_behalf_of_workspace_id` | **ACC-3** (SQL mío, revisión tuya), **AGE-2** | `audit()` no los toca; cuando existan, la sesión delegada los fija en SQL igual que hoy `current_user_id()`. |
| Pantalla de bitácora («qué hizo mi mánager») | **AGE-2** / fase 2 | Necesita etiquetas en español por acción: la lista cerrada `AUDIT_ACTIONS` está pensada para eso. |
| `ip` en `audit_log` | no se escribe | PII; la evidencia de consentimiento ya la guarda `data_consent.evidence`. Si un día hace falta, es una decisión de §7 del backlog. |

## 3. Tus escrituras que deberían auditar (cuando adoptes la convención)

`audit()` está en `@mc/db` y `test/audit-convencion.test.ts` acepta
archivos nuevos en `ARCHIVOS`. Por el criterio de ACC-2 —dinero,
publicación o cuenta conectada— estas son las tuyas, con la acción que
propongo (se agregan a `AUDIT_ACTIONS`):

| Archivo | Función | Acción propuesta | `after` (sin PII: sin correos ni teléfonos de contactos) |
|---|---|---|---|
| `queries/ventas.ts` | marcar un deal como ganado / perdido | `deal.won`, `deal.lost` | stageId anterior y nuevo, amount, currency, motivo |
| `queries/ventas.ts` | cambio de etapa | `deal.stage_changed` | stageId anterior y nuevo |
| `queries/cotizar.ts` | `sendQuote` | `quote.sent` | number, total, currency |
| `queries/cotizar.ts` | aceptar (`acceptPublicQuote`, `completePublicAcceptance`) | `quote.accepted` | number, total, currency, acceptedByName (**sin** el correo de quien aceptó) |
| `queries/cotizar.ts` | media kit publicado / bloqueado / enlace | `media_kit.published`, `media_kit.unpublished`, `media_kit.share_updated` | slug, isPublic, expiresAt (**sin** la contraseña ni su hash) |
| `queries/resumen.ts` | importar CSV de Insights (RES-2) | no: métricas append-only | — |

Las tres funciones SECURITY DEFINER de 0030 corren como
`mc_public_share` **sin workspace en la transacción**: ahí `audit()`
no sirve tal cual (`current_workspace_id()` es NULL y RLS rechazaría el
INSERT). Para `quote.accepted` desde el enlace, la fila la tendría que
dejar la propia función SECURITY DEFINER (con el `workspace_id` de la
cotización) o la Server Action de aceptación que corre después con
workspace. Lo decides tú al adoptarla; te recomiendo la función, porque
es la única que sabe que la aceptación ocurrió.
