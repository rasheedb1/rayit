# @mc/core · reglas puras

Lo que la web, el worker y `@mc/db` comparten y que no toca la base ni
React: máquinas de estado, aritmética de dinero y de métricas, y el
catálogo de permisos. Todo se prueba en milisegundos con `node --test`.

| Archivo | Dueño (backlog §3.1) | Qué hay |
|---|---|---|
| `scoring.ts` | Nicolás | Puntajes y umbrales de métricas (CON-6). |
| `facturacion.ts` | Nicolás | Dinero: `Decimal` como string, `BigInt` de centavos solo aquí (`toCents`, `fromCents`, `mulRateHalfUp`), estados de factura (FIN-1). |
| `campanas.ts` | Nicolás | Estados y transiciones de campaña, errores con `messageEs` (CAM-1, CAM-2). |
| `recordatorios.ts` | Nicolás | Recordatorios de cobro: en qué paso está una factura respecto a su vencimiento y el texto del correo de cada paso (FIN-4). `datosDePagoDe()` pasa de `settings.finanzas` (FIN-8) a las líneas de pago del correo. |
| `flujo-caja.ts` | Nicolás | Flujo de caja a ocho semanas (`projectCashflow`, FIN-6) y **la** regla de gastos recurrentes (`proyectarGastos`), que usan también la vista de gastos de FIN-5: una sola regla, una sola cifra. |
| `gastos.ts` | Nicolás | Las listas cerradas de gastos (categorías, recurrencias) y `sumarMeses` (FIN-5). |
| `ingresos-plataformas.ts` | Nicolás | El estimado mensual de lo que pagan las plataformas (FIN-7). |
| `tarifas.ts` | Rasheed | Cálculo del tarifario (COT-1). |
| `zonas.ts` | Rasheed | Zonas horarias y fin de día. |
| `permisos.ts` | Nicolás | Permisos, roles de fábrica y `can()` (ACC-1). Abajo. |

```bash
pnpm --filter @mc/core test        # node --test, sin base
pnpm --filter @mc/core typecheck
```

## Permisos (`permisos.ts`, ACC-1)

**La regla:** el código pregunta por permisos, nunca por roles
(backlog §7, decisión 7). Un rol es un nombre para un conjunto de
permisos. Agregar «Contador» es una fila de `role_permission`, no
cuarenta archivos.

```ts
import { can, permisosDeRol, SinPermisoError, type Permiso } from "@mc/core";

const permisos = permisosDeRol("creator", "manager");   // ReadonlySet<Permiso>
can(permisos, "campanas.reporte.enviar");                // true
can(permisos, "finanzas.flujo.ver");                     // false: decisión 9
```

### El catálogo

`PERMISOS` es un `as const` de 43 entradas `{ key, module, labelEs,
sensitivity }`. La clave tiene la forma `<módulo>.<recurso>.<acción>`:

- **módulo** ∈ `MODULOS` (`resumen`, `ventas`, `cotizar`, `campanas`,
  `finanzas`, `conexiones`, `equipo`), en español porque los
  identificadores del producto ya lo son;
- **recurso**: minúsculas sin acentos (`factura`, `cuenta`, `mediakit`);
- **acción** ∈ `ACCIONES`, un vocabulario cerrado de catorce verbos
  (`ver`, `crear`, `editar`, `registrar`, `asociar`, `calcular`,
  `generar`, `enviar`, `conectar`, `desconectar`, `importar`,
  `invitar`, `revocar`, `configurar`), cada uno con su significado en
  el JSDoc.

El tipo `Permiso` se deriva de las claves: un permiso que no está en el
catálogo **no compila**. `sensitivity` es `sensible` cuando toca dinero
(todo Finanzas), cuentas conectadas (`conectar`, `desconectar`) o el
equipo (todo Equipo); la pantalla de ACC-4 lo usa para pintar la
matriz. No existe un permiso para leer el token de una cuenta
(decisión E).

Un permiso existe si hoy hay una Server Action que lo necesita, en
cualquier módulo, o si la matriz de fábrica no se puede escribir sin
él. Lo demás lo agrega la historia que lo necesite, editando el
archivo y regenerando el snapshot (abajo).

`PERMISO_MINIMO[modulo]` es el `.ver` que abre cada módulo: lo que
ACC-5 le pasa a `requireModule()` junto a la bandera.

### Los roles de fábrica

`ROLES_SISTEMA`: cinco por tipo de workspace (`WORKSPACE_KINDS`:
`creator`, `agency`), con `key`, `labelEs`, `descriptionEs` y la lista
literal de permisos. La matriz completa está en
`docs/propuestas/ACC-1.md` §2; lo que importa recordar:

- **Dueño** tiene todo, en los dos tipos.
- **Mánager** de creador: Ventas, Cotizar y Campañas completas
  (incluido enviar el reporte), `finanzas.cobro.ver` y ver el resto.
  **Sin** flujo de caja, gastos, impuestos, configuración financiera,
  conectar o desconectar cuentas, ni invitar. Activarlo es una casilla
  consciente al invitar (ACC-4).
- **Contador**: todo Finanzas y nada más; las campañas le llegan por sus
  facturas (ACC-5: con sesión de Contador, `/campanas` responde 404).
- **Editor**: ver campañas, asociar posts y marcar entregables.
- **Solo lectura**: los `.ver` de todo menos Finanzas y Equipo.
- En la agencia, **Administrador** es Dueño menos
  `equipo.workspace.configurar`; **Ejecutivo de cuenta** es Ventas,
  Cotizar y Campañas.

`permisosDeRol(kind, key)` devuelve el conjunto (uno por rol,
compartido) y lanza `RolDesconocidoError` si no existe; `rolSistema()`
devuelve la definición o `undefined`.

### Las reglas que van en código

- **Nadie otorga lo que no tiene.** `permisosOtorgables(propios,
  pedidos)` es la intersección; `puedeAsignarRol(propios, kind, key)`
  dice si quien invita tiene todos los permisos del rol. Sin esto un
  administrador se hace dueño en dos clics.
- **El último dueño no se quita ni se degrada.** `esUltimoDueno(duenos,
  userId)` y `assertNoEsUltimoDueno()` (lanza `UltimoDuenoError`). La
  usa ACC-4; la función pura vive aquí.

### Errores

Como `CampaignError`: `code` y `messageEs`. `SinPermisoError(permiso)`
—«No tienes permiso para crear facturas.»— es lo que lanza
`requirePermission()` en la web (`apps/web/lib/permisos/`);
`PermisoDesconocidoError`, `RolDesconocidoError` y `UltimoDuenoError`
son bugs o reglas, también en español.

### La semilla SQL (para ACC-3)

```bash
pnpm --filter @mc/core permisos:sql > /tmp/permisos.sql
```

`scripts/permisos-sql.ts` imprime los `INSERT … ON CONFLICT DO NOTHING`
de `permission`, `role` y `role_permission` con el esquema de la
propuesta ACC (fase 4). Es determinista: `test/permisos-sql.test.ts`
lo compara con `test/snapshots/permisos.sql`, y
`packages/db/test/permisos-semilla.test.ts` lo ejecuta dos veces en
PGlite contra ese esquema (core no tiene base). Cambiar el catálogo o la matriz sin
regenerar el snapshot rompe la prueba:

```bash
pnpm --filter @mc/core permisos:sql > packages/core/test/snapshots/permisos.sql
```
