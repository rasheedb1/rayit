# Backlog del MVP · dos programadores en paralelo

Escrito para: Nicolás y Rasheed, que van a construir el MVP, y quien
coordine.

Fecha: 21 de septiembre de 2026, segunda versión (la primera, del mismo
día, repartía Ventas y Cotizar a Nicolás y Campañas a Rasheed; se
cambió a pedido de Rasheed). Reemplaza el alcance de
[plan-equipo.md](plan-equipo.md), que cubría los nueve módulos. Las
reglas de trabajo de ese documento (ramas, revisión, integración,
migraciones inmutables) siguen vigentes.

**Actualizado la noche del 21 de septiembre de 2026** con el avance del
sprint 1: las cinco historias de Nicolás están construidas y probadas,
tres ya en `main`. El detalle, lo que falta integrar y lo que Rasheed
tiene que destrabar están en la [sección 8](#8-estado-del-sprint-1-al-21-de-septiembre-de-2026).

**Dónde se ve:** https://multicampaign-web.vercel.app. Es el marco real
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

La base de datos ya tiene las 88 tablas. **No hace falta ninguna
migración de esquema para el MVP.** Si aparece una, es una migración
nueva, nunca una edición. Ya apareció la primera: `0014_worker_grants.sql`
(CON-2), solo `GRANT`s al rol `mc_worker`, aplicada en Supabase el 21 de
septiembre. La siguiente es `0015_…`.

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
| CIM-6 | Seed de ventas y métricas: empresas, deals por etapa, actividades; cuatro conexiones, sesenta posts, noventa días de snapshots, línea base. | Rasheed | S | CIM-2 | `make seed` deja Ventas y Resumen con los números del mock. |
| CIM-7 | Despliegue continuo: el repositorio de GitHub conectado al proyecto de Vercel, cada merge a `main` publica; worker en Railway o Fly. | Rasheed | S | CIM-1 | Un merge a `main` aparece solo en la URL, sin comando. |
| CIM-8 | Seed de finanzas y campañas: tres facturas (una vencida), pagos, gastos recurrentes, dos campañas con posts y snapshots de la marca. | Nicolás | S | CIM-2 | `make seed` deja Finanzas y Campañas con los números del mock. **Hecha en rama el 21-sep, pendiente de merge.** |

### CON · Conexiones y datos (Nicolás, salvo los trámites)

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| CON-1 | Conectores con respuestas grabadas: TikTok Display, TikTok Accounts, Instagram Graph, YouTube. Reintentos, cuota, `api_call_log`. | L | CIM-1 | `pnpm test` pasa sin red y cada llamada deja su fila. |
| CON-2 | Worker arrancado: pg-boss, `job_definition`, `job_run`; `oauth.refresh` renovando tokens. | M | CIM-1 | `make worker` toma un job y lo registra; un token por vencer se renueva solo. **Hecha, en `main` el 21-sep**; en Supabase falta un paso con el token de administración (§8.3). |
| CON-3 | OAuth de TikTok e Instagram en sandbox: token cifrado, `secret_ref`, `data_consent`. | L | CON-1, CIM-3 | Conectar una cuenta de prueba deja la fila con sus scopes y el token no aparece en claro. |
| CON-4 | Pantalla Conexiones sobre `connection_health`: conectar, estado, horas desde la última sincronización, paso manual de Analytics en TikTok. | M | CON-3, CIM-5 | Una conexión vencida se ve en rojo con el botón de reautorizar. |
| CON-5 | Recolector: `collect.posts`, `collect.post_metrics`, `collect.account_metrics`, con `age_hours`. Append-only. | L | CON-1, CON-2 | Dos corridas producen dos filas por post y `post_metrics_daily_delta` muestra el crecimiento. |
| CON-6 | Línea base y puntaje: `compute.baseline` y `compute.post_score` con `packages/core/scoring.ts`. Con menos de ocho videos, `is_reliable = false`. | M | CON-5 | Un post con el doble de views que la mediana queda como outlier. |
| CON-7 | Demografía de audiencia (`collect.demographics`) respetando `metric_requirement`. | M | CON-5 | Con la respuesta grabada, la tabla coincide con el fixture; una cuenta personal de TikTok explica por qué no hay demografía. |
| CON-8 | OAuth de YouTube. | M | CON-3 | Igual que CON-3 para un canal de prueba. |
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

### COT · Cotizar (Rasheed)

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| COT-1 | Tarifario sugerido: `packages/core/tarifas.ts`, views × CPM con modificadores; views manuales hasta que exista la línea base. | M | CIM-2 | Con las views del mock salen los rangos del mock. |
| COT-2 | Media kit público con cifras congeladas, `slug`, contraseña y vencimiento opcionales. | M | COT-1, RES-1 | El enlace abre sin sesión y no cambia aunque cambien las métricas. |
| COT-3 | Cotización: desde un deal, ítems, totales, lo acordado antes de publicar, numeración. | L | COT-1, VEN-3 | Enviar pasa el deal a «Propuesta enviada»; tiene enlace público. |
| COT-4 | Aceptación: llama a `createCampaignFromQuote()` (CAM-2) y pasa el deal a «Ganado». | M | COT-3, CAM-2 | Aceptar deja una campaña en `planned` que Nicolás ve en su módulo. |

### CAM · Campañas (Nicolás)

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| CAM-1 | Lista y ficha de campaña: estado, entregables, fechas, posts asociados, código y enlace de seguimiento. Desde la ficha se crea la factura. | M | CIM-5, CIM-6 | Se asocian dos posts a una campaña y aparecen con sus views. |
| CAM-2 | `createCampaignFromQuote()` en `queries/campanas.ts`: crea la campaña con `quote_id`, `agreed_metrics`, fechas y `brand_baseline_from` catorce días antes. Es el contrato con Cotizar (D5). | S | CAM-1 | Rasheed la llama desde COT-4 sin pedir cambios. |
| CAM-3 | Seguidores de la marca: `brand.snapshot` diario del perfil público desde `brand_baseline_from`. | M | CON-1, CON-2 | La curva sale del snapshot con su línea base de dos semanas. |
| CAM-4 | Lo que aporta la marca: canjes, pedidos, ingresos, por formulario o CSV. | S | CAM-1 | Un CSV de ventas diarias aparece en la ficha. |
| CAM-5 | Resultado: `campaign.compute` llena `campaign_result`; `missing_inputs` dice qué falta. | M | CAM-3, CAM-4, CON-6 | Los seis KPIs salen de la tabla; sin datos de la marca dice «sin datos», no cero. |
| CAM-6 | Reporte a la marca: página pública con `payload` congelado, envío por enlace o PDF, `sent_at`, `viewed_at`. | L | CAM-5 | El reporte no cambia aunque lleguen snapshots nuevos. |

### FIN · Finanzas (Nicolás)

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| FIN-1 | Facturas: desde una campaña o a mano; IVA, retención, vencimiento, numeración, estados, número DIAN. | M | CIM-2, CIM-5 | Una factura desde una campaña trae nombre, empresa y monto solos. **Hecha en rama el 21-sep, pendiente de merge** (§8.2). |
| FIN-2 | Pagos parciales o totales; `tax_reserve` con el porcentaje del workspace. | M | FIN-1 | Un pago parcial deja `partial`; el total pasa a `paid` y aparta el impuesto. |
| FIN-3 | Cuentas por cobrar sobre `receivables`, con los cuatro KPIs. | M | FIN-1 | La factura vencida sale en rojo con sus días. |
| FIN-4 | Recordatorios de cobro: job `finanzas/recordatorios.ts` que redacta y deja listo para copiar. | M | FIN-1, CON-2 | Una factura vencida hace 41 días tiene sus tres recordatorios. |
| FIN-5 | Gastos con recibo en S3, recurrentes, deducibles. | S | CIM-5 | Un gasto recurrente aparece proyectado. |
| FIN-6 | Flujo de caja proyectado: `packages/core/flujo-caja.ts`, ocho semanas, gráfico y tabla. | M | FIN-2, FIN-5, VEN-3 | El gráfico sale de la función con el seed; un test cubre una semana. |
| FIN-7 | Ingresos de plataformas por CSV o a mano. | S | FIN-6 | Un CSV de AdSense aparece en su mes. |
| FIN-8 | Configuración financiera del workspace: moneda, reserva, IVA, retención, datos fiscales. | S | CIM-3 | Cambiar el porcentaje afecta los pagos siguientes, no los anteriores. |

---

## 6. Calendario: cinco sprints de dos semanas

Con los tamaños de arriba, el backlog pide 49 días de Rasheed y 59 de
Nicolás (extremo bajo). A diez días hábiles por sprint y persona, eso
son cinco sprints. **El ciclo completo se enseña al final del cuarto**;
el quinto es lo que depende de aprobaciones, más el piloto.

| Sprint | Rasheed | Nicolás |
|---|---|---|
| **1** · semanas 1 y 2 | CIM-1, CIM-2, CIM-3 (días 1 a 3) · CIM-6, CIM-7, CON-9 · VEN-1, VEN-2 | CIM-4, CIM-5, CIM-8 · CON-2 · FIN-1 |
| **2** · semanas 3 y 4 | RES-1, RES-2 · VEN-3 | CON-1, CON-3 · CAM-1, CAM-2 |
| **3** · semanas 5 y 6 | VEN-4, VEN-5 · COT-1, COT-2 | CON-5, CON-6 · FIN-2, FIN-3, FIN-5 |
| **4** · semanas 7 y 8 | COT-3, COT-4 · VEN-6 | CAM-3, CAM-4, CAM-5, CAM-6 · FIN-6 |
| **5** · semanas 9 y 10 | RES-3, RES-4 · VEN-7, VEN-8 · piloto | CON-4, CON-7, CON-8 · FIN-4, FIN-7, FIN-8 |

Carga estimada por sprint (extremo bajo, sobre 10 días): Rasheed 12 ·
12 · 11 · 9 · 5. Nicolás 12 · 13 · 12 · 12 · 10.

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
5. Pantalla de conexiones, demografía, YouTube, recordatorios de cobro
   (Nicolás). Lo que importa esta semana, cuándo publicar, brief y
   conversión (Rasheed). Producción abierta a los primeros creadores.

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

Y una que no bloquea nada: **nombre del producto y dominio**, para el
media kit y el reporte públicos.

---

## 8. Estado del sprint 1 al 21 de septiembre de 2026

Escrito la noche del 21 de septiembre, al cierre del primer día de
trabajo real. El sprint 1 va de la semana 1 a la 2; lo que sigue es la
foto de dónde está cada cosa, no el cierre del sprint.

### 8.1 Historias, una por una

Estado según `apps/web/content/backlog.ts` en `origin/main` y en las
ramas de cada historia. «En `main`» quiere decir que el código ya está
en `origin/main` y se publica con el siguiente despliegue.

| Id | Historia | Estado | Dónde está | Verificación |
|---|---|---|---|---|
| CIM-4 | Marco y navegación | **Hecha** | `origin/main` | Banderas con las llaves de `feature_flag` (0009) y 404 en la ruta directa; tokens del mock en `globals.css`; tema sin parpadeo; pruebas con vitest de nav, banderas y tema. Las banderas viven en `content/flags.ts` hasta que exista el cliente de base. |
| CIM-5 | Kit de interfaz | **Hecha** | `origin/main` | Trece componentes en `components/ui/` con pruebas (`Button`, `Pill`, formulario, `EmptyState`, `DataAsOf`, `Kpi`/`KpiRow`, `DataTable`, `LineChart`, `BarChart`, `ChartCard`, `Segmented`), `lib/format.ts`, galería `/kit` detrás de la bandera `kit` (`KIT=1` en el build). Los dos últimos commits (contraste AA en claro, cabecera fija con `maxHeight`, estado de error; y `Segmented`, el filtro por red que necesita Resumen) entraron a `main` a las 20:03 y **todavía no están en la rama de integración**. |
| CIM-8 | Seed de finanzas y campañas | **Hecha en rama** | `nicolas/CIM-8-seed-finanzas-campanas` | `db/seed/0003_demo_finanzas_campanas.sql` + `db/seed/verify/run-0003.mjs`: migra en Postgres embebido como rol sin `BYPASSRLS`, corre los seeds dos veces y compara conteos. Como `0002` (Rasheed) no existe, trae una sección 0 con los ids que `0002` debe usar (`docs/propuestas/CIM-8.md`). |
| CON-2 | Worker y `oauth.refresh` | **Hecha** | `origin/main` | `apps/worker` (runner, registro, logger con redacción, `job_run`) y `packages/connectors` (refresher, `secret-store`, fakes por plataforma). Pruebas sobre pglite: worker 16/16, conectores 17/17, corridas hoy. Migración `0014_worker_grants.sql` aplicada en Supabase. Falta el paso administrativo de §8.3. |
| FIN-1 | Facturas | **Hecha en rama** | `nicolas/FIN-1-facturas` (7 commits; el último, `e107ed0`, sin subir a `origin`) | `packages/core/src/facturacion.ts` (dominio y máquina de estados), `packages/db/src/queries/finanzas.ts` (transacción por workspace), lista con KPIs, formulario «Nueva factura» con total en vivo y Server Action con zod, detalle con «Marcar enviada» y «Anular», y `facturarCampana()` para el botón de CAM-1. Pruebas corridas hoy: db 13/13 en Postgres embebido con el seed 0003, web 6/6, core en verde. Sin `DATABASE_URL` arranca en modo demo. |

Historias de Rasheed en el sprint 1, según `backlog.ts` en `main`:
CIM-1 y CIM-7 en curso; CIM-2, CIM-3, CIM-6, CON-9, VEN-1 y VEN-2
pendientes. `docs/tramites.md` (CON-9) no existe todavía.

**Sobre la demo 1 del viernes.** La parte de Nicolás («primera factura
a mano y el worker corriendo un job») ya se puede enseñar desde las
ramas. La de Rasheed («login y marco; seeds cargados; empresas y radar
manual») depende de CIM-1, CIM-2, CIM-3 y CIM-6.

### 8.2 Lo que falta integrar, y en qué orden

Hay una rama local de integración, `nicolas/integracion-sprint-1`
(worktree `rayit-integracion`, sin remoto), que ya trae CIM-4, CIM-8,
CIM-5 y CON-2 mergeados y **tiene el merge de FIN-1 a medias**: trece
archivos en conflicto, ocho en `apps/web/components/ui/` más su
`README.md`, `globals.css`, `lib/format.ts` con su prueba y
`apps/web/package.json`. La causa es conocida: FIN-1
arrancó antes de que CIM-5 llegara a `main` y trajo su propio «kit
mínimo» con la misma API (§4 de `docs/propuestas/FIN-1.md`); al
juntarlos, cada archivo tiene dos versiones.

Orden propuesto para cerrar el sprint:

1. **Resolver el merge de FIN-1** quedándose con la versión de CIM-5 en
   todo `components/ui/`, `globals.css` y `lib/format.ts` (es el kit
   completo y las dos versiones exponen la misma API), conservando de
   FIN-1 solo `input.tsx` si CIM-5 no lo trae con ese nombre, y uniendo
   a mano `apps/web/package.json` (dependencias de `@mc/core` y `@mc/db`
   de FIN-1 más el runner de pruebas de CIM-5). Después, `typecheck`,
   `lint`, `test` y
   `pnpm --filter @mc/web dev` con `/finanzas` y `/finanzas/facturas/nueva`
   abiertas, porque el build no ejecuta páginas apagadas ni detecta
   errores de frontera cliente/servidor.
2. **Mergear `origin/main` en la integración**: trae los dos últimos
   commits de CIM-5 (contraste AA y `Segmented`), que se quedaron fuera.
3. **Subir `e107ed0` de FIN-1** a `origin`.
4. **PR de CIM-8 y PR de FIN-1** contra `main`, con Rasheed como
   revisor. Ambas cambian su `status` a `hecho` en `backlog.ts`; el de
   `main` todavía las tiene en `pendiente`.
5. **`make vercel.deploy PROD=1`** después del merge. Ojo: desde FIN-1
   la web importa `@mc/core` y `@mc/db`, así que el despliegue tiene
   que salir desde `platform/` con Root Directory `apps/web`
   (`V_APP_DIR=. make vercel.link` una vez, `V_APP_DIR=. make
   vercel.deploy PROD=1`) y el proyecto de Vercel necesita
   `DATABASE_URL`. Detalle en §7 de `docs/propuestas/FIN-1.md`.

También quedan sin versionar en el clon principal
`docs/sprint-1-nicolas-prompts.md` y `docs/propuestas/CIM-5-kit.md`;
conviene meterlos en el PR de FIN-1 o en uno de documentación.

### 8.3 Lo que Nicolás necesita de Rasheed (consolidado)

Todo esto está escrito con detalle en `docs/propuestas/`. Aquí, la
lista corta, en orden de urgencia:

| # | Qué | Para qué historia | Dónde está el detalle |
|---|---|---|---|
| 1 | Con el token de administración de Supabase, dos comandos: `CREATE SCHEMA pgboss` y `GRANT mc_worker TO mc_migrator`; luego `pnpm --filter @mc/worker install-schema`. | CON-2 en producción; sin esto el worker solo corre en pglite | `docs/propuestas/CON-2.md` §3.1 y §3.3 |
| 2 | CIM-2: `packages/db/src/client.ts` con `withWorkspace` (o equivalente) y el esquema Drizzle de `invoice`, `campaign`, `company`, `workspace`. Nicolás borra `provisional/` y `_lib/workspace.ts` al recibirlo. | FIN-1, CON-2, CAM-1 | `docs/propuestas/FIN-1.md` §1, §2 y §6 |
| 3 | CIM-3: `lib/workspace/` con el workspace de la sesión. | FIN-1 y todas las pantallas | `docs/propuestas/FIN-1.md` §6 |
| 4 | Seed `0002` usando los ids fijos de la sección 0 de `0003` (workspace, creadora, conexiones, empresas, posts), o avisar para cambiarlos. `0002` debe abrir con `set_config('app.workspace_id', …)` porque RLS está en `FORCE`. | CIM-6, CIM-8 | `docs/propuestas/CIM-8.md` §1 |
| 5 | CIM-7: Root Directory `apps/web` en Vercel, `DATABASE_URL` en el proyecto, y CI en Node 22 corriendo `test` además de migraciones. | Despliegue de FIN-1, CON-2 | `docs/propuestas/FIN-1.md` §7, `CON-2.md` §3.5 |
| 6 | Migración futura con tres filas en `feature_flag`: `content_metrics`, `niche_radar`, `ideas_scripts`. | CIM-4 (banderas a la base) | `docs/propuestas/CIM-4.md` §1 |
| 7 | Arreglo responsive de la tarjeta «Por persona» en `app/(app)/page.tsx` a 390 px. No urge. | Marco | `docs/propuestas/CIM-4.md` §2 |
| 8 | Acceso de desarrollador a las apps de TikTok y Meta (decisión 5). Bloquea CON-3 en el sprint 2. | CON-3 | §7 de este documento |

### 8.4 Desvíos respecto al plan, y por qué

- **La primera migración nueva ya existe** (`0014_worker_grants.sql`).
  El plan decía que el MVP no necesitaba ninguna; esta no cambia el
  esquema, solo concede privilegios a `mc_worker`, que desde 0010
  existía sin poder leer nada. Entró en `db/migrations/` (carpeta de
  Rasheed) por indicación expresa de Nicolás para no frenar CON-2.
- **D1 se resolvió al revés.** CIM-1 y CIM-2 no llegaron los días 1 a 3
  y Nicolás no esperó: FIN-1 usa un cliente provisional con la misma
  forma que tendrá `withWorkspace`, y el worker se conecta con `pg`
  directo. Los dos llevan `TODO(CIM-2)` y su reemplazo es mecánico.
- **Kit duplicado.** FIN-1 se construyó en paralelo a CIM-5 con la API
  del borrador (`docs/propuestas/CIM-5-kit.md`). Eso permitió avanzar,
  pero es la causa de los trece conflictos de §8.2. Regla para el
  sprint 2: una historia que necesita el kit espera a que el kit esté en
  `main`, o parte de la rama del kit, no de `main`.
- **Cifras del mock que no cuadran con la aritmética.** La factura de
  Nutrivé quedó en 4,7 M y no 4,5 M porque 4,5 M no se descompone en
  subtotal más IVA 19 % con dos decimales exactos. Decidido y documentado
  en `docs/propuestas/CIM-8.md` §3.
- **`make db.check` no corre los seeds** y cada corrida de pglite es una
  base nueva. Por eso el seed 0003 trae su propio `run-0003.mjs`. Vale
  para 0002 también.
- **Sesiones en paralelo sobre el mismo clon.** Las cinco historias se
  construyeron a la vez, cada una en su worktree (`rayit-cim5`,
  `rayit-CON-2`, `rayit-finanzas`, `rayit-integracion`). Funcionó, con
  una regla: el árbol principal se queda en `main` y nadie hace
  `checkout` ahí.

### 8.5 Lo que sigue (sprint 2 de Nicolás)

Sin cambios de alcance: CON-1 (conectores con respuestas grabadas),
CON-3 (OAuth de TikTok e Instagram en sandbox), CAM-1 (lista y ficha de
campaña; el botón «Facturar» ya tiene detrás `facturarCampana()`) y
CAM-2 (`createCampaignFromQuote()`, el contrato con Cotizar). CON-3
depende de CIM-3 y del acceso a las apps (§8.3, fila 8); si no llegan
en la semana 3, se adelantan CAM-1 y CAM-2 y CON-3 corre contra fakes.
