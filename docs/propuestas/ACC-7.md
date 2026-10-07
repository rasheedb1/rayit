# ACC-7 · El alcance por creador también en la base

> Historia ACC-7 (épico ACC, sprint 6). Ramas `rasheed/ACC-7-rls-por-creador`,
> `rasheed/ACC-7-rls-por-creador-r2` (los once hallazgos de la ronda 1),
> `rasheed/ACC-7-rls-por-creador-r3` (los trece de la ronda 2) y
> `rasheed/ACC-7-rls-por-creador-r4` (los diecinueve de la ronda 3).
> 7 de octubre de 2026. Migración `0082_alcance_por_creador.sql`, **sin
> aplicar**: la aplica el integrador, y **antes** de desplegar (la guardia
> del esquema la exige y la web no arranca sin ella).

## Qué cierra

Desde ACC-6 el alcance dentro de un espacio —una agencia con varios
creadores, un mánager que solo lleva a algunos— lo pone cada consulta de
`@mc/db` con `scopeFilter()`, y una prueba por módulo recorre las
funciones exportadas. Una consulta **cruda** que no lo compone (una vista
nueva, Ventas/Cotizar/Resumen, que aún no lo componen, un SELECT escrito
deprisa) veía a todos los creadores del espacio.

Ahora `social_connection`, `post`, `campaign` y `deal` llevan, además de la
política de su workspace, una política **RESTRICTIVE** por creador:

```sql
CREATE POLICY <tabla>_creator_scope ON <tabla> AS RESTRICTIVE FOR ALL TO mc_app
  USING ((SELECT session_sees_all_creators()) OR scope_allows('creator', creator_id));
```

| Pieza | Qué hace |
|---|---|
| RESTRICTIVE | Se suma con AND a la de workspace: las dos condiciones, nunca una u otra. No abre nada. |
| `scope_allows('creator', creator_id)` | El mismo predicado de `scopeFilter()` (0040): sin filas de alcance por creador, todo; con ellas, solo esos; un `creator_id` NULL no cae en ningún alcance. |
| `session_sees_all_creators()` | ¿La persona no tiene alcance por creador? Es, letra por letra, `NOT scopeHas('creator')` de `scope.ts`. Envuelta en `(SELECT …)`: se evalúa una vez por consulta, no por fila. |
| FOR ALL, sin WITH CHECK | La fila nueva de un INSERT o un UPDATE pasa por la misma condición: nadie crea ni mueve una fila a nombre de un creador que no ve (42501). |
| TO mc_app | Solo la web, que trabaja en nombre de una persona. Y solo ella: la guardia rechaza TO PUBLIC (ver abajo). |

## Una sola regla de «quién ve a todos» (ronda 2, hallazgos 1 y 7)

La ronda 1 eximía en la base a Dueño y Administrador aunque tuvieran una
fila de alcance; `scopeFilter()` y `session_has_scope()` (0079, Equipo)
no. La misma persona recibía tres respuestas. Ahora hay una:

- **Ve a todos quien no tiene filas de alcance por creador.** Es lo que
  preguntan la política, `scopeFilter()` y, para cualquier tipo,
  `session_has_scope()`.
- **Dueño y Administrador no pueden tener alcance** (0082 §2). Un
  disparador rechaza una fila de `membership_scope` (de cualquier tipo)
  para una de esas membresías, y el cambio de rol a Dueño o Administrador
  de quien tiene alcance (`check_violation`, restricción
  `membership_full_role_unscoped`). Si la base ya tuviera filas así, la
  migración se para con un mensaje claro. «Es Dueño o Administrador» es
  una función, `role_is_full_access(role_id)`, que preguntan el
  disparador, esa comprobación previa y Equipo (ronda 4, hallazgo 9).
- Un rol a medida ve a todos igual que cualquiera: si no tiene filas.

Se eligió prohibir el caso (opción B de la revisión) y no repetir la
excepción por rol en los tres sitios (opción A) porque la opción A dejaba
la regla escrita con las claves `'owner'`/`'admin'` en tres lugares, y
`session_has_scope()` es de 0079, que ya está integrada. Probado: para la
dueña y la administradora de la agencia, el ejecutivo acotado, la dueña de
un espacio de creador y el miembro acotado, los ids de `listCampaigns()`
y los de un `SELECT id FROM campaign` crudo son iguales, y
`session_has_scope()` coincide con la política.

## A quién no toca

- **El worker** (`mc_worker`, BYPASSRLS): no pasa por políticas.
- **Los enlaces públicos** (`mc_public_share`, 0030): sus funciones
  SECURITY DEFINER leen y mueven `deal` sin sesión. Con una política `TO
  PUBLIC`, ese rol habría necesitado leer `membership_scope` y ejecutar
  estas funciones, y la aceptación pública de una cotización habría caído
  con «permission denied». Probado: la marca acepta por el enlace la
  cotización de un negocio de Sofía y el negocio pasa a Ganado.
- **El modo demo** (sin persona): no hay filas de alcance, se ve todo.
- **Los alcances por marca y por campaña**: siguen siendo de
  `scopeFilter()`. Una cuenta conectada no tiene camino a una marca (ACC-6
  D3); la red de la base es para el tipo que tiene columna.

## Qué cubre la red, con exactitud (hallazgo 2)

| Cubre | Por qué |
|---|---|
| las cuatro tablas | su política |
| `campaign_post`, `deal_stage_history`; `api_call_log` y `api_quota_usage` en las filas con cuenta | su política de workspace es un EXISTS sobre una de las cuatro |
| `creator_post_board`, `connection_health`, `deal_pipeline`, `second_by_second` | vistas con `security_invoker` sobre ellas |

| **No** cubre | Sigue con |
|---|---|
| métricas: `post_metric_snapshot`, `account_metric_snapshot` y las vistas `post_metrics_*` | su workspace y `scopeFilter()` donde se compone |
| dinero: `quote` (con su total), `invoice`, `payment` | ídem |
| `data_consent` y las demás tablas con `creator_id` propio | ídem; cada una declarada con su motivo |

Una prueba lo fija en los dos sentidos: el miembro acotado no ve el
historial ni la fila de `deal_pipeline` del negocio de Sofía, y **sí** ve
la métrica de su post y su cotización. El día que ACC-10 cierre eso, la
prueba falla y se da la vuelta. Extender la red es la historia **ACC-10**
del backlog.

## Lo que la política esconde y el código necesitaba

ACC-6 buscaba **sin** filtro «la fila ya existe, pero no es tuya» antes de
escribir, para decir `ScopeError` en vez de chocar con un índice o
duplicar una cuenta (ACC-6 §6, hallazgos 1, 2, 6 y 7). Con la política esa
búsqueda ya no ve la fila: las pruebas de ACC-6 lo encontraron en tres
sitios, y se arreglaron sin cambiar lo que devuelven:

| Dónde | Quién sabe que la fila existe | Cómo se dice |
|---|---|---|
| `createCampaignFromQuote` (campaña viva de la cotización, de otra creadora) | el índice `campaign_quote_id_active_key` | `writeOrScopeError` (src/scope.ts): la escritura va en un SAVEPOINT; si choca con esa restricción y la persona está acotada por creador, es `ScopeError` y la transacción sigue usable. Para quien ve a todos, el choque se relanza tal cual |
| `upgradePublicAccountToOAuth` (el open_id ya es de una cuenta de otra creadora) | el UNIQUE `(platform_id, external_account_id, workspace_id)` | `writeOrScopeError`, igual |
| `findPublicAccountByHandle` (el @ ya es de otra creadora) | ningún índice | `public_account_out_of_scope(platform, handle)` (0082 §4): SECURITY DEFINER que responde solo sí o no, atada al espacio fijado, solo para mc_app. Declarada en `FUNCIONES_DEFINER_DECLARADAS` |

El nombre del SAVEPOINT de `writeOrScopeError` es una unión de literales
(`ScopeSavepoint`) y además se valida contra `/^[a-z_][a-z0-9_]{0,62}$/`
antes de escribir nada (hallazgo 5). Los errores de Postgres se buscan con
`findPgError()` de `src/pg-error.ts`, sobre `findInCauseChain()`: desde la
ronda 4 es el único recorrido de `cause` que busca un error de Postgres,
en @mc/db y en la web (la guardia, la identidad de la sesión y la lectura
de marca de Campañas lo usan también).

## Ventas y Cotizar con la red puesta (hallazgos 6 y 8)

Ventas creaba todos sus negocios con `creator_id` NULL, y la política
trata un NULL como fuera de cualquier alcance: un Ejecutivo de cuenta
acotado no habría podido abrir un negocio, aceptar una señal ni pasar una
respuesta de outreach a negocio. Ahora:

- **Las tres altas ponen el creador.** `createDeal` y `acceptSignal` con
  `creatorForNewDeal()`: el elegido (que tiene que ser del espacio,
  `InvalidCreator`, y de su alcance, `ScopeError`) o el único de
  `listDealCreatorOptions()`; con varios y acotado,
  `DealCreatorRequired`; acotado a creadores dados de baja,
  `NoCreatorInScope`; con varios y sin alcance, sin creador, como hasta
  hoy. La respuesta de outreach (`openDealFromReply`) es del creador de la
  cuenta que la envió o del brief de su cadencia (`originCreatorOf`,
  ronda 4); sin creador de origen, de `sole_creator_for_session()`; y si
  quien corrige desde la bandeja está acotado y no hay uno solo, no abre
  el negocio (ver ronda 3).
- **«Nuevo negocio» pregunta de quién es** cuando hay más de un creador
  para elegir (`listDealCreatorOptions`): opcional para quien ve a todos,
  obligatorio para quien está acotado a varios.
- **El 42501 de la política se dice en español.** `scopeErrorOf()`
  reconoce el `row-level security policy "<tabla>_creator_scope"` de las
  cuatro tablas (y un `ScopeError`); Ventas (`messageOf`) y Cotizar
  (`codigoDe`, código `ScopeError` en la URL) muestran
  `ScopeError.messageEs`. Otro 42501 sigue siendo el genérico.

## La guardia (hallazgos 2, 3 y 9)

`packages/db/src/esquema.ts` exige en cada arranque, en `alcancePorCreador`:

- que las cuatro tablas (`TABLAS_CON_ALCANCE_POR_CREADOR`, con las mismas
  claves que `CREATOR_SCOPE_TABLES` por tipo) tengan una política
  RESTRICTIVE, FOR ALL, sin WITH CHECK, con exactamente la forma de
  arriba y con `polroles` exactamente `{mc_app}`. Con la forma pero TO
  PUBLIC (o con otro rol además), la tabla sale con «debe ser TO mc_app, y
  solo mc_app: TO PUBLIC rompe los enlaces públicos (0030)»: esa política
  acotaría a la web igual, y por eso es la que más engaña;
- que **toda** tabla de `public` con columna `creator_id` esté en esa
  lista o en `TABLAS_CON_CREADOR_SIN_POLITICA`, con su motivo: una tabla
  nueva con `creator_id` no queda fuera de la red sin que nadie lo decida;
- que el cuerpo de `session_sees_all_creators()`, de las dos
  `scope_allows()`, del disparador, de `role_is_full_access()`, de
  `creators_for_session()` y `sole_creator_for_session()`, y de las tres
  SECURITY DEFINER que responden sí o no (`public_account_out_of_scope`,
  `open_deal_out_of_scope`, `deal_creator_locked`) sea el de su migración
  (`CUERPOS_DEL_ALCANCE`, md5 de `prosrc` con los espacios normalizados).
  Un `CREATE OR REPLACE … SELECT true` (o `SELECT false`) desde el SQL
  Editor apagaba la red con las políticas intactas; ahora la guardia lo
  nombra;
- y los dos disparadores de §2, en `DISPARADORES_DE_CANDADO`.

## Pruebas (`packages/db/test/alcance-rls.test.ts`, pglite)

- Consulta cruda, sin `scopeFilter()`, como el miembro con alcance a
  Laura: en las cuatro tablas ninguna fila de Sofía (ni por id, ni en un
  conteo) y sí las de Laura; la dueña y el modo demo lo ven todo; vistas y
  JOIN heredan el filtro; lo que no cubre, también fijado.
- Escrituras crudas: no crea campaña ni negocio de Sofía, no pasa una
  campaña de Laura a Sofía (42501, que `scopeErrorOf` traduce), y
  UPDATE/DELETE sobre filas de Sofía tocan cero filas.
- Una sola regla: `listCampaigns()` y el SELECT crudo dan los mismos ids
  para cinco personas; la base rechaza el alcance de Dueño y
  Administrador (cualquier tipo), el cambio de rol a Administrador de
  quien lo tiene, mover la fila a la administradora, y una fila cuya
  membresía la transacción no ve.
- Ventas: el ejecutivo acotado abre un negocio y lo ve en el pipeline;
  acepta una señal y el negocio es de su creador; con dos creadores tiene
  que elegir y no puede elegir uno de fuera; la dueña de la agencia puede
  dejarlo sin creador; en un espacio de una sola creadora, es suyo.
- Worker y enlace público, como arriba. `public_account_out_of_scope`,
  `writeOrScopeError` (y un SAVEPOINT inválido que no llega al SQL).
- La guardia: en verde con 0082; sin la política de `deal` nombra la
  tabla **y** la consulta cruda vuelve a enseñar el negocio de Sofía;
  cinco variantes mal formadas también se reportan; una tabla nueva con
  `creator_id` sin declarar; y tres sondas que reescriben
  `session_sees_all_creators()`, `scope_allows()` y el disparador para
  que no acoten. Volver a correr 0082 (y 0040) lo deja como estaba.
- Web: `ventas/actions.test.ts`, `cotizar/actions.test.ts` y
  `ventas/empresas/[id]/negocio.test.tsx`.

## Ronda 3: los trece hallazgos de la ronda 2

| # | Qué | Cómo quedó |
|---|---|---|
| 1, 9 | «Corregir intención → Me interesa» desde la bandeja, acotada a varios creadores: 42501 y el genérico; y un segundo negocio con la marca si el abierto era de otro creador | `reclassifyInboxMessage` pregunta antes (`interestedOutOfScope`): si el mensaje apunta a un negocio que no ve, o la marca solo tiene abierto uno que no ve (`open_deal_out_of_scope`, 0082 §6, sí o no), devuelve `out_of_scope` sin tocar nada. Si hay que abrir uno y no se sabe de qué creador, la intención queda escrita y el negocio no se abre (`dealNeedsCreator`): la bandeja dice «ábrelo desde la ficha y elige». La acción traduce además `scopeErrorOf()`. Se tomó la forma del hallazgo 9 (marcar y no abrir) y no la del 1 (`creator_required`, sin marcar): la persona sí sabe que la respuesta es de interés; lo que no sabe la base es de quién es el negocio |
| 2, 8 | Equipo no reconocía `membership_full_role_unscoped` | `changeMemberRole` lo pregunta antes (`scoped_member`) y, si llega entre la pregunta y el UPDATE, lo reconoce con `isFullRoleUnscopedError()` dentro de un SAVEPOINT. Texto en `accesos/_lib/messages.ts`. Pruebas en `equipo.test.ts` y `accesos/actions.test.ts` |
| 3, 7 | El selector y el alta contaban distinto con un alcance a un creador borrado | Una sola lista en la base: `creators_for_session(ws)` (0082 §1b) cruza con `creator_profile` vivo del mismo espacio; `sole_creator_for_session(ws)` cuenta de ella. `listDealCreatorOptions` lee `session_sees_all_creators()` en su propia consulta (sin filas no hay «primera fila»). Casos: [borrado, vivo] nace del vivo; [borrado] solo, `NoCreatorInScope` y «Nuevo negocio» desactivado con su motivo |
| 4, 12 | `soleCreatorSql()` armaba SQL con `replace` e interpolaba el espacio | Ya no existe: es la función SQL `sole_creator_for_session(ws uuid)`, con su md5 en `CUERPOS_DEL_ALCANCE`, y `soleCreatorFor(tx, workspaceId)` la llama con el espacio como parámetro. No queda SQL que interpolar ni que probar como texto |
| 5, 10 | Los negocios de antes, con `creator_id` NULL, invisibles para el primer mánager acotado | 0082 §5: en cada espacio con UN creador vivo, `deal` y `campaign` sin creador pasan a ese creador. Quita FORCE un momento (como 0026, 0032, 0033, 0044) y apaga `deal_updated` y `campaign_updated` durante el UPDATE para no tocar `updated_at`. Probado: el mánager acotado no lo veía y después sí; el de una agencia con varios sigue sin creador; las tablas vuelven a tener FORCE y los disparadores, encendidos |
| 6 | El creador de un negocio no se veía ni se cambiaba | El pipeline (tarjeta, lista y fila móvil) y la ficha dicen el creador cuando la persona ve a más de uno, y «Sin creador» siempre, con «solo lo ve quien ve a todos». En la ficha, «Cambiar» abre un selector (`setDealCreator`: mismas reglas que el alta; «Sin creador» solo para quien ve a todos; bitácora `deal.creator_changed`). Y la ficha dice cuando la marca tiene negocios abiertos que la persona no ve (`hasOpenDealOutOfScope`) |
| 11 | La guardia de §2 leía como el migrador, sin espacio y con FORCE: nunca veía filas | Quita FORCE a `membership_scope`, `membership` y `role` solo para esa pregunta, como en §5. Se eligió eso y no recorrer los espacios con `set_config`: para recorrerlos hay que leer `workspace`, que también tiene FORCE, y un `set_config` no ayuda con una política que no aplicara al migrador. Si el migrador no fuera dueño, el ALTER falla en voz alta. Probado: con una fila de alcance de una Dueña sembrada saltándose el disparador, volver a aplicar 0082 se para |
| 13 | `scopeErrorOf()` repetía el recorrido de `cause` | `findPgError(err, code, constraint?, matches?)`: un predicado opcional para lo que Postgres solo dice en el mensaje |

## Ronda 4: los diecinueve hallazgos de la ronda 3

Varios hallazgos llegaron dos veces (los dos revisores): se agrupan.

| # | Qué | Cómo quedó |
|---|---|---|
| 1, 13 | En una agencia, el «me interesa» del worker abría el negocio sin creador, y el mánager acotado no veía el pipeline de su propio outreach | `originCreatorOf(tx, messageId, ws)` (outreach/intent.ts): el creador de la cuenta de envío del mensaje, si no el de la cuenta de su toque, si no el del brief de su cadencia; el primero que sea un creador vivo del espacio. `openDealFromReply` lo usa antes que `sole_creator_for_session()`. Si la sesión no lo puede poner (quien corrige está acotado a otro creador), la bandeja dice `out_of_scope` antes de tocar nada (`interestedOutOfScope`) en vez de abrirlo a nombre de otro. Pruebas: el worker abre el de la cuenta de A a nombre de A y el ejecutivo acotado a A lo ve en `listPipeline`; el brief de la cadencia de B decide cuando no hay cuenta; con una cuenta del espacio, como antes; el ejecutivo acotado a A no abre lo que llegó por la cuenta de B; acotado a dos, la cuenta ya dice de quién es |
| 2, 11 | La guardia aceptaba la política con su forma pero TO PUBLIC | `SQL_POLITICAS` lee `solo_app` (`polroles = ARRAY[to_regrole('mc_app')]`) y `esPoliticaPorCreador` lo exige. Con la forma y otros roles, la tabla sale con su motivo. La prueba de variantes añade TO PUBLIC y TO mc_app + otro rol |
| 3, 10 | `public_account_out_of_scope` no tenía el cuerpo fijado | En `CUERPOS_DEL_ALCANCE`, con `open_deal_out_of_scope`, `deal_creator_locked` y `role_is_full_access`. La prueba de sondas reescribe las cuatro a `false` y comprueba que la del @ muerde (deja de avisar por el @ de Sofía) |
| 4, 15 | El foco caía a `<body>` al cerrar el selector de creador; `aria-expanded={false}` fijo | `creador-negocio.tsx` devuelve el foco a «Cambiar» al cancelar y al guardar (un efecto cuando `open` pasa a falso), o al renglón del creador si el botón ya no está; sin `aria-expanded`. Dos pruebas de componente |
| 5, 17 | `dealId` mal formado decía «La empresa no es válida.» | `V.deal`: «Ese negocio no es válido.» Probado en `ventas/actions.test.ts` |
| 6, 18 | Una constante entre los `import` de `_pipeline/vista.tsx` | `SIN_CREADOR`, debajo del último import |
| 7, 19 | La nota del backlog era un párrafo con tres rondas | Dos frases; el detalle, aquí |
| 8 | Quedaban tres recorridos de `cause` además de `findPgError` | `findInCauseChain()` en `pg-error.ts` (con un tope de eslabones) y `findPgError` encima. La guardia (`codigoDeError`), `identidad.ts` (`esOtroCorreo`) y la lectura de marca de Campañas (`esSinPrivilegio`, una línea en la carpeta de Nicolás) lo usan |
| 9 | «Dueño o Administrador» escrito cuatro veces | `role_is_full_access(role_id)` en 0082 §2 (0082 sigue sin aplicar, así que va en ella y no en una migración nueva): la llaman el disparador, la comprobación previa y `equipo.ts`. Su md5, en la guardia |
| 12 | `setDealCreator` partía un acuerdo: el negocio de B con la cotización y la campaña de A | `deal_creator_locked(deal, creador)` (0082 §7, SECURITY DEFINER de sí o no, como §4 y §6): una cotización no borrador o una campaña no cancelada de un creador distinto del nuevo bloquea el cambio con `VentasError('DealCreatorLocked')` y su texto en Ventas. Pasar AL creador de la cotización sí se deja (pone en orden un «Sin creador»). Es DEFINER porque la campaña de otro creador no se ve con la política: probado con un ejecutivo que no ve la campaña de B y aun así no puede pasar a E el negocio de A |
| 14 | `dealNeedsCreator` mandaba a «Nuevo negocio» a quien lo tiene desactivado | `dealNeedsCreator: 'pick' \| 'none' \| null`. `'none'` (acotado solo a creadores dados de baja) tiene su texto, sin «Nuevo negocio». Probado en pglite y en la acción de la bandeja |
| 16 | Nada de ACC-7 se podía ver en la demo | Seed `0013_demo_agencia.sql` y `verify/0013.sql`: ver «Cómo verlo» |

## Cómo verlo

El seed `0013_demo_agencia.sql` deja «Agencia Norte · demo»
(`00000013-0000-4000-8000-000000000001`): Camilo Rey y Mariana Gil,
Valentina Ortiz (Dueña) y Diego Salas (Ejecutivo de cuenta, acotado a
Camilo); cinco negocios (dos de cada creador, uno «Sin creador», y Fresko
Market con uno de cada uno) y una campaña de cada creador. Sin fechas: no
envejece ni lo toca el worker. `node db/seed/verify/run.mjs 0013`
comprueba el escenario y, con las mismas funciones que la política, qué
ve cada persona.

- **Como quien ve a todos, sin llaves:**
  `DEMO_WORKSPACE_ID=00000013-0000-4000-8000-000000000001 pnpm --filter @mc/web dev --port 3105`.
  Ventas › Pipeline enseña el creador en cada tarjeta (fila móvil a 400 px
  incluida) y «Sin creador» en el de Nutrivé; la ficha de Nutrivé, «Sin
  creador · Solo lo ve quien ve a todos» y «Cambiar»; «Nuevo negocio»,
  el selector con los dos creadores. El modo demo no lleva persona en las
  pantallas (lib/permisos/sesion.ts), así que siempre es la vista de quien
  ve a todos.
- **Como el ejecutivo acotado:** con Supabase Auth y el seed aplicado
  (`make db.seed`), entrar como `diego@agencia-demo.test` con
  `generate_link` (apps/web/README.md, «Cómo probarlo sin esperar un
  correo»). Ve solo lo de Camilo; la ficha de Fresko Market dice que la
  marca tiene negocios que él no ve; «Nuevo negocio» no pregunta (solo
  tiene a Camilo). `valentina@agencia-demo.test` es la dueña.

## Pendiente

- **Aplicar 0082 en Supabase antes de desplegar** (`make db.migrate`,
  `make db.guardia`). Sin ella la guardia de producción no deja arrancar.
  Y `make db.seed` si se quiere la agencia de demo (0013) en Supabase.
- El modo demo sin llaves no puede enseñar la vista acotada: las
  pantallas corren sin persona (`DEMO_USER_ID` solo cambia los permisos
  del marco). Llevar la persona simulada a las transacciones de las
  pantallas es un cambio de `lib/permisos` y `lib/db`, fuera de ACC-7.
- **ACC-10** (backlog): extender la red a las métricas
  (`post_metric_snapshot`, `account_metric_snapshot`, por EXISTS sobre
  `post` o `social_connection`), a `quote` (por su `creator_id`), a
  `invoice` y `payment` (por EXISTS sobre `campaign`) y a `data_consent`.
- Ventas, Cotizar y Resumen todavía no componen `scopeFilter()` en sus
  lecturas (CIERRE-ACC §5.4). Para el alcance por creador la base ya
  filtra las cuatro tablas; el de marca y campaña sigue pendiente ahí.
- La pantalla que escriba `membership_scope` (CIERRE-ACC §5.6) tiene que
  traducir `membership_full_role_unscoped` al dar alcance a un Dueño o un
  Administrador (el cambio de rol ya lo traduce Equipo: `scoped_member`).
- Al aplicar 0082 en Supabase, el NOTICE de §5 dice cuántos negocios y
  campañas pasaron a su creador; los de agencias con varios creadores
  quedan «sin creador» y se asignan desde la ficha.
