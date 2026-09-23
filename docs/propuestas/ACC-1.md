# ACC-1 · Catálogo de permisos y can() — plan y lo que necesita Rasheed

Escrito para: Nicolás (dueño de la historia) y Rasheed (dueño de
`lib/auth/`, `db/migrations/` y de las Server Actions de Resumen, Ventas
y Cotizar). Fecha: 23 de septiembre de 2026. Rama
`nicolas/ACC-1-catalogo-permisos`, worktree `rayit-acc1`, desde
`origin/main` `29460e3`.

**Qué es.** La lista cerrada de permisos de la plataforma con la forma
`<módulo>.<recurso>.<acción>`, los cinco roles de fábrica del workspace
de creador y los cinco del de agencia con su matriz (fase 5 de
`ACC-accesos-y-roles.md`), `can()`, `permisosDeRol()`, la regla «nadie
otorga lo que no tiene», la del último dueño, y un script que imprime la
semilla SQL para que ACC-3 no la escriba a mano. Más el
`requirePermission()` provisional de la web, que desde hoy abre toda
Server Action. Sin base de datos, sin pantalla, sin migraciones.

---

## 0. Plan (fase 1)

### 0.1 Archivos

```
packages/core/src/permisos.ts              NUEVO · catálogo, roles, can(), reglas, errores
packages/core/src/index.ts                 + export * from './permisos.ts'
packages/core/test/permisos.test.ts        NUEVO · matriz, reglas, errores
packages/core/scripts/permisos-sql.ts      NUEVO · imprime la semilla (permission, role, role_permission)
packages/core/test/permisos-sql.test.ts    NUEVO · N filas exactas y snapshot determinista
packages/core/test/snapshots/permisos.sql  NUEVO · la salida esperada (es lo que copia ACC-3)
packages/core/package.json                 + script "permisos:sql"
packages/core/tsconfig.json                + "scripts" en include
packages/core/README.md                    NUEVO · §permisos (el paquete no tenía README)
apps/web/lib/permisos/index.ts             NUEVO · requirePermission(), reexporta SinPermisoError
apps/web/lib/permisos/sesion.ts            NUEVO · permisosDeLaSesion(): hoy Dueño, TODO(ACC-3)
apps/web/lib/permisos/README.md            NUEVO · por qué vive aquí y no en lib/auth/
apps/web/lib/permisos/require-permission.test.ts   NUEVO · pasa con Dueño, falla con Contador
apps/web/lib/permisos/convencion.test.ts   NUEVO · prueba estática sobre app/(app)/**/actions.ts
apps/web/app/(app)/finanzas/facturas/actions.ts    3 acciones abren con requirePermission
apps/web/app/(app)/campanas/[id]/actions.ts        6 acciones
apps/web/app/(app)/conexiones/actions.ts           3 acciones
apps/web/content/backlog.ts                solo la entrada ACC-1
docs/propuestas/ACC-1.md                   este documento
```

### 0.2 Decisiones

1. **El catálogo es un `as const` en TypeScript, y la tabla `permission`
   de ACC-3 es su copia.** La propuesta ACC (decisión B) pone el catálogo
   «en una tabla, no en una constante», para que la pantalla de Equipo
   dibuje la matriz con etiquetas. Las dos cosas no se excluyen: la
   fuente de verdad es el archivo (el compilador rechaza un permiso que
   no existe; la fase 8 pide justo eso) y la tabla se genera desde él
   con el script. Cada entrada lleva `key`, `module`, `labelEs` y
   `sensitivity` (`normal` | `sensible`; sensible = dinero, cuentas
   conectadas y equipo). El tipo `Permiso` se deriva de las `key`.
   Descartado: solo tabla (un string cualquiera compila) y solo
   TypeScript (la pantalla de ACC-4 no tendría etiquetas sin importar
   core, que sí puede, pero ACC-9 quiere roles a medida persistidos).
2. **Nombres.** Módulo y recurso en español porque los identificadores
   del producto ya lo son; el módulo es uno de los siete del producto
   (`resumen`, `ventas`, `cotizar`, `campanas`, `finanzas`,
   `conexiones`, `equipo`) y la acción sale del vocabulario cerrado de
   catorce verbos que fijó Nicolás. Los dos conjuntos son tipos: una
   `key` fuera de `${Modulo}.${string}.${Accion}` no compila.
   - `cuenta.workspace.eliminar` de la propuesta **no entra**: ni el
     módulo `cuenta` ni el verbo `eliminar` están en los conjuntos
     cerrados, y en el MVP ninguna pantalla borra un workspace. Lo que
     distingue al Dueño del Administrador de agencia queda como
     `equipo.workspace.configurar` (nombre, moneda, zona horaria y
     cierre de la cuenta), que solo tiene el Dueño. **DECISIÓN PENDIENTE
     DE NICOLÁS**: si prefiere un módulo `cuenta` aparte, es renombrar
     una línea antes de ACC-3.
   - `finanzas.config.editar` de la propuesta pasa a
     `finanzas.ajustes.configurar` (FIN-8), por el vocabulario.
   - El verbo `calcular` queda en el vocabulario sin ningún permiso que
     lo use: guardar el tarifario es `cotizar.tarifario.editar` (lo que
     hace la persona es guardar; el cálculo lo hace core) y el resultado
     de campaña (CAM-5) lo calcula una vista, no una acción. Se usará
     cuando exista un botón que calcule algo a pedido.
3. **Qué entra en el catálogo.** Un permiso existe si (a) hoy hay una
   Server Action que lo necesita, en cualquier módulo de los dos dueños,
   o (b) la matriz de la fase 5 no se puede escribir sin él (el Mánager
   sin `finanzas.flujo.ver` ni `finanzas.gasto.*`; el Editor que marca
   entregables; el reporte que envía el Mánager). Lo demás se agrega en
   la historia que lo necesite, editando el archivo. Son 43 permisos
   (§1). Descartado: uno por historia futura (VEN-9 a VEN-16, FIN-4,
   FIN-7, RES-3): serían nombres inventados antes de ver la pantalla,
   que es el riesgo 1 de la fase 8.
4. **La matriz de fábrica es literal** (§2): cada rol lista sus permisos
   uno a uno, salvo el Dueño, que es «todo» (`PERMISOS.map(p => p.key)`)
   porque así lo dice la fase 5 y así no se olvida ninguno nuevo. Dos
   reglas van en código, no en la matriz: `permisosOtorgables()` y
   `puedeAsignarRol()` (intersección: nadie otorga lo que no tiene) y
   `esUltimoDueno()` / `assertNoEsUltimoDueno()` (el último dueño no se
   quita ni se degrada; la usa ACC-4, la función pura vive aquí).
5. **Lecturas conservadoras de la fase 5**, marcadas por si Nicolás las
   cambia (todas son una línea):
   - Mánager de creador: Finanzas solo `finanzas.cobro.ver` (el estado
     de cobro; en un workspace de creador todas las campañas son «las
     suyas», el recorte por campaña es alcance, ACC-6). Sin
     `finanzas.factura.ver`: la lista de facturas incluye las que no
     nacen de una campaña.
   - «Actualizar» una cuenta por @ (`actualizarCuenta`) exige
     `conexiones.cuenta.conectar`: gasta cuota de la casa y escribe un
     snapshot. El Mánager no lo tiene de fábrica; con la casilla
     «también puede conectar mis cuentas» de ACC-4, sí. **DECISIÓN
     PENDIENTE DE NICOLÁS**: si «Actualizar» debe bastar con
     `conexiones.cuenta.ver`.
   - Contador: `campanas.campana.ver` entero. La fase 5 dice «ver nombre
     y monto»; recortar campos es cosa de la pantalla o del alcance, no
     de un permiso.
   - Ejecutivo de cuenta de agencia: exactamente Ventas, Cotizar y
     Campañas, como dice la fase 5. Sin `resumen.panel.ver`.
   - Solo lectura: Equipo «—» en las dos matrices, así que no ve la
     lista de miembros.
   - `PERMISO_MINIMO` por módulo (lo que ACC-5 pasará a `requireModule`):
     el `.ver` principal de cada módulo. Para Finanzas es
     `finanzas.factura.ver`, así que el Mánager de fábrica **no abre**
     /finanzas y ve el cobro dentro de la campaña. Alternativa:
     `finanzas.cobro.ver`, que le abriría la portada con las cuentas por
     cobrar de todo el espacio.
6. **`can(permisos, permiso)` sobre `ReadonlySet<Permiso>`** y
   `permisosDeRol(kind, key)` que devuelve el conjunto congelado del rol
   de sistema (lanza `RolDesconocidoError` si no existe). ACC-3 cambiará
   de dónde salen los permisos de una sesión (de `role_permission`), no
   la forma en que se preguntan.
7. **Los errores viven en core**, con el patrón de `CampaignError`
   (`code` + `messageEs`): `PermisoError` como base, `SinPermisoError`
   (lleva el permiso y la etiqueta: «No tienes permiso para crear
   facturas.»), `RolDesconocidoError`, `UltimoDuenoError`. La propuesta
   ponía `SinPermisoError` junto a `requirePermission` en la web; va en
   core porque ACC-2 (bitácora), ACC-5 (marco) y el worker lo van a
   necesitar sin importar la web. `lib/permisos` lo reexporta.
8. **`requirePermission(permiso)` en `apps/web/lib/permisos/`**, no en
   `lib/auth/` (de Rasheed). Firma `Promise<void>`; lanza
   `SinPermisoError`. Hoy resuelve la sesión como Dueño a través de
   `permisosDeLaSesion()` (archivo aparte, con `TODO(ACC-3)`) para que
   ACC-3 cambie un archivo y las pruebas puedan sustituirlo por un rol
   sin permiso. **No toca la sesión hoy**: llamar a `getCurrentContext`
   antes de validar cambiaría el orden en que una acción sin sesión
   responde, y la historia pide no cambiar comportamiento.
   - Cómo se convierte el error: en páginas y layouts será `notFound()`
     (ACC-5, con `requireModule(slug, permiso)`: 404 y no 403 para no
     confirmar que el módulo existe). En Server Actions, hoy el error
     cae en la frontera del segmento (`error.tsx`) como cualquier otro
     error no previsto; es un caso de borde porque ACC-5 esconde antes
     lo que no se puede abrir. Convertirlo en `ActionState` con el
     mensaje dentro del formulario exige mover la llamada dentro del
     `try` de cada acción, que es justo lo contrario de «primera
     línea». **DECISIÓN PENDIENTE DE NICOLÁS**: (a) dejarlo en la
     frontera, o (b) que `messageOf` de cada módulo reconozca
     `SinPermisoError` y la convención pase a «primera línea del try».
     Se implementa (a); (b) es una línea por módulo cuando se decida.
9. **La prueba estática** (`lib/permisos/convencion.test.ts`) recorre
   `app/(app)/<módulo>/**/actions.ts` de los módulos con la convención
   adoptada (`campanas`, `finanzas`, `conexiones`; Rasheed agrega los
   suyos a la lista cuando los adapte) y, por cada
   `export async function`, exige que la primera línea de código del
   cuerpo sea `await requirePermission("<permiso del catálogo>")`, o
   que la preceda el comentario `// TODO(ACC-1): <permiso>`. Sin AST:
   un escáner de paréntesis para cerrar la firma (que puede ocupar
   varias líneas) y luego líneas, saltando comentarios y vacías. Es lo
   que hace cumplir la convención sin revisión humana.
10. **El script SQL** (`packages/core/scripts/permisos-sql.ts`) imprime
    tres `INSERT … ON CONFLICT DO NOTHING` con el esquema de la fase 4
    de la propuesta: `permission (key, module, label_es, sensitivity)`,
    `role (workspace_id NULL, key, workspace_kind, label_es,
    description_es, is_system)` y `role_permission` resolviendo el
    `role_id` con un `JOIN` sobre `(key, workspace_kind)`, porque el id
    es `gen_random_uuid()`. Es determinista (orden del catálogo) y la
    prueba compara la salida con `test/snapshots/permisos.sql`, así que
    cambiar la matriz sin regenerar el snapshot rompe la prueba. Nota
    para ACC-3: `DO NOTHING` no quita un permiso que un rol de sistema
    pierda después; si se quiere que la semilla mande sobre los roles
    de sistema, ACC-3 añade el `DELETE` (está escrito en §5).
11. **Sin dependencias nuevas.** Las pruebas de core siguen con
    `node --test`; las de la web con vitest y `node:fs`, como
    `frontera.test.tsx`.

### 0.3 Dudas que no bloquean

- Los dos route handlers de OAuth (`conexiones/oauth/[platform]/
  start|callback`) no son Server Actions y CON-3 está pospuesta detrás
  de `OAUTH_CONNECT`. Les corresponde `conexiones.cuenta.conectar`;
  se lo pondrá quien reactive CON-3 (o ACC-5, que decide cómo responde
  un route handler sin permiso). Queda en «fuera de alcance».
- `(public)/actions.ts` (media kit y aceptar cotización por enlace) no
  lleva permiso: no hay sesión ni workspace; el slug es la credencial
  (0030). Se documenta para que nadie lo «arregle».

---

## 1. El catálogo

(Se completa al cerrar la historia: la tabla sale de `PERMISOS`.)

## 2. La matriz de fábrica

(Se completa al cerrar.)

## 3. Lo que Rasheed puede mover a `lib/auth/` cuando quiera

(Se completa al cerrar.)

## 4. Los permisos de las Server Actions de Rasheed

(Se completa al cerrar.)

## 5. Cómo usa ACC-3 el script

(Se completa al cerrar.)
