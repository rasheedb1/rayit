# ACC-3 · Esquema de accesos (migración) — plan y lo que necesita Rasheed

Escrito para: Nicolás (dueño del SQL y de la semilla) y Rasheed (dueño
de `db/migrations/`, de `packages/db/src/schema/` y de la aplicación en
Supabase; y dueño de ACC-4, que arranca sobre estas tablas). Fecha: 23
de septiembre de 2026. Rama `nicolas/ACC-3-esquema-accesos`, worktree
`rayit-acc3`, desde `origin/main` `29460e3`.

**Qué es.** La migración que convierte «entrar a un workspace es tener
todo el workspace» en un modelo de roles y permisos: `permission`,
`role`, `role_permission`, `membership.role → role_id` con relleno,
`membership_scope`, `invitation`, `workspace_grant`,
`audit_log.actor_kind = 'delegate'` con `on_behalf_of_workspace_id`, RLS
para todo lo que lleva inquilino, y la semilla de los cinco roles de
creador y los cinco de agencia con su matriz (43 permisos, 222 filas de
`role_permission`). Todo tal como está en la fase 4 de
`ACC-accesos-y-roles.md`, corregido con lo que la base tiene hoy
(0024–0033: guardia invertida, disparadores de referencias, privilegios
mínimos).

---

## 0. Plan (fase 1)

### 0.1 Lo que se comprobó antes de escribir (23-sep)

| Qué | Resultado | Consecuencia |
|---|---|---|
| Número libre: `git fetch` y `git ls-tree` de las 19 ramas remotas y las 19 locales | El más alto en TODAS es `0033_una_aceptada_por_negocio.sql` (`main`, `rasheed/integracion`, `nicolas/CON-3-oauth-sandbox`) | La migración es **`0034_access_control.sql`**. `0023` sigue siendo un hueco declarado en `test/aplicar.test.ts`; no se recicla. |
| `0019`/`0028`: ¿las políticas `membership_read` y `membership_alta` nombran la columna `role`? | No: solo `workspace_id` y `user_id` (comprobado en pglite con `pg_get_expr`) | `DROP COLUMN role` no las rompe; no hay que reescribirlas. |
| ¿Quién lee o escribe `membership.role` hoy? | `queries/identidad.ts` (`listMyWorkspaces`, `isMemberOf`, `createCreatorWorkspace` inserta `'owner'`), `queries/ventas.ts` (`listOwnerOptions` filtra `role <> 'client'`), `lib/auth/reglas.ts` (`PUEDEN_RENOMBRAR`), `lib/auth/acciones.ts` (`w.role === 'owner'`), `lib/auth/messages.ts` (etiquetas), `cuenta/page.tsx`, los seeds 0002 y 0003, y las pruebas `rls`, `identidad` y `ventas` | La propuesta ACC decía «ningún código lo lee»; ya no es verdad desde CIM-3. El cambio de columna arrastra esos sitios (§0.4). |
| Guardia de esquema (`src/esquema.ts`, `test/schema.test.ts`) | Exige: cada tabla de `public` aislada o en `EXCEPCIONES_SIN_AISLAMIENTO`; cada excepción con entrada en `PRIVILEGIOS_DE_LA_APP`; toda clave ajena hacia una tabla con RLS, en una tabla que mc_app escribe, con el disparador `assert_reference_visible` (una **compuesta** se reporta salvo que esté en `REFERENCIAS_SIN_COMPROBAR_DECLARADAS`); todo índice único global en una tabla con RLS que mc_app escribe, declarado; y **cada columna de `src/schema`** existente en la base | Una tabla nueva **sin** esquema Drizzle NO rompe la guardia (solo se comprueba lo declarado), pero `membership.role` declarado en `schema/cimientos.ts` y borrado en la base SÍ la rompe. Las declaraciones nuevas van en `esquema.ts` (README de @mc/db, «Ciclo de una migración nueva», paso 5). |
| `politicas.ts`: qué acepta como «aísla» | `col = current_workspace_id()` solo si `col` es la columna de inquilino, o una FK a `workspace(id)` en una tabla sin columna de inquilino; `IS NULL OR …` solo en lectura y sobre la misma columna (patrón `feature_flag_read`); `EXISTS` correlacionado por una FK real | `role` (`workspace_id IS NULL` = sistema) usa el patrón de 0020; `workspace_grant` se aísla por sus dos FK a `workspace`; `role_permission` hereda de `role` por `EXISTS`. |
| `audit_log` hoy | `actor_kind` con CHECK `audit_log_actor_kind_check` (`user`,`system`,`job`,`webhook`); política `audit_log_ws_isolation` FOR ALL por `workspace_id`; mc_app con SELECT + INSERT (0025 §5); disparadores `ref_visible_workspace_id` y `ref_visible_actor_user_id`; **no está en `src/schema`** | La columna nueva lleva su disparador de referencia y no toca el esquema Drizzle. |
| Seeds 0002/0003 | Insertan `membership (…, role) VALUES (…, 'owner')` fijando antes `app.workspace_id` y `app.user_id`; corren DESPUÉS de las migraciones | El backfill no los cubre: el INSERT nombra una columna que ya no existe. Hay que tocar los dos seeds (§0.3, decisión 7). |
| Supabase (solo lectura, `make db.sql`) | `membership`: 1 fila, `owner`; `workspace`: 1, `creator`; aplicada hasta 0022 | El relleno de `admin`, `member`, `viewer` y `client` es teórico: la opción conservadora no cambia a nadie real. |
| ACC-1 | No está en `main`. Está en curso en `rayit-acc1` (plan en su §0 y `packages/core/src/permisos.ts` sin commitear): 43 permisos, 10 roles, script `scripts/permisos-sql.ts` todavía sin escribir | La semilla de 0034 se generó desde ese `permisos.ts` con un script desechable con el formato que ACC-1 promete (§0.3, decisión 6). Cuando ACC-1 llegue, su snapshot tiene que coincidir con el bloque de 0034, y `test/accesos.test.ts` pasa a importar `ROLES_SISTEMA`. |

### 0.2 Archivos

```
platform/db/migrations/0034_access_control.sql        NUEVO · la migración y la semilla (mía; revisa y aplica Rasheed)
platform/packages/db/src/schema/accesos.ts            NUEVO · esquema Drizzle PROPUESTO de las seis tablas (carpeta de Rasheed:
                                                               va en el PR porque schema.test.ts lo verifica columna a columna)
platform/packages/db/src/schema/cimientos.ts          membership.role → roleId (una columna; carpeta de Rasheed)
platform/packages/db/src/schema/index.ts              + export * from './accesos.ts'
platform/packages/db/src/esquema.ts                   declaraciones de la guardia para las tablas nuevas (paso 5 del ciclo del README)
platform/packages/db/src/queries/identidad.ts         role → role_id: listMyWorkspaces (JOIN role), isMemberOf, createCreatorWorkspace (Rasheed)
platform/packages/db/src/queries/ventas.ts            listOwnerOptions sin `m.role <> 'client'` (Rasheed; decisión D)
platform/packages/db/src/queries/accesos.ts           NUEVO · system_role_id/roles de sistema para leer (mío; lo usa ACC-5)
platform/packages/db/test/accesos.test.ts             NUEVO · la prueba de la historia
platform/packages/db/test/{rls,identidad,ventas}.test.ts   INSERT INTO membership con role_id (siete sitios)
platform/packages/db/test/aplicar.test.ts             la nota del hueco 0023
platform/packages/db/README.md                        § roles y permisos
platform/db/seed/0002_demo_ventas_metricas.sql        membership con role_id (Rasheed: una línea)
platform/db/seed/0003_demo_finanzas_campanas.sql      membership con role_id (mío)
platform/apps/web/lib/auth/messages.ts                etiquetas de los seis roles (Rasheed: un objeto)
platform/apps/web/content/backlog.ts                  solo la entrada ACC-3
docs/propuestas/ACC-3.md                              este documento
```

Lo que toca carpetas de Rasheed se hace aquí porque sin ello
`pnpm verificar` queda en rojo (la guardia exige que `src/schema`
coincida con la base, y las consultas de identidad no compilan sin la
columna nueva). Cada cambio es el mínimo para que compile y pase, va en
su propio commit y está listado en §6 para su revisión. **DECISIÓN
PENDIENTE DE NICOLÁS**: si prefiere que el esquema Drizzle NO viaje en
este PR, se quita `schema/accesos.ts` y se deja `membership.roleId` sin
`references()`; `test/accesos.test.ts` está escrito en SQL crudo y no
lo necesita.

### 0.3 Decisiones (con lo descartado y por qué)

1. **Relleno de `membership.role → role_id`, por `workspace.kind`.**

   | `role` viejo | creador | agencia |
   |---|---|---|
   | `owner` | Dueño | Dueño |
   | `admin` | **Mánager** | Administrador |
   | `member` | Editor | Ejecutivo de cuenta (`manager`) |
   | `viewer` | Solo lectura | Solo lectura |
   | `client` | Solo lectura | Solo lectura |

   `admin` en un workspace de creador no tiene equivalente: o sube a
   Dueño o baja a Mánager. Se toma **Mánager**: la regla conservadora es
   «el relleno nunca sube a nadie» (un Dueño de más puede cerrar la
   cuenta; un Mánager de menos se corrige desde ACC-4 en un clic). Hoy
   no existe ninguna fila `admin` en Supabase, así que la decisión no
   cambia a nadie. **DECISIÓN PENDIENTE DE NICOLÁS** (el prompt decía
   «→owner en creador» y a la vez «nunca subir a alguien»): cambiarlo
   es una línea del `CASE` de la sección 4 de la migración.
   `client → viewer` va con nota en la propia migración: decisión D, la
   marca no tiene cuenta; la fila, si existiera, queda como «solo
   lectura» hasta que alguien la quite. Un valor fuera de los cinco del
   CHECK de 0001 no puede existir; si existiera, la migración se para
   (`RAISE EXCEPTION`), no inventa un rol.

   El relleno corre como el rol que migra con `membership` en
   `NO FORCE ROW LEVEL SECURITY` solo durante el `UPDATE`, y lo
   devuelve en la misma transacción (patrón 0026/0032/0033): sin eso, la
   tabla no tiene política de UPDATE y el relleno tocaría cero filas en
   silencio. Después `SET NOT NULL` y `DROP COLUMN role`. Sin `DEFAULT`
   en `role_id`: el único valor por omisión defendible sería el más
   bajo, y `'member'` de 0001 tampoco lo usaba nadie; `createCreatorWorkspace`
   y los seeds dicen el rol explícitamente con `system_role_id()`.

2. **Privilegios de mc_app** (lo que no se puede tapar con RLS, 0024 §7):

   | Tabla | mc_app | Por qué |
   |---|---|---|
   | `permission` | SELECT | catálogo; lo llena la migración (como `job_definition`) |
   | `role` | SELECT | los de sistema los llena la migración; los a medida son ACC-9 (entonces: política de escritura por `workspace_id` + GRANT) |
   | `role_permission` | SELECT | ídem |
   | `membership_scope` | los cuatro, por RLS | tabla de inquilino: quitar un alcance es borrar la fila (no hay columna de estado) |
   | `invitation` | SELECT, INSERT, UPDATE | revocar es `revoked_at`; nadie borra el rastro de a quién se invitó |
   | `workspace_grant` | SELECT | fase 2 (AGE-1): la concesión la escribirá el worker o una función; desde la web solo se lee, por los dos extremos |

   mc_worker hereda los cuatro privilegios de todo lo nuevo por el
   `ALTER DEFAULT PRIVILEGES` de 0014 y se salta RLS: nada que hacer.

3. **RLS.** `membership_scope` e `invitation` por `workspace_id`
   (política de lectura y de escritura, WITH CHECK explícito). `role` con
   el patrón de `feature_flag` (0020/0025): `role_read` = «de sistema o
   mío», `role_seed` FOR INSERT `TO CURRENT_USER` (el rol que migra:
   `mc_migrator` en Supabase, `mc_migrator_embedded` en pglite) para la
   semilla, y ninguna política de escritura para mc_app hasta ACC-9.
   `role_permission` sin `workspace_id`: `EXISTS` sobre `role` (patrón
   0018); la semilla la inserta el migrador y pasa porque ve las filas de
   sistema. `workspace_grant`: `SELECT` si soy uno de los dos extremos
   (`grantor_workspace_id = current OR grantee_workspace_id = current`);
   la propuesta decía «sin RLS por workspace_id», pero la guardia exige
   aislar toda tabla que apunte a una con RLS, y aislar por los dos
   extremos es lo que la propuesta describe («se consulta por los dos
   extremos»). `permission` sin RLS: catálogo global, declarado en
   `EXCEPCIONES_SIN_AISLAMIENTO`. Todas con `ENABLE` + `FORCE`.

4. **UNIQUE parciales y CHECK, tal cual la fase 4**, más:
   - `invitation.token_hash` con `CHECK (token_hash ~ '^[0-9a-f]{64}$')`:
     la columna solo admite un SHA-256 en hexadecimal; el token en claro
     (base64url, de otra longitud) no cabe. Es la misma regla que CON-3
     para los secretos, hecha exigible por la base.
   - `invitation_token_hash_uk` UNIQUE sobre `token_hash`: la aceptación
     busca por el hash y un hash resuelve a una invitación. Es un único
     global en una tabla con RLS que mc_app escribe, así que va declarado
     en `UNICOS_GLOBALES_DECLARADOS` (chocar exige conocer el token, y
     conocerlo ya es tenerlo: mismo motivo que `connection_secret_pkey`).
   - `invitation_no_both` CHECK (`accepted_at IS NULL OR revoked_at IS NULL`):
     el índice parcial «una pendiente por correo» supone que no hay
     filas aceptadas y revocadas a la vez.
   - `membership_scope`: FK compuesta `(workspace_id, user_id) → membership`
     con `ON DELETE CASCADE` (quitar a alguien se lleva su alcance). La
     guardia no sabe comprobar visibilidad de una clave compuesta, así
     que va declarada en `REFERENCIAS_SIN_COMPROBAR_DECLARADAS` con el
     argumento: la política fija `workspace_id = current_workspace_id()`
     y `membership_read` muestra todas las membresías del workspace
     fijado, luego un par que pasa la FK es visible por construcción.
     Descartado: dos FK simples más (`workspace_id → workspace`,
     `user_id → app_user`) con sus disparadores, que serían redundantes
     con ese argumento.
   - `membership`: disparador `membership_role_fits` (función
     `assert_membership_role_fits()`, SECURITY INVOKER) que exige
     `role.workspace_kind = workspace.kind` y (`role.workspace_id IS NULL`
     o `= membership.workspace_id`). No está en la fase 4, pero sin él
     un rol de agencia se puede colgar de un workspace de creador y
     el relleno de la decisión 1 no tendría sentido. Error 23514 con
     mensaje en español.

5. **Re-ejecutable y se para si se aplica al revés.** Cada sentencia
   lleva `IF NOT EXISTS` / `DROP … IF EXISTS` / `CREATE OR REPLACE`; el
   relleno va en un `DO` que solo corre si la columna `role` todavía
   existe; los `ADD CONSTRAINT` van precedidos de `DROP CONSTRAINT IF
   EXISTS`; la semilla es `ON CONFLICT DO NOTHING`. Guardia de entrada
   (patrón 0024/0028): exige `0028_membership_alta_propia.sql` en
   `schema_migrations` (y con ella 0024 y 0025, que 0028 exige a su
   vez) y que exista `assert_reference_visible()`; si no, `RAISE
   EXCEPTION` con la instrucción. `test/accesos.test.ts` la corre dos
   veces y comprueba que la segunda no cambia nada.

6. **La semilla dentro de la migración** (precedente: `feature_flag` y
   `job_definition` en 0009), con `ON CONFLICT DO NOTHING` y en el orden
   del catálogo. Se generó desde `permisos.ts` de ACC-1 (estado del
   23-sep en `rayit-acc1`) con el formato que ACC-1 promete para
   `scripts/permisos-sql.ts` (decisión 10 de su plan): `permission (key,
   module, label_es, sensitivity)`, `role (workspace_id NULL, key,
   workspace_kind, label_es, description_es, is_system)` y
   `role_permission` resolviendo `role_id` con un `JOIN` por `(key,
   workspace_kind)`. Sin `DELETE` de lo que sobre: una migración
   aplicada es inmutable, así que un cambio de matriz será otra
   migración, que borrará lo que toque. **Contrato con ACC-1**: el
   snapshot de su script tiene que ser byte a byte el bloque de la
   sección 9 de 0034; su prueba lo hará cumplir cuando exista.
   `test/accesos.test.ts` lleva hoy la matriz esperada como fixture
   (`test/fixtures/accesos-matriz.ts`, generada del mismo archivo) con
   `TODO(ACC-1)`: cuando `@mc/core` exporte `ROLES_SISTEMA`, el fixture
   se borra y la prueba importa.

7. **Seeds 0002 y 0003.** El relleno NO los cubre (corren después y
   nombran la columna `role`). Cambian a `role_id` con
   `system_role_id('creator', 'owner')`, función STABLE de 0034 que
   cualquiera puede ejecutar y que solo ve roles de sistema por la
   política `role_read`. Es una línea por seed; la de 0002 es de
   Rasheed y va listada en §6. `make db.seed.check` (cuatro pasadas)
   sigue en verde.

8. **`system_role_id(workspace_kind, key)`** existe para que seeds,
   pruebas, `createCreatorWorkspace` y ACC-4 no repitan el `SELECT id
   FROM role WHERE workspace_id IS NULL AND …`. Va en
   `FUNCIONES_QUE_USA_EL_CODIGO` de la guardia (existe y mc_app la puede
   ejecutar) con `GRANT EXECUTE` explícito como `brand_key` en 0031.

9. **`audit_log`**: `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT` con
   `'delegate'`; `ADD COLUMN IF NOT EXISTS on_behalf_of_workspace_id`
   con `ON DELETE SET NULL` y su disparador `ref_visible_…` (mc_app
   tiene INSERT). Significado, fijado en `COMMENT ON COLUMN`: el
   workspace **por cuya concesión** actúa quien escribe (la agencia),
   cuando `actor_kind = 'delegate'`; `workspace_id` sigue siendo el
   inquilino de los datos (el creador). Lo llenará ACC-2/AGE-2; hoy nadie
   lo escribe.

10. **Sin dependencias nuevas.** Todo es SQL, Drizzle y `node --test`.

### 0.4 Blast radius del `DROP COLUMN role` (lo que la propuesta no vio)

`MembershipRole` pasa a ser `RoleKey` (`owner | admin | manager | editor
| finance | viewer`, en `schema/accesos.ts`) y `listMyWorkspaces` lo
lee con un `JOIN role`, así que `PUEDEN_RENOMBRAR` (`owner`, `admin`),
`acciones.ts` (`w.role === 'owner'`) y las pruebas de la web que
falsifican `role: "owner"` siguen valiendo sin tocarse. Cambian:
`messages.ts` (las etiquetas de los seis roles, en vez de las cinco
viejas), `identidad.ts` (tres funciones), `ventas.ts`
(`listOwnerOptions`: el filtro `role <> 'client'` desaparece; decisión
D), los dos seeds y siete `INSERT` de pruebas.

### 0.5 Dudas que no bloquean

- **Cómo acepta una invitación quien todavía no es miembro** (ACC-4).
  `invitation` lleva RLS por `workspace_id` y quien acepta no tiene ese
  workspace fijado. Dos caminos, los dos fuera de esta historia: (a) una
  función SECURITY DEFINER `invitation_accept(token_hash)` que corra como
  un rol acotado, patrón 0030 (`mc_public_share`); (b) hacerlo desde el
  worker. Descartado aquí: una política `email = current_user_email()`
  sobre `invitation`, porque la guardia solo acepta esa forma en
  `app_user` y habría que declararla abierta. Ver §5.
- **`0023` queda como hueco declarado.** La alternativa es una migración
  vacía `0023_reservada.sql`; no se hace sin preguntar.

---

## 1. La migración, sección por sección

(Se completa al cerrar.)

## 2. El esquema Drizzle propuesto

(Se completa al cerrar.)

## 3. Orden en la cola del integrador

(Se completa al cerrar.)

## 4. Lo que ACC-4 (Rasheed) necesita saber

(Se completa al cerrar.)

## 5. Lo que ACC-5 va a exponer

(Se completa al cerrar.)

## 6. Lo que toca carpetas de Rasheed, archivo por archivo

(Se completa al cerrar.)
