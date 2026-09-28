# CAM-6 · Reporte a la marca — página pública con el payload congelado

Escrito para: Rasheed, que revisa y aplica la migración `0037` y la
línea nueva de `lib/auth/rutas.ts`, y quien revise el PR de CAM-6.
Fecha: 23 de septiembre de 2026. Rama `nicolas/CAM-6-reporte-marca`,
integrada con `origin/main` el mismo día (ACC-1/2/3, CAM-3/4/5, FIN-2/4).

> **Nota de integración.** El plan de abajo se escribió sobre `29460e3`,
> cuando ACC-1 y ACC-2 no estaban en `main`: por eso habla de `0034`,
> de `TODO(ACC-1)` y de escribir `audit_log` a mano. Al integrar, la
> migración pasó a **`0037`** (0034 es ACC-3; 0035 CAM-3 y ACC-6; 0036
> FIN-7 y CON-7), las acciones abren con `requirePermission` real y la
> bitácora va por `audit()` con `campaign.report_sent`. §1 cuenta el
> estado final.

---

## 0. Plan (escrito antes de tocar código)

### 0.1 Qué existe ya y qué no

- `report` (0008) ya tiene todo lo que la historia pide: `payload`
  jsonb, `white_label`, `status` draft/sent/viewed, `sent_via`
  email/whatsapp/link/pdf, `sent_at`, `viewed_at`, `view_count`, `slug`
  UNIQUE (declarado en `UNICOS_GLOBALES_DECLARADOS`) y RLS por
  `workspace_id` desde 0010. No está curada en el esquema Drizzle (los
  reportes quedaron fuera del MVP a propósito, `schema/index.ts`); las
  consultas van en SQL crudo por `tx.query`, como el resto de
  `queries/campanas.ts`.
- Las tres fuentes que el payload congela **existen en la base y en el
  seed** aunque CAM-3, CAM-4 y CAM-5 no estén en `main`:
  `brand_account_snapshot` (60 días de @cafealma), `campaign_brand_input`
  (canjes e ingresos de Café Alma) y `campaign_result` (los KPIs del
  mock). CAM-6 las lee tal como están; cuando CAM-3/4/5 las llenen de
  verdad, el reporte sale igual. Sin filas, el payload lo dice con
  `null`/lista vacía y la página lo explica con una frase.
- Los cortes a 7 y 30 días salen de `post_metrics_at_cut` (0010, cortes
  24/72/168/720), como dejó apuntado CAM-1 §7.
- El patrón de enlace público es el de 0030: función `SECURITY DEFINER`
  de `mc_public_share`, política `TO mc_public_share` acotada al slug
  que fija la propia función, `withPublicShare` en la web, página en
  `(public)` con `noindex`, sin `loading.tsx`, 404 real.
- ACC-1 (`requirePermission`) y ACC-2 (`audit()`) **no están en `main`**
  (se construyen en paralelo en `rayit-acc1` y `rayit-acc2`). Las
  acciones nacen con `// TODO(ACC-1): campanas.reporte.generar` /
  `.enviar` como primera línea, y la bitácora se escribe directamente en
  `audit_log` (mc_app tiene SELECT + INSERT desde 0025) con
  `// TODO(ACC-2)` para pasarla por `audit()` cuando exista. Así «enviar
  deja bitácora» se cumple hoy y ACC-2 solo cambia el camino.

### 0.2 Archivos

| Qué | Dónde | Nuevo |
|---|---|---|
| `ReportPayload` v1, `construirReporte(entradas)`, reglas puras (cortes, ventana de la curva, `trackingUrl` sin query, `hayVersionMasReciente`) | `packages/core/src/reporte.ts` + `test/reporte.test.ts` | sí (exportado desde `index.ts`) |
| `generateReport`, `listCampaignReports`, `getReport`, `markReportSent`, errores | `packages/db/src/queries/campanas/reporte.ts` (reexportado por `queries/campanas.ts`, como hace `cotizar.ts` con su carpeta) | sí |
| `readPublicReport` (PublicShareTx) | `packages/db/src/queries/campanas/reporte-publico.ts` | sí |
| Pruebas en pglite | `packages/db/test/campanas-reporte.test.ts` | sí |
| Migración: `report.superseded_by`, índice, GRANT/políticas de `mc_public_share`, `public_report()` | `platform/db/migrations/0034_reporte_publico.sql` | sí |
| Declaraciones de la guardia (función definer, privilegios y políticas del enlace) | `packages/db/src/esquema.ts` | edita 3 constantes |
| Ruta pública `/reporte` | `apps/web/lib/auth/rutas.ts` (Rasheed: una línea con su motivo, ver §6) | edita |
| Sección «Reporte a la marca» de la ficha, acciones, botón de imprimir | `apps/web/app/(app)/campanas/[id]/page.tsx`, `reporte-seccion.tsx`, `actions.ts`, `imprimir.tsx` | edita / sí |
| Vista previa del creador (misma pieza que la pública) | `apps/web/app/(app)/campanas/[id]/reporte/[reportId]/page.tsx` | sí |
| El documento (solo props) | `apps/web/app/(app)/campanas/_ui/documento-reporte.tsx` | sí |
| Textos del módulo | `apps/web/app/(app)/campanas/_lib/messages.ts` | sí |
| Página pública | `apps/web/app/(public)/reporte/[slug]/page.tsx` + pruebas | sí |
| `@media print` | `apps/web/app/globals.css` | edita |
| Estado de la historia | `apps/web/content/backlog.ts` (solo CAM-6) | edita |
| Este documento | `docs/propuestas/CAM-6.md` | sí |

### 0.3 Decisiones

1. **El payload es un tipo de core con versión** (`ReportPayload`,
   `version: 1`) y lo arma una función pura, `construirReporte(entradas)`,
   probada con el seed de Café Alma. La consulta solo recoge las
   entradas (campaña, lo acordado, posts con sus cortes, resultado,
   curva, aportes, creador, workspace) y guarda lo que core devuelve.
   **Todo lo que la página pública pinta sale del payload**: la función
   de la base devuelve `payload || {slug, status, sentAt, viewedAt,
   superseded}` y nada más; la página no consulta ninguna tabla. Es lo
   mismo que hace `public_snapshot` de la cotización (0030).
   Descartado: leer en vivo y «congelar» solo las métricas (la
   cotización, el nombre de la marca o el handle del creador cambiarían
   un documento ya entregado).
2. **Regenerar.** Mientras el último reporte de la campaña está en
   `draft`, «Generar» lo reemplaza (mismo id, mismo slug, payload nuevo,
   `created_at` nuevo). Una vez enviado, «Generar» crea OTRA fila con
   slug nuevo; la anterior sigue abriendo y, cuando la nueva se
   **envía**, la anterior recibe `superseded_by` y su página dice «hay
   una versión más reciente». Nunca se rompe un enlace ya enviado.
   `superseded_by` se fija al enviar y no al generar porque un borrador
   no lo ve nadie: avisar «hay otra versión» de algo que la marca no
   puede abrir sería mentir. **DECISIÓN PENDIENTE DE NICOLÁS**: si
   prefiere que el enlace viejo deje de abrir (`expired`), es cambiar
   una condición en `public_report_impl`. La conservadora es no romper.
3. **La migración `0034_reporte_publico.sql`** (número: `git fetch` y
   el más alto en todas las ramas es 0033; 0023 no se recicla). Contiene:
   `report.superseded_by uuid REFERENCES report(id) ON DELETE SET NULL`
   con su CHECK «no a sí mismo» y su disparador `assert_reference_visible`
   (0025 §3); un índice `(campaign_id, created_at DESC)` para listar
   versiones; `GRANT SELECT ON report` y `GRANT UPDATE (status,
   viewed_at, view_count)` a `mc_public_share`; dos políticas `TO
   mc_public_share` con la misma cerradura que `quote_public_share`
   (`status <> 'draft' AND slug = nullif(current_setting('app.public_share',
   true), '')`); y `public_report_impl(text, boolean)` +
   `public_report(text, boolean)` (SECURITY DEFINER, fija y restaura
   `app.public_share`, valida el largo del slug). Re-ejecutable: `ADD
   COLUMN IF NOT EXISTS`, `DROP POLICY IF EXISTS`, `CREATE OR REPLACE
   FUNCTION`, `DO` con `pg_constraint`. `viewed_at` se marca la primera
   vez que se abre con `p_count` (la vista previa del creador y los
   robots de vista previa de los chats no cuentan, `_lib/robots.ts`).
   **Enumeración de slugs**: el slug son 26 signos de un alfabeto de 31
   (≈128 bits, `nuevoSlug` de `queries/cotizar/enlace.ts`, el mismo de
   la cotización): no se enumera, y un `not_found` no dice si el slug
   existe. El bloqueo por origen de 0030 no aplica (protege la
   contraseña de un kit, no el slug; el reporte no lleva contraseña).
   Delante va el freno en memoria de `_lib/limite.ts` (60 enlaces
   desconocidos por minuto y por IP → el mismo 404 sin tocar la base):
   es POR INSTANCIA y de mejor esfuerzo, como dice su cabecera; la
   barrera es la entropía del slug. Descartado: una tabla global de
   topes por IP resumida en la función (una tabla sin inquilino más en
   `EXCEPCIONES_SIN_AISLAMIENTO` para proteger algo que 128 bits ya
   protegen).
4. **PDF sin dependencia nueva.** La página pública y la vista previa
   llevan `@media print` (sin botones, sin sombras, saltos de página
   entre secciones) y un botón «Descargar PDF» que abre el diálogo de
   impresión (`window.print()`). `sent_via = 'pdf'` se registra cuando
   el creador marca «Enviado como PDF»; `'link'` cuando marca «Enviado
   por enlace». `email` y `whatsapp` siguen en el CHECK para la fase 2
   (CIM-10, no hay SMTP). Descartado: PDF en servidor (dependencia
   pesada, fuera de alcance).
5. **Marcar «enviado»** es una Server Action con permiso
   `campanas.reporte.enviar` (hoy `TODO(ACC-1)`) que, en UNA
   transacción: `status = 'sent'`, `sent_at`, `sent_via`;
   `superseded_by` en los reportes enviados anteriores de la campaña;
   `activity` `report_sent` en la empresa (`company_id`, `deal_id` de la
   campaña si lo tiene, `user_id = current_user_id()`, frase de
   `messages.ts` y `metadata.kind`, como hace Cotizar); `notification`
   `report_sent` (severity `success`, `entity_type 'report'`,
   `action_url` a la ficha); fila en `audit_log` (`action
   'report.sent'`, `before {status}`, `after {status, sentVia}`; sin
   payload, sin PII; `TODO(ACC-2)`); y la campaña pasa `measuring →
   reported` por `transitionCampaign` de core si estaba en `measuring`
   (en otro estado no se toca: un reporte de una campaña cerrada no la
   reabre). Idempotente: un reporte ya enviado responde
   `ReportAlreadySentError` y no escribe nada.
   **Generar** (`campanas.reporte.generar`, `TODO(ACC-1)`) solo en
   `live`, `measuring`, `reported` o `closed`: una campaña planeada no
   tiene nada que reportar y una cancelada no se reporta
   (`ReportNotAvailableError` con `messageEs`).
6. **Qué NO va en el payload**, con prueba (`dump-text` sobre
   `JSON.stringify(payload)` en core y sobre la fila real en db):
   correos y teléfonos (ni del creador ni de contactos de la marca),
   `notes` de `campaign_brand_input`, montos de otras campañas, ids de
   cuentas externas (`external_account_id`), handles de cuentas del
   creador (solo `creator_profile.handle`, que es el público del media
   kit), `tracking_url` con parámetros (`utm` fuera: se guarda origen +
   ruta), `brief`, `deal_id`, `quote_id`, ids internos de posts. Sí va:
   el `tracking_code` (la marca lo dio), el handle público de la marca
   (para etiquetar su curva), el monto de ESTA campaña (es lo acordado
   con esta marca) y `locale`/`timezone`/`currency` del workspace para
   formatear sin consultar nada.
7. **Enlace absoluto** con el origen de `lib/auth/origen.ts` (`APP_URL`
   en producción; cabeceras solo en dev y vistas previas), calculado en
   el servidor y pasado al `CopyButton` de la ficha. Descartado: armarlo
   en el navegador como `copiar-enlace.tsx` de Cotizar (el pulido pidió
   el origen de `origen.ts`, que en producción no se deduce del cliente).
8. **La vista previa del creador** es la misma pieza (`DocumentoReporte`,
   solo props) que la página pública, en
   `/campanas/[id]/reporte/[reportId]` con sesión y `withWorkspace`: el
   creador ve exactamente lo que la marca tiene delante, sin contar
   visitas ni marcar `viewed_at`. Un borrador solo se ve así.
9. **`lib/auth/rutas.ts`** (Rasheed) necesita `"/reporte"` en
   `RUTAS_PUBLICAS`; sin esa línea el middleware manda la marca a
   `/login`. Es exactamente lo que la cabecera del archivo describe
   («abrirla es agregar una línea aquí, con su motivo») y el precedente
   de `/cotizacion`; la incluyo en el PR y la marco en §6 para su
   revisión.
10. **Lo acordado se pinta con `lineasAcordado` y `nombreMetrica` de
    Cotizar** (las mismas líneas que la cotización y su página pública):
    la marca lee en el reporte las mismas palabras que aceptó. Es una
    importación de solo lectura de un módulo de Rasheed; no se cambia
    nada allí.

### 0.4 Dudas que no bloquean

- **Permisos.** `campanas.reporte.generar` y `campanas.reporte.enviar`
  quedan como `TODO(ACC-1)` en la primera línea de cada acción; la
  prueba «falla con un rol sin permiso» (R3) no se puede escribir hasta
  que ACC-1 esté en `main`. Está anotado en §7.
- **AGE-5** heredará `white_label` (hoy `{version, creator}`) y el
  enlace congelado; no hace falta nada más en la base.

---

## 1. Lo que quedó

| Pieza | Dónde |
|---|---|
| `ReportPayload` v1, `construirReporte` (lista blanca), `tituloParaLaMarca`, `urlHttp`, `trackingUrlSinParametros`, `reportForbiddenMatch`, errores con `messageEs` | `packages/core/src/reporte.ts` |
| Permiso `campanas.reporte.generar` (junto a `…enviar`, que ya estaba) | `packages/core/src/permisos.ts`; `scripts/permisos-sql.ts` acepta `sinPermisos` para comparar 0034 con el catálogo de entonces |
| `generateReport`, `listCampaignReports`, `getReport`, `markReportSent` | `packages/db/src/queries/campanas/reporte.ts` |
| `readPublicReport` (`PublicShareTx`) | `packages/db/src/queries/campanas/reporte-publico.ts` |
| Migración | `platform/db/migrations/0037_reporte_publico.sql` |
| Guardia | `esquema.ts`: `public_report` en `FUNCIONES_DEFINER_DECLARADAS`, `report` en `PRIVILEGIOS_DEL_ENLACE_PUBLICO`, dos políticas en `POLITICAS_DEL_ENLACE_PUBLICO` |
| Ficha | sección «Reporte a la marca» (`[id]/reporte-seccion.tsx`), acciones `generarReporte` y `marcarReporteEnviado`, vista previa `[id]/reporte/[reportId]/` |
| Documento (uno solo para la vista previa y la marca) | `campanas/_ui/documento-reporte.tsx`, `_ui/imprimir.tsx` |
| Página pública | `app/(public)/reporte/[slug]/page.tsx`, con el freno de fallos `campanas/_lib/freno.ts` |
| PDF | `@media print` en `globals.css` (paleta clara completa aunque el tema sea oscuro) |

## 2. La migración `0037_reporte_publico.sql` (para revisar y aplicar)

- **Qué hace.** `report.superseded_by` (con su CHECK y su
  `assert_reference_visible`), un índice por campaña, `SELECT` y
  `UPDATE (status, viewed_at, view_count)` sobre `report` para
  `mc_public_share`, las políticas `report_public_share` y
  `report_public_share_state` (misma cerradura que la cotización: no
  borradores, slug fijado por la función), y `public_report(text,
  boolean)` SECURITY DEFINER con sus dos auxiliares
  (`public_report_impl`, `public_report_iso`), todas de
  `mc_public_share` y sin `PUBLIC`; `EXECUTE` solo para `mc_app`. Y la
  fila del permiso `campanas.reporte.generar` con sus cinco
  `role_permission` de sistema (los mismos roles que `…enviar`).
- **Orden.** Después de 0034 (usa `permission`/`role`). No depende de
  0035 ni de 0036. `make db.check` la aplica sobre main con 35
  migraciones; re-ejecutable.
- **Requisito en Supabase.** Ninguno nuevo: el rol `mc_public_share`
  existe desde 0030 y `mc_migrator` es miembro.
- **Después:** `make db.migrate` y `make db.guardia` antes del deploy.
  Sin 0037 aplicada, `/reporte/<slug>` falla (no existe la función) y
  la guardia lo dice.

**Choques de numeración que vi al integrar (no son de CAM-6):** hay dos
`0035` (CAM-3 en main y ACC-6 en su rama) y dos `0036` (FIN-7 y CON-7,
ninguna en main). El runner se para con dos archivos del mismo número:
quien integre la segunda de cada par tiene que renumerarla.

## 3. La línea de `lib/auth/rutas.ts` (tuya)

`"/reporte"` en `RUTAS_PUBLICAS`, con su motivo, como `/cotizacion`.
Sin ella el middleware manda a la marca a `/login`. Va en este PR para
que la historia funcione; si prefieres hacerla tú, es esa línea.

## 4. Decisiones

- **Regenerar** (DECISIÓN PENDIENTE DE NICOLÁS, la conservadora): un
  enlace enviado nunca se rompe; al enviar otra versión, el viejo sigue
  abriendo con «Hay una versión más reciente…» y las mismas cifras.
- **Permiso de generar.** El catálogo de ACC-1 solo traía `enviar`; la
  historia pide los dos. Se añadió `campanas.reporte.generar` con su
  migración (0034 es inmutable) y la prueba de ACC-3 comprueba 0034
  contra el catálogo sin él y, aparte, que 0037 lo siembre con la matriz
  de core.
- **Generar no se audita; enviar sí.** Un borrador solo lo ve el creador
  y su enlace no abre: congelar no es publicar. Declarado en
  `audit-convencion.test.ts`, que ahora también recorre
  `campanas/reporte.ts`.
- **Enumeración de slugs.** Sin contraseña no hay bloqueo por origen que
  copiar de 0030; la barrera es la entropía del slug (≈128 bits). Delante
  hay un freno en memoria que solo cuenta slugs desconocidos (60 por
  minuto e IP → 404 sin tocar la base). No reutiliza `LimiteDeIntentos`
  de Cotizar porque ese cuenta cada intento, y la marca que recarga su
  enlace no debe frenarse; tampoco se tocó tu archivo.
- **Identificadores en español** en las Server Actions (`generarReporte`,
  `marcarReporteEnviado`) y en `construirReporte`, `FrenoDeFallos`: el
  precedente de CAM-1/FIN-1 y el nombre que pide la historia. Las
  consultas de `@mc/db` van en inglés.

## 5. Lo que AGE-5 hereda

El reporte congelado, su slug y `white_label` (`{version, creator}`).
El portal de marca pone delante un enlace firmado con vencimiento; la
función pública y el payload no cambian. Si AGE-5 quiere vencimiento,
es una columna `expires_at` y una condición en `public_report_impl`,
como el media kit.

## 6. Fuera de alcance

- Envío por correo o WhatsApp (fase 2, CIM-10): `email` y `whatsapp`
  siguen en el CHECK; la acción solo admite `link` y `pdf`.
- Reportes mensuales y programados (`report_schedule`, fase 2).
- Portal de marca (AGE-5). PDF generado en servidor.

## 7. Verificación

Ver el mensaje de cierre de la historia (pruebas, `pnpm verificar`,
`next build`, `make db.check` y la verificación en dev con salidas). La
prueba clave es `packages/db/test/campanas-reporte.test.ts` «LA CLAVE:
el reporte enviado no cambia aunque lleguen snapshots nuevos (byte a
byte)»; en dev, el enlace viejo tras generar y enviar otra versión solo
difiere en la línea del aviso.

## 8. Revisión

`/code-review` (alto): diez hallazgos. Corregidos ocho: la caption
entera como título (ahora primera línea sin correos ni teléfonos, y el
payload se revisa antes de guardar), enviar el borrador de una campaña
cancelada, enviar con un `campaignId` que no es el del reporte, marcar
visto un payload de versión desconocida, colores oscuros al imprimir,
la curva recortando los días recientes, `horas()` duplicando
`cutHoursLabel`, y la cita de 0034 §1 cambiada por error. Justificados
dos: el freno propio (arriba) y los identificadores en español (arriba).

`/security-review`: sin hallazgos (ninguno con confianza ≥ 8). Se aplicó
igual el endurecimiento sugerido: el enlace de un post solo pasa si es
http(s) (`urlHttp`).
