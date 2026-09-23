# ACC-5 · Permisos en el marco — plan y lo que necesita Rasheed

Escrito para: Nicolás (dueño de la historia) y Rasheed (dueño de
`lib/workspace/`, `lib/auth/`, `queries/identidad.ts`, de los módulos
Resumen, Ventas y Cotizar, y de la cola de migraciones). Fecha: 23 de
septiembre de 2026. Rama `nicolas/ACC-5-permisos-en-el-marco`, worktree
`rayit-acc5`, desde `origin/main` `29460e3`.

**Qué es.** Cada módulo declara el permiso mínimo para abrirlo; una
sesión sin ese permiso recibe 404 (como una bandera apagada: un 403
confirmaría que el módulo existe); el menú esconde lo que no se puede
abrir; y `requirePermission()` de las Server Actions deja de resolver
la sesión como Dueño y lee la membresía real del workspace actual, una
vez por petición.

---

## 0. Plan (fase 1)

### 0.1 Lo que se comprobó antes de diseñar

| Hecho | Consecuencia |
|---|---|
| ACC-1, ACC-2 y ACC-3 **no están en `origin/main`**. ACC-1 y ACC-2 corren en paralelo a esta historia (worktrees `rayit-acc1` y `rayit-acc2`, lanzados a la vez); ACC-3 no ha empezado. La historia dice «depende de ACC-3 aplicada». | No hay `role_permission` ni `permisosDeRol()` que leer. Se construye sobre lo que sí existe (`membership.role`, 0001) con DOS costuras marcadas para ACC-1 y ACC-3 (§0.3, decisiones 1 y 2). No se bloquea: es lo que pide el modo autónomo. |
| **Ninguna página de producto llama a `requireModule()`**: solo `plan/[modulo]`, `kit` y `ModulePlan` (cimientos, accesos). Resumen, Ventas, Cotizar, Campañas, Finanzas y Conexiones no pasan por él. | «Los page.tsx de Rasheed que llaman `requireModule(slug)` siguen compilando» es cierto por vacuidad. Para que el permiso cierre la ruta directa hace falta un punto por el que pasen TODAS las rutas del módulo: un `layout.tsx` en la raíz de cada carpeta de módulo (decisión 5). |
| `app/(app)/loading.tsx` no existe y `app/(app)/not-found.tsx` sí. | Un `notFound()` en el layout del módulo responde 404 de verdad (no un 200 con el 404 pintado), que es lo que exige `no-existe.test.tsx`. |
| `getCurrentContext()` (Rasheed, CIM-3) ya trae `workspaces` con `role` y `kind` del workspace actual, sin consulta extra. | Se podría leer el rol de ahí, pero después de ACC-3 los permisos salen de un JOIN que `identidad.ts` no hace. La consulta va en `queries/accesos.ts` (mía) para que ACC-3 cambie UNA función y no el marco. |
| El seed 0002 tiene un solo usuario (Laura, `demo@oncue.test`, `owner`). El seed no trae un Contador ni un Mánager; los valores de `membership.role` hoy son `owner`, `admin`, `member`, `viewer`, `client`. | Contador y Mánager no existen en la base hasta ACC-3. La prueba con Contador corre sobre el conjunto de permisos del rol (matriz de la fase 5), inyectado; la prueba contra pglite usa `viewer` y `member` insertados en la prueba (§0.4). Un segundo usuario del seed se propone (§3). |
| ACC-1 (borrador en `rayit-acc1`) nombra `PERMISO_MINIMO` por módulo con `ventas.negocio.ver` y `cotizar.cotizacion.ver`, y da al Contador `campanas.campana.ver` («nombre y monto»). | El «terminado cuando» de ACC-5 dice lo contrario: con Contador, `/campanas` responde 404. Se implementa el criterio de ACC-5 y se marca la contradicción (§0.5, decisión pendiente 1). Los nombres de permiso se toman del borrador de ACC-1 (dueño del catálogo). |
| `nav.tsx` es cliente y `modules.ts` lo importa. | Nada de `lib/permisos` (que abre la base) puede entrar en `content/modules.ts`. `requireModule` sigue puro y síncrono; el que carga la sesión vive en `lib/permisos/modulo.ts`. |
| `Shell` se pinta también en `/kit` (pública, sin sesión) y en modo demo (sin llaves). | El conjunto de permisos del marco tiene que resolverse sin redirigir y sin lanzar: sin sesión y con llaves → vacío; sin llaves → Dueño (para que `pnpm verificar` y el dev sin red sigan igual). |

### 0.2 Qué se construye

```
apps/web/content/modules.ts                 permission por módulo; requireModule(slug, { flags, permisos }); productModules(flags, permisos); can()
apps/web/lib/permisos/index.ts              requirePermission(permiso) REAL + SinPermisoError (hasta ACC-1: aquí; con ACC-1: reexporta la de core)
apps/web/lib/permisos/sesion.ts             permisosDeLaSesion(): cache de React; demo → Dueño; sin sesión → vacío; con sesión → queries/accesos
apps/web/lib/permisos/roles-provisionales.ts  matriz por módulo de la fase 5 y el mapa membership.role → rol de fábrica (lo borra ACC-1 + ACC-3)
apps/web/lib/permisos/modulo.ts             requireModuleAccess(slug): carga la sesión y llama a requireModule; 404 por notFound()
apps/web/lib/permisos/README.md             por qué vive aquí y no en lib/auth/; las dos costuras
apps/web/components/shell.tsx               resuelve los permisos en servidor y los pasa a la navegación
apps/web/components/nav.tsx                 productModules(flags, permisos); «Accesos» solo con equipo.miembro.ver
apps/web/components/module-plan.tsx         async; requireModuleAccess
apps/web/app/(app)/plan/[modulo]/page.tsx   requireModuleAccess en generateMetadata
apps/web/app/(app)/{campanas,finanzas,conexiones}/layout.tsx   NUEVOS · await requireModuleAccess('<slug>')
apps/web/app/(app)/{resumen,ventas,cotizar}/layout.tsx         NUEVOS · lo mismo, en carpetas de Rasheed (§0.5, decisión pendiente 2)
packages/db/src/queries/accesos.ts          getSessionMembership(tx): rol y tipo de workspace de la sesión; null sin membresía
packages/db/package.json                    + "./queries/accesos"
packages/db/test/accesos.test.ts            dueña del seed → owner; viewer insertada; sin membresía → null; otro workspace → null
apps/web/lib/permisos/*.test.ts             demo, sin sesión, con sesión; requirePermission lanza; requireModuleAccess 404
apps/web/content/modules.test.ts            permiso y bandera, en ese orden
apps/web/components/nav.test.tsx            Contador: sin Campañas, con Finanzas; Accesos con equipo.miembro.ver
apps/web/app/(app)/permisos-marco.test.tsx  los seis layouts con Contador, Mánager y bandera apagada, y contra pglite con viewer/member
apps/web/README.md                          §Reglas del marco: banderas y permisos, DEMO_USER_ID
packages/db/README.md                       queries/accesos en «qué importar»
apps/web/content/backlog.ts                 solo la entrada ACC-5
docs/propuestas/ACC-5.md                    este documento
```

Sin migraciones. Sin dependencias nuevas.

### 0.3 Decisiones

1. **`permisosDeLaSesion()` en `lib/permisos/sesion.ts`, sobre
   `queries/accesos.ts`.** Devuelve `ReadonlySet<string>` con los
   permisos de quien abrió la petición en el workspace actual,
   memorizado por petición con `cache` de React (el marco, la página y
   las Server Actions preguntan una vez). Tres ramas, en este orden:
   - **Sin llaves de Supabase (modo demo, el de `pnpm verificar` y del
     dev sin red): Dueño.** Igual que `DEMO_WORKSPACE_ID` elige el
     espacio, `DEMO_USER_ID` (nueva, solo demo) elige a quién se
     simula: con ella se lee la membresía real de ese `app_user` en el
     workspace de demo; sin ella, todos los permisos. Es lo que permite
     verificar en dev sin sesión (§0.4). Con llaves, la variable no
     existe para este archivo, como `DEMO_WORKSPACE_ID` en
     `lib/workspace/current.ts`.
   - **Con llaves y sin sesión: conjunto vacío**, sin abrir la base y
     sin redirigir (el marco de `/kit` se pinta con el enlace «Entrar»
     y ningún módulo). Una ruta protegida no llega aquí sin sesión: el
     middleware y `getCurrentContext` la mandan antes a `/login`.
   - **Con sesión:** `withWorkspace(getSessionMembership)` → rol y tipo
     de workspace → conjunto. Sin membresía (no debería pasar: el
     workspace actual sale de mis membresías) → vacío. Si la base falla,
     LANZA: `requirePermission` falla cerrado; el `Shell` lo recoge y
     pinta el menú sin módulos (la pantalla ya cae en su `error.tsx`).
   - El nombre es el de ACC-1 (`permisosDeLaSesion`, archivo
     `lib/permisos/sesion.ts`, que ACC-1 crea «hoy Dueño, TODO(ACC-3)»)
     y no `getPermisosSesion()` como decía el prompt: así el merge con
     ACC-1 es «tomar el archivo de ACC-5» y no dos funciones con dos
     nombres. Descartado: leer el rol de `getCurrentContext().workspaces`
     (cero consultas hoy, pero deja el marco atado a `identidad.ts`, de
     Rasheed, y ACC-3 tendría que tocar CIM-3 para el JOIN).
2. **Dos costuras para lo que no está en main, marcadas en el código:**
   - **ACC-1 (catálogo y matriz).** Hasta que llegue, el conjunto de un
     rol sale de `roles-provisionales.ts`: la fase 5 de la propuesta
     reducida a los **siete permisos de módulo** (lo único que ACC-5
     decide), con los nombres del borrador de ACC-1. Con ACC-1 en main,
     `permisosDeRol(kind, key)` de `@mc/core` lo reemplaza y el archivo
     se borra; `SinPermisoError` pasa a ser la de core y
     `requirePermission` recibe `Permiso` en vez de `string`.
   - **ACC-3 (esquema).** `getSessionMembership(tx)` lee
     `membership.role` (text, 0001) y `workspace.kind`; el mapa a rol
     de fábrica es el backfill que ACC-3 hará en SQL (owner→owner,
     admin→owner en creador y admin en agencia, member→editor en creador
     y manager en agencia, viewer→viewer, client→ninguno por la decisión
     D). Con ACC-3, la función pasa a `getSessionPermissions(tx)` con el
     JOIN `membership.role_id → role_permission` (SQL en §2) y el mapa
     desaparece.
   - Descartado: esperar a ACC-1/ACC-3 (bloquea), o merger la rama de
     ACC-1 a medio hacer (su archivo cambia mientras se escribe esto).
3. **`requireModule(slug, { flags, permisos })` compatible hacia atrás y
   puro.** Acepta el segundo argumento de antes (`Flags`) o el objeto de
   opciones; sin `permisos` no comprueba permiso (los tres llamadores de
   hoy siguen compilando y comportándose igual). Con `permisos`, evalúa
   **primero la bandera y después el permiso**, y en los dos casos sale
   por `notFound()`: 404, nunca 403. El que carga la sesión es
   `requireModuleAccess(slug)` en `lib/permisos/modulo.ts` (servidor):
   `modules.ts` no puede importar nada que abra la base porque `nav.tsx`
   (cliente) lo importa. Un módulo sin `permission` no pide permiso,
   como un módulo sin `flag` siempre está encendido: hoy son `cimientos`
   y `kit` (herramientas del equipo; `/kit` es pública) y los de fase 2,
   que están apagados por bandera y reciben su permiso cuando alguien
   los encienda (queda dicho en el JSDoc).
4. **El menú filtra con `productModules(flags, permisos)`** (el
   `.filter(can)` del prompt, dentro de la función para que la lateral y
   la móvil no diverjan). El `Shell` (servidor) resuelve
   `permisosDeLaSesion()` y pasa la lista a `SideNav` y `MobileNav` como
   prop, que es como ya reciben `flags`. «Accesos» (herramienta del
   equipo, hoy el plan) solo sale con `equipo.miembro.ver`; «Plan»,
   «Cimientos», «Reglas» y «Kit» no llevan permiso.
5. **La ruta directa se cierra con un `layout.tsx` por módulo** que
   hace `await requireModuleAccess('<slug>')`. Es un archivo de seis
   líneas que corre en TODAS las rutas del módulo, incluidas las que
   lleguen después, y el `notFound()` desde el layout sube al
   `not-found.tsx` de `(app)` con el marco puesto y el código 404 (no
   hay `loading.tsx` por encima). Los tres míos los pongo; los tres de
   Rasheed (`resumen`, `ventas`, `cotizar`) también, como archivos
   nuevos e idénticos, **pendientes de su visto bueno** (§0.5, decisión
   pendiente 2): sin ellos, un Contador no vería Ventas en el menú pero
   abriría `/ventas` por URL, y la historia pide lo contrario para todos
   los módulos. El precedente es el suyo: bajó el `Shell` a
   `app/(app)/layout.tsx` (carpeta mía) y pidió mi visto bueno después.
   Descartado: gatear en `app/(app)/layout.tsx` (un layout de servidor no
   conoce la ruta; haría falta que el middleware, de Rasheed, escribiera
   una cabecera) y en el middleware (corre en Edge, no puede abrir pglite
   ni pg).
6. **`/accesos` detrás de `equipo.miembro.ver`**, por `ModulePlan`, que
   pasa a componente asíncrono y usa `requireModuleAccess`; lo mismo
   `plan/[modulo]` (el plan de un módulo que no se puede abrir tampoco
   se ve). `/kit` sigue con el `requireModule('kit')` síncrono: sin
   permiso y pública.
7. **`requirePermission(permiso)` real, en `lib/permisos/index.ts`**:
   `permisosDeLaSesion()` y `SinPermisoError` si no está. Firma
   `Promise<void>`, la de ACC-1. **No toca las Server Actions**: ACC-1
   está insertando `requirePermission('…')` como primera línea en las
   tres de mis módulos en este momento (su fase 3); tocarlas aquí sería
   un conflicto seguro por la misma línea. El «terminado cuando» de las
   acciones se cumple con las dos ramas juntas: ACC-1 pone la llamada,
   ACC-5 la hace real. Se prueba aquí que la llamada falla con un rol
   sin el permiso.
8. **El visto bueno al layout de `(app)`.** Correcto: `/login`, el
   callback y `(public)` no llevan marco, y `force-dynamic` en el grupo
   es exactamente lo que ACC-5 necesita (el marco depende ahora también
   de los permisos de quien mira). Se da en §3.

### 0.4 Cómo se prueba

- **Consulta (pglite + seed):** Laura → `owner`/`creator`; una membresía
  `viewer` insertada con `admin()` para un `app_user` nuevo → `viewer`;
  un usuario sin membresía → `null`; el mismo usuario desde otro
  workspace → `null` (negativa de RLS); sin `app.user_id` → `null`.
- **Lib (vitest, sin base):** demo → todo; con llaves y sin sesión →
  vacío, sin abrir transacción; con sesión → el conjunto del rol que
  devuelve la consulta (mock de `@mc/db/queries/accesos`); una sola
  transacción por petición; `requirePermission` lanza `SinPermisoError`
  con Contador para `campanas.campana.ver` y pasa con Dueño; con base
  caída lanza (no concede).
- **Marco (vitest):** `requireModule` con Contador y `campanas` → 404;
  `finanzas` → módulo; bandera apagada gana aunque haya permiso;
  `productModules(flags, contador)` = `[finanzas]`; `SideNav`/`MobileNav`
  con Contador no pintan Campañas y sí Finanzas, y «Accesos» solo con
  `equipo.miembro.ver`. Los seis layouts con Contador (Campañas 404,
  Finanzas pasa), con Mánager (Campañas pasa; Finanzas 404 porque el
  mínimo es `finanzas.factura.ver` y el Mánager de fábrica no lo tiene;
  `/finanzas/flujo` no existe hasta FIN-6) y con bandera apagada.
- **Integración (vitest + pglite con seed, el patrón de
  `no-existe.test.tsx`):** con `getCurrentContext` falsificado para un
  `viewer` insertado en la base embebida, el layout de Finanzas responde
  404 y el de Campañas pasa, por el camino real (`withWorkspace` →
  `getSessionMembership` → matriz → `requireModule`).
- **Dev (sin llaves):** `pnpm --filter @mc/web dev -p 31xx`; sin
  `DEMO_USER_ID` → Dueño, seis módulos y Accesos, `/campanas` 200; con
  `DEMO_USER_ID` de un uuid que no es miembro → menú sin módulos,
  `/campanas`, `/finanzas` y `/accesos` 404, `/` 200; con
  `DEMO_USER_ID` de Laura → todo otra vez. Un Contador en dev necesita
  ACC-3 (no hay valor de `membership.role` que lo represente).

### 0.5 Decisiones pendientes de Nicolás

1. **Contador y `/campanas`.** ACC-1 (borrador) le da
   `campanas.campana.ver` («ve el nombre y monto de las campañas»); el
   «terminado cuando» de ACC-5 y la fila del backlog dicen que con
   Contador `/campanas` responde 404. Aquí manda el criterio de ACC-5:
   la matriz provisional deja al Contador sin `campanas.campana.ver` (el
   nombre y el monto los ve en Finanzas, en cada factura). Cuando ACC-1
   reemplace la matriz, la prueba `permisos-marco.test.tsx` fallará si
   ACC-1 conserva su lectura: hay que quitar ese permiso del Contador en
   `ROLES_SISTEMA` o cambiar el criterio de ACC-5. Conservador: sin el
   permiso (menos acceso).
2. **Los tres `layout.tsx` en carpetas de Rasheed** (`resumen`,
   `ventas`, `cotizar`). Están en esta rama para que la historia quede
   completa; si prefiere que los ponga él, se quitan del PR y van a §3
   como propuesta (el menú ya los esconde; solo quedaría abierta la
   URL directa).
3. **`DEMO_USER_ID`**, variable de desarrollo (no es un secreto: es un
   uuid del seed). La leo en `lib/permisos/sesion.ts` solo cuando no hay
   llaves. Lo natural es que viva en `lib/workspace/current.ts` junto a
   `DEMO_WORKSPACE_ID` y llegue como `identity` del contexto (así
   también `audit()` de ACC-2 tendría actor en demo): propuesta a
   Rasheed en §3.
4. **Los nombres de dos permisos mínimos** siguen al borrador de ACC-1
   (`ventas.negocio.ver`, `cotizar.cotizacion.ver`) y no al prompt de
   ACC-5 (`ventas.empresa.ver`, `cotizar.tarifario.ver`). Con ACC-1 en
   main, `permission: Permiso` no compila si difieren: es una línea.

### 0.6 Dudas que no bloquean

- Los route handlers de OAuth (`conexiones/oauth/[platform]/…`, detrás
  de `OAUTH_CONNECT`) no pasan por `requireModuleAccess` (un route
  handler no usa layouts). Les corresponde `conexiones.cuenta.conectar`
  con `requirePermission` y una respuesta 404; lo pone quien reactive
  CON-3. Fuera de alcance, dicho aquí.
- `/cuenta` (Rasheed, CIM-3) no es un módulo y no lleva permiso: es la
  ficha de la propia persona.

---

## 1. Lo que quedó construido

| Pieza | Dónde | Qué hace |
|---|---|---|
| Permiso por módulo | `apps/web/content/modules.ts` | `permission` en `ModuleDef` (los seis de producto y Accesos; `MODULE_PERMISSIONS` con los nombres del borrador de ACC-1); `can(permisos, m)`; `hasPermission(permisos, permiso)` (exacto o comodín `<módulo>.*`); `productModules(flags, permisos?)`; `requireModule(slug, { flags, permisos })`, puro, compatible con `requireModule(slug, flags)` y `requireModule(slug)`. Bandera primero, permiso después, 404 en los dos casos. |
| La sesión → permisos | `apps/web/lib/permisos/sesion.ts` | `permisosDeLaSesion()` con `cache` de React; demo → Dueño o `DEMO_USER_ID`; con llaves y sin sesión → vacío; con sesión → `getSessionMembership` en `withWorkspace`. Falla cerrado. |
| Server Actions | `apps/web/lib/permisos/index.ts` | `requirePermission(permiso)` real, `puede(permiso)`, `SinPermisoError` (`code`, `messageEs`, `permiso`; sin ids en el mensaje). |
| Ruta directa | `apps/web/lib/permisos/modulo.ts` + `app/(app)/<módulo>/layout.tsx` ×6 | `requireModuleAccess(slug)`; el layout de cada módulo lo llama y devuelve `children`. Con `not-found.tsx` de `(app)` y sin `loading.tsx` por encima, el 404 es de verdad. |
| Menú | `components/shell.tsx`, `components/nav.tsx` | El Shell (servidor) resuelve los permisos y baja la lista; `SideNav`/`MobileNav` filtran con `productModules(flags, permisos)`; «Accesos» solo con `equipo.miembro.ver`. Si la base falla, el menú va sin módulos y se registra. |
| Plan | `components/module-plan.tsx`, `app/(app)/plan/[modulo]/page.tsx` | `ModulePlan` es asíncrono y usa `requireModuleAccess`: `/accesos` y `/plan/<módulo>` respetan bandera y permiso. |
| Consulta | `packages/db/src/queries/accesos.ts` | `getSessionMembership(tx)`: `membership.role` y `workspace.kind` con `current_workspace_id()` y `current_user_id()`; sin identidad, null. Exportada como `@mc/db/queries/accesos`. |
| Matriz provisional | `apps/web/lib/permisos/roles-provisionales.ts` | Fase 5 por módulo con comodines, y `membership.role` → rol de fábrica (el backfill de ACC-3). **Se borra con ACC-1 y ACC-3.** |
| Pruebas | `packages/db/test/accesos.test.ts` (7), `lib/permisos/*.test.ts` (21), `content/modules.test.ts` (+7), `components/nav.test.tsx` (+4), `app/(app)/permisos-marco.test.tsx` (7), `app/(app)/permisos-marco-db.test.tsx` (3, contra Postgres embebido con el seed) | Ver §0.4. |
| Documentación | `apps/web/README.md` (§Reglas del marco, §Variables), `packages/db/README.md`, `lib/permisos/README.md`, `content/backlog.ts` | — |

Sin migraciones, sin dependencias nuevas, sin tocar `lib/auth/`,
`lib/workspace/` ni `queries/identidad.ts`.

## 2. La consulta que ACC-3 reemplaza

Hoy (`queries/accesos.ts`):

```sql
SELECT m.role, w.kind AS workspace_kind
FROM membership m JOIN workspace w ON w.id = m.workspace_id
WHERE m.workspace_id = current_workspace_id() AND m.user_id = current_user_id()
LIMIT 1;
```

Con ACC-3 (`membership.role_id`, `role`, `role_permission`), la misma
función pasa a devolver las llaves y la web deja de conocer roles:

```sql
-- getSessionPermissions(tx): Promise<string[]>
SELECT rp.permission_key
FROM membership m
JOIN role_permission rp ON rp.role_id = m.role_id
WHERE m.workspace_id = current_workspace_id() AND m.user_id = current_user_id();
```

`role_permission` no tiene `workspace_id`: necesita política EXISTS
sobre `role` (patrón 0018), y `role` de sistema (`workspace_id IS NULL`)
tiene que ser visible para `mc_app` (patrón `feature_flag`, 0020). Con
eso, `permisosDeLaSesion()` cambia dos líneas (`new Set(await
getSessionPermissions(tx))`) y `roles-provisionales.ts` se borra. Las
pruebas de `permisos-marco.test.tsx` no cambian: prueban conjuntos.

## 3. Lo que necesita Rasheed

1. **Visto bueno a `app/(app)/layout.tsx`** (el Shell bajado al grupo
   `(app)`, CIM-3 + COT-2): **dado**. Es lo correcto —`/login`, el
   callback y `(public)` no llevan marco— y `force-dynamic` en el grupo
   es justo lo que ACC-5 necesita: el marco depende ahora también de
   los permisos de quien mira.
2. **Tres archivos nuevos en tus carpetas**, idénticos a los míos:
   `app/(app)/resumen/layout.tsx`, `app/(app)/ventas/layout.tsx` y
   `app/(app)/cotizar/layout.tsx` (seis líneas: `await
   requireModuleAccess("<slug>")` y `return children`). Sin ellos, el
   menú esconde tu módulo pero la URL directa sigue abierta. No tocan
   ningún `page.tsx` tuyo ni tus `loading.tsx` (quedan dentro del
   layout, como Next los pone). Si prefieres ponerlos tú, se quitan de
   este PR. **Ningún `page.tsx` tuyo llama a `requireModule`**, así que
   no hay más archivos afectados; `plan/[modulo]` y `ModulePlan` (míos)
   sí, y ya aplican el permiso.
3. **`queries/accesos.ts`** es mío y nuevo (junto a tu
   `queries/identidad.ts`, que no toco). Cuando apliques ACC-3, la
   sustitución es la de §2.
4. **`DEMO_USER_ID`** la leo en `lib/permisos/sesion.ts` solo sin
   llaves. Lo natural es que viva junto a `DEMO_WORKSPACE_ID` en
   `lib/workspace/current.ts` y llegue como `identity` del `Contexto`
   en modo demo: entonces `audit()` (ACC-2) tendría actor también en
   demo y yo borro `permisosDeDemo()`. Propuesta, no urgencia.
5. **Un segundo usuario en el seed** para probar el marco en dev sin
   ACC-3: propongo en `db/seed/0003` (mío) o `0002` (tuyo) una fila
   `app_user` («Valeria Ruiz», `valeria@oncue.test`,
   `0000000e-0000-4000-8000-000000000001`) con membresía `viewer` en
   el espacio de Laura. Hoy la prueba lo inserta en pglite. Con ACC-3
   el seed debería traer además un Contador y un Mánager reales (son
   los roles del «terminado cuando» de ACC-5 y de ACC-4).
6. **Tus Server Actions** (Ventas, Cotizar, Resumen/importar) reciben
   `await requirePermission("…")` como primera línea cuando adoptes la
   convención (ACC-1 deja la lista de permisos en su propuesta);
   `requirePermission` ya es real desde esta historia. Los dos route
   handlers de OAuth (detrás de `OAUTH_CONNECT`) no pasan por el layout:
   les toca `conexiones.cuenta.conectar` cuando se reactive CON-3.
