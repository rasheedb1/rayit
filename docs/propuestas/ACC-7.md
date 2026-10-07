# ACC-7 · El alcance por creador también en la base

> Historia ACC-7 (épico ACC, sprint 6). Rama `rasheed/ACC-7-rls-por-creador`.
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
| `session_sees_all_creators()` | ¿La persona ve a todos los creadores? Sí sin alcance por creador, y sí con rol **Dueño** o **Administrador** de fábrica aunque alguien le hubiera dejado una fila de alcance. Envuelta en `(SELECT …)`: se evalúa una vez por consulta, no por fila. |
| FOR ALL, sin WITH CHECK | La fila nueva de un INSERT o un UPDATE pasa por la misma condición: nadie crea ni mueve una fila a nombre de un creador que no ve (42501). |
| TO mc_app | Solo la web, que trabaja en nombre de una persona. |

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
| `findPublicAccountByHandle` (el @ ya es de otra creadora) | ningún índice | `public_account_out_of_scope(platform, handle)` (0082 §3): SECURITY DEFINER que responde solo sí o no, atada al espacio fijado, solo para mc_app. Declarada en `FUNCIONES_DEFINER_DECLARADAS` |

`upsertConnection` y `addPublicAccount` no cambiaron: su `ON CONFLICT DO
UPDATE … WHERE <alcance>` evalúa el WHERE antes que la política, así que
siguen devolviendo cero filas y `ScopeError`.

## La guardia

`packages/db/src/esquema.ts` declara `TABLAS_CON_ALCANCE_POR_CREADOR` y
exige en cada arranque que cada tabla tenga una política RESTRICTIVE que
alcance a mc_app, FOR ALL, sin WITH CHECK y con exactamente la forma de
arriba. Si falta, `alcancePorCreador` la nombra y `explicarEsquema` lo
dice; en producción la web no arranca. Una restrictiva borrada no abre la
tenencia, así que ninguna otra comprobación lo habría visto.
`session_sees_all_creators()` va en `FUNCIONES_QUE_USA_EL_CODIGO`.

## Pruebas (`packages/db/test/alcance-rls.test.ts`, pglite)

- Consulta cruda, sin `scopeFilter()`, como el miembro con alcance a
  Laura: en las cuatro tablas ninguna fila de Sofía (ni por id, ni en un
  conteo) y sí las de Laura; la dueña y el modo demo lo ven todo; vistas
  (`creator_post_board`, `connection_health`) y JOIN heredan el filtro.
- Escrituras crudas: no crea campaña ni negocio de Sofía, no pasa una
  campaña de Laura a Sofía (42501), y UPDATE/DELETE sobre filas de Sofía
  tocan cero filas.
- Roles: en una agencia, Dueña y Administradora (con una fila de alcance
  olvidada) ven a los dos creadores; el Ejecutivo acotado, solo al suyo.
  Un alcance por marca no acota en la base.
- Worker y enlace público, como arriba. `public_account_out_of_scope` y
  `writeOrScopeError`, sus ramas.
- La guardia: en verde con 0082; sin la política de `deal` nombra la
  tabla **y** la consulta cruda vuelve a enseñar el negocio de Sofía (la
  prueba muerde); cinco variantes mal formadas (permisiva, `USING (true)`,
  solo SELECT, con WITH CHECK, para otro rol) también se reportan; volver
  a correr 0082 la deja como estaba.

## Pendiente

- **Aplicar 0082 en Supabase antes de desplegar** (`make db.migrate`,
  `make db.guardia`). Sin ella la guardia de producción no deja arrancar.
- Ventas y Cotizar todavía no componen `scopeFilter()` (CIERRE-ACC §5.4).
  Para quien esté acotado por creador, la base ya les quita los negocios
  de otros creadores; crear un negocio **sin** creador (o de otro) le dará
  un 42501 en vez de un mensaje: hoy nadie tiene filas de alcance, pero el
  día que ACC-4 las escriba, esas pantallas tienen que traducirlo.
- Otras tablas con `creator_id` (`quote`, `data_consent`, ideas y
  guiones) siguen solo con `scopeFilter()`. Ampliarlas es una política y
  una entrada más en la lista de la guardia.
