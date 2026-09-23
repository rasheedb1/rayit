# Backlog del MVP · dos programadores en paralelo

Escrito para: Nicolás y Rasheed, que van a construir el MVP, y quien
coordine.

Fecha: 21 de septiembre de 2026, segunda versión (la primera, del mismo
día, repartía Ventas y Cotizar a Nicolás y Campañas a Rasheed; se
cambió a pedido de Rasheed). Reemplaza el alcance de
[plan-equipo.md](plan-equipo.md), que cubría los nueve módulos. Las
reglas de trabajo de ese documento (ramas, revisión, integración,
migraciones inmutables) siguen vigentes.

**Actualizado el 22 de septiembre de 2026** con el avance del sprint 2
de Nicolás: CON-1, CAM-1 y CAM-2 están en `main`, verificadas y
desplegadas en producción; CON-3 sigue bloqueada. El detalle está en la
[sección 9](#9-estado-del-sprint-2-al-22-de-septiembre-de-2026). El
cierre del sprint 1 (las cinco historias en `main` y en producción el
21 de septiembre) queda en la
[sección 8](#8-estado-del-sprint-1-al-21-de-septiembre-de-2026).

**Dónde se ve:** https://on-cue-web.vercel.app. Es el marco real
de la aplicación (`platform/apps/web`), con una ruta por módulo que
muestra su dueño, sus historias y su estado. El estado vivo de cada
historia está en `platform/apps/web/content/backlog.ts`: cada uno cambia
el `status` de las suyas en el PR de la historia, y el despliegue de
`main` lo publica. Este documento es la narrativa; ese archivo, el
tablero.

---

## 1. Qué es el MVP y qué no

**Entra** (fase 1):

| Módulo | Qué hace | Dueño |
|---|---|---|
| **Resumen** | Todas las redes en una sola lectura: seguidores, views, alcance en no seguidores, guardados. | Rasheed |
| **Ventas / CRM** | Radar de señales, pipeline de deals, ficha de empresa con contactos, actividad y siguiente acción. | Rasheed |
| **Cotizar** | Tarifario sugerido, media kit y cotización compartible. Es la puerta entre Ventas y Campañas. | Rasheed |
| **Campañas** | La campaña, sus posts, lo que produjo, y el reporte que se envía a la marca. | Nicolás |
| **Finanzas** | Cuentas por cobrar, pagos, gastos, reserva de impuestos y flujo de caja. | Nicolás |
| **Conexiones** | Las cuentas conectadas, los conectores, el worker y la recolección de métricas. | Nicolás |

**No entra** (fase 2, ya modelado en la base, apagado en `flags.ts`):
Mis videos, Tendencias del nicho, Ideas y guiones, Laboratorio de
video, Vista agencia, predictor, envío automático de outbound, adelanto
de pagos.

**Entró después** (decidido el 22 de septiembre, sobre la primera
versión de este documento): los **roles dentro de una cuenta**, épico
ACC-1 a ACC-5 y ACC-8. Los creadores del piloto tienen mánager, y sin
roles el piloto se hace dándole al mánager la contraseña del creador —
que es justo lo que el producto dice resolver. Lo que sigue fuera es el
**alcance** (ACC-6, ACC-7) y las **agencias** (épico AGE): un workspace
de creador tiene un solo creador, así que no hay nada que acotar hasta
que existan las agencias. El diseño, y lo que se corrió para que quepa,
están en
[`propuestas/ACC-accesos-y-roles.md`](propuestas/ACC-accesos-y-roles.md)
y en §6.

La base de datos ya tiene las 88 tablas. **Al MVP le hace falta una sola
migración de esquema, `0023_access_control.sql` (ACC-3)**, y sale de esa
decisión; el resto del producto no pide ninguna. Toda migración es un
archivo nuevo, nunca una edición. Ya apareció la primera: `0014_worker_grants.sql`
(CON-2), solo `GRANT`s al rol `mc_worker`, aplicada en Supabase el 21 de
septiembre; `0015_connection_secret` (CON-3, aplicada) y
`0016_campaign_quote_unique` (CAM-2) y `0022_public_profile_access`
(CON-10) el 22. 0017 a 0021 (RLS de CIM-2 y de la integración) están
aplicadas en Supabase y viven en `rasheed/integracion`: no se reciclan.
Números reservados: `0023_access_control` (ACC-3). En
`rasheed/integracion`, pendientes de aplicar y en este orden:
`0024`–`0026` (endurecimiento de RLS), `0027`/`0028` (CIM-3), `0029`
(endurecimiento), `0030_public_share` (Cotizar, COT-2 a COT-4) y
`0031_mover_negocio` (Ventas y Cotizar: `deal_move_stage` y `brand_key`;
va la última porque reescribe `public_quote_accept_impl` de 0030). Sin
0031, el tablero de Ventas, «Enviar» en Cotizar y la aceptación pública
fallan; `make db.guardia` lo dice. El orden exacto, con el rol
`mc_public_share` creado antes, está en la nota de CIM-2 de
`platform/apps/web/content/backlog.ts`. Antes de crear cualquiera, `git fetch` y mirar el
número más alto en todas las ramas activas. Desde CIM-2 `make db.check`
(y el job «esquema» del CI) falla si dos archivos comparten número.

---

## 2. Cómo se reparte, y por qué así

El corte es **por módulo completo**, no por capa. Cada uno hace la
pantalla, las consultas y los trabajos en segundo plano de sus módulos.
En el dashboard, cada uno mira sus propias rutas y cambia el estado de
sus propias historias; el otro no las toca.

### Rasheed · lo que el creador ve y vende, y la base de todo

Módulos **Resumen**, **Ventas** y **Cotizar**. De cimientos: el
monorepo, el cliente de base con aislamiento, la autenticación, el
despliegue y el seed de ventas y métricas. Y los trámites de
plataforma, porque tiene las cuentas de empresa.

Ventas y Cotizar son una sola cadena (señal → deal → cotización) y no
dependen de ninguna API de plataforma: se pueden enseñar a un creador
real desde la semana 4. Resumen es pantalla sobre datos que trae
Nicolás, con importación por CSV mientras llegan las aprobaciones.

### Nicolás · lo que entra por las APIs y lo que sale a la marca y al banco

Módulos **Conexiones**, **Campañas** y **Finanzas**. De cimientos: el
marco de la aplicación (ya desplegado), el kit de interfaz y el seed de
finanzas y campañas.

Campañas vive de los datos de las plataformas: snapshots de los posts,
seguidores públicos de la marca, la mediana del creador. Por eso
Conexiones va con Campañas y no con Resumen: quien mide una campaña
necesita ser dueño de los conectores, del worker y de la recolección.
Si no, Campañas espera a la otra persona en cada paso.

### Por qué Conexiones va con Nicolás y no con Rasheed

Con Rasheed en Ventas, Cotizar y Resumen, si además se quedaba con
Conexiones y el worker, la carga quedaba en 73 días estimados contra 34
de Nicolás, y los dos módulos de Nicolás dependían de Rasheed para
todo. Con Conexiones en el lado de Nicolás queda en 49 contra 59, y
cada cadena tiene dentro casi todo lo que necesita.

Lo que Rasheed tiene que darle a Nicolás para eso, la primera semana:
acceso de desarrollador a las apps de TikTok y Meta, y las llaves de
esas apps en el vault (`make db.unlock` ya se las entrega).

### Si los perfiles no encajan

Se intercambian las dos columnas enteras. Lo que **no** se hace es
partir por capa (uno backend, otro frontend): cada pantalla quedaría
esperando.

---

## 3. Reglas para no pisarse

### 3.1 Un dueño por carpeta

| Ruta | Dueño | El otro… |
|---|---|---|
| `platform/db/migrations/` | Rasheed | propone la migración en el PR; Rasheed la revisa y aplica |
| `platform/db/seed/` | por archivo: `0001_catalog` Rasheed · `0002_demo_ventas_metricas` Rasheed · `0003_demo_finanzas_campanas` Nicolás | no edita el archivo del otro |
| `packages/db/src/client.ts`, `schema/` | Rasheed | pide cambios por PR |
| `packages/db/src/queries/<modulo>.ts` | el dueño del módulo | no lo toca |
| `packages/core/` | por archivo: `scoring.ts` Nicolás · `tarifas.ts` Rasheed · `flujo-caja.ts` Nicolás | — |
| `packages/connectors/` | Nicolás | — |
| `apps/worker/src/runner/` | Nicolás | — |
| `apps/worker/src/jobs/<modulo>/` | el dueño del módulo | — |
| `apps/web/app/(app)/<modulo>/` | el dueño del módulo | — |
| `apps/web/components/ui/` (kit compartido) | Nicolás | puede agregar un componente nuevo; para cambiar uno existente, PR revisado por Nicolás |
| `apps/web/content/backlog.ts` | cada uno sus historias | — |
| `apps/web/lib/auth/`, `lib/workspace/` | Rasheed | — |
| `apps/web/app/layout.tsx`, `components/shell.tsx`, `nav.tsx` | Nicolás | — |
| `.github/workflows/` | Rasheed | — |
| `package.json`, `pnpm-lock.yaml` | quien agrega la dependencia, **avisa en el daily** | — |

Regla simple: **si el archivo no está en tu columna, no lo editas; abres
un PR pequeño y lo revisa el dueño.** Un PR que cruza dos módulos se
parte en dos.

### 3.2 Un módulo, una carpeta, un archivo de consultas

```
apps/web/app/(app)/finanzas/          páginas y componentes del módulo
packages/db/src/queries/finanzas.ts   todas sus consultas, tipadas
apps/worker/src/jobs/finanzas/        sus jobs (uno por archivo)
```

Los dos primeros existen desde el día 1 aunque estén casi vacíos. Así
ningún `git merge` toca el mismo archivo desde dos ramas.

### 3.3 El contrato entre los dos es la base de datos

- Las vistas de `0010` (`deal_pipeline`, `receivables`,
  `connection_health`, `creator_post_board`, `post_metrics_latest`) son
  la API interna. Si un módulo necesita un número derivado que no está
  en una vista, se agrega una vista en una migración nueva. Nadie hace
  aritmética de métricas en React.
- Un módulo lee las tablas del otro **solo por sus vistas o por las
  consultas del dueño**. Ejemplo: al aceptar una cotización, Rasheed no
  inserta en `campaign`: llama a `createCampaignFromQuote()` de
  `queries/campanas.ts`, que escribe Nicolás (`CAM-2`).
- `workspace_id` lo pone el cliente de base de datos (`CIM-2`), nunca
  la pantalla.

### 3.4 Flujo de trabajo

- **Ramas cortas**, una por historia, con el id delante:
  `nicolas/CAM-3-seguidores-marca`, `rasheed/VEN-3-pipeline-kanban`.
  Máximo tres días abiertas.
- **PR obligatorio, el otro revisa** en menos de un día laborable. Si
  el PR toca solo tu carpeta, puedes hacer merge tras la revisión sin
  esperar cambios del otro.
- **CI verde antes de mergear**: migraciones en Postgres embebido,
  typecheck, lint, pruebas.
- **`main` siempre despliega.** Lo que está a medias va detrás de una
  bandera, no de una rama larga.
- **Integración los viernes**: `make dev` con las dos cadenas juntas y
  una demo de cinco minutos cada uno.
- **Daily de quince minutos**: qué terminé, qué sigo, qué me bloquea,
  y **qué archivo compartido voy a tocar hoy**.

---

## 4. Las dependencias entre los dos, y cómo se desbloquean

| # | Quién espera a quién | Cuándo | Cómo no bloquearse |
|---|---|---|---|
| D1 | Todo lo de Nicolás que toca la base espera el **cliente con RLS** y el **monorepo** (`CIM-1`, `CIM-2`, Rasheed). | Días 1 a 3 | Rasheed los entrega primero que nada, con un test. Nicolás arranca el kit de interfaz y el worker sin base esos tres días. **Cómo quedó:** CIM-1 y CIM-2 no llegaron en el sprint 1; Nicolás no esperó y abrió un cliente provisional en `packages/db/src/provisional/` (FIN-1) y una conexión `pg` directa en el worker (CON-2), ambos marcados `TODO(CIM-2)` para reemplazarlos cuando exista el cliente real. Ver §8.4. |
| D2 | Las pantallas de Rasheed (Resumen, Ventas, Cotizar) esperan el **kit de interfaz** (`CIM-5`, Nicolás). | Semana 1 | Rasheed hace base, auth, seeds y las consultas de Ventas en la semana 1; la pantalla la arma en la 2 con el kit ya listo. |
| D3 | Resumen y Campañas esperan **datos de las plataformas**, que esperan las aprobaciones. | Semanas 1 a 8, quizá más | Seed de métricas (`CIM-6`), importación por CSV (`RES-2`) y respuestas grabadas (`CON-1`). |
| D4 | Cotizar quiere las **views promedio** del creador (`creator_baseline`, `CON-6`, Nicolás). | Semana 5 | El tarifario acepta las views a mano con `source = 'manual'` y las reemplaza cuando exista la línea base (`COT-1`). |
| D5 | Aceptar una cotización **crea la campaña**: Rasheed (`COT-4`) llama a la función de Nicolás (`CAM-2`). | Semana 7 | `CAM-2` se entrega en el sprint 2, mucho antes de que `COT-4` la necesite. Se prueba juntos el lunes del sprint 4. |
| D6 | El job de seguimientos de Ventas (`VEN-4`) y «lo que importa esta semana» (`RES-3`) corren en el **worker** de Nicolás (`CON-2`). | Semanas 5 y 9 | El runner existe desde la semana 1; cada job vive en la carpeta de su módulo. |
| D7 | El flujo de caja (`FIN-6`) lee los **deals ganados** de Rasheed (`VEN-3`). | Semana 7 | Lee la vista `deal_pipeline`, que ya existe. |

Todo lo demás es interno a una persona.

---

## 5. El backlog

Tamaños: **S** un día o menos · **M** dos o tres días · **L** una
semana. Cada historia tiene su *terminado cuando*, que es lo que se
enseña en la demo del viernes. El detalle de cada historia, con su
estado, está en `apps/web/content/backlog.ts` y en la URL.

### CIM · Cimientos (los dos)

| Id | Historia | Dueño | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|---|
| CIM-1 | Monorepo listo: `apps/web`, `packages/db` con Drizzle, `apps/worker` con pg-boss, turbo con `dev`, `typecheck`, `lint`, `test`. | Rasheed | M | — | `make dev` levanta los tres procesos y el CI pasa. |
| CIM-2 | Cliente de base con aislamiento: cada consulta en una transacción que fija `app.workspace_id`; esquema Drizzle de las tablas del MVP. | Rasheed | M | CIM-1 | Un test con dos workspaces comprueba que ninguno ve al otro. |
| CIM-3 | Autenticación con Supabase Auth y enlace mágico; `app_user`, `membership`, workspace de creador por defecto; cambio de workspace. | Rasheed | M | CIM-2 | Se entra con un correo nuevo y aparece un workspace vacío. |
| CIM-4 | Marco de la aplicación: navegación con los módulos, fase 2 tras bandera, tema claro y oscuro. | Nicolás | M | — | Se navega entre los módulos, el tema se conserva, una bandera apagada quita el módulo. **Hecha, en `main` el 21-sep.** |
| CIM-5 | Kit de interfaz: KPIs con delta y sparkline, tabla con «Ver tabla», gráficos con tooltip, estado vacío, aviso «datos hasta el {fecha}», formularios. | Nicolás | L | CIM-4 | Una galería (`/kit`) muestra cada componente en claro y oscuro. **Hecha, en `main` el 21-sep.** |
| CIM-6 | Seed de ventas y métricas: empresas, deals por etapa, actividades; cuatro conexiones, sesenta posts, noventa días de snapshots, línea base. | Rasheed | S | CIM-2 | `make seed` deja Ventas y Resumen con los números del mock. **Hecha en rama el 22-sep, pendiente de merge** (`docs/propuestas/CIM-6.md`). |
| CIM-7 | Despliegue continuo: el repositorio de GitHub conectado al proyecto de Vercel, cada merge a `main` publica; worker en Railway o Fly. | Rasheed | S | CIM-1 | Un merge a `main` aparece solo en la URL, sin comando. |
| CIM-8 | Seed de finanzas y campañas: tres facturas (una vencida), pagos, gastos recurrentes, dos campañas con posts y snapshots de la marca. | Nicolás | S | CIM-2 | `make seed` deja Finanzas y Campañas con los números del mock. **Hecha, en `main` el 21-sep (PR #1).** |

### CON · Conexiones y datos (Nicolás, salvo los trámites)

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| CON-1 | Conectores con respuestas grabadas: TikTok Display, TikTok Accounts, Instagram Graph, YouTube. Reintentos, cuota, `api_call_log`. | L | CIM-1 | `pnpm test` pasa sin red y cada llamada deja su fila. **Hecha, en `main` el 22-sep y en producción** (§9.1). |
| CON-2 | Worker arrancado: pg-boss, `job_definition`, `job_run`; `oauth.refresh` renovando tokens. | M | CIM-1 | `make worker` toma un job y lo registra; un token por vencer se renueva solo. **Hecha, en `main` el 21-sep**; en Supabase falta un paso con el token de administración (§8.4). |
| CON-3 | OAuth de TikTok e Instagram en sandbox: token cifrado, `secret_ref`, `data_consent`. | L | CON-1, CIM-3 | Conectar una cuenta de prueba deja la fila con sus scopes y el token no aparece en claro. **Hecha en código, en `main` y desplegada el 22-sep; bloqueada solo por la prueba en vivo** (§9). |
| CON-4 | Pantalla Conexiones sobre `connection_health`: conectar, estado, horas desde la última sincronización, paso manual de Analytics en TikTok. | M | CON-3, CIM-5 | Una conexión vencida se ve en rojo con el botón de reautorizar. |
| CON-5 | Recolector: `collect.posts`, `collect.post_metrics`, `collect.account_metrics`, con `age_hours`. Append-only. | L | CON-1, CON-2 | Dos corridas producen dos filas por post y `post_metrics_daily_delta` muestra el crecimiento. |
| CON-6 | Línea base y puntaje: `compute.baseline` y `compute.post_score` con `packages/core/scoring.ts`. Con menos de ocho videos, `is_reliable = false`. | M | CON-5 | Un post con el doble de views que la mediana queda como outlier. |
| CON-7 | Demografía de audiencia (`collect.demographics`) respetando `metric_requirement`. | M | CON-5 | Con la respuesta grabada, la tabla coincide con el fixture; una cuenta personal de TikTok explica por qué no hay demografía. **Hecha en código el 23-sep (rama `nicolas/CON-7`, migración `0036`); bloqueada solo por la prueba en vivo**: ninguna fuente pública da demografía y no hay todavía una cuenta autorizada con permiso de insights (`docs/propuestas/CON-7.md` §6). |
| CON-8 | OAuth de YouTube. | M | CON-3 | Igual que CON-3 para un canal de prueba. |
| CON-10 | Cuentas por @ con datos públicos: `public_profile`, fuentes oficiales (business_discovery con token casa, YouTube con API key, TikTok solo identidad), `collect.account_metrics`, pantalla «Agregar cuenta». | L | CON-1 | Agregar un @ deja la fila con su snapshot del día y el worker la actualiza a diario. **Hecha, en `main` el 22-sep** (§9). |
| CON-12 | Proveedor de datos de TikTok por @ (Apify, EnsembleData o Phyllo) sobre `PublicProfileSource`, `access_mode = 'aggregator'`. Opción futura, de pago. | M | CON-10 | Agregar un @ de TikTok deja seguidores y vistas sin subir nada. **Pendiente; solo si el CSV se queda corto.** |
| CON-9 | Trámites: formulario de Accounts API de TikTok, App Review de Meta, auditoría de Google. **Rasheed**, día 1. | — | — | Los tres iniciados, con número de caso en `docs/tramites.md`. |

### RES · Resumen (Rasheed)

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| RES-1 | Pantalla Resumen: los cuatro KPIs, seguidores por red en 90 días, views por semana y red; filtro por red; aviso «datos hasta el {fecha}». | L | CIM-5, CIM-6 | Con el seed coincide con el mock; sin datos muestra el estado vacío, no un cero. |
| RES-2 | Importación por CSV desde TikTok Studio, Instagram Insights o YouTube Studio, con `source = 'csv_import'`. | M | CIM-5 | Un CSV real de Instagram llena los snapshots y aparece en Resumen. |
| RES-3 | «Lo que importa esta semana»: outliers, conexión con error, factura vencida, seguimiento vencido. Lee `notification`. | M | CON-6, VEN-4, FIN-4 | Las cuatro fuentes producen su fila y cada una lleva a su módulo. |
| RES-4 | Demografía y «cuándo publicar» en pantalla. | S | CON-7 | El gráfico por hora coincide con el fixture. |

### VEN · Ventas y CRM (Rasheed)

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| VEN-1 | Empresas y contactos; búsqueda por nombre; `company_link`; un contacto exige `source`. | M | CIM-2, CIM-5 | Una empresa con dos contactos aparece en la búsqueda al tercer carácter. |
| VEN-2 | Radar manual y por CSV: bandeja de `signal`, aceptar o descartar con motivo. | M | VEN-1 | Aceptar crea el deal con «Enviar pitch»; descartar no vuelve a entrar. |
| VEN-3 | Pipeline kanban y lista sobre `deal_pipeline`; arrastrar cambia etapa y escribe `deal_stage_history`; KPIs. | L | VEN-1 | Mover a «Ganado» fija `won_at`; el cierre ponderado cambia al mover. |
| VEN-4 | Siguiente acción y seguimientos; job `ventas/seguimientos.ts` crea `deal_due` y `deal_overdue`. | M | VEN-3, CON-2 | Un deal vencido aparece en la lista y en la campana. |
| VEN-5 | Ficha de empresa: contactos, línea de tiempo, «lo que sabemos», cadena deal → cotización → campaña → factura. | L | VEN-3 | Registrar una llamada la pone en la línea de tiempo. |
| VEN-6 | Pitch con afirmaciones trazables (`claims`), en borrador y al portapapeles. | M | COT-2, VEN-5 | Un pitch con una cifra sin origen no se puede marcar como listo. |
| VEN-7 | Brief de outbound: qué busca y qué no acepta; filtra el radar. | S | VEN-2 | Una señal de una categoría excluida no aparece. |
| VEN-8 | Deal perdido con motivo y conversión por etapa. | S | VEN-3 | La tasa entre etapas aparece con su número de deals. |

Outreach automático (diseño en [ventas-outreach.md](ventas-outreach.md),
a partir de CadenceV1.0):

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| VEN-9 | Canales de outreach: migración `0015`, Unipile (LinkedIn, Instagram) con hosted auth y webhook firmado, OAuth de Google, pantalla de canales, keepalive. | L | CIM-2, CIM-3 | Un creador conecta Gmail y LinkedIn; el token se refresca solo; una cuenta caída se ve en rojo. |
| VEN-10 | Motor de cadencias: pasos, enrolamiento, cola atómica en `outbound_touch`, despachador por canal, días hábiles y zona horaria, límites, reintentos, apagado, cancelación al responder. | L | VEN-9, CON-2 | Una secuencia de tres pasos corre sola contra un buzón de prueba; una respuesta cancela lo pendiente. |
| VEN-11 | Perfil comercial del creador con narrativa de afirmaciones enlazadas. | M | CON-6, COT-1 | Cada cifra de la narrativa lleva a su origen. |
| VEN-12 | Generación con afirmaciones trazables: pre-vuelo, juez con rúbrica por paso, regeneración con pistas, riesgos, revisión humana con calentamiento. | L | VEN-10, VEN-11 | Una cifra sin origen no pasa; similitud entre marcas menor de 0,65; nota, tokens y costo registrados. |
| VEN-13 | Recomendador de cadencia con guía por paso y plantillas por nicho y señal. | M | VEN-12 | Desde una señal, seis pasos con guía activados en dos clics. |
| VEN-14 | Bandeja de aprobación y bandeja unificada, con clasificación de intención de la respuesta. | L | VEN-12 | Un retenido se aprueba y sale; un «me interesa» mueve el deal. |
| VEN-15 | Entregabilidad y cumplimiento: baja pública, `List-Unsubscribe`, rebotes, calentamiento, alertas. | M | VEN-10 | El enlace de baja marca al contacto y cancela todo; un rebote marca el correo inválido. |
| VEN-16 | Actividad y métricas: cola con reintento por tipo, uso por canal, embudo por paso, vista de flujo. | M | VEN-10 | El embudo cuadra con `outbound_touch` fila a fila. |

### COT · Cotizar (Rasheed)

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| COT-1 | Tarifario sugerido: `packages/core/tarifas.ts`, views × CPM con modificadores; views manuales hasta que exista la línea base. | M | CIM-2 | Con las views del mock salen los rangos del mock, sin los modificadores de engagement y audiencia del mock, que no tienen fuente; ver `tarifas.ts`. |
| COT-2 | Media kit público con cifras congeladas, `slug`, contraseña y vencimiento opcionales. | M | COT-1, RES-1 | El enlace abre sin sesión y no cambia aunque cambien las métricas. |
| COT-3 | Cotización: desde un deal, ítems, totales, lo acordado antes de publicar, numeración. | L | COT-1, VEN-3 | Enviar pasa el deal a «Propuesta enviada»; tiene enlace público. |
| COT-4 | Aceptación: llama a `createCampaignFromQuote()` (CAM-2) y pasa el deal a «Ganado». | M | COT-3, CAM-2 | Aceptar deja una campaña en `planned` que Nicolás ve en su módulo. |

### CAM · Campañas (Nicolás)

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| CAM-1 | Lista y ficha de campaña: estado, entregables, fechas, posts asociados, código y enlace de seguimiento. Desde la ficha se crea la factura. | M | CIM-5, CIM-6 | Se asocian dos posts a una campaña y aparecen con sus views. **Hecha, en `main` el 22-sep y en producción** (§9.1). |
| CAM-2 | `createCampaignFromQuote()` en `queries/campanas.ts`: crea la campaña con `quote_id`, `agreed_metrics`, fechas y `brand_baseline_from` catorce días antes. Es el contrato con Cotizar (D5). | S | CAM-1 | Rasheed la llama desde COT-4 sin pedir cambios. **Hecha, en `main` el 22-sep**; falta aplicar la migración 0016 (§9.4). |
| CAM-3 | Seguidores de la marca: `brand.snapshot` diario del perfil público desde `brand_baseline_from`. | M | CON-1, CON-2 | La curva sale del snapshot con su línea base de dos semanas. |
| CAM-4 | Lo que aporta la marca: canjes, pedidos, ingresos, por formulario o CSV. | S | CAM-1 | Un CSV de ventas diarias aparece en la ficha. |
| CAM-5 | Resultado: `campaign.compute` llena `campaign_result`; `missing_inputs` dice qué falta. | M | CAM-3, CAM-4, CON-6 | Los seis KPIs salen de la tabla; sin datos de la marca dice «sin datos», no cero. |
| CAM-6 | Reporte a la marca: página pública con `payload` congelado, envío por enlace o PDF, `sent_at`, `viewed_at`. | L | CAM-5 | El reporte no cambia aunque lleguen snapshots nuevos. |

### FIN · Finanzas (Nicolás)

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| FIN-1 | Facturas: desde una campaña o a mano; IVA, retención, vencimiento, numeración, estados, número DIAN. | M | CIM-2, CIM-5 | Una factura desde una campaña trae nombre, empresa y monto solos. **Hecha, en `main` el 21-sep (PR #2) y en producción.** |
| FIN-2 | Pagos parciales o totales; `tax_reserve` con el porcentaje del workspace. | M | FIN-1 | Un pago parcial deja `partial`; el total pasa a `paid` y aparta el impuesto. |
| FIN-3 | Cuentas por cobrar sobre `receivables`, con los cuatro KPIs. | M | FIN-1 | La factura vencida sale en rojo con sus días. |
| FIN-4 | Recordatorios de cobro: job `finanzas/recordatorios.ts` que redacta y deja listo para copiar. | M | FIN-1, CON-2 | Una factura vencida hace 41 días tiene sus tres recordatorios. |
| FIN-5 | Gastos con recibo en S3, recurrentes, deducibles. | S | CIM-5 | Un gasto recurrente aparece proyectado. |
| FIN-6 | Flujo de caja proyectado: `packages/core/flujo-caja.ts`, ocho semanas, gráfico y tabla. | M | FIN-2, FIN-5, VEN-3 | El gráfico sale de la función con el seed; un test cubre una semana. |
| FIN-7 | Ingresos de plataformas por CSV o a mano. | S | FIN-6 | Un CSV de AdSense aparece en su mes. |
| FIN-8 | Configuración financiera del workspace: moneda, reserva, IVA, retención, datos fiscales. | S | CIM-3 | Cambiar el porcentaje afecta los pagos siguientes, no los anteriores. |

### ACC · Accesos y roles dentro de una cuenta

Una cuenta no es una persona. El creador tiene mánager, editor y
contador; la agencia, un equipo. Hoy `membership` guarda un rol que
**ningún código lee**: entrar a un workspace es tener todo el workspace.
El diseño completo, con el esquema y la matriz de roles, está en
[`propuestas/ACC-accesos-y-roles.md`](propuestas/ACC-accesos-y-roles.md).

**Los creadores del piloto tienen mánager** (confirmado el 22 de
septiembre). Eso mete ACC-1 a ACC-5 y ACC-8 **dentro del MVP**: sin
ellas, el piloto se hace dándole al mánager la cuenta del creador, que
es justo lo que el producto tiene que evitar. Lo que **no** necesita el
piloto es el alcance (ACC-6, ACC-7): un workspace de creador tiene un
solo creador, así que no hay nada que acotar. Eso sigue en el sprint 6,
con las agencias, que es donde el alcance empieza a significar algo.

| Id | Historia | Dueño | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|---|
| ACC-1 | `packages/core/permisos.ts`: catálogo de permisos `<módulo>.<recurso>.<acción>`, roles de fábrica y `can()`. Puro, sin base ni pantalla. | Nicolás | S | — | Cada Server Action nueva abre con su `requirePermission()`; una prueba comprueba que el «Mánager» no trae `finanzas.flujo.ver`. |
| ACC-2 | `withAudit()`: toda escritura de dinero, publicación o cuenta conectada deja fila en `audit_log` con actor, `before` y `after`. | Nicolás | S | CIM-2 | Crear una factura y conectar una cuenta dejan su fila; una prueba recorre las escrituras de `queries/` y falla si alguna no audita. |
| ACC-3 | Migración `0023_access_control.sql`: `permission`, `role`, `role_permission`, `membership.role → role_id`, `membership_scope`, `invitation`, `workspace_grant`, `audit_log.on_behalf_of_workspace_id`. Semilla de los roles de fábrica. | SQL y semilla Nicolás (§3.1); esquema Drizzle, revisión y aplicación Rasheed | M | ACC-1, CIM-3 | Migra en limpio y en Supabase; el seed deja los cinco roles de creador y los cinco de agencia con su matriz. |
| ACC-4 | Pantalla **Equipo**, lo del piloto: invitar por correo eligiendo uno de los roles de fábrica, aceptar por enlace con vencimiento, cambiar rol, revocar. Al invitar a un mánager, dos casillas explícitas: «también puede ver mis finanzas» y «también puede conectar mis cuentas», apagadas. Nadie otorga lo que no tiene; el último dueño no se puede quitar. | Rasheed | M | ACC-3 | Un creador invita a su mánager, entra por el enlace y ve Campañas pero no el flujo de caja. Con la casilla marcada sí lo ve. Intentar quitar al último dueño falla con mensaje. |
| ACC-5 | Permisos en el marco: `requireModule()` recibe el permiso mínimo; el menú esconde lo que no se puede abrir; una ruta sin permiso da 404, no 403. | Nicolás | S | ACC-3 | Con sesión de «Contador», `/campanas` responde 404 y no aparece en el menú. |
| ACC-6 | Alcance en las consultas: `scopeFilter()` en `packages/db` compuesto por cada `queries/<modulo>.ts`, con prueba por módulo. | los dos, por módulo | M | ACC-3 | Un miembro con alcance a un creador no ve las campañas, los deals ni los posts del otro, en ninguna función exportada. |
| ACC-7 | Endurecimiento: política RLS por `creator_id` en `social_connection`, `post`, `campaign` y `deal`. | Rasheed | M | ACC-6 | Una consulta cruda sin `scopeFilter()` tampoco devuelve filas de otro creador. |
| ACC-8 | Consentimiento delegado: quien conecta una cuenta ajena no es quien consiente. `data_consent.evidence` lleva `acted_by` y el creador recibe notificación. | Nicolás | S | CON-3, ACC-3 | El mánager conecta el TikTok del creador: el consentimiento queda a nombre del creador, con el mánager como operador, y le llega la notificación. |
| ACC-9 | Matriz de permisos editable y roles a medida: la pantalla que muestra los permisos uno por uno y deja crear un rol propio (`role` con `workspace_id`). | Rasheed | M | ACC-4 | Una agencia crea el rol «Becario» con tres permisos y se lo asigna a alguien. |

### AGE · Agencias (fase 2, tras `agency_workspace`)

La agencia **no absorbe** al creador: recibe una concesión sobre su
workspace, revocable en una fila (decisión 6). Eso deja la tenencia y
RLS exactamente como están y hace que un creador pueda tener dos
agencias, o irse de la suya sin perder su historia.

| Id | Historia | Dueño | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|---|
| AGE-1 | Concesión de acceso: la agencia solicita, el creador acepta con rol, alcance y vencimiento; revocar en un clic desde cualquiera de los dos lados. | por definir | M | ACC-4 | El creador ve «Agencia X puede ver tus campañas hasta el 30 de junio» y al revocar la agencia pierde el acceso en la siguiente petición. |
| AGE-2 | Sesión delegada: la persona de agencia entra al workspace del creador con el rol de la concesión; la interfaz avisa en qué cuenta está actuando; `audit_log` guarda `actor_kind = 'delegate'` y `on_behalf_of_workspace_id`. | por definir | M | AGE-1 | Una acción hecha por la agencia aparece en la bitácora del creador con los dos nombres. |
| AGE-3 | Panel de agencia: consolidado de los creadores concedidos (campañas activas, por cobrar, entregas de la semana) como proyección de solo lectura que escribe el worker, con `DataAsOf`. | por definir | L | AGE-2 | Treinta creadores en una tabla, con su fecha de corte; ninguna acción se ejecuta desde ahí, todas abren el workspace del creador. |
| AGE-4 | Marcas y equipo de la agencia: `company` como cartera, ejecutivos asignados a marcas y campañas usando `membership_scope`. | por definir | L | ACC-6, AGE-3 | Un ejecutivo con dos marcas asignadas no ve las campañas de las otras. |
| AGE-5 | Portal de marca por enlace firmado con vencimiento, sobre el reporte congelado de CAM-6. Sin membresía (decisión 8). | por definir | M | CAM-6 | La marca abre su reporte sin cuenta; el enlace vencido pide uno nuevo y no filtra nada. |

---

## 6. Calendario: cinco sprints de dos semanas, más el sexto de la fase 2

Con los tamaños de arriba, el backlog pide 49 días de Rasheed y 59 de
Nicolás (extremo bajo). A diez días hábiles por sprint y persona, eso
son cinco sprints. **El ciclo completo se enseña al final del cuarto**;
el quinto es lo que depende de aprobaciones, más el piloto.

| Sprint | Rasheed | Nicolás |
|---|---|---|
| **1** · semanas 1 y 2 | CIM-1, CIM-2, CIM-3 (días 1 a 3) · CIM-6, CIM-7, CON-9 · VEN-1, VEN-2 | CIM-4, CIM-5, CIM-8 · CON-2 · FIN-1 |
| **2** · semanas 3 y 4 | RES-1, RES-2 · VEN-3 | CON-1, CON-3 · CAM-1, CAM-2 |
| **3** · semanas 5 y 6 | VEN-4, VEN-5 · COT-1, COT-2 | CON-5, CON-6 · FIN-2, FIN-3, FIN-5 · **ACC-1, ACC-2** |
| **4** · semanas 7 y 8 | COT-3, COT-4 · VEN-6 · **ACC-3** (revisar y aplicar) | CAM-3, CAM-4, CAM-5, CAM-6 · FIN-6 · **ACC-3** (SQL y semilla) |
| **5** · semanas 9 y 10 | RES-3 · **ACC-4** · piloto | CON-4, CON-7, CON-8 · FIN-4, FIN-8 · **ACC-5, ACC-8** |
| **6** · fase 2, sin fecha | ACC-7, ACC-9 · AGE-1, AGE-2 · **RES-4, VEN-7, VEN-8** | ACC-6 · AGE-3 · **FIN-7** |

Carga estimada por sprint antes de los roles (extremo bajo, sobre 10
días): Rasheed 12 · 12 · 11 · 9 · 5. Nicolás 12 · 13 · 12 · 12 · 10.

**Lo que se corrió para que quepan los roles.** Que los creadores del
piloto tengan mánager mete ~7 días nuevos en un plan que ya iba al
110 %. No se absorbe solo; sale de aquí:

| Qué se corre al sprint 6 | De quién | Por qué es lo que menos duele |
|---|---|---|
| VEN-7 (brief de outbound) y VEN-8 (deal perdido con motivo) | Rasheed, 2 días | Las dos son S y ninguna es parte del ciclo que se demuestra |
| RES-4 (demografía en pantalla) | Rasheed, 1 día | Depende de CON-7, que a su vez depende de aprobaciones que pueden no llegar (§8.4) |
| FIN-7 (ingresos de plataformas por CSV) | Nicolás, 1 día | No la toca ningún creador en un piloto de dos semanas |

El punto frágil es el **sprint 4 de Nicolás**: CAM-3 a CAM-6 es el ciclo
completo que se demuestra al final del cuarto y no se puede tocar. Si
aprieta, lo que se mueve es el SQL de ACC-3 a la semana 9 —Rasheed tiene
aire en el sprint 5— y nunca ACC-4, que es lo que el piloto necesita
enseñar. Las cifras vivas de cada sprint las calcula el tablero en
`apps/web/content/backlog.ts`; esta tabla es la narrativa.

El sprint 6 no es parte del MVP y no tiene fecha: se abre cuando el
piloto confirme que hay agencias esperando. Dentro del MVP quedan ACC-1
a ACC-5 y ACC-8, repartidas en tres sprints a propósito: las
convenciones en el 3 (antes de que Campañas y Finanzas tengan sus Server
Actions escritas, que es cuando cuestan día y medio en vez de una
semana), el esquema en el 4 y la pantalla en el 5, pegada al piloto.

ACC-6 y AGE-4/AGE-5 no están repartidos: cada uno hace el alcance de sus
módulos, y el reparto de AGE depende de quién tenga aire cuando se abra.

**Demos de los viernes:**

1. Login y marco; seeds cargados; empresas y radar manual (Rasheed);
   primera factura a mano y el worker corriendo un job (Nicolás).
2. Resumen con seed y con un CSV real de Instagram; pipeline kanban
   (Rasheed). Conectar una cuenta de TikTok sandbox; ficha de campaña
   con posts del seed (Nicolás).
3. Ficha de empresa con siguiente acción; tarifario y media kit público
   (Rasheed). El recolector trayendo métricas reales de la cuenta
   conectada, línea base, pagos y cuentas por cobrar (Nicolás).
4. **El ciclo completo.** Cotización enviada y aceptada crea la campaña
   (Rasheed); la campaña mide seguidores de la marca, calcula el
   resultado y envía el reporte; flujo de caja (Nicolás). Pitch
   trazable (Rasheed).
5. Pantalla de conexiones, YouTube, recordatorios de cobro (Nicolás).
   Lo que importa esta semana (Rasheed). **Y la que pide el piloto: el
   creador invita a su mánager, el mánager entra y ve Campañas pero no
   el flujo de caja** (ACC-4, Rasheed; el marco y el 404, Nicolás).
   Producción abierta a los primeros creadores. Demografía, brief y
   conversión salen de esta demo: se corrieron al sprint 6.

---

## 7. Decisiones

1. **Dirección visual.** Resuelta el 21 de septiembre: minimalista,
   con Vercel y Notion como referencia. Es lo que está desplegado.
2. **Radar en el MVP** (bloquea VEN-2). Propuesta: señales manuales y
   carga por CSV; las fuentes automáticas son la primera historia de la
   fase 2, sobre la misma tabla `signal`.
3. **Autenticación** (bloquea CIM-3). Propuesta: Supabase Auth con
   enlace mágico; Google cuando pase la verificación.
4. **Dueño de los trámites** (CON-9). Rasheed, el lunes de la semana 1.
5. **Acceso de Nicolás a las apps de TikTok y Meta** (bloquea CON-3).
   Rasheed lo agrega como desarrollador la primera semana.

6. **La agencia no absorbe al creador** (bloquea ACC-3 y todo AGE).
   Propuesta: cada creador tiene su workspace y la agencia recibe una
   concesión revocable (`workspace_grant`), en vez de que el creador
   sea una fila dentro del workspace de la agencia. Conceder es un
   superconjunto de absorber —una agencia puede crear el workspace del
   creador y nacer con la concesión—, mientras que el camino inverso es
   una migración entre tenants. Es la decisión más cara de cambiar
   después: conviene cerrarla antes de escribir `0023`.
7. **El código pregunta por permisos, no por roles.** Propuesta:
   `requirePermission(session, 'finanzas.factura.crear')`, nunca
   `role === 'admin'`. Un rol es un nombre para un conjunto de
   permisos; agregar «Contador» debe ser una fila, no cuarenta
   archivos en dos módulos de dos dueños.
8. **La marca no tiene cuenta: tiene un enlace.** Propuesta: no
   construir sobre `membership.role = 'client'`. El patrón correcto ya
   está en COT-2 y CAM-6 —enlace firmado, con vencimiento, a contenido
   congelado—, y no deja superficie que proteger.
9. **El dinero no entra en ningún rol por defecto.** Propuesta: el rol
   «Mánager» sale de fábrica sin flujo de caja, gastos ni reserva de
   impuestos; solo el cobro de las campañas que él negoció. Activarlo
   es un clic consciente del creador, no un valor por omisión.
10. **Roles en el piloto.** Resuelta el 22 de septiembre: los creadores
    del piloto tienen mánager, así que ACC-1 a ACC-5 y ACC-8 entran al
    MVP y se corren VEN-7, VEN-8, RES-4 y FIN-7 al sprint 6 (§6). Con un
    cabo suelto de la decisión 9: si el mánager es quien hace el
    onboarding, necesita `conexiones.cuenta.conectar` desde el primer
    día. Por eso ACC-4 lo pregunta con una casilla explícita al invitar,
    en vez de meterlo en el rol.

Y una que no bloquea nada: **nombre del producto y dominio**, para el
media kit y el reporte públicos.

---

## 8. Estado del sprint 1 al 21 de septiembre de 2026

Escrito el 21 de septiembre a las 20:30, al cierre del primer día de
trabajo real. Reemplaza la versión de las 20:08 del mismo día, que
todavía tenía CIM-8 y FIN-1 en rama: en las dos horas siguientes se
mergearon los cinco PR y se desplegó producción. El sprint 1 va de la
semana 1 a la 2; esto es la foto de las historias de Nicolás, no el
cierre del sprint.

### 8.1 Historias, una por una

| Id | Historia | Estado | Cómo llegó a `main` | Terminado cuando… y cómo se comprobó |
|---|---|---|---|---|
| CIM-4 | Marco y navegación | **Hecha** | Push directo, 18:23 | Se navega entre módulos (las seis rutas responden 200 en dev y en producción); el tema se conserva (prueba de `lib/theme.ts`); una bandera apagada quita el módulo del menú y su ruta directa da 404 (`/videos`, `/laboratorio` → 404 en dev, pruebas de nav y banderas). Las banderas viven en `content/flags.ts` hasta CIM-2. |
| CIM-5 | Kit de interfaz | **Hecha** | Push directo, 18:26 a 20:03 | Trece componentes en `components/ui/` con pruebas (`Button`, `Pill`, formulario, `EmptyState`, `DataAsOf`, `Kpi`/`KpiRow`, `DataTable`, `LineChart`, `BarChart`, `ChartCard`, `Segmented`) y `lib/format.ts`. La galería `/kit` responde 200 en dev con `KIT=1` y, como se diseñó, 404 en producción con la bandera apagada. |
| CIM-8 | Seed de finanzas y campañas | **Hecha** | PR #1, mergeado por Rasheed | `db/seed/verify/run-0003.mjs` corrido hoy sobre `main`: migra en Postgres embebido como rol sin `BYPASSRLS`, carga los tres seeds dos veces y compara. Salen las cifras del mock: Café Alma 712 K views y 3,1 M; Fresko 265 K y 5,2 M; Nutrivé 4,7 M; Hogar Lindo 1,1 M; 17 facturas sin totales mal ni números repetidos. En Supabase el seed ya está cargado: producción muestra `FV-2026-001` a `FV-2026-009`. |
| CON-2 | Worker y `oauth.refresh` | **Hecha** | Push directo, 19:35 | Pruebas sobre pglite corridas hoy: worker 16/16 (toma un job, lo registra en `job_run` con duración, reintenta, respeta `timeout_s`) y conectores 17/17 (un token por vencer se renueva y el secreto nunca sale en los logs). Migración `0014_worker_grants.sql` aplicada en Supabase. Contra Supabase el worker todavía no corre: falta el paso administrativo de §8.4. |
| FIN-1 | Facturas | **Hecha** | PR #2, mergeado por Rasheed | Prueba de `packages/db` «desde una campaña del seed (Café Alma) trae empresa, campaña y monto sin escribirlos» en verde; en dev, la factura desde la campaña sale como `FV-2026-012` con `COP 3.100.000`. Lista con KPIs, «Nueva factura» con total en vivo y Server Action con zod, detalle con «Marcar enviada» y «Anular», `facturarCampana()` para CAM-1. En producción, `/finanzas` y `/finanzas/facturas/nueva` responden 200 con los datos de Supabase. |

Historias de Rasheed en el sprint 1, según `backlog.ts` en `main`:
CIM-1 y CIM-7 en curso; CIM-2, CIM-3, CIM-6, CON-9, VEN-1 y VEN-2
pendientes. `docs/tramites.md` (CON-9) no existe todavía.

**Sobre la demo 1 del viernes.** La parte de Nicolás («primera factura
a mano y el worker corriendo un job») ya se enseña desde producción y
desde `make worker` en local. La de Rasheed («login y marco; seeds
cargados; empresas y radar manual») depende de CIM-1, CIM-2, CIM-3 y
CIM-6.

### 8.2 Doble verificación sobre `main`

Corrida el 21 de septiembre a las 20:15 sobre `712e3bd`, el `main` de
ese momento, en un clon limpio con `pnpm install --frozen-lockfile`.
Todo en verde:

| Qué | Resultado |
|---|---|
| `typecheck` | 5 paquetes (`core`, `connectors`, `db`, `worker`, `web`) sin errores |
| `lint` | `worker` y `web` sin avisos |
| Pruebas | `core` 23 · `connectors` 17 · `db` 14 · `worker` 16 · `web` 77 en 14 archivos. **147 pruebas, 0 fallos** |
| `next build` de la web | 13 páginas estáticas; `/finanzas`, `/finanzas/facturas/[id]` y `/finanzas/facturas/nueva` dinámicas |
| Seed | `node db/seed/verify/run-0003.mjs` en verde |
| Dev con `KIT=1` | `/`, `/kit`, `/finanzas`, `/finanzas/facturas/nueva`, el detalle de una factura del seed, `/campanas` y `/conexiones` → 200. `/videos` y `/laboratorio` → 404. Sin errores en el log. |

Lo que **no** se verificó: `make seed` contra Supabase (solo el embebido;
producción demuestra que el seed está cargado) y el worker contra
Supabase (bloqueado por §8.4, fila 1).

### 8.3 Producción

https://on-cue-web.vercel.app sirve `main` con FIN-1 dentro.
Hoy hubo cinco despliegues a producción y uno fallido hasta dejarlo
funcionando, y de ahí salieron tres PR de despliegue mergeados el mismo
día:

- El proyecto de Vercel pasó a **Root Directory `apps/web`** y se
  despliega **desde `platform/`**, para que pnpm vea el lockfile y los
  paquetes del monorepo. `platform/.vercelignore` deja fuera el vault,
  las migraciones, los scripts, el worker y las pruebas.
- **PR #4**: `.vercelignore` excluía `db/` a secas, lo que también
  escondía `packages/db` y `db/certs`.
- **PR #5**: la CA raíz de Supabase va embebida en `@mc/db`, no como
  archivo, porque el bundle de Vercel no la llevaba.
- `DATABASE_URL` está configurada en el proyecto de Vercel para
  Production y Preview. Sin ella, `/finanzas` falla a propósito en
  producción (no hay modo demo allí).

Cómo se despliega mientras CIM-7 no conecte GitHub con Vercel:
`scripts/vercel.sh deploy` todavía pasa `--cwd apps/web`, que ya no
sirve con el Root Directory nuevo. Se usa el comando de la propuesta
de `docs/propuestas/CIM-4.md`:

```bash
cd platform
./scripts/vercel.sh run deploy --cwd "$PWD" --yes           # vista previa
./scripts/vercel.sh run deploy --cwd "$PWD" --yes --prod    # producción
```

Un detalle pendiente de publicar: la nota de CIM-5 en `backlog.ts`
decía «doce componentes»; este mismo PR la corrige a trece y sale con
el siguiente despliegue.

### 8.4 Lo que Nicolás necesita de Rasheed (consolidado)

Todo esto está escrito con detalle en `docs/propuestas/`. Aquí, la
lista corta, en orden de urgencia:

| # | Qué | Para qué historia | Dónde está el detalle |
|---|---|---|---|
| 1 | Con el token de administración de Supabase, dos comandos: `CREATE SCHEMA pgboss` y `GRANT mc_worker TO mc_migrator`; luego `pnpm --filter @mc/worker install-schema`. | CON-2 en producción; sin esto el worker solo corre en pglite | `docs/propuestas/CON-2.md` §3.1 y §3.3 |
| 2 | CIM-2: `packages/db/src/client.ts` con `withWorkspace` (o equivalente) y el esquema Drizzle de `invoice`, `campaign`, `company`, `workspace`. **Entregado** (rama `rasheed/CIM-2-cliente-db-r3`, con `main` integrado): `provisional/`, `lib/db/workspace.ts` y `test/helpers/base.ts` ya no existen; la web abre la base por `apps/web/lib/db` (`withWorkspace`) y el workspace sale solo de `lib/workspace/current.ts`; `queries/campanas.ts` y `queries/conexiones.ts` de CAM-2 y CON-3 se conservaron y solo cambió su importación (`isUuid`/`UUID_RE` ahora salen de `client.ts`). Las consultas se importan por `@mc/db/queries/<módulo>`; la raíz sigue reexportando las de Finanzas, Conexiones y Campañas para no tocar sus pantallas. Contrato en `packages/db/README.md`. Queda para Nicolás (CON-2b): migrar `apps/worker/src/runner/db.ts` a `createPgDb`/`tlsFor` de `@mc/db` y reemplazar la copia del bucle de migraciones de `connectors/test/helpers/pglite.ts` y `worker/src/runner/db-pglite.ts` por `@mc/db/test/pglite` o `db/lib/aplicar.mjs`. | FIN-1, CON-2, CAM-1 | `docs/propuestas/FIN-1.md` §1, §2 y §6 |
| 2b | **Prioridad 1 de esta lista, junto con la fila 1.** Con la integración de CIM-2 el integrador aplica `make db.migrate` (0017 y 0018; nacieron como 0015 y 0016 y se renumeraron al integrar CON-3 y CAM-2) y comprueba `select relname, relrowsecurity from pg_class where relname in ('outbound_policy','quote_item','rate_card_item','deal_stage_history','campaign_post')` = `true` en todas. Hasta entonces la base real tiene el hueco que la rama cierra (verificado el 22-sep como `mc_app` sin workspace: `campaign_post` devuelve filas y esas cuatro tablas tienen `relrowsecurity = false`): **no cargar datos de clientes reales antes de aplicarlas.** Desde 0017 `outbound_policy` tiene RLS: toda lectura suya fuera de `withWorkspace` devuelve cero filas sin aviso (ia-outreach, ui-cadencias). Desde 0018 las tablas hijas sin `workspace_id` (`quote_item`, `rate_card_item`, `deal_stage_history`, `campaign_post`, hijas de `video_analysis`, `script`, `idea`) heredan la RLS del padre. Las hijas con FK opcional (`brand_account_snapshot`, `trait_lift`, `external_post`, `api_call_log`, `api_quota_usage`) siguen sin RLS: su dueño decide la política. | Ventas, Cotizar, Campañas, CON | `packages/db/test/schema.test.ts` |
| 2c | Ventas (VEN-1): `contact` y `app_user` son tablas globales con PII (correo, teléfono, LinkedIn, `opted_out`) y hoy cualquier workspace las enumera. Propuesta de migración para el dueño de Ventas: `ALTER TABLE contact ENABLE/FORCE ROW LEVEL SECURITY; CREATE POLICY contact_visibility ON contact USING (source IN ('public_website','public_profile','press') OR EXISTS (SELECT 1 FROM company_link l WHERE l.company_id = contact.company_id AND l.workspace_id = current_workspace_id()))`, con una prueba en `rls.test.ts` (un contacto `user_provided` de A que B no ve). Mientras tanto `contact` y `company` se leen SIEMPRE dentro de `withWorkspace` a través de `company_link`; `test.todo` visible en `schema.test.ts`. | Ventas | `packages/db/README.md` §3 |
| 3 | CIM-3: `lib/workspace/` con el workspace de la sesión. Hoy el workspace sale de `DEMO_WORKSPACE_ID`; sin la variable, la web usa el del seed y lo avisa en el log (también en producción, para no romper `/finanzas`). | FIN-1 y todas las pantallas | `docs/propuestas/FIN-1.md` §6 |
| 4 | Seed `0002` usando los ids fijos de la sección 0 de `0003` (workspace, creadora, conexiones, empresas, posts), o avisar para cambiarlos. `0002` debe abrir con `set_config('app.workspace_id', …)` porque RLS está en `FORCE`. | CIM-6, CIM-8 | `docs/propuestas/CIM-8.md` §1 |
| 5 | CIM-7: conectar GitHub con el proyecto de Vercel (Root Directory y `DATABASE_URL` ya están) y CI en Node 22 corriendo `test` además de migraciones. Con eso `scripts/vercel.sh deploy` deja de hacer falta; si se conserva, aplicar la propuesta de `--cwd "$RAIZ"`. | Despliegue de todo | `docs/propuestas/CIM-4.md`, `CON-2.md` §3.5 |
| 6 | Migración futura con tres filas en `feature_flag`: `content_metrics`, `niche_radar`, `ideas_scripts`. | CIM-4 (banderas a la base) | `docs/propuestas/CIM-4.md` §1 |
| 7 | Arreglo responsive de la tarjeta «Por persona» en `app/(app)/page.tsx` a 390 px. No urge. | Marco | `docs/propuestas/CIM-4.md` §2 |
| 8 | Acceso de desarrollador a las apps de TikTok y Meta (decisión 5). Bloquea CON-3 en el sprint 2. | CON-3 | §7 de este documento |

### 8.5 Desvíos respecto al plan, y por qué

- **La primera migración nueva ya existe** (`0014_worker_grants.sql`).
  El plan decía que el MVP no necesitaba ninguna; esta no cambia el
  esquema, solo concede privilegios a `mc_worker`, que desde 0010
  existía sin poder leer nada. Entró en `db/migrations/` (carpeta de
  Rasheed) por indicación expresa de Nicolás para no frenar CON-2.
- **D1 se resolvió al revés.** CIM-1 y CIM-2 no llegaron los días 1 a 3
  y Nicolás no esperó: FIN-1 usa un cliente provisional con la misma
  forma que tendrá `withWorkspace`, y el worker se conecta con `pg`
  directo. Los dos llevan `TODO(CIM-2)` y su reemplazo es mecánico.
  **Cómo quedó (22-sep):** el provisional de FIN-1 desapareció con
  CIM-2; el del worker (`apps/worker/src/runner/db.ts`, con su pool y
  su `tlsFor` propios) sigue y lo migra Nicolás a `createPgDb`/`tlsFor`
  de `@mc/db` en CON-2b. El bucle «aplicar `*.sql` en orden» vive una
  sola vez en `db/lib/aplicar.mjs` (lo usan `migrate.mjs`, el embebido
  de `@mc/db` e `introspect`) y desde CIM-2 se niega si dos archivos
  comparten número; las copias de `connectors/test/helpers/pglite.ts` y
  `worker/src/runner/db-pglite.ts` pueden importarlo o usar
  `@mc/db/test/pglite` en su siguiente cambio.
- **CIM-1 sigue bloqueada por dos permisos de administración.** El
  worker contra Supabase necesita `GRANT mc_worker TO mc_migrator` y el
  esquema `pgboss` (`docs/propuestas/CON-2.md` §3.1), que solo el token
  de administración puede dar. Mientras tanto `make dev` no se cae:
  `apps/worker/src/dev.ts` comprueba las dos cosas, imprime los
  comandos exactos y lista `job_definition`; `make arranque` avisa igual.
- **Kit duplicado, ya resuelto.** FIN-1 se construyó en paralelo a
  CIM-5 con la API del borrador (`docs/propuestas/CIM-5-kit.md`) y trajo
  su propio kit mínimo. Al integrar `main` en FIN-1 se tomó el kit de
  CIM-5 como canónico y las pantallas siguieron compilando porque la API
  era la misma. La rama local `nicolas/integracion-sprint-1` y su
  worktree `rayit-integracion` quedaron obsoletos; se pueden borrar.
  Regla para el sprint 2: una historia que necesita el kit parte de
  `main` con el kit dentro, no de un borrador.
- **Tres PR de despliegue el mismo día** (#3 con el `.vercelignore`
  inicial, #4 y #5). Causa: el deploy de `apps/web` sola dejó de valer en
  cuanto la web importó `@mc/core` y `@mc/db`. Está estable, pero es
  frágil hasta que CIM-7 lo pase a configuración.
- **Cifras del mock que no cuadran con la aritmética.** La factura de
  Nutrivé quedó en 4,7 M y no 4,5 M porque 4,5 M no se descompone en
  subtotal más IVA 19 % con dos decimales exactos. Decidido y documentado
  en `docs/propuestas/CIM-8.md` §3.
- **`make db.check` no corre los seeds** y cada corrida de pglite es una
  base nueva. Por eso el seed 0003 trae su propio `run-0003.mjs`. Vale
  para 0002 también.
- **Sesiones en paralelo sobre el mismo clon.** Las cinco historias se
  construyeron a la vez, cada una en su worktree. Funcionó, con una
  regla: el árbol principal se queda en `main` y nadie hace `checkout`
  ahí.

### 8.6 Lo que sigue (sprint 2 de Nicolás)

Sin cambios de alcance: CON-1 (conectores con respuestas grabadas),
CON-3 (OAuth de TikTok e Instagram en sandbox), CAM-1 (lista y ficha de
campaña; el botón «Facturar» ya tiene detrás `facturarCampana()`) y
CAM-2 (`createCampaignFromQuote()`, el contrato con Cotizar). CON-3
depende de CIM-3 y del acceso a las apps (§8.4, fila 8); si no llegan
en la semana 3, se adelantan CAM-1 y CAM-2 y CON-3 corre contra fakes.

---

## 9. Estado del sprint 2 al 22 de septiembre de 2026

Escrito el 22 de septiembre, al cierre del segundo día de trabajo real.
El sprint 2 va de la semana 3 a la 4; esto es la foto de las historias
de Nicolás, no el cierre del sprint. Lo previsto en §8.6 se cumplió tal
cual: se adelantaron CAM-1 y CAM-2. CON-3 sí se construyó (contra
respuestas grabadas) y solo le falta la prueba en vivo con las apps.

### 9.1 Historias, una por una

| Id | Historia | Estado | Cómo llegó a `main` | Terminado cuando… y cómo se comprobó |
|---|---|---|---|---|
| CON-1 | Conectores con respuestas grabadas | **Hecha** | Push directo, once commits (`0b837df` a `f57177b`) | `packages/connectors`: núcleo HTTP con `fetch` y reloj inyectables, `PlatformApiError` (transitorio, definitivo, auth, cuota), reintentos con `Retry-After`, `QuotaManager` con ventanas y presupuesto diario en `api_quota_usage`, y clientes de TikTok Display, TikTok Accounts, Instagram y YouTube con 62 fixtures de la documentación. 137 pruebas sin red, incluida la matriz de transporte sobre los veinte métodos; el worker expone `ctx.connectors` y `ctx.callLog` (25 pruebas). Pendiente de CON-9: `video_view_retention` y `engagement_likes` sin confirmar contra el portal. Propuesta en `docs/propuestas/CON-1.md`. |
| CAM-1 | Lista y ficha de campaña | **Hecha** | Rama `nicolas/CAM-1-ficha-campana` (PR #8) y avance rápido a `main` por indicación de Nicolás | «Se asocian dos posts a una campaña y aparecen con sus views actuales»: prueba de `packages/db` en Postgres embebido con el seed (asociar a Fresko el video de Nutrivé y quitarlo; Café Alma 412 K + 300 K) y, en dev, las Server Actions ejercitadas por HTTP sobre la ficha (quitar, sugerir, asociar, transicionar, editar). En producción, `/campanas` y las cuatro fichas responden 200 con las cifras del mock desde Supabase; Lighthouse 98 / 100 / 100. Propuesta y QA en `docs/propuestas/CAM-1.md`. |
| CAM-2 | Crear campaña desde la cotización | **Hecha** | Mismo avance rápido | `createCampaignFromQuote(tx, { quoteId, startsOn, endsOn, name?, trackingCode? })` en `@mc/db`: nueve pruebas, incluido el flujo de COT-4 de punta a punta con rollback y dos aceptaciones concurrentes. Contrato para Rasheed en `docs/propuestas/CAM-2.md` (firma, ejemplo, errores, garantías, guion del lunes del sprint 4). La migración `0016_campaign_quote_unique.sql` (nació como 0015; renumerada al integrar CON-3, ver §9.5) pasa en Postgres embebido y **está pendiente de aplicar en Supabase**. |
| CON-3 | OAuth de TikTok e Instagram en sandbox | **Hecha en código; pospuesta a una versión avanzada** (bandera `oauth_connect`) | Rama `nicolas/CON-3-oauth-sandbox` (desde la rama de CON-1, con `main` integrado) y avance rápido a `main` por indicación de Nicolás | Migración `0015_connection_secret.sql` (**aplicada** en Supabase el 21-sep), cifrado AES-256-GCM con HKDF y rotación, `EncryptedSecretStore`, OAuth de TikTok Login Kit e Instagram Login (Accounts API detrás de `TIKTOK_BUSINESS_APP_ID`), rutas `start`/`callback` con cookie sellada de 10 minutos, `data_consent` con evidencia, pantalla mínima de `/conexiones` y `oauth.refresh` con los refreshers reales. La prueba clave vuelca todas las columnas de texto de todas las tablas por `pg_catalog` y no encuentra ningún token. `/security-review` sin hallazgos; diez de `/code-review` resueltos. En producción `TOKEN_ENCRYPTION_KEY` y `APP_URL` ya están; los botones responden con la variable que falta. Falta solo la prueba con una cuenta sandbox (`docs/propuestas/CON-3.md` §5), que depende del acceso a las apps. |

**Cambio de producto del 22-sep (noche): sin OAuth por creador en el MVP.** Las cuentas se agregan por @ y se leen con fuentes oficiales (CON-10, hecha, en `main`): Instagram con el token de la cuenta casa, YouTube con API key, TikTok solo identidad por @. **Decidido el 23-sep:** las cifras de TikTok las desbloquea el dueño con «Autorizar cifras» (el OAuth de CON-3, gratis y oficial; la fila por @ se convierte en autorizada conservando su historial). Se enciende con `OAUTH_CONNECT=1` y la app de TikTok en sandbox; para cualquier creador hace falta App Review de Login Kit. El proveedor de pago (CON-12) sigue como opción futura; CON-4 y CON-8 se posponen. Detalle en `docs/propuestas/CON-10.md`.

### 9.2 Verificación sobre `main`

Corrida el 22 de septiembre (noche) sobre el merge de CON-3 con `main`
(CAM-1, CAM-2 y CON-1 ya dentro). Todo en verde:

| Qué | Resultado |
|---|---|
| `pnpm turbo run typecheck lint test --concurrency=1` | 13 tareas, 0 fallos (en paralelo, la prueba de timeout de CON-2 puede fallar por carga: pasa siempre en serie) |
| Pruebas | `core` 36 · `connectors` 176 · `db` 42 · `worker` 29 · `web` 114 en 21 archivos. **397 pruebas, 0 fallos** |
| `next build` de la web | 18 rutas; `/campanas`, `/campanas/[id]`, `/conexiones` y las dos de OAuth dinámicas junto a las de Finanzas |
| Migraciones y seeds | `node db/migrate.mjs --pglite --seed` con 16 migraciones (0015 `connection_secret` y 0016 `campaign_quote_unique`) y `run-0003.mjs` en verde con el seed alineado |
| Revisión | `/code-review` en nivel alto sobre CAM-1 (10 hallazgos, 9 resueltos, 1 justificado) y sobre CAM-2 (10 de 10 resueltos); CON-1 con su propia pasada de revisión y QA |

### 9.3 Producción

https://on-cue-web.vercel.app sirve `main` (`fa4a499`, y `fc447f0`
solo con documentación) desde el 22 de septiembre, desplegado desde el
worktree `rayit-cam2/platform` con `make vercel.deploy PROD=1`, ya con
`make vercel.link NOMBRE=on-cue-web` y el directorio `.` guardado en el
vault (el comando manual de §8.3 ya no hace falta). El QA sobre
producción está en `docs/propuestas/CAM-1.md` §6: rutas y 404,
contenido, Lighthouse 98 / 100 / 100 (SEO 60 por el `noindex`
intencional), axe sin violaciones propias del módulo, y privilegios de
`mc_app` y políticas RLS comprobados por SQL de solo lectura. Las
escrituras no se ejercitaron contra datos reales.

Cuatro hallazgos, ninguno bloqueante: los snapshots del seed 0003 tienen
`captured_at` en el futuro («datos hasta el 6 oct»); Vercel avisa que
`DATABASE_URL` no está declarada en `turbo.json`; «Creada» muestra la
fecha de carga del seed; y la migración 0016 sigue sin aplicar.

**Incidente del 22-sep (noche).** El primer deploy de CON-3 salió de su
rama, no de `main`, y reemplazó producción por una versión sin CAM-1 ni
CAM-2 durante un rato (`/campanas` volvió a mostrar el plan). Se corrigió
integrando `main` en CON-3 y volviendo a desplegar desde `main`. Regla
reforzada: **producción solo se despliega desde `main`**.

### 9.4 Lo que Nicolás necesita de Rasheed (lo nuevo respecto a §8.4)

| # | Qué | Para qué historia | Dónde está el detalle |
|---|---|---|---|
| 9 | Revisar la migración `0016_campaign_quote_unique.sql` (índice único parcial sobre `campaign (quote_id)` salvo canceladas; antes 0015). La aplica Nicolás con `make db.migrate`. | CAM-2 / COT-4 | `docs/propuestas/CAM-2.md` §0.2.3 |
| 10 | COT-4: pedir `startsOn` y `endsOn` al aceptar y llamar a `createCampaignFromQuote()` después del `UPDATE` de `quote.status`, en la misma transacción. | COT-4 (sprint 4) | `docs/propuestas/CAM-2.md` §2 |
| 11 | CIM-6: `company.socials` como `{ "<red>": "<handle>" }` y `campaign.brand_accounts` como `[{ platform_id, handle }]`; los ids fijos de la sección 0 del seed 0003. | CAM-1, CAM-3 | `docs/propuestas/CAM-1.md` §1.3 |
| 12 | `turbo.json`: `"build": { "env": ["DATABASE_URL"] }` para que el aviso de Vercel desaparezca y la caché de Turbo la tenga en cuenta. | Despliegue | `docs/propuestas/CAM-1.md` §6 |
| 13 | CON-1: el `UPDATE` de `platform.limits` en `db/seed/0001_catalog.sql`, los números de caso de CON-9 (TikTok Accounts, Meta App Review, cuota de YouTube Analytics) y `pnpm --filter @mc/connectors lint test` en el CI. | CON-1, CON-9 | `docs/propuestas/CON-1.md` §1 y §3 |
| 14 | Opcional: política RLS para `campaign_post` vía `EXISTS (SELECT 1 FROM campaign …)`. Las consultas ya se protegen solas. | Campañas | `docs/propuestas/CAM-1.md` §4 |
| 15 | Acceso de desarrollador a la app de TikTok (Login Kit con sandbox) y a la de Meta (Instagram Login), o sus credenciales al vault con los nombres de `.env.example`; registrar las redirect URIs `/conexiones/oauth/<proveedor>/callback` y los scopes; corregir `.env.example`, que trae `/api/oauth/…`. | CON-3 | `docs/propuestas/CON-3.md` §2 y §3 |
| 16 | Revisar la migración `0015_connection_secret.sql` (ya aplicada por Nicolás para poder desplegar). | CON-3 | `docs/propuestas/CON-3.md` §1 |
| 17 | Revisar `0022_public_profile_access.sql` (aplicada por Nicolás) y subir al repositorio las migraciones 0017–0021 que están aplicadas en Supabase pero no en ninguna rama. | CON-10 | `docs/propuestas/CON-10.md` §2 |
| 18 | `.env.example`: `INSTAGRAM_HOUSE_TOKEN` y `GOOGLE_API_KEY`. | CON-10 | `docs/propuestas/CON-10.md` §4 |

### 9.5 Desvíos respecto al plan, y por qué

- **Avance rápido a `main` sin PR revisado.** CAM-1 y CAM-2 entraron
  por `git push origin …:main` por indicación expresa de Nicolás para
  desplegar producción el mismo día; el PR #8 queda como registro y
  CON-1 entró por push directo, como las historias del sprint 1. La
  regla de §3.4 (PR y revisión del otro) sigue vigente para cuando
  Rasheed esté activo en el repositorio.
- **Dos migraciones nuevas que nacieron con el mismo número.** CAM-2 y
  CON-3 se construyeron en paralelo y las dos crearon una `0015`. Como
  `0015_connection_secret.sql` ya estaba aplicada en Supabase (es
  inmutable), la de CAM-2 pasó a `0016_campaign_quote_unique.sql` al
  integrar. Regla nueva: antes de crear una migración, `git fetch` y
  mirar el número más alto en **todas** las ramas activas. La de CAM-2
  salió de su revisión: la idempotencia «una campaña por cotización» solo
  era cierta para quien pasara por la función; ahora la garantiza la base.
  La de CON-3 guarda el token cifrado porque ningún rol nuestro tiene
  acceso a Supabase Vault (comprobado) y el `SecretStore` exige una
  referencia estable.
- **CON-3 arrancó desde la rama de CON-1**, no desde `main`, porque
  necesitaba su cliente HTTP y CON-1 aún no se había mezclado (la regla
  de §8.4: quien necesita una pieza parte de su rama). Al integrarla,
  `lib/db` de CAM-1 reemplazó las reexportaciones provisionales de
  Conexiones sin cambiar ninguna consulta.
- **El seed 0003 cambió** `brand_accounts` de `{ platform, handle }` a
  `{ platform_id, handle }` para que la columna tenga una sola forma.
  En Supabase la fila vieja se actualiza al volver a correr el seed
  (`ON CONFLICT DO UPDATE`).
- **La conexión provisional de la web** pasó de `finanzas/_lib/` a
  `apps/web/lib/db/`, compartida por módulos; Finanzas reexporta.
  `apps/web/lib/forms.ts` unifica lo común de las Server Actions y
  Finanzas migra en FIN-2.
- **Tres decisiones tomadas por la opción conservadora, pendientes de
  Nicolás:** una campaña cerrada o cancelada no admite cambios; la lista
  `/campanas` no lleva la fila de KPIs del mock (son el resultado de una
  campaña, CAM-5); las Server Actions conservan nombre en español por el
  precedente de FIN-1.
- **`apps/worker/src/jobs/campanas/` no existe todavía** aunque §3.2 lo
  daba por creado desde el día 1; lo abre CAM-3.
- **Sesiones en paralelo, otra vez.** CON-1 y CAM-1/CAM-2 se
  construyeron a la vez en worktrees distintos y se cruzaron en `main`;
  el merge solo tocó `content/backlog.ts` en entradas distintas. El
  clon principal quedó atrás por cambios sin commitear de otra sesión;
  esta actualización del documento partió de esa versión preparada.

### 9.6 Lo que sigue

- **Ya:** aplicar 0015 (Nicolás) y, cuando Rasheed pueda, las filas 9 a
  13 de §9.4.
- **Ya (CON-3):** aplicar 0016; cuando lleguen las credenciales de las
  apps, seguir `docs/propuestas/CON-3.md` §5 y pasar CON-3 a «hecha».
- **Sprint 3 de Nicolás (§6):** CON-5, CON-6, FIN-2, FIN-3 y FIN-5.
- **Sprint 4:** CAM-3, CAM-4, CAM-5 y CAM-6 tienen sus anclajes en la
  ficha (`docs/propuestas/CAM-1.md` §7); COT-4 usa el contrato de CAM-2.
