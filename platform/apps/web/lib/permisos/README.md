# lib/permisos · qué puede hacer la sesión

Dueño: Nicolás (ACC-1 y ACC-5). Vive aquí y no en `lib/auth/` —donde la
propuesta ACC ponía `requirePermission`— porque `lib/auth/` es de
Rasheed (§3.1 del backlog) y estas piezas nacen de los módulos de
Nicolás; cuando Rasheed quiera moverlas, es cambiar cuatro importaciones.

| Archivo | Qué |
|---|---|
| `sesion.ts` | `permisosDeLaSesion()`: el conjunto de permisos de quien abrió la petición en el workspace actual, una vez por petición (`cache` de React). Demo sin llaves → Dueño (o la membresía de `DEMO_USER_ID`); con llaves y sin sesión → nada; con sesión → `getSessionMembership` de `@mc/db/queries/accesos`. Si la base no contesta, lanza: falla cerrado. |
| `index.ts` | `requirePermission(permiso)`, la primera línea de toda Server Action; `puede(permiso)` para decidir qué pintar; `SinPermisoError`. |
| `modulo.ts` | `requireModuleAccess(slug)`: `requireModule` de `content/modules.ts` con la sesión puesta. Lo llama el `layout.tsx` de cada módulo: sin bandera o sin permiso, 404. |
| `roles-provisionales.ts` | **Se borra con ACC-1 y ACC-3.** La matriz de la fase 5 reducida a qué módulo se abre, y el mapa de `membership.role` (0001) al rol de fábrica. |

## Las dos costuras

1. **ACC-1 (catálogo y matriz, `@mc/core`).** Hoy `permiso` es `string`
   y el conjunto de un rol sale de `roles-provisionales.ts`, donde el
   «Todo» de la fase 5 es el comodín `<módulo>.*`. Con ACC-1 en main:
   `permisosDeMembresia` pasa a `permisosDeRol(kind, key)`,
   `SinPermisoError` se reexporta de core, `requirePermission` recibe
   `Permiso`, y `MODULE_PERMISSIONS` de `content/modules.ts` se
   reemplaza por `PERMISO_MINIMO`.
2. **ACC-3 (esquema).** Hoy el rol es `membership.role`; con
   `membership.role_id → role_permission`, `getSessionMembership` se
   reemplaza por `getSessionPermissions(tx)` (el SQL está en
   `docs/propuestas/ACC-5.md` §2) y el mapa `rolDeFabrica` desaparece.

## Reglas

- Una bandera dice si el módulo **existe**; un permiso, si **esta
  persona** entra. Se evalúan en ese orden y las dos responden 404,
  nunca 403.
- El código pregunta por permisos, nunca por roles (decisión B).
- Nadie recibe permisos por omisión: sin sesión, nada; sin membresía,
  nada; base caída, error. El único «todo» es el modo demo sin llaves,
  que es el de las pruebas y del dev sin red.
