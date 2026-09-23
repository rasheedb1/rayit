# `lib/permisos/` · qué puede hacer la sesión

La costura entre la sesión y el catálogo de permisos de `@mc/core`
(`packages/core/src/permisos.ts`, ACC-1). Dueño: Nicolás (ACC-1 y ACC-5).

| Archivo | Qué hace |
|---|---|
| `index.ts` | `requirePermission(permiso)`: la primera línea de toda Server Action. Lanza `SinPermisoError` (mensaje en español) si la sesión no tiene el permiso. `puede(permiso)` responde sin lanzar. Reexporta `SinPermisoError` y el tipo `Permiso`. |
| `sesion.ts` | `permisosDeLaSesion()`: los permisos de quien abrió la petición en el workspace actual, **una vez por petición** (`cache` de React), leídos de `membership.role_id → role_permission` con `getSessionPermissions` de `@mc/db/queries/accesos` (ACC-5). Modo demo sin llaves → Dueño, o los permisos reales de `DEMO_USER_ID`; con llaves y sin sesión → ninguno; base caída → lanza (falla cerrado). |
| `modulo.ts` | `requireModuleAccess(slug)`: `requireModule` de `content/modules.ts` con los permisos de la sesión. Lo llama el `layout.tsx` de cada módulo: sin bandera o sin el permiso mínimo, 404 (ACC-5). `requirePagePermission(permiso)`: lo mismo para una pantalla que pide más que su módulo (`/finanzas/flujo`). |

## La convención

```ts
"use server";
import { requirePermission } from "@/lib/permisos";

export async function crearFactura(_prev: ActionState, formData: FormData): Promise<ActionState> {
  await requirePermission("finanzas.factura.crear");
  // zod, withWorkspace, revalidatePath…
}
```

- La primera línea de código del cuerpo. Antes de validar, antes de
  abrir la transacción.
- El permiso es un literal del catálogo: uno que no existe no compila.
- Si una acción todavía no puede llamarlo (una rama sin ACC-1 integrada),
  lleva el comentario `// TODO(ACC-1): <permiso>` en su lugar.
- `convencion.test.ts` recorre `app/(app)/<módulo>/**/actions.ts` de los
  módulos de la lista `MODULOS_CON_CONVENCION` y falla si una función
  exportada no cumple. Al adoptar la convención en un módulo, se agrega
  a la lista.

## Banderas y permisos en el marco (ACC-5)

- Una bandera dice si el módulo **existe**; un permiso, si **esta
  persona** entra. `requireModule` los evalúa en ese orden y las dos
  responden **404**, nunca 403.
- Cada módulo declara su permiso mínimo en `content/modules.ts`
  (`permission`, de `PERMISO_MINIMO` de `@mc/core`).
- El menú esconde lo que no se puede abrir: el `Shell` (servidor) pasa
  los permisos a la navegación (cliente) como lista.
- Un route handler (`route.ts`) no pasa por el layout: llama a
  `requirePermission` y convierte el error él mismo.
- Nadie recibe permisos por omisión: sin sesión, nada; sin membresía,
  nada; base caída, error. El único «todo» es el modo demo sin llaves,
  que es el de las pruebas y del dev sin red.

## Por qué aquí y no en `lib/auth/`

La propuesta ACC (fase 6) pone `requirePermission` en `lib/auth/`, que
es de Rasheed (backlog §3.1). Para no tocar su carpeta vive aquí, en
una carpeta de Nicolás. Moverlo es cambiar la importación
`@/lib/permisos` en las acciones y en las pruebas; nada más depende de
la ruta.
