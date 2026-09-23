# CON-4 · Pantalla Conexiones — plan y lo que necesita Rasheed

Escrito para: Nicolás (dueño del módulo) y Rasheed (dueño de
`db/migrations/`, del despliegue y de los trámites).
Fecha: 23 de septiembre de 2026. Rama `nicolas/CON-4-pantalla-conexiones`,
worktree `rayit-con4`.

**Condición de apertura: cumplida.** La fila de CON-4 en
`docs/backlog-mvp.md` §5 pide CON-3 *probada en vivo* (CON-3.md §5) y
`OAUTH_CONNECT=1` con credenciales en el vault. Ocurrió el **23 de
septiembre**: Nicolás creó la app de TikTok (Login Kit, sandbox con su
cuenta como usuario de prueba), verificó el dominio y puso
`OAUTH_CONNECT=1`, `TIKTOK_LOGIN_CLIENT_KEY` y
`TIKTOK_LOGIN_CLIENT_SECRET` en Vercel producción; `@selvathegolden`
quedó `direct_oauth`/`active` a las 15:09 UTC. Instagram Login no se
probó y **queda fuera del MVP**: Instagram va por @ (CON-10 §3).

Eso tiene dos consecuencias para esta historia, y las dos están en las
decisiones de abajo: la bandera está **encendida en producción**, así
que lo que se escriba aquí se ve de verdad (no detrás de una puerta
cerrada); y la única red que se ofrece conectar es **TikTok**, porque
es la única donde autorizar añade algo que el @ no da.

La pantalla se escribe igual para los dos estados de la bandera: **con
`oauth_connect` apagada** (una copia sin las variables, o el día que se
apague) es la de CON-10 con el estado, la frescura y la columna
«Acceso» nuevos; **encendida**, aparecen «Conectar», «Reautorizar» y el
paso manual.

---

## 0. Plan (fase 1)

### 0.1 Qué se construye y dónde

| Archivo | Qué |
|---|---|
| `apps/web/app/(app)/conexiones/_lib/estado.ts` | **Nuevo.** Funciones puras: `claseDeAcceso(row)`, `estadoDeCuenta(row, now)` y `frescura(horas)`. Ninguna pantalla decide el color ni el texto con un `if` suelto. |
| `apps/web/app/(app)/conexiones/_lib/estado.test.ts` | **Nuevo.** Las tres funciones, caso por caso, en milisegundos. |
| `apps/web/app/(app)/conexiones/_lib/messages.ts` | **Nuevo.** Los textos del módulo en un solo sitio (convención de los pulidos de Rasheed). |
| `apps/web/app/(app)/conexiones/error.tsx` | **Nuevo.** El módulo no tenía frontera de error: caía en la de `(app)`. Ahora dice «No pudimos leer tus cuentas». |
| `apps/web/app/(app)/conexiones/loading.tsx` | Cambia: del esqueleto genérico al del módulo (formulario + tabla). |
| `apps/web/app/(app)/conexiones/conectar.tsx` | **Nuevo.** La sección «Conectar una cuenta autorizada», detrás de `oauth_connect`: un `ConnectDialog` por red con su motivo cuando falta configuración. |
| `apps/web/app/(app)/conexiones/pasos-manuales.tsx` | **Nuevo.** El panel del paso manual, con el `message_es` de `tt.insights.optin` leído de la base. |
| `apps/web/app/(app)/conexiones/connect-dialog.tsx` | Cambia: acepta `variant: "danger"` (el «Reautorizar» en rojo) y un título propio del diálogo. |
| `apps/web/app/(app)/conexiones/page.tsx` | Cambia: una sola tabla con las dos clases de fila, columna «Acceso», columna «Última lectura» con las horas, estado derivado y acciones por fila. |
| `apps/web/app/(app)/conexiones/actions.ts` | Cambia: textos a `_lib/messages.ts` y `TODO(ACC-2)` en las escrituras auditables. Los `requirePermission` los puso ACC-1 y se conservan. |
| `apps/web/app/(app)/conexiones/pagina.test.tsx` | **Nuevo.** La página entera contra Postgres embebido con el escenario del `--demo` del worker. |
| `packages/db/src/queries/conexiones.ts` | Cambia: `getMetricRequirement(tx, id)` sobre el catálogo `metric_requirement` (0011). |
| `apps/web/content/backlog.ts` | Cambia: **solo** mi fila CON-4. |
| `docs/backlog-mvp.md` | Cambia: **solo** la fila CON-4 de §5. |

No se toca ninguna migración, ningún archivo de Rasheed y ninguna
dependencia nueva.

### 0.2 Decisiones

**1. Una tabla, no dos.** La historia lo pide («una sola tabla sobre
`connection_health` con las dos clases de fila») y la base lo permite:
`listAccounts` ya devuelve las dos, porque `connection_health` es
`social_connection` viva sin distinguir `access_mode`.
*Descartado:* dos tablas («Cuentas por @» y «Cuentas autorizadas»).
Leen mejor por separado, pero rompen la pregunta que una creadora se
hace de verdad —«¿de dónde salen las cifras de esta cuenta?»— y
duplicarían el estado vacío, el orden y las acciones.

**2. Cómo se distinguen a simple vista: una columna «Acceso», no un
color de fila.** Una pastilla por fila: «Por @» en tono neutro,
«Autorizada» en el tono de acento. Texto distinto **y** color distinto
(AA en los dos temas), porque el color nunca puede ser el único
indicador.
*Descartado:* sangrar o teñir la fila entera (se pierde al hacer scroll
horizontal, que es lo que pasa a 400 px) y un icono de candado sin
texto (no se lee en voz alta y no dice cuál es cuál).

**3. El estado se deriva; no se copia `status`.** `social_connection
.status` es lo que el worker dejó la última vez. Un token que **ya
venció** puede seguir con `status = 'active'` si `oauth.refresh` no ha
corrido (en producción todavía no corre: CIM-7). `estadoDeCuenta`
compara `accessExpiresAt` con el reloj y devuelve «Vencida» en rojo con
el botón de reautorizar aunque la columna diga `active`. Los casos:

| Situación | Pastilla | Acción |
|---|---|---|
| `status = 'needs_reauth'` | rojo · «Necesita reautorizar» | Reautorizar |
| `status = 'expired'` **o** `access_expires_at <= ahora` | rojo · «Vencida» | Reautorizar |
| `status = 'revoked'` | rojo · «Revocada» | Reautorizar |
| `status = 'error'` | rojo · «No se pudo leer» | Actualizar (no es un problema de permiso) |
| `status = 'disabled'` | neutro · «Quitada» | — |
| activa y `token_expiring_soon` | ámbar · «Vence pronto» | Actualizar |
| activa | verde · «Activa» | Actualizar |

Una cuenta **por @** no tiene token: nunca vence y nunca ofrece
reautorizar. Sus únicos estados son «Activa», «No se pudo leer» y
«Quitada».
*Descartado:* mostrar `status` tal cual. Es lo que hacía CON-10 y es
justo lo que el «terminado cuando» de CON-4 prohíbe: con el token
vencido y el worker parado, la fila se veía verde.

**4. Las horas desde `last_synced_at` se leen en la vista, no se
calculan en React.** `connection_health.hours_since_sync` ya viene de
0010 y `listConnections` ya la trae. `frescura(horas)` solo la pone en
palabras: «hace 3 horas», «hace 2 días», «hace un momento». Sin
lectura, una frase —«Sin leer todavía»—, nunca un guion ni un cero.

**5. «Conectar» va en su propia sección, no en la cabecera de la
tabla.** Conectar una cuenta autorizada es empezar un flujo con
consentimiento: necesita su título, su explicación y un botón por red.
Va **debajo** del formulario «Agregar cuenta» (el camino del MVP) y
**encima** de la tabla, y solo existe con `oauth_connect`.
*Descartado:* un botón «Conectar» en la barra de la tabla: no cabe el
diálogo ni el motivo de «sin configurar» a 400 px.

**6. Qué red ofrece «Conectar»: solo TikTok.** No por falta de código
—CON-3 tiene tres proveedores escritos y probados con respuestas
grabadas— sino porque es la única donde autorizar **añade algo**:
TikTok no publica seguidores ni vistas por @ (CON-10 §7), así que el
permiso del dueño es lo que desbloquea las cifras, y es lo que se probó
en vivo el 23-sep. Instagram entrega seguidores y publicaciones por @
con `business_discovery`: poner ahí un botón que pide permisos para
conseguir lo que ya tenemos es pedir de más, y su Login no se ha
probado nunca. `tiktok-business` (la Accounts API) no es otra red, es
otra app de la misma, depende del trámite de CON-9 y haría elegir entre
dos TikToks. YouTube no tiene OAuth todavía (CON-8) y sigue por @.
Añadir una red es añadirla a `REDES_CONECTABLES`: el diálogo, la ruta y
el callback ya existen para las tres.

*Y dónde se dice que falta una variable.* En la **sección** de
conectar, el botón de una red sin configurar sale deshabilitado con el
nombre de lo que falta: ahí mira quien despliega. En una **fila** de la
tabla, no: a una creadora «faltan TIKTOK_LOGIN_CLIENT_KEY» no le dice
nada y no le sirve de nada, así que en su lugar va la instrucción que
sí puede seguir —«Para volver a leerla, quítala y agrégala por su @»—.
Es la misma regla que `(app)/_lib/messages.ts` aplica a la pista de
despliegue de la frontera de error.

**6 bis. Ninguna fila sin salida.** Cuando una cuenta pide reautorizar
y esta versión no puede hacerlo —la bandera apagada, una red sin app de
OAuth (YouTube y Facebook, CON-8), o la app sin configurar en este
entorno— la celda de acciones no se queda con «Quitar» y nada más: dice
qué hacer en su lugar. Sin esa rama, una conexión de YouTube del seed
con el token vencido se veía roja y sin ninguna acción posible.

**7. «Reautorizar» reusa el mismo `POST …/start`.** No hay ruta nueva:
el callback de CON-3 hace `upsertConnection`, que por el UNIQUE
`(platform_id, external_account_id, workspace_id)` **reactiva** la fila
—`status = 'active'`, `status_detail = NULL`, `consecutive_failures = 0`,
`secret_ref` reutilizada— en vez de crear otra. Lo único que cambia es
el botón: `variant="danger"`, el texto «Reautorizar» y un diálogo que
dice que el permiso caducó. Una cuenta de TikTok agregada por @ que ya
se había autorizado vuelve por `findPublicAccountByHandle` a la misma
fila (CON-10 §7).

**8. El paso manual se lee de la base.** El texto de «Activa Analytics
en TikTok» es `metric_requirement.message_es` de `tt.insights.optin`
(0011), un catálogo global de solo lectura para `mc_app` (0024 §7.1).
Se lee con `getMetricRequirement(tx, 'tt.insights.optin')` dentro de la
misma transacción de workspace. Sin números ni textos mágicos.
*Descartado:* copiar la frase a `messages.ts`. Sería una segunda fuente
de verdad de algo que la base ya tiene y que CON-7 volverá a leer.
*Dónde se ve:* un panel debajo de la tabla, solo si hay al menos una
cuenta de TikTok **autorizada** (sin token no hay API que desbloquear).

**9. Permisos: los de ACC-1, que llegaron a mitad de la historia.**
La rama salió de un `main` sin ACC-1 y llevaba `// TODO(ACC-1)`. ACC-1
se mergeó el 23-sep (`e52e833`), así que tras el rebase la pantalla
abre con `requirePermission('conexiones.cuenta.ver')` —el mismo
`PERMISO_MINIMO.conexiones` que ACC-5 usará para responder 404— y el
`POST /conexiones/oauth/<red>/start` con
`'conexiones.cuenta.conectar'`, por ser el punto de entrada del flujo
que escribe tokens. En `actions.ts` mandan las llamadas que ACC-1 ya
había puesto; «Actualizar» se queda en `conexiones.cuenta.conectar` y
no en `.ver` porque pedir una lectura nueva gasta cuota de la
plataforma y escribe un snapshot.

**La bitácora sigue en marcador.** ACC-2 no está en `main` (no existe
`packages/db/src/audit.ts` en ninguna rama remota), así que las tres
escrituras auditables —agregar, quitar y autorizar— llevan
`// TODO(ACC-2): audit(...)` con el evento y los campos que le tocan,
sin tokens ni PII.

**10. Formato por `formatterFor`.** La pantalla de CON-10 usaba
`formatInt`/`formatDelta` sueltos, con el locale por omisión. Pasa a
`formatterFor(await getCurrentWorkspace())`, como el resto del
producto: un workspace en otro país ve sus cifras y sus fechas.

### 0.3 Decisiones pendientes de Nicolás (se tomó la opción conservadora)

1. **DECISIÓN PENDIENTE DE NICOLÁS · ¿«Reautorizar» debería poder
   quitar la cuenta rota?** Hoy, junto a «Reautorizar» queda «Quitar»,
   que revoca los consentimientos y borra el ciphertext. No se añade
   ningún «Olvidar y volver a empezar» porque reautorizar sobre la
   misma fila conserva el historial, que es lo que vale. Si prefieres
   el camino destructivo visible, es un botón más.
2. **DECISIÓN PENDIENTE DE NICOLÁS · ¿Se avisa de «Vence pronto»?**
   `token_expiring_soon` es cierto 24 h antes. Se muestra en ámbar,
   pero **no** se manda notificación ni correo: eso es del worker
   (`oauth.refresh` ya crea `notification`) y no de esta pantalla.
3. **DECISIÓN PENDIENTE DE NICOLÁS · ¿`tiktok-business` en la
   pantalla?** Se deja fuera (decisión 6). Si el trámite de CON-9 sale
   antes de lo previsto, entra con una línea.
4. **DECISIÓN PENDIENTE DE NICOLÁS · ¿Instagram conectable?** Se deja
   fuera por lo de la decisión 6. Si algún día quieres el alcance y la
   retención por video de Instagram (que `business_discovery` no da),
   se enciende añadiendo `"instagram"` a `REDES_CONECTABLES` y metiendo
   `META_APP_ID` y `META_APP_SECRET` al vault.

### 0.4 Fuera de alcance (y a qué historia va)

- Videos y métricas por video de una cuenta autorizada → **CON-5**.
- Demografía y el resto de `metric_requirement` → **CON-7**.
- OAuth de YouTube → **CON-8**.
- Notificaciones de token por vencer → ya las crea **CON-2**
  (`oauth.refresh`); la bandeja es de otra historia.
- `audit()` real → **ACC-2** (`requirePermission` ya entró con ACC-1, ver decisión 9).
- La prueba en vivo del flujo OAuth → **CON-3 §5** (hecha el 23-sep).
- Abrir el OAuth a cualquier creador (App Review de Login Kit) → **CON-9**.

---

## 1. Lo que necesita Rasheed

**Nada que aplicar.** Esta historia no trae migración, no toca
`db/migrations/`, ni `lib/auth/`, ni `lib/workspace/`, ni
`packages/db/src/{client,schema}`, ni ningún seed. Lo único que pide es
lo que ya estaba pedido:

1. **Las migraciones 0024 a 0033 siguen pendientes de aplicar** en
   Supabase (cola única del integrador). La pantalla no las necesita:
   lee `connection_health` (0010), `social_connection` (0002),
   `account_metric_snapshot` (0002/0022) y `metric_requirement` (0011),
   todas aplicadas.
2. **Para encender la pantalla completa** hacen falta, en Vercel y en
   el vault, las variables de CON-3 §3 y `OAUTH_CONNECT=1`. Son de
   Nicolás; aquí solo se anotan los nombres, nunca los valores.

---

## 2. Verificación (23 de septiembre de 2026)

### 2.1 Pruebas automáticas

| Archivo | Qué fija |
|---|---|
| `_lib/estado.test.ts` (18) | El token vencido es rojo y pide reautorizar **aunque `status` siga en `active`**; la plataforma manda sobre la fecha; una cuenta por @ no vence; las horas en palabras (incluido un reloj adelantado); y que `filaDeCuenta` deja fuera `secretRef` y `scopes`. |
| `_lib/entorno.test.ts` (3) | Lo que viaja por el árbol de render no contiene ningún valor del entorno, solo nombres de variables. |
| `tabla.test.tsx` (14) | Las ramas del JSX: vencida en rojo con «Reautorizar» al mismo `POST …/start`; «Por @» y «Autorizada» con texto y explicación distintos; sin app configurada, la instrucción en vez de un botón muerto y **sin nombrar variables de servidor**; una variación de cero se escribe y una ausente no se inventa; y la bandera apagada. |
| `pagina.test.tsx` (10) | La página entera contra Postgres embebido con el seed más el escenario del `--demo` del worker, con y sin bandera. |

```
$ pnpm --filter @mc/web exec vitest run "app/(app)/conexiones/" "lib/permisos/"
 Test Files  8 passed (8)
      Tests  81 passed (81)
```

Las diez de `lib/permisos/` son de ACC-1 e incluyen `convencion.test.ts`,
que falla si una Server Action de Conexiones deja de abrir con su
`requirePermission`.

### 2.2 Verde total (rebasada sobre el `main` del 23-sep con ACC-1)

```
$ pnpm verificar
@mc/web:test:  Test Files  93 passed (93)
@mc/web:test:       Tests  805 passed | 1 todo (806)

$ pnpm --filter @mc/db test
ℹ tests 615   ℹ pass 615   ℹ fail 0

$ pnpm --filter @mc/web build
✓ Compiled successfully in 29.4s
├ ƒ /conexiones                            4.07 kB         110 kB
├ ƒ /conexiones/oauth/[platform]/callback    198 B         102 kB
├ ƒ /conexiones/oauth/[platform]/start       198 B         102 kB
BUILD_EXIT=0
```

Una nota sobre la corrida de `pnpm verificar`: con cuatro sesiones
verificando a la vez en esta máquina (carga media de 120), `@mc/db#test`
cayó por **tiempo de espera** —`listSql` de `test/aplicar.test.ts`
tardó 157 s contra un tope de 120 s y arrastró 614 pruebas canceladas—,
no por un fallo. Corrido solo, el paquete da 615 de 615. Es contención
de la máquina, no del código.

El *unhandled rejection* de `lote.test.ts` que rompía `pnpm verificar`
en `main` ya está arreglado en `main` (`913d465`, RES-6), así que ese
rojo desapareció.

No se tocó ninguna migración, así que no hay `make db.check` ni `make
db.guardia` que correr.

### 2.3 Verificación en dev (lo que se ve)

`pnpm --filter @mc/web dev -p 3123` con `OAUTH_CONNECT=1` y credenciales
de mentira de TikTok, sobre el Postgres embebido con el seed más cuatro
filas temporales **sin versionar** (un token vencido sin anotar, uno
revocado por la plataforma y dos cuentas por @): el seed de demo no
trae ninguna cuenta vencida ni ninguna por @, que son justo los dos
casos del «terminado cuando». El archivo se borró al terminar.

Las ocho filas, leídas del HTML servido (`curl` → `<tbody>`):

```
@lauracocinafacil  Facebook  │ Autorizada │  21.000  0 % en 7 días │ hace 6 horas      │ Activa
@laura.reposteria  Instagram │ Autorizada │ Sin dato               │ Sin leer todavía  │ Necesita reautorizar → «Para volver a leerla, quítala y agrégala por su @.»
@laura.cocinafacil Instagram │ Autorizada │ 128.000 +1 % en 7 días │ hace 3 horas      │ Activa
@laura.recetas     TikTok    │ Por @ · Sin cifras por @ │ 18.450 +8 % │ hace una hora   │ Activa → «Autorizar cifras»
@laura.tienda      TikTok    │ Autorizada │   4.210                │ hace un día       │ VENCIDA → «Reautorizar» (rojo)
@laura.cocinafacil TikTok    │ Autorizada │ 214.000 +1 % en 7 días │ hace 2 horas      │ Vence pronto
@LauraPostres      YouTube   │ Por @      │ Sin dato               │ hace 3 días       │ No se pudo leer · «YouTube no encontró el canal @LauraPostres.»
@LauraCocinaFacil  YouTube   │ Autorizada │  49.000 +1 % en 7 días │ hace 5 horas      │ Vence pronto
```

- **El criterio.** `@laura.tienda` tiene `status = 'active'` en la base
  y el token venció hace dos horas: la pantalla dice **Vencida** en rojo
  y ofrece **Reautorizar**, también en rojo, con su diálogo de
  consentimiento contra `/conexiones/oauth/tiktok/start`.
- **Las dos clases, la misma red.** `@laura.recetas` (TikTok, **Por @**,
  «Sin cifras por @», con «Autorizar cifras») y `@laura.tienda` (TikTok,
  **Autorizada**) se distinguen sin leer la letra pequeña.
- **El paso manual** sale al pie con el texto de la base:
  «Activa Analytics en la app de TikTok (Herramientas de creador, botón
  Activar)…», y nombra las dos cuentas de TikTok autorizadas.
- **400 px y tema oscuro:** capturas a 390 px en un iframe (Chrome sin
  cabeza no baja de 500 px) en claro y oscuro. La página no desborda; la
  tabla hace su propio scroll horizontal dentro del recuadro, como en
  todo el producto.
- **Secretos:** sobre la respuesta de dev, `grep` de
  `clave-falsa-de-prueba`, `secreto-falso-de-prueba`, `enc:tiktok:`,
  `enc:instagram:`, `public:tiktok:`, `public:youtube:`, `seed://demo`,
  `user.info.basic`, `instagram_business_basic`, `secretRef` y `scopes`:
  **cero cada uno**. Antes del último commit, `enc:tiktok:` y los scopes
  salían dos y tres veces: React serializa en desarrollo las props de
  cada componente para sus herramientas, y la fila completa se estaba
  pasando a la tabla. `renderToString` no escribe esa carga, así que la
  prueba de página no lo veía; el `grep` sobre dev, sí. Por eso existe
  `FilaDeCuenta`.
