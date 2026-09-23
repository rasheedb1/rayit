# ACC-8 · Consentimiento delegado — plan y lo que necesita Rasheed

Escrito para: Rasheed (dueño de `db/migrations/`, `packages/db/src/schema`,
`lib/auth/` y `lib/workspace/`) y quien revise el PR de ACC-8.
Fecha: 23 de septiembre de 2026. Rama `nicolas/ACC-8-consentimiento-delegado`,
worktree `rayit-acc8`, creada desde `origin/main` (`29460e3`) e
integrada después con `origin/main` (`f7466a8`), que ya traía ACC-1,
ACC-2 y ACC-3.

---

## 0. Plan (fase 1)

### 0.1 El punto de partida

El plan se escribió primero sobre `29460e3`, sin ACC-1, ACC-2 ni ACC-3.
A mitad de la historia `main` recibió las tres, y la rama se integró y
se rehízo sobre lo real:

| Necesita | Hay en main | Cómo lo usa ACC-8 |
|---|---|---|
| Quién actúa | `current_user_id()` fijado por la sesión (CIM-3) | `getSessionMember(tx)`: `app_user` + `membership` + `role.key` del workspace actual |
| Su rol | `membership.role_id` → `role` (0034, ACC-3); `membership.role` ya no existe | `roleKey = role.key`, lo que queda en `evidence.actedBy.roleKey` |
| El permiso | `requirePermission()` (ACC-1) en `lib/permisos`; `role_permission` (0034) | la acción abre con `requirePermission`; la transacción que escribe comprueba `role_permission` con `sessionHasPermission` (ver 0.3.5) |
| La bitácora | `audit()` (ACC-2) dentro de cada consulta de `queries/conexiones.ts` | cada fila de conexiones y consentimientos suma `onBehalfOf` y `actedBy` al `after` |
| El titular | `creator_profile.user_id` (0001) | `getConsentCreator(tx)`; cierra el `TODO(CIM-3)` de `getDefaultCreatorId` |
| El aviso | `notification` (0009 y 0030) sin `kind` para «cuenta conectada» | migración **0038** con `connection_added` |

**La casilla de ACC-4 no existe todavía.** En un workspace de creador,
solo el rol `owner` trae `conexiones.cuenta.conectar` de fábrica; el
`manager` no (decisión E). Las pruebas representan «el mánager con la
casilla» con un **rol a medida del workspace** (`manager_conecta`: los
permisos del Mánager más conectar y desconectar), que 0034 ya admite.
Es lo que la casilla otorga; cómo la materializa ACC-4 es de Rasheed.

### 0.2 Qué se construye y dónde

```
db/migrations/0038_notification_connection_added.sql
                                    CHECK de notification.kind + 'connection_added'. Re-ejecutable.
db/seed/0003_demo_finanzas_campanas.sql (mío)
                                    + Andrés Pardo, mánager de la demo (rol de fábrica 'manager'),
                                      un data_consent v2 con actedBy sobre el Instagram del seed y su aviso.

packages/db/src/queries/conexiones.ts
  getConsentCreator(tx)             el titular: creator_profile del workspace con su user_id
  getSessionMember(tx)              quien actúa: { userId, email, name, roleKey } | null
  sessionHasPermission(tx, key)     role_permission por la membresía de la sesión
  delegationFor(tx, creatorId)      privada: { onBehalfOf, actedBy? } para el `after` de cada audit()
  disconnectConnection(tx, id, rev) + evidence.revocation en cada consentimiento revocado
  notifyConnectionAdded(tx, …)      kind connection_added al titular, sin duplicar uno sin leer
  listAccounts(tx)                  + connectedBy { userId, name, email, at } | null
packages/db/test/conexiones-delegado.test.ts
packages/db/test/audit-convencion.test.ts   notifyConnectionAdded declarada sin bitácora, con motivo

apps/web/app/(app)/conexiones/
  _lib/consent.ts                   evidencia v2: buildConsentEvidence, buildRevocationEvidence, ipHash
  _lib/permisos.ts                  requireConexionesPermission(tx, permiso) con SinPermisoError de @mc/core
  _lib/messages.ts                  el aviso al titular y «Conectada por … el …»
  _lib/cuentas-service.ts           agregar y quitar con permiso, evidencia v2 y aviso
  _lib/oauth-handlers.ts            start y callback con permiso, evidencia v2 y aviso
  _lib/*.test.ts                    mánager / titular / editor / dump-text, en los dos caminos
  actions.ts                        requirePermission (ACC-1, ya en main) + SinPermisoError al quitar
  page.tsx                          «Conectada por <nombre> el <fecha>» con formatterFor
apps/web/README.md                  §Conexiones: quién conecta y quién consiente
apps/web/content/backlog.ts         entrada ACC-8
```

### 0.3 Decisiones

**(1) Evidencia v2.** Un solo objeto para los dos caminos:

```jsonc
{
  "v": 2,
  "method": "public_handle" | "oauth",
  "declaredOwner": true,            // por @: la casilla; en OAuth, false (la titularidad la prueba la plataforma)
  "ipHash": "sha256 hex" | null,    // v1 guardaba la IP en claro
  "userAgent": "…" | null,
  "textShown": "…", "policyVersion": "2026-09-22", "at": "ISO",
  "onBehalfOf": { "creatorId": "<creator_profile.id>" },
  "actedBy": { "userId": "…", "email": "…", "roleKey": "manager_conecta" },   // se OMITE si actúa el titular
  // lo que v1 ya llevaba: handle, platformId, source | scopesRequested, scopesGranted
}
```

- `actedBy` se omite cuando actúa el titular y en modo demo sin sesión.
  `onBehalfOf` va siempre.
- **Descartado**: una columna `acted_by_user_id` en `data_consent`. El
  encargo la excluye, y la evidencia tiene que ser un registro autónomo:
  si mañana el mánager deja de ser miembro, su correo y su rol de ese
  día siguen en la fila.
- **Descartado**: el nombre del actor en la evidencia. El nombre cambia
  y el id no. La pantalla lo resuelve al leer y cae al correo guardado
  si la persona ya no es miembro.
- `ipHash` es `sha256(ip)` sin sal: una sal por despliegue volvería
  inverificable la evidencia al rotar. Confirma una IP conocida, pero
  no oculta una IPv4 ante fuerza bruta. **DECISIÓN PENDIENTE DE
  NICOLÁS**: volver a la IP en claro de v1 es cambiar una línea en
  `consent.ts`.

**(2) Aviso al titular.** `notification` con `user_id =
creator_profile.user_id`, `kind 'connection_added'`, `severity 'info'`,
`entity_type 'social_connection'`, `action_url '/conexiones'`. Título y
cuerpo los arma la web (`messages.ts`) con quién, qué cuenta, qué red y
cuándo, en la zona y el locale del workspace; `@mc/db` no escribe
frases. No se crea si el titular no tiene `app_user`: el servicio
devuelve `aviso: 'sin_titular'`. No se duplica mientras haya uno sin
leer para la misma cuenta y persona.

- **Descartado**: el correo. Es fase 2.
- **Descartado**: reutilizar `connection_error`, que el worker ya usa
  con el sentido contrario.

**(3) Bitácora.** No hay función propia: las consultas ya auditan con
`audit()` (ACC-2), con `actor_user_id = current_user_id()`. ACC-8 añade
al `after` de cada fila de conexiones y consentimientos
(`connection.added`, `.reconnected`, `.authorized`, `.disconnected`,
`consent.recorded`, `consent.revoked`) el `onBehalfOf` y, si actuó un
tercero, `actedBy { userId, roleKey }`. Sin correo: `sanitizeForAudit`
lo taparía igual. `actor_kind 'delegate'` y `on_behalf_of_workspace_id`
(0034) quedan para AGE-2, cuando alguien actúe desde OTRO workspace;
aquí el mánager actúa dentro del del creador.

**(4) Desconectar por un tercero.** `disconnectConnection` anexa
`evidence.revocation = { v, at, onBehalfOf, actedBy? }` a cada
consentimiento que revoca. El otorgamiento no se toca, y la bitácora
lleva `connection.disconnected` con la delegación.

**(5) Dónde se comprueba el permiso.** `requirePermission()` es la
primera línea de cada Server Action (convención de ACC-1, ya en main).
Hasta ACC-5 esa función resuelve toda sesión como Dueño, así que no
distingue al Editor. Por eso la transacción que escribe comprueba otra
vez, como primera sentencia, con `sessionHasPermission`, que lee
`role_permission` por la membresía de la sesión. Esa es también la
única comprobación de los route handlers de OAuth, que no son Server
Actions. Además corre antes de gastar una llamada a la plataforma y
antes de redirigir al diálogo de OAuth.

- **Descartado**: esperar a ACC-5. El encargo pide la prueba de que el
  Editor no puede, y hoy `requirePermission` no lo impediría.
- **Descartado**: una tabla de roles en TypeScript. La matriz ya está
  en la base y en `@mc/core`; una tercera copia se desincroniza.

**(6) Número de la migración.** Tras `git fetch` el 23 de septiembre,
en todas las ramas están tomados 0034 (ACC-3), 0035 (CAM-3, ACC-6),
0036 (CON-7, FIN-7) y 0037 (CAM-6). La nueva es **0038**; `0023` no se
recicla. Es una sola sentencia sin dependencias: si otra rama toma
0038, se renumera. Si otra rama amplía también el CHECK de
`notification.kind`, la segunda en aplicarse tiene que incluir los
valores de la primera.

**(7) Seed.** Andrés Pardo entra con el rol `manager` de fábrica, sin
la casilla, porque un seed no puede crear roles a medida (política
`role_seed` de 0034). La demo cuenta una historia pasada: con la
casilla, Andrés conectó el Instagram de Laura, y eso queda en la
evidencia y en el aviso. Hoy, con su rol de fábrica, no podría. Ids
fijos y `ON CONFLICT DO NOTHING`. **DECISIÓN PENDIENTE DE NICOLÁS**:
si no lo quiere en la demo pública, se quita el bloque, que está
delimitado.

---

## 1. Lo que necesita Rasheed

### 1.1 Migración 0038 (revisar y aplicar; esta rama no corre `make db.migrate`)

`platform/db/migrations/0038_notification_connection_added.sql` es una
sola sentencia re-ejecutable que amplía el CHECK de
`notification.kind` con `connection_added`. Pasa `make db.check`. El
seed 0003 la necesita aplicada antes de sembrar en Supabase.

### 1.2 Esquema Drizzle (`packages/db/src/schema/cimientos.ts`)

Añadir `'connection_added'` a `NOTIFICATION_KINDS` con su comentario
(`// 0038 (ACC-8): un tercero conectó una cuenta en nombre del titular`).
Esta rama no lo toca: los INSERT van por SQL.

### 1.3 La casilla de ACC-4

- **Qué otorga**: exactamente `conexiones.cuenta.conectar` y
  `conexiones.cuenta.desconectar`, además de los permisos del Mánager.
- **Cómo lo lee ACC-8**: `sessionHasPermission` pregunta a
  `role_permission` por el rol de la membresía. Si ACC-4 materializa la
  casilla como un rol a medida del workspace, como hacen las pruebas,
  no hay que tocar nada. Si la materializa de otra forma (permisos por
  membresía), `sessionHasPermission` tiene que leer también de ahí.
- **Qué queda en la evidencia**: `actedBy.roleKey` es la `role.key` de
  ese día.

### 1.4 Lo que ACC-5 y AGE-2 heredan

- **ACC-5**: cuando `permisosDeLaSesion()` lea la base,
  `requirePermission` y `requireConexionesPermission` responderán lo
  mismo. La segunda se queda como comprobación dentro de la transacción
  que escribe (hay un `TODO(ACC-5)` en `sessionHasPermission`).
- **AGE-2**: el modelo no cambia. El actor sigue siendo
  `current_user_id()` y el titular sigue siendo `creator_profile`. Lo
  nuevo es `actor_kind 'delegate'` y `on_behalf_of_workspace_id` en
  `audit_log`, y quizá `actedBy.workspaceId` en la evidencia.

### 1.5 Fuera de alcance

- La casilla al invitar: ACC-4 (Rasheed).
- Sesión delegada entre workspaces: AGE-2.
- Envío del aviso por correo: fase 2 (`notification.emailed_at` ya existe).
- Aviso al titular cuando un tercero QUITA la cuenta: otro `kind`,
  fase 2. Hoy queda en la evidencia y en la bitácora.
- Mover a `messages.ts` los textos anteriores de Conexiones
  (declaración, texto OAuth, errores del flujo): pulido.

---

## 2. Revisiones

### 2.1 `/code-review` (nivel alto): diez hallazgos

| # | Hallazgo | Qué se hizo |
|---|---|---|
| 1 | «Actualizar» no comprobaba el permiso en la transacción: un Editor abría tokens y gastaba cuota | Arreglado: `actualizar` comprueba `conexiones.cuenta.conectar` antes de leer tokens o llamar a la plataforma. Prueba: el Editor recibe `sin_permiso` y `fetch` no se llama |
| 2 | Quitar fallaba si el `creator_profile` estaba dado de baja | Arreglado: `getConnectionCreator(tx, id)` toma el titular de la propia cuenta, sin filtrar borrados. Prueba en `conexiones-delegado.test.ts` |
| 3 | «Conectada por» salía del último consentimiento delegado, no del último vigente | Arreglado: el `LATERAL` toma el vigente más reciente. Prueba: la titular reconsiente y la línea desaparece |
| 4 | El callback de OAuth canjeaba el code antes de mirar el permiso | Arreglado: comprobación antes del canje. Prueba: el Editor no provoca ninguna llamada. Revocar en la plataforma un grant huérfano queda fuera: la comprobación temprana lo evita en la práctica |
| 5 | `onBehalfOf` de la revocación y de la bitácora podían nombrar perfiles distintos | Arreglado con el mismo cambio que el 2 |
| 6 | El aviso al titular estaba duplicado en los dos caminos | Arreglado: `notifyOwner` en `_lib/owner-notice.ts` |
| 7 | `delegationFor` repite consultas que ya hizo el permiso | Justificado: son dos o tres consultas por índice en una acción que se hace pocas veces por cuenta. Mantenerlo dentro de las consultas asegura que ninguna escritura de conexiones se audite sin delegación, venga de donde venga |
| 8 | Dos fuentes deciden si actúa un tercero (`actedByFor` y `delegationFor`) | Justificado: las dos comparan `current_user_id()` con `creator_profile.user_id`. El caso en que divergirían (sesión sin membresía) no llega a escribir, porque el permiso lo rechaza antes |
| 9 | `getDefaultCreatorId` ya no se usa en producción; `ownerNotice` no se lee en la acción | `getDefaultCreatorId` se queda: lo usan las pruebas de CON-3 y es API pública de `@mc/db`. `ownerNotice` lo leen las pruebas y queda para el aviso en pantalla |
| 10 | Identificadores nuevos en español | Arreglado: `notifyOwner`, `OwnerNotice`, `displayNameOf`, `MESSAGES.ownerNotice` y `MESSAGES.list` |

### 2.2 `/security-review`: sin hallazgos

Ninguno supera el umbral de confianza (8/10). Lo que se revisó:

- **SQL.** Todas las consultas nuevas usan parámetros.
- **Permiso.** Se comprueba en cada transacción que escribe y en cada paso de OAuth, ligado a `current_user_id()` y `current_workspace_id()`.
- **Delegación.** `actedBy` y `onBehalfOf` salen de la base, nunca del navegador.
- **Secretos.** No hay tokens ni correos en la bitácora ni en las URL.
- **XSS.** No hay HTML sin escapar.

Queda anotado, por debajo del umbral, que `ipHash` sin sal se revierte por fuerza bruta sobre IPv4. No es peor que la IP en claro de v1, y es la decisión pendiente de §0.3.1.
