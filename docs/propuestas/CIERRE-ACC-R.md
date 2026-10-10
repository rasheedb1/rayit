# Cierre de la parte de Rasheed en Accesos (R2-ACC) · 10-oct-2026

Escrito para: Rasheed y Nicolás. Lo que R2-ACC cerró de CIERRE-ACC §5 y
de los hallazgos abiertos de ACC-7, lo que dejó pendiente y por qué, y
las decisiones que tomó.

## 0. Foto al empezar

`origin/main` en `b8c98394` (fase 9 de Rasheed en main y producción;
Supabase 0001–0084, seeds 0001–0013). Las 77 Server Actions de Ventas
(13 archivos), Cotizar y Resumen abrían con una puerta por ROL
(`puedeOperarVentas` = owner, admin, manager, editor) y ninguna con el
catálogo de ACC-1; las 24 páginas de los tres módulos no llevaban
`requireModuleAccess` (solo sus layouts); `pendientes-fase-9.json` tenía
11 hallazgos de ACC-7 (nota 9,3).

## 1. Qué quedó hecho

| CIERRE-ACC §5 | Estado | Dónde |
|---|---|---|
| 1 · `requirePermission` en las Server Actions | **Hecho**: 77 acciones en 15 `actions.ts` (Ventas 13 archivos, Cotizar, Resumen/importar), con el permiso de ACC-1.md §4; `ventas`, `cotizar` y `resumen` en `MODULOS_CON_CONVENCION` (`ACCIONES_MINIMAS` 12 → 90) | `lib/permisos/convencion.test.ts` (10 casos, 90+ acciones) |
| 2 · Puerta en cada página | **Hecho**: 24 `page.tsx`; los tres módulos en `MODULOS_CON_PUERTA_EN_PAGINA` | `lib/permisos/paginas.test.ts` (47 casos) |
| 3 · Visto bueno a los `layout.tsx` de ACC-5 | Ya estaban en main; sin cambios | — |
| 4 · Alcance en sus consultas (`alcance-<modulo>.test.ts`) | **Pendiente** (ver §3) | — |
| 5 · Contadora de demo | **Hecho**: seed 0014 (Carolina Ruiz, `finance`) con `verify/0014.sql` | `DEMO_USER_ID=00000002-0000-4000-8000-000000000005` |
| 7 · `ScopeError` en `codigoDe` | Ya estaba (ACC-7 r5: `scopeErrorOf`) | `cotizar/actions.ts` |
| 8 · Política por creador | Hecha en 0082 (fase 9) | — |

**Los permisos nuevos (0085 §1).** El outreach no tenía permiso en el
catálogo. `ventas.outreach.enviar` (aprobar, deshacer, regenerar y saltar
mensajes; responder, clasificar y marcar en la bandeja; reintentar y
cancelar en Actividad) lo tienen Dueño, Administrador y Mánager/Ejecutivo.
`ventas.outreach.configurar` (encender y apagar el envío, política,
límites y desconexión de canales, brief) es 'sensible' y solo del Dueño
y del Administrador: es lo que ya decían `PUEDEN_CAMBIAR_LA_POLITICA`,
`PUEDEN_GESTIONAR_CANALES` y `PUEDEN_EDITAR_BRIEF`. El resto del CRM usa
los de 0034 (`ventas.senal.*`, `ventas.empresa.*`, `ventas.negocio.*`);
cadencias, perfil comercial y pitch, `ventas.negocio.editar`.

**Hallazgos de ACC-7 (pendientes-fase-9.json).**

| # | Hallazgo | Estado |
|---|---|---|
| 1 | `createQuote` acepta cualquier creador sobre un negocio con creador | **Hecho**: `CreadorDistintoDelNegocio` si el negocio tiene otro creador; `ScopeError` si el creador que firma no está en el alcance de quien cotiza. Dos pruebas en `alcance-rls.test.ts` («Cotizar con la red puesta») |
| 2 | Responsable que no ve al creador (`member_sees_creator`) | **Pendiente** (§3) |
| 3, 6 | La ficha se contradice con negocios ocultos | **Hecho**: con negocios ocultos y ninguno visible, un solo estado vacío (`hiddenDealsOnly`); Datos dice «Negocios abiertos (tuyos)» |
| 4 | `tieneRol` devuelve true a cualquiera sin Auth | **Hecho**: con `DEMO_USER_ID` resuelve el rol real de esa persona (`getSessionMember` con su identidad, como `permisosDeDemo`) |
| 5 | Nombre accesible del botón (WCAG 2.5.3) | **Hecho**: `Cambiar creador de «…»` / `Asignar creador a «…»`, con prueba |
| 7 | `DealCreatorRequired` manda a donde ya está | **Hecho**: texto propio del formulario (`newDeal.creatorRequired`) |
| 8 | Señal pendiente de Hostal Brisa en el seed 0013 | **Pendiente** (§3) |
| 9 | `scope_allows` sin `search_path` | **Hecho** en 0085 §2 (`SQL_CUERPOS` con `proconfig` queda para la guardia, §3) |
| 10 | `DEMO_USER_ID` en `.env.example` | **Hecho**, con el ejemplo de Diego |
| 11 | `NO_CREATORS` dos veces | **Hecho** |

## 2. Decisiones

| Pregunta | Lo que quedó | Si se quiere lo contrario |
|---|---|---|
| ¿El Editor sigue operando Ventas? Por rol (`OPERAN`) sí; por la matriz de ACC-1, no (ni ve el módulo: ACC-5 ya le daba 404 en `/ventas`) | **La matriz manda**: el Editor no opera Ventas ni Cotizar. La prueba de Actividad lo dice | Dar al Editor `ventas.*` en `ROLES_SISTEMA` y una migración que lo siembre |
| ¿Se quitan las puertas por rol (`puedeOperarVentas…`) ahora que el catálogo decide? | **Se quedan detrás del catálogo**: pintan o no el botón y dan el mensaje en pantalla; la puerta es `requirePermission`, primera línea. Un rol a medida (ACC-9) con el permiso y sin el rol de fábrica vería el mensaje del rol: cuando ACC-9 exista, esos helpers pasan a `puede(<permiso>)` | Cambiarlos por `puede()` en `_lib/permiso.ts` de cada módulo y adaptar las 18 pruebas que simulan el rol |
| ¿`ventas.outreach.configurar` para el Mánager? | **No**: política, canales y brief comprometen la reputación del remitente; hoy eran de owner/admin | Quitar el `.filter` de la matriz en `permisos.ts` y sembrar la fila para `manager` |
| ¿`createQuote` fija el creador en el negocio al enviar (`setDealCreator`) cuando el negocio no tenía? | **No todavía**: la cotización ya no puede ser de otro creador que el del negocio, y un negocio sin creador sigue aceptando al creador del alcance; coser `setDealCreator` al enviar es la vuelta siguiente | `sendQuote` → `setDealCreator(tx, dealId, quote.creatorId)` cuando `deal.creator_id IS NULL` |

## 3. Lo que queda (para la vuelta siguiente de Rasheed)

1. **§5.4, alcance en las consultas** (L): `test/alcance-ventas.test.ts`,
   `alcance-cotizar.test.ts` y `alcance-resumen.test.ts` con el arnés
   de `test/alcance.ts` (`sembrarExtra`), un caso por función exportada
   (`queries/ventas.ts` 26, `queries/cotizar/*` 48, `queries/resumen.ts`
   12) y sus archivos en `ARCHIVOS` de `alcance-convencion.test.ts`. Hoy
   el alcance de esas consultas lo pone `scopeFilter()` donde el módulo
   lo compone y la política restrictiva de 0082 en `deal`, `campaign`,
   `post` y `social_connection`.
2. **ACC-10** (M): la política RESTRICTIVE por creador en
   `post_metric_snapshot`, `account_metric_snapshot` (por EXISTS),
   `quote` (`creator_id`), `invoice` y `payment` (por EXISTS sobre
   `campaign`) y `data_consent`; entrada en `TABLAS_CON_ALCANCE_POR_CREADOR`
   y fuera de `TABLAS_CON_CREADOR_SIN_POLITICA`; la prueba de ACC-7 que
   fija lo que no cubre se da la vuelta. Cuidado con los `ON CONFLICT DO
   UPDATE` del worker (mc_worker queda fuera).
3. **Hallazgo 2**: `member_sees_creator(user_id, creator_id)` SECURITY
   DEFINER en la migración siguiente; usarla en `assertMember`
   (`InvalidOwner` «Esa persona no lleva a este creador») y para filtrar
   `listOwnerOptions` por negocio; en `setDealCreator`, avisar en la
   ficha cuando el responsable deja de ver el negocio.
4. **Hallazgo 8**: una señal pendiente de Hostal Brisa en el seed 0013
   (con un negocio abierto de Mariana) y su fila en «Cómo verlo» de
   ACC-7.md.
5. **Hallazgo 9, la mitad de la guardia**: `SQL_CUERPOS` comparando
   también `proconfig` y `prosecdef` de las funciones de la red.

## 4. Verificación

Ver la entrega y `docs/backlog-mvp.md` §13: `pnpm verificar` completo
sobre la rama, `make db.check` (0001–0085) y `verify/0014.sql`.
