# Sprint 1 · Prompts de Nicolás

Cinco historias en tres módulos independientes. Cada prompt se corre en su
propia rama, desde `rayit/platform`, en **modo plan** (todos exigen leer y
proponer antes de escribir). Un prompt = una sesión de Claude Code.

| Módulo | Historias | Rama |
|---|---|---|
| A · Interfaz | CIM-4, CIM-5 | `nicolas/CIM-4-marco-navegacion`, `nicolas/CIM-5-kit-interfaz` |
| B · Worker | CON-2 | `nicolas/CON-2-worker-oauth-refresh` |
| C · Finanzas | CIM-8, FIN-1 | `nicolas/CIM-8-seed-finanzas-campanas`, `nicolas/FIN-1-facturas` |

Bloque común que va **al principio de cada prompt** (cópialo tal cual):

```
CONTEXTO COMÚN — MultiCampaign, sprint 1, historias de Nicolás.

Antes de tocar cualquier archivo lee, en este orden: CLAUDE.md,
docs/arquitectura.md, docs/plan-equipo.md y la página de reglas del plan
(resumen: un dueño por carpeta; el esquema de la base es el contrato; ramas
cortas con el id delante; PR obligatorio; CI verde; main siempre despliega;
lo a medias va detrás de una bandera).

Reglas del repositorio que no se negocian:
- Comentarios, documentación, mensajes de commit y nombres de rama en
  español. Identificadores de código y de base de datos en inglés.
- Fechas siempre timestamptz y en UTC. Dinero numeric(14,2) + moneda
  ISO-4217 aparte; en TypeScript el dinero viaja como string decimal, nunca
  como number/float. Enumerados como text + CHECK. Tablas de métricas
  append-only.
- Nunca leas ni imprimas platform/.env.local, platform/.env ni
  platform/secrets/*.enc. Nunca escribas una credencial en un archivo
  versionado. Si necesitas una variable de entorno nueva, dímelo y la
  meto al vault yo.
- No modifiques archivos de carpetas que no son mías (ver tabla de dueños
  en las reglas). Si algo necesita cambiar ahí, escribe el cambio propuesto
  en un archivo aparte docs/propuestas/<historia>.md y sigue.
- No agregues dependencias sin decirme antes cuál, para qué y cuánto pesa.
  Tengo que avisarlas en el daily.
- Las migraciones aplicadas son inmutables. No edites ningún archivo de
  db/migrations/. Si el esquema no alcanza, detente y explícamelo.

Forma de trabajo: primero investiga y entrégame un plan con archivos,
decisiones y dudas; espera mi aprobación; luego implementa en pasos
pequeños, corriendo typecheck, lint y pruebas después de cada paso. Al
final: lista de archivos creados o cambiados, cómo verificar cada criterio
de terminado, qué quedó fuera y por qué, y el texto del PR (título con el
id de la historia, descripción en español).
```

---

## Módulo A · Interfaz

### CIM-4 — Marco de la aplicación y navegación

```
[CONTEXTO COMÚN]

HISTORIA CIM-4 · Marco de la aplicación y navegación · talla M · estado
"en curso". Mis archivos: apps/web/app/layout.tsx,
apps/web/components/shell.tsx, apps/web/components/nav.tsx y
apps/web/content/flags.ts. NO toco apps/web/lib/auth/ ni lib/workspace/
(Rasheed).

SITUACIÓN. Rasheed desplegó un primer marco en
https://multicampaign-web.vercel.app el 21 de septiembre. Mi trabajo es
revisarlo, cerrar lo que falte y dejarlo como base estable para el kit de
interfaz (CIM-5) y para las pantallas de los seis módulos. No es una
reescritura. Si apps/web no está en este clon, detente y dímelo: hay que
pedirle el push a Rasheed.

FASE 1 · AUDITORÍA (sin cambiar nada todavía).
Recorre apps/web y responde, con archivo:línea, a cada punto:

1. Estructura. ¿Existe apps/web/app/(app)/<modulo>/page.tsx para resumen,
   ventas, cotizar, campanas, finanzas y conexiones? ¿Cada uno es una ruta
   real de Next.js (App Router) y no un panel dentro de una sola página?
2. Navegación. ¿nav.tsx recibe la lista de módulos de un solo lugar
   (content/modules.ts o similar) con id, ruta, etiqueta en español, dueño
   y bandera? ¿Marca el módulo activo por ruta, no por estado local? ¿Es
   usable con teclado (Tab, Enter, foco visible) y tiene aria-current?
3. Banderas. ¿content/flags.ts define las cinco de fase 2 —videos,
   tendencias, ideas, laboratorio de video, vista agencia— apagadas? ¿Una
   bandera apagada (a) quita el módulo del menú y (b) hace que su ruta
   directa devuelva notFound() en vez de renderizar? Las llaves deben
   coincidir con las de la tabla feature_flag de la migración 0009
   (video_lab, sales_radar, agency_workspace, …) para que migrar a la base
   después sea un cambio de fuente, no de nombres.
4. Tema. ¿Claro y oscuro con tokens CSS en :root y [data-theme]? ¿Se
   conserva al recargar sin parpadeo (script inline antes de hidratar que
   lee localStorage y respeta prefers-color-scheme si no hay elección)?
   ¿El toggle vive en el shell y es accesible?
5. Dirección visual. Decisión 1 del plan, resuelta: minimalista, Vercel y
   Notion como referencia, tipografía Geist. Compara con
   dashboard/local/styles.css: los tokens del marco deben ser los mismos
   nombres y valores (--bg, --surface, --ink, --muted, --border, --accent,
   --good, --warn, --bad y sus -wash, --s-tiktok/instagram/facebook/youtube,
   --sans, --mono), en claro y en oscuro. Lista cada diferencia.
6. Calidad. ¿pnpm --filter @mc/web typecheck, lint y build pasan? ¿Hay
   algún any, algún use client innecesario, algún color hardcodeado?
7. Responsive. ¿A 390 px de ancho el menú colapsa y no hay scroll
   horizontal? ¿A 1440 px el contenido tiene un ancho máximo razonable?

Entrégame la auditoría como tabla: criterio · cumple/no cumple · evidencia
· propuesta de arreglo · tamaño del arreglo. Espera mi visto bueno.

FASE 2 · CORRECCIONES. Solo lo que falló, en mis archivos. Si algo está en
lib/auth o lib/workspace, va a docs/propuestas/CIM-4.md. Prioridad: 3
(banderas) y 4 (tema) porque son los criterios de terminado; luego 5, 2,
7, 6.

FASE 3 · PRUEBAS. Una por criterio de terminado, con el runner que ya use
apps/web (si no hay ninguno, propón vitest + testing-library y espera mi
ok):
- Render de nav con una bandera apagada → el módulo no aparece; con la
  bandera encendida → aparece.
- La ruta de un módulo apagado devuelve 404.
- El script de tema aplica data-theme antes del primer paint (prueba
  unitaria de la función que decide el tema a partir de localStorage y
  prefers-color-scheme).
- Los seis módulos del MVP están en el menú, en este orden: Resumen,
  Ventas, Cotizar, Campañas, Finanzas, Conexiones.

FASE 4 · CIERRE.
- README corto en apps/web/components/README.md: cómo agregar un módulo,
  cómo agregar una bandera, dónde cambia el tema. Diez líneas, no más.
- Cambia el estado de CIM-4 a "hecha" en apps/web/content/backlog.ts (solo
  esa entrada).
- Corre typecheck, lint, build y pruebas. Pégame la salida resumida.

TERMINADO CUANDO: se navega entre los módulos, el tema se conserva al
recargar y una bandera apagada quita el módulo del menú. Verifícalo
levantando la app (pnpm --filter @mc/web dev) y describiéndome qué viste
en cada uno de los tres puntos.
```

### CIM-5 — Kit de interfaz compartido

```
[CONTEXTO COMÚN]

HISTORIA CIM-5 · Kit de interfaz compartido · talla L · depende de CIM-4.
Mi carpeta: apps/web/components/ui/. Ruta de galería:
apps/web/app/(app)/kit/page.tsx (detrás de la bandera "kit", encendida en
desarrollo, apagada en producción).

POR QUÉ IMPORTA. Es la dependencia D2 del plan: Rasheed arma Resumen,
Ventas y Cotizar en la semana 2 con estos componentes, y yo armo Campañas,
Finanzas y Conexiones después. La API pública de cada componente vale más
que el pulido visual: una vez que la usen, cambiarla cuesta dos PR.

FASE 1 · INVESTIGACIÓN. Lee dashboard/local/index.html, app.js y
styles.css (la referencia visual manda) y, si existen, theme-signal.css y
theme-studio.css. Extrae:
- Los patrones que se repiten: función kpis() (líneas ~83-100), lineChart()
  (~102-154), barChart() (~155+), legend(), pillEl(), el toggle "Ver
  tabla | Ver gráfico" (~785), las tablas con clases cell-main/cell-sub/num,
  las listas de checks con ✓/·.
- Los tokens de styles.css y cómo cambian en oscuro.
- Cómo formatea el mock dinero (cop()), enteros (fmtInt), porcentajes
  (pct()) y fechas (fmtDate()).
Documenta qué te llevas de cada uno y qué descartas.

FASE 2 · DISEÑO DE API. Propónme, en un solo archivo markdown temporal,
las props en TypeScript de cada componente, con un ejemplo de uso y los
estados que soporta. Espera mi aprobación antes de codificar. Componentes:

1. KpiRow / Kpi. label, value (ya formateado, string), note?, delta?
   (number relativo, p. ej. 0.31), deltaLabel? ("vs. mismo período 2025"),
   trend? ("up" | "down" | "flat"; si no viene, se deduce del signo de
   delta), sparkline? (number[]), href?. Cuatro por fila en escritorio,
   dos en tablet, una en móvil. El delta usa --good/--bad y una flecha; el
   color nunca es el único indicador (texto "+31 %").
2. LineChart. series: { name, data: number[], color?: token, dashed? }[],
   labels: string[], fromZero?, shade? ({ from, to, label }) para marcar
   una ventana (campaña 24–31 ago), tooltip con todos los valores de ese
   índice, formatter para eje y tooltip, aria-label obligatorio.
3. BarChart. cats, series, mode "group" | "stack", mismos formatters y
   tooltip.
4. ChartCard. Envuelve un gráfico con título, subtítulo, leyenda, el botón
   "Ver tabla / Ver gráfico" y el aviso DataAsOf. La tabla se genera
   sola desde series+labels, con <caption>, <th scope>, y es la misma data
   que el gráfico (no una prop aparte, para que no se desincronicen).
5. DataTable. columns: { key, header, align?: "left" | "num", render? }[],
   rows, emptyState, rowKey, onRowClick?, y densidad compacta. Cabeceras
   sticky. Sin paginación ni ordenamiento en este sprint (déjalo previsto
   en la API sin implementarlo).
6. Pill. kind: "good" | "warn" | "bad" | "neutral"; texto obligatorio.
7. EmptyState. title, description, action? ({ label, href | onClick }),
   icon? Ilustración mínima, un solo tono.
8. DataAsOf. date (ISO), source? → "datos hasta el 20 sep · Instagram".
   Formatea con Intl.DateTimeFormat("es-CO", { timeZone: "UTC" }).
9. Form: Field (label, help?, error?, required?, children), Input, Select,
   Textarea, MoneyInput (recibe y emite string decimal + currency; muestra
   separador de miles es-CO; no usa type="number"), DateInput. Validación
   con zod en el lado del que usa el formulario; el kit solo pinta
   errores. Mensajes de error en español.
10. Button. variant "primary" | "secondary" | "ghost" | "danger", size,
    loading (spinner + aria-busy + disabled), asChild o href para enlaces.
11. Utilidades en apps/web/lib/format.ts: formatMoney(amountDecimal:
    string, currency: string) → "COP 5,2 M" y "COP 5.200.000" (dos modos:
    compact y full), formatInt, formatPct, formatDate, formatDelta. Todo
    con Intl y es-CO. Con pruebas unitarias.

Decisiones ya tomadas (no las reabras):
- Los componentes NO consultan datos ni conocen la base. Solo props.
- Server Components por defecto; "use client" solo en los que necesitan
  estado o eventos (gráficos con tooltip, toggle de tabla, formulario,
  botón con loading).
- Colores solo por tokens CSS del tema definidos en CIM-4. Nada
  hardcodeado. Los gráficos usan --accent, --deemph, --grid, --axis,
  --tooltip-bg y las --s-<red> para series por red social.
- Gráficos: SVG propio, como el mock, sin librería. Si después de leer
  app.js concluyes que una librería es imprescindible, dime cuál, cuánto
  pesa y por qué, y espera mi respuesta.
- Accesibilidad: cada gráfico con role="img" y aria-label, tooltip
  accesible por teclado (foco en puntos o descripción en la tabla), foco
  visible en todo, contraste AA en los dos temas.
- Tipografía Geist / Geist Mono. Cifras en la tabla con
  font-variant-numeric: tabular-nums.

FASE 3 · IMPLEMENTACIÓN, un componente por commit, en este orden: format
utils → Button → Pill → Field/Input/MoneyInput/DateInput → EmptyState →
DataAsOf → Kpi/KpiRow → DataTable → LineChart → BarChart → ChartCard.
Después de cada uno: typecheck, lint, pruebas, y agrégalo a /kit.

FASE 4 · GALERÍA /kit. Una sección por componente con: nombre, uso
mínimo, y variantes: datos normales, vacío, cargando, error, valores
largos (COP 1.234.567.890 y nombres de empresa de 40 caracteres), y una
serie con 90 puntos. Toggle de tema en la misma página. Usa cifras del
mock: KPIs de Finanzas (Por cobrar COP 9,4 M · 3 facturas; Vencido
COP 1,1 M · 1 factura · 41 días; Cobrado en 2026 COP 38,6 M +31 %;
Apartado para impuestos COP 4,2 M · 11 % de cada cobro), la tabla CXC y
el gráfico de seguidores de @cafealma con la ventana sombreada
"Campaña 24–31 ago".

FASE 5 · PRUEBAS. Unitarias para format.ts (casos: 0, negativos, 1e9,
string con decimales, moneda distinta a COP). Render de cada componente
en su estado vacío y normal. ChartCard: al pulsar "Ver tabla" la tabla
tiene tantas filas como labels y tantas columnas como series + 1.
MoneyInput: escribir "5200000" emite "5200000.00"; pegar "5.200.000,50"
emite "5200000.50".

FASE 6 · DOCUMENTACIÓN. apps/web/components/ui/README.md: tabla de
componentes con una línea cada uno, el principio "solo props, sin datos",
cómo agregar uno nuevo, y la regla del plan: agregar un componente es
libre; cambiar uno existente pide PR revisado por Nicolás.

TERMINADO CUANDO: /kit muestra cada componente con datos de ejemplo, en
claro y oscuro. Verifícalo levantando la app, recorriendo /kit en los dos
temas y a 390 px y 1440 px, y cuéntame qué encontraste. Marca CIM-5 como
"hecha" en content/backlog.ts.
```

---

## Módulo B · Worker

### CON-2 — Worker arrancado y `oauth.refresh`

```
[CONTEXTO COMÚN]

HISTORIA CON-2 · Worker arrancado y oauth.refresh · talla M · depende de
CIM-1 (monorepo, Rasheed). Mis carpetas: apps/worker/ completo (soy dueño
de src/runner/), apps/worker/src/jobs/conexiones/ y packages/connectors/.
Los jobs de otros módulos (ventas, finanzas, campañas) los agregará cada
dueño en su carpeta sin tocar el runner: ese contrato es lo más importante
que entrego.

LECTURAS OBLIGATORIAS ADEMÁS DEL CONTEXTO COMÚN:
- docs/base-de-datos.md (roles mc_app / mc_migrator / mc_worker, pooler,
  TLS).
- platform/db/migrations/0009_jobs_notifications.sql: tablas
  job_definition (21 filas ya sembradas, con queue, default_cron,
  timeout_s, max_attempts, max_concurrency, enabled) y job_run (status
  running/ok/failed/skipped/partial, attempt, duration_ms,
  items_processed, items_failed, error, metadata).
- platform/db/migrations/0002_social_connections.sql: social_connection
  (secret_ref, scopes, access_expires_at, refresh_expires_at, access_mode,
  status con needs_reauth y status_detail), api_call_log, api_quota_usage.
- platform/db/migrate.mjs y db/sql.mjs para ver cómo se conecta hoy a
  Postgres (certificado en db/certs, usuario con el ref pegado).
- platform/packages/core/package.json: el estilo de paquete del repo
  (ESM, node --test con --experimental-strip-types, tsc --noEmit).
- Si packages/db ya existe (CIM-2), su client.ts. Si no, no lo inventes:
  el worker se conecta con pg directamente por ahora y dejamos un TODO
  para migrar al cliente compartido.

FASE 1 · INVESTIGACIÓN Y PLAN. Responde por escrito antes de codificar:
1. Qué versión de pg-boss usar, qué esquema crea (pgboss) y qué permisos
   necesita para crearlo y operarlo. mc_migrator no tiene CREATEROLE y
   mc_app no puede alterar el esquema: ¿quién crea el esquema pgboss? Mi
   hipótesis: se crea una vez con DATABASE_URL_DIRECT (mc_migrator) al
   arrancar con una bandera --install, y en operación normal el worker
   usa mc_app + SET ROLE mc_worker. Confírmalo o corrígeme, y si hace
   falta un GRANT, escríbelo como migración propuesta en
   docs/propuestas/CON-2.md (no en db/migrations/).
2. pg-boss necesita conexión en modo sesión (pooler :5432,
   DATABASE_URL_DIRECT), no el pooler de transacción (:6543). Confirma y
   documenta cuál variable usa el worker y por qué.
3. Cómo mapear job_definition → pg-boss: cola = queue, cron =
   default_cron con boss.schedule(), timeout = timeout_s, reintentos =
   max_attempts con backoff exponencial, concurrencia = max_concurrency
   por cola (teamSize/teamConcurrency o batchSize según la versión).
   enabled = false → no se programa.
4. Contrato de handler. Propón la interfaz, algo así:
     interface JobContext { jobId, runId, workspaceId?, db, logger,
       signal: AbortSignal, secrets: SecretStore, now(): Date }
     type JobHandler = (payload, ctx) => Promise<{ processed: number;
       failed: number; metadata?: object }>
   y un registro: registerJob('oauth.refresh', handler). Cada carpeta
   jobs/<modulo>/index.ts exporta sus registros; el runner los importa
   todos desde jobs/index.ts. Un job_definition sin handler registrado se
   registra en job_run como skipped con error "sin handler", una vez por
   arranque, y el worker sigue.
5. Estructura de apps/worker: package.json (@mc/worker, ESM, scripts dev
   con tsx --watch, start, typecheck, lint, test), tsconfig, src/index.ts
   (arranque + apagado limpio con SIGTERM/SIGINT: boss.stop con
   graceful), src/runner/{boss.ts, registry.ts, run.ts, db.ts, logger.ts},
   src/jobs/index.ts, src/jobs/conexiones/oauth-refresh.ts,
   packages/connectors/src/{index.ts, secret-store.ts, token-refresher.ts,
   fakes/}.
Espera mi aprobación.

FASE 2 · RUNNER. Requisitos:
- Al arrancar: conecta, lee job_definition WHERE enabled, registra cada
  cola con su handler (si existe) y su cron, imprime una tabla resumen en
  el log (job, cola, cron, handler sí/no).
- Por cada ejecución: INSERT en job_run con status running, attempt (el
  número de intento que reporta pg-boss), workspace_id/entity_type/
  entity_id si vienen en el payload. Al terminar: UPDATE con status ok o
  failed, finished_at, duration_ms, items_processed, items_failed, error
  (mensaje + nombre de la clase, sin stack en la columna; el stack va al
  log), metadata. Si el handler devuelve failed > 0 y processed > 0 →
  status partial.
- Timeout: si el handler no termina en timeout_s, se aborta con la
  AbortSignal y se marca failed con error "timeout".
- Idempotencia de cron: al reiniciar el worker no se duplican schedules
  (pg-boss los guarda; comprueba y actualiza si cambió el cron).
- Logs en JSON por línea, con jobId, runId, durationMs. Sin console.log
  sueltos.
- El worker corre como mc_worker: tras conectar, SET ROLE mc_worker en la
  sesión (BYPASSRLS, porque los jobs cruzan workspaces). Documenta el
  riesgo: cada job que escriba debe filtrar por workspace_id
  explícitamente.

FASE 3 · packages/connectors. Solo las interfaces y las falsas:
- SecretStore { get(ref): Promise<OAuthTokens | null>; set(ref, tokens):
  Promise<void> } donde OAuthTokens = { accessToken, refreshToken?,
  accessExpiresAt, refreshExpiresAt?, scopes }. Implementación
  InMemorySecretStore para pruebas y EnvSecretStore mínima que lee de
  variables de entorno por ref (documenta que la real llega con CON-3).
- TokenRefresher { platformId; refresh(tokens): Promise<OAuthTokens> }.
  Un FakeTokenRefresher configurable (éxito, fallo transitorio, fallo
  definitivo tipo invalid_grant). Los reales de TikTok, Instagram y
  YouTube son CON-3 y CON-8: deja el archivo por plataforma con el
  endpoint y los campos documentados en comentarios a partir de
  docs/investigacion-apis.md, sin implementar.
- El token NUNCA se escribe en la base ni en los logs. social_connection
  solo guarda secret_ref. Agrega una prueba que falla si un objeto
  OAuthTokens llega a JSON.stringify en el logger (redactor).

FASE 4 · JOB oauth.refresh (jobs/conexiones/oauth-refresh.ts).
- Selecciona social_connection WHERE status = 'active' AND
  access_expires_at <= now() + margen (margen por defecto 30 minutos,
  configurable por env OAUTH_REFRESH_MARGIN_MINUTES) AND access_mode =
  'direct_oauth'. Ordena por access_expires_at ASC. Procesa en lotes de
  max_concurrency respetando max_concurrency por plataforma.
- Por conexión: lee tokens del SecretStore por secret_ref; llama al
  TokenRefresher de su platform_id; guarda los tokens nuevos en el
  SecretStore; UPDATE social_connection SET access_expires_at,
  refresh_expires_at, status='active', status_detail=null.
- Fallo transitorio (red, 5xx, rate limit): cuenta como failed, no cambia
  el estado, y pg-boss reintenta. Fallo definitivo (invalid_grant, token
  revocado, refresh_expires_at pasado): status='needs_reauth',
  status_detail con la causa en español, y una fila en notification si
  la tabla lo permite (revisa 0009; si no encaja, déjalo como TODO
  documentado).
- Registra cada llamada en api_call_log con platform_id, endpoint lógico
  'oauth.refresh', status_code y duración, sin cuerpo de la respuesta.
- Devuelve { processed, failed, metadata: { renewed: [...ids],
  needsReauth: [...ids] } }.

FASE 5 · PRUEBAS. Integración contra Postgres real, nunca contra Supabase:
usa el docker compose del repo (make up) o pglite si pg-boss corre ahí
(verifica: pg-boss usa LISTEN/NOTIFY y funciones que pglite podría no
soportar; si no corre, docker). Casos:
1. make worker arranca, lee las 21 definiciones, y el log muestra cuáles
   tienen handler.
2. Se encola un job de prueba → aparece en job_run como running y luego
   ok con duration_ms > 0.
3. Handler que lanza → job_run failed con error; pg-boss reintenta hasta
   max_attempts.
4. Handler que excede timeout_s → failed con "timeout".
5. oauth.refresh: tres conexiones (una vence en 10 min, una en 3 h, una
   revocada). Tras correr: la primera renovada (access_expires_at nuevo,
   status active), la segunda intacta, la tercera needs_reauth con
   status_detail. Ningún token en job_run.metadata ni en los logs.
6. El redactor de logs oculta accessToken y refreshToken.

FASE 6 · CIERRE.
- make worker debe funcionar (el Makefile ya tiene el target con
  pnpm --filter @mc/worker dev). Verifica que make dev levante el worker
  junto con la web.
- apps/worker/README.md: cómo correrlo, variables que necesita (nombres,
  no valores), cómo agregar un job en tu módulo (cinco líneas de ejemplo),
  qué pasa cuando falla, cómo leer job_run.
- docs/propuestas/CON-2.md con lo que necesita Rasheed: GRANTs o
  migración para el esquema pgboss, y la variable de entorno del worker
  en el vault y en Railway/Fly (CIM-7).
- Estado de CON-2 en content/backlog.ts.

TERMINADO CUANDO: make worker toma un job de la cola, lo registra en
job_run, y un token con access_expires_at cercano se renueva solo.
Demuéstramelo con la salida real de las pruebas y con una consulta a
job_run.
```

---

## Módulo C · Finanzas

### CIM-8 — Seed de finanzas y campañas

```
[CONTEXTO COMÚN]

HISTORIA CIM-8 · Seed de finanzas y campañas · talla S · depende de
CIM-2. Mi archivo: platform/db/seed/0003_demo_finanzas_campanas.sql.
0001_catalog.sql y 0002_demo_ventas_metricas.sql son de Rasheed: los leo,
no los toco. Si 0002 todavía no existe, detente y dímelo: este seed
depende de su workspace, su creadora y sus empresas.

LECTURAS OBLIGATORIAS:
- platform/db/seed/0001_catalog.sql (estilo: comentario de cabecera,
  INSERT … ON CONFLICT, idempotente) y 0002 (identificadores del
  workspace, creator_profile, company y post que voy a reutilizar).
- platform/db/migrations/0008_quotes_campaigns_finance.sql: campaign,
  campaign_post, campaign_brand_input, brand_account_snapshot,
  campaign_result, invoice, payment, expense, platform_payout,
  tax_reserve.
- platform/db/migrations/0010_views_rls.sql: vista receivables (calcula
  outstanding, days_overdue y aging_bucket a partir de due_on y
  CURRENT_DATE; excluye void y draft).
- platform/db/migrate.mjs: cómo corre --seed (orden de archivos, si usa
  transacción, con qué rol).
- dashboard/local/app.js: constante CXC (línea ~408), renderFinanzas()
  (~731) y renderCampanas() (~603), y la constante CAMPS. Es la fuente de
  verdad de los números.

FASE 1 · MAPA DE CIFRAS. Antes de escribir SQL, entrégame una tabla
"cifra del mock → filas que la producen → consulta que la verifica":

Finanzas (KPIs y tabla CXC):
- Por cobrar COP 9,4 M · 3 facturas = 5,2 M + 3,1 M + 1,1 M.
- Fresko Market · "Campaña 2 TikTok · sep" · COP 5.200.000 · vence en
  23 días · Al día.
- Café Alma · "Lanzamiento cold brew" · COP 3.100.000 · vence en 14 días
  · Vence pronto (ojo: la vista marca vence_pronto solo a ≤ 7 días;
  decide si ajustas la fecha a 7 días o dejas 14 y documentas la
  diferencia con el mock; propónmelo).
- Hogar Lindo · "3 historias · jun" · COP 1.100.000 · vencida hace 41
  días · reminders_sent = 2 · last_reminder_at reciente.
- Cobrado en 2026: COP 38,6 M (+31 % vs 2025) → pagos direction='in'
  repartidos en 2026, más los de 2025 que sostengan el +31 %.
- Apartado para impuestos COP 4,2 M · 11 % → tax_reserve con rate 0.11
  sobre cada pago; la suma de amount debe dar ≈ 4,2 M (4,2 / 0,11 ≈ 38,2 M,
  cuadra con lo cobrado; documenta el redondeo).
- Gastos recurrentes: los suficientes para que "Gastos e impuestos" del
  flujo de caja (1,1 a 1,7 M por semana en S38–S45) sea creíble: edición,
  software, equipo; is_recurring true con recurrence 'monthly'.
- Cobros esperados S38–S45: 3,1 M · 0 · 5,2 M · 0 · 2,6 M · 1,8 M · 0 ·
  5,0 M → facturas sent con due_on en esas semanas (las de 2,6, 1,8 y 5,0
  pueden ser facturas adicionales en estado sent que NO cuenten en "Por
  cobrar 3 facturas"; propón cómo cuadrar ambos KPIs o documenta qué
  cifra del mock cede).

Campañas:
- Dos campañas: Café Alma "Lanzamiento cold brew" (status reported, 24–31
  ago, tracking_code LAURA15, brand_baseline_from 14 días antes) y Fresko
  Market "Campaña 2 TikTok · sep" (status measuring o live).
- campaign_post: los posts del seed 0002 asociados (un reel y un TikTok
  para Café Alma; dos TikTok para Fresko), con deliverable e is_primary.
- brand_account_snapshot de @cafealma: 60 días diarios, de 18.200
  seguidores subiendo ~12–18/día antes, ~150–210/día en la ventana 24–31
  ago, ~22–30/día después; total ganado en la ventana ≈ 1.240. Hazlo con
  generate_series y una función determinista (sin random()), respetando
  UNIQUE (company_id, platform_id, day).
- campaign_brand_input para Café Alma: code_redemptions 318 y revenue
  COP 8,4 M, source brand_manual.
- campaign_result de Café Alma con los KPIs del mock: reach 486.000,
  views 712.000, reach_non_followers_pct 0.58, link_clicks 6.240,
  code_redemptions 318, attributed_revenue 8.400.000,
  brand_followers_gained 1.240, cpm 11.800, cpa 26.400, y
  brand_followers_baseline_rate / campaign_rate coherentes con "12× su
  ritmo normal".
- Las facturas de Café Alma y Fresko Market apuntan a su campaign_id.

Espera mi aprobación del mapa (ahí decidimos los dos casos ambiguos).

FASE 2 · SQL. Reglas:
- Idempotente de verdad: UUID fijos y legibles para todo lo que tenga id
  uuid (p. ej. '00000000-0000-4000-8000-0000000fin001'), ON CONFLICT
  (id) DO UPDATE en las tablas maestras (campaign, invoice, expense) para
  que corregir una cifra y volver a correr actualice; ON CONFLICT DO
  NOTHING en las append-only (brand_account_snapshot, payment,
  tax_reserve) con claves naturales. Para bigserial sin clave natural
  (brand_account_snapshot tiene UNIQUE (company_id, platform_id, day):
  úsala).
- Fechas relativas a CURRENT_DATE (due_on = CURRENT_DATE - 41, etc.) para
  que la demo diga "41 días" cualquier día. Excepción: las fechas de la
  campaña de Café Alma y el snapshot pueden ser relativas también (la
  ventana termina hace N días); decide y documenta.
- Dinero numeric(14,2) y currency 'COP'. Nada de float.
- Numeración de facturas por workspace: 'FV-2026-001', '002', '003' (el
  formato tiene que ser el mismo que use FIN-1; déjalo en un comentario
  para que FIN-1 lo lea).
- Un solo archivo, secciones con cabecera de comentario en español,
  orden de inserción que respete las FK.
- Todo dentro del workspace del seed 0002. No crees workspaces, usuarios,
  empresas ni posts nuevos; si falta una empresa (Hogar Lindo) o un post,
  detente y propón agregarlos en 0002 vía docs/propuestas/CIM-8.md para
  Rasheed, o en 0003 con id fijo y un comentario que lo diga.

FASE 3 · VERIFICACIÓN.
- make db.check (Postgres embebido) con migraciones + los tres seeds, dos
  veces seguidas: el conteo de filas por tabla es idéntico en la segunda
  pasada. Pégame los conteos.
- Consultas de verificación, en un archivo
  platform/db/seed/verify/0003.sql que yo pueda correr con make db.sql:
  (a) SELECT sum(outstanding), count(*) FROM receivables WHERE status <>
  'paid' → 9.400.000 y 3; (b) la fila de Hogar Lindo con days_overdue =
  41 y aging_bucket 'vencida'; (c) suma de pagos 'in' en 2026 → 38.600.000;
  (d) suma de tax_reserve → ≈ 4.200.000; (e) seguidores ganados de
  @cafealma en la ventana → ≈ 1.240; (f) campaign_result de Café Alma.
- No corras nada contra Supabase; eso lo hago yo con make db.migrate /
  db.seed cuando revise.

TERMINADO CUANDO: make seed deja Finanzas y Campañas con los mismos
números que el mock, y correrlo dos veces no cambia nada. Marca CIM-8 en
content/backlog.ts.
```

### FIN-1 — Facturas

```
[CONTEXTO COMÚN]

HISTORIA FIN-1 · Facturas · talla M · depende de CIM-2 (cliente con RLS)
y CIM-5 (kit). Mis carpetas: packages/db/src/queries/finanzas.ts,
apps/web/app/(app)/finanzas/, apps/worker/src/jobs/finanzas/ (no se usa
en esta historia) y packages/core/src/ para lógica pura de facturación.
NO toco packages/db/src/client.ts ni schema/ (Rasheed): si el esquema
Drizzle de invoice, payment o company no existe, lo pido por
docs/propuestas/FIN-1.md y mientras tanto uso SQL con el cliente.

DEMO DEL VIERNES: "primera factura a mano". Lo que la demo necesita son
los pasos 1 a 4; el paso 5 (crear desde campaña) es el criterio de
terminado oficial y va después, si el tiempo alcanza.

LECTURAS OBLIGATORIAS:
- platform/db/migrations/0008_quotes_campaigns_finance.sql, tabla
  invoice: columnas number, currency, subtotal, tax, withholding, total,
  issued_on, due_on, status CHECK (draft, sent, partial, paid, overdue,
  void), paid_amount, paid_at, reminders_sent, last_reminder_at,
  external_ref (factura electrónica DIAN), campaign_id, quote_id,
  company_id; UNIQUE (workspace_id, number); trigger updated_at.
- 0010: vista receivables y cómo funciona RLS (set_config
  'app.workspace_id' por transacción, current_workspace_id()).
- packages/db/src/client.ts de Rasheed: cómo se abre una transacción con
  workspace fijado. Úsalo tal cual.
- El seed 0003 (CIM-8): formato de numeración y datos de prueba.
- dashboard/local/app.js renderFinanzas() y CXC: la tabla de cuentas por
  cobrar es la referencia visual de la lista.
- apps/web/components/ui/README.md: los componentes disponibles.

FASE 1 · PLAN. Propón y espera aprobación:
1. Modelo de dominio en packages/core/src/facturacion.ts (puro, sin base):
   - computeInvoiceTotals({ subtotal, taxRate, withholdingRate }) →
     { tax, withholding, total } con aritmética decimal (usa una
     implementación de decimales sobre string/BigInt; dime si propones
     una librería). Redondeo a 2 decimales, half-up. IVA por defecto 19 %,
     retención por defecto 11 % (Colombia, servicios), ambos editables.
   - Máquina de estados: transiciones válidas draft→sent, sent→partial,
     sent→paid, partial→paid, sent|partial→overdue, overdue→partial|paid,
     draft|sent→void. Cualquier otra lanza InvalidTransition con mensaje
     en español. paid exige paid_amount = total; partial exige
     0 < paid_amount < total.
   - deriveStatus(invoice, today): overdue se DERIVA de due_on < today
     para sent/partial, sin job (finance.reminders es FIN-4, sprint 5).
     Propón si se persiste el status overdue en lectura (no) o se calcula
     en la consulta y la vista (sí: receivables ya lo hace con
     aging_bucket). Decide y documenta.
   - nextInvoiceNumber(year, lastSeq) → 'FV-2026-004'.
2. Consultas en packages/db/src/queries/finanzas.ts, todas dentro de la
   transacción con workspace fijado:
   - listInvoices({ status?, companyId?, limit, cursor }) leyendo de
     receivables + invoice para incluir draft.
   - getInvoice(id) con empresa y campaña.
   - createInvoice(input): en UNA transacción: SELECT … FOR UPDATE sobre
     una fila de secuencia por workspace (o pg_advisory_xact_lock con
     hash del workspace_id + año) → siguiente número → INSERT. Dos
     creaciones concurrentes no pueden chocar en UNIQUE (workspace_id,
     number) ni saltarse números.
   - transitionInvoice(id, to, { paidAmount?, paidAt? }) validando con la
     máquina de estados.
   - createInvoiceFromCampaign(campaignId): lee campaign (name, company_id,
     amount, currency) → prellena y crea en draft, con campaign_id y
     quote_id si la campaña lo tiene.
3. Rutas en apps/web/app/(app)/finanzas/: page.tsx (lista + KPIs "Por
   cobrar", "Vencido"), facturas/nueva/page.tsx (formulario), facturas/
   [id]/page.tsx (detalle y acciones de estado). Server Actions con zod
   para el formulario; los mensajes de validación en español. Si el
   módulo Finanzas en nav ya tiene página placeholder de CIM-4,
   reemplázala.
4. Qué falta del kit (CIM-5) para armar estas pantallas. Si falta un
   componente, se agrega en components/ui/ (soy dueño), no se improvisa
   en la página.

FASE 2 · IMPLEMENTACIÓN, en este orden y un commit por paso:
1. packages/core/src/facturacion.ts + pruebas (totales, redondeo,
   transiciones válidas e inválidas, deriveStatus con fechas límite:
   vence hoy no es overdue; vence ayer sí).
2. queries/finanzas.ts + pruebas de integración en Postgres embebido con
   el seed 0003: listar devuelve 3 facturas por cobrar del workspace; con
   otro workspace_id devuelve 0; crear dos facturas en paralelo
   (Promise.all) produce números consecutivos distintos; transición
   inválida lanza y no modifica la fila.
3. Formulario "Nueva factura": empresa (select de company del workspace),
   subtotal (MoneyInput), IVA % y retención % con defaults, emisión (hoy)
   y vencimiento (emisión + 30), external_ref opcional, moneda COP fija
   con el campo visible pero deshabilitado. El total se muestra en vivo
   calculado con la misma función de core (importada en cliente, es
   pura). Al guardar: draft, redirige al detalle.
4. Lista y detalle: tabla con Marca · Campaña · Monto · Vence · Estado
   (Pill: al_dia good, vence_pronto warn, vencida bad, pagada neutral) ·
   Acción; KPIs arriba. Detalle con los montos desglosados, número DIAN,
   y botones "Marcar enviada", "Anular" (y "Registrar pago" deshabilitado
   con tooltip "Sprint 3 · FIN-2"). Estado vacío con "Crear tu primera
   factura". DataAsOf no aplica aquí (no son métricas): no lo pongas.
5. Crear desde campaña: en el detalle de una factura nueva, selector
   "Desde una campaña" que prellena; y una Server Action
   createInvoiceFromCampaign lista para que Campañas (CAM-1) la enlace
   con un botón "Facturar". Exporta la función desde un índice para que
   la pantalla de campañas la importe sin conocer finanzas por dentro.

FASE 3 · CALIDAD.
- Aislamiento: ninguna consulta recibe workspace_id como parámetro
  suelto; siempre sale del contexto de la transacción. Prueba que lo
  demuestre.
- Nada de float: grep de "parseFloat|Number\(" en mis archivos debe salir
  vacío salvo donde esté justificado en comentario.
- Accesibilidad del formulario: labels asociados, errores con
  aria-describedby, foco al primer error.
- typecheck, lint, pruebas y build verdes. Pégame el resumen.

FASE 4 · CIERRE. docs/propuestas/FIN-1.md con lo que Rasheed tiene que
saber (esquema Drizzle que pedí, la decisión sobre overdue derivado, el
formato de numeración). Estado en content/backlog.ts. Texto del PR.

TERMINADO CUANDO: una factura creada desde una campaña del seed (Café
Alma) trae nombre, empresa y monto sin escribirlos. Verifícalo en la app
corriendo con el seed cargado y cuéntame paso a paso qué hiciste y qué
viste. Si el paso 5 no entra en el sprint, el PR se llama "FIN-1 (parte 1):
facturas a mano" y dejas el paso 5 como issue con este mismo texto.
```

---

## Cómo sacarles el 9.5

1. **Modo plan siempre.** Cada prompt tiene una "Fase 1 · espera mi
   aprobación". Ahí es donde corriges la API o el diseño antes de que
   cueste.
2. **Una sesión por historia, desde `rayit/platform`**, para que cargue el
   CLAUDE.md y los permisos del repo.
3. **Pide el push de Rasheed hoy.** CIM-4 y CIM-5 no arrancan sin
   `apps/web` en `origin/main`.
4. **Al terminar cada fase, `/code-review`** sobre el diff antes de abrir el
   PR.
