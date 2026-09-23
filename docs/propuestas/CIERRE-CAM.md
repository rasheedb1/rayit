# CIERRE-CAM · Cierre del módulo Campañas (CAM-1 a CAM-6)

Escrito para: Nicolás (dueño del módulo, aplica la migración y hace la
prueba de humo), Rasheed (dueño de `db/migrations/` y de
`packages/db/src/esquema.ts`, que esta rama toca) y quien revise el PR.
Rama `nicolas/CAM-cierre-modulo`, worktree `../rayit-cierre-cam`, desde
`origin/main`. Fecha: 23 de septiembre de 2026.

---

## 0. Inventario (foto del 23-sep por la tarde)

### 0.1 Git

- `origin/main` = `098b25a` (P0 entró mientras se hacía la foto: arregla
  las tres pruebas rojas de `lib/permisos/paginas.test.ts` en
  `finanzas/ingresos/*`). La rama parte de ahí por avance rápido.
- Producción (`on-cue-web`) sirve `7737b62` (FIN-7).
- Supabase: 0001–0039 aplicadas (0023 es hueco). 0040 reservada para
  ACC-6; **0041 reservada para esta rama**.
- Ramas de CAM frente a `main` (`git cherry origin/main <rama>`):

| Rama | Commits que main no tiene | Qué hacer |
|---|---|---|
| `nicolas/CAM-1-ficha-campana` | 0 | nada |
| `nicolas/CAM-2-campana-desde-cotizacion` | 0 | nada |
| `nicolas/CAM-3-seguidores-marca` | 0 | nada |
| `nicolas/CAM-4-aporte-marca` | 1: `0bfa72c` (una fila en `CAM-4.md` §2 sobre el rojo de `resumen/importar/lote.test.ts`) | **No se trae**: ya no aplica. `pnpm verificar` sobre `cf90d57` ya no da ese rechazo de `undici` (el log de esta foto no tiene ningún «Unhandled»); los únicos rojos eran los tres de `finanzas/ingresos`, que P0 arregló. Traerlo metería en la propuesta una afirmación falsa. |
| `nicolas/CAM-5-resultado-campana` | 0 | nada |
| `nicolas/CAM-6-reporte-marca` | 0 | nada |

No hay integración que hacer: F1 es solo la migración 0041.

### 0.2 Cada historia frente a su «terminado cuando» (`docs/backlog-mvp.md` §5)

| Historia | Terminado cuando | En main | Lo que falta |
|---|---|---|---|
| CAM-1 | Se asocian dos posts a una campaña y aparecen con sus views. | Sí, desde el 22-sep, y en producción. | Visto bueno al `loading.tsx` de Rasheed (F3). Costura con FIN-1 sin prueba propia de la ruta (F2). |
| CAM-2 | Rasheed la llama desde COT-4 sin pedir cambios. | Sí; COT-4 la llama desde el panel y el enlace. | Nada de código; la costura entra en la prueba del ciclo. |
| CAM-3 | La curva sale del snapshot con su línea base de dos semanas. | Sí, con 0035 aplicada. | La lectura diaria (`brand.snapshot`) espera al worker (WRK); «Actualizar ahora» funciona. Nota vieja del tablero («falta aplicar 0035»). |
| CAM-4 | Un CSV de ventas diarias aparece en la ficha. | Sí. | Dos `TODO(ACC-2)` viejos en `actions.ts` (ACC-2 ya está en main). |
| CAM-5 | Los seis KPIs salen de la tabla; sin datos de la marca dice «sin datos», no cero. | Sí. | **«Recalcular» apagado**: `mc_app` no tiene INSERT/UPDATE sobre `campaign_result` (0025 §5). El cálculo de cada mañana espera al worker. Nota vieja («rama encadenada sobre CAM-4»). |
| CAM-6 | El reporte no cambia aunque lleguen snapshots nuevos. | Sí, con 0037 aplicada. | Nota vieja («falta aplicar 0037»). |

Además: **nunca se probó el ciclo entero en una sola prueba**, y las
decisiones pendientes están repartidas en cinco propuestas.

### 0.3 Plan

1. **F1** · `0041_campaign_result_escritura_web.sql`: GRANT INSERT,
   UPDATE a `mc_app`, política que ata cada fila a una campaña visible
   de su mismo workspace, disparador de referencias en las dos claves
   ajenas; `PRIVILEGIOS_DE_LA_APP` en `esquema.ts` (de Rasheed, anotado
   en §3). «Recalcular» ya se enciende solo con `has_table_privilege`;
   se añade que la ficha tampoco lo enseñe a un rol sin
   `campanas.resultado.calcular` (ni «Generar» sin
   `campanas.reporte.generar`).
2. **F2** · Costuras con su prueba y la **prueba del ciclo**. (Se planeó
   en `packages/db`; acabó en la web, `apps/web/app/(app)/campanas/ciclo-db.test.ts`,
   porque ahí encadena las Server Actions reales —aceptar la cotización,
   aporte por formulario y CSV, «Recalcular», «Facturar», generar y enviar
   el reporte— y la página pública, no solo las consultas.)
3. **F3** · `TODO(ACC-2)`, notas del tablero, tabla de decisiones.
4. **F4** · verificar completo, build, db.check, guardia, dev a 400 px y
   oscuro con Mánager y Contador, `/code-review` alto y
   `/security-review` (toca privilegios de la base).
5. **F5** · PARADA 1 con la 0041; tras CONTINUAR-DESPLIEGUE, push a main
   y despliegue desde `../rayit-deploy`.

---

## 1. Lo hecho

| Fase | Commit | Qué |
|---|---|---|
| F0 | `8ea4e2d` | Esta sección 0. |
| F1 | `84ea9a0` | **Migración `0041_campaign_result_escritura_web.sql`**; `PRIVILEGIOS_DE_LA_APP` en `esquema.ts`; la ficha no pinta «Recalcular» ni «Generar»/«Enviado» a un rol sin el permiso (y lo dice con una frase). |
| F2 | `097e88b` | La prueba del ciclo (`apps/web/app/(app)/campanas/ciclo-db.test.ts`), la ficha real contra el seed (`ficha-db.test.tsx`), CON-6 → CAM-5 con y sin línea base, y la ruta de la factura en un solo sitio (`_lib/rutas.ts`). |
| F3 | `6400a17` | `TODO(ACC-2)` viejos, README de la web, notas del tablero, una línea de estado en CAM-4.md y CAM-5.md, y la tabla de decisiones (§3). |

### 1.1 La migración 0041

- **Qué hace.** `GRANT INSERT, UPDATE ON campaign_result TO mc_app` y
  `REVOKE DELETE`; dos políticas **restrictivas** (`campaign_result_web_insert`,
  `campaign_result_web_update`, solo `TO mc_app`) que exigen que la
  campaña de la fila exista, se vea y sea del mismo `workspace_id`; el
  disparador `assert_reference_visible` en `campaign_id` y `workspace_id`
  (la guardia lo exige en cuanto `mc_app` escribe).
- **Por qué las restrictivas, si 0010 ya aísla por `workspace_id`.** La
  política de 0010 obliga a que `workspace_id` sea el de la transacción,
  pero no que la campaña sea de ese workspace; hoy eso lo cubre la RLS de
  `campaign` (aislamiento puro) vía el disparador. Si ACC-6 o las cuentas
  de agencia abren la visibilidad de `campaign`, una campaña visible de
  otro workspace podría recibir una fila con `workspace_id` propio. La
  prueba «las restrictivas atan la fila…» simula esa apertura y, **sin**
  las restrictivas, falla (lo comprobé quitándolas: 52/53).
- **Compatible con producción (`7737b62`).** Ese código ya pregunta
  `has_table_privilege('campaign_result', 'INSERT' | 'UPDATE')`
  (`canRecomputeResult`) y la acción ya abre con
  `requirePermission('campanas.resultado.calcular')` y hace el mismo
  UPSERT. Aplicada antes del deploy, la ficha vieja enseña «Recalcular»
  y escribe una fila válida. Nada de lo que ya corre cambia de forma.
- **Re-ejecutable.** Prueba «la migración es re-ejecutable»: se aplica
  otra vez sobre la base ya migrada y los privilegios, las políticas y
  los disparadores quedan idénticos.
- **Sin permiso nuevo**: `campanas.resultado.calcular` ya está en la
  semilla de 0034 (Dueño y Mánager de creador; Dueño, Admin y Mánager de
  agencia).

### 1.2 «Recalcular» y el reporte, por rol

`page.tsx` pregunta `puede()` por `campanas.resultado.calcular`,
`campanas.reporte.generar` y `campanas.reporte.enviar` (la sesión está en
`cache()`: una consulta). Sin el permiso no hay botón y una frase lo dice
(`MESSAGES.resultado.noRole`, `MESSAGES.reporte.sinPermisoGenerar` /
`sinPermisoEnviar`). Las acciones siguen rechazando con
`requirePermission`: esconder el botón es producto, no seguridad.

---

## 2. Costuras (cada contrato con su prueba)

| Contrato | Prueba que falla si se rompe |
|---|---|
| **COT-4 → CAM-2**: aceptar crea UNA campaña (idempotente) con los entregables de la cotización | `ciclo-db.test.ts` paso 1: `aceptarCotizacion` (COT-2026-008, sin ventana) deja la cotización aceptada y ninguna campaña; `crearCampanaConVentana` dos veces deja **una** campaña, con `deliverablesSource = 'quote'` y los dos ítems de `quote_item`. Además, las de Rasheed en `packages/db/test/cotizar.test.ts` (panel y enlace) y las nueve de CAM-2 en `campanas.test.ts`. |
| **CAM-1 → FIN-1**: «Facturar» abre la factura con la campaña, en la ruta nueva | `ciclo-db.test.ts` paso 6: `facturarCampana` deja UNA factura en borrador con `campaign_id` y redirige a `facturaHref(id)`, la misma función con la que la ficha enlaza sus facturas (`_lib/rutas.ts`, un solo sitio). FIN-3 no está en main, pero `/finanzas/facturas/[id]` ya lo está: se usa la ruta nueva. |
| **CON-5/CON-10 → CAM-1**: los posts asociados salen de `post` y `post_metric_snapshot`; sin posts, la frase | `ficha-db.test.tsx`: la ficha real de Café Alma pinta los dos posts con su última lectura (417.673 y 303.685 views «hasta el 22 sep»); la de Hogar Lindo dice «Sin posts asociados». En @mc/db, «se asocian dos posts…» de CAM-1. |
| **CON-6 → CAM-5**: `views_vs_median` usa la línea base; si falta, `baseline` y la ficha lo dice | `campanas.test.ts` «CON-6 → CAM-5»: con la línea base del seed, 4,496; con la de TikTok marcada no fiable, `null` y `['baseline', 'brand_csv_sales']` (el resto de cifras intacto). `resultado.test.tsx` «CON-6 → CAM-5»: con ella, «× tu mediana»; sin ella, ninguna razón inventada y la frase de «Falta». CON-6 no está en main: la costura es la tabla `creator_baseline`, no su código. |
| **CAM-3 + CAM-4 + CAM-5 → CAM-6**: el payload congela el resultado; regenerar crea versión nueva y la vieja sigue abriendo | `ciclo-db.test.ts` pasos 7–9: el `result` del documento público es el de `campaign_result`; una lectura nueva de la marca, un canje nuevo y otro «Recalcular» (CPA pasa a 25.783,33) no lo cambian; regenerar da otro id y otro slug, y al enviarla la vieja queda con `superseded_by` y sigue abriendo con las cifras de antes. Además la prueba byte a byte de `campanas-reporte.test.ts`. |
| **CAM-6 → público**: sin sesión, 404 en borrador o slug desconocido, `viewed_at` en la primera apertura | `ciclo-db.test.ts` paso 7, con la página real `/reporte/[slug]`: borrador y slug inventado → `notFound()`; enviado → abre; `viewed_at` se fija en la primera apertura y la segunda solo suma `view_count`. |
| **La prueba del ciclo** | `apps/web/app/(app)/campanas/ciclo-db.test.ts`: una sola prueba, Server Actions reales contra pglite con migraciones y seeds, cifras derivadas a mano (views 154 000, alcance 104 720, no seguidores 0,54991, vs mediana 0,824, ganados 1 600 a 10 y 200 al día, canjes 150, ingresos 2 000 000,00, CPM 50.227,27, costo por seguidor 4.834,38, CPA 51.566,67, `missing_inputs` vacío). Cambiar una sola cifra la pone en rojo (lo comprobé con el CPM). |

---

## 3. Decisiones pendientes de Nicolás (todas las del módulo)

Ninguna se cambió: en el código queda la opción conservadora. «Si dices
lo contrario» da el archivo y el tamaño del cambio.

| # | Dónde | La pregunta | En el código hoy | Recomiendo | Si dices lo contrario |
|---|---|---|---|---|---|
| 1 | `docs/propuestas/CAM-1.md:102` | ¿Una campaña cerrada o cancelada admite asociar, quitar, marcar principal o editar? | No (`canEditCampaign`). | Mantener: el reporte se congela al cerrar y el resultado de una cerrada no se recalcula. | Quitar la comprobación en `packages/core/src/campanas.ts` (`canEditCampaign`) y sus pruebas; ~10 líneas, sin migración. |
| 2 | `docs/propuestas/CAM-3.md:150` | ¿«Actualizar ahora» con migración (0035) o sin ella y solo lo del job? | Con 0035, ya aplicada. | Mantener: es lo único que da seguidores de la marca en producción mientras no corra el worker. | Quitar la acción y el botón (~40 líneas en `actions.ts` y `seguidores.tsx`); 0035 queda (es inmutable). |
| 3 | `docs/propuestas/CAM-3.md:192` y `:236` | ¿Editar `brand_accounts` desde la ficha? ¿En CAM-4 o historia propia? | No se edita; la ficha dice qué handle falta o no se encontró. | Historia propia, S: campo «Cuentas de la marca» en el formulario de datos de CAM-1. **Fuera de alcance** de este cierre. | `editar-form.tsx`, `editarCampana` y `updateCampaign` (+ `brandAccountsOf`) y pruebas; ~150 líneas, sin migración. |
| 4 | `docs/propuestas/CAM-4.md:77` y `:137` (1) | Un día del CSV ya cargado con otra cifra: ¿se corrige o se rechaza? | Se corrige (UPDATE) y el resumen lo cuenta como «corregido». | Mantener: es la regla del formulario (lo último que reporta la marca manda) y sin ella un error de la marca no tiene arreglo. | Rechazo `dia_ya_cargado` en `BrandCsvRejectReason` (core), en `importBrandCsv` y en `messages.ts`; ~40 líneas con pruebas. |
| 5 | `docs/propuestas/CAM-4.md:137` (2) | ¿El formulario acepta fechas futuras? | No (hoy en la zona del workspace). | Mantener. | Quitar la comprobación en `registrarAporte`; 2 líneas. |
| 6 | `docs/propuestas/CAM-5.md:71` y `:146` | «Recalcular»: ¿GRANT a `mc_app` o solo el job? | **Resuelta por este prompt**: migración 0041. | — | Revertir: una migración 0042 con `REVOKE INSERT, UPDATE` y la línea de `esquema.ts`; el botón se apaga solo. |
| 7 | `docs/propuestas/CAM-5.md:83` (y `:170`) | EMV (valor de medios equivalente): ¿qué fórmula? | Siempre `null`; la ficha no lo enseña. | Mantener `null` hasta acordar la fórmula: un EMV sin fuente infla el reporte que ve la marca. **Fuera de alcance.** | Fórmula en `calcularResultado` (core), el `NULL` literal de `upsertResult` pasa a parámetro, el payload del reporte y la ficha; ~60 líneas con pruebas, sin migración (la columna existe). |
| 8 | `docs/propuestas/CAM-6.md:93` y `:246` | Regenerar un reporte enviado: ¿el enlace viejo sigue abriendo o caduca? | Sigue abriendo con «hay una versión más reciente» y sus cifras. | Mantener: un enlace enviado nunca se rompe. | Migración nueva con `CREATE OR REPLACE` de `public_report_impl` para devolver `expired` si `superseded_by` no es null (0037 es inmutable), y el estado en la página; ~30 líneas con pruebas. |
| 9 | `app/(app)/campanas/loading.tsx` (Rasheed, pulido r4) | ¿Visto bueno al esqueleto genérico en Campañas? | Reexporta `EsqueletoGenerico`; cubre lista y ficha. | **Visto bueno**: conserva la señal de carga y no hay un esqueleto propio que valga más. | Un esqueleto propio de la ficha; ~30 líneas. |
| 10 | `app/(app)/campanas/page.tsx:69` (COT-4, Rasheed; backlog §10.6) | ¿«Total con impuesto» como columna de monto en `/campanas`? | Así está: `campaign.amount = quote.total`. | **Visto bueno**: es lo que se factura y cobra, y coincide con la ficha («Monto acordado (con impuesto)»). | Otra etiqueta o el neto: 1 línea de texto, o una columna nueva en la consulta. |

---

## 4. Lo que necesita Rasheed

| # | Qué | Por qué |
|---|---|---|
| 1 | **Revisar `db/migrations/0041_campaign_result_escritura_web.sql`** (carpeta suya; excepción con precedente: pasa `make db.check` y la guardia, re-ejecutable, con cabecera). | Es el GRANT que CAM-5 §2 le proponía. |
| 2 | **`packages/db/src/esquema.ts`**: la fila de `campaign_result` en `PRIVILEGIOS_DE_LA_APP` pasa a `SELECT, INSERT, UPDATE` con su motivo. Va en esta rama porque sin ella la guardia fallaría con la 0041. | La guardia exige declarar lo que `mc_app` tiene. |
| 3 | Nada más: sin variables, sin permisos nuevos, sin cambios en `lib/auth/` ni `lib/workspace/`. | — |

---

## 5. Fuera de alcance, y adónde va

| Qué | Por qué | Historia destino |
|---|---|---|
| La lectura diaria de seguidores (`brand.snapshot`) y el cálculo de cada mañana (`campaign.compute`) en producción | Necesitan el worker desplegado; la ficha dice «Se recalcula cada mañana» y hay botones a mano. | WRK |
| EMV | Decisión #7. | Decisión de Nicolás |
| Editar `brand_accounts` desde la ficha | Decisión #3. | Historia propia (CAM, S) |
| Esconder por rol los demás botones de la ficha (asociar, editar datos y seguimiento, registrar aporte, transiciones) | Hoy los ve todo el que entra al módulo; la acción los rechaza con `requirePermission` y el error cae en la frontera. Aquí solo se hizo con «Recalcular» y el reporte porque el prompt lo pedía. | ACC (marco de permisos, ACC-5/ACC-7) |
| Mover a `messages.ts` los textos que `page.tsx` de la ficha aún escribe en línea (títulos de sección, vacíos de posts) | Deuda de CAM-1 anterior a la regla; no cambia comportamiento. | Pulido de CAM |
| F4 | `bf62a8b` | Los hallazgos de `/code-review` (§7). |

---

## 6. Verificación

### 6.1 Automática (sobre `bf62a8b`, con `origin/main` = `098b25a` sin cambios)

| Qué | Resultado |
|---|---|
| `pnpm verificar` (typecheck + lint + test, sin caché) | **15/15 tareas.** core 242/242 · connectors 202/202 · db 769/769 · worker 88/88 · web 970 + 1 todo (115 archivos) · raíz 8/8. Cero canceladas. |
| `next build` (con `.next` borrado) | Verde. `/campanas`, `/campanas/[id]`, `/campanas/[id]/reporte/[reportId]` y `/reporte/[slug]` dinámicas. |
| `make db.check` | Verde: 39 migraciones en Postgres embebido, la 0041 incluida. |
| Guardia en pglite (`esquema.test.ts`) | Verde con la 0041 (privilegios declarados, disparadores de referencia, restrictivas). |
| Guardia contra Supabase (solo lectura, con el código de la rama) | Lo único que dice es «faltan 1 migración(es) por aplicar (la base va por 0039): 0041». **Ojo:** la del clon principal (`29460e3`, no puede hacer pull) da avisos de 0034–0039 que son del código viejo, no de la base; la de después del deploy se corre con el código de `origin/main`. |
| Supabase, solo lectura | `has_table_privilege('mc_app','campaign_result', INSERT/UPDATE/DELETE)` = `false/false/false`; última migración `0039_demografia_de_cuenta.sql`. |

### 6.2 En dev (Postgres embebido, puerto 3417, seed temporal sin commitear con un Mánager y una Contadora, borrado al terminar)

| Persona | Qué | Visto |
|---|---|---|
| Mánager | `/campanas` | 200 |
| Mánager | Ficha de Café Alma | «Recalcular» y «Generar reporte» sí; FV-2026-010 como texto, **sin** «Ver factura» ni enlaces a `/finanzas`. |
| Mánager | «Recalcular» (Server Action por HTTP) | 303 a la ficha; CPM de COP 11.800 (mock) a **COP 4.353,93**, CPA 9.748,43 y «4,5× tu mediana». |
| Mánager | «Generar reporte» → `/reporte/<slug>` | 303; el enlace del borrador da **404**. |
| Mánager | «Enviado por enlace» → `/reporte/<slug>` sin sesión | 303; el público da **200** con «CPM COP 4.353,93»; la ficha dice «Abierto por la marca el 23 de septiembre de 2026 a las 5:49 p. m. · 1 apertura». |
| Cualquiera | `/reporte/<slug inventado>` | 404 |
| Contadora | `/campanas` y `/campanas/<id>` | **404** y **404**; `/finanzas` 200. |
| Dueña | La ficha a 400 px, en claro y en oscuro | «Resultado» con «Recalcular», «Falta» con enlace, «Lo que aportó la marca» y «Reporte a la marca» legibles y sin desbordes en los dos temas. |

---

## 7. Revisión

### 7.1 `/code-review` en nivel alto: 10 hallazgos, 8 corregidos, 2 justificados

| # | Hallazgo | Qué se hizo |
|---|---|---|
| 1 | Todo 42501 se leía como «falta el GRANT», también una violación de RLS. | **Corregido**: `isGrantMissing` (`_lib/errores-db.ts`, con prueba) exige «permission denied» y no «row-level security». |
| 2 | La cabecera de 0041 decía «sin romper nada», pero el código de producción enseña el botón por la base, no por el rol. | **Corregido** en la cabecera: el hueco está descrito (un rol sin permiso ve el botón y la frontera de error lo rechaza sin escribir). |
| 3 | «Facturar» y «Ver factura» se veían sin los permisos de Finanzas (el Mánager caía en un 404 o en la frontera). | **Corregido**: `finanzas.factura.crear` y `finanzas.factura.ver`, con frase; prueba de la ficha real con el Mánager. |
| 4 | `facturaHref` vive en Campañas y no en Finanzas. | **Justificado**: el cierre de FIN corre en paralelo sobre `finanzas/`; la prueba del ciclo ata las dos (Finanzas tiene que redirigir a `invoiceHref`). Moverla es cambiar una importación. |
| 5 | JSDoc de `canRecomputeResult` viejo. | **Corregido**. |
| 6 | Los disparadores también corren para el worker. | **Justificado**: dos búsquedas por clave primaria por campaña y día; la guardia los exige. Anotado en la cabecera. |
| 7 | `puede()` corría después de la carga. | **Corregido**: en paralelo (`Promise.all`). |
| 8 | Identificadores en español (`puedeGenerar`…). | **Corregido**: `canGenerate`, `canSend`, `invoiceHref`. |
| 9 | Condición de «Enviado» duplicada. | **Corregido**. |
| 10 | La prueba del Editor dependía del orden. | **Corregido**: compara antes y después. |

### 7.2 `/security-review`

Sin hallazgos de confianza alta. Lo que se revisó: la 0041 (la permisiva de
0010 hace de WITH CHECK para el workspace y las restrictivas solo
estrechan; no hay camino para escribir en otro workspace ni colgar una
fila de la campaña de otro), `recalcularResultado` (`requirePermission`
en la primera línea, valores calculados en el servidor, SQL con
parámetros) y la ficha (esconder botones es producto, no control).
Descartados con confianza 1–2: escritura directa como `mc_app` fuera de
la app (no hay tal camino), carrera entre leer el estado y el UPSERT
(integridad dentro del mismo workspace) y una RLS de `campaign` más
abierta en el futuro (las restrictivas la cubren).

---

## 8. Salida a producción

### 8.1 PARADA 1: la migración 0041

- **Número y archivo:** `platform/db/migrations/0041_campaign_result_escritura_web.sql`.
- **Qué hace:** §1.1.
- **Por qué convive con el código de hoy (`7737b62`):** ese código ya
  decide el botón con `has_table_privilege` y ya hace el mismo UPSERT tras
  `requirePermission`. Única diferencia en el hueco: un rol sin permiso ve
  «Recalcular» y, si lo pulsa, la frontera de error lo rechaza sin escribir.
- **Comando (lo corre Nicolás):**
  `cd /Users/nicolasduarte/Documents/influ/rayit/platform && make db.migrate`

### 8.2 Después de CONTINUAR-DESPLIEGUE

(Se completa al desplegar: commit desplegado, URL anterior como plan B,
rutas, guardia y la lectura de `has_table_privilege`.)

### 8.3 Guion de humo para Nicolás, en producción con tu sesión

Marcado **[escribe]** lo que toca la base real.

1. `/campanas`: las cuatro campañas del seed. La Contadora, si la tienes,
   recibe 404.
2. Abre **Café Alma · Lanzamiento cold brew**. En «Resultado» tiene que
   aparecer el botón **Recalcular** (antes decía «Se recalcula cada mañana»).
3. **[escribe]** Pulsa **Recalcular**. El CPM pasa de COP 11.800 (mock) a
   **COP 4.353,93**, el CPA a **COP 9.748,43** y aparece «4,5× tu mediana».
   «Falta» sigue diciendo «el CSV de ventas diarias de la marca». Si ves
   «Desde la ficha todavía no se puede recalcular…», la 0041 no está
   aplicada.
4. **[escribe]** Pulsa **Recalcular** otra vez: las mismas cifras (una sola fila).
5. **[escribe]** En «Reporte a la marca», **Generar reporte** (o «Generar de
   nuevo»): nace en borrador. Copia el enlace y ábrelo en una ventana
   privada: **404**.
6. **[escribe]** **Enviado por enlace**, y abre el enlace en la ventana
   privada: el reporte con el CPM de COP 4.353,93. La ficha dice «Abierto
   por la marca el … · 1 apertura».
7. `/reporte/esto-no-existe` en la ventana privada: 404.
8. En la ficha de una campaña sin factura (si hay), **Facturar** abre la
   factura en borrador en `/finanzas/facturas/<id>`. **[escribe]** (no lo
   hagas si no quieres una factura de prueba).
