# Cierre de los módulos de Rasheed · revisión del 9-oct-2026 y prompts

Escrito para: Rasheed, que lanza una sesión de Claude Code por prompt, y
para esas sesiones. La sección 0 y el prompt R0 son para Nicolás, que
coordina y tiene que dar el visto bueno a lo que Rasheed tocó de sus
carpetas.

Fecha: 9 de octubre de 2026. Sigue el formato de
`docs/cierre-modulos-nicolas-prompts.md`: **un prompt = una sesión**, en
su propio worktree, en modo autónomo, con la autoevaluación contra la
rúbrica de 9,5/10 al final. Cada prompt cierra un módulo (o un bloque
de pendientes de un módulo) y lo deja en `main` y en producción.

---

## Cómo se usa (léelo primero)

Los prompts ya armados, con el bloque común incluido, están en:

```
docs/prompts/cierre-rasheed/R0-REVISION-NICOLAS.txt   (la corre Nicolás)
docs/prompts/cierre-rasheed/R1-INTEGRACION.txt        (rasheed/integracion → main → producción, 0078–0084)
docs/prompts/cierre-rasheed/R2-ACC.txt                (permisos, puertas y alcance en Ventas/Cotizar/Resumen; ACC-7 r6; ACC-10)
docs/prompts/cierre-rasheed/R3-VEN.txt                (VEN-9 en vivo, VEN-14 llave, pulido de Ventas)
docs/prompts/cierre-rasheed/R4-RES.txt                (RES-4 demografía y pulido de Resumen)
docs/prompts/cierre-rasheed/R5-COT.txt                (pulido de Cotizar y su costura con Campañas)
docs/prompts/cierre-rasheed/R6-CIM-7-TURNOS.txt       (despliegue continuo y VEN-17)
docs/prompts/cierre-rasheed/R7-ANTES-DEL-PRIMER-CLIENTE.txt (CIM-9 legal, CIM-10 CAPTCHA/SMTP, CON-9 trámites)
docs/prompts/cierre-rasheed/CONTINUAR-DESPLIEGUE.txt
```

1. **Abre el worktree** que dice la tabla de §1 (desde `rayit/platform`):
   `git fetch origin && git worktree add -b <rama> ../<carpeta> <base>`.
   La base es `origin/rasheed/integracion` para R1 y `origin/main` para
   todos los demás (que solo se lanzan cuando R1 ya está en `main`).
2. `cd ../<carpeta>/platform && claude`.
3. **Pega el archivo entero** como primer mensaje. La primera línea es
   `DESPLIEGUE: AUTORIZADO`. Si la dejas, la sesión hace el push a
   `main` por avance rápido y despliega cuando todo esté verde. Con
   `DESPLIEGUE: NO` se detiene antes y te deja los comandos.
4. **Si el prompt trae migración**, la sesión se detiene antes del
   push, te da el comando `make db.migrate` y espera. Cuando la hayas
   aplicado, pega en la misma sesión `CONTINUAR-DESPLIEGUE.txt`. R1 es
   especial: su migración 0083 obliga a construir antes de migrar y
   promover después; la receta va dentro del prompt.
5. Lee la entrega: la autoevaluación trae los criterios R1 a R12 con
   evidencia y la tabla de decisiones queda en
   `docs/propuestas/CIERRE-<MÓDULO>-R.md`.

Si cambias un prompt de este documento, regenera los archivos:

```bash
python3 docs/prompts/cierre-rasheed/armar.py
```

---

## 0. Dónde estamos: evidencia, no afirmaciones

Sacado el 9-oct-2026 a mediodía con `git fetch`, `git rev-list`,
`git show origin/rasheed/integracion:…`, `make db.sql` (solo lectura),
`ps`, y la API de Vercel (`run ls`, `run api /v13/deployments`,
`/v9/projects`, `env ls production`).

| Cosa | Estado |
|---|---|
| `origin/main` | `50145b34` (4-oct, Nicolás: vault de META_APP_*). Rasheed no tiene nada en `main` desde `ba63f834` (4-oct, CIM-7 firma del turno) |
| `origin/rasheed/integracion` | `1b7777a0` (7-oct). **156 commits por delante de `main` y 0 por detrás**: ya contiene todo `main`. Es la única rama remota suya (sus ramas por historia viven en su máquina) |
| Qué trae esa rama que `main` no tiene | La **fase 9** entera: CIM-12 (verificar determinista), ACC-4 (pantalla Equipo), RES-3 (lo que importa esta semana), ACC-7 (RLS por creador), CIM-11 (ids sin contador) y el arreglo de VEN-17 del 7-oct (search_path con `extensions`). Migraciones **0078–0084** y seeds **0011, 0012, 0013** |
| Supabase | **0001–0077 aplicadas** (76 filas; 0023 es el hueco declarado). Faltan 0078–0084 y los seeds 0011–0013. El `ALTER ROLE … SET search_path` y el `GRANT USAGE ON SCHEMA extensions TO mc_worker` de VEN-17 ya se corrieron «en caliente» el 7-oct; 0084 los deja escritos |
| Producción (`on-cue-web`) | Sirve **`90f76503`** (CON-3 Instagram, 4/5-oct) = `main` menos el commit del vault. Los cuatro últimos despliegues son de hace 5 días |
| GitHub ↔ Vercel | **No conectado** (`link: null` en el proyecto). El «terminado cuando» de CIM-7 («un merge a main aparece en la URL sin correr ningún comando») no se cumple |
| Turnos del worker (pg_cron → `/api/cron/tick`) | `CRON_SECRET` y `WORKER_DATABASE_URL` están en Vercel. **No se pudo verificar desde esta máquina**: `job_run` no es visible para `mc_app` (0 filas con y sin workspace) y `make cron.status` solo existe en la rama de Rasheed y pide el `CRON_SECRET`. Lo verifica Rasheed con `make cron.status` |
| Variables en Vercel (production) | Están: `APP_URL`, `DATABASE_URL`, `WORKER_DATABASE_URL`, `CRON_SECRET`, `DEMO_WORKSPACE_ID`, `OAUTH_CONNECT`, `TOKEN_ENCRYPTION_KEY`, `TIKTOK_LOGIN_*`, `META_APP_*`, `INSTAGRAM_HOUSE_TOKEN`, `GOOGLE_API_KEY`, **`GOOGLE_OUTREACH_CLIENT_ID/SECRET`, `UNIPILE_DSN`, `UNIPILE_ACCESS_TOKEN`, `UNIPILE_WEBHOOK_SECRET`** (las de VEN-9 ya están). **Faltan**: `ANTHROPIC_API_KEY` (VEN-14), `TURNSTILE_SITE_KEY` (CIM-10), `SUPPORT_EMAIL` (CIM-9), `GOOGLE_CLIENT_ID/SECRET` (CON-8, de Nicolás) |
| `pnpm verificar` sobre `rasheed/integracion` | **No lo corrí** (la máquina estaba ocupada con el QA de Nicolás). Los commits de Rasheed del 7-oct dicen «pnpm verificar y build de @mc/web en verde» en cada ronda; R1 lo vuelve a correr |

### 0.0 ¿Hay algo de Rasheed corriendo ahora mismo en esta máquina?

No. Lo que corre a las 12:50 del 9-oct es de Nicolás:

- `pnpm verificar` en `rayit-qa` (rama `nicolas/QA-modulos-sprint`,
  `node --test` del worker desde las 12:45 y nueve vitest de la web),
  más tres sesiones de Claude Code (del 4-oct, del 5-oct y la de hoy).
- Dos procesos **zombis** `node src/index.ts -- --demo` del worker en
  `rayit-cierre-con-a` desde el **23-sep**. No hacen nada útil; se
  pueden matar (`kill 76832 71426`).

Rasheed trabaja en su máquina: lo único que se ve de él desde aquí es
su rama, cuyo último commit es del 7-oct a última hora.

### 0.1 Las 42 historias de Rasheed, módulo por módulo

Regla del tablero: «hecho» solo si está en `main`.

**En `main` y en producción (27):** CIM-2, CIM-3, CIM-2c, CIM-6, RES-1,
RES-2, RES-5, RES-6, VEN-1 a VEN-8, VEN-10 a VEN-16, COT-1 a COT-4.

**Hechas en `rasheed/integracion`, sin fusionar (6):** CIM-1, CIM-11,
CIM-12, RES-3, ACC-4, ACC-7. Todas con migración o seed sin aplicar en
Supabase, y cuatro de ellas (ACC-4, RES-3, CIM-11, CIM-7) **tocan
archivos de Nicolás y piden su visto bueno antes del merge** (ver §0.4).

**En curso (1):** CIM-7. El worker por turnos está en producción desde
el 28-sep; falta conectar GitHub a Vercel y el visto bueno de Nicolás
al runner (`rasheed/CIM-7-runner-1`, ya dentro de `integracion`).

**Bloqueadas (2):** CIM-10 (Turnstile + SMTP: código listo, espera a
una persona) y VEN-9 (código listo contra dobles; las llaves **ya están
en Vercel**, falta grabar las sesiones reales de Google y Unipile, §9.3
de ventas-outreach.md).

**Pendientes (6):** CIM-9 (texto legal), CON-9 (trámites), RES-4
(demografía en pantalla: **ya no está bloqueada**, CON-7 se probó en
vivo en producción el 5-oct), VEN-17 (jobs agotados en los turnos: el
7-oct encontró la causa de `outbound.replies`, falta la semana de turnos
limpios y la parte de `collect.account_metrics`), ACC-9 (roles a medida,
fase 2) y ACC-10 (alcance por creador en métricas, dinero y
consentimientos).

Además hay dos listas de hallazgos abiertos que ningún prompt cerró:
`docs/propuestas/pendientes-fase-9.json` (11 hallazgos de ACC-7, nota
9,3 < 9,5) y `docs/propuestas/pendientes-pulido-final.json` (13
hallazgos del pulido final del 28-sep; comprobé que 11 siguen abiertos:
solo `estres-verificar.sh` y la nota de CIM-6 se resolvieron).

### 0.2 Qué le falta a cada módulo para cerrar

| Módulo | Qué falta | Prompt |
|---|---|---|
| **Integración de la fase 9** | Visto bueno de Nicolás; mezclar `origin/main` otra vez (Nicolás tiene dos ramas de QA sin fusionar que tocan `collect-account-metrics.ts`, el mismo archivo que RES-3); `pnpm verificar` completo; aplicar 0078–0084 y seeds 0011–0013 con la receta «construir antes, migrar, promover»; reinstalar el cron; pasar las 6 historias a «hecho» | R0 (Nicolás) y R1 |
| **CIM** | CIM-7: conectar GitHub a Vercel y probar que un merge publica solo. VEN-17: una semana de turnos sin `exhausted` ni `failed`. CIM-9: /legal con texto revisado y `SUPPORT_EMAIL`. CIM-10: Turnstile + SMTP propio. CON-9: trámites iniciados con número de caso en `docs/tramites.md` | R6 y R7 |
| **ACC (su parte)** | CIERRE-ACC §5: `requirePermission` en las 27 Server Actions de Ventas (12), Cotizar (14) e importar (1); puerta en 14 páginas; `ventas`, `cotizar`, `resumen` en `MODULOS_CON_CONVENCION` y `MODULOS_CON_PUERTA_EN_PAGINA`; pruebas de alcance de `queries/ventas.ts` (26), `queries/cotizar/*` (48) y `queries/resumen.ts` (12); Contadora de demo en el seed; `ScopeError` en `codigoDe`. Los 11 hallazgos de ACC-7 (r6). ACC-10 | R2 |
| **VEN** | VEN-9: grabar las tres sesiones reales y conectar un Gmail y un LinkedIn en producción. VEN-14: `ANTHROPIC_API_KEY` en Vercel y el clasificador real probado. Pulido: narrativa sin datos, «views» en 0067/0046, «captions», «Activar» sin aviso prematuro, `UUID_RE` por triplicado | R3 |
| **RES** | RES-4 sobre lo que recolecta CON-7 (ya hay datos reales de @nicolasduartea). Pulido: partir `asistente.tsx` (1 025 líneas), etiquetas del gráfico a 1 280 px, hidratación #418 del media kit, prueba de actualización 0033 → 0084 | R4 |
| **COT** | Pulido: `FechaInput` → PR al kit (`DateInput` con anillo de foco, visto bueno de Nicolás), segundo enlace del tarifario vacío a /resumen/importar, hidratación de /kit. Fase 9: `createQuote` exige el creador del negocio. Costura COT-4 ↔ CAM-2 con alcance | R5 |
| **ACC-9** | Fase 2 (roles a medida). No entra en el cierre del MVP; queda en su workflow (fase 10) | — |

### 0.3 Lo que no es de una sesión (lo hace Rasheed a mano, en paralelo a la ola 1)

1. **GitHub → Vercel** (CIM-7): en el panel de Vercel, proyecto
   `on-cue-web` → Settings → Git → Connect `rasheedb1/rayit`, rama de
   producción `main`, Root Directory `apps/web` (ya está). Un clic.
2. **`ANTHROPIC_API_KEY`** en Vercel (production y preview) y en el
   vault (VEN-14). Sin ella las respuestas no se clasifican solas.
3. **Cloudflare Turnstile** (CIM-10): crear el sitio, meter
   `TURNSTILE_SITE_KEY` en Vercel, desplegar, y SOLO DESPUÉS encender
   Attack Protection en Supabase con la clave secreta. Y el SMTP propio
   en Project Settings → Auth → SMTP.
4. **`SUPPORT_EMAIL`** en Vercel (CIM-9) y alguien que revise el texto
   legal.
5. **CON-9**: iniciar Accounts API de TikTok, App Review + Business
   Verification de Meta y la auditoría de Google con las cuentas de
   empresa. Fecha y número de caso en `docs/tramites.md` (R7 deja la
   plantilla).
6. **Las sesiones de grabación de VEN-9** (§9.3 de ventas-outreach.md):
   necesitan un túnel, un buzón de pruebas y un LinkedIn de pruebas. R3
   lo guía paso a paso.
7. `make db.migrate` cuando R1 (0078–0084) y, si la hay, la migración
   de R2 (ACC-10) se detengan en la PARADA 1.

### 0.4 Lo que depende de Nicolás (y lo bloquea todo)

El merge de `rasheed/integracion` a `main` está parado por **cuatro
vistos buenos** que Rasheed pidió por escrito y Nicolás no ha dado:

| Historia | Archivos de Nicolás que tocó | Dónde está explicado |
|---|---|---|
| ACC-4 | `components/nav.tsx`, `content/modules.ts`, `packages/db/src/queries/accesos.ts`, `queries/conexiones.ts`, `packages/core/src/permisos.ts` | `docs/propuestas/CIERRE-ACC.md` §7bis (filas 1, 4, 5 y 6) |
| RES-3 | `apps/worker/src/jobs/conexiones/{aviso-cuenta.ts (nuevo), _posts.ts, collect-account-metrics.ts, oauth-refresh.ts}` | `docs/fases-rasheed.md` §9 (con la vuelta atrás si no lo aprueba) |
| CIM-11 | `apps/worker/src/runner/{run,once,comun,registry,worker}.ts`, `demo.ts`, `queries/campanas.ts`, 12 archivos de prueba del worker y de connectors, `apps/worker/README.md`, `docs/propuestas/WRK.md` | `docs/fases-rasheed.md` §10 |
| CIM-7 | El runner por turnos (`rasheed/CIM-7-runner-1`, ya en producción) | `docs/propuestas/CIM-12.md` «Resultado» y nota de CIM-7 |
| CIM-12 | `packages/connectors/test/helpers/pglite.ts`, `apps/worker/test/helpers/harness.ts`, `apps/worker/package.json`, varias pruebas | `docs/propuestas/CIM-12.md` «Archivos de Nicolás que se tocaron» |

Y un choque previsible: las ramas `nicolas/QA-modulos-sprint` (en
`rayit-qa`, con cambios sin commitear) y `nicolas/QA-9-5-modulos`
(`rayit-qa2`) modifican `collect-account-metrics.ts`,
`cuentas-service.ts` y `collect-post-metrics.test.ts`, que la rama de
Rasheed también cambia. Quien entre segundo en `main` resuelve el
conflicto. Recomendación: **Nicolás cierra su QA en `main` primero**
(es pequeño) y R1 trae `origin/main` encima; si no, R1 entra primero y
el QA se rebasa encima.

---

## 1. Olas, worktrees y orden de salida

| Ola | Prompt | Quién | Worktree y rama | Base | Migración | Depende de |
|---|---|---|---|---|---|---|
| 0 | **R0-REVISION-NICOLAS** | Nicolás | `../rayit-revision-rasheed` · `nicolas/revision-fase-9` | `origin/rasheed/integracion` | no | — |
| 0 | QA de Nicolás a `main` | Nicolás | `rayit-qa` | — | no | — |
| 1 | **R1-INTEGRACION** | Rasheed | `../rayit-r1` · `rasheed/integracion` (la misma rama) | `origin/rasheed/integracion` | **0078–0084** + seeds 0011–0013 | R0 con los vistos buenos |
| 2 | **R2-ACC** | Rasheed | `../rayit-r2-acc` · `rasheed/ACC-cierre-r` | `origin/main` | **0085** (ACC-10 y `scope_allows` con search_path) | R1 en `main` |
| 2 | **R3-VEN** | Rasheed | `../rayit-r3-ven` · `rasheed/VEN-cierre-r` | `origin/main` | no (0046–0077 ya aplicadas) | R1 en `main`; §0.3 puntos 2 y 6 |
| 2 | **R4-RES** | Rasheed | `../rayit-r4-res` · `rasheed/RES-cierre-r` | `origin/main` | no | R1 en `main` |
| 3 | **R5-COT** | Rasheed | `../rayit-r5-cot` · `rasheed/COT-cierre-r` | `origin/main` | no | R2 en `main` (usa la convención de permisos) |
| 3 | **R6-CIM-7-TURNOS** | Rasheed | `../rayit-r6-cim7` · `rasheed/CIM-7-cierre` | `origin/main` | no | R1 en `main`; §0.3 punto 1; una semana de turnos |
| 3 | **R7-ANTES-DEL-PRIMER-CLIENTE** | Rasheed | `../rayit-r7-cliente` · `rasheed/CIM-9-10-CON-9` | `origin/main` | no | §0.3 puntos 3, 4 y 5 |

- **Nunca más de tres sesiones a la vez** por máquina: con la máquina
  cargada las pruebas de `@mc/db` se cancelan en bloque.
- **Números de migración**: 0085 reservado para R2. Cualquier otra, el
  máximo de todas las ramas + 1 (`git ls-tree origin/<rama>
  platform/db/migrations/`).
- **El orden de salida lo da `main`**: quien termina primero despliega
  primero; el protocolo del bloque común (F5) obliga a traer
  `origin/main`, verificar otra vez y hacer push solo por avance rápido.
- R2 va antes que R5 a propósito: R5 necesita `ventas`/`cotizar` ya en
  `MODULOS_CON_CONVENCION` para que su costura con CAM-2 pase por la
  misma prueba.

---

## 2. Bloque común (versión cierre de Rasheed)

Va **al principio de cada prompt de Rasheed** (R1 a R7), tal cual.

```
CONTEXTO COMÚN — On Cue (repositorio rayit), CIERRE DE MÓDULOS de
Rasheed. Fecha de la foto: 9-oct-2026 a mediodía.

QUIÉN SOY. Soy Rasheed, dueño de CIM-1/2/3/6/7/9/10/11/12, RES, VEN,
COT, ACC-4/7/9/10 y CON-9; de lib/auth/, lib/workspace/,
packages/db/src/{client,schema,queries/{resumen,resumen-semana,ventas,
ventas-ficha,cotizar,equipo,accesos}}, db/migrations/, db/seed/ y de
las carpetas app/(app)/{resumen,ventas,cotizar,accesos} y app/(public)/
{kit,cotizacion,baja}. Nicolás es dueño de Conexiones (CON), Campañas
(CAM), Finanzas (FIN) y ACC-1/2/3/5/6/8; del marco (app/layout.tsx,
components/shell.tsx, nav.tsx, content/flags.ts, content/modules.ts,
globals.css); de apps/web/components/ui/; de packages/connectors/; de
apps/worker/ (runner y jobs); y de packages/core/src/{scoring,
facturacion,campanas,flujo-caja,ingresos-plataformas,reporte,
permisos}.ts.

EL OBJETIVO DE ESTE PROMPT es CERRAR UN MÓDULO (o un bloque de
pendientes de un módulo): todo integrado en main, verde, cosido con los
módulos vecinos (cada costura con una prueba), las notas del tablero
diciendo la verdad, las decisiones pendientes en una sola tabla y el
módulo DESPLEGADO en producción y comprobado ahí. La puerta de calidad
es la de siempre: 9,5/10 con la rúbrica de docs/fases-rasheed.md §2
(funciona 3 · terminado cuando 2 · seguridad de datos 1,5 ·
convenciones 1 · experiencia 1,5 · código 1). Si un comando falla, la
nota máxima es 5.

LA FOTO (verificada el 9-oct; no la vuelvas a investigar salvo para
refrescarla con git fetch):
- origin/main = 50145b34. origin/rasheed/integracion = 1b7777a0, 156
  commits por delante y 0 por detrás de main. Producción (proyecto
  Vercel on-cue-web, alias https://on-cue-web.vercel.app) sirve
  90f76503.
- Supabase: 0001–0077 aplicadas (0023 es un hueco declarado). Sin
  aplicar: 0078_equipo, 0079_equipo_cerrojos, 0080_equipo_quien_invito,
  0081_lo_que_importa, 0082_alcance_por_creador, 0083_ids_sin_contador,
  0084_search_path_extensions y los seeds 0011, 0012 y 0013. 0085 está
  reservada para R2-ACC. Cualquier otra: git fetch y el máximo en TODAS
  las ramas + 1.
- El worker corre POR TURNOS en producción (/api/cron/tick llamado por
  pg_cron cada minuto; make cron.status lo dice). No hay proceso largo
  ni pg-boss en producción. Todo lo que dependa de un job tiene que
  caber en un turno de 45 s o retomarse en el siguiente.
- GitHub NO está conectado a Vercel: hoy se despliega a mano con
  ./scripts/vercel.sh desde platform/.
- Variables en Vercel production: APP_URL, DATABASE_URL,
  WORKER_DATABASE_URL, CRON_SECRET, DEMO_WORKSPACE_ID, OAUTH_CONNECT,
  TOKEN_ENCRYPTION_KEY, TIKTOK_LOGIN_CLIENT_KEY/SECRET,
  META_APP_ID/SECRET, INSTAGRAM_HOUSE_TOKEN, GOOGLE_API_KEY,
  GOOGLE_OUTREACH_CLIENT_ID/SECRET, UNIPILE_DSN, UNIPILE_ACCESS_TOKEN,
  UNIPILE_WEBHOOK_SECRET. Faltan ANTHROPIC_API_KEY, TURNSTILE_SITE_KEY,
  SUPPORT_EMAIL y GOOGLE_CLIENT_ID/SECRET (esta última es de Nicolás).
  Nunca las inventes: sin la variable, la función se apaga y lo dice
  con una frase.
- Hallazgos abiertos: docs/propuestas/pendientes-fase-9.json (11, de
  ACC-7) y docs/propuestas/pendientes-pulido-final.json (13 del 28-sep;
  11 siguen abiertos). Cada prompt dice cuáles son suyos.

LECTURAS PREVIAS, antes de tocar un archivo: CLAUDE.md;
platform/apps/web/README.md; platform/packages/db/README.md;
platform/apps/worker/README.md; docs/fases-rasheed.md (§2 la puerta,
§3 lo profesional, §8–§10 las decisiones de RES-1/2, RES-3 y CIM-11);
docs/ventas-outreach.md (§5.2 el esquema y la cola del despliegue,
§8 decisiones, §9.3 la sesión real); docs/backlog-mvp.md (§3 reglas,
§4 dependencias, §5 las filas de mi módulo y la sección de estado más
reciente); docs/propuestas/CIERRE-ACC.md (§5 lo que me toca de ACC,
§7bis lo que ACC-4 tocó); las propuestas de las historias de mi módulo
en docs/propuestas/; mis entradas de
platform/apps/web/content/backlog.ts.

REGLAS DEL REPOSITORIO QUE NO SE NEGOCIAN:
- Comentarios, documentación, mensajes al usuario, commits y ramas en
  español. Identificadores de código y de base en inglés.
- Tipos. timestamptz en UTC y devueltas como ISO; date como 'YYYY-MM-DD'
  (to_char); dinero numeric(14,2) con moneda aparte, string decimal en
  TypeScript y BigInt de centavos solo dentro de core; enumerados text +
  CHECK; tablas de métricas append-only; un nulo no es un cero; ninguna
  consulta devuelve a la web un id numérico (desde 0083 todas las
  claves son uuid; el grep de ids-sin-contador-codigo.test.ts lo vigila).
- Secretos. Nunca leas ni imprimas platform/.env.local, platform/.env ni
  platform/secrets/*.enc. Nunca escribas una credencial en un archivo
  versionado, un log, una URL, un error, job_run.metadata ni
  audit_log.before/after. Variable nueva: dime el nombre y la meto yo.
- Un dueño por carpeta. Lo que necesite de una carpeta de Nicolás va a
  docs/propuestas/CIERRE-<MÓDULO>-R.md con el diff propuesto, o en
  commits propios titulados «(revisión de Nicolás)» si la historia no
  puede cerrar sin ello; en ese caso la nota del tablero dice «hecha,
  pendiente del visto bueno de Nicolás». Las migraciones aplicadas son
  inmutables. Una migración nueva: re-ejecutable (IF NOT EXISTS, DROP
  POLICY IF EXISTS, CREATE OR REPLACE, ADD CONSTRAINT dentro de un DO
  que consulta pg_constraint), con cabecera que diga qué hace y por qué,
  con search_path = public, extensions, pg_temp en toda función
  (packages/db/test/search-path-extensions.test.ts lo exige), con make db.check y make
  db.guardia en verde. NUNCA corras make db.migrate ni escribas en
  Supabase desde la sesión: make db.sql Q="…" solo para leer. Migrar lo
  hago yo en la PARADA 1.
- Toda Server Action: "use server"; zod con formField/firstErrors/
  DECIMAL_RE de @/lib/forms; requirePermission('<módulo>.<recurso>.
  <acción>') como PRIMERA línea; toda escritura de dinero, publicación,
  cuenta conectada o envío llama a audit() DENTRO de la consulta de
  @mc/db (test/audit-convencion.test.ts lo exige); revalidatePath al
  final; textos en messages.ts del módulo. Toda página de un módulo con
  permiso abre con requireModuleAccess/requirePagePermission
  (lib/permisos/paginas.test.ts lo exige).
- El catálogo de permisos viaja en la semilla de 0034 y
  packages/db/test/accesos.test.ts exige que sea idéntico a la salida de
  pnpm --filter @mc/core permisos:sql. Un permiso nuevo exige migración:
  reutiliza uno existente salvo que de verdad no haya ninguno que sirva.
- Alcance (ACC-6/ACC-7): toda consulta de @mc/db que lea filas de un
  creador pasa por el arnés de test/alcance.ts, o está declarada con
  motivo en SIN_ALCANCE_DECLARADAS de alcance-convencion.test.ts. La
  política RESTRICTIVE por creador es para mc_app; worker y enlaces
  públicos quedan fuera.
- Ninguna pantalla hace aritmética de métricas ni de dinero: vistas o
  funciones puras de @mc/core. Kit y formato: components/ui, colores por
  variables de globals.css, dinero y fechas con
  formatterFor(await getCurrentWorkspace()). Cada pantalla se mira a 400
  px y en tema oscuro. Una ausencia se explica con una frase, nunca con
  un guion mudo ni con un cero. Textos de creador: «visualizaciones»,
  nunca «views»; «descripciones», nunca «captions».
- Worker: en producción corre como mc_worker por turnos; cada consulta
  lleva workspace_id explícito; se respeta ctx.signal; reloj ctx.now();
  metadata sin PII ni secretos; un job que no puede correr por falta de
  llave termina como «no configurado» (skipped con motivo), nunca como
  failed ni exhausted.
- Dependencias: antes de agregar una, dime cuál, para qué y cuánto pesa.
  No commitees pnpm-lock.yaml con importers de paquetes fuera de git.

ENTORNO. macOS sin Docker, sin psql y sin GNU timeout; Node 24 y pnpm
9.12. Las pruebas de integración van contra pglite con migraciones y
seeds reales (@mc/db/test/pglite; apps/worker/test/helpers/harness.ts).
pnpm verificar es determinista desde CIM-12 (reloj anclado, --continue):
si algo sale rojo no es «la máquina», es un fallo. La web en dev en un
puerto 3100–3999, lanzada en background y matada al terminar. Antes de
next build o tsc, borra apps/web/.next. Si turbo cancela un paquete,
corre por paquete (pnpm --filter @mc/db test, @mc/worker test) hasta
tener los conteos de TODOS.

GIT. Worktree propio (el comando está en la cabecera del prompt). Hay
otras sesiones en el mismo clon: antes de cada commit, git branch
--show-current y git status; git add solo por rutas propias, nunca -A;
nunca git checkout ni git stash en el árbol principal. Un commit por
paso, con el id de la historia delante. Para traer una rama abierta:
git merge --no-ff (no rebase de ramas publicadas), resolviendo
conflictos a favor de lo que ya está en main y reaplicando encima lo
de la rama; cada conflicto resuelto va explicado en el mensaje del
merge.

FASES. Trabaja en modo autónomo, sin esperar aprobación, salvo en los
dos puntos de parada de F5.
F0 · Foto. git fetch; confirma o corrige la foto de arriba para mi
  módulo. Escribe la sección 0 de docs/propuestas/CIERRE-<MÓDULO>-R.md
  con el inventario: qué está en main, qué falta de cada historia según
  su «terminado cuando» de backlog-mvp.md §5, qué hallazgos abiertos son
  de este módulo, y el plan.
F1 · Construcción. Lo que el prompt enumera, en su orden, con pnpm
  verificar en verde después de cada paso que toque la base.
F2 · Costuras. Cada contrato con otro módulo tiene una prueba que falla
  si se rompe (la lista va en el prompt). Donde una costura depende de
  algo que no existe todavía, la pantalla lo dice con una frase y la
  prueba cubre esa frase.
F3 · Deuda y decisiones. Cierra los hallazgos de pendientes-*.json que
  son de este módulo (cada uno: hecho con su prueba, o por qué no, en
  la tabla). Junta TODAS las «decisión pendiente» de las propuestas del
  módulo en una tabla de CIERRE-<MÓDULO>-R.md: archivo:línea, la
  pregunta en una frase, la opción que quedó en el código, tu
  recomendación y qué cambia si digo lo contrario. No las cambies tú: la
  opción conservadora se queda.
F4 · Verificación. pnpm verificar con los conteos de TODOS los
  paquetes; next build; make db.check y make db.guardia si hay
  migración; verificación en dev de cada pantalla del módulo (400 px y
  oscuro); dos revisores como en fases-rasheed.md §2 (técnico y
  producto), nota mínima 9,5 o una ronda más (máximo cinco); /code-review
  en nivel alto y /security-review si tocaste permisos, RLS, enlaces
  públicos, secretos, envíos o dinero. Resuelve o justifica cada
  hallazgo.
F5 · Salida a producción. La primera línea del prompt dice si está
  AUTORIZADO. El protocolo:
  1. git fetch origin && git merge origin/main (si trae algo, vuelve a
     F4 completo).
  2. SI HAY MIGRACIÓN: PARADA 1. Deja la migración en la rama, con
     db.check y guardia en verde, y entrégame: el número, qué hace, por
     qué es compatible con el código que HOY está en producción (la
     migración se aplica ANTES del deploy y convive con el código viejo
     durante el hueco; si NO es compatible, como 0083, dilo y usa la
     receta de construir antes y promover después de ventas-outreach.md
     §5.2) y el comando exacto:
       cd <clon principal>/platform && make db.migrate
     Después espera a que te pegue CONTINUAR-DESPLIEGUE.
  3. Si DESPLIEGUE: AUTORIZADO, git push origin HEAD:<tu rama> y luego
     git push origin HEAD:main, solo por avance rápido; si lo rechaza,
     alguien entró antes: vuelve al paso 1. Nunca --force. Si dice NO,
     PARADA 2: dame los comandos y termina. NUNCA despliegues desde una
     rama: producción solo sale de origin/main.
  4. Despliega desde un worktree limpio en origin/main (../rayit-deploy
     o equivalente; nunca desde el clon principal):
       git -C ../rayit-deploy fetch origin && git -C ../rayit-deploy checkout --detach origin/main
       cd ../rayit-deploy/platform && pnpm install --frozen-lockfile
       ./scripts/vercel.sh run ls on-cue-web     # la URL anterior es el plan B
       ./scripts/vercel.sh run deploy --cwd "$PWD" --yes --prod
     Si GitHub ya está conectado a Vercel (CIM-7 cerrada), el push a
     main despliega solo: entonces espera al despliegue y verifica.
  5. Comprueba en producción: run api /v13/deployments/<url> →
     meta.gitCommitSha = tu commit; cada pantalla del módulo responde;
     make cron.status en verde; los seeds nuevos en la demo. Si algo
     falla, promueve la URL anterior (plan B) y dímelo.
F6 · Entrega. Lista de archivos; cada criterio del «terminado cuando»
  con su evidencia (comando y salida, o pantalla y qué se vio); los
  conteos de pruebas por paquete; la tabla de decisiones; la nota corta
  de cada historia en content/backlog.ts (status y note con fecha); el
  texto del PR en español; y la autoevaluación contra la rúbrica con la
  nota de cada revisor. Lo que quedó fuera, dicho con nombre y motivo.
```

---

## 3. Los prompts

### R0 · REVISIÓN DE NICOLÁS a lo que Rasheed tocó (la corre Nicolás)

Worktree: `git worktree add -b nicolas/revision-fase-9 ../rayit-revision-rasheed origin/rasheed/integracion`.
Sin bloque común de Rasheed: lleva su propia cabecera.

```
DESPLIEGUE: NO

Soy Nicolás. Rasheed tiene en origin/rasheed/integracion (1b7777a0,
7-oct-2026) la fase 9 de su plan, 156 commits por delante de main, y
no puede fusionarla porque cuatro historias suyas tocan archivos míos
y pidió mi visto bueno por escrito. Este prompt es ESA revisión: no
construye nada, decide. Lee CLAUDE.md, docs/fases-rasheed.md §9 y §10,
docs/propuestas/CIERRE-ACC.md §7bis, docs/propuestas/CIM-12.md
(«Archivos de Nicolás que se tocaron» y «Resultado») y la nota de CIM-7
en platform/apps/web/content/backlog.ts.

Mis carpetas: apps/worker/ (runner y jobs), packages/connectors/,
components/nav.tsx, content/modules.ts, components/ui/,
packages/core/src/permisos.ts, packages/db/src/queries/{accesos,
conexiones,campanas}.ts, app/(app)/{conexiones,campanas,finanzas}.

PASOS.
1. Inventario exacto: git diff --stat origin/main...origin/rasheed/
   integracion -- <cada carpeta mía>. Agrupa por historia (ACC-4, RES-3,
   CIM-11, CIM-7, CIM-12) usando git log --format=%s de cada archivo.
   Nada que no esté en esa lista cuenta como «mío tocado».
2. Por historia, lee el diff ENTERO y contrástalo con lo que Rasheed
   escribió que haría (§9, §10, §7bis). Para cada archivo: ¿cambia lo
   que hace un job o una pantalla mía, o solo el tipo del runId, el
   orden o un título? ¿Tiene prueba? ¿Rompe algún contrato de mis
   módulos (CON-2 runner, CON-4 Conexiones, CAM-5 reporte, ACC-5
   permisos, ACC-8 consentimiento)? Corre las pruebas de mis paquetes
   sobre su rama: pnpm --filter @mc/worker test, @mc/connectors test,
   @mc/core test, y la web filtrada a conexiones/, campanas/,
   finanzas/, components/.
3. RES-3 (§9): decide sobre el cambio de título de markNeedsReauth
   («TikTok dejó de darnos las cifras de @laura» en vez de «Vuelve a
   conectar…»), el barrido remindBrokenAccounts en oauth.refresh y el
   candado pg_advisory_xact_lock. Para cada uno: APRUEBO / NO APRUEBO
   con el motivo. Si NO, el §9 dice la vuelta atrás: déjala escrita
   como instrucción para Rasheed, no la hagas tú.
4. CIM-11 (§10): (A) runId como texto no tiene alternativa mientras
   0083 exista: aprueba o rechaza 0083 ENTERA. (B) y (C): cualquier
   orden por fecha con desempate determinista vale; comprueba que
   ORDEN_ULTIMA_CORRIDA y ORDEN_CORRIDAS_ASC dan el mismo orden que
   antes en apps/worker/test/runner.test.ts y que el corte por edad de
   queries/campanas.ts sigue dando el mismo reporte (campanas/
   reporte.test.ts). Mira además que el harness de pruebas y el --demo
   no cambian lo que un job escribe.
5. ACC-4 (§7bis filas 1, 4, 5, 6): nav.tsx (Accesos sale de las
   herramientas y entra en Producto como «Equipo»), modules.ts (name y
   group), accesos.ts y conexiones.ts (session_permission_keys() en vez
   del JOIN propio), permisos.ts (permisosQueFaltan como única regla y
   ROLE_KEYS). Comprueba que el Contador sigue sin ver Campañas (ACC-1)
   y que ACC-8 sigue preguntando lo mismo (equipo.test.ts).
6. CIM-7 (runner por turnos, ya en producción desde el 28-sep) y
   CIM-12 (helpers de prueba): aprobación a posteriori. Lee
   apps/worker/src/turno/ y runner/comun.ts; confirma que --once y el
   proceso largo no cambiaron (pruebas de once-reclamo.test.ts) y que
   el harness sigue sembrando mi demo igual.
7. Choque con mis ramas de QA: nicolas/QA-modulos-sprint (rayit-qa, con
   cambios sin commitear) y nicolas/QA-9-5-modulos (rayit-qa2) tocan
   collect-account-metrics.ts, cuentas-service.ts y
   collect-post-metrics.test.ts. Haz un merge de prueba en tu worktree
   (git merge --no-commit origin/nicolas/QA-modulos-sprint, luego
   abort) y lista los conflictos con la resolución que propones.

ENTREGA: docs/propuestas/REVISION-FASE-9.md con una tabla por historia
(archivo, qué cambia, prueba, APRUEBO / NO APRUEBO / APRUEBO CON
CAMBIO + el cambio en una frase), la lista de conflictos del paso 7
con su resolución, y al final el veredicto en una línea: «Rasheed
puede mezclar integracion en main» o «no, hasta X». Sin commits en su
rama: el archivo va en la mía (nicolas/revision-fase-9) y lo pego yo
en el PR. No despliegues nada.
```

### R1 · INTEGRACIÓN: `rasheed/integracion` → `main` → producción (0078–0084)

Worktree: `git worktree add ../rayit-r1 rasheed/integracion` (la rama ya existe; si no está en local, `git checkout -b rasheed/integracion origin/rasheed/integracion` dentro del worktree).

```
DESPLIEGUE: AUTORIZADO

<BLOQUE COMÚN>

ESTE PROMPT · R1 INTEGRACIÓN. Cierra la fase 9: CIM-1, CIM-11, CIM-12,
RES-3, ACC-4 y ACC-7 pasan de «hechas en la rama» a «hechas en main y
en producción», con 0078–0084 y los seeds 0011–0013 aplicados.
PRECONDICIÓN: Nicolás dejó docs/propuestas/REVISION-FASE-9.md (en
origin/nicolas/revision-fase-9 o en main) con el veredicto «puede
mezclar». Si no está, PARA en F0 y dímelo: no se mezcla sin él. Si
alguna fila dice NO APRUEBO, aplica la vuelta atrás que esa historia
tiene escrita (fases-rasheed.md §9 para RES-3; §10 (B)/(C) para
CIM-11; §7bis para ACC-4) antes de seguir, en un commit propio.

PASOS (F1).
1. git fetch; git merge origin/main (trae el QA de Nicolás si ya entró;
   los conflictos en apps/worker/src/jobs/conexiones/
   collect-account-metrics.ts, cuentas-service.ts y
   collect-post-metrics.test.ts se resuelven a favor de main y
   reaplicando el aviso de RES-3 encima; el merge lo explica).
2. pnpm verificar completo con conteos de todos los paquetes; pnpm
   --filter @mc/web build; make db.check (0001–0084 sobre pglite);
   make db.seed.check. Nada sigue en rojo.
3. Las notas del tablero: CIM-1, CIM-11, CIM-12, RES-3, ACC-4 y ACC-7 a
   «hecho» con fecha y una línea de qué quedó pendiente (ACC-4: «pendiente
   CIERRE-ACC §5 → R2»; ACC-7: «hallazgos de fase 9 → R2; ACC-10 → R2»;
   RES-3: nada; CIM-11: nada; CIM-12: «seed 0003 es de CIM-8»). CIM-7
   sigue en_curso. docs/backlog-mvp.md: una sección nueva «§12. Cierre
   de la fase 9 de Rasheed al <fecha>» con la forma de §11 (historias
   una por una, verificación sobre main con conteos, producción, lo que
   Rasheed necesita de Nicolás y viceversa, desvíos, lo que sigue) y el
   párrafo puntero en la cabecera y en docs/plan-equipo.md.
4. Receta de despliegue de 0083 (ventas-outreach.md §5.2 «CIM-11 va
   pegada al despliegue»): 0083 NO convive con el código viejo (la web
   vieja no arranca en frío sin las secuencias; la nueva no arranca con
   0083 pendiente). Por eso, en F5:
   a. push a <rama> y a main por avance rápido (paso 3 del protocolo);
   b. desde el worktree de despliegue en origin/main:
        ./scripts/vercel.sh deploy --prod --skip-domain   → anota <url>
      (construido con variables de producción, SIN el dominio);
   c. PARADA 1 con ESTA lista para mí, en orden, y espera:
        cd <clon principal>/platform
        make cron.uninstall        # ningún turno en medio
        make db.migrate            # 0078–0084, una transacción por archivo
        make db.guardia            # en verde
        make vercel.run ARGS="promote <url> --yes"   # el dominio pasa al build nuevo, sin build
        make cron.install          # pide CRON_SECRET
        make cron.status
      Y los seeds: make db.seed (0011 equipo, 0012 lo que importa,
      0013 agencia de demo) con el comando exacto que use el Makefile.
      Si make db.migrate falla en un archivo, ese archivo se deshace
      entero y los anteriores quedan: me dices cuál, no se promueve
      nada, y la web vieja sigue sirviendo (plan B: cron.install).
   d. Cuando te pegue CONTINUAR-DESPLIEGUE: comprueba
      run api /v13/deployments/<url> → gitCommitSha = tu commit y
      alias on-cue-web.vercel.app; make db.sql Q="select id from
      schema_migrations order by 1 desc limit 8" (0078–0084 presentes);
      /resumen con el bloque «Lo que importa esta semana» y un aviso de
      cada fuente (seed 0012); /accesos con Equipo (ACC-4) y el enlace
      de invitación que se ve pero no se acepta en la demo; la ficha de
      un negocio de la agencia del seed 0013 como Diego (DEMO_USER_ID
      NO va en Vercel: compruébalo en local contra la copia); el grep
      de ids: ninguna pantalla pinta un id numérico.

COSTURAS (F2), cada una con prueba que ya existe o que escribes:
- RES-3 ↔ Conexiones: apps/worker/test/lo-que-importa.test.ts (los
  cinco productores) y resumen/semana.test.tsx (el título de la campana
  es el de la fila).
- ACC-4 ↔ ACC-5/ACC-8: equipo.test.ts y las suites de ACC-5/8 intactas.
- CIM-11 ↔ worker/Campañas: runner.test.ts, costuras-con.test.ts,
  campanas/reporte.test.ts, ids-sin-contador.test.ts con datos.
- ACC-7 ↔ Ventas/Cotizar: alcance-esquema (TABLAS_CON_ALCANCE_POR_
  CREADOR) y la prueba que fija lo que ACC-7 todavía NO cubre (queda
  para ACC-10 en R2; no la des la vuelta aquí).

LO QUE NO ENTRA EN R1 (y adónde va): CIERRE-ACC §5 (R2), los 11
hallazgos de pendientes-fase-9.json (R2), pendientes-pulido-final.json
(R3/R4/R5), VEN-17 (R6), GitHub→Vercel (R6).

TERMINADO CUANDO: main contiene 1b7777a0 (o su merge) por avance
rápido; producción sirve ese commit; Supabase tiene 0078–0084 y los
seeds 0011–0013; make cron.status en verde después de reinstalar;
pnpm verificar en verde con los conteos; las seis historias en «hecho»
y backlog-mvp.md §12 escrito.
```

### R2 · ACC (la parte de Rasheed): permisos, puertas, alcance, ACC-7 r6 y ACC-10

Worktree: `git worktree add -b rasheed/ACC-cierre-r ../rayit-r2-acc origin/main`. Migración **0085**.

```
DESPLIEGUE: AUTORIZADO

<BLOQUE COMÚN>

ESTE PROMPT · R2 ACC. Cierra mi parte de Accesos: lo que
docs/propuestas/CIERRE-ACC.md §5 me dejó (filas 1, 2, 4, 5 y 7; la 8 ya
está en 0082), los 11 hallazgos abiertos de ACC-7
(docs/propuestas/pendientes-fase-9.json, nota 9,3) y ACC-10. Base:
origin/main con R1 dentro (si R1 no está en main, para en F0).

PASOS (F1), en este orden porque cada uno es una prueba de convención
que obliga al siguiente:
1. Permisos (§5.1). requirePermission('<módulo>.<recurso>.<acción>')
   como PRIMERA línea de las 12 Server Actions de app/(app)/ventas/
   actions.ts, las 14 de cotizar/actions.ts y la de resumen/importar/
   actions.ts, con el permiso que ya les asigna docs/propuestas/ACC-1.md
   §4 (reutiliza; un permiso nuevo exige migración y va en 0085 con su
   fila en la semilla y en permisos:sql). Añade ventas.outreach.aprobar
   y ventas.outreach.politica si ACC-1 §4 no los cubre (ventas-outreach
   §5.2 paso 8 los pide para aprobarMensaje, resolverIntento,
   saltarMensaje, reanudarCadencia, encenderEnvio y apagarEnvio).
   Retira puedeOperarVentas/puedeCambiarLaPolitica como puerta (pueden
   quedar para pintar o no un botón). Añade "ventas", "cotizar" y
   "resumen" a MODULOS_CON_CONVENCION en lib/permisos/convencion.test.ts
   y sube ACCIONES_MINIMAS.
2. Puertas (§5.2). requireModuleAccess/requirePagePermission en las 14
   páginas de la lista de §5.2 (Resumen 2, Ventas 4, Cotizar 8) y los
   tres módulos en MODULOS_CON_PUERTA_EN_PAGINA de paginas.test.ts. Las
   páginas públicas (kit, cotización, baja) NO llevan puerta: déjalo
   dicho en el test si hace falta excluirlas.
3. Alcance (§5.4). Un test/alcance-<modulo>.test.ts por módulo con el
   arnés de packages/db/test/alcance.ts (sembrarExtra) para
   queries/ventas.ts (26 exportadas), queries/ventas-ficha.ts,
   queries/cotizar/*.ts (48, incluida campana.ts) y queries/resumen.ts
   (12); sus archivos en ARCHIVOS de alcance-convencion.test.ts; lo que
   legítimamente no lleva alcance, declarado con motivo en
   SIN_ALCANCE_DECLARADAS (worker, público por enlace, catálogos).
4. ScopeError en Cotizar (§5.7): codigoDe() reconoce ScopeError; «Crear
   campaña» sobre una cotización fuera de alcance dice «no tienes
   alcance sobre esta cotización», no «la cotización no existe». Prueba
   en cotizar/actions.test.ts.
5. Seed (§5.5): una Contadora de demo (rol de fábrica finance) en
   db/seed/ (número libre), para probar ACC-5 en la copia sin llaves.
6. ACC-7 r6: los 11 hallazgos de pendientes-fase-9.json, uno a uno:
   createQuote exige input.creatorId = deal.creator_id
   (CreadorDistintoDelNegocio); member_sees_creator(user_id,
   creator_id) SECURITY DEFINER en 0085 y su uso en assertMember y
   listOwnerOptions; la ficha no se contradice cuando hiddenDeals
   (un solo estado vacío y «Negocios abiertos (tuyos)»); tieneRol
   resuelve el rol de DEMO_USER_ID; aria-label que empieza por el texto
   visible (WCAG 2.5.3) con prueba; el error DealCreatorRequired con
   texto distinto en el formulario y en el radar; una señal pendiente de
   Hostal Brisa en el seed 0013 para ver el aviso del radar;
   scope_allows(text,uuid) y (text,uuid[]) con SET search_path = public,
   extensions, pg_temp en 0085 y SQL_CUERPOS comparando también
   proconfig; DEMO_USER_ID en .env.example; NO_CREATORS una sola vez.
   Cierra con dos revisores hasta 9,5.
7. ACC-10: política RESTRICTIVE por creador para mc_app en
   post_metric_snapshot y account_metric_snapshot (por EXISTS sobre post
   y social_connection o por su creator_id), quote (creator_id), invoice
   y payment (por EXISTS sobre campaign) y data_consent; entrada en
   TABLAS_CON_ALCANCE_POR_CREADOR y fuera de
   TABLAS_CON_CREADOR_SIN_POLITICA; la prueba de ACC-7 que fija lo que
   no cubría se da la vuelta. Todo en 0085, re-ejecutable. Cuidado con
   los ON CONFLICT DO UPDATE del worker: el worker es mc_worker y queda
   fuera; compruébalo con collect-*.test.ts y campaign-compute.test.ts.
   invoice y payment son tablas de Nicolás (FIN): la política va en MI
   migración, pero el diff de sus pruebas (finanzas.test.ts) va en un
   commit «(revisión de Nicolás)».

COSTURAS (F2): convencion.test.ts y paginas.test.ts en verde con los
tres módulos; alcance-convencion con los archivos nuevos; accesos.test
(catálogo = permisos:sql); cotizar/actions.test (ScopeError);
campanas/reporte y finanzas.test con la política nueva; ACC-5 y ACC-8
intactas; el Contador de demo no ve Campañas ni Ventas pero sí
Finanzas (nav.test).

0085 ES COMPATIBLE con el código viejo (solo añade políticas, una
función y permisos): PARADA 1 normal, migrar antes del deploy.

TERMINADO CUANDO: las 27 acciones y las 14 páginas pasan las dos
pruebas de convención; 86 consultas con alcance probado o declarado;
como miembro acotado a un creador, un SELECT crudo sobre métricas,
cotizaciones, facturas, pagos y consentimientos del otro creador
devuelve nada (prueba); los 11 hallazgos cerrados o justificados;
ACC-7 y ACC-10 en «hecho», ACC-4 sin «pendiente de» en su nota;
docs/propuestas/CIERRE-ACC-R.md con la tabla de decisiones.
```

### R3 · VEN: VEN-9 en vivo, VEN-14 con llave, pulido de Ventas

Worktree: `git worktree add -b rasheed/VEN-cierre-r ../rayit-r3-ven origin/main`. Sin migración.

```
DESPLIEGUE: AUTORIZADO

<BLOQUE COMÚN>

ESTE PROMPT · R3 VEN. Cierra Ventas: VEN-9 deja de estar bloqueada
(las llaves de Google outreach y Unipile YA están en Vercel; falta la
sesión real), VEN-14 con el clasificador real, y los hallazgos del
pulido final que son de Ventas. Base: origin/main con R1 dentro.

PASOS (F1).
1. VEN-9, la sesión real (ventas-outreach.md §9.3). Es un trabajo a
   medias entre tú y yo: tú preparas y verificas, yo pongo las manos
   donde hay una cuenta real. Prepara: comprueba que
   packages/connectors/scripts/record-outreach.ts y
   outreach-grabacion.test.ts están como dice §9.3; levanta la web en
   dev en un puerto 3100–3999; dame el guion EXACTO, comando por
   comando, con lo que tengo que hacer yo en el navegador (túnel,
   buzón de pruebas, LinkedIn de pruebas, conectar en /ventas/canales,
   escribir, contestar, cerrar sesión) y espera. Cuando te diga
   «grabado», corre outreach-grabacion.test.ts: la cuenta grabada trae
   el estado entero en name (o entra el plan B, y lo dices), el aviso
   LIGÓ la cuenta (meta.appReply sin ignored), la forma de
   sender.attendee_provider_id y account_info casa con los fixtures, y
   el canje de Google es el que esperábamos. Corrige lo que la
   grabación desmienta. Si no puedo grabar hoy, VEN-9 sigue bloqueada,
   el resto del prompt se hace igual, y la nota dice qué falta.
2. VEN-9 en producción: cuando ANTHROPIC_API_KEY y las llaves estén y
   R3 esté desplegado, conecto un Gmail y un LinkedIn reales en
   /ventas/canales de producción; tú compruebas desde make db.sql
   (solo lectura, con el workspace fijado) que outreach_channel_account
   tiene las dos filas en status conectado, que el keepalive las toca
   (last_ok_at) y que una cuenta caída se ve en rojo con «Reconectar».
3. VEN-14: con ANTHROPIC_API_KEY en Vercel (la pongo yo; dime cuándo
   la necesitas), el clasificador real clasifica una respuesta de la
   demo (--demo o el job outbound.replies en un turno) y deja su fila en
   outbound_llm_call con costo; sin la llave, el job termina «no
   configurado», no failed. Prueba de los dos caminos.
4. Pulido final (pendientes-pulido-final.json), los de Ventas:
   narrativa.ts sin cifras → estado «sin datos suficientes» con
   EmptyState propio en ventas/perfil (enlaces a Conexiones y a
   /resumen/importar), no una narrativa con frases internas; «views» →
   «visualizaciones» en los guidance_es de 0067 y 0046 §303 y en el seed
   0002 (SIN tocar migraciones aplicadas: va en una migración nueva
   solo si el texto vive en la base; si vive en el seed o en core, ahí);
   «captions» → «descripciones»; «Activar y escribir a…» no muestra el
   aviso de éxito hasta que termina router.refresh() (o actualiza la
   píldora y el contador de forma optimista); UUID_RE una sola vez
   (isUuid en @mc/core, reexportado por @mc/db; connectors lo importa).
5. Las notas: VEN-9 y VEN-14 con fecha y lo que se vio en vivo.

COSTURAS (F2): outreach-grabacion.test.ts (la puerta de la sesión
real); canales.test (una cuenta en error pinta «Reconectar»);
outbound.replies con y sin llave; el perfil comercial con y sin
datos; plantillas.test sin /\bviews\b/i en ningún guidance_es.

TERMINADO CUANDO: un creador conecta su Gmail y su LinkedIn en
producción; el token de Google se refresca solo (keepalive); una
cuenta caída se ve en rojo con reconectar; una respuesta real se
clasifica con el modelo y deja su costo; VEN-9 y VEN-14 en «hecho»
con la fecha; los cinco hallazgos cerrados con prueba.
```

### R4 · RES: RES-4 (demografía y cuándo publicar) y pulido de Resumen

Worktree: `git worktree add -b rasheed/RES-cierre-r ../rayit-r4-res origin/main`. Sin migración.

```
DESPLIEGUE: AUTORIZADO

<BLOQUE COMÚN>

ESTE PROMPT · R4 RES. Cierra Resumen: RES-4 ya no está bloqueada
(CON-7 recolecta demografía real desde el 5-oct: Instagram Login con
@nicolasduartea en producción; la tabla y el job son de Nicolás, en
apps/worker/src/jobs/conexiones/collect-demographics.ts y su
propuesta docs/propuestas/CON-7.md), y los hallazgos del pulido final
que son de Resumen. Base: origin/main con R1 dentro.

PASOS (F1).
1. RES-4. Lee CON-7.md y el esquema de lo que escribe (audience_*
   o como se llame en 0039: míralo en packages/db/src/schema y en el
   seed). Dos bloques en /resumen, debajo de los KPIs y encima de las
   barras: «Quién te ve» (edad, género, país; una red a la vez, con el
   selector del filtro que ya existe) y «Cuándo publicar» (seguidores
   conectados por hora, solo Instagram, el gráfico por hora coincide
   con el fixture de CON-7). Toda la aritmética en SQL
   (queries/resumen-demografia.ts, con alcance por el arnés) y React
   solo formatea. Estados: la red no da demografía (TikTok por @, o
   cuenta sin autorizar) → una frase que dice por qué y qué hacer
   («Autorizar analítica» en Conexiones); menos de 100 seguidores (el
   mínimo de Instagram) → lo dice; sin lectura en 30 días → frescura
   como el resto de la página. La demo (seed) trae una lectura. Kit:
   BarChart y las tarjetas que ya hay; si necesitas un gráfico nuevo
   (barras horizontales), es un PR al kit con visto bueno de Nicolás,
   como axisLabels.
2. Pulido final, los de Resumen: partir asistente.tsx (1 025 líneas)
   en un reducer puro _lib/asistente-estado.ts con pruebas y un archivo
   por paso (paso-subir, paso-formato, paso-revisar, paso-hecho), sin
   cambiar comportamiento (las pruebas de RES-2 siguen igual); las
   etiquetas de «Visualizaciones por semana» a 1 280 px (las doce
   cuando caben, una sí y una no en móvil, sin hueco irregular antes
   de la última; _lib/eje.ts probado contra el BarChart real); la
   prueba de actualización: packages/db/test/actualizacion.test.ts que
   siembra pglite hasta 0033 con los seeds de ese commit (git show
   f2fed50c^:…) y aplica 0034–0085 encima con datos, como pide el
   hallazgo (Supabase pasó por ahí de verdad; que una migración futura
   no lo rompa).
3. Las notas: RES-4 a «hecho»; RES-1/RES-2 si su nota envejeció.

COSTURAS (F2): resumen/page.test.tsx (los dos bloques con y sin
demografía); el fixture de CON-7 y el gráfico por hora; alcance en
resumen-demografia (alcance-resumen.test.ts); actualizacion.test.ts.

TERMINADO CUANDO: el gráfico por hora coincide con el fixture; si la
cuenta no da demografía, la pantalla explica por qué; en producción
/resumen enseña la demografía real de la cuenta de Nicolás (lo miras
con él: no leas sus datos por make db.sql); el asistente partido con
las mismas pruebas en verde; RES-4 en «hecho».
```

### R5 · COT: pulido de Cotizar y la costura con Campañas

Worktree: `git worktree add -b rasheed/COT-cierre-r ../rayit-r5-cot origin/main`. Sin migración. Después de R2.

```
DESPLIEGUE: AUTORIZADO

<BLOQUE COMÚN>

ESTE PROMPT · R5 COT. Cotizar está en main desde la fase 2; lo que
falta es pulido y dos costuras. Base: origin/main con R1 y R2 dentro.

PASOS (F1).
1. FechaInput (cotizar/_ui/fecha.tsx) es un parche del kit: prepara el
   PR al kit en una rama aparte sobre origin/main
   (rasheed/kit-dateinput-foco) que añade a components/ui/
   date-input.tsx el anillo de foco (focus:border-ink focus:ring-2
   focus:ring-ink/15), con la prueba del kit; borra _ui/fecha.tsx y
   vuelve a importar DateInput en generar-form. Es carpeta de Nicolás:
   la rama queda para su visto bueno y R5 NO la mezcla; mientras, el
   parche se queda y la nota lo dice.
2. El estado vacío del tarifario ofrece también /resumen/importar (texto
   en cotizar/messages.ts), como SinConexiones en resumen.
3. Hidratación #418 en /kit/<slug>: los componentes cliente del media
   kit que formatean fechas o tiempos relativos reciben el valor ya
   formateado desde el servidor; prueba de render sin avisos de
   hidratación (y lo mismo en /cotizacion/<slug>).
4. Costura COT-4 ↔ CAM-2 con alcance (CIERRE-ACC §5.7, ya con
   ScopeError en codigoDe desde R2): una cotización fuera de alcance no
   crea campaña y lo dice; una dentro sí; prueba en cotizar/actions.test
   y en queries/cotizar/campana.test.
5. Costura COT ↔ ACC-7 (fase 9): createQuote con el creador del negocio
   (lo cerró R2); aquí la prueba de pantalla: en la ficha de un negocio
   de Mariana, «Cotizar» no deja elegir a otro creador.
6. Las decisiones pendientes de COT-1..4 (grep en docs/propuestas/ y en
   las notas) a la tabla de CIERRE-COT-R.md.

COSTURAS (F2): kit y cotización públicas (mc_public_share) sin puerta
y sin alcance, declaradas; media-kit.test (foto congelada del seed);
cotizar/actions.test (ScopeError); campana.test.

TERMINADO CUANDO: /kit y /cotizacion sin #418 en 10 recorridos a 400 px
en oscuro; el tarifario vacío con los dos enlaces; «Crear campaña»
dice la verdad con y sin alcance; la rama del kit lista para Nicolás;
COT-1..4 con nota al día.
```

### R6 · CIM-7 + VEN-17: despliegue continuo y turnos limpios

Worktree: `git worktree add -b rasheed/CIM-7-cierre ../rayit-r6-cim7 origin/main`. Sin migración. Lánzalo después de conectar GitHub a Vercel (§0.3 punto 1) y con R1 en `main`.

```
DESPLIEGUE: AUTORIZADO

<BLOQUE COMÚN>

ESTE PROMPT · R6 CIM-7 Y VEN-17. Cierra el despliegue continuo y la
salud de los turnos. Antes de lanzarlo conecté GitHub a Vercel
(proyecto on-cue-web ← rasheedb1/rayit, rama main, Root Directory
apps/web). Base: origin/main con R1 dentro.

PASOS (F1).
1. CIM-7, el «terminado cuando»: un merge a main aparece en la URL sin
   correr ningún comando. Comprueba con run api /v9/projects/on-cue-web
   que link ya no es null; revisa que el build de Vercel desde GitHub
   usa platform/ como raíz del monorepo y apps/web como Root Directory
   (vercel.json / Project Settings; .vercelignore ya no excluye
   apps/worker desde 5c3b9518); que las variables de production y
   preview están; que el CI de GitHub (.github/workflows/ci.yml) corre
   pnpm verificar en cada PR. Documenta en apps/web/README.md
   «Despliegue» el camino nuevo y deja make vercel.deploy como plan B
   manual (y la receta de 0083 para migraciones incompatibles).
   La prueba real: el push de este mismo prompt a main tiene que
   publicarse solo; verifícalo con run ls y gitCommitSha, sin correr
   deploy.
2. VEN-17. Lee docs/propuestas/CIM-12.md «Resultado» y los tres
   commits del 7-oct (1b7777a0, 6b459cf5, b092fdf8): outbound.replies
   fallaba por citext fuera del search_path y por USAGE de mc_worker en
   extensions; 0084 y el GRANT lo arreglan (R1 los aplicó). Falta la
   otra mitad: por qué collect.account_metrics sale exhausted en cada
   turno. Reprodúcelo con el harness de turnos
   (apps/worker/test/tick-postgres.test.ts, senal-turno.test.ts y cron-tick-sql.test.ts) contra las conexiones de la demo:
   si es el presupuesto de 45 s (demasiadas cuentas por turno), el job
   retoma en el turno siguiente sin gastar intentos (ya existe el
   mecanismo: úsalo y pruébalo); si es un error del conector (token,
   cuota, red), eso es de Nicolás (CON-2): escribe el diagnóstico exacto
   con la corrida, el error y el archivo en CIERRE-CIM-R.md y NO toques
   el conector. En cualquier caso: un job que no puede correr por falta
   de llave o de conexión termina como «no configurado» (skipped con
   motivo), nunca failed ni exhausted; make cron.status lo distingue.
3. Salud: make cron.status en verde y su veredicto documentado; la
   proyección de GB-h contra el cupo de Hobby con los números de hoy
   en el README del worker.
4. Las notas: CIM-7 a «hecho» cuando el push publique solo; VEN-17 con
   la causa, lo arreglado y la fecha desde la que se cuenta la semana
   limpia. VEN-17 pasa a «hecho» SOLO cuando yo te diga que make
   cron.status lleva siete días sin exhausted ni failed: si no ha
   pasado la semana, queda en_curso con la fecha objetivo.

COSTURAS (F2): tick-postgres.test (presupuesto que retoma); la prueba de que
toda ruta de cron exige el Bearer; cron-tick.sh status contra un
fixture de job_run con exhausted/failed/skipped.

TERMINADO CUANDO: el push a main de este prompt aparece en la URL sin
deploy manual; collect.account_metrics y outbound.replies ya no salen
exhausted ni failed en make cron.status; cada job sin llave dice «no
configurado»; CIM-7 en «hecho».
```

### R7 · Antes del primer cliente que pague: CIM-9, CIM-10 y CON-9

Worktree: `git worktree add -b rasheed/CIM-9-10-CON-9 ../rayit-r7-cliente origin/main`. Sin migración. Las tres son mitad humanas: la sesión prepara, tú ejecutas en los paneles.

```
DESPLIEGUE: AUTORIZADO

<BLOQUE COMÚN>

ESTE PROMPT · R7 ANTES DEL PRIMER CLIENTE. Tres historias que no son
(solo) código y que el tablero exige «antes del primer cliente que
pague»: CIM-9 (texto legal), CIM-10 (CAPTCHA y SMTP) y CON-9
(trámites de plataforma). Base: origin/main.

PASOS (F1).
1. CIM-9. /legal hoy dice solo lo que es cierto y que está pendiente.
   Redacta un BORRADOR de términos de servicio y política de
   privacidad para On Cue (Colombia como país por defecto, Ley 1581 de
   2012 y su decreto; responsable del tratamiento, finalidades, base
   legal, datos que leemos de las plataformas y por cuánto los
   guardamos —mira la retención real en el esquema y en CON-3/CON-7—,
   derechos del titular y el contacto de datos personales en
   SUPPORT_EMAIL), en app/legal (la página ya existe) con la fecha de versión y una
   nota visible «borrador pendiente de revisión legal» hasta que yo la
   quite. NO afirmes nada que el producto no haga. Deja en
   CIERRE-CIM-R.md la lista de lo que un abogado tiene que confirmar.
   SUPPORT_EMAIL: dime que lo ponga en Vercel; sin él la página enseña
   la frase de lib/soporte.ts.
2. CIM-10. El código está (widget en /login y captchaToken hacia
   Supabase). Prepara el guion en el orden del README («El límite del
   correo»): (a) yo creo el sitio en Cloudflare Turnstile con
   on-cue-web.vercel.app y localhost; (b) yo meto TURNSTILE_SITE_KEY
   en Vercel production y preview; (c) desplegamos y tú compruebas en
   producción que /login pinta el widget y manda el token (sin romper
   el login: Attack Protection todavía apagado); (d) yo enciendo Attack
   Protection en Supabase con la clave secreta; (e) tú compruebas que
   un POST a /auth/v1/otp sin token da 4xx y que el login con widget
   sigue entrando; (f) SMTP propio en Supabase (yo) y una prueba de
   enlace real a un buzón nuestro. Cada paso con su verificación y con
   la vuelta atrás (apagar Attack Protection) si algo deja a alguien
   fuera. Prueba automática: app/login/acciones.test.ts con y sin TURNSTILE_SITE_KEY.
3. CON-9. Escribe docs/tramites.md con los tres trámites (Accounts API
   de TikTok; App Review + Business Verification de Meta con los
   permisos exactos que CON-3/CON-7/CON-10 usan —instagram_basic,
   instagram_manage_insights, business_management, y los que lea en
   el código—; auditoría de Google para los scopes de CON-8 y del
   outreach gmail.send/gmail.modify), cada uno con: qué pide la
   plataforma, qué tenemos ya (política en /legal, URL de la app, video
   de demostración: dime qué grabar), quién lo inicia, fecha, número
   de caso y estado. Los números de caso los pongo yo; tú dejas la
   plantilla y la lista de lo que hay que preparar antes de enviar.
4. Las notas: CIM-9 y CIM-10 con lo hecho y lo que espera a una
   persona; CON-9 a en_curso con la fecha de inicio cuando yo la dé.

TERMINADO CUANDO: /legal publica el borrador con fecha y aviso;
SUPPORT_EMAIL fijado en producción; /login pinta el widget y Supabase
rechaza un enlace sin token (verificado en producción); SMTP propio
mandando; docs/tramites.md con los tres trámites iniciados, fecha y
número de caso. Lo que no dependa de mí al terminar la sesión queda
dicho con nombre.
```

### CONTINUAR-DESPLIEGUE (se pega en la misma sesión después de `make db.migrate`)

```
CONTINUAR-DESPLIEGUE. Ya apliqué la migración (y los seeds si los
pediste). Comprueba por make db.sql Q="select id from
schema_migrations order by 1 desc limit 10" que está, make db.guardia
en verde, y sigue el protocolo F5 desde el paso 3 (push por avance
rápido, despliegue o promoción según la receta de tu prompt,
verificación en producción, cron.status, notas y entrega F6). Si algo
está mal en Supabase, dímelo antes de desplegar.
```

---

## 4. Generar los archivos de texto

```bash
python3 docs/prompts/cierre-rasheed/armar.py
```

Lee este documento, toma el bloque de §2 y lo pega donde cada prompt
dice `<BLOQUE COMÚN>`, y escribe un `.txt` por prompt en
`docs/prompts/cierre-rasheed/`.
