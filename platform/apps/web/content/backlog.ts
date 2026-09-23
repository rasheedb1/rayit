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
    note: "ESTADO (22-sep, endurecimiento integrado en rasheed/integracion): una sola frontera de error en (app), y la comprobación de que el workspace existe dentro de withWorkspace para todos los módulos (el alta de espacio de CIM-3 no pasa por ella). Sigue bloqueada por GRANT mc_worker TO mc_migrator y el esquema pgboss en Supabase. Pendientes de aplicar en Supabase (va por 0022_public_profile_access), con make db.migrate y en este orden: 0024_aislamiento_por_defecto, 0025_referencias_visibles, 0026_duenos_unicos_secuencias, 0027_sesion_correo_verificado, 0028_membership_alta_propia, 0029_supresion_verificada_filas_que_nombran y 0030_public_share (antes, el rol mc_public_share; ver su cabecera). make db.check las aplica todas en orden. Ronda 4 (22 de septiembre): `pnpm --filter @mc/web dev` ya carga platform/.env.local (`node --env-file-if-exists=../../.env.local`, igual que el worker), así que `make dev` levanta web y worker contra LA MISMA base; antes la web caía al modo demo en silencio y se depuraban datos de pglite creyéndolos reales. La verificación de calidad vale con `--force`: la caché de turbo es local a la máquina, se comparte entre todos los clones y worktrees y no distingue la rama, así que `pnpm turbo run typecheck lint test` puede dar 14/14 «cache hit» replayando otra rama; el job «calidad» del CI corre con `--force --concurrency=2`, y las suites de @mc/db y @mc/worker con `--test-isolation=none` y `--test-timeout=120000` (con aislamiento por proceso, varias instancias de PGlite a la vez cancelaban archivos enteros con «Promise resolution is still pending»). Sigue bloqueada el 22 de septiembre, tras la ronda 3: falta GRANT mc_worker TO mc_migrator en Supabase (supabase-admin.sh, docs/propuestas/CON-2.md §3.1) y el esquema pgboss; media fuera de turbo hasta MED-1. Lo que sí está: pnpm turbo run typecheck lint test cubre web, db, worker, core y connectors y pnpm --filter @mc/web build pasa; `pnpm --filter @mc/worker dev` (src/dev.ts) comprueba la membresía y el esquema antes de arrancar y, si faltan, imprime los comandos exactos y las definiciones de jobs y sale con 0 (make dev no se cae en bucle); con credenciales rechazadas o host inalcanzable dice qué corregir (make db.unlock, make db.info) en vez del stack de pg; `make worker.humo` lista job_definition por DATABASE_URL; make arranque dice qué falta. `pnpm --filter @mc/web dev --port NNNN` ya manda (el script dev no fija puerto) y el worker solo carga .env.local. lib/workspace/current.ts (DEMO_WORKSPACE_ID) es la única costura del workspace: lib/db la usa y Finanzas y Conexiones la reexportan. Vuelve a «hecho» cuando `pnpm --filter @mc/worker dev` arranque el runner contra Supabase. RONDA 5 (22 de septiembre): la puerta de calidad dejó de depender de que uno se acuerde de los flags: `test` ya no se cachea en turbo.json (cada suite levanta su propio Postgres embebido: cachearla no ahorra nada y sí miente entre ramas) y el comando documentado es `pnpm verificar` —alias de `turbo run typecheck lint test --force --concurrency=2`, también como `make verificar`—, explicado en platform/README.md con las dos razones medidas: el «14/14 cache hit» replayando otro worktree y las 18 pruebas del worker que morían con «Promise resolution is still pending» cuando web, worker y db levantan PGlite y pg-boss a la vez. Y los tres archivos nuevos del worker (preflight.ts, humo.ts, dev.ts) ya tienen prueba: apps/worker/test/preflight.test.ts corre runPreflight sobre PGlite (mc_app NO es miembro de mc_worker, el esquema pgboss aparece al crearlo) y fija los mensajes de explainMissing (el GRANT y el CREATE SCHEMA exactos), explainConnectionError (28P01 con usuario y host; null para cualquier otro error) y formatJobDefinitions (una línea por definición, con el host), que es lo que hacía reproducible el criterio de «dev imprime las definiciones» sin credenciales. ENDURECIMIENTO, RONDA 1 (22 de septiembre): el segmento (app) ya tiene frontera de error y esqueleto de carga propios —solo los tenía Finanzas—, así que una pantalla que falle en tiempo de petición se ve en español y DENTRO del marco de la aplicación (la barra lateral sigue ahí) en vez del documento genérico de Next en inglés; apps/web/app/(app)/frontera.test.tsx lo cubre. La portada dejó de tocar la base: abría una transacción para leer `workspace` y quedarse con el locale y la zona horaria… para formatear UNA fecha en el pie, de modo que un DEMO_WORKSPACE_ID que no corresponde a ninguna fila —lo normal en un despliegue nuevo— la tumbaba con un 500; ahora es estática y su contenido entero sale de content/backlog.ts. Higiene: UUID_RE estaba copiado en lib/workspace/current.ts y en finanzas/facturas/actions.ts pese a que @mc/db exporta isUuid; lib/format.ts formatea el dinero desde el TEXTO del decimal (Intl.NumberFormat v3) en vez de convertirlo a number y decidir los centavos con `Math.round(abs * 100) % 100`, que es justo lo que numeric(14,2) evita; y la receta `verificar` del Makefile entró en .PHONY. ENDURECIMIENTO, RONDA 2 (22 de septiembre): la frontera de error del segmento (app) dejó de enseñarle a cualquiera los nombres de dos variables de entorno del servidor. Lo que ve quien entra es una frase de producto («Vuelve a intentarlo en un momento; si sigue así, escríbenos.»); la pista de despliegue (DEMO_WORKSPACE_ID y DATABASE_URL) solo se renderiza fuera de producción —comprobado en el bundle: en la compilación de producción no queda ni una referencia a hintDespliegue— y las variables siguen en el log del servidor, que es donde ya estaban. Y la deduplicación de UUID_RE, que había quedado a medias: se borraron dos copias y la tercera seguía viva en apps/web/lib/forms.ts, que es justo la que usan los seis puntos de campanas/[id]/actions.ts; ahora lib/forms.ts reexporta isUuid y UUID_RE de @mc/db y no hay más de una definición. ENDURECIMIENTO, RONDA 3 (22 de septiembre): «Reintentar» no reintentaba. En Next 15 `reset()` solo vuelve a renderizar el segmento en el cliente con el payload que ya tiene, que es el del error: con la base caída, pulsarlo no disparaba ninguna petición (medido por CDP) y la pantalla seguía en error aunque la base hubiera vuelto. Ahora las dos fronteras —la del segmento (app) y la de Finanzas— usan useReintentar (app/(app)/_lib/reintentar.ts): router.refresh() dentro de una transición y reset() cuando llega, con el botón en espera mientras tanto; frontera.test.tsx comprueba que se llama a router.refresh en las dos. La pista de despliegue decía salir «en desarrollo y en vista previa», pero NODE_ENV se fija al compilar y las vistas previas de Vercel compilan con production: ahora la decide mostrarPistaDeDespliegue, que mira también NEXT_PUBLIC_VERCEL_ENV (sale en development y en preview, no en production), con prueba para los tres casos. Y la cuarta copia de la regex de UUID, que vivía en el worker (apps/worker/src/runner/run.ts), se cambió por isUuid de @mc/db/client: ahora sí hay una sola definición en el repositorio. ENDURECIMIENTO, RONDA 4 (22 de septiembre, rebasada sobre rasheed/integracion con Ventas dentro): las fronteras de módulo se habían separado de la de (app). Con un DEMO_WORKSPACE_ID que no corresponde a ninguna fila, /finanzas y /ventas caían en la suya y decían «la base de datos no respondió a tiempo o rechazó la conexión» —falso: la base contestó, lo que está mal es la configuración—, sin la pista de despliegue ni «Volver al plan», y la de Ventas con un reset() que no volvía a pedir nada al servidor. Ahora las tres pintan la misma frontera (app/(app)/_lib/frontera.tsx) y cada módulo solo pone su nombre y su título. frontera-ruta.test.tsx corre las pantallas reales de Finanzas y Ventas contra el embebido con un workspace que no existe, captura lo que lanzan y pinta con ESE error la frontera que Next usaría: nombra la configuración, da la pista y deja volver. Sigue bloqueada por lo mismo que en la ronda 3 (GRANT mc_worker TO mc_migrator en Supabase y el esquema pgboss). ENDURECIMIENTO, RONDA 5 (22 de septiembre): un DEMO_WORKSPACE_ID sin fila se veía de dos formas según el módulo. Finanzas y Ventas leen la fila workspace para formatear y caían en su frontera; Campañas y Conexiones no la leen y pintaban «Todavía no hay campañas» o la lista vacía, como si fuera un workspace nuevo. Ahora lo decide lib/db una vez para todos los módulos, también para el próximo: la primera transacción de cada workspace en el proceso comprueba la fila con getWorkspace y, si no existe, lanza «no existe en esta base» y la pantalla cae en la frontera del segmento (app), dentro del Shell. No va en el layout de (app) porque un error del layout lo recoge la frontera del segmento padre, que ya no pinta la barra lateral. Y Empresas y la ficha de una empresa tienen frontera propia («No pudimos leer tus empresas», «No pudimos leer la ficha de esta empresa»): la de Ventas decía «No pudimos leer tu pipeline» también ahí. frontera-ruta.test.tsx corre las seis pantallas reales (Finanzas, Ventas, Empresas, la ficha, Campañas y Conexiones) contra el embebido con un workspace que no existe y pinta con ESE error la frontera que Next usaría. Sigue bloqueada por lo mismo (GRANT mc_worker TO mc_migrator en Supabase y el esquema pgboss).",
  },
  {
    id: "CIM-2", module: "CIM", owner: "rasheed", size: "M", sprint: 1, deps: ["CIM-1"],
    title: "Cliente de base con aislamiento (RLS)",
    desc: "Cada consulta corre en una transacción que fija app.workspace_id con set_config(…, true), contra el pooler en modo transacción. Esquema Drizzle generado desde las migraciones para las tablas del MVP.",
    done: "Un test crea dos workspaces, inserta un deal en cada uno y comprueba que ninguno ve el del otro. Sin workspace_id fijado, la consulta devuelve cero filas.",
    status: "hecho",
    note: "ESTADO (22-sep): rondas 1 a 5 del endurecimiento integradas en rasheed/integracion con fase 2 y CRM; la guardia de esquema está activa y en verde sobre el esquema completo (Cotizar y CIM-3 declaran sus funciones SECURITY DEFINER, el rol mc_public_share y el índice de auth_user_id con su motivo; la web conserva INSERT en post_metric_snapshot para el CSV de RES-2). Pendientes de aplicar en Supabase (va por 0022_public_profile_access), con make db.migrate y en este orden: 0024_aislamiento_por_defecto, 0025_referencias_visibles, 0026_duenos_unicos_secuencias, 0027_sesion_correo_verificado, 0028_membership_alta_propia, 0029_supresion_verificada_filas_que_nombran y 0030_public_share (antes, el rol mc_public_share; ver su cabecera). make db.check las aplica todas en orden. Falta repetir estadoDelEsquema contra Supabase después de migrar. Cerrada el 21 de septiembre; rondas 2 y 3 el 22, la última con main (CAM-1, CAM-2, CON-3) integrado. packages/db con Drizzle (45 tablas y 8 vistas curadas desde las migraciones; test/schema.test.ts las compara columna a columna con la base y exige RLS en toda tabla de tenant o hija de una), client.ts con withWorkspace, withoutWorkspace (solo catálogos: company y contact NO lo son, se leen por company_link) y asWorker (SET LOCAL ROLE mc_worker; probado también que mc_app no puede asumirlo), timeouts por transacción, manijas que lanzan TransactionClosedError tras el cierre, NestedTransactionError si se anida una transacción, conexión destruida si el ROLLBACK falla, TLS con la CA de db/certs, y Postgres embebido que corre como mc_app con el mismo runner de migraciones que Supabase (db/lib/aplicar.mjs, que ahora se niega si dos archivos comparten número). Las consultas de CAM-2 y CON-3 se conservaron (isUuid/UUID_RE salen de client.ts) y campanas/conexiones/finanzas.test.ts corren sobre test/pglite.ts; el CI las corre además contra Postgres 16 con un rol mc_app_ci (TEST_DATABASE_URL), que es lo que ejercita el runner de pg. README.md con los cinco usos; los operadores de Drizzle salen de @mc/db y las consultas por @mc/db/queries/<módulo> (la raíz reexporta las de Finanzas, Conexiones y Campañas por compatibilidad). Migraciones pendientes de aplicar en Supabase por el integrador, en el mismo PR de la fusión (make db.migrate): 0017 (RLS en outbound_policy, antes 0015: desde entonces exige withWorkspace, aviso a los dueños de Ventas) y 0018 (antes 0016: RLS heredada en quote_item, rate_card_item, deal_stage_history, campaign_post y las hijas de video_analysis/script/idea: desde B se leían los precios de A); comprobar después relrowsecurity = true en esas cinco tablas y no cargar clientes reales antes. membership sigue sin RLS hasta CIM-3 y contact/app_user hasta VEN-1 (test.todo visibles; propuesta de política en docs/backlog-mvp.md §8.4 fila 2c). Lo que queda para Nicolás está en CON-2b. RONDA 4 (22 de septiembre): migración 0019 (membership y contact con RLS: ya no queda ninguna tabla con workspace_id sin política, y contact —correo, teléfono, LinkedIn— solo se ve si su fuente es pública o si company_link la vincula a mi workspace; la función current_user_id() queda lista para CIM-3 y devuelve NULL hasta entonces); un `?sslmode=…` en DATABASE_URL ya no puede ganarle a la CA del repositorio (pg re-parsea la cadena DESPUÉS de la configuración: no-verify apagaba la verificación, disable mandaba texto plano a Supabase y require descartaba la CA embebida — resolveTls lanza con instrucciones, y en un host sin CA propia traduce el parámetro y lo borra de la URL); el worker importa tlsFor/hostOf/resolveTls de @mc/db y borró su copia (era CON-2b); `withoutWorkspace` se llama `withCatalogs`, sale del barril y en su lugar está queries/catalogos.ts con las siete lecturas con nombre; queries/cimientos.ts (getWorkspaceSettings) es la costura de moneda, zona horaria y locale del workspace, que lib/format.ts, /finanzas y createInvoice ya usan en vez de es-CO y COP fijos; raw/admin dentro de una transacción de PGlite lanzan en vez de colgarse para siempre; lib/db ya no exporta el cliente crudo (getDbMode/closeDb); y hay pruebas nuevas de TLS, de las dos políticas de 0019 y de los helpers de queries (listPostBoard, getCurrentRateCard, getWorkspaceSettings, catálogos). Migraciones pendientes para el integrador: 0017, 0018 y 0019. RONDA 5 (22 de septiembre): migración 0020, que cierra lo que 0019 dejó abierto y todo lo reprodujo antes una prueba en packages/db/test/rls.test.ts. (1) contact se aislaba por company_link, y company es un catálogo global sin RLS: a B le bastaba insertarse UNA fila de company_link para leer el correo y el teléfono que guardó A, y como la política era única, permisiva y FOR ALL, su rama pública servía también de escritura (B cambiaba el correo de un contacto de A, lo borraba, o le colgaba uno nuevo marcándolo 'press'). Ahora contact lleva owner_workspace_id con DEFAULT current_workspace_id() y dos políticas, lectura (público o mío) y escritura (mío, y con la empresa vinculada); un trigger impide que opted_out vuelva a false, y la baja de un contacto ajeno la registra el worker con asWorker, porque en Postgres un UPDATE con WHERE tiene que poder LEER la fila y abrir eso sería abrir la PII. (2) app_user tenía RLS aplazada a CIM-3 «porque el seed lo inserta antes que su membership»: se resuelve con dos políticas (SELECT «soy yo o comparto workspace» e INSERT abierto), así que ya no queda ninguna tabla con datos personales sin política y el test.todo se convirtió en prueba. (3) pipeline_stage y feature_flag llevan RLS: B leía las etapas privadas de A y podía encenderle feature_flag('outbound_send') a otro workspace; listPipelineStages / listFeatureFlags perdieron el parámetro workspaceId y ahora reciben la transacción. Además: la guardia de TLS vigila los seis parámetros de la URL, no dos (sslrootcert sustituía la CA del repositorio por la del archivo que dijera la URL, y sslnegotiation=direct la perdía; medido con el pg instalado); createPool deja siempre un oyente de 'error' en el pool, porque una conexión OCIOSA rota tumbaba el proceso de Next entero con ERR_UNHANDLED_ERROR; createDbFromEnv comprueba al arrancar que la base tenga las migraciones y la RLS que el paquete declara (assertSchemaUpToDate en src/esquema.ts: avisa en desarrollo, lanza en producción, y el worker pregunta lo mismo en su preflight) — hasta ahora el aviso de «Supabase va por la 15 y el repo por la 19» vivía en esta nota, que nadie lee en tiempo de ejecución; un builder de Drizzle capturado dentro de la transacción y esperado fuera ya lanza TransactionClosedError; y los helpers de queries/ validan los ids que llegan de una ruta (getCurrentRateCard, getPipelineDeal y getInvoice devuelven null en vez de un 22P02 convertido en 500). En la web, formatterFor dejó de estar solo citada: el plan, Finanzas y el detalle de factura formatean con el locale, la moneda Y la zona horaria del workspace, y lib/format.test.ts falla si alguna de las tres vuelve al valor por defecto. Migraciones pendientes para el integrador: 0017, 0018, 0019 y 0020, en ese orden, y ANTES del siguiente despliegue a producción: desde esta ronda la web no arranca con NODE_ENV=production contra una base sin ellas (dice cuáles faltan y qué tablas se quedaron sin RLS; la salida explícita, para un despliegue que no puede esperar, es ALLOW_STALE_SCHEMA=1). INTEGRACIÓN (22 de septiembre, rasheed/integracion): 0016 a 0021 aplicadas en Supabase con make db.migrate; 89 tablas, 10 vistas, 217 índices. La 0021 nació en la integración: 0020 dejó app_user sin política de UPDATE a propósito y el seed 0002 refresca last_seen_at con ON CONFLICT DO UPDATE, que Postgres rechaza ya en la primera pasada aunque no haya fila con la que chocar. Es la línea que 0020 anunciaba para CIM-3 (id = current_user_id()), y el seed pasa a fijar app.user_id junto a app.workspace_id; DELETE sigue sin política. ENDURECIMIENTO, RONDA 1 (22 de septiembre, rasheed/endurecer-db): la fase 1 gastó cinco rondas tapando agujeros de RLS de uno en uno y cada ronda encontró los siguientes, siempre del mismo tipo. La causa raíz era la guardia: packages/db/src/esquema.ts preguntaba «¿estas 53 tablas que yo enumero tienen RLS?», así que una tabla nueva sin política pasaba en verde por no estar en ninguna lista. Ahora la guardia está INVERTIDA: trae de pg_class TODAS las tablas de public y exige aislamiento (ENABLE + FORCE + al menos una política) en todas, con una lista corta de EXCEPCIONES_SIN_AISLAMIENTO que lleva el motivo escrito de cada una; una tabla nueva sin política y sin excepción declarada rompe la prueba, y una excepción que ya no corresponde también. Con la guardia puesta salieron nueve tablas que nadie había mencionado, y la migración 0024 las cierra todas: (1) `workspace`, la raíz del inquilino —sin RLS y con los cuatro privilegios— se leía, se renombraba y se BORRABA desde cualquier transacción de la aplicación, con cascada a todos sus datos; se escapaba porque la prueba solo miraba una columna llamada workspace_id y aquí la clave se llama id. Ahora lleva SELECT/UPDATE/INSERT por política y ninguna de DELETE, más el REVOKE. (2) membership: su política era FOR ALL sin WITH CHECK, así que desde B se colgaba a CUALQUIER user_id dentro de B y app_user_read abría acto seguido su correo; se parte en lectura y alta, y mc_app pierde INSERT/UPDATE/DELETE (el alta es del worker y del seed hasta CIM-3). (3) app_user_insert era WITH CHECK (true): con el enlace mágico de CIM-3, que casa por correo, una fila precreada con el correo de la víctima es una apropiación de cuenta; ahora el alta solo pasa sin workspace fijado o siendo uno mismo. (4) company se escribe desde el CRM: lleva owner_workspace_id con DEFAULT current_workspace_id() y dos políticas, lectura abierta (el directorio de empresas es compartido: dos workspaces pueden trabajar con la misma marca; esa lectura abierta la sustituyó la ronda 2 por «la empresa con la que trabajo», y la ronda 3 por «sin dueño o mía») y escritura solo del dueño, que es lo que impedía que B renombrara o BORRARA —con sus contactos por cascada— una empresa de A. (5) api_call_log y api_quota_usage cuelgan de social_connection y no llevaban política: desde B se leían los endpoints y los mensajes de error de A. (6) las hijas con clave ajena OPCIONAL que 0018 aplazó (brand_account_snapshot, trait_lift, external_post y las dos hijas de external_post) heredan ya del padre con la rama «fk IS NULL». Y la mitad que RLS no cubre: mc_app tenía SELECT/INSERT/UPDATE/DELETE sobre las 89 tablas, así que una transacción cualquiera de la web cambiaba los límites de TikTok, apagaba un job o reescribía una regla del preflight para TODOS; 0024 deja los mínimos tabla por tabla (PRIVILEGIOS_DE_LA_APP los declara con su motivo y la guardia los comprueba en cada arranque, también contra Supabase). packages/db/test/rls.test.ts reproduce cada camino desde el ataque —leer, escribir y borrar desde el workspace equivocado— para workspace, membership, app_user, company, los catálogos, api_call_log y api_quota_usage. Dos cosas más que el cambio destapó: createEmbeddedDb concedía `GRANT … ON ALL TABLES` DESPUÉS de migrar, así que sobre pglite devolvía en silencio todo lo que una migración revocara (ahora usa ALTER DEFAULT PRIVILEGES antes de crear nada, que es como está Supabase); y getWorkspace volvía a filtrar en JavaScript con eq(workspace.id, tx.workspaceId), lo que parecía prueba de aislamiento y no lo era. Migración pendiente para el integrador: 0024 (make db.migrate). NO se aplicó a Supabase desde esta rama. ENDURECIMIENTO, RONDA 2 (22 de septiembre): la ronda 1 invirtió la guardia y los revisores encontraron la misma clase una capa más abajo. (1) La guardia solo le preguntaba a la base por TABLAS, y las diez VISTAS de public quedaban fuera de las dos mitades. En Postgres una vista es SECURITY DEFINER por omisión: lee sus tablas base con los privilegios de su dueño, mc_migrator, así que rodea el muro de privilegios de 0024 §7 (medido: una vista sobre `niche` deja hacer UPDATE a mc_app, y una sobre webhook_event deja leerla). 0024 §8 les pone security_invoker en un bucle sobre pg_class —no en una lista de diez nombres— y la guardia trae ahora relkind 'v' y exige security_invoker o entrada en VISTAS_SIN_INVOCADOR con motivo. (2) La guardia fallaba ABIERTA: las consultas del inventario terminaban en `.catch(() => [])`, así que un permiso que falte, un statement_timeout o un pooler que corte dejaban todas las listas vacías y explicarEsquema devolvía null; el arranque daba verde afirmando que toda tabla está aislada cuando lo que pasó es que no pudo preguntar. Ahora el error se anota en `inventarioLeido` y en producción lanza igual que con migraciones pendientes. (3) Contar políticas no bastaba: una tabla con `USING (true)` tenía RLS, FORCE y una política y no aislaba nada. La guardia lee pg_policy con pg_get_expr y exige que al menos una política mencione current_workspace_id(), current_user_id() o una subconsulta al padre; las que sean `true` a propósito se declaran en POLITICAS_ABIERTAS_DECLARADAS, que hoy está vacía. (4) El invariante «toda excepción está además en PRIVILEGIOS_DE_LA_APP» estaba escrito y no lo comprobaba nadie: ahora sí (excepcionesSinPrivilegios). (5) company_read era `USING (true)`, así que desde un workspace cualquiera se enumeraba la lista de prospectos de una agencia con su razón social —el dato que 0020 cerró en contact—. Ahora la regla es «la empresa con la que TRABAJO»: sin dueño (catálogo compartido), mía, vinculada por company_link, o con un deal, una campaña, una factura o un reporte míos. Acotarla solo a company_link se probó y NO sirve: una campaña cuya empresa no esté vinculada desaparece de su propia pantalla porque listCampaigns hace JOIN company. La lista de puertas la vigila una prueba que recorre pg_constraint: toda tabla con company_id tiene que estar nombrada en la política o declarada con su motivo (así salieron report y report_schedule, que nadie había mencionado). (6) getWorkspace perdió su WHERE en la ronda 1 y quedaba dependiendo al 100% de que 0024 esté aplicada, con ALLOW_STALE_SCHEMA=1 como ventana documentada: ahora comprueba que la fila que vuelve sea la del workspace de la transacción y lanza nombrando la migración si no. (7) El índice `external_post_snapshot_post_id_idx` de la ronda 1 era un duplicado exacto del que 0004 ya crea (IF NOT EXISTS compara nombres, no definiciones) sobre la tabla que más escribe el radar: borrado. Y (8) la sección 6 de 0024 —las cinco hijas con clave ajena opcional— era la única parte sin prueba desde el ataque: rls.test.ts la cubre familia por familia, incluida la rama `fk IS NULL`. Migración pendiente para el integrador: 0024 (make db.migrate), verificada con make db.check (22 migraciones, 89 tablas, 10 vistas, 218 índices). NO se aplicó a Supabase desde esta rama. ENDURECIMIENTO, RONDA 3 (22 de septiembre): los revisores encontraron la misma clase —algo sin declarar pasa en verde— en tres capas que la guardia todavía no miraba, y las tres quedan cerradas por la guardia y no por una lista. (1) LAS REFERENCIAS. Postgres comprueba una clave ajena sin RLS, así que una fila puede nombrar otra que su transacción no ve: desde B, `SELECT DISTINCT company_id FROM contact` (los contactos públicos de A) seguido de un company_link por cada id abría, por la rama «vinculada» de company_read, las empresas de A con su dueño (antes 0 filas, después 6); igual con un deal, una campaña, una factura, un reporte o una programación. Y no era cosa de company: una etapa privada de A en deal.stage_id (NO ACTION: A ya no podía borrarla) o un deal de A en quote.deal_id pasaban igual. La migración 0025 añade assert_reference_visible, un disparador SECURITY INVOKER que exige que la fila referenciada sea visible para quien escribe, y lo engancha en un bucle sobre pg_constraint a todas las claves ajenas hacia tablas con RLS de las tablas que mc_app escribe; da 23503, el mismo error que un id inexistente, así que no es un oráculo nuevo, y solo comprueba la columna cuando cambia. La guardia exige el disparador en toda clave de ese tipo que exista mañana (referenciasSinComprobar). Con eso company_read queda en «sin dueño o mía», el dominio pasa a ser único por dueño (el índice global de 0007 le confirmaba a B que otra agencia tenía esa marca, y le impedía dar de alta la suya) y contact_read deja de enseñar a todos los contactos públicos que guardó un workspace: lo compartido son las filas sin dueño del catálogo. (2) LAS POLÍTICAS. Las permisivas se combinan con OR, y la guardia daba la tabla por aislada si ALGUNA mencionaba el inquilino: `USING (1 = 1)` junto a una buena, `current_workspace_id() IS NOT NULL` o un `FOR DELETE USING (workspace_id IS NOT NULL)` pasaban en verde (y B leía o BORRABA lo de A). Ahora packages/db/src/politicas.ts evalúa cada política permisiva, por cada comando que mc_app tiene concedido: aísla una igualdad de columna con current_workspace_id() o current_user_id(), o un EXISTS correlacionado sobre una tabla a su vez aislada (con un punto fijo, así que una política abierta contagia a las hijas que la miran), y la rama «sin dueño» solo vale para leer. schema.test.ts dejó de tener su propia copia de la regex. Eso destapó que las altas «sin workspace fijado» (etapas y banderas globales, empresas del catálogo, app_user, workspace) eran de mc_app: withCatalogs existe en el objeto que recibe la web, así que no era una frontera. 0025 las deja TO CURRENT_USER (el rol que migra) y a mc_app solo su fila y su workspace; la única política abierta declarada es el alta de api_call_log sin conexión (el OAuth que falla). (3) LO QUE NO ES TABLA. Vistas materializadas y tablas foráneas (sin RLS posible: medido, una materializada sobre webhook_event le daba a mc_app las cabeceras con firmas), funciones SECURITY DEFINER, TRUNCATE, TRIGGER, REFERENCES y MAINTAIN de mc_app, y cualquier otro rol con privilegios en public (PUBLIC incluido; en Supabase solo aparece service_role, declarado con su motivo). Además: las métricas propias, job_run y sus derivadas pasan a solo lectura para mc_app, y audit_log a SELECT + INSERT (la regla append-only se aplicaba solo a las de terceros); account_metric_snapshot conserva INSERT y UPDATE porque CON-10, en main, guarda desde la web el snapshot del día con un upsert. La guardia distingue ya «la base no contesta» (no dice «nunca se migró» ni manda a migrar) de «no existe schema_migrations» (42P01). NUMERACIÓN: la 0022 de las rondas 1 y 2 pasa a llamarse 0024 —no está aplicada en ninguna parte—, porque main aplicó en Supabase 0022_public_profile_access (CON-10) y reservó 0023 para ACC-3; con dos 0022 el runner se niega a correr. packages/db/test/aplicar.test.ts declara esos dos números como huecos de otras ramas. Migraciones pendientes para el integrador: 0024 y 0025 (make db.migrate), verificadas con make db.check (89 tablas, 10 vistas, 219 índices). NO se aplicaron a Supabase desde esta rama. ENDURECIMIENTO, RONDA 4 (22 de septiembre, rebasada sobre rasheed/integracion): la misma clase en cinco capas más, y la guardia las mira todas. (1) FILAS HEREDADAS: 0024 dejaba sin dueño las empresas que ya existían «porque una migración no puede leer company_link», y era falso (el rol que migra es dueño de las tablas y puede quitar FORCE dentro de la transacción). Con 0024 + 0025 tal cual, las 11 empresas de Supabase —todas de Laura— pasaban al catálogo compartido: un workspace nuevo leía qué marcas trabaja la agencia y Laura no podía editar ninguna. 0026 §1 las adjudica por votos (toda fila con clave hacia company y columna de inquilino, recorridas en pg_constraint): de un solo workspace, suya; de varios, una ficha por workspace con sus filas repuntadas; de ninguno, catálogo. rls.test.ts reconstruye la base hasta 0021 con filas de la forma vieja, comprueba que el agujero existe con 0024 y 0025, y que 0026 lo cierra (y que el FORCE vuelve a las mismas tablas). Ensayado además contra Supabase dentro de una transacción con ROLLBACK: 11 de 11 quedan de Laura y la guardia no reporta nada. (2) ÍNDICES ÚNICOS: un único global sobre una tabla con dueño es un oráculo que no pasa por RLS (desde B, guardar el correo de un contacto de A daba 23505 contact_email_idx). La guardia recorre todos los únicos y de exclusión (unicosSinInquilino) y exige la columna de inquilino, una clave hacia una tabla aislada, un parcial sobre las filas sin dueño o la clave sustituta; lo global a propósito va en UNICOS_GLOBALES_DECLARADOS con su motivo. Salieron contact.email, video_asset.content_hash y —sin que nadie lo hubiera nombrado— pipeline_stage.id, cuyo id de etapa privada era un nombre legible; 0026 §2 los hace por dueño y obliga por CHECK a que el id de una etapa privada sea un uuid al azar. La baja global, que dependía del correo único, pasa a contact_suppression (sin workspace, sin privilegios para mc_app, llenada y aplicada por dos disparadores SECURITY DEFINER sin EXECUTE para mc_app). (3) GRANT POR COLUMNA: la guardia solo leía pg_class.relacl y `GRANT UPDATE (slug) ON niche TO mc_app` pasaba en verde; ahora lee también pg_attribute.attacl y los trata como de tabla. (4) CORRELACIONES: un EXISTS contaba como aislado con igualar CUALQUIER columna (`d.name = t.nota`); ahora el par tiene que ser una clave ajena real (en cualquiera de los dos sentidos) o la clave de inquilino de los dos, y un padre con filas globales no aísla una fila que tiene inquilino propio. (5) SECUENCIAS: mc_app leía last_value de todas (el volumen de la plataforma entera); 0026 §4 le deja solo USAGE y solo donde inserta, y la guardia las mira como a las tablas. En Ventas: la prueba de VEN-1 que esperaba ver los contactos públicos de otro workspace pasa a la semántica de 0025 §6 (se ve el catálogo sin dueño; lo que guardó otro, no), listContacts devuelve isOwn false —no null— en el catálogo, la ficha lo explica como «del catálogo compartido», el duplicado de correo se busca solo entre los míos, y editar la ficha de una empresa del catálogo dice CompanyNotEditable en vez de «guardado» con cero filas. Migraciones pendientes para el integrador: 0024, 0025 y 0026, juntas y en ese orden (make db.migrate), verificadas con make db.check (90 tablas, 10 vistas, 223 índices). NO se aplicaron a Supabase desde esta rama. ENDURECIMIENTO, RONDA 5 (22 de septiembre): los revisores encontraron lo que corre con los privilegios de OTRO sin pasar por un GRANT, y lo que la forma de una política no decía; la guardia mira ahora las dos cosas y con eso encontró dos casos más que nadie había nombrado. (1) LA BAJA GLOBAL: con 0026 §3 cualquier workspace escribía en contact_suppression (bastaba un contacto propio con opted_out) y desde entonces el contacto de A con ese correo nacía dado de baja con un motivo inventado; una agencia saboteaba el outreach de otra, para siempre. 0029 §1 quita el disparador que la llenaba: la lista la llena SOLO el worker con una baja verificable de la propia persona (unsubscribe_link, hard_bounce, complaint, por CHECK), y la baja que marca un workspace se queda en su contact.opted_out. (2) EL PUNTO CIEGO: la guardia solo miraba las funciones SECURITY DEFINER que mc_app podía EJECUTAR, pero Postgres no mira EXECUTE al disparar (medido: un disparador definer en company reescribía niche con la guardia en verde). Ahora inventaría TODA función definer de public y todo disparador que llame a una (DISPARADORES_DEFINER_DECLARADOS: queda contact_suppression_apply, con su motivo), las reglas CREATE RULE (REGLAS_DECLARADAS), los esquemas fuera de public a los que llega mc_app y CREATE en public (ESQUEMAS_DECLARADOS), y el propio rol mc_app: sin SUPERUSER, BYPASSRLS ni CREATEROLE y sin ser miembro de ningún rol (con GRANT mc_worker TO mc_app, SET ROLE mc_worker lo leía todo y la guardia no lo nombraba). (3) LA FORMA: un EXISTS solo aísla con una constante en la lista (`SELECT count(*)` sin GROUP BY es verdadero para toda fila) y sin GROUP BY, HAVING, UNION, LIMIT…; `col = current_workspace_id()` solo si col es la columna de inquilino; `col = current_user_id()` solo si col nombra a una persona y, en una tabla con inquilino, junto al inquilino en un AND o declarada (AISLADAS_POR_PERSONA_DECLARADAS: membership.user_id, la lista de mis workspaces). (4) LO QUE NOMBRA UNA FILA GLOBAL: la rama «IS NULL» de una lectura tiene que correlacionar cada otra clave hacia una tabla con RLS. Salieron brand_account_snapshot (sin campaña enseñaba handle y seguidores de empresas privadas) y contact_read (un contacto del catálogo de una empresa adjudicada a un workspace), cerrados en 0029 §3. (5) BORRAR NO PUBLICA: una clave ON DELETE SET NULL sobre la columna de una rama «IS NULL» publica la fila al borrar el padre (borradosQuePublican). Salieron company.owner_workspace_id —borrar un workspace publicaba su CRM— y external_post.analysis_id; 0029 §2 las pasa a CASCADE. Cada agujero tiene su prueba en rls.test.ts (falla contra el esquema de 0026 y pasa con 0029) y cada forma de la guardia su sonda en esquema.test.ts, incluida una base reconstruida hasta 0026 en la que la guardia, sin tocarla, nombra lo que 0029 cierra. CONTRA SUPABASE: la base real va por 0022_public_profile_access; la guardia nueva no encuentra allí ninguna función definer, ningún disparador definer, ninguna regla, ningún esquema de más ni nada en el rol mc_app, y todo lo demás que reporta lo cierran 0024–0029. Ensayadas 0024, 0025, 0026 y 0029 dentro de UNA transacción como mc_migrator con ROLLBACK (lock_timeout 5 s): la guardia, en esa transacción, da sinAislar, politicasAbiertas, disparadores, reglas, esquemas, rol, borrados, vistas, referencias, únicos, privilegios y roles vacíos, con 76 tablas aisladas; después schema_migrations sigue en 22. Falta que el integrador, tras fusionar con main y correr make db.migrate, repita estadoDelEsquema (o assertSchemaUpToDate con production:true) y deje aquí la salida. NUMERACIÓN: la nueva es 0029 porque 0027 y 0028 son de CIM-3; la 0026_public_share de Cotizar pasó a 0030_public_share al integrar (ver ESTADO arriba).",
  },
  {
    id: "CIM-3", module: "CIM", owner: "rasheed", size: "M", sprint: 1, deps: ["CIM-2"],
    title: "Autenticación y workspaces",
    desc: "Supabase Auth con correo y enlace mágico. Al entrar se crea app_user y membership; si no hay workspace, se crea uno de tipo creador con su creator_profile. Cambio de workspace en la barra.",
    done: "Se entra con un correo nuevo y aparece un workspace vacío con nombre; se entra con uno del seed y aparece la creadora ficticia.",
    status: "hecho",
    note:
      "Hecha e integrada con el endurecimiento. Pulido r1 (22-sep): CAPTCHA Turnstile listo en /login, el correo de la sesión en el selector y /auth/comprobar contra el login CSRF, /auth/salir cierra una sesión en conflicto, contacto de soporte en los errores, y 0024/0028 se paran si se aplican al revés. Pendiente de aplicar: 0027 y 0028, detrás de 0024–0026 (orden de la nota de CIM-2). A mano: panel de Supabase (Redirect URLs, plantilla, Confirm email), SUPPORT_EMAIL y APP_URL en Vercel, y SMTP + CAPTCHA en CIM-10; visto bueno de Nicolás al Shell bajado a app/(app)/layout.tsx y a <Marca enMarco /> en shell.tsx. Detalle: apps/web/README.md#autenticación.",
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
    note: "POSPUESTA a una versión avanzada (decisión del 22-sep): el MVP agrega cuentas por @ con datos públicos (CON-10); esta autorización queda detrás de la bandera oauth_connect (OAUTH_CONNECT=1). Código completo y probado con respuestas grabadas: cifrado AES-256-GCM (HKDF, AAD = secret_ref, rotación de clave), tabla connection_secret (migración 0015, RLS en FORCE, aplicada en Supabase el 21-sep), EncryptedSecretStore, OAuth de TikTok Login Kit e Instagram Login (Accounts API detrás de TIKTOK_BUSINESS_APP_ID hasta CON-9), rutas start/callback con cookie sellada de 10 minutos, data_consent con evidencia, pantalla mínima de /conexiones y oauth.refresh con los refreshers reales. La prueba clave vuelca todas las columnas de texto de todas las tablas y no encuentra ningún token. En main y desplegada en producción el 22-sep con TOKEN_ENCRYPTION_KEY y APP_URL en Vercel. Bloqueada solo por la prueba en vivo: falta el acceso de desarrollador a las apps de TikTok y Meta (backlog §9.4 fila 15); el paso a paso está en docs/propuestas/CON-3.md §5.",
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
    note: "En main el 22-sep. Probado con respuestas grabadas (connectors 180, db 46, worker 31, web 119) y con el volcado de todas las columnas de texto sin credenciales. Comprobado desde servidor que el HTML público de TikTok e Instagram no sirve (reto anti-bot y muro de login): por eso solo fuentes oficiales. Para la prueba real faltan dos configuraciones de Nicolás: INSTAGRAM_HOUSE_TOKEN (token de su cuenta profesional, generado en el App Dashboard de Meta) y GOOGLE_API_KEY; TikTok se agrega ya, sin métricas. DECIDIDO el 22-sep: las métricas de TikTok entran por el CSV de TikTok Studio (RES-2, gratuito) y el proveedor de pago queda como opción futura (CON-12). Detalle en docs/propuestas/CON-10.md.",
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
    note: "Asistente de 4 pasos en /resumen/importar: guarda con la fecha de exportación y nunca hacia atrás (el paso 3 ya avisa qué no se guardará), lee Windows-1252 y no duplica una cuenta que ya existe. El mapeo manual es el camino: ninguna plataforma documenta su cabecera (docs/fases-rasheed.md §8).",
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
    status: "en_curso",
    note: "Lista para integrar en rasheed/VEN-1-crm-base (22 de septiembre): /ventas/empresas con búsqueda desde el tercer carácter (en la URL, ?q= y ?rel=), «Nueva empresa» (un dominio ya vinculado se marca en su campo), ficha con relación editable, negocios y contactos; añadir contacto exige procedencia y la baja pide confirmación y solo se ofrece en los propios. Comprobado de punta a punta en el navegador contra el seed: una empresa con dos contactos aparece al tercer carácter. La RLS de contact ya NO es parte de esta historia: la adelantaron las migraciones 0019 y 0020 en las rondas 4 y 5 de CIM-2. Lo que hay que saber para la pantalla: el candado es contact.owner_workspace_id, que pone la base sola (DEFAULT current_workspace_id()) —nunca se escribe a mano—; se lee lo público (source public_website/public_profile/press) más lo propio; se escribe solo lo propio y solo sobre una empresa que este workspace tenga en company_link; y opted_out no vuelve a false (un trigger lo impide), así que la baja de un contacto ajeno la registra el worker con asWorker, no la pantalla. Los casos están en packages/db/test/rls.test.ts. Aquí queda la pantalla: los contactos se leen y se escriben dentro de withWorkspace y la política hace el resto.",
  },
  {
    id: "VEN-2", module: "VEN", owner: "rasheed", size: "M", sprint: 1, deps: ["VEN-1"],
    title: "Radar manual y por CSV",
    desc: "Bandeja de signal con estado pendiente, aceptar (crea o actualiza empresa y deal en nuevo) o descartar con motivo. Fuente manual y carga por CSV de una lista de marcas. Las fuentes automáticas quedan para fase 2.",
    done: "Aceptar una señal crea el deal con «Enviar pitch» como siguiente acción; descartarla la saca de la bandeja y no vuelve a entrar (dedupe_key).",
    status: "en_curso",
    note: "Lista para integrar en rasheed/VEN-1-crm-base (22 de septiembre): «Anotar una marca» y «Cargar una lista» (CSV subido o pegado, con , o ; y cabecera en español o inglés; las filas sin marca se listan con su línea) en /ventas; aceptar abre el negocio con «Enviar pitch» y enlaza al pipeline; descartar pide motivo. Una marca ya vista, aunque se haya descartado, no vuelve a entrar ni a mano ni por lista. La bandeja muestra el nombre de las señales que aún no tienen empresa (salía «Marca sin identificar»).",
  },
  {
    id: "VEN-3", module: "VEN", owner: "rasheed", size: "L", sprint: 2, deps: ["VEN-1"],
    title: "Pipeline kanban y lista",
    desc: "Tablero por etapa y vista de lista sobre deal_pipeline. Arrastrar cambia la etapa y escribe deal_stage_history con los días en la etapa. KPIs: deals abiertos, cierre ponderado, ganado en el trimestre.",
    done: "Mover un deal a «Ganado» fija won_at; el cierre ponderado cambia al mover entre etapas.",
    status: "en_curso",
    note: "Lista para integrar en rasheed/VEN-1-crm-base (22 de septiembre): tablero con arrastrar y soltar y un menú «Mover a» por tarjeta para teclado y lector de pantalla, movimiento optimista que vuelve solo si el servidor lo rechaza, y vista de lista (?forma=lista). Los montos por etapa y los KPI llegan de SQL. Comprobado en el navegador: mover a «Ganado» persiste tras recargar.",
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
    done: "Con las views del mock salen los rangos del mock; cambiar el CPM cambia el rango y la explicación lo dice.",
    status: "hecho",
    note: "Rango por entregable y paquetes con la fórmula de packages/core/src/tarifas.ts, la misma en la pantalla y al guardar; «Cómo se calcula» bajo su fila, precio y CPM a mano marcados, rango al revés bloqueado en todas las capas (más un CHECK en 0030). Pulido r1: guardar ya no desmarca las casillas de condiciones y paquetes (sin el reinicio de <form action>); los modificadores quedan en cada entregable y paquete (RateCardItem.modifierIds); los campos vacíos muestran «p. ej. 25.000» o «CPM bajo» en vez de «0»; queries/cotizar partido por pieza sin cambiar su API.",
  },
  {
    id: "COT-2", module: "COT", owner: "rasheed", size: "M", sprint: 3, deps: ["COT-1", "RES-1"],
    title: "Media kit público",
    desc: "Foto congelada de los números en media_kit.snapshot, página pública por slug, opcional con contraseña y vencimiento. Contador de vistas.",
    done: "El enlace abre sin sesión, muestra las cifras congeladas, y no cambia aunque cambien las métricas.",
    status: "hecho",
    note: "/kit/<slug> sin sesión sobre public_media_kit() (0030, rol mc_public_share). Contraseña de 8+ signos guardada como huella; bloqueo de 15 min tras 10 fallos en la base; el freno de 5 por minuto del servidor es por instancia y de mejor esfuerzo (documentado en 0030 y el README). Vista previa y robots no cuentan visitas. Pulido r1: bajo las tarifas dice qué condiciones ya incluyen los rangos; la pastilla de red no se estira; la hora del bloqueo sale de lib/format.ts; la lista distingue por hora; las páginas públicas tienen esqueleto de carga.",
  },
  {
    id: "COT-3", module: "COT", owner: "rasheed", size: "L", sprint: 4, deps: ["COT-1", "VEN-3"],
    title: "Cotización",
    desc: "Crear desde un deal, ítems desde el tarifario, subtotal, descuento, impuesto y total. Lo que se acuerda antes de publicar: métricas a reportar, cortes (24 h, 7 d, 30 d), derechos, exclusividad, plazo de pago. Numeración COT-2026-014.",
    done: "Enviar pasa el deal a «Propuesta enviada»; la cotización tiene su enlace público.",
    status: "hecho",
    note: "Ciclo draft → sent → viewed → accepted/rejected/expired con una fecha por estado y transiciones con la fila bloqueada; entregables del tarifario, impuesto del workspace, numeración COT-AAAA-NNN. Pulido r1: elegir un entregable cuyo precio cobra exclusividad o derechos sube esos días en «Lo acordado» y lo dice en la línea (createQuote hace lo mismo si no se le pasan); preselecciona el media kit más reciente sin contraseña y avisa si el elegido la tiene; el detalle cabe a 400 px (total de la línea siempre visible, historia en el mismo dibujo) y oculta «Válida hasta» cuando ya está cerrada.",
  },
  {
    id: "COT-4", module: "COT", owner: "rasheed", size: "M", sprint: 4, deps: ["COT-3", "CAM-2"],
    title: "Aceptación crea la campaña",
    desc: "Al marcar aceptada, llama a createCampaignFromQuote() de queries/campanas.ts (la escribe Nicolás en CAM-2) y pasa el deal a «Ganado». Es el punto de cruce entre las dos cadenas.",
    done: "Aceptar una cotización deja una campaña en planned y Nicolás la ve en su módulo sin tocar nada.",
    status: "hecho",
    note: "Aceptar crea la campaña de CAM-2 sin segundo clic, desde el panel (misma transacción, con SAVEPOINT si faltan fechas) y desde el enlace con firma; aviso al creador y la marca que llega tarde lee qué pasó. Pendiente humano: crear el rol mc_public_share con supabase-admin y aplicar 0030 en Supabase, la última de la cola 0024–0030 (ver la nota de CIM-2).",
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
    status: "pendiente",
    note: "Va en el sprint 3 a propósito: fija los nombres antes de que Campañas y Finanzas tengan sus Server Actions escritas. Después cuesta diez veces más.",
  },
  {
    id: "ACC-2", module: "ACC", owner: "nicolas", size: "S", sprint: 3, deps: ["CIM-2"],
    title: "Bitácora obligatoria",
    desc: "withAudit() en packages/db: toda escritura de dinero, publicación o cuenta conectada deja su fila en audit_log con actor, before y after.",
    done: "Crear una factura y conectar una cuenta dejan su fila; una prueba recorre las escrituras de queries/ y falla si alguna no audita.",
    status: "pendiente",
    note: "audit_log no se puede rellenar hacia atrás: o se escribe desde la primera Server Action o no existe.",
  },
  {
    id: "ACC-3", module: "ACC", owner: "nicolas", size: "M", sprint: 4, deps: ["ACC-1", "CIM-3"],
    title: "Esquema de accesos (migración 0023)",
    desc: "0023_access_control.sql: permission, role, role_permission, membership.role → role_id, membership_scope, invitation, workspace_grant y audit_log.on_behalf_of_workspace_id. Más la semilla de los roles de fábrica.",
    done: "Migra en limpio y en Supabase; el seed deja los cinco roles de creador y los cinco de agencia con su matriz.",
    status: "pendiente",
    note: "El SQL y la semilla los escribe Nicolás y los revisa y aplica Rasheed (regla de db/migrations/ en §3.1); el esquema Drizzle es de Rasheed. Va en el sprint 4 y no en el 5 por riesgo: ACC-4 no puede empezar sin la tabla.",
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
