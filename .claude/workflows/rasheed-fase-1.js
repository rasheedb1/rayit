// =====================================================================
// rasheed-fase-1 · construye toda la parte de Rasheed del MVP con
// agentes en paralelo y una puerta de calidad: ningún agente termina
// hasta que dos revisores independientes le dan 9,5 o más, y al final
// el producto integrado pasa por el mismo umbral en bucle.
//
// Fase 1 · cimientos      db (CIM-1, CIM-2) · seed (CIM-6)
// Fase 2 · pantallas      auth (CIM-3) · resumen (RES-1, RES-2) · cotizar (COT-1..4)
// Fase 3 · CRM            crm (VEN-1..3) · ficha (VEN-4, VEN-5)
// Fase 4 · tubería        esquema (migración de outreach) → canales (VEN-9) · motor (VEN-10) · entregabilidad (VEN-15)
// Fase 5 · inteligencia   perfil (VEN-11) · generacion (VEN-12) · recomendador (VEN-13)
// Fase 6 · operación      bandejas (VEN-14) · metricas (VEN-16) · cierre (VEN-7, VEN-8)
// Fase 7 · revisión final revisión integrada en bucle hasta el umbral
//
// Después de cada fase, un integrador mergea a rasheed/integracion y
// corre el CI. Nunca hace push, nunca toca main, nunca despliega.
//
// Se lanza fase por fase:  args = { fases: [1] } … { fases: [7] }
// Argumentos: umbral (9.5), maxRondas (5), maxRondasFinal (4), fases.
// El plan está en docs/fases-rasheed.md y docs/ventas-outreach.md.
// =====================================================================
export const meta = {
  name: 'rasheed-fase-1',
  description: 'Construye cimientos, Resumen, Cotizar y Ventas (la parte de Rasheed) con agentes en paralelo y puerta de calidad de 9,5',
  whenToUse: 'Cuando Rasheed quiera avanzar su backlog con agentes en paralelo, fase por fase. Deja todo en rasheed/integracion; el merge a main lo hace una persona.',
  phases: [
    { title: 'Preparación', detail: 'rama rasheed/integracion y CI en verde' },
    { title: 'Fase 1 · cimientos', detail: 'packages/db + cliente RLS · seed' },
    { title: 'Integración 1', detail: 'merge, migraciones, seeds, CI' },
    { title: 'Fase 2 · pantallas', detail: 'auth · Resumen · Cotizar' },
    { title: 'Integración 2', detail: 'merge, migraciones, CI' },
    { title: 'Fase 3 · CRM', detail: 'empresas, radar, pipeline · ficha y seguimientos' },
    { title: 'Integración 3', detail: 'merge y CI' },
    { title: 'Fase 4 · tubería de outreach', detail: 'esquema 0015 → canales · motor · entregabilidad' },
    { title: 'Integración 4', detail: 'merge, migración de outreach, CI' },
    { title: 'Fase 5 · inteligencia', detail: 'perfil comercial · generación · recomendador' },
    { title: 'Integración 5', detail: 'merge y CI' },
    { title: 'Fase 6 · operación', detail: 'bandejas · métricas · cierre' },
    { title: 'Integración 6', detail: 'merge, CI y Vercel en modo monorepo' },
    { title: 'Revisión final', detail: 'producto integrado en bucle hasta el umbral' },
  ],
}

const UMBRAL = (args && args.umbral) || 9.5
const MAX_RONDAS = (args && args.maxRondas) || 5
const MAX_RONDAS_FINAL = (args && args.maxRondasFinal) || 4
const FASES = (args && args.fases) || [1, 2, 3, 4, 5, 6, 7]
const RAMA_INTEGRACION = 'rasheed/integracion'

// ---------------------------------------------------------------------
// Esquemas de salida
// ---------------------------------------------------------------------
const CHECKS = {
  type: 'object',
  properties: {
    typecheck: { type: 'boolean' },
    lint: { type: 'boolean' },
    test: { type: 'boolean' },
    build: { type: 'boolean' },
  },
  required: ['typecheck', 'lint', 'test', 'build'],
}
const BUILD = {
  type: 'object',
  properties: {
    branch: { type: 'string', description: 'rama donde quedó el trabajo, ya liberada con git checkout --detach' },
    commit: { type: 'string', description: 'SHA del último commit' },
    summary: { type: 'string', description: 'qué se construyó, en español, diez líneas máximo' },
    checks: CHECKS,
    decisions: { type: 'array', items: { type: 'string' }, description: 'decisiones que tomaste y por qué' },
    pending: { type: 'array', items: { type: 'string' }, description: 'lo que quedó fuera y por qué' },
  },
  required: ['branch', 'commit', 'summary', 'checks'],
}
const REVIEW = {
  type: 'object',
  properties: {
    score: { type: 'number', description: 'de 0 a 10 con un decimal, según la rúbrica' },
    ran: { type: 'array', items: { type: 'string' }, description: 'comandos y pruebas manuales que ejecutaste de verdad' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['bloqueante', 'alta', 'media', 'baja'] },
          where: { type: 'string', description: 'archivo:línea o pantalla' },
          issue: { type: 'string' },
          fix: { type: 'string', description: 'qué cambiar exactamente' },
        },
        required: ['severity', 'where', 'issue', 'fix'],
      },
    },
    praise: { type: 'array', items: { type: 'string' } },
  },
  required: ['score', 'ran', 'findings'],
}
const MERGE = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    commit: { type: 'string' },
    notes: { type: 'string' },
    ci: CHECKS,
  },
  required: ['ok', 'notes', 'ci'],
}

// ---------------------------------------------------------------------
// Texto común
// ---------------------------------------------------------------------
const CONTEXTO = `
CONTEXTO DEL PROYECTO
- Monorepo pnpm en platform/ (Next.js 15 en apps/web, packages/core con puntajes, base Postgres en Supabase con migraciones ya aplicadas e inmutables). Lee CLAUDE.md, docs/backlog-mvp.md, docs/fases-rasheed.md y, para todo lo de Ventas, docs/ventas-outreach.md antes de tocar nada.
- El backlog vivo es platform/apps/web/content/backlog.ts. Eres el dueño de las historias que te asigno; al terminar cambia su status (hecho / en_curso / bloqueada) y deja una note corta.
- Reglas que no se negocian: una migración aplicada es inmutable (si necesitas esquema nuevo, crea el siguiente 00NN_*.sql y verifícalo con \`make db.check\`; NO la apliques a Supabase: lo hace el integrador); las métricas se insertan, nunca se actualizan; ninguna pantalla hace aritmética de métricas (si falta un número derivado, va en una vista o en una consulta tipada); los tokens nunca tocan la base en claro; toda tabla con workspace_id lleva RLS y el workspace lo fija el cliente de base por transacción, nunca la pantalla.
- Convenciones: comentarios, documentación y textos de interfaz en español; identificadores en inglés; timestamptz; dinero en numeric con moneda aparte; enumerados como text + CHECK.
- Dueños de carpeta: no edites carpetas de Nicolás (packages/connectors salvo lo que te asigne, apps/worker/src/runner salvo lo que te asigne, apps/web/components/ui salvo lo que instale la CLI de shadcn, components/shell.tsx y nav.tsx salvo una línea de montaje que dejes explicada). Si una historia lo exige, hazlo mínimo y dilo en decisions.
- Estilo visual: minimalista, referencia Vercel y Notion. Tokens en apps/web/app/globals.css (bg, fg, line, accent y semánticos); nunca un color literal; tema claro y oscuro; Geist; números con tabular-nums; móvil a 400 px sin scroll horizontal.
- Producto pensado para escalar globalmente: todos los textos de interfaz en un solo lugar por módulo (un archivo messages.ts), moneda y zona horaria desde el workspace, fechas y montos con Intl, nada hardcodeado a Colombia salvo los valores por defecto del workspace.
- Llaves externas: las de Google (GOOGLE_CLIENT_ID/SECRET), Unipile (UNIPILE_DSN/UNIPILE_ACCESS_TOKEN) y Anthropic (ANTHROPIC_API_KEY) pueden no existir en el entorno. Construye contra fixtures grabados y una implementación falsa detrás de la misma interfaz; las pruebas automatizadas nunca necesitan red; la interfaz muestra un estado claro de «canal no configurado» cuando falta la llave. Nunca inventes credenciales. Documenta en platform/.env.example qué llave hace falta y cómo se consigue.
- Modelos de lenguaje: usa @anthropic-ai/sdk; claude-sonnet-5 para generar y juzgar, claude-haiku-4-5-20251001 para clasificar. Registra tokens y costo de cada llamada. Consulta la documentación actual del SDK antes de escribir la integración.
- Otros agentes trabajan en paralelo en esta máquina: para levantar la web usa un puerto libre entre 3100 y 3999 (\`pnpm --filter @mc/web dev --port NNNN\`), nunca el 3000.
`

const PROTOCOLO_RAMA = (branch) => `
PROTOCOLO DE TRABAJO (obligatorio)
1. Estás en un worktree limpio. Crea tu rama: \`git checkout -b ${branch}\`.
2. Instala: \`cd platform && pnpm install\`. Si necesitas credenciales de Supabase, corre \`make db.unlock\` en platform/ (la frase está en el Llavero; escribe .env.local, que no se versiona). Las pruebas automatizadas NO deben necesitar red: usa Postgres embebido (pglite, ya es dependencia) aplicando db/migrations como hace db/migrate.mjs.
3. Trabaja hasta cumplir el «terminado cuando» de cada historia. No dejes TODOs sin dueño, ni código muerto, ni datos de ejemplo pasando por reales.
4. Antes de terminar, en platform/: \`pnpm turbo run typecheck lint test\` y \`pnpm --filter @mc/web build\` en verde. Si algo no pasa, arréglalo; no lo silencies.
5. Actualiza status y note de tus historias en platform/apps/web/content/backlog.ts.
6. Commits en español con el id de la historia al frente (por ejemplo "CIM-2: cliente de base con aislamiento por workspace"). Termina con \`git checkout --detach\` para liberar la rama, y devuelve el JSON pedido con la rama y el SHA.
`

const RUBRICA = `
RÚBRICA (calificación de 0 a 10; el umbral para aprobar es ${UMBRAL})
Corre TÚ los comandos y usa TÚ la aplicación; no te fíes del resumen del constructor.
1. Funciona (peso 3). \`pnpm turbo run typecheck lint test\` y \`pnpm --filter @mc/web build\` en verde en la rama. Si algo falla, la nota máxima es 5.
2. Cumple el «terminado cuando» de cada historia (peso 2), demostrado ejecutando la prueba o el flujo. Una historia sin cumplir baja a 7 como máximo.
3. Seguridad de datos (peso 1,5): RLS por transacción, workspace nunca desde el cliente, sin secretos en claro, TLS con la CA versionada, sin \`rejectUnauthorized: false\`, entradas validadas, webhooks firmados, la baja de un contacto respetada en todos los canales.
4. Convenciones del repositorio (peso 1): español en UI y comentarios, identificadores en inglés, dinero en numeric, sin aritmética de métricas en React, carpetas del dueño respetadas, backlog.ts actualizado.
5. Experiencia de uso (peso 1,5): estados vacío, cargando y error; tema claro y oscuro; móvil a 400 px; foco visible y navegación por teclado; textos claros en la voz del producto; las referencias externas de la historia aplicadas de verdad, no citadas.
6. Calidad de código (peso 1): tipos estrictos sin any, funciones puras con pruebas donde hay cálculo, nombres claros, sin duplicación con lo que ya existe.
Nota = suma ponderada sobre 10, con un decimal. Sé exigente: 9,5 significa que lo desplegarías a un cliente que paga sin tocar nada. Cada punto que quites debe tener un finding con severidad, lugar y arreglo concreto. Findings vacíos con nota menor a ${UMBRAL} no valen.
`

// ---------------------------------------------------------------------
// Las piezas de trabajo
// ---------------------------------------------------------------------
const PIEZAS = {
  // ------------------------------------------------------------ Fase 1
  db: {
    id: 'db', historias: 'CIM-1 y CIM-2', branch: 'rasheed/CIM-2-cliente-db',
    brief: `
QUÉ CONSTRUYES: el paquete de acceso a datos y el esqueleto del monorepo.
- packages/db (@mc/db): Drizzle sobre pg. Esquema en src/schema/*.ts para las tablas del MVP: workspace, app_user, membership, creator_profile, niche, niche_cpm_benchmark, platform, social_connection, data_consent, post, post_metric_snapshot, account_metric_snapshot, audience_breakdown, creator_baseline, post_score, company, contact, company_link, signal, signal_source, pipeline_stage, deal, deal_stage_history, activity, outbound_brief, outbound_policy, outbound_sequence, outbound_touch, rate_card, rate_card_item, media_kit, quote, quote_item, campaign, campaign_post, campaign_result, invoice, payment, expense, platform_payout, tax_reserve, notification, job_definition, job_run, feature_flag; y las vistas post_metrics_latest, post_metrics_at_cut, post_metrics_daily_delta, creator_post_board, connection_health, deal_pipeline, receivables, outbound_touch_recent como pgView. El esquema real está en platform/db/migrations/*.sql: puedes introspectarlo (drizzle-kit contra Supabase en solo lectura con DATABASE_URL_DIRECT, o contra pglite) y luego curarlo; lo que manda es la migración, nunca al revés (no generes migraciones desde Drizzle).
- src/client.ts: pool sobre DATABASE_URL (pooler :6543, modo transacción) con TLS verificando la CA de platform/db/certs (PGSSLROOTCERT), y \`withWorkspace(workspaceId, fn)\`: abre transacción, \`select set_config('app.workspace_id', $1, true)\`, ejecuta fn con un cliente Drizzle atado a esa transacción, confirma o revierte. Nada fuera de withWorkspace debe poder leer tablas con RLS. Expón también \`asWorker(fn)\` que hace SET ROLE mc_worker dentro de la transacción, para jobs globales.
- src/queries/: un archivo por módulo, vacío o con un helper, para que cada dueño tenga el suyo desde el día 1 (resumen, ventas, cotizar, campanas, finanzas, conexiones).
- Pruebas (test/): Postgres embebido con pglite aplicando db/migrations en orden (reutiliza la lógica de db/migrate.mjs). Como pglite corre como superusuario y el superusuario salta RLS, la prueba debe \`SET ROLE mc_app\` (el rol existe desde la migración 0010; concede lo necesario en la prueba). Prueba obligatoria: dos workspaces, un deal en cada uno, cada uno ve solo el suyo; sin workspace fijado, cero filas. Deja un helper reutilizable \`test/pglite.ts\` que otros paquetes puedan importar para sus propias pruebas.
- apps/worker (@mc/worker): esqueleto con pg-boss como dependencia y un src/index.ts que abre @mc/db y lista job_definition (humo). El runner de verdad lo hace Nicolás en CON-2: no lo escribas.
- apps/web/lib/workspace/current.ts: \`getCurrentWorkspaceId()\` que hoy devuelve DEMO_WORKSPACE_ID del entorno (documentado en .env.example) y que CIM-3 reemplazará por la sesión. Es la costura para que las pantallas avancen sin auth.
- turbo: que \`pnpm turbo run typecheck lint test\` cubra los tres paquetes y \`make dev\` levante web y worker. No cambies el Makefile salvo que sea imprescindible.
TERMINADO CUANDO: la prueba de RLS pasa en pglite sin red; \`pnpm --filter @mc/worker dev\` imprime las definiciones de jobs contra Supabase; typecheck, lint, test y build en verde.
REFERENCIAS: la forma de \`withWorkspace\` sigue el patrón de Supabase para RLS con set_config por transacción; el paquete se organiza como los starters de Drizzle (schema/, client, queries por dominio).
`,
  },
  seed: {
    id: 'seed', historias: 'CIM-6', branch: 'rasheed/CIM-6-seed-ventas-metricas',
    brief: `
QUÉ CONSTRUYES: platform/db/seed/0002_demo_ventas_metricas.sql, idempotente (UUIDs fijos y ON CONFLICT DO NOTHING), que se aplica con \`node db/migrate.mjs <url> --seed\` (mira cómo migrate.mjs aplica db/seed/*.sql y respeta ese mecanismo).
- Un workspace demo de tipo creador (COP, America/Bogota) con UUID fijo documentado, un app_user demo (demo@multicampaign.test), una creator_profile (la creadora de cocina fácil del mock, ver dashboard/local/app.js y dashboard/creadores-mock.html para nombres y cifras).
- Cuatro social_connection (una por red) con secret_ref ficticio del tipo seed://…, status active, last_synced_at reciente.
- Sesenta posts repartidos en las cuatro redes en los últimos 120 días, con caption, duración, hashtags.
- Noventa días de post_metric_snapshot por post (age_hours coherente con published_at; curvas acumuladas verosímiles: crecimiento rápido las primeras 72 h y luego lento; dos o tres outliers claros) y de account_metric_snapshot diario por conexión (seguidores creciendo hacia los valores de FOLLOWERS_NOW del mock). Genera con generate_series y funciones deterministas (nada de random()), para que dos corridas den lo mismo. Demografía de audiencia (audience_breakdown) por cuenta: edad, género, país.
- creator_baseline por red y corte (24, 72, 168, 720 h) con is_reliable true, y post_score por post con views_vs_median y outlier_tier coherentes con packages/core/src/scoring.ts.
- Ventas: ocho company con dominio, nicho y redes, contactos con source válida (uno con opted_out true), company_link, doce signal en estados mixtos con dedupe_key, quince deal repartidos por etapa con next_action y fecha (dos vencidas), deal_stage_history, activity que cuenten una historia creíble; un outbound_brief activo y la outbound_policy del workspace.
- Dos campañas reportadas con campaign_result calculado, para que el perfil comercial tenga prueba social.
- Al final del archivo, un bloque de comentarios con los conteos esperados por tabla.
TERMINADO CUANDO: aplicar el seed dos veces sobre pglite con todas las migraciones deja los mismos conteos; las vistas deal_pipeline, creator_post_board y post_metrics_latest devuelven filas coherentes con el mock (seguidores totales, views en 30 días, deals abiertos y cierre ponderado del orden de los del mock).
REFERENCIAS: datos de demostración como los de Stripe en modo test o el workspace de ejemplo de Linear: creíbles, con nombres reales de negocio, sin «lorem» ni «test1».
`,
  },
  // ------------------------------------------------------------ Fase 2
  auth: {
    id: 'auth', historias: 'CIM-3', branch: 'rasheed/CIM-3-auth-workspaces',
    brief: `
QUÉ CONSTRUYES: la entrada a la aplicación con Supabase Auth y el concepto de workspace.
- @supabase/ssr en apps/web: cliente de servidor y de navegador, middleware.ts que refresca la sesión y protege todo (app)/; las rutas públicas (/login, /auth/callback, /kit/*, /cotizacion/*, /baja/*, /api/webhooks/*) quedan fuera.
- Variables: SUPABASE_URL y SUPABASE_ANON_KEY ya llegan por .env.local (make db.unlock). Next las necesita como NEXT_PUBLIC_*: mapéalas en next.config.ts (env) en vez de pedir cambios al vault; documenta en .env.example.
- /login: una sola pantalla, un campo de correo, botón «Enviarme un enlace», estado «Revisa tu correo» con reenviar y cambiar correo, errores claros. Referencias: el login de Vercel y el de Linear (un campo, sin distracciones, marca arriba, enlace legal abajo). Ojo: el correo integrado de Supabase tiene límite bajo por hora; dilo en el README.
- /auth/callback: intercambia el código, y sincroniza: app_user por correo (citext), membership, y si el usuario no tiene workspace, crea uno de tipo creador con su creator_profile (nombre a partir del correo, editable después). Todo dentro de withWorkspace o con el cliente adecuado; nunca desde el navegador.
- Workspace actual: cookie firmada mc.workspace; reemplaza getCurrentWorkspaceId() de lib/workspace/current.ts para que lea sesión + cookie y valide la membresía. Un usuario sin membresía en ese workspace nunca obtiene datos. Conserva DEMO_WORKSPACE_ID solo como atajo de desarrollo explícito.
- Cambio de workspace: components/workspace-switcher.tsx (nombre, inicial, lista de workspaces, «Crear espacio»), montado en components/shell.tsx con una sola línea (es carpeta de Nicolás: déjalo dicho en decisions). Referencia: el selector de Notion y el de Vercel arriba a la izquierda.
- Cerrar sesión, y una página /cuenta mínima con nombre y correo.
- Qué debe configurar una persona en el panel de Supabase (Site URL, Redirect URLs para localhost y para multicampaign-web.vercel.app): escríbelo en apps/web/README.md, sección «Autenticación».
TERMINADO CUANDO: se entra con un correo nuevo y aparece un workspace vacío con nombre; se entra con el correo del seed y aparece la creadora demo con sus datos; sin sesión, /resumen redirige a /login; el cambio de workspace cambia lo que se ve.
`,
  },
  resumen: {
    id: 'resumen', historias: 'RES-1 y RES-2', branch: 'rasheed/RES-1-resumen-y-csv',
    brief: `
QUÉ CONSTRUYES: la pantalla Resumen sobre datos reales y la importación por CSV.
- apps/web/app/(app)/resumen/ reemplaza el plan por la pantalla real. El plan de construcción del módulo se mueve a una ruta genérica apps/web/app/(app)/plan/[modulo]/page.tsx (usa el componente ModulePlan existente) y se enlaza desde la cabecera del módulo con un enlace discreto «Plan de construcción».
- packages/db/src/queries/resumen.ts: todas las consultas tipadas, dentro de withWorkspace. KPIs con comparación contra el periodo anterior (seguidores totales, views en el periodo, alcance en no seguidores, guardados por mil) calculados en SQL sobre account_metric_snapshot y post_metrics_latest / post_metrics_at_cut; seguidores por red en 90 días; views por semana y red en 12 semanas; «datos hasta el {fecha}» por conexión desde connection_health. Nada de aritmética de métricas en React.
- Interfaz: selector de periodo 7 / 30 / 90 días en la URL (compartible), filtro por red, fila de KPIs con delta y sparkline, dos gráficos con tooltip exacto y botón «Ver tabla» que muestra los mismos datos en tabla (accesibilidad y copia), aviso de frescura por conexión, estado vacío con dos acciones («Conectar una cuenta», «Importar un CSV»), esqueletos de carga con Suspense. Gráficos: Recharts a través de los componentes Raw de Tremor o directos, con los tokens del tema.
- Referencias que debes aplicar: Vercel Analytics (una página, periodo arriba a la derecha, comparación con el periodo anterior como pastilla de delta), Stripe Dashboard (KPIs con sparkline y «últimos 30 días»), Plausible (nada que no sea el dato), Linear Insights (tooltips con el número exacto). El modelo mental del creador es TikTok Studio e Instagram Insights: usa sus palabras (Seguidores, Visualizaciones, Alcance).
- Importación por CSV en /resumen/importar, en cuatro pasos como Flatfile u OneSchema: subir (arrastrar o elegir) → detectar formato por encabezados (TikTok Studio, Instagram Insights exportado desde Meta Business Suite, YouTube Studio) con mapeo manual de columnas si no se reconoce → previsualizar con validación fila por fila (fechas, números, duplicados contra posts existentes) → importar con server action, creando post y post_metric_snapshot con source = 'csv_import' y age_hours calculado, y un resumen «N videos, M lecturas». Investiga los encabezados reales de cada exportación y deja fixtures en apps/web/test/fixtures/csv/ con pruebas del parser (papaparse o similar). Si un formato no está documentado con certeza, el mapeo manual es el camino y lo dices.
- Textos en apps/web/app/(app)/resumen/messages.ts.
TERMINADO CUANDO: con el seed, Resumen muestra cifras del orden del mock y cada gráfico tiene su tabla; un CSV real de Instagram Insights (o el fixture) llena snapshots y aparece en Resumen; con un workspace sin conexiones se ve el estado vacío, no ceros.
`,
  },
  cotizar: {
    id: 'cotizar', historias: 'COT-1, COT-2, COT-3 y COT-4 (hasta el límite del contrato con Campañas)', branch: 'rasheed/COT-1-cotizar',
    brief: `
QUÉ CONSTRUYES: el módulo Cotizar completo: tarifario, media kit público, cotización con página pública y aceptación.
- packages/core/src/tarifas.ts (puro, con pruebas): entradas (views promedio por red, rango de CPM de niche_cpm_benchmark, modificadores como derechos de uso y exclusividad, paquetes) → ítems con rango bajo y alto y la explicación de cada número. Guarda rate_card y rate_card_item con basis y overridden cuando el creador edita.
- COT-1 pantalla: tabla de entregables con rangos (no precios fijos), panel «Cómo se calcula» al estilo del desglose de comisiones de Stripe, edición en línea con marca de «editado». Las views salen de creator_baseline cuando es confiable; si no, el creador las escribe y quedan marcadas como manuales (D4).
- COT-2 media kit: genera un snapshot congelado (seguidores por red, views promedio, engagement, top posts, audiencia si existe, tarifas) en media_kit.snapshot, con slug, contraseña y vencimiento opcionales, y contador de vistas. Página pública en apps/web/app/(public)/kit/[slug]/page.tsx. Referencias: los media kits de Beacons y Passionfroot (una columna, cifras grandes, tarifas al final), el compartir de Notion (enlace, contraseña, vencimiento).
- COT-3 cotización: crear desde un deal (los del seed, vía deal_pipeline), ítems desde el tarifario, subtotal, descuento, impuesto y total, numeración COT-AAAA-NNN por workspace (secuencia segura dentro de la transacción), lo acordado antes de publicar (métricas a reportar, cortes 24 h / 7 d / 30 d, derechos, exclusividad, plazo de pago), ciclo draft → sent → viewed → accepted / rejected / expired con fechas. Enviar = marcar sent y copiar el enlace (no hay correo en el MVP). Página pública en apps/web/app/(public)/cotizacion/[slug]/page.tsx con botón «Aceptar cotización». Referencias: Stripe Quotes (ciclo de vida y página alojada), Stripe hosted invoice page (limpieza), las propuestas de Bonsai y HoneyBook.
- Las páginas públicas no tienen sesión ni workspace, y las tablas tienen RLS: crea la migración platform/db/migrations/0014_public_share.sql con funciones SECURITY DEFINER \`public_media_kit(slug)\` y \`public_quote(slug)\` (devuelven solo lo necesario, validan contraseña y vencimiento, incrementan view_count) y una función \`public_quote_accept(slug)\`; concede EXECUTE a mc_app. Verifícala con \`make db.check\` (pglite) y NO la apliques a Supabase: eso lo hace el integrador.
- COT-4 aceptación: al aceptar, la cotización pasa a accepted, el deal a «ganado» (won_at, deal_stage_history) y se debe llamar a \`createCampaignFromQuote(quoteId)\` de packages/db/src/queries/campanas.ts, que escribe Nicolás en CAM-2 y todavía no existe. No la escribas tú ni insertes en campaign: deja la llamada preparada detrás de una interfaz clara, documenta la firma esperada en apps/web/app/(app)/cotizar/README.md, muestra en la interfaz «Campaña: pendiente de Campañas» y deja COT-4 en status bloqueada con esa nota.
- Textos en apps/web/app/(app)/cotizar/messages.ts. Moneda y formato con Intl según el workspace.
TERMINADO CUANDO: con las views del seed salen rangos del orden del mock y cambiar el CPM cambia el rango y su explicación; el enlace del media kit abre sin sesión y no cambia aunque cambien las métricas; enviar una cotización pasa el deal a «Propuesta enviada» y su enlace público permite aceptarla; aceptar deja el deal en «ganado» y la campaña marcada como pendiente de CAM-2.
`,
  },
  // ------------------------------------------------------------ Fase 3
  crm: {
    id: 'crm', historias: 'VEN-1, VEN-2 y VEN-3', branch: 'rasheed/VEN-1-crm-base',
    brief: `
QUÉ CONSTRUYES: la base del CRM de Ventas: empresas y contactos, el radar manual y el pipeline.
- apps/web/app/(app)/ventas/ reemplaza el plan por la pantalla real con dos vistas en pestañas (URL): Radar y Pipeline. El plan del módulo queda enlazado en /plan/ventas.
- packages/db/src/queries/ventas.ts: todas las consultas tipadas dentro de withWorkspace.
- VEN-1 empresas y contactos: crear, editar, buscar por nombre con el índice trigram que ya existe (búsqueda desde el tercer carácter, con debounce), company_link con relationship y dueño; un contacto exige source (public_website, public_profile, user_provided, inbound, enrichment_vendor, press) y muestra opted_out como estado inamovible. Lista en /ventas/empresas y creación en un diálogo lateral.
- VEN-2 radar manual y por CSV: bandeja de signal en estado pendiente ordenada por fit_score, aceptar (crea o actualiza la empresa y un deal en «nuevo» con «Enviar pitch» como siguiente acción y fecha a tres días) o descartar con motivo; fuente manual desde un formulario y carga por CSV de una lista de marcas (nombre, dominio, país, nicho, nota) con dedupe_key determinista para que una señal descartada no vuelva a entrar. Las fuentes automáticas quedan para fase 2 y la interfaz lo dice.
- VEN-3 pipeline: tablero kanban por etapa y vista de lista, sobre la vista deal_pipeline. Arrastrar cambia la etapa y escribe deal_stage_history con los días en la etapa (dnd-kit). KPIs arriba: señales por revisar, deals abiertos y valor, cierre ponderado, ganado en el trimestre. Un deal sin siguiente acción se ve marcado.
- Referencias: Attio y Folk (lista de empresas densa y rápida, edición en línea), Pipedrive (kanban con monto por columna), Linear (listas con teclado y acciones inmediatas, estados vacíos con una sola acción).
- Textos en apps/web/app/(app)/ventas/messages.ts.
TERMINADO CUANDO: se crea una empresa con dos contactos y aparece en la búsqueda al tercer carácter; aceptar una señal crea el deal con «Enviar pitch» y descartarla no vuelve a entrar; mover un deal a «Ganado» fija won_at y el cierre ponderado cambia al mover entre etapas.
`,
  },
  ficha: {
    id: 'ficha', historias: 'VEN-4 y VEN-5', branch: 'rasheed/VEN-5-ficha-empresa',
    brief: `
QUÉ CONSTRUYES: la ficha de empresa y el sistema de siguiente acción.
- apps/web/app/(app)/ventas/empresas/[id]/: cabecera con nombre, dominio, nicho, relación y dueño; contactos (con source y opted_out visibles); línea de tiempo de activity (nota, correo, llamada, reunión, cambio de etapa, señal detectada) con registro rápido desde la misma pantalla; «lo que sabemos» (las señales de esa empresa); y la cadena deal → cotización → campaña → factura con enlaces a lo que exista. Consultas en packages/db/src/queries/ventas-ficha.ts (archivo propio para no chocar con la pieza crm, que escribe queries/ventas.ts).
- VEN-4 siguiente acción: cada deal abierto tiene acción, fecha y responsable, editables desde la ficha y desde el pipeline (solo lectura aquí del pipeline: el componente de edición lo expones tú y crm lo puede montar después). Lista «vencidos hoy» como bloque arriba de /ventas (un componente exportado que la pieza crm monta con una línea). Job apps/worker/src/jobs/ventas/seguimientos.ts que cada mañana crea notification de tipo deal_due (vence hoy) y deal_overdue (vencido) sin duplicar; como el runner de Nicolás puede no existir, expón el job como función pura \`runSeguimientos(db, now)\` con prueba en pglite y un comando \`pnpm --filter @mc/worker run job:seguimientos\` para correrlo a mano.
- Registrar una actividad de tipo llamada, correo o reunión actualiza deal.last_contact_at.
- Referencias: la ficha de Attio (bloques colapsables, actividad como conversación), Linear (siguiente acción como una sola línea con fecha y responsable, editable en línea), Superhuman (registro rápido con teclado).
- Textos en apps/web/app/(app)/ventas/empresas/messages.ts.
TERMINADO CUANDO: registrar una llamada la pone en la línea de tiempo y actualiza last_contact_at; un deal sin siguiente acción se ve marcado; correr el job con un deal vencido crea la notificación y volver a correrlo no la duplica.
`,
  },
  // ------------------------------------------------------------ Fase 4
  esquema: {
    id: 'esquema', historias: 'VEN-9 (la migración) ', branch: 'rasheed/VEN-9-esquema-outreach',
    brief: `
QUÉ CONSTRUYES: la migración de outreach (platform/db/migrations/00NN_outreach.sql, con NN = el siguiente número libre; otras piezas pueden haber agregado migraciones antes) y su esquema Drizzle, exactamente como la describe docs/ventas-outreach.md sección 5.2. Nada más: es una pieza corta que las demás de esta fase necesitan integrada antes de empezar.
- Tablas nuevas: outreach_channel_account, outbound_step, outbound_enrollment, outbound_message, outbound_review, outbound_step_rubric, outbound_angle, outbound_counter, outbound_breaker, outbound_sequence_template (plantillas globales sin workspace, con RLS de solo lectura para todos). Extensiones de outbound_sequence (timezone, automation_mode, status, template_id) y de outbound_touch (enrollment_id, step_id, scheduled_for ya existe, attempt_count, next_retry_at, provider_message_id, thread_ref, message_id_rfc, opened_at, replied_at, held_reason) con los CHECK de status descritos. Extensión de outbound_policy: enabled, llm_daily_cap_usd, warmup_days, postal_address. Todas las tablas con workspace_id entran en la lista de RLS con el mismo patrón de la migración 0010 (la migración falla si falta workspace_id).
- Funciones: increment_if_under_cap(workspace, action_type, cap) e increment_weekly(workspace, action_type, cap) atómicas y correctas (bloquea la fila del periodo que cuenta, no la de hoy), should_pause_outreach(workspace), disable_outreach(workspace, reason) que cancela lo pendiente, enable_outreach(workspace), outbound_health(workspace, hours) que devuelve jsonb, public_optout(token) SECURITY DEFINER que marca contact.opted_out y cancela todo lo pendiente de ese contacto en cualquier workspace, y next_business_day(ts, tz).
- Datos de catálogo dentro de la migración: los seis ángulos de la sección 5.3 en outbound_angle (con permitido, prohibido y prueba que puede usar), la rúbrica por defecto en outbound_step_rubric (umbral 8,0, mínimo 4,5, cinco intentos; conexión y comentario más laxos), y una plantilla de secuencia global «Marca con campaña activa» de seis pasos.
- Índices para la cola: parcial único (enrollment_id, step_id) donde status in ('scheduled','processing'); (workspace_id, status, scheduled_for).
- Verifica con \`make db.check\`; NO la apliques a Supabase. Actualiza packages/db/src/schema con las tablas y funciones nuevas y agrega una prueba en pglite que aplique la migración de outreach y ejercite increment_if_under_cap con dos llamadas concurrentes simuladas y public_optout.
TERMINADO CUANDO: \`make db.check\` aplica la migración de outreach en limpio; la prueba de caps y de baja pasa; typecheck en verde.
`,
  },
  canales: {
    id: 'canales', historias: 'VEN-9', branch: 'rasheed/VEN-9-canales',
    brief: `
QUÉ CONSTRUYES: los canales de outreach: conectores, conexión desde la interfaz, salud y keepalive. Lee docs/ventas-outreach.md secciones 2, 4, 5.1 y 9 antes de empezar.
- packages/connectors/unipile.ts (te lo asigno aunque la carpeta sea de Nicolás; dilo en decisions): cliente con petición genérica, clasificación de errores («no conectado», «ya conectado», «límite»), hosted auth link con \`name\` = estado firmado (HMAC con una llave derivada de TOKEN_ENCRYPTION_KEY, con workspace, creador, canal y nonce), lectura de cuentas, enviar mensaje en chat nuevo o existente, invitación de LinkedIn con nota de 300 caracteres, ver perfil, reaccionar y comentar un post, listar chats y mensajes, para LINKEDIN e INSTAGRAM. Fixtures grabados en packages/connectors/fixtures/unipile/ y una implementación falsa \`FakeUnipile\` detrás de la misma interfaz. Registro de cada llamada en api_call_log.
- packages/connectors/gmail.ts: OAuth de Google (alcances gmail.send y gmail.modify más userinfo.email), refresco del token con dos minutos de margen en una sola implementación, envío con MIME correcto (RFC 2047 para acentos, multipart para adjuntos), hilo con In-Reply-To y References usando el Message-ID real (guarda threadId y Message-ID por separado), cabecera List-Unsubscribe y List-Unsubscribe-Post cuando se le pasa la URL de baja, lectura de un hilo y búsqueda de respuestas y de rebotes (mailer-daemon). Fixtures y \`FakeGmail\`.
- Rutas en apps/web: /api/oauth/google (inicio y callback, con state firmado), /api/webhooks/unipile (valida el secreto compartido, ignora lo que no venga con estado válido, escribe outreach_channel_account y encola las respuestas nuevas en outbound_message). Los tokens van al vault de tokens con TOKEN_ENCRYPTION_KEY y la tabla guarda solo secret_ref.
- Pantalla /ventas/canales: una fila por canal (correo, LinkedIn, Instagram) con estado (conectado, vencido, necesita reconectar, no configurado si falta la llave), cuenta, límites diarios y semanales editables dentro de la política, uso de hoy y de la semana, botón conectar o reconectar. Referencias: la pantalla de integraciones de Vercel y de Linear (una fila por servicio, estado a la derecha).
- Job apps/worker/src/jobs/ventas/canales.keepalive.ts: refresca a diario los tokens de Google que vencen y marca las cuentas caídas; función pura con prueba.
- Textos en apps/web/app/(app)/ventas/canales/messages.ts.
TERMINADO CUANDO: con las llaves presentes, un creador conecta su Gmail y su LinkedIn; sin llaves, la pantalla explica qué falta; el webhook rechaza una llamada sin firma válida (prueba); el keepalive con un token por vencer lo refresca (prueba con FakeGmail); typecheck, lint, test y build en verde.
`,
  },
  motor: {
    id: 'motor', historias: 'VEN-10', branch: 'rasheed/VEN-10-motor-cadencias',
    brief: `
QUÉ CONSTRUYES: el motor de cadencias, casi todo en backend. Lee docs/ventas-outreach.md secciones 2, 5.2 y 9 antes de empezar.
- packages/core/src/outreach/schedule.ts (puro, con pruebas): días hábiles, conversión de zona horaria con Intl.DateTimeFormat, hora de envío por paso, dispersión aleatoria determinista (semilla) dentro de la ventana laboral del workspace, cálculo del siguiente reintento con espera creciente.
- packages/db/src/queries/outreach.ts: enrolar contactos en una secuencia (crea outbound_enrollment y las filas de outbound_touch programadas para todos los pasos), reclamar con \`UPDATE … WHERE status='scheduled' AND scheduled_for <= now() RETURNING\` dentro de withWorkspace o asWorker, registrar resultado, cancelar pendientes de un enrolamiento, avanzar de paso.
- Despachador apps/worker/src/jobs/ventas/outbound.dispatch.ts: cada dos minutos toma hasta cincuenta toques vencidos, y para cada uno, en una sola transacción: relee el enrolamiento (si está pausado, respondido, con baja o el contacto tiene opted_out, lo salta y lo dice), comprueba la política (enabled, límites diarios y semanales con las funciones de la migración de outreach, calentamiento), comprueba que el mensaje esté aprobado (status = scheduled con cuerpo; si está held, no lo toca), despacha por el adaptador del canal, y escribe el resultado con provider_message_id y thread_ref. Fallo transitorio → attempt_count + next_retry_at con espera creciente hasta cinco intentos; fallo permanente (rebote, cuenta caída) → failed y avisa. Zombis en processing más de cinco minutos → failed sin reenviar.
- Adaptadores en apps/worker/src/jobs/ventas/canales/: interfaz \`ChannelSender { send(touch): Promise<Result> }\` con implementaciones email (gmail), linkedin e instagram (unipile) y \`fake\` para pruebas. Guardia de placeholders (packages/core/src/outreach/placeholder-guard.ts, con pruebas) en el punto de envío: bloquea {{x}}, {x}, [x], <x>, ${'$'}{x}, TBD, TODO.
- Respuestas: job outbound.replies (cada cinco minutos como respaldo del webhook) que lee hilos abiertos por Gmail y Unipile, escribe outbound_message inbound, y ante una respuesta cancela lo pendiente del enrolamiento (scheduled y held) y lo marca replied; detector de baja (packages/core/src/outreach/optout.ts, catorce expresiones en español e inglés, con pruebas) que marca contact.opted_out.
- Runner: si apps/worker/src/runner/ no existe aún (es de Nicolás, CON-2), crea el mínimo con pg-boss que registre los jobs de job_definition con su cron y los ejecute con job_run; déjalo dicho en decisions y en el README del worker para que Nicolás lo adopte. Comandos \`pnpm --filter @mc/worker run job:dispatch\` y \`job:replies\` para correr una pasada a mano.
- Interruptor: outbound_policy.enabled apagado cancela lo pendiente (usa disable_outreach de la migración de outreach) y el despachador no toma nada.
- Prueba de punta a punta en pglite con el adaptador fake: una secuencia de tres pasos, dos contactos, avanzar el reloj, comprobar envíos, una respuesta que cancela, el límite diario que reprograma al siguiente día hábil, un fallo transitorio que reintenta.
TERMINADO CUANDO: la prueba de punta a punta pasa sin red; contra Supabase con el seed, \`job:dispatch\` con la política apagada no envía nada y con la política encendida y el adaptador fake registra los envíos en outbound_touch; typecheck, lint, test y build en verde.
`,
  },
  entregabilidad: {
    id: 'entregabilidad', historias: 'VEN-15', branch: 'rasheed/VEN-15-entregabilidad',
    brief: `
QUÉ CONSTRUYES: entregabilidad y cumplimiento del correo saliente. Lee docs/ventas-outreach.md secciones 4, 5.1 y 8 antes de empezar.
- packages/core/src/outreach/deliverability.ts (puro, con pruebas): token de baja firmado por contacto y workspace, URL de baja, pie de correo obligatorio (texto de baja + dirección postal del workspace desde outbound_policy.postal_address; si falta, el envío no puede marcarse listo), cálculo del límite diario en calentamiento (día 1 a 7: 20; hasta el límite de la política a partir del día 14, creciendo cada día), detección de rebote a partir de un mensaje de mailer-daemon (códigos 5xx y textos habituales).
- Página pública apps/web/app/(public)/baja/[token]/page.tsx: sin sesión, un solo botón «Dejar de recibir mensajes», confirma y llama a public_optout(token) de la migración de outreach; muestra un estado claro después. Referencia: la página de baja de Substack (una frase, un botón, sin trucos).
- Job apps/worker/src/jobs/ventas/outbound.bounces.ts: lee rebotes con el conector de Gmail (a través de su interfaz; no toques packages/connectors), marca contact.email_invalid con motivo (agrega la columna en una migración nueva con el siguiente número libre si no existe; verifícala con make db.check) y cancela los toques de correo pendientes de ese contacto.
- Job apps/worker/src/jobs/ventas/outbound.alerts.ts: a diario, con outbound_health de la migración de outreach: rebotes sobre el 5 % con diez intentos o más, cero envíos con enrolamientos activos, cola atascada, cuenta de canal caída, presupuesto de LLM agotado; una notification por tipo y día y un correo de resumen al dueño del workspace por SMTP_URL (Mailpit en local). Prueba con fixtures.
- Pantalla /ventas/politica: la política de outreach editable (límites, días entre toques, enfriamiento, revisión humana, afirmaciones con origen, dirección postal, interruptor), con explicación de cada regla en una línea. Referencia: la configuración de Lemlist y de Instantly para límites y calentamiento.
- Textos en apps/web/app/(app)/ventas/politica/messages.ts.
TERMINADO CUANDO: un clic en el enlace de baja marca al contacto y cancela todo lo pendiente (prueba en pglite y flujo manual); un rebote de fixture marca el correo inválido y cancela los correos pendientes; el job de alertas con un fixture de salud produce las notificaciones correctas una sola vez; typecheck, lint, test y build en verde.
`,
  },
  // ------------------------------------------------------------ Fase 5
  perfil: {
    id: 'perfil', historias: 'VEN-11', branch: 'rasheed/VEN-11-perfil-comercial',
    brief: `
QUÉ CONSTRUYES: el perfil comercial del creador, el análisis de su perfil y sus videos que alimenta el outreach. Lee docs/ventas-outreach.md sección 5.4.
- packages/core/src/outreach/perfil.ts (puro, con pruebas): a partir de entradas tipadas (creator_profile, audience_breakdown, creator_baseline, post_score con los posts, campaign_result, rate_card) arma el perfil: identidad, audiencia, desempeño (mediana por red y los cinco mejores videos con su outlier_tier y una explicación corta de por qué funcionaron a partir de gancho, formato y duración), formatos y tono (en el MVP, inferidos de los captions), prueba social (campañas reportadas con resultado) y tarifas. Cada cifra es un \`Claim { id, kind, label, value, unit, source: { table, id, field } }\`.
- packages/db/src/queries/perfil-comercial.ts: las consultas dentro de withWorkspace, y persistencia del perfil en creator_profile.media_kit (jsonb) bajo la clave perfil_comercial, con fecha de cálculo.
- Narrativa: tres párrafos generados con claude-sonnet-5 que solo pueden citar claims por id (el prompt recibe la lista y exige marcar cada cifra como [claim:id]); un verificador determinista rechaza cualquier número que no esté en la lista. Sin ANTHROPIC_API_KEY, una narrativa de plantilla determinista con los mismos claims. Registro de tokens y costo.
- Pantalla /ventas/perfil: el perfil en una columna, cifras grandes con su origen al pasar el cursor (enlace al post o a la campaña), la narrativa editable, botón «Recalcular». Referencia: los media kits de Beacons y Passionfroot para la jerarquía, y el perfil de Stripe Atlas para «cada dato con su fuente».
- Textos en apps/web/app/(app)/ventas/perfil/messages.ts.
TERMINADO CUANDO: con el seed, el perfil muestra los cinco mejores videos con sus cifras y cada cifra de la narrativa lleva a su origen; un claim inventado en la narrativa es rechazado por la prueba; typecheck, lint, test y build en verde.
`,
  },
  generacion: {
    id: 'generacion', historias: 'VEN-12 (y absorbe VEN-6)', branch: 'rasheed/VEN-12-generacion-trazable',
    brief: `
QUÉ CONSTRUYES: la generación de mensajes con afirmaciones trazables y su puerta de calidad. Lee docs/ventas-outreach.md secciones 5.3, 5.6 y 9 completas antes de empezar.
- packages/core/src/outreach/render.ts: un único renderizador de plantillas ({{variable}}) con la lista canónica de variables del contacto, la empresa, la señal y el creador, con pruebas.
- packages/core/src/outreach/gates.ts (puro, con pruebas): gate A de asunto (presente, sin placeholders, 2 a 12 palabras, menos de 80 caracteres, «Re:» solo en respuestas), gate B de similitud Jaccard sobre 5-shingles contra los últimos veinte mensajes enviados del mismo tipo de paso en el workspace (umbral 0,65 directo, 0,80 correo), gate C de idempotencia.
- packages/core/src/outreach/preflight.ts (puro, con pruebas): placeholders, longitud por tipo de paso y día, lista de palabras prohibidas en español e inglés (sinergia, disruptivo, apalancar, propuesta de valor, quedo a tus órdenes, leverage, game-changer…), muletillas de IA, guiones largos y punto y coma, mayúsculas sostenidas, una sola pregunta de cierre, enlaces de calendario en el primer toque, y ninguna cifra que no esté en los claims del perfil comercial.
- Generador (packages/core/src/outreach/generate.ts + prompts en packages/core/src/outreach/prompts/*.md): entradas = perfil comercial con claims, empresa y contacto, señal que originó el deal, paso y su ángulo de outbound_angle con lo permitido y lo prohibido, toques anteriores leídos SOLO de outbound_touch con status sent, brief del creador, idioma. Salida = asunto y cuerpo con cada cifra marcada [claim:id]; claude-sonnet-5, temperatura 0,7, tope de tokens por tipo de paso. Regeneración con pistas cerradas (más corto, más específico, otro ángulo, otra señal, suavizar, añadir prueba).
- Juez (packages/core/src/outreach/judge.ts): pre-vuelo primero (sin tokens); si pasa, claude-sonnet-5 con temperatura 0 califica relevancia, calidad, estructura y voz según outbound_step_rubric del paso; banda muerta; disparadores de riesgo (cifra sin origen, marca inventada como cliente, urgencia falsa, presión, competidor de la marca, falta de divulgación) que fuerzan revisión humana; hasta cinco regeneraciones y «enviar el mejor» si alguno supera el mínimo; todo registrado en outbound_review con tokens y costo, respetando outbound_policy.llm_daily_cap_usd. Sin ANTHROPIC_API_KEY: un juez falso determinista para pruebas.
- Jobs apps/worker/src/jobs/ventas/outbound.generate.ts y outbound.review.ts: toman los toques en draft con generate_with_ai, generan, juzgan, y dejan el toque en scheduled (aprobado) o held (revisión humana) según la política y el calentamiento por tipo de paso (los primeros diez de cada tipo siempre held).
- Interfaz mínima de VEN-6 dentro de la ficha de empresa o del deal: «Redactar pitch» abre un editor con el borrador generado o vacío, las variables, los claims disponibles como chips insertables, la vista previa, los resultados del pre-vuelo en línea, y «Copiar» o «Programar». Referencias: el generador de Chief (investigación → mensaje → referencias → tono → instrucciones, nota de calidad visible, tres botones de regeneración) y el compositor de Superhuman.
TERMINADO CUANDO: un mensaje con una cifra sin claim no pasa el pre-vuelo (prueba); dos empresas del seed del mismo nicho reciben correos generados con similitud menor de 0,65 (prueba con el juez falso); el juez registra nota, tokens y costo en outbound_review; los toques anteriores del prompt salen solo de lo enviado (prueba); typecheck, lint, test y build en verde.
`,
  },
  recomendador: {
    id: 'recomendador', historias: 'VEN-13', branch: 'rasheed/VEN-13-recomendador',
    brief: `
QUÉ CONSTRUYES: el recomendador de cadencia y el constructor de secuencias. Lee docs/ventas-outreach.md secciones 5.3 y 5.5.
- packages/core/src/outreach/recomendar.ts (puro, con pruebas): desde el brief del creador, el tipo de señal (campaña activa, lanzamiento, temporada, colaboración de un competidor, manual), los canales conectados y los contactos disponibles (con o sin correo, con o sin LinkedIn), propone una secuencia: pasos con día, canal, ángulo de outbound_angle y una guía por paso en español («abre con…, no menciones…, cierra con una sola pregunta»); reglas deterministas primero, y claude-sonnet-5 solo para redactar la guía cuando hay llave (plantilla determinista si no).
- Plantillas globales en outbound_sequence_template (de la migración de outreach) por nicho y tipo de señal: al menos seis, escritas con criterio, en una migración nueva (siguiente número libre) verificada con make db.check.
- packages/db/src/queries/cadencias.ts: crear una secuencia desde una propuesta o una plantilla, editar pasos, activar, duplicar, archivar.
- Pantallas: /ventas/cadencias (lista con estado, enrolados, respuesta) y /ventas/cadencias/[id] con la línea de tiempo editable: un paso por tarjeta con día, canal, ángulo, guía, plantilla o generación automática, hora; arrastrar para reordenar; «Proponer desde esta señal» que llama al recomendador; activar en dos clics; enrolar contactos desde un deal. Referencias: la línea de tiempo de Lemlist e Instantly, el flow viewer de Chief para el resumen «Día 0: …→ Día 1: …», Linear para la edición en línea.
- Textos en apps/web/app/(app)/ventas/cadencias/messages.ts.
TERMINADO CUANDO: desde una señal de «campaña activa» del seed, el creador obtiene una secuencia de seis pasos con guía y la activa en dos clics; la propuesta cambia si el contacto no tiene LinkedIn (prueba); typecheck, lint, test y build en verde.
`,
  },
  // ------------------------------------------------------------ Fase 6
  bandejas: {
    id: 'bandejas', historias: 'VEN-14', branch: 'rasheed/VEN-14-bandejas',
    brief: `
QUÉ CONSTRUYES: la bandeja de aprobación y la bandeja unificada. Lee docs/ventas-outreach.md secciones 5.6 y 5.7.
- /ventas/aprobaciones: los toques en held, uno por fila: empresa, contacto, paso y canal, vista previa completa, por qué quedó retenido (pre-vuelo, juez o calentamiento, con la nota y el feedback), y acciones: aprobar (pasa a scheduled), editar y aprobar, regenerar con una pista, saltar. Navegación por teclado (j, k, a, e, r, s). Referencia: la bandeja de Linear y la de Superhuman; Stripe Radar para «por qué se retuvo».
- /ventas/bandeja: hilos de outbound_message agrupados por contacto y canal (correo, LinkedIn, Instagram), no leídos primero, con la conversación completa y respuesta desde la app a través del adaptador del canal (usa la interfaz del motor; no dupliques envíos). Referencia: Front y Superhuman (lista a la izquierda, conversación a la derecha, acciones arriba).
- Job apps/worker/src/jobs/ventas/outbound.intent.ts: clasifica cada respuesta nueva con claude-haiku-4-5-20251001 en interesado, ahora no, fuera de oficina (con fecha), baja, referido o ambiguo (confianza menor de 0,7 → ambiguo); clasificador falso determinista sin llave. Efectos: interesado → deal a «En conversación», siguiente acción «Responder hoy», notificación; ahora no → enrolamiento en cooldown 90 días; fuera de oficina → resume_at; baja → contact.opted_out; referido → propone crear el contacto; ambiguo → notificación para revisar.
- Textos en apps/web/app/(app)/ventas/aprobaciones/messages.ts y bandeja/messages.ts.
TERMINADO CUANDO: un toque retenido se aprueba desde la bandeja y queda scheduled; una respuesta «me interesa» (fixture) mueve el deal y aparece en la bandeja con la conversación completa; una respuesta de baja marca al contacto y cancela lo pendiente; typecheck, lint, test y build en verde.
`,
  },
  metricas: {
    id: 'metricas', historias: 'VEN-16', branch: 'rasheed/VEN-16-actividad-metricas',
    brief: `
QUÉ CONSTRUYES: la actividad y las métricas del outreach. Lee docs/ventas-outreach.md sección 6 (VEN-16) y las referencias de Chief en la sección 2.
- Migración nueva de vistas de outreach, con el siguiente número libre (verificada con make db.check): vistas outbound_queue (la cola con su estado, paso, contacto y error), outbound_usage_daily (uso por canal y día contra el límite), outbound_funnel_by_step (enviados, abiertos, respondidos, positivos por paso y secuencia) y outbound_sequence_health. Las vistas se prueban en pglite contra datos insertados: nada de estados que no existan en los CHECK.
- /ventas/actividad: la cola visible (programados y fallidos) y el historial, con filtros por secuencia, tipo de paso y contacto, reintento por tipo de paso, cancelar en masa, error truncado con detalle al pasar el cursor. Referencia: la Outreach Activity y la pestaña Queue de Chief, y la lista de eventos de Stripe.
- Widget de uso por canal con límite blando y duro y semáforo, en /ventas/canales (expórtalo como componente; la pieza canales ya montó la pantalla, agrégalo con una línea y dilo en decisions).
- Embudo por paso en /ventas/cadencias/[id] (expórtalo como componente montable con una línea) y vista de flujo de solo lectura con tooltips que explican cada número, como el flow viewer de Chief.
- Textos en apps/web/app/(app)/ventas/actividad/messages.ts.
TERMINADO CUANDO: con una semana de envíos de prueba (fixture insertado en pglite), el embudo cuadra con outbound_touch fila a fila (prueba); la cola muestra un fallido y el reintento lo devuelve a scheduled; typecheck, lint, test y build en verde.
`,
  },
  cierre: {
    id: 'cierre', historias: 'VEN-7 y VEN-8', branch: 'rasheed/VEN-7-brief-y-conversion',
    brief: `
QUÉ CONSTRUYES: el brief de outbound y el cierre de deals.
- VEN-7 /ventas/brief: qué busca el creador (categorías, países, presupuesto mínimo, entregables, disponibilidad) y qué no acepta (categorías y empresas excluidas, divulgación obligatoria), sobre outbound_brief; el radar filtra la bandeja con el brief activo y lo dice («3 señales ocultas por tu brief»). Consultas en packages/db/src/queries/brief.ts.
- VEN-8: al mover un deal a «Perdido», motivo obligatorio (los del CHECK de deal.lost_reason) en un diálogo; tasa de conversión por etapa desde deal_stage_history, mostrada en el pipeline como una fila discreta debajo de cada columna con el número de deals que la sostiene. Consulta en packages/db/src/queries/conversion.ts; el componente lo exportas y lo montas en el pipeline con una línea (dilo en decisions).
- Referencias: el formulario de preferencias de Passionfroot, y la conversión por etapa de Pipedrive.
TERMINADO CUANDO: una señal de una categoría excluida no aparece en la bandeja (prueba); marcar un deal perdido exige motivo; la tasa entre etapas aparece con su número de deals y cuadra con deal_stage_history (prueba); typecheck, lint, test y build en verde.
`,
  },
}

const FASES_DEF = [
  { n: 1, titulo: 'Fase 1 · cimientos', primero: [], paralelo: ['db', 'seed'] },
  { n: 2, titulo: 'Fase 2 · pantallas', primero: [], paralelo: ['auth', 'resumen', 'cotizar'] },
  { n: 3, titulo: 'Fase 3 · CRM', primero: [], paralelo: ['crm', 'ficha'] },
  { n: 4, titulo: 'Fase 4 · tubería de outreach', primero: ['esquema'], paralelo: ['canales', 'motor', 'entregabilidad'] },
  { n: 5, titulo: 'Fase 5 · inteligencia', primero: [], paralelo: ['perfil', 'generacion', 'recomendador'] },
  { n: 6, titulo: 'Fase 6 · operación', primero: [], paralelo: ['bandejas', 'metricas', 'cierre'] },
]

// ---------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------
function promptConstruir(p) {
  return `Eres el constructor de la pieza «${p.id}» del MVP de MultiCampaign: historias ${p.historias} de Rasheed.
${CONTEXTO}
${p.brief}
${PROTOCOLO_RAMA(p.branch)}
Devuelve el JSON del esquema: rama, SHA, resumen, checks reales, decisiones y pendientes.`
}

function promptRevisar(lente, p, branch, ronda) {
  const foco = lente === 'tecnico'
    ? `LENTE TÉCNICO. Lee el diff completo contra ${RAMA_INTEGRACION} (\`git diff ${RAMA_INTEGRACION}...${branch}\`), corre los cuatro comandos, corre las pruebas de la pieza, busca fallos de seguridad de datos (RLS, workspace desde el cliente, secretos, validación de entradas, webhooks sin firma, baja no respetada), tipos débiles, duplicación, y que cada «terminado cuando» esté demostrado por una prueba o un comando reproducible.`
    : `LENTE DE PRODUCTO. Levanta la aplicación (\`make db.unlock\` si hace falta, \`pnpm --filter @mc/web dev --port NNNN\` con un puerto libre entre 3100 y 3999) y usa de verdad cada flujo de la pieza como lo haría un creador que paga: estados vacío, cargando y error; tema claro y oscuro; ventana de 400 px; teclado y foco; textos y nombres; que las referencias externas de la historia estén aplicadas (no citadas); que nada parezca un prototipo. Si la pieza no tiene pantalla (db, seed, esquema, motor), evalúa la experiencia del desarrollador que la va a usar: nombres, documentación, mensajes de error, comandos, y que los datos de demostración cuenten una historia creíble.`
  return `Eres un revisor independiente y exigente de la pieza «${p.id}» (historias ${p.historias}), ronda ${ronda}. No construiste nada: tu trabajo es encontrar lo que falta para que esto sea un producto que se cobra.
${CONTEXTO}
LA PIEZA PEDIDA:
${p.brief}
${foco}
PROTOCOLO: estás en un worktree limpio; \`git checkout ${branch}\`; \`cd platform && pnpm install\`. No modifiques archivos de la rama. Al terminar, \`git checkout --detach\`.
${RUBRICA}
Devuelve el JSON del esquema con la nota, lo que ejecutaste, los findings con arreglo concreto y lo que está bien hecho.`
}

function promptCorregir(p, branch, findings, ronda) {
  const lista = findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.where}: ${f.issue}\n   Arreglo: ${f.fix}`).join('\n')
  const nueva = `${p.branch}-r${ronda}`
  return `Eres el constructor de la pieza «${p.id}» (historias ${p.historias}) en la ronda ${ronda}. Dos revisores calificaron la rama ${branch} por debajo de ${UMBRAL}. Tu trabajo es dejarla por encima.
${CONTEXTO}
LA PIEZA PEDIDA:
${p.brief}
FINDINGS A RESOLVER (todos; si uno te parece equivocado, explícalo en decisions con evidencia, no lo ignores):
${lista}
PROTOCOLO: estás en un worktree limpio. \`git checkout -b ${nueva} ${branch}\`; \`cd platform && pnpm install\`; resuelve; corre \`pnpm turbo run typecheck lint test\` y \`pnpm --filter @mc/web build\` en verde; actualiza backlog.ts si cambia algo; commit en español con el id de la historia; \`git checkout --detach\`.
Devuelve el JSON del esquema con la rama nueva (${nueva}) y el SHA.`
}

function promptIntegrar(etiqueta, piezas, extra) {
  const ramas = piezas.map((r) => `- ${r.id}: ${r.branch} (nota ${r.score})`).join('\n')
  return `Eres el integrador de «${etiqueta}». Trabajas en el checkout principal del repositorio, que está en la rama ${RAMA_INTEGRACION}. NO uses worktrees.
${CONTEXTO}
RAMAS A INTEGRAR, en este orden:
${ramas}
PROTOCOLO:
1. \`git status\` debe estar limpio y \`git branch --show-current\` debe ser ${RAMA_INTEGRACION}. Si no, detente y explícalo en notes con ok=false.
2. \`git merge --no-ff <rama>\` una por una. Los conflictos esperables son package.json y pnpm-lock.yaml: resuélvelos conservando ambas dependencias y regenerando el lockfile con \`pnpm install\` en platform/. Un conflicto en código de dos piezas distintas es una señal de que alguien tocó carpeta ajena: resuélvelo respetando al dueño y dilo en notes.
3. En platform/: \`pnpm install\`, \`pnpm turbo run typecheck lint test\`, \`pnpm --filter @mc/web build\`. Si algo falla por la integración (no por una pieza), arréglalo con un commit "integración ${etiqueta}: …". Si falla por una pieza, dilo en notes con el detalle y ok=false; no parches la pieza.
4. Si la integración trae migraciones nuevas en platform/db/migrations: \`make db.check\` y, si pasa, \`make db.migrate\` (aplica a Supabase, que es la base de desarrollo). Si trae seeds nuevos en platform/db/seed: \`make db.seed\`. Anota en notes qué aplicaste.
5. Revisa platform/apps/web/content/backlog.ts: cada historia integrada con su status correcto.
${extra || ''}
6. Deja el checkout en ${RAMA_INTEGRACION} con todo commiteado. No hagas push, no toques main, no despliegues.
Devuelve el JSON del esquema.`
}

const EXTRA_VERCEL = `5b. Vercel en modo monorepo: cuando apps/web depende de packages/db, subir solo apps/web deja de servir. Adapta platform/scripts/vercel.sh para que \`deploy\` corra \`vercel deploy --cwd platform\` (con un .vercelignore en platform/ que excluya node_modules, .next, secrets y todo lo que no sea código) y para que \`link\` fije \`rootDirectory: "apps/web"\` en el proyecto con \`api PATCH /v9/projects/{id}\`, guardando la decisión en el vault (VERCEL_APP_DIR). No despliegues ni llames a la API ahora: solo deja el script listo y documenta en notes cómo se corre.`

const PROMPT_PREPARAR = `Prepara el repositorio para el workflow. Trabajas en el checkout principal, sin worktrees.
1. \`git status --porcelain\` debe estar vacío. Si hay cambios sin commit, devuelve ok=false y explica en notes qué hay: no arregles nada.
2. Rama: si estás en ${RAMA_INTEGRACION}, sigue. Si estás en main: si ${RAMA_INTEGRACION} no existe, créala (\`git checkout -b ${RAMA_INTEGRACION}\`); si existe, \`git checkout ${RAMA_INTEGRACION}\` y \`git merge main\` (si hay conflicto, ok=false). En cualquier otra rama, ok=false.
3. En platform/: \`pnpm install\`, \`pnpm turbo run typecheck lint test\` y \`pnpm --filter @mc/web build\`. Devuelve los resultados en ci.
4. Confirma que docs/fases-rasheed.md y docs/ventas-outreach.md existen (son el plan que leen los agentes).
Devuelve el JSON del esquema con ok, el SHA actual en commit y notas.`

function promptRevisionFinal(lente, ronda) {
  const foco = lente === 'tecnico'
    ? `LENTE TÉCNICO. Corre los cuatro comandos en la rama integrada; lee \`git diff main...${RAMA_INTEGRACION} --stat\` y revisa por módulo los puntos de riesgo: RLS en cada consulta nueva, webhooks firmados, baja respetada en todos los canales, la cola sin condiciones de carrera, secretos, duplicación entre módulos (dos renderizadores, dos clientes de Gmail, dos formas de calcular lo mismo), vistas que usen estados fuera de los CHECK, migraciones que no aplican en limpio con make db.check.`
    : `LENTE DE PRODUCTO. Levanta la app (\`make db.unlock\`, \`pnpm --filter @mc/web dev --port NNNN\` en un puerto libre entre 3100 y 3999) y recorre el producto completo como un creador nuevo y luego como la creadora del seed: entrar; ver el workspace vacío; entrar con el seed; Resumen con periodos, redes, tablas e importar un CSV; Ventas de punta a punta: canales (o su estado de no configurado), brief, radar, aceptar una señal, pipeline, ficha, perfil comercial, proponer una cadencia desde la señal, activarla, ver la cola, aprobar un mensaje retenido, ver una respuesta en la bandeja, política y actividad; Cotizar con tarifario, media kit público en una ventana sin sesión, cotización pública y aceptación; cambio de workspace; cerrar sesión. Comprueba coherencia entre módulos (mismas cifras en Resumen, perfil y media kit; misma moneda y formato; mismos nombres para las mismas cosas), tema oscuro y móvil en todo el recorrido, y que el plan (/) refleje los estados reales del backlog.`
  return `Eres el revisor final del producto integrado en ${RAMA_INTEGRACION}, ronda ${ronda}. Trabajas en un worktree limpio: \`git checkout ${RAMA_INTEGRACION}\`; \`cd platform && pnpm install\`.
${CONTEXTO}
${foco}
${RUBRICA}
Aquí la nota es del producto integrado, no de una pieza. En cada finding, empieza \`where\` con la ruta del archivo o la ruta de la pantalla (por ejemplo apps/web/app/(app)/ventas/… o /ventas/cadencias) para que se pueda asignar a su módulo. Devuelve el JSON del esquema.`
}

function promptCorregirIntegrado(area, findings, ronda) {
  const lista = findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.where}: ${f.issue}\n   Arreglo: ${f.fix}`).join('\n')
  const branch = `rasheed/final-r${ronda}-${area}`
  return `Eres el corrector del área «${area}» en la ronda final ${ronda}. Los revisores del producto integrado dejaron estos findings que caen en tu área. Tu trabajo es resolverlos todos sin romper nada de lo demás.
${CONTEXTO}
FINDINGS (si uno te parece equivocado, explícalo en decisions con evidencia, no lo ignores):
${lista}
PROTOCOLO: estás en un worktree limpio sobre ${RAMA_INTEGRACION}. \`git checkout -b ${branch}\`; \`cd platform && pnpm install\`; resuelve tocando solo los archivos de tu área (si un arreglo exige tocar otra área, hazlo mínimo y dilo en decisions); corre \`pnpm turbo run typecheck lint test\` y \`pnpm --filter @mc/web build\` en verde; commits en español; \`git checkout --detach\`.
Devuelve el JSON del esquema con la rama (${branch}) y el SHA.`
}

// ---------------------------------------------------------------------
// Construir con puerta de calidad
// ---------------------------------------------------------------------
async function construirConCalidad(p, etiqueta) {
  let r = await agent(promptConstruir(p), {
    label: `construir:${p.id}`, phase: etiqueta, isolation: 'worktree', effort: 'high', schema: BUILD,
  })
  if (!r) return { id: p.id, ok: false, score: 0, branch: null, rondas: 0, notes: 'el constructor no devolvió resultado' }
  let branch = r.branch || p.branch
  let ultimo = null

  for (let ronda = 1; ronda <= MAX_RONDAS; ronda++) {
    // Barrera legítima: la nota es el mínimo de dos lentes distintas.
    const [tec, prod] = await parallel([
      () => agent(promptRevisar('tecnico', p, branch, ronda), {
        label: `revisar-tecnico:${p.id} r${ronda}`, phase: etiqueta, isolation: 'worktree', effort: 'high', schema: REVIEW,
      }),
      () => agent(promptRevisar('producto', p, branch, ronda), {
        label: `revisar-producto:${p.id} r${ronda}`, phase: etiqueta, isolation: 'worktree', effort: 'high', schema: REVIEW,
      }),
    ])
    const notaTec = tec ? tec.score : 0
    const notaProd = prod ? prod.score : 0
    const score = Math.min(notaTec, notaProd)
    ultimo = { tec, prod, score }
    log(`${p.id} · ronda ${ronda}: técnico ${notaTec} · producto ${notaProd} · mínimo ${score} (umbral ${UMBRAL})`)

    if (score >= UMBRAL) {
      return { id: p.id, ok: true, score, branch, rondas: ronda, summary: r.summary, pending: r.pending || [] }
    }
    const findings = [...((tec && tec.findings) || []), ...((prod && prod.findings) || [])]
    if (ronda === MAX_RONDAS) {
      log(`${p.id}: no alcanzó ${UMBRAL} en ${MAX_RONDAS} rondas; se entrega con la nota ${score} y sus findings`)
      return { id: p.id, ok: false, score, branch, rondas: ronda, summary: r.summary, findings }
    }
    const fix = await agent(promptCorregir(p, branch, findings, ronda + 1), {
      label: `corregir:${p.id} r${ronda + 1}`, phase: etiqueta, isolation: 'worktree', effort: 'high', schema: BUILD,
    })
    if (fix && fix.branch) { r = fix; branch = fix.branch }
  }
  return { id: p.id, ok: false, score: ultimo ? ultimo.score : 0, branch, rondas: MAX_RONDAS }
}

async function integrar(etiqueta, fase, listas, extra) {
  phase(`Integración ${fase}`)
  const int = await agent(promptIntegrar(etiqueta, listas, extra), {
    label: `integrar:${etiqueta}`, phase: `Integración ${fase}`, effort: 'high', schema: MERGE,
  })
  return int
}

async function correrFase(def) {
  phase(def.titulo)
  const hechas = []
  // Piezas que van primero, una a una, integradas antes de las paralelas.
  for (const id of def.primero) {
    const r = await construirConCalidad(PIEZAS[id], def.titulo)
    hechas.push(r)
    if (r.branch) {
      const int = await integrar(`fase ${def.n} · ${id}`, def.n, [r])
      if (!int || !int.ok) return { fase: def.n, piezas: hechas, integracion: int, ok: false }
      log(`${id} integrado (${int.commit})`)
      phase(def.titulo)
    }
  }
  // Barrera legítima: la integración necesita todas las ramas de la fase.
  const paralelas = (await parallel(def.paralelo.map((id) => () => construirConCalidad(PIEZAS[id], def.titulo)))).filter(Boolean)
  hechas.push(...paralelas)
  if (paralelas.some((x) => !x.ok)) log(`Fase ${def.n}: alguna pieza no alcanzó el umbral; se integra igual y queda señalada en el informe`)
  const listas = paralelas.filter((x) => x.branch)
  const int = await integrar(`fase ${def.n}`, def.n, listas, def.n === 6 ? EXTRA_VERCEL : '')
  return { fase: def.n, piezas: hechas, integracion: int, ok: !!(int && int.ok) }
}

function areaDe(where) {
  const w = (where || '').toLowerCase()
  if (w.includes('ventas') || w.includes('outreach') || w.includes('outbound')) return 'ventas'
  if (w.includes('cotizar') || w.includes('cotizacion') || w.includes('/kit')) return 'cotizar'
  if (w.includes('resumen')) return 'resumen'
  if (w.includes('auth') || w.includes('login') || w.includes('workspace')) return 'auth'
  if (w.includes('worker') || w.includes('connectors') || w.includes('packages/db') || w.includes('migrations') || w.includes('seed') || w.includes('packages/core')) return 'datos'
  return 'web'
}

async function revisionFinal() {
  phase('Revisión final')
  const salida = { rondas: [], ok: false, score: 0 }
  for (let ronda = 1; ronda <= MAX_RONDAS_FINAL; ronda++) {
    const [tec, prod] = await parallel([
      () => agent(promptRevisionFinal('tecnico', ronda), { label: `final-tecnico r${ronda}`, phase: 'Revisión final', isolation: 'worktree', effort: 'high', schema: REVIEW }),
      () => agent(promptRevisionFinal('producto', ronda), { label: `final-producto r${ronda}`, phase: 'Revisión final', isolation: 'worktree', effort: 'high', schema: REVIEW }),
    ])
    const notaTec = tec ? tec.score : 0
    const notaProd = prod ? prod.score : 0
    const score = Math.min(notaTec, notaProd)
    log(`Revisión final · ronda ${ronda}: técnico ${notaTec} · producto ${notaProd} · mínimo ${score} (umbral ${UMBRAL})`)
    const findings = [...((tec && tec.findings) || []), ...((prod && prod.findings) || [])]
    salida.rondas.push({ ronda, tec: notaTec, prod: notaProd, score, findings: findings.length })
    salida.score = score
    if (score >= UMBRAL) { salida.ok = true; return salida }
    if (ronda === MAX_RONDAS_FINAL) {
      salida.findings = findings
      log(`Revisión final: no alcanzó ${UMBRAL} en ${MAX_RONDAS_FINAL} rondas; quedan ${findings.length} findings en el informe`)
      return salida
    }
    const grupos = {}
    for (const f of findings) { const a = areaDe(f.where); (grupos[a] ||= []).push(f) }
    const fixes = (await parallel(Object.keys(grupos).map((area) => () =>
      agent(promptCorregirIntegrado(area, grupos[area], ronda), { label: `final-corregir:${area} r${ronda}`, phase: 'Revisión final', isolation: 'worktree', effort: 'high', schema: BUILD })
        .then((r) => (r && r.branch ? { id: `final-${area}`, branch: r.branch, score: '-' } : null))
    ))).filter(Boolean)
    if (!fixes.length) { salida.findings = findings; return salida }
    const int = await agent(promptIntegrar(`revisión final · ronda ${ronda}`, fixes), { label: `integrar:final r${ronda}`, phase: 'Revisión final', effort: 'high', schema: MERGE })
    if (!int || !int.ok) { salida.integracion = int; salida.findings = findings; return salida }
    phase('Revisión final')
  }
  return salida
}

// ---------------------------------------------------------------------
// Orquestación
// ---------------------------------------------------------------------
phase('Preparación')
const prep = await agent(PROMPT_PREPARAR, { label: 'preparar', phase: 'Preparación', effort: 'medium', schema: MERGE })
if (!prep || !prep.ok) {
  return { ok: false, etapa: 'preparación', detalle: prep ? prep.notes : 'sin respuesta del agente de preparación' }
}
log(`Repositorio listo en ${RAMA_INTEGRACION} (${prep.commit})`)

const resultado = { ok: true, umbral: UMBRAL, fases: {} }

for (const def of FASES_DEF) {
  if (!FASES.includes(def.n)) continue
  const r = await correrFase(def)
  resultado.fases[def.n] = r
  if (!r.ok) {
    resultado.ok = false
    resultado.detalle = `la integración de la fase ${def.n} falló; ver fases[${def.n}].integracion.notes`
    return resultado
  }
  log(`Fase ${def.n} integrada en ${RAMA_INTEGRACION} (${r.integracion.commit})`)
}

if (FASES.includes(7)) {
  resultado.final = await revisionFinal()
  resultado.ok = resultado.ok && resultado.final.ok
}

resultado.siguiente = `Revisar ${RAMA_INTEGRACION}, mergear a main, fijar el directorio raíz del proyecto en Vercel y desplegar con make vercel.deploy PROD=1 (ver docs/fases-rasheed.md).`
return resultado
