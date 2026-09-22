// =====================================================================
// rasheed-endurecer-db · cierra la CLASE de problema que la fase 1 dejó
// abierta: la cobertura de aislamiento por fila (RLS) del esquema.
//
// Por qué existe este workflow y no otra ronda del anterior: en la fase 1
// la pieza db pasó por cinco rondas y se quedó en 8,3. No fue ruido de
// los revisores: cada ronda encontraron un agujero REAL y más profundo
// (app_user, contact, luego workspace, luego los catálogos, luego
// api_call_log). La causa es una sola: la guardia de esquema está
// escrita como lista de tablas incluidas, así que cualquier tabla que
// no esté en la lista se escapa en silencio. Arreglar casos uno por uno
// no converge nunca; hay que invertir la guardia y cerrar la clase.
//
// Diferencias con el ciclo de la fase 1, que son la razón de que esto
// sí converja:
//   1. El constructor recibe el problema como CLASE, con el SQL que los
//      revisores ya escribieron, y la orden de preguntarle a la base qué
//      falta en vez de fiarse de una lista.
//   2. Los revisores reciben el ALCANCE acotado: juzgan el aislamiento,
//      las fronteras de error y la higiene listada, más regresiones. No
//      vuelven a auditar la pieza entera ni a re-litigar lo ya aceptado.
//
//   Workflow({scriptPath: '.claude/workflows/rasheed-endurecer-db.js'})
// =====================================================================
export const meta = {
  name: 'rasheed-endurecer-db',
  description: 'Cierra la cobertura de aislamiento por fila del esquema y las fronteras de error de la web, hasta 9,5',
  whenToUse: 'Después de la fase 1, para cerrar la clase de hallazgos de RLS que quedó abierta en rasheed/integracion.',
  phases: [
    { title: 'Endurecer', detail: 'migración que cierra la clase + guardia invertida' },
    { title: 'Verificar', detail: 'dos revisores con alcance acotado' },
    { title: 'Integrar', detail: 'merge a rasheed/integracion y CI' },
  ],
}

const UMBRAL = (args && args.umbral) || 9.5
const MAX_RONDAS = (args && args.maxRondas) || 3
const RAMA = 'rasheed/integracion'

const CHECKS = {
  type: 'object',
  properties: { typecheck: { type: 'boolean' }, lint: { type: 'boolean' }, test: { type: 'boolean' }, build: { type: 'boolean' } },
  required: ['typecheck', 'lint', 'test', 'build'],
}
const BUILD = {
  type: 'object',
  properties: {
    branch: { type: 'string' }, commit: { type: 'string' }, summary: { type: 'string' },
    checks: CHECKS,
    decisions: { type: 'array', items: { type: 'string' } },
    pending: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'commit', 'summary', 'checks'],
}
const REVIEW = {
  type: 'object',
  properties: {
    score: { type: 'number' },
    ran: { type: 'array', items: { type: 'string' } },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['bloqueante', 'alta', 'media', 'baja'] },
          where: { type: 'string' }, issue: { type: 'string' }, fix: { type: 'string' },
          en_alcance: { type: 'boolean', description: 'true si cae en el alcance de esta ronda o es una regresión' },
        },
        required: ['severity', 'where', 'issue', 'fix', 'en_alcance'],
      },
    },
    praise: { type: 'array', items: { type: 'string' } },
  },
  required: ['score', 'ran', 'findings'],
}
const MERGE = {
  type: 'object',
  properties: { ok: { type: 'boolean' }, commit: { type: 'string' }, notes: { type: 'string' }, ci: CHECKS },
  required: ['ok', 'notes', 'ci'],
}

const CONTEXTO = `
CONTEXTO
- Monorepo pnpm en platform/ del producto **On Cue** (Next.js 15 en apps/web, packages/db con Drizzle, packages/core, packages/connectors, apps/worker con pg-boss; Postgres en Supabase). Lee CLAUDE.md antes de tocar nada.
- Trabajas sobre la rama ${RAMA}, que ya tiene integrada la fase 1 y todo el trabajo de Nicolás.
- Reglas que no se negocian: una migración aplicada es inmutable (crea la siguiente con el número libre y verifícala con \`make db.check\`; NO la apliques a Supabase, eso lo hace el integrador); las métricas se insertan, nunca se actualizan; el workspace lo fija el cliente de base por transacción, nunca la pantalla; los tokens nunca tocan la base en claro.
- Convenciones: comentarios, documentación y textos de interfaz en español; identificadores en inglés; timestamptz; dinero en numeric con moneda aparte.
- Estilo visual: minimalista (Vercel, Notion); tokens en apps/web/app/globals.css; nunca un color literal; tema claro y oscuro; móvil a 400 px.
- Para levantar la web usa un puerto libre entre 3100 y 3999, nunca el 3000.
- La puerta de calidad del repositorio es \`pnpm verificar\` en platform/ (equivale a typecheck, lint y test con concurrencia acotada) más \`pnpm --filter @mc/web build\`.
`

const HALLAZGOS = `
LO QUE LOS REVISORES DE LA FASE 1 ENCONTRARON Y DEJARON SIN CERRAR
Todos están reproducidos por ellos contra pglite o contra la Supabase real. El SQL que citan es suyo; úsalo salvo que encuentres algo mejor, y entonces explica por qué.

1. [BLOQUEANTE] La tabla \`workspace\` —la raíz del inquilino— no tiene RLS y mc_app tiene SELECT/INSERT/UPDATE/DELETE sobre ella. Desde cualquier transacción de la aplicación se leen, se renombran y se BORRAN los workspaces ajenos, y el DELETE cascadea a todos sus datos. Se escapó porque la prueba «toda tabla con workspace_id tiene RLS» solo mira una columna llamada workspace_id, y aquí la clave se llama id.
   SQL propuesto: ALTER TABLE workspace ENABLE ROW LEVEL SECURITY; ALTER TABLE workspace FORCE ROW LEVEL SECURITY; CREATE POLICY workspace_read ON workspace FOR SELECT USING (id = current_workspace_id()); CREATE POLICY workspace_update ON workspace FOR UPDATE USING (id = current_workspace_id()) WITH CHECK (id = current_workspace_id()); CREATE POLICY workspace_signup ON workspace FOR INSERT WITH CHECK (current_workspace_id() IS NULL); y ninguna política de DELETE (borrar un inquilino es del worker, no de una pantalla).
   Y en packages/db/src/queries/cimientos.ts, getWorkspace debe dejar de filtrar en JavaScript con eq(workspace.id, tx.workspaceId): con la política puesta, basta seleccionar y limitar a uno.

2. [ALTA] \`membership_ws_isolation\` (0019) es FOR ALL sin WITH CHECK propio, así que su USING gobierna también el INSERT: desde el workspace B se cuelga a CUALQUIER user_id dentro de B, y acto seguido \`app_user_read\` («comparto workspace») le abre el correo y el nombre de esa persona. Reproducido: B inserta membership(current_workspace_id(), USER_A, 'owner') sin error y luego lee a@ejemplo.com.
   Separar lectura y escritura de membership, y dejar el alta en manos del worker y del seed hasta que CIM-3 fije app.user_id.

3. [ALTA] Los catálogos globales (\`platform\`, \`niche\`, \`niche_cpm_benchmark\`, \`signal_source\`, \`job_definition\`) no llevan RLS y mc_app conserva INSERT/UPDATE/DELETE. Son de solo lectura para la aplicación: los llena una migración o el worker. REVOKE de escritura. \`company\` sí se escribe desde el CRM: necesita RLS con el mismo patrón de dueño que se usó para \`contact\` en 0020.

4. [MEDIA] \`api_call_log\` y \`api_quota_usage\` cuelgan de \`social_connection\` (que sí está aislada) pero no llevan RLS: desde el workspace B se leen los endpoints y los mensajes de error de las llamadas de A. Cerrarlas con la política heredada de 0018 tolerando el connection_id nulo de la cuota global.

5. [MEDIA] \`app_user_insert\` es WITH CHECK (true) y mc_app tiene INSERT: desde una transacción cualquiera de la web se crean filas de app_user con el correo que se quiera. Con el enlace mágico de CIM-3, que casa por correo, una fila precreada con el correo de la víctima es una primitiva de apropiación de cuenta. Cerrarla con el patrón de alta sin workspace fijado que la propia 0020 ya usa para los catálogos.

6. [MEDIA] La guardia de esquema de packages/db/src/esquema.ts está escrita como LISTA DE INCLUIDOS (30 tablas del MVP, 19 hijas, 2 de datos personales, 2 catálogos), pero la migración 0010 puso RLS en 38 tablas y hay tablas del esquema que no están en ninguna lista. **Esta es la causa raíz de todos los hallazgos anteriores.**

7. [MEDIA] El segmento (app) de la web no tiene frontera de error: solo existe finanzas/error.tsx. Con un DEMO_WORKSPACE_ID que no corresponde a ninguna fila, la portada responde 500 con el documento genérico de Next, en inglés. Falta error.tsx y loading.tsx del segmento, con sus textos en español, y quitar de la portada la dependencia de base que solo servía para formatear una fecha.

8. [BAJA] UUID_RE está copiado en apps/web/lib/workspace/current.ts y en finanzas/facturas/actions.ts, pese a que @mc/db ya exporta isUuid.

9. [BAJA] apps/web/lib/format.ts convierte el dinero a number para formatearlo y decide los centavos con \`Math.round(abs * 100) % 100\`, en un repositorio cuya regla es «dinero en numeric(14,2), nunca float». numeric(14,2) admite valores que no caben exactos en un double. Formatear desde el string.

10. [BAJA] La receta \`verificar\` del Makefile no está en .PHONY.
`

const BRIEF = `
QUÉ CONSTRUYES

**El encargo no es tapar los diez hallazgos de arriba. Es cerrar la CLASE.**
La fase 1 gastó cinco rondas tapando casos uno a uno: cada ronda arreglaba los que le nombraban y los revisores encontraban los siguientes, siempre del mismo tipo. Si haces eso otra vez, esto no termina.

1. **Invierte la guardia de esquema** (packages/db/src/esquema.ts). Hoy pregunta «¿están estas tablas protegidas?». Debe preguntarle a la BASE: trae de information_schema y pg_class TODAS las tablas de public y exige aislamiento en todas, con una lista corta y EXPLÍCITA de excepciones, cada una con su motivo escrito (catálogos de solo lectura, tablas del esquema de migraciones, etc.). Incluye las tablas cuya clave de inquilino no se llama workspace_id (la propia \`workspace\`, y las hijas que heredan por clave ajena). Una tabla nueva sin política y sin excepción declarada debe hacer fallar la prueba, no pasar en silencio.
2. **Corre esa guardia y cierra TODO lo que reporte**, no solo lo que está en la lista de hallazgos. Empieza por ahí: es muy probable que aparezcan tablas que nadie ha mencionado todavía.
3. **Revoca lo que mc_app no debe poder hacer.** Los revisores midieron 99 tablas × 4 privilegios para mc_app contra la Supabase real. Un rol de aplicación no necesita escribir catálogos ni borrar inquilinos. Deja los GRANT mínimos, en la migración, tabla por tabla o por patrón, con el motivo escrito.
4. **Prueba cada agujero antes de taparlo.** Para cada caso, una prueba en pglite que falle contra el esquema de hoy y pase con tu migración: leer, actualizar y borrar desde el workspace equivocado. Los revisores dejaron guiones de sonda; repítelos como pruebas de verdad en packages/db/test/rls.test.ts.
5. **Las fronteras de error de la web** (punto 7) y la higiene de los puntos 8, 9 y 10.

CÓMO
- Una migración nueva con el siguiente número libre (hoy la última es 0021_app_user_self_update.sql, así que empieza en 0022; comprueba). NO toques ninguna migración ya existente.
- Verifícala con \`make db.check\` (Postgres embebido). NO corras \`make db.migrate\`: aplicar a Supabase es del integrador.
- Si algo exige crear o alterar un ROL de Postgres, no lo hagas: mc_migrator no tiene CREATEROLE. Déjalo escrito en pending con el comando exacto para \`./scripts/supabase-admin.sh\`.
- Actualiza el estado y la nota de CIM-1 y CIM-2 en platform/apps/web/content/backlog.ts.

TERMINADO CUANDO
- La guardia invertida corre contra pglite y contra Supabase y no reporta ninguna tabla sin política ni excepción declarada.
- rls.test.ts prueba, para workspace, membership, app_user, company, los catálogos, api_call_log y api_quota_usage, que desde el workspace equivocado no se lee, no se escribe y no se borra.
- \`pnpm verificar\` y \`pnpm --filter @mc/web build\` en verde.
- La portada con un DEMO_WORKSPACE_ID inexistente muestra un error en español dentro del marco de la aplicación, no el 500 genérico de Next.
`

const ALCANCE = `
ALCANCE DE ESTA REVISIÓN (léelo antes de puntuar)
Esta ronda tiene un encargo acotado. Puntúa SOLO:
  (a) el aislamiento por fila del esquema y los privilegios de mc_app;
  (b) que la guardia de esquema sea de verdad una guardia (que una tabla nueva sin política la haga fallar);
  (c) las fronteras de error y carga del segmento (app) de la web;
  (d) los puntos de higiene 8, 9 y 10 de la lista de hallazgos;
  (e) cualquier REGRESIÓN que este trabajo haya introducido en lo que ya funcionaba.
Todo lo demás de la pieza ya fue revisado y aceptado en la fase 1: NO lo vuelvas a juzgar ni lo puntúes. Si ves algo fuera de alcance que te parezca grave, repórtalo con en_alcance=false y NO lo descuentes de la nota.
Marca en_alcance=true solo en lo que cae en (a) a (e).
`

const RUBRICA = `
RÚBRICA (0 a 10, umbral ${UMBRAL})
Corre TÚ los comandos y reproduce TÚ los ataques; no te fíes del resumen.
1. Cierra la clase (peso 4). No basta con que los diez hallazgos estén tapados: la guardia debe ser inversa (pregunta a la base) y debe fallar si mañana alguien agrega una tabla sin política. Comprueba eso creando una tabla de prueba en pglite y viendo que la guardia la caza. Si sigues encontrando tablas sin política ni excepción declarada, la nota máxima es 6.
2. Está probado (peso 2). Cada agujero con una prueba que falla contra el esquema anterior. Intenta tú mismo leer, escribir y borrar cruzando workspaces: si alguno pasa, dilo con el guión exacto.
3. No rompió nada (peso 2). \`pnpm verificar\` y el build en verde; el seed sigue sembrando; las pantallas que ya existían siguen funcionando. Si algo falla, la nota máxima es 5.
4. Experiencia y convenciones (peso 1,5). Fronteras de error en español dentro del marco; higiene 8, 9 y 10; comentarios que expliquen el porqué de cada excepción declarada.
5. Reversibilidad y claridad (peso 0,5). La migración es legible, comenta cada decisión, y lo que no se pudo hacer (roles) queda escrito con su comando.
Nota = suma ponderada, un decimal. Cada punto que quites lleva un finding con lugar y arreglo concreto, y con en_alcance. Findings vacíos con nota bajo ${UMBRAL} no valen.
`

function promptConstruir(ronda, findings) {
  const extra = findings ? `
LO QUE LOS REVISORES ENCONTRARON EN LA RONDA ANTERIOR (resuélvelo todo; si alguno te parece equivocado, explícalo en decisions con evidencia, no lo ignores):
${findings.map((f, i) => `${i + 1}. [${f.severity}] ${f.where}: ${f.issue}\n   Arreglo: ${f.fix}`).join('\n')}
` : ''
  const branch = `rasheed/endurecer-db${ronda > 1 ? `-r${ronda}` : ''}`
  return `Eres el constructor del endurecimiento del esquema de On Cue, ronda ${ronda}.
${CONTEXTO}
${HALLAZGOS}
${BRIEF}
${extra}
PROTOCOLO: estás en un worktree limpio. \`git checkout -b ${branch} ${ronda > 1 ? `rasheed/endurecer-db${ronda > 2 ? `-r${ronda - 1}` : ''}` : RAMA}\`; \`cd platform && pnpm install\`; si necesitas credenciales, \`make db.unlock\`. Trabaja hasta cumplir el «terminado cuando». Commits en español con el id de la historia al frente. Termina con \`git checkout --detach\`.
Devuelve el JSON del esquema con la rama (${branch}) y el SHA.`
}

function promptRevisar(lente, branch, ronda) {
  const foco = lente === 'ataque'
    ? `LENTE DE ATAQUE. Tu trabajo es romper el aislamiento. Levanta pglite con las migraciones de la rama, ponte como mc_app, y prueba a leer, actualizar y borrar filas de otro workspace en TODAS las tablas que puedas, no solo en las de la lista. Comprueba también los privilegios de mc_app contra la Supabase real si tienes credenciales (\`make db.unlock\`, \`make db.sql\`). Y comprueba que la guardia es de verdad inversa: crea una tabla con workspace_id y sin política y mira si la prueba falla como debe.`
    : `LENTE DE PRODUCTO Y OFICIO. Levanta la aplicación (\`pnpm --filter @mc/web dev --port NNNN\` con un puerto libre entre 3100 y 3999) y comprueba las fronteras de error y carga: con DEMO_WORKSPACE_ID inexistente, con la base caída, y en las rutas del segmento (app). Todo en español, dentro del marco, con acción de reintentar, en claro y en oscuro y a 400 px. Revisa además la higiene de los puntos 8, 9 y 10, la legibilidad de la migración y que cada excepción declarada tenga su motivo escrito y sea cierto.`
  return `Eres un revisor independiente y exigente del endurecimiento del esquema, ronda ${ronda}. No construiste nada.
${CONTEXTO}
EL ENCARGO QUE SE REVISA:
${BRIEF}
${ALCANCE}
${foco}
PROTOCOLO: worktree limpio; \`git checkout ${branch}\`; \`cd platform && pnpm install\`. No modifiques archivos de la rama. Al terminar, \`git checkout --detach\`.
${RUBRICA}
Devuelve el JSON del esquema.`
}

function promptIntegrar(branch, score) {
  return `Eres el integrador del endurecimiento del esquema. Trabajas en el checkout principal, que está en ${RAMA}. NO uses worktrees.
${CONTEXTO}
RAMA A INTEGRAR: ${branch} (nota ${score}).
PROTOCOLO:
1. \`git status\` limpio y \`git branch --show-current\` = ${RAMA}. Si no, ok=false y explícalo.
2. \`git merge --no-ff ${branch}\`. Conflictos esperables en package.json y pnpm-lock.yaml: conserva ambas dependencias y regenera el lockfile con \`pnpm install\`.
3. En platform/: \`pnpm install\`, \`pnpm verificar\`, \`pnpm --filter @mc/web build\`.
4. Migraciones nuevas: \`make db.check\` y, si pasa, \`make db.migrate\` (Supabase es la base de desarrollo). Si la migración necesita un cambio de rol que mc_migrator no puede hacer, NO lo intentes: déjalo en notes con el comando de supabase-admin.sh.
5. Después de migrar, comprueba contra Supabase que la guardia invertida no reporta nada: corre la prueba o la consulta que la rama deje para eso, y pon el resultado en notes.
6. Revisa el estado de CIM-1 y CIM-2 en platform/apps/web/content/backlog.ts.
7. Deja el checkout en ${RAMA} con todo commiteado. No hagas push, no toques main, no despliegues.
Devuelve el JSON del esquema.`
}

// ---------------------------------------------------------------------
phase('Endurecer')
let findings = null
let branch = null
let score = 0

for (let ronda = 1; ronda <= MAX_RONDAS; ronda++) {
  const r = await agent(promptConstruir(ronda, findings), {
    label: `endurecer r${ronda}`, phase: 'Endurecer', isolation: 'worktree', effort: 'high', schema: BUILD,
  })
  if (!r || !r.branch) return { ok: false, etapa: `construcción ronda ${ronda}`, detalle: 'el constructor no devolvió rama' }
  branch = r.branch

  phase('Verificar')
  // Barrera legítima: la nota es el mínimo de dos lentes distintas.
  const [ataque, oficio] = await parallel([
    () => agent(promptRevisar('ataque', branch, ronda), { label: `revisar-ataque r${ronda}`, phase: 'Verificar', isolation: 'worktree', effort: 'high', schema: REVIEW }),
    () => agent(promptRevisar('oficio', branch, ronda), { label: `revisar-oficio r${ronda}`, phase: 'Verificar', isolation: 'worktree', effort: 'high', schema: REVIEW }),
  ])
  const na = ataque ? ataque.score : 0
  const no = oficio ? oficio.score : 0
  score = Math.min(na, no)
  const enAlcance = [...((ataque && ataque.findings) || []), ...((oficio && oficio.findings) || [])].filter((f) => f.en_alcance !== false)
  const fuera = [...((ataque && ataque.findings) || []), ...((oficio && oficio.findings) || [])].filter((f) => f.en_alcance === false)
  log(`ronda ${ronda}: ataque ${na} · oficio ${no} · mínimo ${score} (umbral ${UMBRAL}) · ${enAlcance.length} en alcance, ${fuera.length} fuera`)

  if (score >= UMBRAL) {
    phase('Integrar')
    const int = await agent(promptIntegrar(branch, score), { label: 'integrar', phase: 'Integrar', effort: 'high', schema: MERGE })
    return { ok: !!(int && int.ok), score, rondas: ronda, branch, integracion: int, fueraDeAlcance: fuera }
  }
  if (ronda === MAX_RONDAS) {
    log(`no alcanzó ${UMBRAL} en ${MAX_RONDAS} rondas; se entrega con ${score}`)
    return { ok: false, score, rondas: ronda, branch, findings: enAlcance, fueraDeAlcance: fuera }
  }
  findings = enAlcance
  phase('Endurecer')
}
