# ACC-8 · Consentimiento delegado — plan y lo que necesita Rasheed

Escrito para: Rasheed (dueño de `db/migrations/`, `packages/db/src/schema`,
`lib/auth/` y `lib/workspace/`) y quien revise el PR de ACC-8.
Fecha: 23 de septiembre de 2026. Rama `nicolas/ACC-8-consentimiento-delegado`,
worktree `rayit-acc8`, creada desde `origin/main` (`29460e3`).

---

## 0. Plan (fase 1)

### 0.1 El punto de partida, y lo que NO está en main

ACC-8 se escribió suponiendo ACC-1 (`requirePermission`), ACC-2
(`withAudit`), ACC-3 (migración de roles) y ACC-5 (`getPermisosSesion`).
El 23 de septiembre **ninguna de las cuatro está en `main`** (las ramas
locales `nicolas/ACC-1-…`, `ACC-2-…` y `ACC-3-…` existen, sin commits).
La regla del repositorio para ese caso es explícita: `// TODO(ACC-1)` y
`// TODO(ACC-2)` donde irían la llamada real, y nada a medias. Así que
ACC-8 se construye sobre lo que sí hay:

| Necesita | Hay en main | Cómo se puentea |
|---|---|---|
| Quién actúa | `app.user_id` fijado por la sesión (CIM-3); `current_user_id()` (0019) | `getSessionMember(tx)`: la fila de `app_user` + `membership` del workspace actual para `current_user_id()` |
| Su rol | `membership.role` de 0001: `owner`, `admin`, `member`, `viewer`, `client` | `roleKey = membership.role` hasta que ACC-3 lo convierta en `role.key` |
| El permiso `conexiones.cuenta.conectar` | nada | tabla mínima en `conexiones/_lib/permisos.ts` (`owner`, `admin` → conectar y desconectar; el resto no), marcada `TODO(ACC-1)`; **el nombre del permiso ya es el del catálogo** |
| La bitácora | `audit_log` de 0001 (mc_app tiene INSERT; 0025 le quitó UPDATE/DELETE) | `recordConnectionAudit(tx, …)` en `queries/conexiones.ts`, marcada `TODO(ACC-2)`: cuando llegue `withAudit()` se reemplaza la llamada, no el dato |
| El titular | `creator_profile.user_id` (0001) | `getConsentCreator(tx)`: el perfil del workspace con su `user_id`. Cierra el `TODO(CIM-3)` de `getDefaultCreatorId` |
| El aviso | `notification` (0009) sin ningún `kind` para «cuenta conectada» | migración **0034** que amplía el CHECK con `connection_added` (precedente 0030) |

El «Mánager con la casilla de ACC-4» no existe todavía como rol. En las
pruebas y en el seed lo representa una membresía `admin`; el «Editor
sin permiso», una `viewer`. Cuando ACC-3 y ACC-4 lleguen, la tabla de
`permisos.ts` desaparece y `roleKey` pasa a ser `manager`/`editor` sin
tocar la evidencia (es un `text` libre dentro del jsonb).

### 0.2 Qué se construye y dónde

```
db/migrations/0034_notification_connection_added.sql
                                    CHECK de notification.kind + 'connection_added'. Re-ejecutable.
db/seed/0003_demo_finanzas_campanas.sql (mío)
                                    + Andrés Pardo (mánager, membership admin), un data_consent v2 con
                                      actedBy sobre la cuenta de Instagram del seed y su notification,
                                      para VER la fila «Conectada por …» en dev con el seed (fase 3).

packages/db/src/queries/conexiones.ts
  getSessionMember(tx)              { userId, email, name, role } | null de current_user_id()
  getConsentCreator(tx)             { id, userId, displayName } del creator_profile del workspace
  recordConsent(tx, …)              sin cambios de firma; la evidencia v2 la arma la web
  disconnectConnection(tx, id, rev) + evidencia de la revocación (evidence.revocation)
  notifyConnectionAdded(tx, …)      kind connection_added al titular; sin duplicar un aviso sin leer
  recordConnectionAudit(tx, …)      audit_log connection.added / connection.removed  (TODO(ACC-2))
  listAccounts(tx)                  + connectedBy { userId, name, email, at } | null (de la evidencia)
packages/db/test/conexiones-delegado.test.ts
                                    pglite: mánager, titular, editor, otro workspace, revocación

apps/web/app/(app)/conexiones/
  _lib/consent.ts                   evidencia v2: buildConsentEvidence(), ipHash(), tipos
  _lib/permisos.ts                  requireConexionesPermission(tx, 'conectar'|'desconectar')  (TODO(ACC-1))
  _lib/messages.ts                  textos nuevos: aviso al titular, «Conectada por», sin permiso
  _lib/cuentas-service.ts           agregar/quitar con actor, evidencia v2, aviso y bitácora
  _lib/oauth-handlers.ts            start comprueba el permiso; callback deja la misma evidencia v2
  _lib/cuentas-service.test.ts      + mánager / titular / editor / dump-text
  _lib/oauth-handlers.test.ts       + callback con identidad de mánager
  actions.ts                        // TODO(ACC-1) en cada Server Action; código sin_permiso
  page.tsx                          «Conectada por <nombre> el <fecha>» con formatterFor
apps/web/README.md                  §Conexiones: consentimiento delegado
apps/web/content/backlog.ts         entrada ACC-8
docs/propuestas/ACC-8.md            este archivo
```

### 0.3 Decisiones

**(1) Evidencia v2.** Un solo objeto para los dos caminos:

```jsonc
{
  "v": 2,
  "method": "public_handle" | "oauth",
  "declaredOwner": true,            // solo por @: la casilla; en OAuth es false (lo prueba la plataforma)
  "ipHash": "sha256 hex" | null,    // antes iba la IP en claro (v1); v2 no guarda PII de red
  "userAgent": "…" | null,
  "textShown": "…", "policyVersion": "2026-09-22", "at": "ISO",
  "onBehalfOf": { "creatorId": "<creator_profile.id>" },
  "actedBy": { "userId": "…", "email": "…", "roleKey": "admin" },   // se OMITE si actúa el titular
  // extras que ya llevaba v1 y siguen: handle, platformId, source | scopesRequested, scopesGranted
}
```

- `actedBy` se omite cuando `current_user_id() = creator_profile.user_id`
  (el titular actúa por sí mismo) y también en modo demo sin sesión
  (no hay nadie que nombrar; queda escrito en la evidencia como
  ausencia, no como cero). `onBehalfOf` va siempre: es la respuesta a
  «¿de quién son los datos?».
- **Descartado**: una columna `acted_by_user_id` en `data_consent`. El
  prompt lo excluye, y la evidencia tiene que ser un registro completo
  y autónomo (si mañana el mánager deja de ser miembro, su correo y rol
  de ese día siguen en la fila).
- **Descartado**: guardar el nombre del actor en la evidencia. El
  nombre cambia; el `userId` no. La pantalla lo resuelve al leer
  (`app_user` es visible para los miembros del workspace, 0020) y cae
  al correo si la persona ya no es miembro.
- `ipHash` es `sha256(ip)` en hex. Sin sal: una sal por despliegue
  haría la evidencia inverificable cuando rote. Es un compromiso: sirve
  para confirmar una IP conocida, no oculta una IPv4 ante fuerza bruta.
  **DECISIÓN PENDIENTE DE NICOLÁS**: si prefiere la IP en claro (v1)
  como evidencia de habeas data, es cambiar una línea en `consent.ts`.

**(2) Aviso al titular.** `notification` con `user_id =
creator_profile.user_id`, `kind = 'connection_added'`, `severity
'info'`, `entity_type 'social_connection'`, `entity_id` la conexión,
`action_url '/conexiones'`. Título y cuerpo los arma la web
(`messages.ts`) con red, @, quién (nombre, o correo si no lo puso) y cuándo
(`formatterFor(settings).dateTime`); `@mc/db` no escribe frases
(precedente `TextosCotizar`). No se crea si el titular no tiene
`app_user` (`user_id` NULL): el servicio lo devuelve como
`aviso: 'sin_titular'` y queda en la bitácora. No se duplica si ya
hay uno sin leer para la misma conexión y persona (idempotencia de
«Agregar» repetido; patrón `notifyMediaKitLocked`).

- **Descartado**: correo. Es fase 2 (fuera de alcance del prompt).
- **Descartado**: un `kind` genérico reutilizado (`connection_error`).
  Cambiaría el significado de un valor que el worker ya usa.

**(3) Bitácora.** `connection.added` y `connection.removed` en
`audit_log` con `actor_user_id = current_user_id()`, `actor_kind
'user'`, `entity_type 'social_connection'`, `after = { connectionId,
platformId, handle, accessMode, onBehalfOf, actedBy?: { userId, roleKey } }`.
Sin correo ni IP en `after` (regla de PII de la bitácora). Se escribe
desde `queries/conexiones.ts` con `TODO(ACC-2)`; `withAudit()` la
reemplazará. `actor_kind 'delegate'` y `on_behalf_of_workspace_id` son
de ACC-3 (AGE-2): aquí el mánager actúa DENTRO del workspace del
creador, así que `after.onBehalfOf` basta.

**(4) Desconectar por un tercero.** `disconnectConnection` recibe la
revocación y la anexa a cada consentimiento que revoca:
`evidence = evidence || { revocation: { at, actedBy?, onBehalfOf } }`.
La evidencia del otorgamiento no se toca. Bitácora
`connection.removed`. Sin aviso al titular (el prompt no lo pide; queda
en «fuera de alcance» con ACC-8 fase 2, y sería otro `kind`).

**(5) El rol se lee de la sesión.** `getSessionMember(tx)` dentro de la
misma transacción: `app_user` por `current_user_id()` y `membership`
del `current_workspace_id()`. Nada viene del navegador. Es lo que
`getPermisosSesion` (ACC-5) hará con la tabla `role`; hasta entonces el
rol es `membership.role`.

**(6) Dónde se comprueba el permiso.** Como PRIMERA sentencia de cada
transacción que escribe (`requireConexionesPermission(tx, 'conectar')`),
y además antes de la llamada HTTP en `agregar` (una transacción corta:
un editor sin permiso no gasta cuota de Instagram) y en `start` de
OAuth (no se manda a la plataforma a quien no puede volver). Sin
identidad (copia sin llaves, modo demo) no hay a quién negarle nada y
se deja pasar sin actor: es el mismo atajo de desarrollo de
`lib/workspace/current.ts`, y con Supabase Auth configurado nunca se
llega sin sesión (falla cerrado).

**(7) Número de la migración.** `git fetch` el 23 de septiembre: la más
alta en TODAS las ramas (remotas y locales) es
`0033_una_aceptada_por_negocio.sql`. La nueva es **0034**. `0023` no se
recicla. **Riesgo**: ACC-3 corre en paralelo y podría tomar 0034; si
pasa, esta se renumera (es una sola sentencia sin dependencias).

**(8) Seed.** Se agrega a `0003` (mío) un mánager de la demo con
membresía `admin` y un consentimiento v2 sobre la cuenta de Instagram
del seed, con su aviso. Es lo que hace visible la fase 3 en dev sin
sesión. Ids fijos, `ON CONFLICT DO NOTHING` (el verificador de seeds
exige idempotencia). **DECISIÓN PENDIENTE DE NICOLÁS**: si no quiere
al mánager en la demo pública, se quita el bloque y la fase 3 se
verifica solo con la prueba automática.

### 0.4 Dudas

- `NOTIFICATION_KINDS` en `packages/db/src/schema/cimientos.ts` (de
  Rasheed) no lleva `connection_added`. No lo toca esta rama: mis
  INSERT van por SQL. Va en §1 para Rasheed.
- Si ACC-2 define `after` con otra forma, `recordConnectionAudit` se
  adapta; los nombres `connection.added` / `connection.removed` son
  los que el backlog nombra desde ACC-2.

---

## 1. Lo que necesita Rasheed

### 1.1 Migración 0034 (revisar y aplicar; `make db.migrate` lo corre Nicolás o Rasheed, nunca esta rama)

`platform/db/migrations/0034_notification_connection_added.sql`: una
sola sentencia, re-ejecutable, que amplía el CHECK de
`notification.kind` con `connection_added`. Pasa `make db.check`; la
guardia contra Supabase (`make db.guardia`, solo lectura) reporta
exactamente «falta 0034», que es lo esperado. Si ACC-3 tomó también el
0034, esta se renumera sin más.

### 1.2 Esquema Drizzle (`packages/db/src/schema/cimientos.ts`, de Rasheed)

Añadir `'connection_added'` a `NOTIFICATION_KINDS`, con su comentario
(`// 0034 (ACC-8): un tercero conectó una cuenta en nombre del titular`).
Esta rama no lo toca: los INSERT de `notifyConnectionAdded` van por SQL
y no dependen del enum de TypeScript.

### 1.3 Seed (para leerlo, no para hacer nada)

`db/seed/0003` (mío) trae ahora a **Andrés Pardo** (`app_user`
`…000000000004`, `andres@ejemplo.com`), mánager de la demo con
`membership 'admin'`, un `data_consent` v2 con `actedBy` sobre la
cuenta de Instagram del seed (`…0000000000c1`) y un `notification`
`connection_added` sin leer para Laura. Ids fijos, `ON CONFLICT DO
NOTHING`. Si el seed se aplica en Supabase, 0034 tiene que ir antes
(el CHECK). Si no queremos al mánager en la demo pública, se quita el
bloque entero (está delimitado con su cabecera).

### 1.4 Lo que ACC-1, ACC-3, ACC-4 y ACC-5 heredan de aquí

- **Nombres de permiso ya en uso**: `conexiones.cuenta.conectar` y
  `conexiones.cuenta.desconectar` (`apps/web/app/(app)/conexiones/_lib/permisos.ts`).
  Cuando `requirePermission` exista, cada `// TODO(ACC-1)` de
  `actions.ts`, `cuentas-service.ts` y `oauth-handlers.ts` se
  reemplaza por esa llamada y `permisos.ts` se reduce a reexportarla.
- **La casilla de ACC-4** («también puede conectar mis cuentas»)
  otorga exactamente `conexiones.cuenta.conectar` y
  `conexiones.cuenta.desconectar` al mánager. Sin ella, el rol
  «Mánager» de fábrica no los trae (decisión E). Hasta ACC-3, el puente
  es `membership.role IN ('owner','admin')`.
- **`roleKey` en la evidencia** es `membership.role` hoy y `role.key`
  con ACC-3; el campo no cambia de nombre ni de forma.
- **ACC-2**: `recordConnectionAudit` (`queries/conexiones.ts`) escribe
  `connection.added` / `connection.removed` con `after = { connectionId,
  platformId, handle, accessMode, onBehalfOf, actedBy? }`. Cuando
  `withAudit()` exista, se reemplaza la llamada; la forma de `after` es
  la que las pruebas ya comprueban.
- **AGE-2** (sesión delegada entre workspaces) hereda el modelo entero:
  el actor sigue siendo `current_user_id()` y el titular
  `creator_profile`; lo que cambia es que `audit_log` pasa a llevar
  `actor_kind 'delegate'` y `on_behalf_of_workspace_id` (ACC-3), y la
  evidencia puede sumar `actedBy.workspaceId`. Nada de lo de aquí se
  reescribe.

### 1.5 Fuera de alcance (con su historia)

- La casilla al invitar: ACC-4 (Rasheed).
- Sesión delegada entre workspaces: AGE-2.
- Envío del aviso por correo: ACC-8 fase 2 (`notification.emailed_at`
  ya existe para cuando llegue).
- Aviso al titular cuando un tercero QUITA la cuenta: otro `kind`
  (`connection_removed`); queda para ACC-8 fase 2 junto con el correo.
  Hoy queda en la evidencia y en la bitácora.
- Recolocar los textos anteriores de Conexiones en `messages.ts`
  (declaración de propiedad, texto OAuth, errores del flujo): pulido,
  no ACC-8.
