# Cierre de CON, parte B · La pantalla Conexiones

Escrito para: Nicolás (dueño del módulo) y Rasheed (dueño de
`db/migrations/`, `lib/auth/`, `lib/workspace/` y del hosting del worker).
Fecha: 23 de septiembre de 2026. Rama `nicolas/CON-B-pantalla`,
worktree `rayit-cierre-con-b`, salida de `origin/main` = `2a388d6`.

**Terminado cuando** (prompt CON-B): CON-4 «hecho» en `main` y en
producción, con cada clase de fila probada. **Sin migración.**

---

## 0. Inventario (F0)

La foto del bloque común, refrescada con `git fetch` al empezar:

| Qué | La foto decía | Lo que había |
|---|---|---|
| `origin/main` | `cf90d57` | **`2a388d6`**: ya entraron P0, los cierres de CAM, CON-A y FIN |
| Producción | `7737b62` | La de FIN (`0bd7107`, CIERRE-FIN.md §9) |
| Supabase | 0001–0039 | Igual; CON-B no trae migración |
| `nicolas/CON-4-pantalla-conexiones` | 12 commits, 176 detrás | 12 commits propios, **248** detrás |

Lo que había de cada historia que toca `/conexiones`:

| Historia | Dónde | Qué le faltaba para su «terminado cuando» en esta pantalla |
|---|---|---|
| CON-4 · Pantalla Conexiones | Rama `nicolas/CON-4-pantalla-conexiones` (GitHub) | Todo: no estaba en `main`. La rama era de antes de CON-5, CON-7, ACC-2, ACC-5 y ACC-8 |
| CON-5 · Conteo de posts | `main` | Nada: la fila ya decía «N en seguimiento» y «publicaciones hasta el …». Había que llevarlo a la tabla de CON-4 |
| ACC-8 · «Conectada por» | `main` | Nada propio; lo mismo: llevarlo a la tabla nueva sin perder el aviso `connection_added` |
| CON-7 · Huecos de demografía | `main` (0039 aplicada) | **La pantalla no leía `metric_gap`**: `getAccountAudience` existía para RES-4 pero ninguna fila de `/conexiones` decía qué faltaba ni por qué |
| ACC-5 · Puertas | `main` | Layout y página con `requireModuleAccess`; los botones se enseñaban igual a un rol que solo ve |
| ACC-2 · Bitácora | `main` | `audit()` ya vive en cada consulta de conexiones; CON-4 traía tres `TODO(ACC-2)` que habían quedado viejos |

**Plan.** Un solo merge (`--no-ff`) de la rama de CON-4, resolviendo a
favor de `main` y reaplicando encima lo de CON-4; después las costuras
con su prueba, las deudas (`TODO(ACC-2)`, el 500 del `POST …/start`
sin permiso), la verificación en dev con una fila de cada estado y la
salida a producción.

---

## 1. El merge (F1)

`git merge --no-ff origin/nicolas/CON-4-pantalla-conexiones`. Seis
conflictos, todos resueltos con la regla del prompt: **la fila final
lleva todo lo de `main` más el estado, el acceso y la frescura de
CON-4, y las funciones puras de CON-4 son la fuente.**

| Archivo | Conflicto | Cómo quedó |
|---|---|---|
| `packages/db/src/queries/conexiones.ts` | `AccountRow` y `listAccounts`: `main` añadió `connectedBy`, `postsCount` y `lastPostSnapshotAt` (ACC-8, CON-5); CON-4 añadió `followersDelta7d` y cambió la subconsulta de hace siete días por un `LATERAL` | Todo junto: los campos de `main`, más `followersDelta7d` calculado en SQL con el `LATERAL` de CON-4 (alias `h` para no confundirlo con el `p` de `post`) |
| `apps/web/app/(app)/conexiones/_lib/messages.ts` | add/add: `main` lo creó para ACC-8 (`ownerNotice`, `list`), CON-4 para toda la pantalla | Un solo `MESSAGES`: el de CON-4, con `ownerNotice` de ACC-8 intacto (lo usa `owner-notice.ts`) y `list.connectedBy` convertido en `tabla.conectadaPor` |
| `apps/web/app/(app)/conexiones/actions.ts` | Imports y el `catch` de «Quitar»: `main` traduce `SinPermisoError` (ACC-8), CON-4 movió los textos a `messages.ts` | Las dos cosas: textos de `messages.ts` y la rama de `SinPermisoError`. Los `TODO(ACC-2)` se borraron (ver §4) |
| `apps/web/app/(app)/conexiones/page.tsx` | La página entera | La de CON-4, con `requireModuleAccess` (ACC-5) en vez de `requirePermission`, y los botones según `puede()` |
| `apps/web/content/backlog.ts` | La nota de CON-4 | La de `main`, reescrita al cerrar (§4) |
| `apps/web/README.md` | La línea de `/conexiones` | La de `main`, ampliada con lo de CON-4 |

Lo que `main` calculaba en la página y se movió o se borró:

| En la página de `main` | Ahora |
|---|---|
| `STATUS_PILL[r.status]`: el estado copiado de `social_connection.status` | `estadoDeCuenta(fila, ahora)` (`_lib/estado.ts`), con el reloj |
| La variación `(f - prev) / prev` hecha en React | `followersDelta7d`, calculada en la base |
| `AccountSub` con `displayNameOf` | `filaDeCuenta()` proyecta `conectadaPor: { quien, en }`; la tabla solo formatea la fecha |
| «Sin lectura todavía» (texto propio de la columna) | `frescura(null)` = «Sin leer todavía»: una sola frase para lo mismo |
| `TikTokAuthorize` con `loadOAuthApps(process.env)` en el árbol | `AutorizarCifras` con `entornoDeConexion` (sin el `client_secret`) |

---

## 2. CON-4 · Pantalla Conexiones · **hecha**

**Terminado cuando:** «Una conexión con token vencido se ve en rojo con
el botón de reautorizar». Desde el cierre, además: cada clase de fila
probada.

| Clase de fila | Qué se ve | Prueba automática |
|---|---|---|
| Conectada | verde «Activa», «Actualizar» | `estado.test.ts` («viva y con el token al día: verde») |
| Por vencer | ámbar «Vence pronto» | `estado.test.ts` («vence dentro de 24 h») |
| Vencida con renovación | ámbar «Se renueva sola» + «El worker de renovación la renueva sin pedirte nada cuando corra…», sin «Actualizar» y con «Reautorizar» secundario (no rojo) | `estado.test.ts` (costura CON-3 → CON-4), `tabla.test.tsx`, `pagina.test.tsx` (`cafealma.pausa`) |
| Vencida sin renovación | **rojo «Vencida» y «Reautorizar» en rojo** aunque `status` siga en `active` | `estado.test.ts`, `tabla.test.tsx`, `pagina.test.tsx` (`cafealma.tienda`) |
| Por @ | «Por @» + «Cifras públicas, leídas por su @.»; en TikTok, «Sin cifras por @» y «Autorizar cifras» | `tabla.test.tsx`, `pagina.test.tsx` (`cafealma.recetas`) |
| Por @ autorizada | Una sola fila «Autorizada», con el historial por @ como base de la variación | `packages/db/test/cuentas-pantalla.test.ts` |
| Revocada / necesita reautorizar | rojo con su propio texto y «Reautorizar» | `estado.test.ts`, `pagina.test.tsx` (`cafealma.reposteria`) |
| Quitada | neutro, sin acciones | `estado.test.ts` |

**Verificación real.** En dev (`next dev -p 3187`, Postgres embebido con
el seed y una semilla temporal **sin versionar** que añadía las filas
que el seed no trae; se borró al terminar), fila por fila, sacadas del
HTML servido:

```
@laura.cocinafacil  Instagram │ Autorizada │ 128.000 +1 % │ 939 · 17 en seguimiento │ hace 3 horas          │ Activa                                  │ Actualizar · Quitar
@laura.cocinafacil  TikTok    │ Autorizada │ 214.000 +1 % │ 669 · 21 en seguimiento │ hace 2 horas          │ Vence pronto                            │ Actualizar · Quitar
@laura.pausa        TikTok    │ Autorizada │ Sin dato     │ Sin dato                │ hace un día           │ Se renueva sola + la frase del worker   │ Quitar (*)
@laura.tienda       TikTok    │ Autorizada │ Sin dato     │ Sin dato                │ hace un día           │ Vencida                                 │ Reautorizar · Quitar
@nicolasduartea     Instagram │ Por @      │ 1.204 +2 %   │ 97                      │ hace 4 horas          │ Activa · Falta la audiencia de la cuenta desde el 20 sep. Instagram no publica la audiencia… │ Actualizar · Quitar
                    (debajo del @: «Conectada por Andrés Pardo el 20 sep»)
@selvathegolden     TikTok    │ Autorizada │ 81           │ 13                      │ hace una hora         │ Activa                                  │ Actualizar · Quitar
@laura.reposteria   TikTok    │ Autorizada │ Sin dato     │ Sin dato                │ Sin leer todavía      │ Revocada                                │ Reautorizar · Quitar
```

(*) Tras `/code-review` la fila de «Se renueva sola» ofrece además
«Reautorizar» como botón secundario (§5, hallazgo 1).

- **400 px:** `node apps/web/scripts/ancho-movil.mjs http://localhost:3187 /conexiones` → `✓ /conexiones  400 px de 400`.
- **Oscuro:** captura a 390 px con `--force-dark-mode`. La página no
  desborda; la tabla se desplaza dentro de su recuadro, como en todo el
  producto.
- **Secretos en el HTML de dev:** 0 apariciones de las credenciales
  falsas del entorno ni de las claves `"secretRef"`, `"scopes"`,
  `"userId"` o `"email"`. Aparece el texto SQL de los archivos del seed
  (con sus `seed://…` de mentira): es la carga de depuración que React
  manda solo en desarrollo, porque el Postgres embebido lee esos
  archivos; en producción no hay base embebida ni esa carga.

---

## 3. Costuras (F2)

| Contrato | Qué se prueba | Prueba |
|---|---|---|
| **CON-3 → CON-4** | Acceso vencido con renovación viva: «Se renueva sola» y una frase que dice que depende del worker (hoy no corre en producción), sin «Actualizar» (lo dejaría en `error`) y con «Reautorizar» solo como salida secundaria. Sin renovación, o con la renovación vencida: rojo y «Reautorizar». Lo que dice la plataforma (`needs_reauth`, `revoked`) manda sobre la fecha | `_lib/estado.test.ts` («costura CON-3 → CON-4», 5), `tabla.test.tsx`, `pagina.test.tsx` (`cafealma.pausa` y `cafealma.tienda`) |
| **CON-10 híbrido** | Una cuenta por @ que el dueño autoriza sigue siendo UNA fila, con su id, su historial por @ como base de la variación y la fecha de su renovación | `packages/db/test/cuentas-pantalla.test.ts` (y la de `cuentas-publicas.test.ts` que ya existía) |
| **ACC-8** | «Conectada por X el Y» (nombre, correo o «alguien del equipo»), nada si la conectó el titular, sin que el `userId` baje a la pantalla; el aviso `connection_added` al titular | `estado.test.ts` («costura ACC-8»), `tabla.test.tsx`, `pagina-publicaciones.test.tsx`; el aviso, `_lib/cuentas-service.test.ts` y `_lib/oauth-handlers.test.ts` (ya estaban en `main`, siguen en verde) |
| **CON-7** | La fila dice qué grupo falta, desde cuándo y por qué, con el `message_es` de `metric_requirement` tal cual; enlace de arreglo solo si es `https://`; otro workspace no ve el hueco (RLS). Pie: «lo revisa el worker cada mañana» | `cuentas-pantalla.test.ts` (base y RLS), `estado.test.ts` («costura CON-7», 5), `tabla.test.tsx` |
| **CON-5** | «N en seguimiento» junto a lo que dice la red, «publicaciones hasta el …» aparte de «datos hasta el …», y una frase si nunca se leyó | `pagina-publicaciones.test.tsx` (6), `tabla.test.tsx`, `estado.test.ts` |
| **ACC-5 / ACC-1** | Sin `conexiones.*` (Contador): 404 y la base no se toca. Ve pero no conecta (Mánager): la tabla entera, ni un botón y la frase «Tu rol puede ver las cuentas, pero no…». Conecta pero no quita: todo menos «Quitar». El `POST …/start` sin permiso vuelve a Cuentas con `sin_permiso` (antes: 500) | `permisos.test.tsx` (5), `tabla.test.tsx`, y `lib/permisos/{convencion,paginas}.test.ts` de `main` |
| **ACC-2** | «Reautorizar» escribe por `upsertConnection`, que deja `connection.reconnected` en la bitácora dentro de la misma transacción; alta y baja las auditaba ya ACC-8 | `packages/db/test/{conexiones,cuentas-publicas}.test.ts` y `test/audit-convencion.test.ts` |

---

## 4. Deuda resuelta (F3)

- **`TODO(ACC-2)`**: los tres de CON-4 (`actions.ts` ×2 y el callback)
  eran viejos: `audit()` ya vive en `addPublicAccount`,
  `disconnectConnection`, `upsertConnection` y
  `upgradePublicAccountToOAuth`. Se borraron; el callback dice qué fila
  de bitácora deja cada camino.
- **`TODO(ACC-1)`**: no quedaba ninguno. Los `TODO(ACC-5)` de
  `_lib/permisos.ts` y `queries/conexiones.ts` describen el diseño que
  quedó (dos comprobaciones que hoy responden lo mismo) y no son deuda.
- **El 500 del `POST …/start`**: CON-4 lo protegía con
  `requirePermission`, que en un route handler lanza sin frontera de
  error. Ahora pregunta con `puede()` y vuelve a Cuentas con el mismo
  aviso que ya daba el handler.
- **Notas del tablero**: CON-4 a «hecho» con fecha. Las notas viejas de
  §0.1 que no son de CON (ACC-8, CAM, FIN) son de sus propios cierres.

---

## 5. Revisión (F4)

**`/code-review` en nivel alto: 8 hallazgos, 5 arreglados (`d9cd009`) y
3 justificados.**

| # | Hallazgo | Qué se hizo |
|---|---|---|
| 1 | «Se renueva sola» sin ninguna acción dejaba la fila atascada mientras el worker no corre, que es justo cuando se ve | **Arreglado**: «Reautorizar» como botón secundario (no rojo). Sigue sin «Actualizar» |
| 2 | La frase de «no se puede reautorizar» mandaba a quitar la cuenta y agregarla por @, lo que en TikTok pierde cifras e historial, y se la daba a roles sin «Quitar» | **Arreglado**: dice que las cifras se quedan en la última lectura y el historial se conserva |
| 3 | «Reautorizar» mandaba el portafolio de empresa de Meta por Instagram Login | **Arreglado**: `proveedorDe` solo repara `direct_oauth` |
| 4 | La clave de cada hueco era su texto: dos grupos sin nombre chocaban | **Arreglado**: clave `metric_group` y los cinco grupos del catálogo con nombre |
| 5 | Portafolio o CSV en `error`: rojo sin explicación | **Arreglado**: «Esta cuenta no se vuelve a leer desde aquí: la lee el worker en su próxima pasada» |
| 6 | El paso manual abre una segunda transacción | **Justificado**: solo ocurre si hay una cuenta de TikTok autorizada, lee una fila de un catálogo global y depende de la lista, así que no puede ir en paralelo. Es una lectura del pooler por visita |
| 7 | Identificadores en español (`filaDeCuenta`, `estadoDeCuenta`…) | **Justificado**: vienen de CON-4 y siguen el precedente de la capa web (`puede`, `permisosDeLaSesion`, `requireModuleAccess` conviven; Finanzas usa `pestanas`, `bandeja`). Renombrarlos al cerrar el módulo es un cambio grande sin efecto en el producto. Queda en la tabla de decisiones (D7) |
| 8 | El estado se calcula dos veces por fila (columna Estado y columna Acciones) | **Justificado**: es una función pura de O(1) sobre la misma fila y el mismo reloj; las dos columnas no pueden discrepar |

**`/security-review`**: ningún hallazgo con confianza 8 o más. Se
revisaron la ruta de inicio de OAuth (añade una comprobación, no quita
ninguna; la redirección es a una ruta fija), las acciones, los botones
escondidos (la autoridad es el servidor), el `LATERAL` sobre
`metric_gap` (RLS FORCE y parámetros), el `href` del arreglo (solo
`https://`, escrito por una migración), el `client_secret` fuera del
árbol y la proyección de la fila sin `secretRef` ni `scopes`.

### Verificación final (tras los arreglos de la revisión, `d9cd009`)

```
$ pnpm verificar
//:test            ℹ tests 8     ℹ fail 0
@mc/core:test      ℹ tests 267   ℹ fail 0
@mc/connectors     ℹ tests 203   ℹ fail 0
@mc/db:test        ℹ tests 817   ℹ fail 0
@mc/worker:test    ℹ tests 121   ℹ fail 0
@mc/web:test       Test Files 135 passed · Tests 1241 passed | 1 todo
Tasks: 15 successful, 15 total

$ pnpm --filter @mc/web build
✓ Compiled successfully
├ ƒ /conexiones                              4.06 kB   110 kB
├ ƒ /conexiones/oauth/[platform]/callback      217 B   102 kB
├ ƒ /conexiones/oauth/[platform]/start         217 B   102 kB
BUILD_EXIT=0
```

Sin migración: no hay `make db.check` que correr; `make db.guardia` se
corre tras el despliegue (§9).

---

## 6. Decisiones pendientes de Nicolás

Ninguna se cambió: en el código quedó la opción conservadora.

| # | Dónde | Pregunta | Lo que hay en el código | Recomendación | Si dices lo contrario |
|---|---|---|---|---|---|
| D1 | `docs/propuestas/CON-4.md:189` | ¿«Reautorizar» debería poder «olvidar y empezar de cero»? | No: junto a «Reautorizar» queda «Quitar»; reautorizar conserva la fila y el historial | Dejarlo así | Un botón más en `tabla.tsx` que llama a `desconectarConexion` y abre el diálogo. S |
| D2 | `docs/propuestas/CON-4.md:195` | ¿Se avisa de «Vence pronto»? | Solo en ámbar en la pantalla; el aviso es de `oauth.refresh` (worker) | Dejarlo en el worker: cuando corra (WRK) avisa él | Un `notification` desde la web duplicaría el del worker. M, y mejor no |
| D3 | `docs/propuestas/CON-4.md:199` | ¿`tiktok-business` en «Conectar»? | Fuera (`conectar.tsx:30`) | Esperar el trámite de CON-9 | Una línea en `REDES_CONECTABLES` y sus variables en el vault. S |
| D4 | `docs/propuestas/CON-4.md:202` | ¿Instagram conectable? | Fuera: por @ ya entrega seguidores y publicaciones | Fuera del MVP | `"instagram"` en `REDES_CONECTABLES` + `META_APP_ID`/`META_APP_SECRET` en el vault. S |
| D5 | `docs/propuestas/ACC-8.md:158` | ¿El bloque de Andrés Pardo (conectó el Instagram de Laura) en la demo pública? | Está en el seed 0003, y por eso la demo enseña «Conectada por Andrés Pardo el 6 may» | Dejarlo: es la única fila que enseña ACC-8 en la demo | Quitar el bloque delimitado de `db/seed/0003` (carpeta de Rasheed, seed nuevo o edición suya). S |
| D6 | Nueva · `_lib/estado.ts:174` | Con el acceso vencido y la renovación viva, ¿se ofrece «Reautorizar»? | Sí, como salida secundaria (no roja), porque en producción el worker no corre | Quitarlo cuando WRK esté en producción: ahí la fila no llegaría a verse así | `accion: "ninguna"` en esa rama y dos pruebas. S |
| D7 | Nueva · revisión, hallazgo 7 | ¿Renombrar al inglés los identificadores de la pantalla (`filaDeCuenta`, `estadoDeCuenta`, `TablaDeCuentas`…)? | En español, como los dejó CON-4 | Hacerlo con la limpieza general de identificadores de la capa web, no por módulo | Unos 15 símbolos en 8 archivos de `conexiones/`. M, mecánico |

Las decisiones de CON-1, CON-3, CON-5 y CON-10 (fuentes, cuotas,
proveedor de TikTok) son de las fuentes y las cierra **CON-C**. La de
CON-7 (la tabla `metric_gap` en vez de `status_detail`) quedó resuelta
con la 0039 aplicada.

---

## 7. Lo que necesita Rasheed

**Nada que aplicar.** Sin migración, sin tocar `lib/auth/`,
`lib/workspace/`, `packages/db/src/{client,schema}`, `db/migrations/`
ni los seeds. Lo que ya estaba pedido sigue igual:

1. **El worker en producción** (esquema `pgboss` y `GRANT mc_worker TO
   mc_migrator`, WRK): sin él, «Se renueva sola» no se renueva y los
   huecos de CON-7 no se detectan. La pantalla lo dice con dos frases.
2. **D5** si se quiere quitar a Andrés de la demo.

---

## 8. Fuera de alcance

| Qué | Por qué | Historia |
|---|---|---|
| OAuth de YouTube | Espera `GOOGLE_CLIENT_*` y la verificación de Google | CON-8 (CON-C) |
| Proveedor de TikTok (EnsembleData) | Falta decidir si se contrata | CON-12 (CON-C) |
| Renovar el token desde la pantalla («Renovar ahora») | Es el job `oauth.refresh`; la pantalla ofrece reautorizar mientras tanto | WRK |
| La demografía en sí (gráficas) | La pantalla solo dice qué falta; enseñarla es de Resumen | RES-4 |
| Alcance por marca/creador en la consulta de cuentas | `membership_scope` | ACC-6 (cierre ACC, 0040) |
