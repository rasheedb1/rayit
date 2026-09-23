# `lib/permisos/` · requirePermission()

La costura entre la sesión y el catálogo de permisos de `@mc/core`
(`packages/core/src/permisos.ts`, ACC-1). Dos archivos:

| Archivo | Qué hace |
|---|---|
| `index.ts` | `requirePermission(permiso)`: la primera línea de toda Server Action. Lanza `SinPermisoError` (mensaje en español) si la sesión no tiene el permiso. Reexporta `SinPermisoError` y el tipo `Permiso`. |
| `sesion.ts` | `permisosDeLaSesion()`: de dónde salen los permisos de la sesión actual. **Hoy devuelve siempre los del Dueño** (`TODO(ACC-3)`); cuando exista `role_permission`, lee la membresía del workspace actual. Es el único archivo que ACC-3 cambia. |

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

Un route handler (`route.ts`) o una página la llaman igual; cómo
convierten el error es cosa de ACC-5 (`notFound()` en páginas).

## Por qué aquí y no en `lib/auth/`

La propuesta ACC (fase 6) pone `requirePermission` en `lib/auth/`, que
es de Rasheed (backlog §3.1). Para no tocar su carpeta vive aquí, en
una carpeta de Nicolás. Moverlo es cambiar la importación
`@/lib/permisos` en las acciones y en las pruebas; nada más depende de
la ruta.
