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
packages/db/test/permisos-semilla.test.ts  NUEVO · la semilla corre dos veces en PGlite y deja la matriz
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
   - Contador: **sin** `campanas.campana.ver`. La fase 5 dice «ver nombre
     y monto», pero ACC-5 exige que con sesión de Contador `/campanas`
     responda 404 (backlog.ts), y el permiso mínimo de Campañas es
     justo ese. El nombre y el monto de la campaña le llegan por la
     factura (`invoice.campaign_id`). Cambiado tras `/code-review`.
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
    `node --test` y sin base; la ejecución de la semilla en Postgres
    vive en `packages/db/test/permisos-semilla.test.ts`, que ya tiene
    PGlite. Las de la web, con vitest y `node:fs`, como
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

43 permisos, generados desde `PERMISOS` (`packages/core/src/permisos.ts`).
`sensible` = dinero, cuentas conectadas o equipo (decisión E). No existe
un permiso para leer el token de una cuenta.

| Permiso | Módulo | Etiqueta | Sensibilidad |
|---|---|---|---|
| `resumen.panel.ver` | resumen | Ver el resumen | normal |
| `resumen.metricas.importar` | resumen | Importar métricas por CSV | normal |
| `ventas.senal.ver` | ventas | Ver el radar de señales | normal |
| `ventas.senal.registrar` | ventas | Anotar, aceptar y descartar señales | normal |
| `ventas.senal.importar` | ventas | Cargar una lista de marcas por CSV | normal |
| `ventas.empresa.ver` | ventas | Ver empresas y contactos | normal |
| `ventas.empresa.crear` | ventas | Crear empresas | normal |
| `ventas.empresa.editar` | ventas | Editar empresas y sus contactos | normal |
| `ventas.negocio.ver` | ventas | Ver el pipeline de negocios | normal |
| `ventas.negocio.crear` | ventas | Crear negocios | normal |
| `ventas.negocio.editar` | ventas | Mover negocios de etapa | normal |
| `cotizar.tarifario.ver` | cotizar | Ver el tarifario | normal |
| `cotizar.tarifario.editar` | cotizar | Guardar el tarifario | normal |
| `cotizar.mediakit.ver` | cotizar | Ver los media kits | normal |
| `cotizar.mediakit.generar` | cotizar | Generar un media kit | normal |
| `cotizar.mediakit.editar` | cotizar | Publicar, despublicar y desbloquear media kits | normal |
| `cotizar.cotizacion.ver` | cotizar | Ver las cotizaciones | normal |
| `cotizar.cotizacion.crear` | cotizar | Crear cotizaciones | normal |
| `cotizar.cotizacion.editar` | cotizar | Editar y borrar borradores de cotización | normal |
| `cotizar.cotizacion.enviar` | cotizar | Enviar cotizaciones y registrar la respuesta de la marca | normal |
| `campanas.campana.ver` | campanas | Ver las campañas | normal |
| `campanas.campana.crear` | campanas | Crear campañas | normal |
| `campanas.campana.editar` | campanas | Editar campañas y cambiar su estado | normal |
| `campanas.post.asociar` | campanas | Asociar posts y marcar entregables | normal |
| `campanas.aporte.registrar` | campanas | Registrar lo que aporta la marca | normal |
| `campanas.reporte.enviar` | campanas | Enviar el reporte a la marca | normal |
| `finanzas.factura.ver` | finanzas | Ver las facturas | sensible |
| `finanzas.factura.crear` | finanzas | Crear facturas | sensible |
| `finanzas.factura.editar` | finanzas | Marcar facturas como enviadas o anularlas | sensible |
| `finanzas.pago.registrar` | finanzas | Registrar pagos | sensible |
| `finanzas.cobro.ver` | finanzas | Ver el estado de cobro de las campañas | sensible |
| `finanzas.gasto.ver` | finanzas | Ver los gastos | sensible |
| `finanzas.gasto.registrar` | finanzas | Registrar gastos | sensible |
| `finanzas.flujo.ver` | finanzas | Ver el flujo de caja y la reserva de impuestos | sensible |
| `finanzas.ajustes.configurar` | finanzas | Configurar los parámetros financieros | sensible |
| `conexiones.cuenta.ver` | conexiones | Ver el estado de las cuentas conectadas | normal |
| `conexiones.cuenta.conectar` | conexiones | Conectar cuentas y pedir una lectura nueva | sensible |
| `conexiones.cuenta.desconectar` | conexiones | Quitar cuentas conectadas | sensible |
| `equipo.miembro.ver` | equipo | Ver quién está en el espacio | sensible |
| `equipo.miembro.invitar` | equipo | Invitar personas al espacio | sensible |
| `equipo.miembro.revocar` | equipo | Quitar personas del espacio | sensible |
| `equipo.rol.editar` | equipo | Cambiar el rol de una persona | sensible |
| `equipo.workspace.configurar` | equipo | Configurar el espacio y cerrar la cuenta | sensible |

Lo que quedó fuera y quién lo agrega, cuando exista la acción: VEN-4 a
VEN-16 (seguimientos, pitch, outreach), FIN-4 (recordatorios), FIN-7
(ingresos por CSV, sprint 6), RES-3, AGE (`equipo.concesion.*`).
`calcular` está en el vocabulario sin uso hasta que haya un cálculo a
pedido.

## 2. La matriz de fábrica

Generada desde `ROLES_SISTEMA`; es exactamente lo que deja la semilla
(`packages/db/test/permisos-semilla.test.ts` lo comprueba fila por fila en PGlite).

### Workspace de creador

| Permiso | Dueño (`owner`) | Mánager (`manager`) | Editor (`editor`) | Contador (`finance`) | Solo lectura (`viewer`) |
|---|:-:|:-:|:-:|:-:|:-:|
| `resumen.panel.ver` | ● | ● | ● | — | ● |
| `resumen.metricas.importar` | ● | — | — | — | — |
| `ventas.senal.ver` | ● | ● | — | — | ● |
| `ventas.senal.registrar` | ● | ● | — | — | — |
| `ventas.senal.importar` | ● | ● | — | — | — |
| `ventas.empresa.ver` | ● | ● | — | — | ● |
| `ventas.empresa.crear` | ● | ● | — | — | — |
| `ventas.empresa.editar` | ● | ● | — | — | — |
| `ventas.negocio.ver` | ● | ● | — | — | ● |
| `ventas.negocio.crear` | ● | ● | — | — | — |
| `ventas.negocio.editar` | ● | ● | — | — | — |
| `cotizar.tarifario.ver` | ● | ● | — | — | ● |
| `cotizar.tarifario.editar` | ● | ● | — | — | — |
| `cotizar.mediakit.ver` | ● | ● | — | — | ● |
| `cotizar.mediakit.generar` | ● | ● | — | — | — |
| `cotizar.mediakit.editar` | ● | ● | — | — | — |
| `cotizar.cotizacion.ver` | ● | ● | — | — | ● |
| `cotizar.cotizacion.crear` | ● | ● | — | — | — |
| `cotizar.cotizacion.editar` | ● | ● | — | — | — |
| `cotizar.cotizacion.enviar` | ● | ● | — | — | — |
| `campanas.campana.ver` | ● | ● | ● | — | ● |
| `campanas.campana.crear` | ● | ● | — | — | — |
| `campanas.campana.editar` | ● | ● | — | — | — |
| `campanas.post.asociar` | ● | ● | ● | — | — |
| `campanas.aporte.registrar` | ● | ● | — | — | — |
| `campanas.reporte.enviar` | ● | ● | — | — | — |
| `finanzas.factura.ver` | ● | — | — | ● | — |
| `finanzas.factura.crear` | ● | — | — | ● | — |
| `finanzas.factura.editar` | ● | — | — | ● | — |
| `finanzas.pago.registrar` | ● | — | — | ● | — |
| `finanzas.cobro.ver` | ● | ● | — | ● | — |
| `finanzas.gasto.ver` | ● | — | — | ● | — |
| `finanzas.gasto.registrar` | ● | — | — | ● | — |
| `finanzas.flujo.ver` | ● | — | — | ● | — |
| `finanzas.ajustes.configurar` | ● | — | — | ● | — |
| `conexiones.cuenta.ver` | ● | ● | ● | — | ● |
| `conexiones.cuenta.conectar` | ● | — | — | — | — |
| `conexiones.cuenta.desconectar` | ● | — | — | — | — |
| `equipo.miembro.ver` | ● | ● | — | — | — |
| `equipo.miembro.invitar` | ● | — | — | — | — |
| `equipo.miembro.revocar` | ● | — | — | — | — |
| `equipo.rol.editar` | ● | — | — | — | — |
| `equipo.workspace.configurar` | ● | — | — | — | — |
| **Total** | 43 | 28 | 4 | 9 | 9 |

### Workspace de agencia

| Permiso | Dueño (`owner`) | Administrador (`admin`) | Ejecutivo de cuenta (`manager`) | Contador (`finance`) | Solo lectura (`viewer`) |
|---|:-:|:-:|:-:|:-:|:-:|
| `resumen.panel.ver` | ● | ● | — | — | ● |
| `resumen.metricas.importar` | ● | ● | — | — | — |
| `ventas.senal.ver` | ● | ● | ● | — | ● |
| `ventas.senal.registrar` | ● | ● | ● | — | — |
| `ventas.senal.importar` | ● | ● | ● | — | — |
| `ventas.empresa.ver` | ● | ● | ● | — | ● |
| `ventas.empresa.crear` | ● | ● | ● | — | — |
| `ventas.empresa.editar` | ● | ● | ● | — | — |
| `ventas.negocio.ver` | ● | ● | ● | — | ● |
| `ventas.negocio.crear` | ● | ● | ● | — | — |
| `ventas.negocio.editar` | ● | ● | ● | — | — |
| `cotizar.tarifario.ver` | ● | ● | ● | — | ● |
| `cotizar.tarifario.editar` | ● | ● | ● | — | — |
| `cotizar.mediakit.ver` | ● | ● | ● | — | ● |
| `cotizar.mediakit.generar` | ● | ● | ● | — | — |
| `cotizar.mediakit.editar` | ● | ● | ● | — | — |
| `cotizar.cotizacion.ver` | ● | ● | ● | — | ● |
| `cotizar.cotizacion.crear` | ● | ● | ● | — | — |
| `cotizar.cotizacion.editar` | ● | ● | ● | — | — |
| `cotizar.cotizacion.enviar` | ● | ● | ● | — | — |
| `campanas.campana.ver` | ● | ● | ● | — | ● |
| `campanas.campana.crear` | ● | ● | ● | — | — |
| `campanas.campana.editar` | ● | ● | ● | — | — |
| `campanas.post.asociar` | ● | ● | ● | — | — |
| `campanas.aporte.registrar` | ● | ● | ● | — | — |
| `campanas.reporte.enviar` | ● | ● | ● | — | — |
| `finanzas.factura.ver` | ● | ● | — | ● | — |
| `finanzas.factura.crear` | ● | ● | — | ● | — |
| `finanzas.factura.editar` | ● | ● | — | ● | — |
| `finanzas.pago.registrar` | ● | ● | — | ● | — |
| `finanzas.cobro.ver` | ● | ● | — | ● | — |
| `finanzas.gasto.ver` | ● | ● | — | ● | — |
| `finanzas.gasto.registrar` | ● | ● | — | ● | — |
| `finanzas.flujo.ver` | ● | ● | — | ● | — |
| `finanzas.ajustes.configurar` | ● | ● | — | ● | — |
| `conexiones.cuenta.ver` | ● | ● | — | — | ● |
| `conexiones.cuenta.conectar` | ● | ● | — | — | — |
| `conexiones.cuenta.desconectar` | ● | ● | — | — | — |
| `equipo.miembro.ver` | ● | ● | — | — | — |
| `equipo.miembro.invitar` | ● | ● | — | — | — |
| `equipo.miembro.revocar` | ● | ● | — | — | — |
| `equipo.rol.editar` | ● | ● | — | — | — |
| `equipo.workspace.configurar` | ● | — | — | — | — |
| **Total** | 43 | 42 | 24 | 9 | 9 |

Lecturas conservadoras de la fase 5 (una línea cada una si Nicolás las
cambia): §0.2, punto 5.

## 3. Lo que Rasheed puede mover a `lib/auth/` cuando quiera

`apps/web/lib/permisos/` tiene dos archivos y ninguna otra dependencia
que `@mc/core` y `server-only`:

| Archivo | Qué es | Al moverlo |
|---|---|---|
| `index.ts` | `requirePermission(permiso)`; reexporta `SinPermisoError` y `Permiso` | Cambiar `@/lib/permisos` por la ruta nueva en las tres `actions.ts` de Nicolás, en `convencion.test.ts` (la expresión regular de la importación) y en `require-permission.test.ts`. Nada más la conoce. |
| `sesion.ts` | `permisosDeLaSesion()`: hoy Dueño, `TODO(ACC-3)` | Es donde ACC-3 lee `membership.role_id → role_permission` del workspace actual (`getCurrentContext`) y lo memoriza por petición con `cache` de React. La firma (`Promise<ReadonlySet<Permiso>>`) no cambia. |

Convenciones que ya están tomadas y conviene conservar al mover:
`SinPermisoError` vive en core (ACC-2, ACC-5 y el worker lo necesitan
sin importar la web); en páginas se convierte con `notFound()` (ACC-5,
`requireModule(slug, permiso)`); en Server Actions hoy cae en la
frontera del segmento (§0.2, punto 8, decisión pendiente).

## 4. Los permisos de las Server Actions de Rasheed

Sin tocar sus archivos. Cuando adopte la convención, cada función abre
con `await requirePermission("<permiso>")` como primera línea de código
y agrega el módulo a `MODULOS_CON_CONVENCION` en
`apps/web/lib/permisos/convencion.test.ts`, que desde entonces la hace
cumplir. Si prefiere hacerlo por partes, `// TODO(ACC-1): <permiso>`
como primera línea del cuerpo también pasa la prueba.

### `resumen/importar/actions.ts`

| Acción | Permiso |
|---|---|
| `buscarPostsConocidos` | `resumen.metricas.importar` (es el paso 3 de la importación; el route handler `lote/route.ts` que escribe, el mismo) |

### `ventas/actions.ts`

| Acción | Permiso |
|---|---|
| `anotarSenal`, `aceptarSenal`, `descartarSenal` | `ventas.senal.registrar` |
| `cargarLista` | `ventas.senal.importar` |
| `crearEmpresa` | `ventas.empresa.crear` |
| `editarEmpresa`, `cambiarRelacion`, `crearContacto`, `editarContacto`, `darDeBaja` | `ventas.empresa.editar` |
| `crearNegocio` | `ventas.negocio.crear` |
| `moverNegocio` | `ventas.negocio.editar` |

### `cotizar/actions.ts`

| Acción | Permiso |
|---|---|
| `guardarTarifario` | `cotizar.tarifario.editar` |
| `generarMediaKit` | `cotizar.mediakit.generar` |
| `desbloquearMediaKit`, `cambiarPublicacionMediaKit`, `marcarAvisoBloqueoVisto` | `cotizar.mediakit.editar` |
| `crearCotizacion` | `cotizar.cotizacion.crear` |
| `editarCotizacion`, `eliminarBorrador`, `marcarAvisoVisto` | `cotizar.cotizacion.editar` |
| `enviarCotizacion`, `aceptarCotizacion`, `rechazarCotizacion` | `cotizar.cotizacion.enviar` (enviar y registrar la respuesta de la marca) |
| `crearCampanaDeCotizacion`, `crearCampanaConVentana` | `campanas.campana.crear` (viven en Cotizar pero lo que crean es la campaña, CAM-2) |

Nota sobre `aceptarCotizacion` (COT-4): acepta la cotización, gana el
negocio y crea la campaña en una transacción. Un solo permiso
(`cotizar.cotizacion.enviar`) es la lectura de producto: quien negocia
cierra; el Mánager lo tiene. Si se prefiere exigir también
`campanas.campana.crear`, son dos líneas.

### `(public)/actions.ts`

`abrirMediaKitProtegido` y `aceptarCotizacionPublica` **no llevan
permiso**: no hay sesión ni workspace, el slug es la credencial y las
funciones SECURITY DEFINER de 0030 deciden (`withPublicShare`). Que
nadie lo «arregle».

### Route handlers (no son Server Actions)

| Archivo | Permiso |
|---|---|
| `resumen/importar/lote/route.ts` | `resumen.metricas.importar` |
| `conexiones/oauth/[platform]/start` y `callback` | `conexiones.cuenta.conectar` (CON-3, pospuesta; lo pone quien la reactive) |

Cómo responde un route handler sin permiso lo decide ACC-5 (404, como
las páginas).

## 5. Cómo usa ACC-3 el script

```bash
cd platform
pnpm --filter @mc/core permisos:sql > /tmp/permisos.sql
```

Imprime tres `INSERT … ON CONFLICT DO NOTHING` (permission, role,
role_permission) con el esquema de la fase 4 de la propuesta ACC; el
`role_id` se resuelve por `(key, workspace_kind) WHERE workspace_id IS
NULL`, así que `role.id` puede seguir siendo `gen_random_uuid()`. La
salida es idéntica a `packages/core/test/snapshots/permisos.sql`.

1. La migración `00NN_access_control.sql` crea las tablas (fase 4) y
   pega la salida al final, o la deja en `db/seed/0001_catalog.sql`
   (roles de sistema como `feature_flag` en 0009). El número: `git
   fetch` y el más alto en todas las ramas más uno; `0023` no se
   recicla sin preguntar a Nicolás.
2. Después de migrar, contar: `SELECT count(*) FROM permission` → 43;
   `role` (workspace_id IS NULL) → 10; `role_permission` → 220.
3. Cada vez que cambie el catálogo o la matriz, se regenera el snapshot
   (`pnpm --filter @mc/core permisos:sql > packages/core/test/snapshots/
   permisos.sql`) y una migración nueva vuelve a pegar la salida: las
   aplicadas son inmutables.
4. Si se quiere que la semilla **mande** sobre los roles de sistema
   (que quitar un permiso de la matriz lo quite también en la base), la
   migración añade antes del tercer INSERT:

   ```sql
   DELETE FROM role_permission rp
    USING role r
    WHERE r.id = rp.role_id AND r.workspace_id IS NULL AND r.is_system
      AND (r.key, r.workspace_kind, rp.permission_key) NOT IN (VALUES
        -- las mismas tuplas del tercer INSERT
      );
   ```

   No está en el script porque los roles a medida (ACC-9) tienen
   `workspace_id` y no se tocan; es una decisión de ACC-3.
5. `membership.role → role_id`: el backfill por `key` mapea `owner →
   owner`, `admin → manager` (en un workspace de creador no hay
   `admin`), `member → editor`, `viewer → viewer`, `client → viewer`
   (decisión D: la marca no tiene cuenta; el valor se deja en el enum
   pero ninguna fila real lo usa). Hoy no hay filas reales fuera del
   seed (`demo@oncue.test` es `owner`).

## 6. Revisión (`/code-review` en nivel alto)

Nueve hallazgos. Ocho resueltos y uno justificado.

| # | Hallazgo | Qué se hizo |
|---|---|---|
| 1 | El Contador tenía `campanas.campana.ver`, que es el permiso mínimo de Campañas: el criterio de ACC-5 («con sesión de Contador, /campanas responde 404») era imposible | Resuelto: el Contador de creador y de agencia quedan con todo Finanzas y nada más. Prueba: `PERMISO_MINIMO.campanas` no está en su conjunto. §0.2, punto 5 |
| 2 | La prueba estática tomaba la llave de un tipo de retorno (`Promise<{ ok: boolean }>`) como inicio del cuerpo | Resuelto: `inicioDelCuerpo()` lleva profundidad de `<>` y `{}`; prueba con tres firmas |
| 3 | No miraba `export const x = async (…) =>` ni funciones con genéricos | Resuelto: la cabecera las reconoce; prueba con una flecha sin permiso que sí se detecta |
| 4 | El `TODO(ACC-3)` decía que ningún código lee `membership.role`; lo leen el selector de espacios y `/cuenta` | Resuelto: el comentario de `sesion.ts` nombra los usos y apunta al mapa de §5 |
| 5 | `esUltimoDueno(['u1','u1'], 'u1')` devolvía `false` | Resuelto: cuenta ids distintos; prueba nueva |
| 6 | El script callaba en un checkout con enlaces simbólicos (`/tmp` en macOS) | Resuelto: compara con `realpathSync(argv[1])` |
| 7 | PGlite entraba como dependencia de core y la contradecía («sin base», «sin dependencias») | Resuelto: la ejecución en Postgres pasa a `packages/db/test/permisos-semilla.test.ts`; core vuelve a no tener dependencias nuevas |
| 8 | La prueba exigía la lista exacta de `actions.ts`: un archivo nuevo la rompía | Resuelto: `arrayContaining` con los tres; uno nuevo entra solo y queda sujeto a la convención |
| 9 | Identificadores en español (`permisosDeRol`, `SinPermisoError`…) contra «identificadores en inglés» de CLAUDE.md | Justificado: el prompt de la historia pide nombres en español para módulo, recurso y acción, y core ya tiene el precedente (`finDelDiaEnZona`, `TarifaError`, `pctToRate` mezclado), igual que las Server Actions (`crearFactura`). Renombrar es mecánico si Nicolás lo pide antes de ACC-3 |

## 7. Verificación y seguridad

`/security-review`: **sin hallazgos**. El generador SQL solo lee
constantes; `requirePermission` es una comprobación en memoria que va
antes de `withWorkspace` y RLS sin reemplazarlas; los permisos de las
acciones tienen el tipo `Permiso`; `puedeAsignarRol` impide que un
Administrador de agencia nombre Dueño.

Verificación del 23-sep sobre `f51ae29`:

| Qué | Resultado |
|---|---|
| core | 95 pruebas, 0 fallos (`node --test`, sin base) |
| db | 603 pruebas, 0 fallos (incluida `permisos-semilla.test.ts`) |
| connectors · worker · raíz | 180 · 47 · 8, 0 fallos |
| web | 88 archivos, 739 pruebas, 0 fallos; typecheck y lint limpios |
| `next build` | compila; 44 rutas |
| En dev (puerto 3141, base embebida) | `marcarPrincipal` 303 y el post cambia de principal; `cambiarEstadoFactura(…, "void")` 303 y la factura queda «Anulada»; `desconectarConexion` con un id inexistente 303 a `?aviso=Esa cuenta ya no está en la lista.`: el mismo comportamiento que antes de ACC-1 |

**Un error previo, no de esta rama.** `pnpm verificar` marca
`@mc/web#test` como fallida por un rechazo no manejado de undici
(`ERR_INVALID_STATE: ReadableStream is already closed`) que se origina en
`app/(app)/resumen/importar/lote.test.ts` (RES-6, Rasheed). Las 17
pruebas del archivo pasan; el rechazo sale siempre, también sobre
`origin/main` `29460e3` sin ningún cambio de ACC-1. Para Rasheed: cerrar
o consumir el cuerpo de la respuesta en esa prueba.
