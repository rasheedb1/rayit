// =====================================================================
// El backlog del MVP, con su estado vivo.
//
// La narrativa (por qué este reparto, las reglas, las dependencias)
// está en docs/backlog-mvp.md. Aquí vive lo que cambia cada día: el
// estado de cada historia.
//
// Para marcar avance, el dueño de la historia cambia `status` y, si
// hace falta, deja una `note` corta (qué falta, qué PR). Se sube en el
// mismo PR de la historia; el despliegue de main lo publica.
//
//   pendiente  → nadie la ha empezado
//   en_curso   → hay una rama abierta
//   bloqueada  → espera algo que no depende del dueño (dilo en la nota)
//   hecho      → cumple su «terminado cuando» y está en main
// =====================================================================
import type { OwnerId } from "./team";
import type { StoryPrefix } from "./modules";

export type Status = "pendiente" | "en_curso" | "bloqueada" | "hecho";
export type Size = "S" | "M" | "L";
export type SprintNumber = 1 | 2 | 3 | 4 | 5 | 6;

export interface Story {
  id: string;
  module: StoryPrefix;
  owner: OwnerId;
  /** S: un día o menos · M: dos o tres días · L: una semana · null: no es código */
  size: Size | null;
  sprint: SprintNumber;
  deps: string[];
  title: string;
  desc: string;
  /** Lo que se enseña en la demo del viernes. */
  done: string;
  status: Status;
  note?: string;
}

export interface Sprint {
  n: SprintNumber;
  weeks: string;
  name: string;
  demo: string;
}

export const SPRINTS: readonly Sprint[] = [
  {
    n: 1,
    weeks: "Semanas 1 y 2",
    name: "Cimientos y las primeras piezas de cada cadena",
    demo: "Login y marco; seeds cargados; empresas y radar manual (Rasheed); primera factura a mano y el worker corriendo un job (Nicolás).",
  },
  {
    n: 2,
    weeks: "Semanas 3 y 4",
    name: "Resumen con datos, pipeline, primera cuenta conectada",
    demo: "Resumen con seed y con un CSV real de Instagram; pipeline kanban (Rasheed). Conectar una cuenta de TikTok sandbox; ficha de campaña con posts del seed (Nicolás).",
  },
  {
    n: 3,
    weeks: "Semanas 5 y 6",
    name: "Métricas reales, ficha de empresa, cotizar y cobrar",
    demo: "Ficha de empresa con siguiente acción; tarifario y media kit público (Rasheed). El recolector trayendo métricas reales de la cuenta conectada, línea base, pagos y cuentas por cobrar (Nicolás).",
  },
  {
    n: 4,
    weeks: "Semanas 7 y 8",
    name: "El ciclo completo",
    demo: "Cotización enviada y aceptada crea la campaña (Rasheed); la campaña mide seguidores de la marca, calcula el resultado y envía el reporte; flujo de caja (Nicolás). Pitch trazable (Rasheed).",
  },
  {
    n: 5,
    weeks: "Semanas 9 y 10",
    name: "Lo que depende de aprobaciones, el mánager y el piloto",
    demo: "Pantalla de conexiones, YouTube, recordatorios de cobro (Nicolás). Lo que importa esta semana (Rasheed). Y la que pide el piloto: el creador invita a su mánager, el mánager entra y ve Campañas pero no el flujo de caja. Producción abierta a los primeros creadores.",
  },
  {
    n: 6,
    weeks: "Fase 2 · sin fecha",
    name: "Alcance, agencias y lo que se corrió para que cupieran los roles",
    demo: "No tiene demo de viernes: se abre cuando el piloto confirme que hay agencias esperando. Lleva el alcance por creador (ACC-6, ACC-7), los roles a medida (ACC-9), el épico AGE de agencias, y las cuatro historias que salieron del sprint 5 para hacerle sitio a ACC-4.",
  },
];

export const STORIES: readonly Story[] = [
  // ---------------------------------------------------------------- CIM
  {
    id: "CIM-1", module: "CIM", owner: "rasheed", size: "M", sprint: 1, deps: [],
    title: "Monorepo listo",
    desc: "apps/web con Next.js + TypeScript, packages/db con Drizzle, apps/worker con pg-boss, turbo corriendo dev, typecheck, lint y test. Un package.json por paquete.",
    done: "make dev levanta los tres procesos y pnpm turbo run typecheck lint pasa en CI.",
    status: "bloqueada",
    note:
      "ESTADO (22-sep, pulido r1): monorepo, `pnpm verificar` y build en verde; una sola frontera de error en (app) y withWorkspace comprueba que el workspace existe (el alta de CIM-3 no pasa por ahí). BLOQUEADA por dos comandos en Supabase con el token de administración: GRANT mc_worker TO mc_migrator y CREATE SCHEMA pgboss (docs/propuestas/CON-2.md §3.1). Vuelve a «hecho» cuando `pnpm --filter @mc/worker dev` arranque el runner contra Supabase. Historia por rondas: docs/propuestas/CIM-2.md §6.2.",
  },
  {
    id: "CIM-2", module: "CIM", owner: "rasheed", size: "M", sprint: 1, deps: ["CIM-1"],
    title: "Cliente de base con aislamiento (RLS)",
    desc: "Cada consulta corre en una transacción que fija app.workspace_id con set_config(…, true), contra el pooler en modo transacción. Esquema Drizzle generado desde las migraciones para las tablas del MVP.",
    done: "Un test crea dos workspaces, inserta un deal en cada uno y comprueba que ninguno ve el del otro. Sin workspace_id fijado, la consulta devuelve cero filas.",
    status: "hecho",
    note:
      "ESTADO (23-sep, pulido r8). Pulido r4: guardia de esquema en verde sobre 0001–0033 en embebido; ahora mide también a mc_public_share contra su inventario exacto (privilegios y columnas, las siete políticas de 0030 y su forma, NOLOGIN sin BYPASSRLS ni membresías), en cada arranque y en make db.guardia. Pulido r5: el bloqueo del media kit pasa a ser por origen (media_kit_lockout en 0030, IP resumida y sin lectura para mc_app) con techo por enlace y «Desbloquear»; AUTH_SECRET sale de .env.example (nada la leía). Pulido r6: la guardia exige además cada columna de src/schema (deal.next_action_kind de 0032 incluida), sin lista a mano. COLA ÚNICA DEL INTEGRADOR (las demás historias remiten aquí), en este orden: 1) crear mc_public_share con supabase-admin.sh; 2) make db.migrate, que aplica 0024…0033 en orden (Supabase va por 0022; 0031 reescribe public_quote_accept_impl de 0030, 0032 reescribe brand_key de 0031 y añade deal.next_action_kind con su disparador deal_next_action_kind_reset, y 0033 añade quote.superseded_by, la política quote_public_share_accepted_sibling y reescribe public_quote_accept_impl de 0031 y public_quote_impl de 0030); 3) make db.guardia en verde ANTES de make vercel.deploy PROD=1, y pegar aquí su salida; 4) volver a sembrar (CIM-6). Pulido r7: 0033 escribe superseded_by también desde el enlace (la tardía dice «sin efecto», no «venció») y se puede volver a correr; mc_app pierde UPDATE sobre account_metric_snapshot (0025 §5, upsert de CON-10 a DO NOTHING; falta el visto bueno de Nicolás). Pulido r8: con ese DO NOTHING, last_synced_at solo se mueve si la lectura del día quedó guardada; si ya la había, Conexiones dice «La lectura de hoy ya está guardada» (mismo visto bueno pendiente). ABIERTO, con plan en docs/propuestas/CIM-2.md §3: ids bigserial como contador global, ahora historia CIM-11 (sprint 4), y el radar, que no puede publicar sin dueño lo que salga de una lista privada. Historia por rondas: docs/propuestas/CIM-2.md §6.1.",
  },
  {
    id: "CIM-3", module: "CIM", owner: "rasheed", size: "M", sprint: 1, deps: ["CIM-2"],
    title: "Autenticación y workspaces",
    desc: "Supabase Auth con correo y enlace mágico. Al entrar se crea app_user y membership; si no hay workspace, se crea uno de tipo creador con su creator_profile. Cambio de workspace en la barra.",
    done: "Se entra con un correo nuevo y aparece un workspace vacío con nombre; se entra con uno del seed y aparece la creadora ficticia.",
    status: "hecho",
    note:
      "Hecha e integrada con el endurecimiento. Pulido r1 (22-sep): CAPTCHA Turnstile listo en /login, el correo de la sesión en el selector y /auth/comprobar contra el login CSRF, /auth/salir cierra una sesión en conflicto, contacto de soporte en los errores, y 0024/0028 se paran si se aplican al revés. Pendiente de aplicar: 0027 y 0028, en la cola única de la nota de CIM-2. A mano: panel de Supabase (Redirect URLs, plantilla, Confirm email), SUPPORT_EMAIL y APP_URL en Vercel, y SMTP + CAPTCHA en CIM-10; visto bueno de Nicolás al Shell bajado a app/(app)/layout.tsx y a <Marca enMarco /> en shell.tsx. Detalle: apps/web/README.md#autenticación.",
  },
  {
    id: "CIM-9", module: "CIM", owner: "rasheed", size: "S", sprint: 3, deps: ["CIM-3"],
    title: "Términos de servicio y política de privacidad",
    desc: "Texto legal de verdad para /legal, redactado o revisado por alguien que sepa, con el responsable del tratamiento, la base legal, los plazos de conservación y el contacto de datos personales (SUPPORT_EMAIL). Hoy /legal solo dice lo que es cierto y que está pendiente.",
    done: "/legal publica unos términos y una política revisados, y SUPPORT_EMAIL está fijado en producción. Tiene que estar antes del primer cliente que pague.",
    status: "pendiente",
    note: "Abierta en la ronda 4 de CIM-3 (22 de septiembre): los revisores marcaron que la página no se puede poner delante de un cliente que paga. El correo de contacto ya salió de los textos de interfaz a SUPPORT_EMAIL (lib/soporte.ts).",
  },
  {
    id: "CIM-10", module: "CIM", owner: "rasheed", size: "S", sprint: 3, deps: ["CIM-3"],
    title: "SMTP propio y CAPTCHA en /login",
    desc: "El enlace mágico sale de un endpoint público de Supabase y el cupo de correos es por proyecto: un script basta para que nadie pueda entrar. SMTP propio en Supabase y CAPTCHA (Cloudflare Turnstile) exigido por Supabase Auth en cada enlace.",
    done: "Supabase manda con SMTP propio y rechaza un enlace sin token de Turnstile; /login pinta el widget en producción. Antes del primer cliente que pague.",
    status: "bloqueada",
    note: "El código está (pulido r1 de CIM-3): widget en /login y captchaToken hacia Supabase. Espera a una persona: sitio en Cloudflare Turnstile, TURNSTILE_SITE_KEY en Vercel y, después, la clave secreta en Supabase → Attack Protection; y el SMTP propio. Orden en apps/web/README.md, «El límite del correo».",
  },
  {
    id: "CIM-11", module: "CIM", owner: "rasheed", size: "M", sprint: 4, deps: ["CIM-2"],
    title: "Ids sin contador global",
    desc: "Las tablas donde escribe mc_app con id bigserial (audit_log, api_call_log, account_metric_snapshot, deal_stage_history, idea_evidence, preflight_result, video_onscreen_text) dejan inferir por el id de una fila propia cuántas escribió toda la plataforma: el oráculo que 0026 §4 cerró en las secuencias. Una migración propia las pasa a uuid DEFAULT gen_random_uuid(), con sus índices y referencias, y la guardia de esquema lo exige.",
    done: "Ninguna tabla en la que inserta mc_app tiene un id de secuencia global, y la guardia de esquema reporta la próxima que lo intente. Antes del piloto (sprint 5): con clientes reales, cambiar la clave cuesta más.",
    status: "pendiente",
    note: "Abierta en el pulido r7 desde el ABIERTO de CIM-2 (docs/propuestas/CIM-2.md §3) para que no dependa de acordarse. Mientras tanto rige la regla de ese §3: ninguna consulta de @mc/db le devuelve esos ids a la web.",
  },
  {
    id: "CIM-4", module: "CIM", owner: "nicolas", size: "M", sprint: 1, deps: [],
    title: "Marco de la aplicación y navegación",
    desc: "Layout, navegación con los módulos del MVP, los de fase 2 ocultos tras una bandera, tema claro y oscuro, dirección visual minimalista. Cada módulo con su ruta.",
    done: "Se navega entre los módulos, el tema se conserva al recargar, y una bandera apagada quita el módulo del menú.",
    status: "hecho",
    note: "Cerrada el 21 de septiembre: banderas con las llaves de feature_flag y 404 en ruta directa, tokens del mock en globals.css, pruebas con vitest. Las banderas viven en content/flags.ts hasta que exista el cliente de base.",
  },
  {
    id: "CIM-5", module: "CIM", owner: "nicolas", size: "L", sprint: 1, deps: ["CIM-4"],
    title: "Kit de interfaz compartido",
    desc: "Fila de KPIs con delta y sparkline, tabla con «Ver tabla» sobre cada gráfico, gráfico de líneas y de barras con tooltip, estado vacío, aviso «datos hasta el {fecha}», formulario con validación, botón de acción principal.",
    done: "Una página de galería (/kit) muestra cada componente con datos de ejemplo, en claro y oscuro.",
    status: "hecho",
    note: "Cerrada el 21 de septiembre: doce componentes en components/ui con pruebas, utilidades de formato en lib/format.ts y galería /kit detrás de la bandera kit.",
  },
  {
    id: "CIM-6", module: "CIM", owner: "rasheed", size: "S", sprint: 1, deps: ["CIM-2"],
    title: "Seed de ventas y métricas",
    desc: "Ocho empresas, quince deals repartidos por etapa, actividades; cuatro conexiones (una por red), sesenta posts, noventa días de snapshots con curvas verosímiles y una línea base calculada. Idempotente.",
    done: "make seed deja Ventas y Resumen con los mismos números que el mock.",
    status: "hecho",
    note: "Seed 0002 determinista e idempotente cualquier día (8 marcas, 13 señales, 15 deals; 60 videos y 90 días de serie que se rellenan hasta ayer), verificado en Postgres embebido con pnpm turbo run test. Sembrado en Supabase el 22-sep. Pulido r3: negocio en neto y campaña/factura con IVA (verify k2) y seed 0004 de Cotizar (tarifario, media kit, COT-2026-001…008 enlazadas a negocio y campaña). Detalle en docs/propuestas/CIM-6.md §6–§7. Pendiente humano: volver a sembrar tras la cola única de la nota de CIM-2.",
  },
  {
    id: "CIM-7", module: "CIM", owner: "rasheed", size: "S", sprint: 1, deps: ["CIM-1"],
    title: "Despliegue continuo",
    desc: "El repositorio de GitHub conectado al proyecto de Vercel para que cada merge a main publique solo; el worker corre en Railway o Fly con las variables del vault.",
    done: "Un merge a main aparece en la URL sin correr ningún comando.",
    status: "en_curso",
    note: "La web ya despliega con make vercel.deploy PROD=1. Falta conectar GitHub al proyecto de Vercel y desplegar el worker. Variables en Vercel: DATABASE_URL, TOKEN_ENCRYPTION_KEY y APP_URL en production, y DEMO_WORKSPACE_ID (el workspace del seed) añadida el 22 de septiembre en production y preview. Hacía falta: desde la ronda 4 de CIM-2, en producción la web LANZA si falta —mismo criterio que DATABASE_URL en from-env.ts— en vez de servir en silencio un workspace codificado leyendo la Supabase real. Para servir el del seed a propósito, ALLOW_SEED_WORKSPACE=1. Ver docs/base-de-datos.md.",
  },
  {
    id: "CIM-8", module: "CIM", owner: "nicolas", size: "S", sprint: 1, deps: ["CIM-2"],
    title: "Seed de finanzas y campañas",
    desc: "Tres facturas (una vencida), pagos, gastos recurrentes, dos campañas con posts asociados y snapshots de seguidores de la marca. Números tomados del mock. Idempotente.",
    done: "make seed deja Finanzas y Campañas con los mismos números que el mock.",
    status: "hecho",
    note: "Seed 0003 con verificación en Postgres embebido: node db/seed/verify/run.mjs (run-0003.mjs queda como atajo). 0002 ya existe con los ids del contrato de docs/propuestas/CIM-8.md, así que la sección 0 de 0003 (prerrequisitos) queda en no-op; CIM-6 ajustó en 0003 las fechas de Café Alma para una sola línea de tiempo (CIM-6.md §3.10).",
  },

  // ---------------------------------------------------------------- CON
  {
    id: "CON-1", module: "CON", owner: "nicolas", size: "L", sprint: 2, deps: ["CIM-1"],
    title: "Conectores con respuestas grabadas",
    desc: "Cliente para TikTok Display, TikTok Accounts, Instagram Graph y YouTube Data + Analytics. Reintentos, respeto de cuota, registro en api_call_log y api_quota_usage. Fixtures para las pruebas.",
    done: "pnpm test pasa sin red y cada llamada deja su fila en api_call_log.",
    status: "hecho",
    note: "packages/connectors: núcleo HTTP con fetch y reloj inyectables, PlatformApiError (transient/permanent/auth/quota), reintentos con Retry-After, QuotaManager con ventanas y presupuesto diario persistido en api_quota_usage, y clientes de TikTok Display, TikTok Accounts, Instagram (Instagram Login) y YouTube (Data + Analytics) con 62 fixtures sacados de la documentación del 22-sep. El worker expone ctx.connectors y ctx.callLog. Pendiente de CON-9: el portal de la Accounts API no se pudo leer; video_view_retention y engagement_likes quedan sin verificar. platform.limits sigue vacío: JSON propuesto en docs/propuestas/CON-1.md.",
  },
  {
    id: "CON-2", module: "CON", owner: "nicolas", size: "M", sprint: 1, deps: ["CIM-1"],
    title: "Worker arrancado y oauth.refresh",
    desc: "pg-boss sobre la base, job_definition cargado, job_run registrando duración y errores. El job oauth.refresh renueva tokens antes de que venzan. Cada job vive en la carpeta de su módulo.",
    done: "make worker toma un job de la cola, lo registra, y un token con access_expires_at cercano se renueva solo.",
    status: "hecho",
    note: "Verificado contra Postgres embebido con las migraciones reales; la migración 0014 (GRANTs de mc_worker) ya está aplicada en Supabase. Falta que Rasheed corra dos comandos con el token de administración (esquema pgboss y GRANT mc_worker TO mc_migrator), ver docs/propuestas/CON-2.md. Los refreshers reales llegan con CON-3 y CON-8.",
  },
  {
    id: "CON-2b", module: "CON", owner: "nicolas", size: "S", sprint: 2, deps: ["CIM-2", "CON-2"],
    title: "El worker sobre @mc/db",
    desc: "En apps/worker/src/runner/db-pglite.ts y packages/connectors/test/helpers/pglite.ts reemplazar el bucle «aplicar *.sql en orden como superusuario» por applyMigrations(exec) de db/lib/aplicar.mjs u openTestDb de @mc/db/test/pglite, para tener schema_migrations, checksums y el rol mc_app iguales que en Supabase.",
    done: "apps/worker y packages/connectors no definen un bucle de migraciones propio; sus pruebas siguen en verde.",
    status: "pendiente",
    note: "Abierta por Rasheed en la ronda 3 de CIM-2 (22 de septiembre). En la ronda 4 se cerró la parte que sí era un camino de seguridad: apps/worker/src/runner/db.ts importa tlsFor, hostOf y resolveTls de @mc/db y borró sus copias (una línea de montaje en carpeta de Nicolás), con lo que el worker hereda además la guardia contra ?sslmode= en la URL. Queda solo la unificación del bucle de migraciones de PGlite.",
  },
  {
    id: "CON-3", module: "CON", owner: "nicolas", size: "L", sprint: 2, deps: ["CON-1", "CIM-3"],
    title: "OAuth de TikTok e Instagram en sandbox",
    desc: "Callback, cifrado del token con TOKEN_ENCRYPTION_KEY, secret_ref en social_connection, data_consent con la evidencia. Necesita acceso de desarrollador a las apps de TikTok y Meta (lo da Rasheed).",
    done: "Conectar una cuenta de prueba deja la fila con sus scopes y el token no aparece en claro en ninguna tabla.",
    status: "bloqueada",
    note: "Vuelve al MVP el 23-sep como «Autorizar cifras» de TikTok: la cuenta se agrega por @ (CON-10) y el dueño autoriza una vez con este flujo; el callback convierte la misma fila. Se enciende con OAUTH_CONNECT=1 y la app de TikTok en sandbox; para abrirlo a todos, App Review de Login Kit. Código completo y probado con respuestas grabadas: cifrado AES-256-GCM (HKDF, AAD = secret_ref, rotación de clave), tabla connection_secret (migración 0015, RLS en FORCE, aplicada en Supabase el 21-sep), EncryptedSecretStore, OAuth de TikTok Login Kit e Instagram Login (Accounts API detrás de TIKTOK_BUSINESS_APP_ID hasta CON-9), rutas start/callback con cookie sellada de 10 minutos, data_consent con evidencia, pantalla mínima de /conexiones y oauth.refresh con los refreshers reales. La prueba clave vuelca todas las columnas de texto de todas las tablas y no encuentra ningún token. En main y desplegada en producción el 22-sep con TOKEN_ENCRYPTION_KEY y APP_URL en Vercel. Bloqueada solo por la prueba en vivo: falta el acceso de desarrollador a las apps de TikTok y Meta (backlog §9.4 fila 15); el paso a paso está en docs/propuestas/CON-3.md §5.",
  },
  {
    id: "CON-4", module: "CON", owner: "nicolas", size: "M", sprint: 5, deps: ["CON-3", "CIM-5"],
    title: "Pantalla Conexiones",
    desc: "Lista sobre connection_health, botón para conectar cada red, estado (activa, vencida, necesita reautorizar), horas desde la última sincronización, y el paso manual «activa Analytics en TikTok».",
    done: "Una conexión con token vencido se ve en rojo con el botón de reautorizar.",
    status: "pendiente",
    note: "Pospuesta con CON-3 (versión avanzada). La pantalla de cuentas del MVP la trae CON-10.",
  },
  {
    id: "CON-10", module: "CON", owner: "nicolas", size: "L", sprint: 2, deps: ["CON-1"],
    title: "Cuentas por @ con datos públicos",
    desc: "Decisión del 22-sep: sin OAuth por creador en el MVP. Una cuenta se agrega con su @ y se lee cada día con fuentes oficiales: Instagram por business_discovery con el token de la cuenta casa (INSTAGRAM_HOUSE_TOKEN), YouTube con API key (GOOGLE_API_KEY), TikTok solo identidad por oEmbed hasta elegir fuente. Migración 0022 (access_mode public_profile), snapshots en account_metric_snapshot con source public_profile, job collect.account_metrics, pantalla «Agregar cuenta».",
    done: "Agregar un @ deja la fila con su snapshot público del día, el worker la actualiza cada día y ninguna credencial aparece en las tablas.",
    status: "hecho",
    note: "En main el 22-sep. Probado con respuestas grabadas (connectors 180, db 46, worker 31, web 119) y con el volcado de todas las columnas de texto sin credenciales. Comprobado desde servidor que el HTML público de TikTok e Instagram no sirve (reto anti-bot y muro de login): por eso solo fuentes oficiales. Para la prueba real faltan dos configuraciones de Nicolás: INSTAGRAM_HOUSE_TOKEN (token de su cuenta profesional, generado en el App Dashboard de Meta) y GOOGLE_API_KEY; TikTok se agrega ya, sin métricas; el 23-sep se decidió que el dueño las desbloquea con «Autorizar cifras» (OAuth de CON-3, gratis), no con CSV; el proveedor de pago queda como opción futura (CON-12). collect.account_metrics también lee las cuentas autorizadas con su token. Detalle en docs/propuestas/CON-10.md.",
  },
  {
    id: "CON-12", module: "CON", owner: "nicolas", size: "M", sprint: 5, deps: ["CON-10"],
    title: "Proveedor de datos de TikTok (opción futura)",
    desc: "Seguidores, vistas y videos de TikTok por @ a través de un proveedor de pago (Apify, EnsembleData o Phyllo) sobre la interfaz PublicProfileSource de CON-10, con access_mode = aggregator. Solo si el CSV de TikTok Studio (RES-2) se queda corto o la fricción de subir archivos frena a los creadores.",
    done: "Agregar un @ de TikTok deja seguidores y vistas del día sin que el creador suba nada; el costo mensual del proveedor está aprobado y anotado.",
    status: "pendiente",
    note: "Decisión del 22-sep: por ahora TikTok va por CSV gratuito (RES-2). Esta historia se abre solo si hace falta; no bloquea nada.",
  },
  {
    id: "CON-5", module: "CON", owner: "nicolas", size: "L", sprint: 3, deps: ["CON-1", "CON-2"],
    title: "Recolector de posts y métricas",
    desc: "collect.posts descubre videos nuevos; collect.post_metrics y collect.account_metrics guardan el snapshot con age_hours. Append-only.",
    done: "Dos corridas seguidas producen dos filas por post y post_metrics_daily_delta muestra el crecimiento.",
    status: "pendiente",
  },
  {
    id: "CON-6", module: "CON", owner: "nicolas", size: "M", sprint: 3, deps: ["CON-5"],
    title: "Línea base y puntaje",
    desc: "compute.baseline (mediana por red y corte de edad) y compute.post_score. Con menos de ocho videos, is_reliable = false. Usa packages/core/scoring.ts, que ya existe.",
    done: "Un post con el doble de views que la mediana queda con outlier_tier = outlier.",
    status: "pendiente",
  },
  {
    id: "CON-7", module: "CON", owner: "nicolas", size: "M", sprint: 5, deps: ["CON-5"],
    title: "Demografía de audiencia",
    desc: "collect.demographics por cuenta, respetando metric_requirement: si falta un prerrequisito, lo explica en vez de dejar la celda vacía.",
    done: "Con la respuesta grabada, la tabla coincide con el fixture; con una cuenta personal de TikTok, dice por qué no hay demografía.",
    status: "pendiente",
  },
  {
    id: "CON-8", module: "CON", owner: "nicolas", size: "M", sprint: 5, deps: ["CON-3"],
    title: "OAuth de YouTube",
    desc: "Mismo flujo que CON-3 para un canal de prueba.",
    done: "Conectar un canal de prueba deja la fila con sus scopes y el token cifrado.",
    status: "pendiente",
    note: "Pospuesta con CON-3. En el MVP YouTube se lee por @ con API key (CON-10).",
  },
  {
    id: "CON-9", module: "CON", owner: "rasheed", size: null, sprint: 1, deps: [],
    title: "Trámites de plataforma",
    desc: "Formulario de Accounts API de TikTok, App Review + Business Verification de Meta, auditoría de Google. No es código: es el camino crítico, y lo hace quien tiene las cuentas de empresa. Se inicia el día 1.",
    done: "Los tres iniciados en la semana 1, con fecha y número de caso en docs/tramites.md.",
    status: "pendiente",
  },

  // ---------------------------------------------------------------- RES
  {
    id: "RES-1", module: "RES", owner: "rasheed", size: "L", sprint: 2, deps: ["CIM-5", "CIM-6"],
    title: "Pantalla Resumen",
    desc: "Los cuatro KPIs (seguidores, views en 30 días, alcance en no seguidores, guardados por mil), seguidores por red en 90 días, views por semana y red en 12 semanas. Filtro por red. Aviso «datos hasta el {fecha}» por conexión.",
    done: "Con el seed, la pantalla coincide con el mock; con una conexión sin datos, muestra el estado vacío y no un cero.",
    status: "hecho",
    note: "Pantalla real con toda la aritmética en SQL: KPIs con delta y sparkline (las explicaciones, detrás de un (i)), seguidores por día y visualizaciones en 12 semanas como el mock, frescura por conexión y vacío en vez de ceros. Sin comparación bajo 3 videos. Detalle en docs/fases-rasheed.md §8. Pendiente humano: el visto bueno de Nicolás a Kpi.deltaText y BarChart.axisLabels (rama rasheed/kit-axislabels-deltatext).",
  },
  {
    id: "RES-2", module: "RES", owner: "rasheed", size: "M", sprint: 2, deps: ["CIM-5"],
    title: "Importación por CSV",
    desc: "El creador exporta desde TikTok Studio, Instagram Insights o YouTube Studio y sube el archivo; se convierte en snapshots con source = csv_import. Es la vía mientras no hay aprobaciones.",
    done: "Un CSV real de Instagram Insights llena post_metric_snapshot y aparece en Resumen.",
    status: "hecho",
    note: "Asistente de 4 pasos en /resumen/importar: guarda con la fecha de exportación y nunca hacia atrás (el paso 3 ya avisa qué no se guardará), lee Windows-1252 y no duplica una cuenta que ya existe. El mapeo manual es el camino: ninguna plataforma documenta su cabecera (docs/fases-rasheed.md §8). Pulido r4: el paso 3 cuenta solo las filas con algo nuevo y, con cero, el botón dice «No hay nada nuevo que importar»; la columna Video tiene ancho mínimo y cada aviso es una pastilla bajo el título. Pulido r8: esas pastillas parten la frase a 400 px.",
  },
  {
    id: "RES-5", module: "RES", owner: "rasheed", size: "S", sprint: 3, deps: ["RES-1", "CIM-5"],
    title: "Visualizaciones por semana, como el mock",
    desc: "El gráfico de barras de Resumen en semanas (las 12 del mock) en vez de bloques de 1, 5 o 10 días. Hoy no cabe: 12 × 7 = 84 días no cuadra con el KPI de 90 y la rejilla de etiquetas de BarChart (cada ceil(n/8) y además la última) pisa las dos últimas con 12 barras.",
    done: "Con el seed, 12 barras semanales con todas sus etiquetas legibles a 400 px y el total de las barras igual a la tarjeta del periodo que cubren.",
    status: "hecho",
    note: "12 semanas de 7 días hacia atrás desde el último día cerrado, sin depender del periodo (la tarjeta dice que no es su suma). La etiqueta que chocaba se deja vacía con axisLabels: no hizo falta tocar el kit otra vez.",
  },
  {
    id: "RES-6", module: "RES", owner: "rasheed", size: "S", sprint: 3, deps: ["RES-2"],
    title: "La importación con su propio límite de tamaño",
    desc: "Mover la escritura de la importación por CSV de la server action a un route handler POST con su propio techo de 6 MB, y devolver serverActions.bodySizeLimit al valor de Next (1 MB): hoy ese techo es global y sube el de todas las server actions de la app.",
    done: "Un CSV de 5 MB se importa; un POST de 2 MB a cualquier otra server action se rechaza.",
    status: "hecho",
    note: "POST /resumen/importar/lote con techo propio (contador, 413) y Origin contra Host; next.config vuelve al 1 MB de las server actions. Probado en lote.test.ts.",
  },
  {
    id: "RES-3", module: "RES", owner: "rasheed", size: "M", sprint: 5, deps: ["CON-6", "VEN-4", "FIN-4"],
    title: "Lo que importa esta semana",
    desc: "Lista generada desde los datos: outliers nuevos, conexión con error, factura vencida, deal con seguimiento vencido. Lee notification.",
    done: "Las cuatro fuentes producen su fila y cada una lleva a su módulo.",
    status: "pendiente",
  },
  {
    id: "RES-4", module: "RES", owner: "rasheed", size: "S", sprint: 6, deps: ["CON-7"],
    title: "Demografía y cuándo publicar, en pantalla",
    desc: "El bloque de audiencia por edad, género y país, y el de «cuándo publicar» (seguidores conectados por hora, Instagram), sobre lo que recolecta CON-7.",
    done: "El gráfico por hora coincide con el fixture; si la cuenta no da demografía, la pantalla explica por qué.",
    status: "pendiente",
    note: "Corrida del sprint 5 al 6 el 22-sep para hacerle sitio a ACC-4: depende de CON-7, que a su vez depende de aprobaciones que pueden no llegar.",
  },

  // ---------------------------------------------------------------- VEN
  {
    id: "VEN-1", module: "VEN", owner: "rasheed", size: "M", sprint: 1, deps: ["CIM-2", "CIM-5"],
    title: "Empresas y contactos",
    desc: "Crear, editar, buscar por nombre (el índice trigram ya existe), company_link con relationship y dueño. Un contacto exige source; sin procedencia no se guarda.",
    done: "Se crea una empresa con dos contactos y aparece en la búsqueda al tercer carácter.",
    status: "hecho",
    note: "Empresas con búsqueda sin tildes, ficha y contactos con procedencia y baja de una sola dirección. Pulido r5: «Editar» empresa y contactos, responsable elegible, país por su nombre. Pulido r6: el país se elige de una lista ISO (Select, _lib/paises.ts; «XX» ya no pasa) y borrar la búsqueda bajo tres letras vuelve a la lista entera. Pulido r7: un nombre ya en el CRM avisa con «Crear igual»; las fichas (empresa, cotización, media kit) tienen esqueleto y siguen dando 404 de verdad (layout.tsx comprueba el id). Pulido r8: la lista no desborda a 400 px con empresas vacías; «Crear igual» vale solo para el nombre del aviso; la pestaña de la ficha dice la empresa. Pendiente humano: la cola única de la nota de CIM-2 y visto bueno de Nicolás a los loading.tsx de campanas/ y conexiones/.",
  },
  {
    id: "VEN-2", module: "VEN", owner: "rasheed", size: "M", sprint: 1, deps: ["VEN-1"],
    title: "Radar manual y por CSV",
    desc: "Bandeja de signal con estado pendiente, aceptar (crea o actualiza empresa y deal en nuevo) o descartar con motivo. Fuente manual y carga por CSV de una lista de marcas. Las fuentes automáticas quedan para fase 2.",
    done: "Aceptar una señal crea el deal con «Enviar pitch» como siguiente acción; descartarla la saca de la bandeja y no vuelve a entrar (dedupe_key).",
    status: "hecho",
    note: "Anotar una marca y cargar una lista (CSV UTF-8 o Windows-1252); una marca pendiente o descartada no vuelve a entrar; aceptar reutiliza la empresa y su negocio abierto; «Enviar pitch» a las 15:00 locales. Pulido r5: el CSV entiende el país por su nombre; el pitch se reconoce por deal.next_action_kind (0032). Pulido r6: formulario y CSV validan el país contra la misma lista ISO. Pulido r7: «Enviar pitch» a tres días hábiles, como el seguimiento; recargar una lista no avisa de filas que no entraron. Pulido r8: la tarjeta dice «Ya en tu CRM» y a qué negocio abierto se sumará. Pendiente humano: la cola única de la nota de CIM-2 (0031–0033 incluidas).",
  },
  {
    id: "VEN-3", module: "VEN", owner: "rasheed", size: "L", sprint: 2, deps: ["VEN-1"],
    title: "Pipeline kanban y lista",
    desc: "Tablero por etapa y vista de lista sobre deal_pipeline. Arrastrar cambia la etapa y escribe deal_stage_history con los días en la etapa. KPIs: deals abiertos, cierre ponderado, ganado en el trimestre.",
    done: "Mover un deal a «Ganado» fija won_at; el cierre ponderado cambia al mover entre etapas.",
    status: "hecho",
    note: "Tablero con arrastrar y soltar, «Mover a», lista y KPI desde SQL; una sola transición de etapa (deal_move_stage, 0031). Pulido r5: pasar a «Perdido» pide el motivo. Pulido r6: perder un negocio cierra sus cotizaciones enviadas o vistas (deal_move_stage, 0031) y el aviso lo dice; la marca ya no lo gana desde el enlace. Pulido r7: ganar un negocio sin monto lo pide en la tarjeta (AmountRequired) y el KPI dice «N cerrados, M sin monto». Pulido r8: el foco va al monto al ganar; moverNegocio valida sus opciones con zod. Pendiente humano: la cola única de la nota de CIM-2 (0031–0033 incluidas).",
  },
  {
    id: "VEN-4", module: "VEN", owner: "rasheed", size: "M", sprint: 3, deps: ["VEN-3", "CON-2"],
    title: "Siguiente acción y seguimientos",
    desc: "Cada deal abierto tiene acción, fecha y responsable. Lista «vencidos hoy» arriba del pipeline. El job ventas/seguimientos.ts crea la notification de tipo deal_due y deal_overdue cada mañana.",
    done: "Un deal sin siguiente acción se ve marcado; uno vencido aparece en la lista y en la campana.",
    status: "pendiente",
  },
  {
    id: "VEN-5", module: "VEN", owner: "rasheed", size: "L", sprint: 3, deps: ["VEN-3"],
    title: "Ficha de empresa",
    desc: "Cabecera, contactos, línea de tiempo de activity (nota, correo, llamada, reunión, cambio de etapa), «lo que sabemos» (señales), y la cadena deal → cotización → campaña → factura con enlaces.",
    done: "Registrar una llamada la pone en la línea de tiempo y actualiza last_contact_at.",
    status: "pendiente",
  },
  {
    id: "VEN-6", module: "VEN", owner: "rasheed", size: "M", sprint: 4, deps: ["COT-2", "VEN-5"],
    title: "Pitch manual con afirmaciones trazables",
    desc: "Borrador de correo a partir de la señal, el media kit y la última campaña, editado a mano. Cada cifra apunta a su origen en claims. Se guarda como outbound_touch en draft y se copia al portapapeles. La generación automática y el envío los hace VEN-12 sobre esta misma base.",
    done: "Un pitch con una cifra sin origen no se puede marcar como listo.",
    status: "pendiente",
  },
  {
    id: "VEN-7", module: "VEN", owner: "rasheed", size: "S", sprint: 6, deps: ["VEN-2"],
    title: "Brief de outbound",
    desc: "Qué busca el creador (categorías, países, presupuesto mínimo, entregables) y qué no acepta. Filtra la bandeja del radar.",
    done: "Una señal de una categoría excluida no aparece en la bandeja.",
    status: "pendiente",
    note: "Corrida del sprint 5 al 6 el 22-sep para hacerle sitio a ACC-4: es S y no es parte del ciclo que se demuestra.",
  },
  {
    id: "VEN-8", module: "VEN", owner: "rasheed", size: "S", sprint: 6, deps: ["VEN-3"],
    title: "Deal perdido y conversión por etapa",
    desc: "Motivo de pérdida, y tasa de conversión por etapa desde deal_stage_history.",
    done: "La tasa entre etapas aparece en el pipeline con el número de deals que la sostiene.",
    status: "pendiente",
    note: "Corrida del sprint 5 al 6 el 22-sep para hacerle sitio a ACC-4: es S y no es parte del ciclo que se demuestra.",
  },
  // Outreach automático. Diseño en docs/ventas-outreach.md, a partir de CadenceV1.0.
  {
    id: "VEN-9", module: "VEN", owner: "rasheed", size: "L", sprint: 4, deps: ["CIM-2", "CIM-3"],
    title: "Canales de outreach",
    desc: "Migración 0015 con las tablas de outreach, conector de Unipile con hosted auth y webhook firmado para LinkedIn e Instagram, OAuth de Google con gmail.send y gmail.modify, pantalla de canales con estado y límites, keepalive diario del token.",
    done: "Un creador conecta su Gmail y su LinkedIn; el token de Google se refresca solo; una cuenta caída se ve en rojo con el botón de reconectar.",
    status: "pendiente",
  },
  {
    id: "VEN-10", module: "VEN", owner: "rasheed", size: "L", sprint: 4, deps: ["VEN-9", "CON-2"],
    title: "Motor de cadencias",
    desc: "Pasos normalizados, enrolamiento, cola en outbound_touch con reclamo atómico, despachador por canal con interfaz común, días hábiles y zona horaria del workspace, límites diarios y semanales, reintentos con espera creciente, interruptor de apagado, cancelación al responder con relectura del estado antes de enviar.",
    done: "Una secuencia de tres pasos con plantillas fijas se ejecuta sola contra un buzón de prueba; una respuesta cancela lo pendiente; el límite diario reprograma al día siguiente.",
    status: "pendiente",
  },
  {
    id: "VEN-11", module: "VEN", owner: "rasheed", size: "M", sprint: 5, deps: ["CON-6", "COT-1"],
    title: "Perfil comercial del creador",
    desc: "Identidad, audiencia, desempeño (mediana y mejores videos con su porqué), formatos, prueba social de campañas reportadas y tarifas, más una narrativa generada cuyas cifras enlazan a su origen. Es el análisis del perfil y los videos del creador que alimenta el outreach.",
    done: "Con el seed, el perfil muestra los cinco mejores videos con sus cifras y cada cifra de la narrativa lleva a su origen.",
    status: "pendiente",
  },
  {
    id: "VEN-12", module: "VEN", owner: "rasheed", size: "L", sprint: 5, deps: ["VEN-10", "VEN-11"],
    title: "Generación con afirmaciones trazables",
    desc: "Generador con perfil del creador, señal de la marca, ángulo del día y toques realmente enviados; pre-vuelo determinista, juez con rúbrica por paso en tabla, regeneración con pistas cerradas, disparadores de riesgo y revisión humana con calentamiento por tipo de paso.",
    done: "Un mensaje con una cifra sin origen no pasa; dos marcas del mismo nicho reciben correos con similitud menor de 0,65; el juez registra nota, tokens y costo.",
    status: "pendiente",
  },
  {
    id: "VEN-13", module: "VEN", owner: "rasheed", size: "M", sprint: 5, deps: ["VEN-12"],
    title: "Recomendador de cadencia",
    desc: "Desde el brief, la señal, los canales conectados y los contactos disponibles, una secuencia propuesta con día, canal, ángulo y guía por paso; plantillas por nicho y tipo de señal; línea de tiempo editable.",
    done: "Desde una señal de campaña activa, el creador obtiene una secuencia de seis pasos con guía y la activa en dos clics.",
    status: "pendiente",
  },
  {
    id: "VEN-14", module: "VEN", owner: "rasheed", size: "L", sprint: 5, deps: ["VEN-12"],
    title: "Bandeja de aprobación y bandeja unificada",
    desc: "Aprobar, editar o regenerar lo propuesto; hilos de correo, LinkedIn e Instagram en un solo lugar; clasificación de la intención de la respuesta (interesado, ahora no, fuera de oficina, baja, referido) y su efecto en el deal y el enrolamiento.",
    done: "Un mensaje retenido se aprueba desde la bandeja y sale; una respuesta «me interesa» mueve el deal y aparece en la bandeja con la conversación completa.",
    status: "pendiente",
  },
  {
    id: "VEN-15", module: "VEN", owner: "rasheed", size: "M", sprint: 4, deps: ["VEN-10"],
    title: "Entregabilidad y cumplimiento",
    desc: "Pie de baja con página pública, cabecera List-Unsubscribe de un clic, rebotes asíncronos, calentamiento progresivo por cuenta, baja respetada en todos los canales, alertas diarias por correo.",
    done: "Un clic en el enlace de baja marca al contacto y cancela todo; un rebote marca el correo inválido; el día siguiente llega el resumen de salud.",
    status: "pendiente",
  },
  {
    id: "VEN-16", module: "VEN", owner: "rasheed", size: "M", sprint: 5, deps: ["VEN-10"],
    title: "Actividad y métricas de outreach",
    desc: "Cola visible con reintento por tipo, uso por canal con límite blando y duro, embudo por paso (enviados, abiertos, respondidos, positivos), vista de flujo de la cadencia.",
    done: "Con una semana de envíos de prueba, el embudo cuadra con outbound_touch fila a fila.",
    status: "pendiente",
  },

  // ---------------------------------------------------------------- COT
  {
    id: "COT-1", module: "COT", owner: "rasheed", size: "M", sprint: 3, deps: ["CIM-2"],
    title: "Tarifario sugerido",
    desc: "packages/core/tarifas.ts calcula el rango por entregable desde views promedio × CPM de niche_cpm_benchmark, con modificadores (derechos de uso, exclusividad). Las views vienen de creator_baseline si existe y es confiable; si no, el creador las escribe y quedan marcadas como manuales.",
    done: "Con las views del mock salen los rangos del mock; cambiar el CPM cambia el rango y la explicación lo dice. Cambio del criterio: sin los modificadores de engagement y audiencia del mock, que no tienen fuente; ver tarifas.ts.",
    status: "hecho",
    note: "Rango por entregable y paquetes con la fórmula de packages/core/src/tarifas.ts, la misma en la pantalla y al guardar; «Cómo se calcula» bajo su fila, precio y CPM a mano marcados, rango al revés bloqueado en todas las capas (más un CHECK en 0030). Pulido r1: guardar ya no desmarca las casillas de condiciones y paquetes (sin el reinicio de <form action>); los modificadores quedan en cada entregable y paquete (RateCardItem.modifierIds); los campos vacíos muestran «p. ej. 25.000» o «CPM bajo» en vez de «0»; queries/cotizar partido por pieza sin cambiar su API. Pulido r2: a 400 px cada entregable es una tarjeta (rango, views y CPM apilados, sin scroll lateral). Pulido r3: tarifas.test.ts fija los rangos con las views del mock (Reel 92 K, TikTok 138 K). Pulido r4: en Paquetes el nombre de cada entregable se lee entero y es la etiqueta de su casilla; un CPM propio al revés se marca en sus campos y no se guarda (antes el entregable salía del tarifario en silencio). Pulido r6: el rango se propone a tres cifras (redondearParaNegociar; el exacto queda en «Sin redondear») y el país del CPM va por su nombre.",
  },
  {
    id: "COT-2", module: "COT", owner: "rasheed", size: "M", sprint: 3, deps: ["COT-1", "RES-1"],
    title: "Media kit público",
    desc: "Foto congelada de los números en media_kit.snapshot, página pública por slug, opcional con contraseña y vencimiento. Contador de vistas.",
    done: "El enlace abre sin sesión, muestra las cifras congeladas, y no cambia aunque cambien las métricas.",
    status: "hecho",
    note: "/kit/<slug> sin sesión sobre public_media_kit() (0030, rol mc_public_share). Contraseña de 8+ signos guardada como huella; bloqueo de 15 min tras 10 fallos por origen (IP resumida) y 50 por enlace, visible y deshacible desde /cotizar/media-kit (pulido r5); el freno de 5 por minuto del servidor es por instancia y de mejor esfuerzo (documentado en 0030 y el README). Vista previa y robots no cuentan visitas. Pulido r1: bajo las tarifas dice qué condiciones ya incluyen los rangos; la pastilla de red no se estira; la hora del bloqueo sale de lib/format.ts; la lista distingue por hora. Pulido r2: un enlace inexistente responde 404 de verdad (sin loading.tsx en (public), con prueba). Pulido r3: el «N× su mediana» se calcula al congelar contra la mediana publicada de su red; a 400 px las cifras por red van en tres columnas; «Vence el» con anillo de foco. Pulido r6: al saltar el techo del enlace el creador recibe un aviso con «Desbloquear» (notification media_kit_locked). Pulido r7: la pestaña dice «Media kit · <creador>» solo con el kit abierto, con una sola lectura por petición (la visita no se cuenta dos veces). Pulido r8: el kit del seed 0004 ya no se contradice: «N×» contra la mediana que publica y tarifas redondeadas de @mc/core, exigido por verify/0004.sql y una prueba.",
  },
  {
    id: "COT-3", module: "COT", owner: "rasheed", size: "L", sprint: 4, deps: ["COT-1", "VEN-3"],
    title: "Cotización",
    desc: "Crear desde un deal, ítems desde el tarifario, subtotal, descuento, impuesto y total. Lo que se acuerda antes de publicar: métricas a reportar, cortes (24 h, 7 d, 30 d), derechos, exclusividad, plazo de pago. Numeración COT-2026-014.",
    done: "Enviar pasa el deal a «Propuesta enviada»; la cotización tiene su enlace público.",
    status: "hecho",
    note: "Ciclo draft → sent → viewed → accepted/rejected/expired con una fecha por estado y transiciones con la fila bloqueada; entregables del tarifario, impuesto del workspace, numeración COT-AAAA-NNN. Pulido r1: elegir un entregable cuyo precio cobra exclusividad o derechos sube esos días en «Lo acordado» y lo dice en la línea (createQuote hace lo mismo si no se le pasan); preselecciona el media kit más reciente sin contraseña y avisa si el elegido la tiene; el detalle cabe a 400 px (total de la línea siempre visible, historia en el mismo dibujo) y oculta «Válida hasta» cuando ya está cerrada. Pulido r2: sin tarifario guardado, el formulario lo dice y enlaza a /cotizar; «enlace copiado» sale una sola vez (se limpia ?enviada). Pulido r3: no encontrado propio («Volver a Cotizaciones»); las fechas enseñan anillo de foco con Tab. Pulido r6: la nueva arranca sin derechos de uso (los sube solo un entregable que los cobra) y el precio propuesto va a tres cifras; enviar deja sin efecto las demás versiones vivas del negocio (0033). Pulido r7: eso se avisa antes (ayuda del campo Negocio y aviso en el borrador) y enviar pide confirmación; una rechazada, vencida o sin efecto ya no ofrece copiar su enlace; títulos de pestaña en messages.ts y la de la marca con «COT-AAAA-NNN · <creador>».",
  },
  {
    id: "COT-4", module: "COT", owner: "rasheed", size: "M", sprint: 4, deps: ["COT-3", "CAM-2"],
    title: "Aceptación crea la campaña",
    desc: "Al marcar aceptada, llama a createCampaignFromQuote() de queries/campanas.ts (la escribe Nicolás en CAM-2) y pasa el deal a «Ganado». Es el punto de cruce entre las dos cadenas.",
    done: "Aceptar una cotización deja una campaña en planned y Nicolás la ve en su módulo sin tocar nada.",
    status: "hecho",
    note: "Aceptar crea la campaña de CAM-2 sin segundo clic, desde el panel (misma transacción, con SAVEPOINT si faltan fechas) y desde el enlace con firma; aviso al creador y la marca que llega tarde lee qué pasó. Pendiente humano: mc_public_share y 0030–0033, en la cola única de la nota de CIM-2. Pulido r2 (desde Ventas): enviar y aceptar fijan en el negocio el monto neto de la cotización y lo mueven con deal_move_stage (0031). Pulido r3: aceptar (panel o enlace) hace cliente a la marca; prueba de negocio = neto y campaña = total. Pendiente humano: visto bueno de Nicolás a «Total con impuesto» en /campanas. Pulido r6: una aceptada por negocio, desde el panel y desde el enlace (0033: DealAlreadyAccepted / «sin efecto»); pendiente humano aplicar 0033 con la cola única de la nota de CIM-2. Pulido r7: quien recarga el enlace de una aceptada lee «Aceptada por <nombre> el <fecha>», no «a tu nombre».",
  },

  // ---------------------------------------------------------------- CAM
  {
    id: "CAM-1", module: "CAM", owner: "nicolas", size: "M", sprint: 2, deps: ["CIM-5", "CIM-6"],
    title: "Lista y ficha de campaña",
    desc: "Estado, entregables, fechas, posts asociados (elegidos a mano de creator_post_board o detectados por fecha y mención), código y enlace de seguimiento. Desde la ficha se crea la factura (FIN-1).",
    done: "Se asocian dos posts a una campaña y aparecen con sus views actuales.",
    status: "hecho",
    note: "Lista con filtro por estado y ficha con lo acordado, entregables, seguimiento, posts asociados (sugeridos por fecha y mención, o buscados), transiciones y «Facturar» (FIN-1). Dejó para CAM-2 la máquina de estados, assertCampaignDates y brandBaselineFrom en core, y getCampaign leyendo lo acordado desde quote. Conexión provisional compartida en lib/db: docs/propuestas/CAM-1.md.",
  },
  {
    id: "CAM-2", module: "CAM", owner: "nicolas", size: "S", sprint: 2, deps: ["CAM-1"],
    title: "Crear campaña desde la cotización",
    desc: "createCampaignFromQuote() en queries/campanas.ts: crea la campaña con quote_id, agreed_metrics, fechas y brand_baseline_from catorce días antes. Es el contrato con Cotizar: Rasheed la llama desde COT-4.",
    done: "Rasheed la usa en COT-4 sin pedir cambios.",
    status: "hecho",
    note: "Lista para COT-4: createCampaignFromQuote(tx, { quoteId, startsOn, endsOn, name?, trackingCode? }) en @mc/db, idempotente con bloqueo consultivo, RLS y errores tipados con messageEs. Contrato, ejemplo de uso y prueba conjunta del lunes del sprint 4 en docs/propuestas/CAM-2.md.",
  },
  {
    id: "CAM-3", module: "CAM", owner: "nicolas", size: "M", sprint: 4, deps: ["CON-1", "CON-2"],
    title: "Seguidores de la marca",
    desc: "brand.snapshot diario del perfil público de la marca (Business Discovery en Instagram, canal en YouTube), desde brand_baseline_from.",
    done: "La curva de seguidores de la marca sale del snapshot con su línea base de dos semanas.",
    status: "hecho",
    note: "Rama nicolas/CAM-3-seguidores-marca. ritmoSeguidores en core (seed: 12,93/día vs 155/día, ×12, 1 240 ganados; línea base corta marcada, nunca inventada), job brand.snapshot en apps/worker/src/jobs/campanas (idempotente por día, TikTok y handles inexistentes dejan la razón), sección de la ficha con curva, «×12 el ritmo» y «Actualizar ahora». Falta aplicar la migración 0035 (unicidad por campaña e INSERT de la web) y el worker desplegado (CIM-7) para la lectura diaria en producción. Detalle en docs/propuestas/CAM-3.md.",
  },
  {
    id: "CAM-4", module: "CAM", owner: "nicolas", size: "S", sprint: 4, deps: ["CAM-1"],
    title: "Lo que aporta la marca",
    desc: "Canjes del código, pedidos, ingresos, por formulario o CSV, en campaign_brand_input.",
    done: "Subir un CSV de ventas diarias llena la tabla y aparece en la ficha.",
    status: "hecho",
    note: "Sección «Lo que aportó la marca» en la ficha: tabla por concepto (último total del formulario o suma del CSV, calculado en SQL), ventas diarias en barras, «Registrar aporte» e «Importar CSV de ventas» con el resumen de filas aceptadas y rechazadas. La fuente decide la semántica (formulario = total a la fecha, CSV = diario); repetir el CSV no duplica; una campaña cerrada lo rechaza; cada alta deja audit_log desde queries/campanas.ts hasta que exista audit() (ACC-2). Sin migraciones; el índice único de la clave natural y el contrato de lectura para CAM-5 están en docs/propuestas/CAM-4.md.",
  },
  {
    id: "CAM-5", module: "CAM", owner: "nicolas", size: "M", sprint: 4, deps: ["CAM-3", "CAM-4", "CON-6"],
    title: "Resultado de campaña",
    desc: "campaign.compute llena campaign_result con views, alcance, clics, canjes, seguidores ganados por la marca frente a su ritmo previo, CPM y CPA reales, y views_vs_median. missing_inputs dice qué falta.",
    done: "Los seis KPIs salen de la tabla; si no hay datos de la marca, la celda dice «sin datos de la marca», no cero.",
    status: "hecho",
    note: "calcularResultado (core, pura) con corte común (720 h o el mayor que todos alcanzaron), vs mediana ponderado por views, seguidores de la marca con ritmoSeguidores (CAM-3), canjes e ingresos de CAM-4 (manda el CSV) y CPM/CPA en centavos. Job campaign.compute cada mañana para live/measuring/reported como mc_worker con workspace explícito; «Resultado» en la ficha con los seis KPIs de campaign_result y «Falta: …» con enlace. El seed recalculado da CPM 4.353,93 y CPA 9.748,43 (no los del mock). «Recalcular» espera el GRANT de docs/propuestas/CAM-5.md §2: mc_app solo lee campaign_result desde 0025. Rama encadenada sobre CAM-4.",
  },
  {
    id: "CAM-6", module: "CAM", owner: "nicolas", size: "L", sprint: 4, deps: ["CAM-5"],
    title: "Reporte a la marca",
    desc: "Página pública por slug con el payload congelado, «acordado antes de publicar» arriba, envío por enlace o PDF, sent_at y viewed_at. Registra activity de tipo report_sent.",
    done: "El reporte enviado no cambia aunque lleguen snapshots nuevos; la marca lo abre sin sesión.",
    status: "pendiente",
  },

  // ---------------------------------------------------------------- FIN
  {
    id: "FIN-1", module: "FIN", owner: "nicolas", size: "M", sprint: 1, deps: ["CIM-2", "CIM-5"],
    title: "Facturas",
    desc: "Crear desde una campaña o a mano, con subtotal, IVA, retención en la fuente, total, fecha de emisión y vencimiento, numeración por workspace. Estados draft → sent → partial/paid → overdue. Campo para el número de la factura electrónica DIAN.",
    done: "Una factura creada desde una campaña trae nombre, empresa y monto sin escribirlos.",
    status: "hecho",
    note: "Lista con KPIs, formulario con total en vivo, detalle con Marcar enviada y Anular, y facturarCampana() para el botón «Facturar» de CAM-1. Desde CIM-2 usa @mc/db (withWorkspace de lib/db) y la costura lib/workspace/current.ts; el workspace de sesión llega con CIM-3. Propuesta original: docs/propuestas/FIN-1.md.",
  },
  {
    id: "FIN-2", module: "FIN", owner: "nicolas", size: "M", sprint: 3, deps: ["FIN-1"],
    title: "Pagos y reserva de impuestos",
    desc: "Registrar un pago contra una factura (parcial o total), método y referencia. Actualiza paid_amount, status y paid_at. Crea tax_reserve con el porcentaje configurado del workspace.",
    done: "Registrar un pago parcial deja la factura en partial; el total la pasa a paid y aparta el impuesto.",
    status: "hecho",
    note: "Sección «Pagos» en el detalle: lista de cobros con lo que cada uno apartó y formulario con el saldo sugerido. applyPayment, taxReserveFor y reservePeriod en core (sin sobrepagos en el MVP); recordPayment escribe cobro, factura, apartado, bitácora y aviso en UNA transacción. La tasa se guarda en cada apartado, así que FIN-8 podrá cambiarla sin tocar los anteriores; un espacio sin reserva_pct cobra igual y lo dice. Un doble envío no registra dos pagos: el formulario lleva el paid_amount que vio y la consulta lo compara con FOR UPDATE tomado. Sin migraciones. ACC-1 y ACC-2 entraron a main durante la historia y ya se usan: la acción abre con requirePermission('finanzas.pago.registrar') y recordPayment llama a audit(); una prueba de punta a punta comprueba que el rol Mánager no puede cobrar y no deja ni pago ni bitácora. Propuesta: docs/propuestas/FIN-2.md.",
  },
  {
    id: "FIN-3", module: "FIN", owner: "nicolas", size: "M", sprint: 3, deps: ["FIN-1"],
    title: "Cuentas por cobrar",
    desc: "Tabla sobre receivables con aging_bucket, y los cuatro KPIs: por cobrar, vencido, cobrado en el año, apartado para impuestos.",
    done: "Con el seed, coincide con el mock; la factura vencida sale en rojo con sus días.",
    status: "pendiente",
  },
  {
    id: "FIN-4", module: "FIN", owner: "nicolas", size: "M", sprint: 5, deps: ["FIN-1", "CON-2"],
    title: "Recordatorios de cobro",
    desc: "Job finanzas/recordatorios.ts que, a los 7 días antes, el día y a los 7, 21 y 45 después del vencimiento, redacta el correo, lo guarda como notification de tipo invoice_overdue y lo deja listo para copiar. Envío automático real en fase 2.",
    done: "Una factura vencida hace 41 días tiene sus tres recordatorios en la bandeja con reminders_sent = 3.",
    status: "pendiente",
  },
  {
    id: "FIN-5", module: "FIN", owner: "nicolas", size: "S", sprint: 3, deps: ["CIM-5"],
    title: "Gastos",
    desc: "Registro con categoría, proveedor, monto, fecha, recurrente o no, foto del recibo en S3, deducible. Lista por mes.",
    done: "Un gasto recurrente aparece proyectado en las ocho semanas siguientes.",
    status: "pendiente",
  },
  {
    id: "FIN-6", module: "FIN", owner: "nicolas", size: "M", sprint: 4, deps: ["FIN-2", "FIN-5", "VEN-3"],
    title: "Flujo de caja proyectado",
    desc: "packages/core/flujo-caja.ts combina cobros esperados (facturas por due_on, deals ganados sin factura por expected_close_date y plazo de pago) menos gastos recurrentes y reserva de impuestos, por semana, ocho semanas. Gráfico y tabla.",
    done: "El gráfico sale de la función con los datos del seed; un test cubre una semana con cobro, gasto e impuesto.",
    status: "hecho",
    note: "projectCashflow() en packages/core/src/flujo-caja.ts (34 pruebas), getCashflowInputs() —una sola consulta— en queries/finanzas.ts (25 en PGlite con el seed, con la negativa de RLS) y /finanzas/flujo (13). La pantalla abre con requirePermission(\'finanzas.flujo.ver\') y una prueba comprueba que el rol Mánager no la abre y que ni siquiera se lee la base. FIN-2 y FIN-5 no hacían falta: lo que FIN-6 necesita de ellas son las tablas payment/expense (0008) y el seed 0003, no sus pantallas; flujo-caja.ts lo crea esta historia. Sin migración. Falta solo el 404 de ACC-5 (hoy el error cae en error.tsx) y la decisión de docs/propuestas/FIN-6.md §0.2.4: el cobro esperado es el bruto de la factura, no el neto de retención.",
  },
  {
    id: "FIN-7", module: "FIN", owner: "nicolas", size: "S", sprint: 6, deps: ["FIN-6"],
    title: "Ingresos de plataformas",
    desc: "Carga manual o CSV de Creator Rewards, AdSense y bonos en platform_payout. Entra al flujo de caja.",
    done: "Un CSV de AdSense aparece como ingreso en su mes.",
    status: "pendiente",
    note: "Corrida del sprint 5 al 6 el 22-sep para hacerle sitio a ACC-5 y ACC-8: no la toca ningún creador en un piloto de dos semanas.",
  },
  {
    id: "FIN-8", module: "FIN", owner: "nicolas", size: "S", sprint: 5, deps: ["CIM-3"],
    title: "Configuración financiera",
    desc: "Moneda, porcentaje de reserva de impuestos, IVA y retención por defecto, datos fiscales para la factura. En workspace.settings.",
    done: "Cambiar el porcentaje cambia la reserva de los pagos siguientes, no de los anteriores.",
    status: "pendiente",
  },

  // ---------------------------------------------------------------- ACC
  // Entró al MVP el 22 de septiembre: los creadores del piloto tienen
  // mánager. El diseño completo está en docs/propuestas/ACC-accesos-y-roles.md.
  {
    id: "ACC-1", module: "ACC", owner: "nicolas", size: "S", sprint: 3, deps: [],
    title: "Catálogo de permisos y can()",
    desc: "packages/core/src/permisos.ts: los permisos con la forma <módulo>.<recurso>.<acción>, los cinco roles de fábrica del creador y los cinco de agencia, y can(). Puro, sin base de datos y sin pantalla. Desde aquí, ninguna Server Action pregunta por el rol.",
    done: "Cada Server Action nueva abre con su requirePermission(); una prueba comprueba que el rol «Mánager» no trae finanzas.flujo.ver.",
    status: "hecho",
    note: "Hecha el 23-sep (rama nicolas/ACC-1-catalogo-permisos). 43 permisos en siete módulos con etiqueta y sensibilidad, diez roles de fábrica con su matriz literal, can(), permisosDeRol(), la intersección «nadie otorga lo que no tiene» y la regla del último dueño; pnpm --filter @mc/core permisos:sql imprime la semilla que ACC-3 pega en su migración (snapshot probado en PGlite). requirePermission() vive en apps/web/lib/permisos/ (no en lib/auth/, que es de Rasheed) y hoy resuelve toda sesión como Dueño (TODO(ACC-3) en sesion.ts); las doce Server Actions de Campañas, Finanzas y Conexiones ya abren con él y una prueba estática falla si una nueva no lo hace. Las de Resumen, Ventas y Cotizar tienen su permiso asignado en docs/propuestas/ACC-1.md §4 para cuando Rasheed las adapte. Tres lecturas conservadoras pendientes de Nicolás en la propuesta §0.2.",
  },
  {
    id: "ACC-2", module: "ACC", owner: "nicolas", size: "S", sprint: 3, deps: ["CIM-2"],
    title: "Bitácora obligatoria",
    desc: "audit() en packages/db/src/audit.ts: toda escritura de dinero, publicación o cuenta conectada deja su fila en audit_log con actor, before y after redactados, en la misma transacción.",
    done: "Crear una factura y conectar una cuenta dejan su fila; una prueba recorre las escrituras de queries/ y falla si alguna no audita.",
    status: "hecho",
    note: "Hecha el 23-sep. Sin migración: 0010 y 0025 ya dejaban audit_log lista. audit(tx, …) va DENTRO de la consulta que escribe (no en la Server Action), así COT-4 audita al crear la campaña sin saberlo; el actor sale de current_user_id() en SQL ('system' si la transacción no tiene identidad; 'job' desde el worker con auditAsJob). Redacción en dos capas (redactSecrets + claves prohibidas: secret_ref, correos, ip, evidence, raw) con prueba de volcado. Las 13 escrituras de finanzas, campanas y conexiones auditan, con el before leído de la fila (y consent.revoked al revocar un consentimiento); test/audit-convencion.test.ts lo exige. Fuera: la pantalla (AGE-2), 'delegate' (ACC-3) y las escrituras de Rasheed (docs/propuestas/ACC-2.md §3).",
  },
  {
    id: "ACC-3", module: "ACC", owner: "nicolas", size: "M", sprint: 4, deps: ["ACC-1", "CIM-3"],
    title: "Esquema de accesos (migración 0034)",
    desc: "0034_access_control.sql (era 0023: 0024–0033 llegaron antes y el runner aplica en orden): permission, role, role_permission, membership.role → role_id con relleno, membership_scope, invitation, workspace_grant y audit_log.on_behalf_of_workspace_id. Más la semilla de los diez roles de fábrica con su matriz (44 permisos y 225 filas al 23-sep, tras CAM-5).",
    done: "Migra en limpio en embebido (db.check y guardia) y está lista para Supabase; el seed deja los cinco roles de creador y los cinco de agencia con su matriz; las pruebas de CIM-3 siguen en verde.",
    status: "hecho",
    note: "ESTADO (23-sep). Hecha en embebido: make db.check en verde (33 migraciones, 97 tablas), guardia de esquema en verde con las declaraciones nuevas (permission como catálogo; role, role_permission y workspace_grant de solo lectura para mc_app; invitation sin DELETE), packages/db/test/accesos.test.ts (matriz exacta contra ROLES_SISTEMA y semilla idéntica a la salida de permisos:sql de ACC-1, relleno por tipo de workspace sin subir a nadie, RLS, privilegios, token solo como SHA-256, dos pasadas y guardia de orden) y las pruebas de identidad/rls/ventas adaptadas a role_id. PENDIENTE HUMANO: aplicar 0034 en Supabase (va por 0033) y desplegar main justo después, sin hueco entre los dos: el código de antes lee membership.role y el de después membership.role_id, y revisar lo que tocó carpetas de Rasheed (docs/propuestas/ACC-3.md §6: schema/accesos.ts propuesto, membership.roleId, identidad.ts, ventas.ts, seed 0002, etiquetas de rol). Choque de números: la rama de ACC-6 trae otra 0034 y pasa a 0035 al integrarse (misma tabla membership_scope, solo lectura para mc_app). DECISIONES PENDIENTES DE NICOLÁS: admin de creador → Mánager (nunca subir; cambiarlo es una línea) y si 0023 se rellena con un archivo vacío o queda como hueco declarado.",
  },
  {
    id: "ACC-4", module: "ACC", owner: "rasheed", size: "M", sprint: 5, deps: ["ACC-3"],
    title: "Pantalla Equipo: invitar al mánager",
    desc: "Invitar por correo eligiendo uno de los roles de fábrica, aceptar por enlace con vencimiento, cambiar rol y revocar. Al invitar a un mánager, dos casillas explícitas y apagadas: «también puede ver mis finanzas» y «también puede conectar mis cuentas». Nadie otorga un permiso que no tiene.",
    done: "Un creador invita a su mánager, el mánager entra por el enlace y ve Campañas pero no el flujo de caja; con la casilla marcada sí lo ve. Quitar al último dueño falla con mensaje.",
    status: "pendiente",
    note: "Es la demo del quinto viernes. Recortada a lo del piloto: sin matriz editable ni roles a medida, que son ACC-9.",
  },
  {
    id: "ACC-5", module: "ACC", owner: "nicolas", size: "S", sprint: 5, deps: ["ACC-3"],
    title: "Permisos en el marco",
    desc: "requireModule() recibe el permiso mínimo además de la bandera; el menú esconde lo que la persona no puede abrir; la ruta directa responde 404.",
    done: "Con sesión de «Contador», /campanas responde 404 y no aparece en el menú.",
    status: "pendiente",
    note: "404 y no 403, igual que una bandera apagada: un 403 confirma que el módulo existe.",
  },
  {
    id: "ACC-6", module: "ACC", owner: "nicolas", size: "M", sprint: 6, deps: ["ACC-3"],
    title: "Alcance en las consultas",
    desc: "scopeFilter() en packages/db, compuesto por cada queries/<modulo>.ts. La tenencia se garantiza en RLS; el alcance, aquí: depende de columnas que no todas las tablas tienen, y una política de alcance mal escrita no se ve como un bug.",
    done: "Un miembro con alcance a un creador no ve las campañas, los deals ni los posts del otro, en ninguna función exportada del módulo.",
    status: "pendiente",
    note: "Cada uno hace el alcance de sus módulos. Fuera del MVP: un workspace de creador tiene un solo creador, así que no hay nada que acotar hasta que existan las agencias.",
  },
  {
    id: "ACC-7", module: "ACC", owner: "rasheed", size: "M", sprint: 6, deps: ["ACC-6"],
    title: "Endurecimiento por creador en RLS",
    desc: "Política de fila por creator_id en las cuatro tablas que lo llevan: social_connection, post, campaign y deal.",
    done: "Una consulta cruda que se olvide de scopeFilter() tampoco devuelve filas de otro creador.",
    status: "pendiente",
  },
  {
    id: "ACC-8", module: "ACC", owner: "nicolas", size: "S", sprint: 5, deps: ["CON-3", "ACC-3"],
    title: "Consentimiento delegado",
    desc: "Quien conecta una cuenta ajena no es quien consiente: data_consent.evidence lleva acted_by y el titular recibe notificación. El token no se lee nunca; no existe el permiso de verlo.",
    done: "El mánager conecta el TikTok del creador: el consentimiento queda a nombre del creador, con el mánager como operador, y al creador le llega la notificación.",
    status: "pendiente",
    note: "Deja de ser opcional en cuanto el mánager hace el onboarding del piloto. Es además la respuesta el día que Meta o TikTok pregunten quién dio el consentimiento.",
  },
  {
    id: "ACC-9", module: "ACC", owner: "rasheed", size: "M", sprint: 6, deps: ["ACC-4"],
    title: "Matriz editable y roles a medida",
    desc: "La pantalla que muestra los permisos uno por uno y deja crear un rol propio del workspace (role con workspace_id).",
    done: "Una agencia crea el rol «Becario» con tres permisos y se lo asigna a alguien.",
    status: "pendiente",
    note: "Necesidad de agencia, no de un creador con un mánager: para el piloto bastan los cinco roles de fábrica.",
  },
];
