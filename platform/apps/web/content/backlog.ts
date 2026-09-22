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
export type SprintNumber = 1 | 2 | 3 | 4 | 5;

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
    name: "Lo que depende de aprobaciones, y el piloto",
    demo: "Pantalla de conexiones, demografía, YouTube, recordatorios de cobro (Nicolás). Lo que importa esta semana, cuándo publicar, brief y conversión (Rasheed). Producción abierta a los primeros creadores.",
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
    note: "Ronda 4 (22 de septiembre): `pnpm --filter @mc/web dev` ya carga platform/.env.local (`node --env-file-if-exists=../../.env.local`, igual que el worker), así que `make dev` levanta web y worker contra LA MISMA base; antes la web caía al modo demo en silencio y se depuraban datos de pglite creyéndolos reales. La verificación de calidad vale con `--force`: la caché de turbo es local a la máquina, se comparte entre todos los clones y worktrees y no distingue la rama, así que `pnpm turbo run typecheck lint test` puede dar 14/14 «cache hit» replayando otra rama; el job «calidad» del CI corre con `--force --concurrency=2`, y las suites de @mc/db y @mc/worker con `--test-isolation=none` y `--test-timeout=120000` (con aislamiento por proceso, varias instancias de PGlite a la vez cancelaban archivos enteros con «Promise resolution is still pending»). Sigue bloqueada el 22 de septiembre, tras la ronda 3: falta GRANT mc_worker TO mc_migrator en Supabase (supabase-admin.sh, docs/propuestas/CON-2.md §3.1) y el esquema pgboss; media fuera de turbo hasta MED-1. Lo que sí está: pnpm turbo run typecheck lint test cubre web, db, worker, core y connectors y pnpm --filter @mc/web build pasa; `pnpm --filter @mc/worker dev` (src/dev.ts) comprueba la membresía y el esquema antes de arrancar y, si faltan, imprime los comandos exactos y las definiciones de jobs y sale con 0 (make dev no se cae en bucle); con credenciales rechazadas o host inalcanzable dice qué corregir (make db.unlock, make db.info) en vez del stack de pg; `make worker.humo` lista job_definition por DATABASE_URL; make arranque dice qué falta. `pnpm --filter @mc/web dev --port NNNN` ya manda (el script dev no fija puerto) y el worker solo carga .env.local. lib/workspace/current.ts (DEMO_WORKSPACE_ID) es la única costura del workspace: lib/db la usa y Finanzas y Conexiones la reexportan. Vuelve a «hecho» cuando `pnpm --filter @mc/worker dev` arranque el runner contra Supabase. RONDA 5 (22 de septiembre): la puerta de calidad dejó de depender de que uno se acuerde de los flags: `test` ya no se cachea en turbo.json (cada suite levanta su propio Postgres embebido: cachearla no ahorra nada y sí miente entre ramas) y el comando documentado es `pnpm verificar` —alias de `turbo run typecheck lint test --force --concurrency=2`, también como `make verificar`—, explicado en platform/README.md con las dos razones medidas: el «14/14 cache hit» replayando otro worktree y las 18 pruebas del worker que morían con «Promise resolution is still pending» cuando web, worker y db levantan PGlite y pg-boss a la vez. Y los tres archivos nuevos del worker (preflight.ts, humo.ts, dev.ts) ya tienen prueba: apps/worker/test/preflight.test.ts corre runPreflight sobre PGlite (mc_app NO es miembro de mc_worker, el esquema pgboss aparece al crearlo) y fija los mensajes de explainMissing (el GRANT y el CREATE SCHEMA exactos), explainConnectionError (28P01 con usuario y host; null para cualquier otro error) y formatJobDefinitions (una línea por definición, con el host), que es lo que hacía reproducible el criterio de «dev imprime las definiciones» sin credenciales.",
  },
  {
    id: "CIM-2", module: "CIM", owner: "rasheed", size: "M", sprint: 1, deps: ["CIM-1"],
    title: "Cliente de base con aislamiento (RLS)",
    desc: "Cada consulta corre en una transacción que fija app.workspace_id con set_config(…, true), contra el pooler en modo transacción. Esquema Drizzle generado desde las migraciones para las tablas del MVP.",
    done: "Un test crea dos workspaces, inserta un deal en cada uno y comprueba que ninguno ve el del otro. Sin workspace_id fijado, la consulta devuelve cero filas.",
    status: "hecho",
    note: "Cerrada el 21 de septiembre; rondas 2 y 3 el 22, la última con main (CAM-1, CAM-2, CON-3) integrado. packages/db con Drizzle (45 tablas y 8 vistas curadas desde las migraciones; test/schema.test.ts las compara columna a columna con la base y exige RLS en toda tabla de tenant o hija de una), client.ts con withWorkspace, withoutWorkspace (solo catálogos: company y contact NO lo son, se leen por company_link) y asWorker (SET LOCAL ROLE mc_worker; probado también que mc_app no puede asumirlo), timeouts por transacción, manijas que lanzan TransactionClosedError tras el cierre, NestedTransactionError si se anida una transacción, conexión destruida si el ROLLBACK falla, TLS con la CA de db/certs, y Postgres embebido que corre como mc_app con el mismo runner de migraciones que Supabase (db/lib/aplicar.mjs, que ahora se niega si dos archivos comparten número). Las consultas de CAM-2 y CON-3 se conservaron (isUuid/UUID_RE salen de client.ts) y campanas/conexiones/finanzas.test.ts corren sobre test/pglite.ts; el CI las corre además contra Postgres 16 con un rol mc_app_ci (TEST_DATABASE_URL), que es lo que ejercita el runner de pg. README.md con los cinco usos; los operadores de Drizzle salen de @mc/db y las consultas por @mc/db/queries/<módulo> (la raíz reexporta las de Finanzas, Conexiones y Campañas por compatibilidad). Migraciones pendientes de aplicar en Supabase por el integrador, en el mismo PR de la fusión (make db.migrate): 0017 (RLS en outbound_policy, antes 0015: desde entonces exige withWorkspace, aviso a los dueños de Ventas) y 0018 (antes 0016: RLS heredada en quote_item, rate_card_item, deal_stage_history, campaign_post y las hijas de video_analysis/script/idea: desde B se leían los precios de A); comprobar después relrowsecurity = true en esas cinco tablas y no cargar clientes reales antes. membership sigue sin RLS hasta CIM-3 y contact/app_user hasta VEN-1 (test.todo visibles; propuesta de política en docs/backlog-mvp.md §8.4 fila 2c). Lo que queda para Nicolás está en CON-2b. RONDA 4 (22 de septiembre): migración 0019 (membership y contact con RLS: ya no queda ninguna tabla con workspace_id sin política, y contact —correo, teléfono, LinkedIn— solo se ve si su fuente es pública o si company_link la vincula a mi workspace; la función current_user_id() queda lista para CIM-3 y devuelve NULL hasta entonces); un `?sslmode=…` en DATABASE_URL ya no puede ganarle a la CA del repositorio (pg re-parsea la cadena DESPUÉS de la configuración: no-verify apagaba la verificación, disable mandaba texto plano a Supabase y require descartaba la CA embebida — resolveTls lanza con instrucciones, y en un host sin CA propia traduce el parámetro y lo borra de la URL); el worker importa tlsFor/hostOf/resolveTls de @mc/db y borró su copia (era CON-2b); `withoutWorkspace` se llama `withCatalogs`, sale del barril y en su lugar está queries/catalogos.ts con las siete lecturas con nombre; queries/cimientos.ts (getWorkspaceSettings) es la costura de moneda, zona horaria y locale del workspace, que lib/format.ts, /finanzas y createInvoice ya usan en vez de es-CO y COP fijos; raw/admin dentro de una transacción de PGlite lanzan en vez de colgarse para siempre; lib/db ya no exporta el cliente crudo (getDbMode/closeDb); y hay pruebas nuevas de TLS, de las dos políticas de 0019 y de los helpers de queries (listPostBoard, getCurrentRateCard, getWorkspaceSettings, catálogos). Migraciones pendientes para el integrador: 0017, 0018 y 0019. RONDA 5 (22 de septiembre): migración 0020, que cierra lo que 0019 dejó abierto y todo lo reprodujo antes una prueba en packages/db/test/rls.test.ts. (1) contact se aislaba por company_link, y company es un catálogo global sin RLS: a B le bastaba insertarse UNA fila de company_link para leer el correo y el teléfono que guardó A, y como la política era única, permisiva y FOR ALL, su rama pública servía también de escritura (B cambiaba el correo de un contacto de A, lo borraba, o le colgaba uno nuevo marcándolo 'press'). Ahora contact lleva owner_workspace_id con DEFAULT current_workspace_id() y dos políticas, lectura (público o mío) y escritura (mío, y con la empresa vinculada); un trigger impide que opted_out vuelva a false, y la baja de un contacto ajeno la registra el worker con asWorker, porque en Postgres un UPDATE con WHERE tiene que poder LEER la fila y abrir eso sería abrir la PII. (2) app_user tenía RLS aplazada a CIM-3 «porque el seed lo inserta antes que su membership»: se resuelve con dos políticas (SELECT «soy yo o comparto workspace» e INSERT abierto), así que ya no queda ninguna tabla con datos personales sin política y el test.todo se convirtió en prueba. (3) pipeline_stage y feature_flag llevan RLS: B leía las etapas privadas de A y podía encenderle feature_flag('outbound_send') a otro workspace; listPipelineStages / listFeatureFlags perdieron el parámetro workspaceId y ahora reciben la transacción. Además: la guardia de TLS vigila los seis parámetros de la URL, no dos (sslrootcert sustituía la CA del repositorio por la del archivo que dijera la URL, y sslnegotiation=direct la perdía; medido con el pg instalado); createPool deja siempre un oyente de 'error' en el pool, porque una conexión OCIOSA rota tumbaba el proceso de Next entero con ERR_UNHANDLED_ERROR; createDbFromEnv comprueba al arrancar que la base tenga las migraciones y la RLS que el paquete declara (assertSchemaUpToDate en src/esquema.ts: avisa en desarrollo, lanza en producción, y el worker pregunta lo mismo en su preflight) — hasta ahora el aviso de «Supabase va por la 15 y el repo por la 19» vivía en esta nota, que nadie lee en tiempo de ejecución; un builder de Drizzle capturado dentro de la transacción y esperado fuera ya lanza TransactionClosedError; y los helpers de queries/ validan los ids que llegan de una ruta (getCurrentRateCard, getPipelineDeal y getInvoice devuelven null en vez de un 22P02 convertido en 500). En la web, formatterFor dejó de estar solo citada: el plan, Finanzas y el detalle de factura formatean con el locale, la moneda Y la zona horaria del workspace, y lib/format.test.ts falla si alguna de las tres vuelve al valor por defecto. Migraciones pendientes para el integrador: 0017, 0018, 0019 y 0020, en ese orden, y ANTES del siguiente despliegue a producción: desde esta ronda la web no arranca con NODE_ENV=production contra una base sin ellas (dice cuáles faltan y qué tablas se quedaron sin RLS; la salida explícita, para un despliegue que no puede esperar, es ALLOW_STALE_SCHEMA=1). INTEGRACIÓN (22 de septiembre, rasheed/integracion): 0016 a 0021 aplicadas en Supabase con make db.migrate; 89 tablas, 10 vistas, 217 índices. La 0021 nació en la integración: 0020 dejó app_user sin política de UPDATE a propósito y el seed 0002 refresca last_seen_at con ON CONFLICT DO UPDATE, que Postgres rechaza ya en la primera pasada aunque no haya fila con la que chocar. Es la línea que 0020 anunciaba para CIM-3 (id = current_user_id()), y el seed pasa a fijar app.user_id junto a app.workspace_id; DELETE sigue sin política.",
  },
  {
    id: "CIM-3", module: "CIM", owner: "rasheed", size: "M", sprint: 1, deps: ["CIM-2"],
    title: "Autenticación y workspaces",
    desc: "Supabase Auth con correo y enlace mágico. Al entrar se crea app_user y membership; si no hay workspace, se crea uno de tipo creador con su creator_profile. Cambio de workspace en la barra.",
    done: "Se entra con un correo nuevo y aparece un workspace vacío con nombre; se entra con uno del seed y aparece la creadora ficticia.",
    status: "hecho",
    note:
      "Cerrada el 22 de septiembre. Supabase Auth con enlace mágico y TODO el flujo en el servidor (@supabase/ssr): /login es un campo y un botón con su estado «revisa tu correo» (reenviar y cambiar de correo), /auth/callback acepta las dos formas que manda Supabase (?code= con PKCE y ?token_hash=&type=), middleware.ts refresca la sesión en cada petición y protege todo (app)/ —público solo lo que declara lib/auth/rutas.ts: /login, /auth, /kit, /cotizacion, /baja y /api/webhooks—, y el `next=` del login solo admite rutas de esta aplicación (un `next=https://…` convertiría /login en un redirector abierto). El marco bajó al layout de (app), así que /login no lleva barra lateral. LA COSTURA: lib/workspace/current.ts ya no lee DEMO_WORKSPACE_ID salvo cuando NO hay sesión; con sesión, el espacio sale de la cookie firmada mc.workspace (HMAC derivado de TOKEN_ENCRYPTION_KEY con su propia etiqueta, con el correo dentro para que otra cuenta en el mismo navegador no herede el espacio anterior) y SIEMPRE se comprueba la membresía contra la base antes de servir nada: a quien le quitan el acceso deja de verlo en la petición siguiente, no cuando caduque la cookie. lib/db se partió en dos (cliente.ts abre transacciones, index.ts decide el workspace) para que la decisión pueda consultar la base sin importarse a sí misma. EN @mc/db: withIdentity(identity, fn) —transacción sin workspace y con app.user_id y app.user_email fijados— y withWorkspace(id, fn, identity), que es como la web abre ahora todas sus transacciones; queries/identidad.ts (upsertAppUserPorCorreo, listMyWorkspaces, isMemberOf, createCreatorWorkspace, updateMyName, nameFromEmail, slugify, freeSlug) con su prueba sobre PGlite. Así «a qué espacios pertenezco» se responde como mc_app, sin asWorker y sin SECURITY DEFINER, que era lo que anunciaban 0019 y 0020. MIGRACIÓN 0022, PENDIENTE DE APLICAR EN SUPABASE POR EL INTEGRADOR (make db.migrate; verificada con make db.check): current_user_email() y dos políticas más en app_user, SELECT y UPDATE por «email = current_user_email()». Sin ella el primer inicio de sesión NO funciona contra Supabase: buscar app_user por correo devuelve cero filas y el alta choca contra el único de email. Mientras nadie fije app.user_email la función es NULL y no cambia nada de lo que ya existe. LO QUE HAY QUE HACER A MANO, UNA VEZ, en el panel de Supabase (Authentication → URL Configuration): Site URL y Redirect URLs de localhost y de on-cue-web.vercel.app; está escrito en apps/web/README.md, sección «Autenticación», junto con el límite bajo por hora del correo integrado (429 → /login lo dice con su propio texto) y cómo probar el enlace sin esperar un correo con generate_link. PROBADO DE VERDAD, no solo con pruebas: web levantada con las llaves reales de Supabase y la base embebida (la de Supabase va por la 0021), enlace mágico real por generate_link. Correo nuevo → espacio propio con nombre sacado del correo y su creator_profile; correo del seed → Laura · Cocina fácil con sus facturas; sin sesión, /resumen y /finanzas redirigen a /login?next=…; /kit sigue abierta; y la cookie de espacio de una persona, con la sesión de otra, no le sirve (sigue en el suyo). Y las server actions, enviadas como formularios sin JavaScript: crear un segundo espacio lo deja como actual, cambiar al primero cambia lo que se ve, mandar el id del espacio del seed —que no es mío— no cambia nada, y cerrar sesión borra las dos cookies y devuelve /resumen a /login. Queda fuera: invitar a alguien a un espacio (no hay pantalla de equipo todavía), cambiar de correo desde /cuenta, y Google como segundo método (espera la verificación, decisión 3 del backlog). RONDA 2 (22 de septiembre), tras dos revisiones. Lo que estaba ROTO y ahora no: (a) el formulario de /login devolvía 500 en el primer envío —`export const ESTADO_INICIAL` salía de un archivo con «use server», y Next exige que todos los exports en tiempo de ejecución de esos módulos sean funciones async—, así que NADIE podía pedirse un enlace desde el producto y lo que la nota anterior daba por probado era el enlace generado a mano con generate_link, que se salta la pantalla; la constante bajó a app/login/formulario.tsx y hay dos pruebas que fijan la regla (app/login/acciones.test.ts). (b) La comprobación de membresía era circular: el id de app_user salía de la PROPIA cookie y luego se preguntaba «¿ese id es miembro?» con RLS fijada a ese mismo id, así que siempre decía que sí y toda la frontera entre inquilinos colgaba de un HMAC. Ahora quién eres se resuelve SIEMPRE desde el correo verificado (getMyIdentityAndWorkspaces en @mc/db: app_user por `email = current_user_email()` y después membership por current_user_id(), en una transacción), y la cookie mc.workspace es una PREFERENCIA que solo se respeta si el espacio está en la lista que devolvió la base. (c) Las cookies de sesión de Supabase se escribían con los valores por defecto de @supabase/ssr: sin HttpOnly, sin Secure y 400 días, con el access token Y el refresh token dentro; los dos clientes pasan ahora el mismo cookieOptions (lib/auth/cookies.ts). (d) Si sincronizar fallaba, /auth/callback dejaba la sesión abierta y mandaba a /login?error=sesion, donde el redirect de «ya entraste» se tragaba el mensaje y devolvía a /resumen sin salida: ahora el callback cierra la sesión antes de redirigir y /login no redirige cuando viene con ?error=. Además: pintar una pantalla ya NO escribe en la base (sincronizar.ts se partió en leerSesion —dos SELECT— y registrarEntrada —el alta, solo desde /auth/callback—; antes cada GET hacía un UPDATE de last_seen_at); el primer espacio se crea una sola vez aunque lleguen dos peticiones a la vez (pg_advisory_xact_lock por correo y relectura dentro del cerrojo: hay prueba que falla sin ellos); el `type` del enlace se valida contra una lista blanca en vez de un `as EmailOtpType`; volver a entrar por el enlace respeta el espacio en el que estabas; el middleware copia a la redirección las cookies que @supabase/ssr acaba de borrar cuando el refresh token caducó, y se ahorra el cliente entero en una ruta pública sin cookie de sesión; crear un espacio sin TOKEN_ENCRYPTION_KEY ya lo dice en vez de mandarte a /resumen sin cambiar nada; /login tiene su error.tsx y su loading.tsx y hay un app/error.tsx en la raíz que cubre /auth/callback; el pie legal son dos enlaces a /legal, una página pública nueva que dice qué hacemos con tu correo; el selector de espacio se anuncia como menú (role=menu/menuitem, foco al abrir, Escape devuelve el foco, flechas) y sin sesión no enseña el nombre de ningún espacio real. PROBADO A MANO sobre el build de producción, con un Supabase de mentira en local y sin JavaScript (que es como Next envía estos formularios cuando el cliente no ha hidratado): enviar → «Revisa tu correo» y la petición de OTP sale con su redirect_to; reenviar → «Enlace reenviado»; usar otro correo → vuelve al campo vacío; /resumen sin sesión → 307 a /login?next=%2Fresumen; un type desconocido en /auth/callback → /login?error=enlace; y una ruta pública sin cookie sb- no construye cliente de sesión. Pruebas nuevas (28 casos): app/login/acciones.test.ts (10), lib/auth/acciones.test.ts (7 sobre PGlite con RLS real: el espacio ajeno se rechaza y no se sella cookie, el propio sí y cambia lo que se sirve, una cookie firmada con el id de otra persona no mueve a nadie, y dos altas simultáneas dejan UN espacio —esta falla si se quita el cerrojo, comprobado—), lib/auth/config.test.ts (6) y components/workspace-menu.test.tsx (5: role de menú, foco al abrir, Escape lo devuelve, flechas). Se tocó components/shell.tsx (carpeta de Nicolás) solo para montar WorkspaceSwitcher en dos sitios, barra lateral y cabecera móvil, porque el marco tiene dos cabeceras; y app/layout.tsx dejó de montar el Shell, que bajó a app/(app)/layout.tsx.",
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
    note: "Seed 0002 determinista e idempotente cualquier día, y que no caduca por ningún lado: 60 videos con curvas ancladas a la primera corrida y una parrilla que se rellena sola (un video cada dos días desde el último guardado hasta ayer), la serie de la cuenta extendida hasta ayer, demografía cuyas personas salen de la última lectura de seguidores, línea base por día de cálculo y puntaje que sube al corte alcanzado con la regla de scoring.ts, y el CRM con 8 marcas, 13 señales (5 por revisar, como el mock) y 15 deals (10 abiertos · COP 95,5 M · ponderado 43,15 M). Volver a sembrar refresca lo que la demo mira hoy —cierre esperado, próxima acción y último contacto de los deals abiertos con su actividad de seguimiento, señales pendientes, ventana del brief, frescura de las conexiones, foto de la audiencia— y congela lo que ya pasó. Las cuatro campañas llevan su deal, así que la cadena señal → deal → campaña → factura se recorre entera. Verificación en Postgres embebido, ya colgada del comando estándar (pnpm turbo run test → tarea raíz //#test): cifras, prueba de la baja en outbound_touch, tercera pasada con el reloj a +1 y cuarta que resiembra la misma base a +41 exigiendo también videos recientes, tablero vivo y cero puntajes obsoletos; más la siembra en limpio a +40 días (node db/seed/verify/run.mjs [--dias 40], también en CI). El reloj del harness vive en reloj.mjs y ya no puede reescribir un dato que se parezca a now(). Toca 0003 (Nicolás) lo mínimo: línea de tiempo de Café Alma y las dos lecturas de Fresko condicionadas a su fecha (CIM-6.md §3.10). Decisiones en docs/propuestas/CIM-6.md. INTEGRACIÓN (22 de septiembre, rasheed/integracion): 0001, 0002 y 0003 sembrados en Supabase con make db.seed. El conflicto conocido de 0003 quedó con la clave platform_id de main y las fechas de esta rama, y las cuatro campañas de 0002 pasaron también a platform_id. Se borraron de Supabase cinco lecturas manuales que había dejado la versión anterior de 0003 —cuatro de ellas con captured_at en el FUTURO, que es justo lo que esta historia vino a quitar—: un seed solo inserta, así que no podían desaparecer solas. Y campanas.test.ts y conexiones.test.ts, que estaban clavadas al seed sin 0002, pasan a afirmar la banda alrededor de la cifra del mock en vez del valor de hoy: la curva sigue midiendo hasta los 90 días y el número exacto sube cada día.",
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
    note: "Código completo y probado con respuestas grabadas: cifrado AES-256-GCM (HKDF, AAD = secret_ref, rotación de clave), tabla connection_secret (migración 0015, RLS en FORCE, aplicada en Supabase el 21-sep), EncryptedSecretStore, OAuth de TikTok Login Kit e Instagram Login (Accounts API detrás de TIKTOK_BUSINESS_APP_ID hasta CON-9), rutas start/callback con cookie sellada de 10 minutos, data_consent con evidencia, pantalla mínima de /conexiones y oauth.refresh con los refreshers reales. La prueba clave vuelca todas las columnas de texto de todas las tablas y no encuentra ningún token. En main y desplegada en producción el 22-sep con TOKEN_ENCRYPTION_KEY y APP_URL en Vercel. Bloqueada solo por la prueba en vivo: falta el acceso de desarrollador a las apps de TikTok y Meta (backlog §9.4 fila 15); el paso a paso está en docs/propuestas/CON-3.md §5.",
  },
  {
    id: "CON-4", module: "CON", owner: "nicolas", size: "M", sprint: 5, deps: ["CON-3", "CIM-5"],
    title: "Pantalla Conexiones",
    desc: "Lista sobre connection_health, botón para conectar cada red, estado (activa, vencida, necesita reautorizar), horas desde la última sincronización, y el paso manual «activa Analytics en TikTok».",
    done: "Una conexión con token vencido se ve en rojo con el botón de reautorizar.",
    status: "pendiente",
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
    status: "pendiente",
  },
  {
    id: "RES-2", module: "RES", owner: "rasheed", size: "M", sprint: 2, deps: ["CIM-5"],
    title: "Importación por CSV",
    desc: "El creador exporta desde TikTok Studio, Instagram Insights o YouTube Studio y sube el archivo; se convierte en snapshots con source = csv_import. Es la vía mientras no hay aprobaciones.",
    done: "Un CSV real de Instagram Insights llena post_metric_snapshot y aparece en Resumen.",
    status: "pendiente",
  },
  {
    id: "RES-3", module: "RES", owner: "rasheed", size: "M", sprint: 5, deps: ["CON-6", "VEN-4", "FIN-4"],
    title: "Lo que importa esta semana",
    desc: "Lista generada desde los datos: outliers nuevos, conexión con error, factura vencida, deal con seguimiento vencido. Lee notification.",
    done: "Las cuatro fuentes producen su fila y cada una lleva a su módulo.",
    status: "pendiente",
  },
  {
    id: "RES-4", module: "RES", owner: "rasheed", size: "S", sprint: 5, deps: ["CON-7"],
    title: "Demografía y cuándo publicar, en pantalla",
    desc: "El bloque de audiencia por edad, género y país, y el de «cuándo publicar» (seguidores conectados por hora, Instagram), sobre lo que recolecta CON-7.",
    done: "El gráfico por hora coincide con el fixture; si la cuenta no da demografía, la pantalla explica por qué.",
    status: "pendiente",
  },

  // ---------------------------------------------------------------- VEN
  {
    id: "VEN-1", module: "VEN", owner: "rasheed", size: "M", sprint: 1, deps: ["CIM-2", "CIM-5"],
    title: "Empresas y contactos",
    desc: "Crear, editar, buscar por nombre (el índice trigram ya existe), company_link con relationship y dueño. Un contacto exige source; sin procedencia no se guarda.",
    done: "Se crea una empresa con dos contactos y aparece en la búsqueda al tercer carácter.",
    status: "pendiente",
    note: "La RLS de contact ya NO es parte de esta historia: la adelantaron las migraciones 0019 y 0020 en las rondas 4 y 5 de CIM-2. Lo que hay que saber para la pantalla: el candado es contact.owner_workspace_id, que pone la base sola (DEFAULT current_workspace_id()) —nunca se escribe a mano—; se lee lo público (source public_website/public_profile/press) más lo propio; se escribe solo lo propio y solo sobre una empresa que este workspace tenga en company_link; y opted_out no vuelve a false (un trigger lo impide), así que la baja de un contacto ajeno la registra el worker con asWorker, no la pantalla. Los casos están en packages/db/test/rls.test.ts. Aquí queda la pantalla: los contactos se leen y se escriben dentro de withWorkspace y la política hace el resto.",
  },
  {
    id: "VEN-2", module: "VEN", owner: "rasheed", size: "M", sprint: 1, deps: ["VEN-1"],
    title: "Radar manual y por CSV",
    desc: "Bandeja de signal con estado pendiente, aceptar (crea o actualiza empresa y deal en nuevo) o descartar con motivo. Fuente manual y carga por CSV de una lista de marcas. Las fuentes automáticas quedan para fase 2.",
    done: "Aceptar una señal crea el deal con «Enviar pitch» como siguiente acción; descartarla la saca de la bandeja y no vuelve a entrar (dedupe_key).",
    status: "pendiente",
  },
  {
    id: "VEN-3", module: "VEN", owner: "rasheed", size: "L", sprint: 2, deps: ["VEN-1"],
    title: "Pipeline kanban y lista",
    desc: "Tablero por etapa y vista de lista sobre deal_pipeline. Arrastrar cambia la etapa y escribe deal_stage_history con los días en la etapa. KPIs: deals abiertos, cierre ponderado, ganado en el trimestre.",
    done: "Mover un deal a «Ganado» fija won_at; el cierre ponderado cambia al mover entre etapas.",
    status: "pendiente",
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
    id: "VEN-7", module: "VEN", owner: "rasheed", size: "S", sprint: 5, deps: ["VEN-2"],
    title: "Brief de outbound",
    desc: "Qué busca el creador (categorías, países, presupuesto mínimo, entregables) y qué no acepta. Filtra la bandeja del radar.",
    done: "Una señal de una categoría excluida no aparece en la bandeja.",
    status: "pendiente",
  },
  {
    id: "VEN-8", module: "VEN", owner: "rasheed", size: "S", sprint: 5, deps: ["VEN-3"],
    title: "Deal perdido y conversión por etapa",
    desc: "Motivo de pérdida, y tasa de conversión por etapa desde deal_stage_history.",
    done: "La tasa entre etapas aparece en el pipeline con el número de deals que la sostiene.",
    status: "pendiente",
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
    done: "Con las views del mock salen los rangos del mock; cambiar el CPM cambia el rango y la explicación lo dice.",
    status: "pendiente",
  },
  {
    id: "COT-2", module: "COT", owner: "rasheed", size: "M", sprint: 3, deps: ["COT-1", "RES-1"],
    title: "Media kit público",
    desc: "Foto congelada de los números en media_kit.snapshot, página pública por slug, opcional con contraseña y vencimiento. Contador de vistas.",
    done: "El enlace abre sin sesión, muestra las cifras congeladas, y no cambia aunque cambien las métricas.",
    status: "pendiente",
  },
  {
    id: "COT-3", module: "COT", owner: "rasheed", size: "L", sprint: 4, deps: ["COT-1", "VEN-3"],
    title: "Cotización",
    desc: "Crear desde un deal, ítems desde el tarifario, subtotal, descuento, impuesto y total. Lo que se acuerda antes de publicar: métricas a reportar, cortes (24 h, 7 d, 30 d), derechos, exclusividad, plazo de pago. Numeración COT-2026-014.",
    done: "Enviar pasa el deal a «Propuesta enviada»; la cotización tiene su enlace público.",
    status: "pendiente",
  },
  {
    id: "COT-4", module: "COT", owner: "rasheed", size: "M", sprint: 4, deps: ["COT-3", "CAM-2"],
    title: "Aceptación crea la campaña",
    desc: "Al marcar aceptada, llama a createCampaignFromQuote() de queries/campanas.ts (la escribe Nicolás en CAM-2) y pasa el deal a «Ganado». Es el punto de cruce entre las dos cadenas.",
    done: "Aceptar una cotización deja una campaña en planned y Nicolás la ve en su módulo sin tocar nada.",
    status: "pendiente",
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
    status: "pendiente",
  },
  {
    id: "CAM-4", module: "CAM", owner: "nicolas", size: "S", sprint: 4, deps: ["CAM-1"],
    title: "Lo que aporta la marca",
    desc: "Canjes del código, pedidos, ingresos, por formulario o CSV, en campaign_brand_input.",
    done: "Subir un CSV de ventas diarias llena la tabla y aparece en la ficha.",
    status: "pendiente",
  },
  {
    id: "CAM-5", module: "CAM", owner: "nicolas", size: "M", sprint: 4, deps: ["CAM-3", "CAM-4", "CON-6"],
    title: "Resultado de campaña",
    desc: "campaign.compute llena campaign_result con views, alcance, clics, canjes, seguidores ganados por la marca frente a su ritmo previo, CPM y CPA reales, y views_vs_median. missing_inputs dice qué falta.",
    done: "Los seis KPIs salen de la tabla; si no hay datos de la marca, la celda dice «sin datos de la marca», no cero.",
    status: "pendiente",
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
    status: "pendiente",
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
    status: "pendiente",
  },
  {
    id: "FIN-7", module: "FIN", owner: "nicolas", size: "S", sprint: 5, deps: ["FIN-6"],
    title: "Ingresos de plataformas",
    desc: "Carga manual o CSV de Creator Rewards, AdSense y bonos en platform_payout. Entra al flujo de caja.",
    done: "Un CSV de AdSense aparece como ingreso en su mes.",
    status: "pendiente",
  },
  {
    id: "FIN-8", module: "FIN", owner: "nicolas", size: "S", sprint: 5, deps: ["CIM-3"],
    title: "Configuración financiera",
    desc: "Moneda, porcentaje de reserva de impuestos, IVA y retención por defecto, datos fiscales para la factura. En workspace.settings.",
    done: "Cambiar el porcentaje cambia la reserva de los pagos siguientes, no de los anteriores.",
    status: "pendiente",
  },
];
