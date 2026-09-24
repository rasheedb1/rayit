# CIERRE-E2E · Todo conectado, de punta a punta

Módulo de cierre de Nicolás (`nicolas/E2E-punta-a-punta`), 23-sep-2026
por la noche. No es una historia: comprueba que lo que cerraron FIN,
CAM, CON-A, CON-B y WRK funciona encadenado, en una base y en
producción, y deja el plan diciendo la verdad.

## 0. La foto (F0), con la forma de `cierre-modulos-nicolas-prompts.md` §0

| Qué | Estado el 23-sep por la noche |
|---|---|
| `origin/main` | `5ad18fa` al empezar el merge (cierre de CON-B); esta rama lo trae |
| Producción | `78c1e8c` (WRK, docs) en `on-cue-web.vercel.app` (API v13); CON-B desplegó después su cierre |
| Supabase | Al empezar, `0001`–`0039` (`0023` hueco), con la `0041` (CAM) en `main` sin aplicar y la `0040` (ACC-6) en la rama de ACC. **A las 00:37 UTC del 24 se aplicaron la 0040 y la 0041.** La **0042** (CON-C) entró después y espera su PARADA 1 |
| Worker | `pgboss` 0, `GRANT mc_worker TO mc_migrator` false, `mc_worker_login` no existe, **`job_run` 0 filas**: ningún job ha corrido nunca en producción (WRK.md §1) |
| Vercel production (nombres) | `APP_URL`, `DATABASE_URL`, `DEMO_WORKSPACE_ID`, `OAUTH_CONNECT`, `TIKTOK_LOGIN_CLIENT_KEY`, `TIKTOK_LOGIN_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY`. Faltan `INSTAGRAM_HOUSE_TOKEN`, `GOOGLE_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ENSEMBLEDATA_TOKEN` |
| Clon principal (`rayit/`) | En `29460e3`, con `backlog-mvp.md`, `plan-equipo.md` y `backlog.ts` modificados sin commitear: es el borrador del cierre del sprint 2 (§10), que ya está en `main` en otra forma. **Choca con `main`**; por eso el plan se actualizó aquí (§5) |

`git cherry origin/main` de las 46 ramas `origin/nicolas/*`: 40 sin nada
fuera de `main`. Las seis con commits propios:

| Rama | Commits fuera de `main` | Qué es | Quién |
|---|---|---|---|
| `CON-12-proveedor-tiktok` | 7 | Proveedor de TikTok (EnsembleData), apagado sin token | Nicolás decide si se contrata |
| `ACC-6-alcance-consultas` | 7 | Alcance por asignación (su 0035 pasa a 0040) | Sesión de cierre de ACC (en curso) |
| `CON-8-oauth-youtube` | 3 | OAuth de YouTube | Espera credenciales de Google y CON-9 |
| `docs-cierre-sprint-1` | 1 | Doc viejo del sprint 1, superado por §8 | Se puede borrar |
| `CON-B-pantalla` | 1 → 0 | Un arreglo que entró con el cierre de CON-B | — |
| `CAM-4-aporte-marca` | 1 | Una nota de propuesta superada por CIERRE-CAM | Se puede borrar |

Sesiones abiertas en otros worktrees al empezar: **CON-C**
(`rayit-cierre-con-c`, 25 commits locales) y **ACC** (`rayit-cierre-acc`,
11 commits locales y tres archivos sin commitear). **CON-C entró a
`main` mientras E2E trabajaba** (con CON-8 y CON-12, apagadas): esta
rama la trae en el merge final y la prueba corre sobre ella. ACC entró
después (con la 0040), y esta rama también la trae.

## 1. La prueba de punta a punta (F1)

`platform/apps/worker/test/punta-a-punta.test.ts`: **17 en verde, ninguna
saltada** (`node --test`, ~3 s tras abrir la base). Mientras ACC no había
entrado, el eslabón 17 se saltaba con su motivo; con el cierre de ACC en
`main` se escribió de verdad.

**Dónde y por qué ahí.** La cadena cruza la web (consultas de
`@mc/db` como `mc_app`, con RLS e identidad) y el worker (jobs reales
como `mc_worker`). La base la abre `createEmbeddedDb` de `@mc/db` —roles
y privilegios como en Supabase, seeds reales— y el worker corre sobre
**la misma** PGlite con `PgliteDatabase.wrap(pglite, 'mc_worker')` (nuevo,
en `apps/worker/src/runner/db-pglite.ts`) y `executeRun`: los mismos
handlers, redactor y `job_run` que en producción, sin pg-boss. Va en
`apps/worker/test/` porque es el único paquete que puede importar las
dos cosas sin cruzar dueños (el worker ya depende de `@mc/db`).

| # | Eslabón | Historia | Qué comprueba |
|---|---|---|---|
| 1 | Cuenta por @ | CON-10 | `addPublicAccount` como Laura; su fila en la bitácora (paso 14) |
| 2 | Posts y lecturas | CON-5 | `collect.posts` y dos `collect.post_metrics` (7 y 22 días) sobre las respuestas grabadas del canal: 3 videos, 3 lecturas cada día |
| 3 | Línea base y puntaje | CON-6 | `compute.baseline` → `compute.post_score` encadenados; un puntaje por video con su múltiplo, porque la muestra de YouTube de Laura (seed + estos tres) llega a `MIN_SAMPLE_FOR_BASELINE` |
| 4 | Cotización aceptada → campaña | COT-4 → CAM-2 | `createDeal` → `createQuote` (corte de 168 h) → `sendQuote` → `acceptQuoteAndCreateCampaign`: campaña `planned` en 7 140 000 (6 000 000 + 19 %) con las cuentas de la marca copiadas de `company.socials` |
| 5 | Posts asociados | CAM-1 | Los tres videos del recolector, en la campaña; pasa a `live` |
| 6 | Aporte de la marca | CAM-4 | 120 canjes y 2 400 000 de ingreso |
| 7 | Seguidores de la marca | CAM-3 | Tres lecturas («Actualizar ahora»): línea base y durante |
| 8 | Resultado | CAM-5 | El **job** `campaign.compute` como `mc_worker`; la ficha lee: corte 168 h, sin huecos de posts ni de seguidores, **800 seguidores ganados**, 120 canjes, 2 400 000, vistas > 0 |
| 9 | Reporte público | CAM-6 | Generar → enviar por enlace → abrirlo **sin sesión** (`withPublicShare`); la campaña pasa a `reported` |
| 10 | Factura desde la campaña | FIN-1 | Total 7 140 000 y la empresa, solos; `draft` → `sent` |
| 11 | Pago con reserva | FIN-2 | Parcial → `partial`; el resto → `paid`; una fila de `tax_reserve` por pago, igual a `mulRateHalfUp(pago, tasa)` |
| 12 | Cobro por antigüedad | FIN-3 | La factura sale de lo pendiente y entra en «pagada» |
| 13 | Flujo de caja | FIN-5/6/7 | Un gasto recurrente nuevo sube el gasto mensual exactamente 260 000; tres meses de AdSense suben otros ingresos 150 000/mes |
| 14 | Bitácora | ACC-2 | Una fila por escritura: `connection.added` 1, `campaign.created` 1, `post_linked` 3, `status_changed` 3, `report_sent` 1, `brand_input.added` 2, `invoice.created` 1, `invoice.sent` 1, `invoice.payment_recorded` 2, `expense.created` 1, `platform_payout.created` 3 |
| 15 | Roles | ACC-1/3/5 | La Contadora tiene `finanzas.flujo.ver` y `finanzas.pago.registrar` y no `campanas.campana.editar`; el Mánager edita campañas y envía reportes y no ve el flujo; ninguno ve la campaña de otro workspace (RLS) |
| 16 | Secretos | R4 | Tras la cadena entera, la API key no está en ninguna columna de texto de la base (`dumpTextColumns` como superusuario); cada job dejó su `job_run` `ok` |
| 17 | Alcance por asignación | ACC-6 | Un Mánager con alcance a la campaña de la cadena ve **solo** esa en la lista, no ve Café Alma (`getCampaign` → null) y en facturas ve solo la suya; la dueña, sin alcance, las ve todas (control) |

Lo que la prueba destapó y dejó escrito (no son fallos, son contratos):

- **Cotizar, Ventas, `recordBrandSnapshot`, `upsertResult` y el
  reporte en borrador no escriben en la bitácora.** Es la convención
  de ACC-2 (`audit-convencion.test.ts` solo recorre Finanzas, Campañas
  y Conexiones, con esas excepciones declaradas). Las escrituras de
  Rasheed quedan fuera: §4, punto 7.
- **Las cuentas de la marca solo nacen de `company.socials`**, que
  `createCompany` no recibe: las llena el enriquecimiento de Ventas.
  Una marca creada a mano no tiene seguidores en su campaña hasta que
  alguien le escriba sus redes. La prueba usa Nutrivé del seed por eso.
- **Con una sola lectura antes del corte, el resultado dice «todavía
  no llega al corte»** (vistas null, `missingInputs: posts`), no un
  cero. Es lo correcto, y por eso la prueba toma dos lecturas.

## 2. Producción (F2)

**Rutas**, con `curl` sin sesión contra `https://on-cue-web.vercel.app`
(commit `78c1e8c`): 48 rutas, **ninguna en 500**.

| Código | Rutas |
|---|---|
| 200 (31 + 6 fichas con ids del seed) | `/`, `/accesos`, `/campanas`, `/cimientos`, `/conexiones`, `/cotizar`, `/cotizar/cotizaciones`, `/cotizar/cotizaciones/nueva`, `/cotizar/media-kit`, `/cuenta`, `/finanzas`, `/finanzas/configuracion`, `/finanzas/facturas`, `/finanzas/facturas/nueva`, `/finanzas/flujo`, `/finanzas/gastos`, `/finanzas/ingresos`, `/finanzas/ingresos/importar`, `/finanzas/ingresos/nuevo`, `/legal`, `/login`, `/plan/finanzas`, `/reglas`, `/resumen`, `/resumen/importar`, `/ventas`, `/ventas/empresas`, `/ventas/empresas/nueva`, `/auth/confirm`, `/auth/comprobar`, `/campanas/<uuid>/reporte/<uuid>`; y con ids reales: `/campanas/…ca0001`, `/finanzas/facturas/…fac25001`, `/ventas/empresas/…e1`, `/cotizar/cotizaciones/…c0701` y `/vista`, `/cotizar/media-kit/…d0c001` |
| 307 | `/auth/callback` sin código, `/cotizar/cotizaciones/…c0701/editar` (aceptada: no se edita) |
| 404 (esperado) | `/cotizacion/<slug falso>`, `/reporte/<slug falso>`, `/kit/<slug falso>`, `/kit` (galería apagada en producción) y las fichas pedidas con un uuid de otro tipo |
| 405 | `/conexiones/oauth/tiktok/start` y `/resumen/importar/lote` (solo POST) |
| 400 | `/conexiones/oauth/tiktok/callback` sin `code`/`state` |

**Guardia** (`make db.guardia` desde `rayit-deploy` en `origin/main`):
al empezar, roja solo por la 0041 sin aplicar. **Tras aplicar la 0040 y
la 0041 (00:37 UTC del 24), en verde**: «40 migraciones (la última,
0041_campaign_result_escritura_web.sql), 83 tablas aisladas, nada sin
declarar». Con la **0042** en `main` y sin aplicar, la guardia vuelve a
pedirla hasta que Nicolás corra `make db.migrate` (PARADA 1 de CON-C).
Desde el clon principal da rojos falsos (compara con código
de `29460e3`).

## 3. Guion de humo único, en el orden de la cadena

Con tu sesión en https://on-cue-web.vercel.app. **✍ = escribe en la
base real.**

1. **/conexiones** → «Agregar por @», YouTube, `@NutriveOficial` ✍
   (`social_connection` + bitácora). Ves la fila «Por @», con la frase
   de que las cifras llegan cada mañana (el worker no corre: WRK) y,
   sin `GOOGLE_API_KEY`, que la lectura de YouTube no está configurada.
2. **/resumen** → «Datos hasta el…» por conexión; la nueva sin lecturas
   dice «Sin lecturas todavía», no un cero.
3. **/cotizar/cotizaciones** → abre una `sent` o `viewed` (COT-2026-005,
   -006 o -007 del seed) → «Aceptar» ✍ (quote, deal, campaña). Ves el
   aviso de campaña creada.
4. **/campanas/<la nueva>** → asocia dos posts ✍, pásala a «En curso» ✍,
   registra un aporte de la marca ✍, «Actualizar ahora» en seguidores
   (sin `INSTAGRAM_HOUSE_TOKEN` lo dice con una frase y no escribe),
   y «Recalcular» ✍ (con la 0041 aplicada, ya lo ve la dueña).
5. En la misma ficha → «Generar reporte» ✍ → «Enviar por enlace» ✍ → abre
   el enlace en una ventana privada: 200, sin sesión, con el nombre de la
   marca. Recarga: el contador de aperturas sube ✍.
6. **/finanzas/facturas/nueva** → «Desde una campaña» → la nueva ✍: nombre,
   empresa y monto solos. «Marcar enviada» ✍ → «Registrar pago» parcial ✍:
   `partial` y el apartado del 11 %.
7. **/finanzas** → la factura en «Por cobrar» con sus días; **/finanzas/flujo**
   → las ocho semanas; **/finanzas/gastos** y **/finanzas/ingresos**.
8. **/accesos** → tu rol y los permisos de cada rol de sistema.

Para deshacer lo del paso 1 a 6 (si era solo humo): desconecta la cuenta
en /conexiones, anula la factura (`void`) y cancela la campaña.

## 4. Lo que sigue sin estar conectado, y de quién depende

| # | Qué no está conectado | Qué se ve hoy | Lo desbloquea | Quién |
|---|---|---|---|---|
| 1 | **El worker no corre en producción** (`job_run` = 0): ni `oauth.refresh`, ni `collect.*`, ni `compute.*`, ni `brand.snapshot`, ni `campaign.compute`, ni `finance.reminders` | Cada pantalla dice que se actualiza cada mañana; el token de TikTok de @selvathegolden caduca | Crear `mc_worker_login` (WRK.md §1.1) y encender el workflow (§7) | **Rasheed** (token de admin) y **Nicolás** (PARADA 2) |
| 2 | **0042 sin aplicar** (la 0040 y la 0041 ya están) | La línea base puede cambiar de un día a otro si un video tiene dos lecturas de la misma edad | `make db.migrate` (PARADA 1 de CON-C) | **Nicolás** |
| 3 | **Alcance en Ventas, Cotizar y Resumen** | Campañas, Finanzas y Conexiones ya filtran por alcance (ACC-6, en `main`); esas tres pantallas no | Su parte de ACC-6 (`CIERRE-ACC.md` §5) | **Rasheed** |
| 4 | **Lecturas reales de Instagram y YouTube** | Sin cifras por @ de esas redes | `INSTAGRAM_HOUSE_TOKEN` y `GOOGLE_API_KEY` en el vault, Vercel y GitHub | **Nicolás** |
| 5 | **OAuth de YouTube** (CON-8) y **proveedor de TikTok** (CON-12) | En `main` y apagados: sin sus variables, la pantalla no los ofrece y lo dice | `GOOGLE_CLIENT_ID/SECRET` (+ verificación de Google, CON-9); decidir si se contrata EnsembleData | **Nicolás** y **Rasheed** (CON-9) |
| 6 | **Demografía en vivo** (CON-7) | La pantalla dice qué requisito falta | Una conexión autorizada con insights (CON-9) | **Rasheed** (CON-9) |
| 7 | **Bitácora de Cotizar y Ventas** | Aceptar una cotización o crear un negocio no deja fila | Extender la convención de ACC-2 a sus módulos | **Rasheed** |
| 8 | **Envío de correos** | Los recordatorios se copian de la bandeja | SMTP (CIM-10) | **Rasheed** |
| 9 | **Despliegue continuo** | Se despliega a mano desde `rayit-deploy` | CIM-7 | **Rasheed** |

## 5. El plan (F3)

- `docs/backlog-mvp.md`: sección nueva §11 «Cierre de los módulos de
  Nicolás al 23 de septiembre de 2026» y el párrafo de la cabecera.
- `docs/plan-equipo.md`: el puntero.
- `platform/apps/web/content/backlog.ts`: CON-7 (estaba «en la rama»:
  está en `main` y producción), CON-8 y CON-12 («solo local»: están en
  GitHub sin fusionar) y ACC-6 (su migración ya es 0040).

**Por qué aquí y no en el clon principal:** el clon está en `29460e3`
con esos mismos tres archivos modificados sin commitear (el borrador
del §10 que ya está en `main`). Editarlos ahí chocaría con `main`. Esos
cambios del clon principal están superados: se pueden descartar con
`git -C rayit checkout -- docs/backlog-mvp.md docs/plan-equipo.md
platform/apps/web/content/backlog.ts` **cuando tú lo decidas** (no lo
hice: es el árbol principal).

## 6. Verificación

`pnpm verificar` sobre la rama (main + la prueba + los arreglos de abajo),
24-sep, tras los merges de los cierres de CON-C y ACC: **15/15
tareas**; raíz 8, `@mc/core` 267, `@mc/connectors` 234, `@mc/db` 1037,
`@mc/worker` 167, `@mc/web` 1268 (+1 todo); 0 fallos. Typecheck y lint del worker limpios.

**Tres pruebas de `main` fallaban pasada la medianoche UTC**, por la
fecha y no por el código. Las tres fallaban igual en `origin/main` sin
esta rama (comprobado en `rayit-deploy` a las 00:17 UTC). La sesión de
CON-C arregló en paralelo las tres; en los merges quedó su versión:

| Prueba | Por qué fallaba | Arreglo |
|---|---|---|
| `packages/db/test/finanzas.test.ts` (FIN-4, bandeja) | Esperaba 41 días de mora fijos; el seed fecha la factura en UTC y la mora se cuenta, bien, en la zona del workspace: entre las 00:00 y las 05:00 UTC son 40 | Compara contra `hoy del workspace − due_on` |
| `apps/worker/test/costuras-con.test.ts` (CON-6 = seed 0002) | **No era la fecha.** `d02` tiene dos lecturas con la misma edad (720 h), una de la API y otra manual, y la vista `post_metrics_at_cut` desempataba al azar: el seed (superusuario) tomó una y el job (`mc_worker`) la otra (mediana de completion 0,085 frente a 0,09). En producción haría cambiar la línea base de un día a otro sin datos nuevos | **Migración 0042** de CON-C (la vista desempata por `captured_at` e `id`), con su PARADA 1. E2E había arreglado la prueba comparando contra la fórmula de 0002 en el momento, con un diagnóstico equivocado (lo atribuyó a la 0003 y al día); se descartó y quedó la prueba original, que con la 0042 pasa |
| `apps/web/app/(app)/campanas/ficha-db.test.tsx` (CAM-1) | Tenía escritas a mano las views y la fecha del 22-sep; el seed rellena la serie hasta ayer | Lee la última lectura de la base y exige esa cifra exacta |

`apps/worker/test/oauth-refresh.test.ts` falló una vez dentro de
`verificar` con la máquina cargada (2 de 6); sola pasa 6/6 dos veces y
en el `verificar` siguiente pasó. Queda anotado como sensible a la carga.

## 7. Producción de este módulo (F5)

Se despliegan la prueba (no cambia la web), las notas del tablero y los
arreglos de pruebas. La salida está al final de este documento.
