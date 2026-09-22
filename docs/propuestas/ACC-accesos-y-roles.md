# ACC · Accesos, roles y agencias — propuesta de diseño

> Documento de trabajo. Fecha: 22 de septiembre de 2026.
> Responde a: «cómo damos acceso parcial a una misma cuenta (el mánager
> del creador) y cómo preparamos el módulo de agencias».
> Lo que se apruebe de aquí pasa al backlog como el épico **ACC** (lo que
> se puede hacer ya) y **AGE** (fase 2), y a las decisiones de §7.

---

## Fase 1 · Qué hay ya construido

No partimos de cero. El esquema de `0001_base_tenancy.sql` ya resolvió
la parte difícil:

| Pieza | Dónde | Qué resuelve | Qué le falta |
|---|---|---|---|
| `workspace` con `kind IN ('creator','agency')` | 0001 | La unidad de aislamiento. Un creador es un workspace; una agencia, otro. | Nada por ahora. |
| `membership (workspace_id, user_id, role)` | 0001 | Que varias personas entren a la misma cuenta. | El rol es un `text` con CHECK de cinco valores y **no significa nada**: ningún código lo lee. |
| RLS `workspace_id = current_workspace_id()` en 36 tablas | 0010 | Que un cliente no vea a otro. Es la garantía dura. | No distingue *entre personas del mismo workspace*: hoy un `viewer` ve exactamente lo mismo que el `owner`. |
| `audit_log` con `actor_user_id` y `actor_kind` | 0001 | El rastro de quién hizo qué. | Nadie escribe en él todavía. Y no sabe representar «Ana, de la agencia, actuando dentro del workspace de Camilo». |
| `data_consent` con ocho propósitos | 0002 | El permiso del creador para usar sus datos. | No distingue *quién* otorgó el consentimiento cuando hay un intermediario. |
| `feature_flag` con `agency_workspace` | 0009 | El interruptor del módulo de agencia. | Apagado, sin nada detrás. |
| `creator_profile (workspace_id, user_id)` | 0001 | Que una agencia tenga N creadores (su *roster*). | Es la puerta al modelo equivocado; ver decisión A. |

**Lo que falta es exactamente una cosa**: entre «quién eres» (RLS, el
workspace) y «qué pantalla abres» no hay nada. Hoy, entrar a un
workspace es tener todo el workspace.

---

## Fase 2 · Las tres preguntas que la gente mezcla

Casi todo el desorden de permisos en productos como este viene de tratar
tres preguntas distintas como si fueran una:

1. **¿Quién eres?** Identidad. Supabase Auth, CIM-3. Resuelta (o en
   camino).
2. **¿Qué puedes hacer?** Permisos. `finanzas.factura.crear`,
   `conexiones.cuenta.conectar`. *No existe.*
3. **¿Sobre qué puedes hacerlo?** Alcance. «Ana puede ver campañas, pero
   solo las de Camilo y Sofía, no las de los otros ocho creadores de la
   agencia.» *No existe.*

La tenencia (RLS) responde una cuarta pregunta, anterior a las tres:
**¿de qué cliente son estos datos?** Esa ya está y no se toca.

Las cinco decisiones de abajo son, cada una, la respuesta a «dónde vive»
cada pregunta.

---

## Fase 3 · Las cinco decisiones

### Decisión A · La agencia no absorbe al creador: se le concede acceso

Es la decisión más cara de cambiar después, así que va primera.

Hay dos formas de modelar una agencia:

| | **Absorber**: el creador es una fila `creator_profile` dentro del workspace de la agencia | **Conceder** (propuesta): el creador tiene su workspace; la agencia tiene el suyo y recibe un permiso explícito sobre el del creador |
|---|---|---|
| Dueño de los datos | La agencia | El creador |
| Un creador con dos agencias | Imposible sin duplicar | Dos concesiones |
| El creador se va de la agencia | Migración de datos entre tenants, a mano | Se revoca una fila |
| El creador quiere su propia cuenta además | Cuenta nueva, historia partida | Ya la tiene; la agencia entra a la suya |
| Reporte consolidado de la agencia | Una consulta trivial | Hay que construirlo (ver AGE-3) |
| RLS | Sin cambios | Sin cambios **si** la sesión sigue fijada a un workspace (ver abajo) |
| Consentimiento (`data_consent`) | Lo firma la agencia por el creador. Frágil ante TikTok y Meta. | Lo firma el creador, que es de quien son los datos |

**Propuesta: conceder.** El esquema ya empuja hacia ahí sin decirlo —
el comentario de `creator_profile` en 0001 dice «para que una agencia
pueda mover un creador de espacio sin perder su historia». Conceder es
esa idea llevada a su conclusión.

Lo importante: **conceder es un superconjunto, absorber no.** Si una
agencia trae a un creador que nunca usó On Cue, la agencia le crea el
workspace y nace con una concesión activa a su favor. El creador no
tiene que hacer nada, y el día que quiera su cuenta ya la tiene. Al
revés no funciona: de «absorbido» a «dueño» hay una migración.

**Cómo se mantiene RLS intacta.** La tentación es cambiar la política a
`workspace_id IN (...)`. No. Cada política pasa de una comparación a una
subconsulta, y un error en cualquiera de las 36 es una fuga entre
clientes. En vez de eso:

- La sesión sigue fijada a **un** workspace (`app.workspace_id`). La
  persona de agencia *entra* al workspace del creador, con el rol y el
  alcance que dice la concesión. RLS no se entera y no cambia.
- El consolidado de la agencia («mis 30 creadores en una tabla») **no**
  se resuelve en RLS: es una proyección de solo lectura que escribe el
  worker en el workspace de la agencia, con fecha de corte. Ya tenemos
  la convención para eso: el aviso `DataAsOf` de CIM-5. Esto es AGE-3.

### Decisión B · El código pregunta por permisos, no por roles

Regla dura, y es la que evita la reescritura dentro de un año:

```ts
// no
if (session.role === "admin" || session.role === "owner") { … }

// sí
requirePermission(session, "finanzas.factura.crear");
```

Un rol es un nombre para un conjunto de permisos, nada más. Con
`role === 'admin'` repartido por 40 Server Actions, agregar el rol
«Contador» es editar 40 archivos en dos módulos de dos dueños
distintos. Con permisos, es una fila en `role_permission`.

**Nombre del permiso:** `<módulo>.<recurso>.<acción>`, en español el
módulo y el recurso porque son los del producto:

```
resumen.panel.ver          conexiones.cuenta.ver
ventas.deal.ver            conexiones.cuenta.conectar
ventas.deal.editar         conexiones.cuenta.desconectar
cotizar.cotizacion.enviar  campanas.campana.ver
finanzas.factura.ver       campanas.campana.editar
finanzas.factura.crear     campanas.reporte.enviar
finanzas.pago.registrar    equipo.miembro.invitar
finanzas.flujo.ver         equipo.rol.editar
finanzas.config.editar     cuenta.workspace.eliminar
```

El catálogo vive en una tabla (`permission`), no en una constante de
TypeScript, por una razón concreta: la pantalla de «Equipo» tiene que
dibujar la matriz de permisos con etiquetas en español, y el día que
una agencia quiera un rol a medida, la matriz ya está ahí.

### Decisión C · La tenencia se garantiza en RLS; el alcance, en las consultas

El alcance («solo los creadores A y B», «solo la marca X») es tentador
meterlo también en RLS. No conviene, y hay que decirlo explícito porque
es el error clásico:

- RLS compara una columna que **todas** las 36 tablas tienen
  (`workspace_id`). El alcance depende de columnas que solo algunas
  tienen (`creator_id`, `campaign_id`, `company_id`) y de tablas que no
  tienen ninguna (`invoice` es de una empresa, no de un creador).
- Una política con `EXISTS` por tabla es lenta y, peor, es difícil de
  leer. Y una política de alcance mal escrita **no** se ve como un bug:
  se ve como una pantalla que funciona.

**Propuesta**: el alcance se aplica en `packages/db`, con un solo helper
(`scopeFilter()`) que cada `queries/<modulo>.ts` compone, y una prueba
por módulo que demuestra que lo aplica. La garantía dura sigue siendo
RLS (nadie ve otro cliente, pase lo que pase); el alcance es una capa
de producto encima.

Endurecimiento posterior (ACC-7, opcional): las tablas que **sí** llevan
`creator_id` —`social_connection`, `post`, `campaign`, `deal`— pueden
además llevar política por creador. Se hace cuando el alcance ya esté
probado en las consultas, no antes.

### Decisión D · La marca no tiene cuenta: tiene un enlace

`membership.role = 'client'` existe en 0001 con el comentario «es la
marca de una agencia: solo ve su propio portal de reportes».
**Propuesta: no construir sobre eso.**

Darle a una marca una sesión dentro del workspace del creador significa
que la única cosa que la separa de las finanzas del creador es que
acertemos con todas las políticas. El producto ya tiene el patrón
correcto en dos historias:

- **COT-2**: media kit público con `slug`, contraseña y vencimiento
  opcionales, con las cifras congeladas.
- **CAM-6**: reporte a la marca con `payload` congelado, `sent_at` y
  `viewed_at`, que no cambia aunque lleguen snapshots nuevos.

Eso es exactamente lo que una marca necesita: un enlace firmado, con
vencimiento, a un contenido congelado. Cero superficie. El valor
`'client'` se deja en el enum (quitarlo es una migración por nada), pero
ninguna historia lo usa. Si algún día una marca grande pide una cuenta
de verdad, es un workspace `kind = 'brand'` con concesiones —
decisión A otra vez, sin inventar nada.

### Decisión E · Tres cosas no son un permiso más

Un sistema de permisos genérico trata todo igual. En este producto hay
tres cosas donde eso falla:

**1. El dinero no entra en ningún rol por defecto.** Que el mánager del
creador vea el flujo de caja, los gastos y la reserva de impuestos no
es un detalle de configuración: es una decisión que el creador toma a
propósito. El rol «Mánager» sale de fábrica **sin** `finanzas.flujo.ver`
ni `finanzas.gasto.*`; lleva solo el estado de cobro de las campañas que
él negoció. Activarlo es un clic consciente en la matriz.

**2. El token de una cuenta conectada no se lee nunca.** No existe el
permiso «ver token». Existen `conexiones.cuenta.conectar` y
`…desconectar`. La pantalla muestra estado y handle
(`connection_health` ya está hecha así). Esto ya funciona en CON-3, solo
hay que dejarlo escrito para que nadie agregue después un permiso de
lectura «para depurar».

**3. Conectar una cuenta ajena es un evento de consentimiento.** Si el
mánager conecta el TikTok de Camilo, `data_consent` tiene que registrar
que el titular es Camilo y que quien operó fue el mánager. Hoy
`data_consent` tiene `creator_id` y `evidence jsonb`: alcanza con la
regla de que `evidence` lleve `acted_by` y que el creador reciba la
notificación (la tabla `notification` ya existe). Sin esto, el día que
Meta pregunte quién dio el consentimiento, no hay respuesta.

**Y el rastro.** `audit_log` ya tiene `actor_user_id` y `actor_kind`. Se
le agrega `'delegate'` al CHECK y una columna
`on_behalf_of_workspace_id`. Eso es lo que hace el modelo *confiable*
para el creador: «siempre puedes ver qué hizo tu mánager, y cuándo».
Escribir en `audit_log` desde el primer Server Action es barato;
rellenarlo hacia atrás es imposible.

---

## Fase 4 · El esquema (migración `0017`)

Números tomados el 22 de septiembre: `origin/main` va en `0016`;
`nicolas/CON-3` trae `0015_connection_secret` y `0016_campaign_quote_unique`.
La siguiente libre es **`0017_access_control.sql`**. La propone Nicolás
en el PR; la revisa y aplica Rasheed (§3.1).

```sql
-- Catálogo de permisos. Como 'niche': compartido, sin workspace_id.
CREATE TABLE permission (
  key           text PRIMARY KEY,            -- 'finanzas.factura.crear'
  module        text NOT NULL,               -- 'finanzas'
  label_es      text NOT NULL,               -- 'Crear facturas'
  description_es text,
  sensitivity   text NOT NULL DEFAULT 'normal'
                CHECK (sensitivity IN ('normal','sensible')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Roles. workspace_id NULL = rol de sistema, igual que feature_flag (0009).
CREATE TABLE role (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid REFERENCES workspace(id) ON DELETE CASCADE,
  key            text NOT NULL,              -- 'owner','manager','editor',…
  workspace_kind text NOT NULL CHECK (workspace_kind IN ('creator','agency')),
  label_es       text NOT NULL,
  description_es text,
  is_system      boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX role_system_uk ON role (key, workspace_kind)
  WHERE workspace_id IS NULL;
CREATE UNIQUE INDEX role_ws_uk     ON role (workspace_id, key)
  WHERE workspace_id IS NOT NULL;

CREATE TABLE role_permission (
  role_id        uuid NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_key text NOT NULL REFERENCES permission(key) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_key)
);

-- membership.role (text + CHECK) pasa a ser una FK.
-- Se puede hacer sin ceremonia: hoy ninguna fila real y ningún código
-- lo lee (grep de 'membership' fuera de 0001: cero resultados).
ALTER TABLE membership ADD COLUMN role_id uuid REFERENCES role(id);
-- …backfill por key… luego:
ALTER TABLE membership ALTER COLUMN role_id SET NOT NULL;
ALTER TABLE membership DROP COLUMN role;

-- Alcance. Sin filas = todo el workspace.
CREATE TABLE membership_scope (
  workspace_id  uuid NOT NULL,
  user_id       uuid NOT NULL,
  scope_type    text NOT NULL CHECK (scope_type IN ('creator','company','campaign')),
  scope_id      uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id, scope_type, scope_id),
  FOREIGN KEY (workspace_id, user_id)
    REFERENCES membership(workspace_id, user_id) ON DELETE CASCADE
);

-- Invitaciones. El token nunca se guarda en claro (misma regla que
-- los secretos de CON-3).
CREATE TABLE invitation (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  email         citext NOT NULL,
  role_id       uuid NOT NULL REFERENCES role(id),
  scope         jsonb NOT NULL DEFAULT '[]'::jsonb,
  token_hash    text NOT NULL,
  invited_by    uuid REFERENCES app_user(id) ON DELETE SET NULL,
  expires_at    timestamptz NOT NULL,
  accepted_at   timestamptz,
  revoked_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON invitation (workspace_id, email)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- Concesión entre workspaces: la agencia entra al del creador.
-- Va en 0017 aunque la pantalla sea fase 2: la tabla es barata y así el
-- modelo queda cerrado de una vez.
CREATE TABLE workspace_grant (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grantor_workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE, -- el creador
  grantee_workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE, -- la agencia
  role_id              uuid NOT NULL REFERENCES role(id),
  scope                jsonb NOT NULL DEFAULT '[]'::jsonb,
  status               text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','active','revoked','expired')),
  requested_by         uuid REFERENCES app_user(id) ON DELETE SET NULL,
  approved_by          uuid REFERENCES app_user(id) ON DELETE SET NULL,
  expires_at           timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  CHECK (grantor_workspace_id <> grantee_workspace_id)
);
CREATE UNIQUE INDEX ON workspace_grant (grantor_workspace_id, grantee_workspace_id)
  WHERE status IN ('pending','active');

-- Rastro de la actuación delegada.
ALTER TABLE audit_log DROP CONSTRAINT audit_log_actor_kind_check;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_kind_check
  CHECK (actor_kind IN ('user','system','job','webhook','delegate'));
ALTER TABLE audit_log ADD COLUMN on_behalf_of_workspace_id uuid
  REFERENCES workspace(id) ON DELETE SET NULL;
```

Las tablas nuevas con `workspace_id` (`membership_scope`, `invitation`)
entran a la lista de RLS de 0010 con su propia política. `permission`,
`role` de sistema y `workspace_grant` **no** llevan RLS por
`workspace_id`: la concesión se consulta por los dos extremos, y se lee
con una consulta del servidor, nunca desde una pantalla.

---

## Fase 5 · La matriz de roles de fábrica

Roles de sistema (`workspace_id IS NULL`), semilla en `db/seed/0001_catalog.sql`.

### Workspace de creador

| Rol | Para quién | Resumen | Ventas + Cotizar | Campañas | Finanzas | Conexiones | Equipo |
|---|---|---|---|---|---|---|---|
| **Dueño** (`owner`) | El creador | Todo | Todo | Todo | Todo | Todo | Todo |
| **Mánager** (`manager`) | Su agente, quien habla con las marcas | Ver | Todo | Todo, incluido enviar el reporte | **Solo el cobro de sus campañas.** Sin flujo, gastos, impuestos ni configuración | Ver estado; **no** conecta ni desconecta | Ver |
| **Editor** (`editor`) | Community manager, editor de video | Ver | — | Ver y marcar entregables | — | Ver estado | — |
| **Contador** (`finance`) | Contador externo | — | — | Ver nombre y monto | Todo | — | — |
| **Solo lectura** (`viewer`) | Quien mira y no toca | Ver | Ver | Ver | — | Ver estado | — |

### Workspace de agencia

| Rol | Alcance típico | Qué hace |
|---|---|---|
| **Dueño** (`owner`) | Toda la agencia | Todo, incluidas concesiones y facturación de la cuenta |
| **Administrador** (`admin`) | Toda la agencia | Personas, roles, marcas y concesiones. No borra la cuenta |
| **Ejecutivo de cuenta** (`manager`) | Las marcas o creadores que tiene asignados | Ventas, Cotizar y Campañas **dentro de su alcance** |
| **Contador** (`finance`) | Toda la agencia | Finanzas de la agencia |
| **Solo lectura** (`viewer`) | Asignable | Ver |

Dos reglas que van en el código, no en la matriz:

- **Nadie otorga lo que no tiene.** Al invitar o editar un rol, la lista
  de permisos disponibles es la intersección con los propios. Sin esto,
  un `admin` se hace `owner` en dos clics.
- **El último dueño no se puede quitar ni degradar.** Un workspace sin
  `owner` es un workspace que nadie puede recuperar.

---

## Fase 6 · La API en código

Cuatro piezas, ninguna grande:

| Pieza | Archivo | Dueño (§3.1) | Qué hace |
|---|---|---|---|
| `PERMISOS`, `ROLES_SISTEMA`, `can()` | `packages/core/permisos.ts` | Nicolás (archivo nuevo, se agrega a la tabla de §3.1) | Catálogo y evaluación pura, sin base de datos. Es la única pieza que se puede hacer **hoy** |
| `requirePermission(session, perm, scope?)` | `apps/web/lib/auth/` | Rasheed | Lanza si no; se usa al inicio de cada Server Action y en cada `page.tsx` |
| `scopeFilter(session, tabla)` | `packages/db/src/scope.ts` | Rasheed (vive junto a `client.ts`) | El `WHERE` de alcance que compone cada `queries/<modulo>.ts` |
| `withAudit(session, accion, fn)` | `packages/db/src/audit.ts` | Rasheed | Envuelve la escritura y deja la fila en `audit_log` con `before`/`after` |

`requireModule()` de CIM-4 (`content/modules.ts`, de Nicolás) recibe un
segundo argumento opcional: el permiso mínimo. Una ruta cuyo permiso no
se tiene responde 404, igual que una bandera apagada — no 403, para no
revelar que el módulo existe.

---

## Fase 7 · Qué hacer ya y qué después

> **Actualizado el 22 de septiembre**, al confirmarse que los creadores
> del piloto tienen mánager. La versión anterior de esta fase dejaba
> todo ACC fuera del MVP; ya no es defendible.

El piloto con mánager convierte ACC de «preparación para la fase 2» en
requisito del MVP: sin roles, el piloto se hace dándole al mánager la
cuenta del creador, que es exactamente lo que el producto dice resolver.
Pero **no todo ACC** hace falta, y esa distinción es lo que hace que
quepa:

| | Piloto con mánager | Agencias |
|---|---|---|
| Permisos y roles de fábrica (ACC-1, ACC-3, ACC-5) | Sí | Sí |
| Invitar, aceptar, cambiar, revocar (ACC-4) | Sí | Sí |
| Bitácora (ACC-2) | Sí | Sí |
| Consentimiento delegado (ACC-8) | Sí, si el mánager hace el onboarding | Sí |
| **Alcance** por creador (ACC-6, ACC-7) | **No**: un workspace de creador tiene un creador; no hay nada que acotar | Sí, es el corazón |
| Matriz editable y roles a medida (ACC-9) | No: cinco roles de fábrica alcanzan | Sí |
| Concesiones entre workspaces (AGE) | No | Sí |

Con ese corte el MVP absorbe ~7 días y el sprint 6 se queda solo con lo
que de verdad es de agencias.

### Sprint 3 · las dos convenciones (≈1,5 días)

| | Qué | Por qué ahora |
|---|---|---|
| **ACC-1** | `packages/core/permisos.ts`: el catálogo y `can()`, sin base de datos y sin pantalla | Fija los nombres. Cada Server Action que se escriba desde ahora nace con su `requirePermission()` — una línea. Ponerlos después es abrir 40 archivos en dos módulos de dos dueños |
| **ACC-2** | `withAudit()` obligatorio en toda escritura de dinero, publicación o cuenta conectada | `audit_log` no se puede rellenar hacia atrás. El día que una marca discuta un reporte, o un creador pregunte qué hizo su mánager, o exista el primer incidente, o está el rastro o no está |

Nada de esto cambia una pantalla ni pide una migración. Es una
convención, y las convenciones solo son gratis al principio.

### Sprint 4 · el esquema (ACC-3)

La migración `0017` la escribe Nicolás y la revisan y aplican Rasheed:
es la convención de §3.1 para `db/migrations/`, y en el sprint 4 Rasheed
va en 9 días de 10 mientras Nicolás ya va en 12. El esquema Drizzle
(`packages/db/schema/`) sí es de Rasheed.

Va en el sprint 4 y no en el 5 por riesgo, no por carga: ACC-4 es una
pantalla que no puede empezar sin la tabla. Si las dos caen en el mismo
sprint y el esquema se atrasa tres días, la pantalla no llega al piloto.

### Sprint 5 · la pantalla y el consentimiento (ACC-4, ACC-5, ACC-8)

ACC-4 va recortada a lo que el piloto necesita: los cinco roles de
fábrica, invitar, aceptar, cambiar y revocar. **Sin** matriz editable ni
roles a medida — eso es ACC-9, y es necesidad de agencia, no de un
creador con un mánager.

Con un detalle que aparece al mirar el piloto de verdad: si el mánager
es quien hace el onboarding, va a necesitar conectar las cuentas del
creador, y el rol «Mánager» de fábrica no lo permite (decisión E). Si no
se resuelve, el piloto se traba el primer día esperando al creador. La
salida no es meter el permiso en el rol —ahí se queda para siempre y
para todos—: es que **la pantalla de invitar lo pregunte**, con dos
casillas apagadas, «también puede ver mis finanzas» y «también puede
conectar mis cuentas». Una decisión consciente, en el momento correcto,
y queda en `audit_log`. Eso es además lo que vuelve obligatoria a ACC-8.

### Sprint 6 · lo que sí es de agencias

ACC-6, ACC-7, ACC-9 y AGE-1 a AGE-5. Más lo que se corrió para hacerles
sitio: VEN-7, VEN-8, RES-4 y FIN-7 (§6 del backlog).

### Lo que cuesta, sin maquillar

~7 días nuevos sobre un plan que ya iba al 110 %. Con el tablero al día
(`apps/web/content/backlog.ts` lo calcula solo), los sprints 3 y 4 de
Nicolás quedan los dos en 14 días sobre 10, y el 4 es el punto frágil: CAM-3 a CAM-6 es el
ciclo completo que se demuestra al final del cuarto sprint y no se puede
tocar. Si aprieta, lo que se mueve es el SQL de ACC-3 a la semana 9
—Rasheed tiene aire en el sprint 5— y nunca ACC-4.

---

## Fase 8 · Lo que puede salir mal

| Riesgo | Señal temprana | Qué hacer |
|---|---|---|
| Los nombres de permiso se inventan sobre la marcha y quedan tres formas de nombrar lo mismo | Un permiso que no está en `permisos.ts` | El catálogo es una lista cerrada en TypeScript; agregar uno es editar el archivo, no pasar un string |
| El alcance se aplica en 9 de 10 consultas | Nadie lo nota nunca | Una prueba por módulo, con dos creadores y un miembro con alcance a uno, que recorre todas las funciones exportadas de `queries/<modulo>.ts` |
| La agencia crece y el consolidado (AGE-3) se vuelve el camino por defecto | Pantallas operativas leyendo la proyección en vez del workspace | La proyección es solo lectura y solo del panel de agencia; cualquier acción abre el workspace del creador |
| «Le damos cuenta a la marca, es más fácil» | Una historia que pide `role = 'client'` | Decisión D |
| Permisos y banderas se mezclan | `flags.ts` con llaves de permiso | Una bandera dice si el módulo **existe**; un permiso, si **esta persona** entra. Las dos se evalúan, en ese orden, en `requireModule()` |

---

## Lo que queda por decidir (para §7 del backlog)

1. **Decisión A** (absorber vs. conceder) es de producto, no de
   ingeniería: si el plan comercial es vender a agencias que traen a sus
   creadores en blanco, «conceder» sigue funcionando (la agencia crea el
   workspace y nace con la concesión), pero el onboarding lo tiene que
   contar bien. Conviene confirmarla antes de escribir `0017`.
2. **Dueño del épico ACC.** Toca `lib/auth/`, `packages/db/client.ts` y
   `db/migrations/` — todo de Rasheed (§3.1) — pero nace de una
   necesidad de los módulos de Nicolás. Propuesta: ACC-1 y ACC-2 de
   Nicolás (archivo nuevo en `core` y convención en sus Server Actions),
   ACC-3 a ACC-5 de Rasheed, ACC-6 y ACC-7 repartidos por módulo.
3. ~~¿Entra ACC-4 en el piloto del sprint 5?~~ **Resuelta el 22 de
   septiembre: sí, los creadores del piloto tienen mánager.** Fase 7
   reescrita en consecuencia.
4. **La matriz del rol «Mánager» hay que confirmarla con un mánager de
   verdad.** La de la fase 5 está escrita mirando el producto, no a las
   personas del piloto. Media hora con uno de ellos antes del sprint 5,
   para cerrar tres cosas: si necesita ver el cobro de sus campañas
   (propuesta: sí, solo el de las suyas), si va a hacer él el onboarding
   de las cuentas (propuesta: solo con la casilla de ACC-4), y si con
   tres roles basta para el piloto o alguien va a pedir «Editor» y
   «Contador» desde el primer día.
