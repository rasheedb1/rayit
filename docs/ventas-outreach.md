# Ventas: outreach automático para creadores, a partir de CadenceV1.0

Escrito para: Rasheed, dueño del módulo de Ventas, y para los agentes
que construirán cada pieza.

Fecha: 22 de septiembre de 2026. Fuente: el repositorio
`rasheedb1/CadenceV1.0` (la plataforma «Chief» de outreach B2B), leído
completo en su parte de outreach: 1.526 archivos, de los que importan
unas 115 edge functions, 150 migraciones, la interfaz de cadencias y
la auditoría que el propio equipo dejó en `tasks/qa-chief-outreach/`.
Las presentaciones, los business cases y la capa de agentes por
WhatsApp quedaron fuera a propósito.

---

## 1. Qué hace Chief, en una página

Chief es un SDR automático para el equipo de ventas de Yuno. Un cron
descubre empresas, busca a las personas correctas en LinkedIn, las
mete en una cadencia de nueve días y ejecuta cada paso solo:

```
Día 0  LinkedIn: solicitud de conexión (plantilla fija)
Día 1  Correo de valor, con investigación de la empresa
Día 2  Comentario en su último post + like dos horas después
Día 3  Mensaje directo en LinkedIn
Día 5  Respuesta en el mismo hilo del correo del día 1
Día 7  Segundo mensaje directo
Día 9  Correo con el business case generado para esa empresa
```

Cada mensaje pasa por esta tubería antes de salir:

1. **Investigación** con caché (30 días empresa, 14 persona, 7
   señales): perfil y posts por Unipile, noticias por Firecrawl,
   señales clasificadas por un LLM en lote.
2. **Generación** con un prompt de trece bloques: regla de cero
   placeholders, persona remitente, señales ordenadas por encaje,
   investigación, límites por canal, «ángulo del día» que prohíbe
   repetir lo que ya se dijo, y los toques anteriores.
3. **Tres validadores deterministas**: asunto válido, similitud
   Jaccard menor de 0,65 contra los últimos veinte mensajes del mismo
   paso, y no enviar dos veces lo mismo.
4. **Supervisor con LLM («Carlos»)**: pre-vuelo sin tokens (longitud
   por paso, muletillas de IA, clichés, mayúsculas, enlaces de
   calendario en el primer toque), y luego una nota 0–10 en cuatro
   dimensiones con rúbrica por paso guardada en tabla. Banda muerta,
   regeneración con feedback concreto, tope de cinco intentos, y
   «enviar el mejor» si ninguno llega pero alguno pasa el mínimo.
5. **Guardarraíles atómicos**: setenta acciones de LinkedIn al día por
   organización, ciento cincuenta mensajes por semana, contrapresión a
   doscientos pendientes, presupuesto diario de treinta dólares para
   el supervisor, disyuntor por tipo de paso, interruptor de apagado
   que cancela todo lo pendiente.
6. **Envío** por Unipile (LinkedIn) o por la API de Gmail del propio
   usuario (correo), con guardia final de placeholders que bloquea
   con 422.
7. **Detección de respuestas** cada cinco minutos: si el contacto
   responde, se cancelan los envíos pendientes; si pide la baja
   (catorce expresiones en inglés y español), queda marcado como no
   contactar.

Funciona, y ha corrido en producción. También arrastra deuda que su
propio equipo documentó: veinte riesgos, seis de ellos críticos.

---

## 2. Lo que nos llevamos

Alrededor de mil doscientas líneas de infraestructura buena, probada,
y agnóstica del dominio. Ninguna se copia tal cual: se reescribe en
nuestro monorepo respetando nuestras convenciones, pero el diseño es
el suyo.

| Pieza de Chief | Dónde queda en MultiCampaign | Qué cambia |
|---|---|---|
| Cola `schedules`: reclamo atómico con `UPDATE … WHERE status='scheduled'`, índice único parcial, recuperación de zombis a los cinco minutos, deduplicación en tres capas, guardia de tiempo de ejecución | `outbound_touch` deja de ser solo el registro del envío y pasa a ser la cola: una fila por contacto y paso, con `status` de máquina de estados | Se añade `attempt_count` y `next_retry_at`: Chief no reintenta nada, un fallo de red mata el paso |
| Funciones `increment_if_under_cap` e `increment_weekly_*` por `action_type` | Migración `0037_outreach.sql`, mismas funciones por workspace | Se corrige el bloqueo: el `FOR UPDATE` de la semanal bloquea la fila de hoy pero cuenta la semana entera |
| Cliente de Unipile: petición genérica, clasificación de errores («no conectado», «ya conectado») | `packages/connectors/unipile.ts` | Se extiende a `INSTAGRAM`; hosted auth con estado firmado, nunca «reclamar cuentas sin dueño» |
| Envío por Gmail: MIME con RFC 2047 para acentos, multipart para adjuntos, refresco perezoso del token con dos minutos de margen | `packages/connectors/gmail.ts` | `In-Reply-To` y `References` con el `Message-ID` real, no con el `threadId` de Gmail (bug que rompe hilos fuera de Gmail) |
| Keepalive diario del token de Google | Job `ventas/canales.keepalive` | Una sola fila por concesión; Chief guarda el mismo refresh token en cuatro sitios y el keepalive deja uno caducado |
| Guardia de placeholders (`{{x}}`, `{x}`, `[x]`, `<x>`, `${x}`, TBD, TODO) en el punto de envío | `packages/core/src/outreach/placeholder-guard.ts` | Sin cambios |
| Detector de baja bilingüe (catorce expresiones) | `packages/core/src/outreach/optout.ts` | Se aplica también a lo que entra por Instagram y LinkedIn |
| Píxel de apertura con la heurística de ignorar la apertura del propio remitente en los primeros treinta segundos | `outbound_touch.opened_at` | Opcional; la apertura es señal débil |
| Conversión de zona horaria con `Intl.DateTimeFormat` (maneja horario de verano sin dependencias) | `packages/core/src/outreach/schedule.ts` | Chief la tiene en el frontend y otra copia en el backend con una ventana 09:00–16:59 en UTC en vez de la zona de la cadencia |
| Separación plantilla → asignación → ejecución → cola | `outbound_sequence` → `outbound_step` → `outbound_enrollment` → `outbound_touch` | Nuestra `outbound_sequence` hoy guarda los pasos en un `jsonb`; se normalizan para poder programar y medir por paso |
| Validadores A, B y C | `packages/core/src/outreach/gates.ts` | El gate B de Chief filtra por un `owner_id` escrito a mano; aquí se filtra por workspace |
| QA en dos niveles: pre-vuelo determinista y juez LLM con rúbrica por paso en tabla, banda muerta, regeneración con pistas cerradas, «enviar el mejor tras el máximo» | `outbound_step_rubric`, `outbound_review`, job `ventas/revisar` | El contenido de la rúbrica se reescribe entero (ver sección 5) |
| Ángulo por día con capacidades permitidas y prohibidas, y detección de ángulo repetido | Tabla `outbound_angle` | Los ángulos son los del creador, no los de pagos |
| Interruptor de apagado por organización con cancelación de pendientes, y disyuntor por tipo de paso (ventana de cincuenta, mínimo veinte muestras) | `outbound_policy.enabled`, `outbound_breaker` | Sin cambios de diseño |
| Alertas diarias por correo con una fila de bloqueo por tipo y día | Job `ventas/alertas` | Chief las manda por correo a propósito: WhatsApp exige plantillas aprobadas y ventana de veinticuatro horas |
| Interfaz: ejecución de un paso contacto por contacto con editor, vista previa y datos del contacto al lado; generación con IA con nota de calidad y tres botones de regeneración («más corto», «más casual», «otro ángulo»); revisión editable antes de un envío masivo; cola con reintento por tipo; widget de uso con límite blando y duro | Pantallas de Ventas | Ver sección 7 |

## 3. Lo que no nos llevamos

- **El monolito `process-queue`**, 2.429 líneas que mezclan
  programación, generación, validación, límites y lógica por canal.
  Su propio equipo tiene un bug de doble avance de paso ahí dentro.
  Se parte en: reclamar → resolver paso → despachar por canal con una
  interfaz común → registrar resultado.
- **Todo el contenido de dominio**: qué es Yuno, los doce clientes
  verificados, los rangos defendibles de tasas de aprobación, el
  vocabulario de pagos, las 383 líneas de contexto regional de medios
  de pago, el mapa de ángulos de orquestación. Nada sobrevive.
- **La prospección B2B**: búsqueda en cascada en Sales Navigator,
  enriquecimiento con Apollo, mínimo de diez correos por empresa,
  multi-threading dentro de la cuenta. Una marca la contacta una o dos
  personas, no diez; el radar de MultiCampaign ya tiene su propio
  diseño en la tabla `signal`.
- **La aprobación humana por WhatsApp** («responde 1, 2 o 3») y su
  bandeja de acciones pendientes. Para un creador la aprobación vive
  en la app.
- **La capa de agentes** (`chief-agents`, `openclaw`): son envoltorios
  conversacionales que en un caso saltan los guardarraíles (las
  herramientas de LinkedIn del agente mandan mensajes sin pasar por
  límites ni por QA). Toda la inteligencia real vive en las edge
  functions.
- **Los adjuntos de business case** generados con Puppeteer y
  SimilarWeb. El patrón «generar un activo y adjuntarlo en el toque N»
  sí se reutiliza: nuestro activo es el media kit y la cotización, que
  ya existen en Cotizar.

## 4. Lo que allá no existe y aquí hace falta

Esto es lo que hay que construir de verdad, y donde va el tiempo.

1. **Aislamiento multi-tenant.** La tabla de cuentas de Unipile de
   Chief no tiene organización; la detección de respuestas consulta
   sin filtro; la conexión puede quedarse con la cuenta de LinkedIn de
   otro usuario. Nuestras tablas nacen con `workspace_id` y RLS, y la
   conexión de un canal lleva un estado firmado.
2. **Entregabilidad y cumplimiento.** Chief no tiene SPF, DKIM,
   DMARC ni `List-Unsubscribe` en ninguna parte; tiene un correo de
   baja configurado que nada lee. Desde 2024 Gmail y Yahoo exigen
   `List-Unsubscribe` a remitentes de volumen. Aquí: pie de baja con
   enlace a una página pública que marca `contact.opted_out`, cabecera
   `List-Unsubscribe` con un clic, rebotes asíncronos leyendo el
   buzón, calentamiento progresivo, y la baja respetada en todos los
   canales (en Chief, los pasos de LinkedIn ignoran «no contactar»).
3. **Instagram como canal.** Cero referencias en Chief. Unipile lo
   soporta con usuario y contraseña (con reto de dos factores que
   caduca a los cinco minutos), y limita a cien acciones al día y diez
   por hora. Los mensajes a quien no te sigue caen en «Solicitudes» y
   se leen poco: es un canal secundario, no el principal.
4. **El perfil comercial del creador.** El equivalente a la «persona
   remitente» de Chief, pero derivado de datos y verificable: nicho,
   audiencia, formatos, sus mejores videos con cifras, campañas
   pasadas con resultado, tarifas. Cada afirmación con su origen.
5. **La bandeja de aprobación y la bandeja unificada.** Chief solo
   tiene un lector de LinkedIn. Un creador necesita una bandeja con
   correo, LinkedIn e Instagram, y un lugar donde aprobar, editar o
   regenerar lo que la máquina propone.
6. **Qué hacer con una respuesta.** En Chief, cualquier respuesta
   pausa al contacto para siempre, incluido un «fuera de la oficina».
   Aquí una clasificación barata de intención: interesado (pasa el deal
   a «En conversación»), ahora no (enfriamiento), fuera de oficina
   (retomar en la fecha), baja (opted_out global), referido (crear el
   contacto nuevo).
7. **Toques anteriores leídos de lo enviado.** Chief construye el
   «como te comenté el martes» a partir de mensajes aprobados, no
   enviados; si el supervisor rechazó el toque anterior, el siguiente
   cita algo que nunca salió. Aquí el historial sale de
   `outbound_touch` con `status = 'sent'`.
8. **Revisar el estado justo antes de enviar.** Chief cancela los
   pendientes al detectar una respuesta, pero no los que están en
   revisión ni los que ya se están procesando: el mensaje puede salir
   después de que el contacto contestó. Aquí el despachador vuelve a
   leer el estado del enrolamiento en la misma transacción del envío.

---

## 5. La adaptación

### 5.1 Canales y límites reales

| Canal | Cómo se conecta | Qué permite | Límites de Unipile o del proveedor | Papel en el MVP |
|---|---|---|---|---|
| **Correo (Gmail del creador)** | OAuth de Google, alcances `gmail.send` y `gmail.modify` (leer respuestas y rebotes) | Enviar, responder en el mismo hilo, adjuntar el media kit, leer respuestas | Cuenta personal: 500 al día oficial, recomendados 50–100; Workspace: 2.000, recomendados 100–150; cuenta nueva: empezar con 20–50 | **Principal.** Las marcas leen `partnerships@`; SPF y DKIM son de Google |
| **LinkedIn** | Unipile hosted auth (enlace de un uso, webhook de creación con estado firmado) | Solicitud de conexión con nota de 300 caracteres, mensaje, ver perfil, comentar y reaccionar a posts, buscar personas | 80–100 invitaciones al día y 200 por semana en cuenta activa; ~100 perfiles al día; espaciar al azar en horario laboral | **Secundario.** Sirve para llegar al responsable de marketing de la marca |
| **Instagram DM** | Unipile con usuario y contraseña; reto 2FA de cinco minutos | Mensaje directo, leer bandeja | 100 acciones al día, 10 por hora; empezar bajo | **Opcional, apagado por defecto** (`outbound_policy.allowed_channels` nace con correo y LinkedIn, 0045). Se enciende por workspace cuando la marca no tiene otro contacto |
| **WhatsApp** | Unipile | Mensaje | Esperar 24 h tras conectar; intervalos cortos entre mensajes | **Fase 2.** Solo para contactos que ya respondieron |

Unipile cobra por cuenta conectada al mes. Es el costo variable
dominante del módulo y hay que modelarlo en el precio por plan: un
creador con correo y LinkedIn son dos cuentas.

Los valores por defecto de `outbound_policy` que ya tenemos (cuatro
toques por empresa, tres días entre toques, veinte correos al día,
ciento ochenta días de enfriamiento tras un no, revisión humana
obligatoria, afirmaciones con origen) son más conservadores que los de
Chief. Se mantienen.

**Ojo con la cadencia de §5.3** (VEN-10): tiene cinco mensajes y
pasos a uno o dos días hábiles, así que con estos valores por defecto
**no cabe**: el quinto mensaje (la síntesis con el media kit y la
cotización, el que más vale) se cancelaría al reclamar (`company_cap`) y
los pasos seguidos se correrían hasta cumplir los tres días. El motor lo
dice al enrolar, con los pasos concretos:
`checkSequenceAgainstPolicy` de `@mc/core` y `EnrollResult.warnings`
(`over_company_cap` y `steps_closer_than_min_gap`, cada uno con sus
`stepIds`), para que la pantalla que enrola lo muestre antes de activar.
Qué cambia —la plantilla o los valores por defecto— lo decide Rasheed
(§8, pregunta 6).

### 5.2 El modelo de datos: migración `0037_outreach.sql` (en el plan original, «0015»)

Lo que ya existe y se queda: `company`, `contact` (con `opted_out`
global y `source` obligatoria), `company_link`, `signal`, `deal`,
`activity`, `outbound_brief`, `outbound_policy`, `outbound_sequence`,
`outbound_touch` con `claims`, y el disparador que impide programar a
quien pidió la baja.

Lo que se agrega:

| Tabla | Para qué | Viene de Chief |
|---|---|---|
| `outreach_channel_account` | Una cuenta conectada por canal y creador: `channel` (email, linkedin, instagram, whatsapp), `provider` (gmail_oauth, unipile), `provider_account_id`, `secret_ref` al vault, `status`, `daily_cap`, `weekly_cap`, `last_ok_at` | `unipile_accounts` + `ae_integrations`, con `workspace_id` y sin duplicar tokens |
| `outbound_step` | Pasos normalizados de una secuencia: `day_offset`, `order_in_day`, `step_type`, `channel`, `scheduled_time`, `angle_id`, `template_id`, `generate_with_ai`, `requires_asset` | `cadence_steps` con `config_json` tipado |
| `outbound_enrollment` | Un contacto dentro de una secuencia: `deal_id`, `contact_id`, `current_step_id`, `status` (active, paused, completed, replied, opted_out, cooldown), `resume_at`, `context` (ángulos usados) | `cadence_leads` |
| `outbound_touch` (extendida) | La cola y el registro: `enrollment_id`, `step_id`, `scheduled_for`, `status` (draft, scheduled, processing, held, sent, failed, skipped, canceled), `attempt_count`, `next_retry_at`, `provider_message_id`, `thread_ref`, `message_id_rfc`, `opened_at`, `replied_at`, `claims` | `schedules` + `lead_step_instances` + `email_messages` en una sola tabla |
| `outbound_message` | Lo que entra y lo que sale por hilo: `direction`, `channel`, `body`, `intent` (interested, not_now, ooo, unsubscribe, referral, ambiguous), `read_at` | `linkedin_messages` + `email_events` |
| `outbound_review` | Cada evaluación de QA: gates pasados, nota por dimensión, `regenerate_hint`, `risk_triggers`, decisión, tokens y costo | `message_qa_reviews` + `qa_supervisor_decisions` |
| `outbound_step_rubric` | Umbral, mínimo aceptable e intentos por `(step_type, day_offset)` | `carlos_step_rubric` |
| `outbound_angle` | Los ángulos permitidos y prohibidos por toque | `touch-angles.ts`, pasado a tabla |
| `outbound_counter` | Contadores atómicos por workspace, día y `action_type` | `daily_action_counters` |
| `outbound_breaker` | Disyuntor por tipo de paso | `step_type_circuit_breaker` |

Funciones: `increment_if_under_cap`, `increment_weekly`,
`should_pause_outreach`, `disable_outreach(workspace, reason)`,
`outbound_health(workspace, hours)`.

**Cómo quedó (VEN-9, 23 de septiembre).** La migración es
`platform/db/migrations/0037_outreach.sql`: el número 0015 lo tomó
`connection_secret` y las fases 1 a 3 llegaron hasta 0036. Además de lo
de arriba trae `outbound_sequence_template` (plantillas globales de solo
lectura, con «Marca con campaña activa»), `outbound_llm_call` (cada
llamada al modelo), `outbound_optout_link` (la prueba del enlace de
baja) y `outbound_optout_event` (quién provocó cada baja),
`enable_outreach`, `next_business_day(ts, tz)` y `public_optout(token)`.
Decisiones que las piezas siguientes tienen que conocer:

- El vocabulario de canales es el de 0007 en todas partes: `email`,
  `linkedin`, `instagram_dm`, `whatsapp`, también en las cuentas.
- Los estados de `outbound_touch` son `draft`, `scheduled`,
  `processing`, `held`, `sent`, `failed`, `skipped` y `canceled`; los
  de 0007 se tradujeron en la migración.
- La semana de los límites es su propia fila en `outbound_counter` (el
  lunes local del workspace): cada función bloquea la fila del periodo
  que cuenta. Los contadores y los disyuntores los escribe solo el
  worker.
- Los topes se cuentan **por cuenta** además de por workspace:
  `outbound_counter.channel_account_id` (NULL = el workspace entero) y
  dos firmas por función, `increment_if_under_cap(workspace, action,
  cap)` e `increment_if_under_cap(workspace, account, action, cap)`
  (igual `increment_weekly`). El despachador llama a la de la cuenta con
  `outreach_channel_account.daily_cap`/`weekly_cap` y a la del workspace
  con los topes de `outbound_policy`, en la misma transacción. Tres
  LinkedIn de una agencia no comparten plaza. `action_type` es la
  acción (`email`, `linkedin_invite`…), nunca una cuenta.
- Cada canal tiene un **techo** que ningún tope de cuenta pasa, ni
  desde la web ni desde el worker (CHECK
  `outreach_channel_account_channel_caps_check`, los números de §5.1):
  LinkedIn 100 al día y 200 a la semana; Instagram y WhatsApp 100 y
  700; correo 2000 y 10000. Por debajo, el tope es de la persona. Los
  mismos números están en `CHANNEL_CAP_LIMITS` (`@mc/db/schema`), que la
  pantalla de canales usa como máximo del campo.
- `outbound_policy.enabled` nace apagado y no se enciende sin
  `postal_address` (lo exige un `CHECK`). `max_pending_touches` mide
  atraso (lo vencido sin salir más lo que está en `processing`), no lo
  programado para dentro de unos días.
- Toda llamada al modelo del outreach deja una fila en
  `outbound_llm_call` (propósito `generate`, `judge`, `classify` o
  `recommend`, modelo, tokens y costo). `outbound_health` suma ahí el
  gasto del día contra `llm_daily_cap_usd`; `outbound_review.cost` es
  el detalle del intento y no se suma aparte.
- `llm_daily_cap_usd` protege la factura de la plataforma (la llave de
  Anthropic es de On Cue): lo cambia solo el worker o un operador. El
  disparador `outbound_policy_llm_cap` rechaza con 42501 que `mc_app` lo
  cambie o cree la política con otro valor que el de
  `outreach_default_llm_daily_cap()` (5,00 USD). Sin política,
  `outbound_health` devuelve ese mismo valor, no 0.
- `outbound_sequence.status` manda; `active` se deriva de él con un
  disparador hasta que VEN-13 retire la columna.
- En `outbound_touch`, `held_reason` es por qué está retenido y
  `blocked_reason` por qué terminó sin salir (`opted_out`,
  `outreach_disabled`…), más una anomalía: `opted_out_in_flight`, un
  envío que salió con la baja recién puesta. `status_changed_at` es la
  hora del último cambio de estado y solo se mueve con él.
- La regla de la baja (0007) vigila el alta y las transiciones, no las
  anotaciones: tras la baja se sigue pudiendo escribir `replied_at` u
  `opened_at` en un toque enviado. Ni la baja ni el apagado cancelan lo
  que está en `processing`: es del despachador, que lo cancela él antes
  de llamar al proveedor o lo registra como enviado después
  (`processing → sent` siempre se puede). Al rescatar un zombi con el
  contacto dado de baja, va a `canceled`, no a `scheduled`.
- **El enlace de baja vive fuera de la cola.** Lleva un token al azar;
  la base guarda solo su sha256, en `outbound_optout_link` (clave
  primaria: un token repetido falla al escribirlo), con la dirección a
  la que sale el correo, el workspace, el toque, la ficha, el intento,
  `claimed_at` y `sent_at`. Esa tabla la escribe **solo el
  despachador**, y la escribe **al reclamar** (`scheduled →
  processing`, en la transacción que sube `attempt_count` y escribe
  `recipient_address`), **antes** de llamar al proveedor: si el
  despachador cae entre Gmail y el COMMIT, o la respuesta se pierde por
  un timeout, el correo que quizá salió lleva un token que la base ya
  conoce. La base lo exige: un correo no se confirma en `processing`
  sin el enlace de su intento (`outbound_touch_optout_link_required`,
  al COMMIT; salvo `require_optout_link = false`). Cada reintento lleva
  su propio enlace (único por `(touch_id, attempt)`), y los anteriores
  siguen dando de baja. `sent_at` se anota una sola vez, al confirmar;
  si nunca se confirma, el enlace funciona igual. Nada más de la fila
  cambia. `mc_app` no tiene ningún privilegio sobre ella y su RLS solo
  tiene políticas de lectura (y la de alta de quien siembra). Sus
  claves ajenas son `ON DELETE SET NULL`, así que el enlace no depende
  de la cola: ni del estado del toque, ni de que el toque, su empresa,
  su ficha o su workspace sigan existiendo (CAN-SPAM pide al menos 30
  días; aquí no caduca). `public_optout` busca ahí y solo ahí.
- `public_optout` es de `mc_public_share`, como los enlaces de Cotizar.
  En 0037 daba de baja a la persona en toda la plataforma
  (`contact_suppression`, todas las fichas con esa dirección en cualquier
  workspace). **Desde 0038 §8 (VEN-15) vale para el workspace que envió
  ese correo, en todos sus canales, y nunca para toda la plataforma** (ver
  «La baja por enlace vale para quien envió», más abajo): la dirección
  entra en `outbound_workspace_optout`, se marca la ficha que recibió el
  correo y las fichas propias de ese workspace con esa dirección, y se
  cancela lo pendiente de ese workspace (los enrolamientos, con
  `finished_at`). Cancela exactamente `CANCELABLE_TOUCH_STATUSES`
  (`draft`, `scheduled`, `held`): todo lo vivo (`LIVE_TOUCH_STATUSES`)
  menos `processing`. Responde `workspaceId` y `touchId`, que son `null`
  si ya no existen.
- **Cada baja por enlace es atribuible y reversible.** `public_optout` deja
  cada clic en `outbound_optout_event` (token, workspace y toque que lo
  originaron, dirección, `sent_at`, si ya estaba de baja). Un operador
  (worker) puede ver qué workspace provocó cada entrada de
  `contact_suppression` y deshacerla, y VEN-15 puede alertar de un
  workspace cuyos destinatarios se dan de baja a los pocos minutos del
  envío (en una vista: ninguna pantalla hace esa resta).
- **Las pruebas de envío las escribe el despachador.**
  `provider_message_id`, `message_id_rfc` y `recipient_address` solo los
  escribe `mc_worker`: el disparador `outbound_touch_worker_columns`
  rechaza a `mc_app` con 42501, al crear y al actualizar. Además, para
  `mc_app`, un toque en `sent` no vuelve atrás (volver a la cola era un
  segundo envío del mismo correo), un toque con pruebas no cambia de
  `contact_id` ni de `company_id` (`contact_id` → NULL sí, que es lo que
  hace borrar la ficha), y no se borra (`outbound_touch_keep_sent`; las
  cascadas de empresa y workspace sí pasan). Son disparadores y no GRANT
  por columnas porque Drizzle nombra todas las columnas en cada INSERT;
  la guardia (`DISPARADORES_DE_CANDADO`) exige en cada arranque que
  existan y estén activos.
- **`processing` es del despachador.** La web no crea un toque en ese
  estado, no lleva uno a él ni lo saca de él, ni lo borra (42501,
  `outbound_touch_worker_columns` y `outbound_touch_keep_sent`). Como
  ni la baja ni el apagado cancelan lo reclamado, un toque puesto en
  `processing` desde la web quedaba fuera de los dos.
- **`recipient_address` se escribe al reclamar.** Es la dirección exacta
  a la que sale el mensaje, y el despachador de VEN-10 la escribe en la
  misma sentencia que pasa el toque de `scheduled` a `processing`: un
  correo en `processing` o con `provider_message_id` sin ella no entra
  (CHECK `outbound_touch_email_recipient_check`). La baja se anota
  sobre ella y no sobre la ficha: cambiarle el correo a la ficha después
  del envío, o mover el toque a otra ficha, no da de baja a otra
  persona.
  En LinkedIn e Instagram, `recipient_address` es el **provider_id** de
  la persona en ese proveedor (el `provider_id` que devuelve el perfil de
  Unipile, el mismo que llega como `attendee_provider_id` en el aviso de
  un mensaje). Es lo que reconoce la respuesta que llega fuera del hilo
  del toque: la invitación con nota no abre chat, y quien la acepta
  contesta en uno nuevo (VEN-9, `recordInboundMessage`). Sin él, esa
  respuesta se ignora como un DM ajeno, y un «no me escribas más»
  también.
- **La regla de la baja mira la lista global.** Un toque no entra en
  `scheduled`, `processing` ni `sent` si su ficha tiene `opted_out`, si
  el correo de la ficha está en `contact_suppression` (un rebote duro o
  una queja que todavía no se reflejó en esa ficha), o si
  `recipient_address` está en la lista aunque no coincida con
  `contact.email`. La excepción es `processing → sent` (lo que ya salió
  se registra, marcado `opted_out_in_flight`). La consulta de reclamo de
  VEN-10 tiene que filtrar esas filas y pasarlas a `canceled`, porque la
  base rechaza el reclamo entero. **Desde VEN-15 r5 (0038 §8.3) es una
  sola regla con una fuente más:** `enforce_outbound_optout` mira también
  `outbound_workspace_optout` (la baja por enlace de ESE workspace, que en
  un contacto global no marca la ficha), con las mismas transiciones. Así
  que el reclamo de VEN-10 filtra además `outbound_workspace_optout` (por
  `workspace_id` y por la dirección de la ficha o la del envío) y, en
  correo, `contact.email_invalid` y los rebotes duros verificados del
  workspace (`outbound_touch_email_invalid`, 0038 §2). **La vuelta a la
  cola desde `processing`** (el reintento, o el rescate del zombi) de
  alguien dado de baja **no se rechaza: la base la cancela en el sitio**
  (`canceled`, `blocked_reason = 'opted_out'`), igual que la del correo
  inválido (`email_invalid`). El rescate de VEN-10 (`releaseUnattempted`)
  devuelve a la cola con un solo `UPDATE` por lote, de todos los
  workspaces: con un 23514, un solo zombi dado de baja abortaba el rescate
  entero en cada pasada y esos toques se quedaban en `processing` para
  siempre (con `outreach_queue_stuck` avisando cada día). Ahora las demás
  filas del lote vuelven a `scheduled` y la dada de baja termina
  cancelada; lo prueba `entregabilidad.test.ts` con tres zombis en un
  solo `UPDATE`. Hasta r4 la baja del
  workspace se saltaba la vuelta desde `processing`: un toque de LinkedIn
  reclamado al pulsar la baja volvía a la cola y salía como `sent` sin
  marca. `mc_app` no lee la lista: la regla usa
  `address_is_suppressed(citext)`, SECURITY DEFINER, que responde sí o
  no para una dirección (lo mismo que ya enseña crear una ficha con ese
  correo).
- **Un toque es coherente con su enrolamiento.** El disparador
  `outbound_touch_enrollment_check` exige, también al worker, que el
  enrolamiento sea del mismo workspace y del mismo contacto que el
  toque, y que el paso sea del mismo workspace y de la secuencia del
  enrolamiento; un toque con enrolamiento siempre lleva contacto. Pasos
  y enrolamientos tienen el workspace de su secuencia, y el paso actual
  de un enrolamiento es de su secuencia.
- A quien pidió la baja no se le enrola ni se le reanuda: el disparador
  `outbound_enrollment_optout` rechaza (23514, el mensaje de 0007) un
  enrolamiento nuevo o que vuelve a `active`, `paused` o `cooldown`. «La
  baja» es la misma que en el toque: la ficha, o su correo en la lista
  global (un rebote o una queja que todavía no se reflejó en la ficha).
- Un paso tiene un solo toque vivo por enrolamiento, y vivo es
  `scheduled`, `processing` **y `held`**: mientras uno espera revisión,
  el motor no programa el mismo paso otra vez; lo aprueba (vuelve a
  `scheduled`) o lo cancela y programa otro.
- Un buzón (el Gmail o la cuenta de Unipile) envía desde **un solo
  workspace**: `(provider, provider_account_id)` es único entre las
  cuentas **autenticadas** (`connected`, `needs_reconnect`, `error`) de
  toda la plataforma. Los topes son por cuenta, y el mismo Gmail en el
  workspace del creador y en el de su agencia habría enviado el doble.
  Para moverlo, se desconecta en uno. Una fila `pending` no ocupa nada,
  y a un estado autenticado solo llega el **callback del proveedor**
  (OAuth de Google o alta en Unipile, en el servidor con `asWorker`):
  `outreach_channel_account_worker_columns` rechaza con 42501 que
  `mc_app` escriba `status` autenticado, `provider_account_id` en una
  fila existente, `secret_ref` o `scopes`. Desde la web se crea la fila
  `pending` o se desconecta. El callback escribe `provider_account_id`
  con lo que **devuelve el proveedor**, en la misma sentencia que pasa a
  `connected`. La pantalla de canales (VEN-9) tiene que traducir el
  23505 en «esta cuenta ya está conectada en otro espacio».
- `outbound_step` no tiene `template_id`: el texto fijo del paso va en
  `subject_template` y `body_template`, y la plantilla de secuencia de
  origen está en `outbound_sequence.template_id`.
- Las funciones se llaman por `@mc/db/queries/outreach`, no con SQL
  suelto: `incrementIfUnderCap` e `incrementWeekly` (WorkerTx, que ahora
  lleva marca de tipo como PublicShareTx: un WorkspaceTx no compila
  ahí; eligen la firma según venga o no `accountId`),
  `shouldPauseOutreach`, `disableOutreach`, `enableOutreach` y
  `outboundHealth` (con un WorkspaceTx el workspace es el de la
  transacción; con un WorkerTx se nombra), `publicOptout`
  (PublicShareTx) y `nextBusinessDay`. El jsonb de `outbound_health` y
  `public_optout` se comprueba en ejecución (`OutreachShapeError` con la
  ruta del campo).
- La concurrencia real de los límites está probada contra Postgres 16
  («el bloqueo es de verdad», que PGlite salta), en un paso propio del
  job `contra-postgres-real` del CI junto con la guardia de esquema;
  ese Postgres se monta como Supabase con
  `platform/db/montaje-postgres-real.sql` antes de migrar. Cómo correrla
  en local está en `platform/packages/db/README.md`.
- `outbound_health` no recorre la historia: la cola se lee por su
  estado vivo y cada cifra de la ventana por el índice de su propia hora
  (`sent_at`, `status_changed_at`, `opened_at`, `replied_at`).
- La demo trae una cadencia entera (seed `0005_demo_outreach.sql`, con
  su verify): Gmail conectado y LinkedIn por reconectar, la secuencia
  copiada de «Marca con campaña activa», tres enrolamientos (activo,
  respondió, enfriamiento) y toques en todos los estados, escritos como
  los dejaría el despachador. Es el ejemplo a copiar para VEN-10, VEN-13
  y la pantalla de canales.
- **Obligatorio para VEN-15:** el correo sale del Gmail del creador,
  así que el enlace de baja también queda en su carpeta de enviados.
  Quien envía podría pulsar su propio enlace y suprimir a una marca en
  toda la plataforma. La página de baja **rechaza el clic que llega con
  una sesión de un miembro del workspace que envió** (el servidor lo
  sabe antes de llamar a `publicOptout`: `outbound_optout_link` no se
  lee desde la web, así que se lo pregunta a `public_optout_preview`
  (0038 §5) por el sha256 del token, sin `asWorker`), pide una
  confirmación que un clic automático no dé, y el despachador no vuelve
  a mostrar el enlace en la aplicación.
  Lo que se escape queda en `outbound_optout_event` para la alerta y
  para deshacerlo.

**Cómo quedó la entregabilidad (VEN-15, ronda 2, 24 de septiembre).** Lo
que el despachador de VEN-10 tiene que usar, todo en
`@mc/core/outreach/deliverability` (puro, con pruebas):

- **El token de baja** es opaco: `createOptoutToken()` da 32 bytes al
  azar en base64url, la misma forma que genera hoy `newOptoutToken` de
  VEN-10, y en `outbound_optout_link.token_hash` va
  `optoutTokenHash(token)`. No lleva ningún id dentro ni depende de un
  secreto: la base lo reconoce por su sha256, así que un error de
  configuración no puede apagar la baja y los enlaces no caducan. La
  primera ronda lo firmaba con `OUTREACH_OPTOUT_SECRET` y llevaba los
  uuid en claro; esa llave ya no existe. **Hecho en VEN-10 r3:** el
  despachador usa `createOptoutToken` + `optoutTokenHash`,
  `buildEmailFooter` y `oneClickUnsubscribeUrl` (la cabecera
  `List-Unsubscribe` apunta a `/baja/<token>/un-clic`); sus copias
  (`newOptoutToken`, `withOptoutFooter`, el `optoutUrl` de
  `@mc/core/outreach/optout.ts`) ya no existen. Un token de la ronda 2 da
  de baja igual (probado en `packages/db/test/entregabilidad.test.ts`).
- **La página de baja** (`/baja/<token>`, sin sesión) pregunta a
  `public_optout_preview(token, espacios de quien la abre)` (0038 §5,
  SECURITY DEFINER de `mc_public_share`): si el enlace es de un correo
  que salió, la dirección enmascarada («v•••@marca.com»), el nombre y el
  idioma (r5) del espacio que escribe, si ya estaba de baja y si quien la
  abre es miembro del espacio que la envió. Ese último caso no ofrece el
  botón (la regla de §5.2). La página habla el idioma del pie que trajo
  hasta ella (español o inglés, la regla de `footerTextsFor`); sin
  espacio que lo diga (un enlace que no existe, la frontera de error), el
  del `Accept-Language` del navegador. Un token que no es de ningún
  correo enviado responde **404 de verdad** (`notFound()` y su propio
  `not-found.tsx`, con los mismos textos por idioma; el segmento no tiene
  `loading.tsx`, que mandaba un 200 antes de saberlo): un monitor o el
  proveedor que prueba el enlace distingue uno roto de uno bueno. La
  pregunta es una sola frase con quién escribe primero y la dirección
  («Laura no volverá a escribirte: ni a l•••@marca.co ni por ningún otro
  canal»). El clic va por `public_optout`.
  Después del clic no se promete lo que el producto no cumple: quien
  escribía no puede deshacer la baja (solo un operador, a pedido de la
  persona), así que el «listo» da `SUPPORT_EMAIL` como la vía para
  deshacerla por error, y sin él no ofrece ninguna. El POST de un clic
  de Gmail va a `/baja/<token>/un-clic`, que acepta el cuerpo en
  `multipart/form-data` (el SHOULD de la RFC 8058 §3.1) y en
  `application/x-www-form-urlencoded` (lo que manda Gmail).
- **La baja por enlace vale para quien envió (0038 §8; alcance cerrado
  el 25 de septiembre).** Sin sesión nadie sabe quién pulsa: el propio
  creador, en una ventana privada o con un `curl` a `/un-clic`, suprimía
  a la marca para toda la plataforma. El clic vale para el espacio que
  envió ese correo, **en todos sus canales**: la dirección entra en
  `outbound_workspace_optout` (ese espacio no le vuelve a escribir, ni por
  correo, ni por LinkedIn, ni por Instagram), se cancela lo suyo, se
  cierran sus enrolamientos y su ficha queda de baja: si es propia, con
  `contact.opted_out`; si es compartida (contacto global), la ficha que
  ese espacio ve dice «Dado de baja», porque `listContacts` suma su fila
  de `outbound_workspace_optout`. Es lo que la ley pide (CAN-SPAM, RGPD,
  habeas data: cada creador responde de su propio envío). **Un enlace
  nunca escribe `contact_suppression`.** Las rondas 3 y 4 la pasaban a
  toda la plataforma cuando la confirmaba un segundo espacio sin miembros
  en común; la revisión mostró que eso lo fabrica UNA sola persona con dos
  registros gratis y un correo desde cada uno, y ninguna señal que la
  plataforma tenga (antigüedad de la cuenta, envío encendido, dominios)
  distingue dos registros de la misma persona: solo alarga la espera del
  sabotaje. La lista de toda la plataforma se llena con lo que un clic no
  fabrica: una respuesta de la persona clasificada como baja (VEN-14,
  desde el worker) o un administrador. `mc_public_share` ya no tiene
  `INSERT` sobre `contact_suppression`, y de las fichas por dirección
  solo lee las propias del espacio que envió (`contact_public_optout_email`
  rehecha en 0038 §8). Probado en pglite: dos espacios recién creados por
  dos usuarios nuevos pulsan sus enlaces y el creador de verdad le sigue
  escribiendo. La base guarda el motivo como código
  (`contact.opted_out_reason = 'unsubscribe_link'`,
  `outbound_policy.disabled_reason = 'manual'`) y la pantalla lo traduce.
  Es la decisión 6 de §8, tomada como supuesto declarado.
- **Cada correo** lleva `buildEmailFooter` (frase de baja con
  `optoutUrl` y la dirección postal de la política; sin dirección no hay
  pie y el correo no está listo) y `listUnsubscribeHeaders`.
- **El tope diario de una cuenta** es `warmupDailyLimit({ day:
  warmupDay(conectada, ahora, zona), policyLimit, warmupDays })`: 20 al
  día durante la meseta (la primera semana con 14 días de calentamiento;
  la primera mitad si son menos) y en línea recta hasta el tope el día
  `warmup_days`. La pantalla pinta `warmupCurve`, que sale de la misma
  función.
- **Los rebotes** los lee `outbound.bounces` cada media hora a través de
  la interfaz `BounceMailbox`. El adaptador sobre el `GmailApi` de VEN-9
  ya está (`apps/worker/src/jobs/ventas/gmail-rebotes.ts`,
  `gmailBounceMailbox`), probado con un Gmail falso de la forma de su
  FakeGmail. **Integrado en la fase 4:** el job registrado lee el Gmail de
  verdad con `GmailChannel.bounceMailboxFor(cuenta)`, el mismo canal del
  despachador de VEN-10, con el token de la cuenta del almacén
  (`gmailMailboxes` en `outbound.bounces.ts`, registrado como
  `bouncesMailboxSource`); `gmailMailboxFor` y `GmailSourceFor` quedan
  para armar un buzón desde otra fuente (las pruebas). Sin
  `GOOGLE_CLIENT_ID/SECRET`, o con el canal falso, cada cuenta sale como
  «canal no configurado». `BOUNCE_READING_CONNECTED`
  (`@mc/core/outreach/bounces`) está en `true`, y la prueba de
  `outbound-bounces.test.ts` impide volver a un job que no lee mientras
  exista `packages/connectors/src/gmail.ts`. Lo que dice «Salud de hoy»
  lo decide el cursor de cada Gmail (`readSendReadiness.bouncesReading`):
  «todavía no leemos» si un buzón no se leyó nunca, y «la lectura está
  parada desde…» con la hora si el cursor tiene más de dos horas; así, un
  job parado no enseña «Ningún rebote» como si todo fuera bien. La hora de cada aviso es la de llegada al buzón
  (`internalDate` de Gmail), no su cabecera `Date`, que pone el remoto y
  puede venir atrasada: con ella un aviso quedaba detrás del cursor. `detectBounce` exige un remitente de rebote
  (mailer-daemon, postmaster) también con DSN, y solo da «duro» con lo
  que dijo el servidor (Diagnostic-Code, una línea con código SMTP, o la
  frase del notificador de que el DOMINIO no existe), nunca por una frase
  suelta del cuerpo: un «fuera de la oficina» de postmaster@ no marca a
  nadie. **Solo un rebote VERIFICADO tiene efectos** (ronda 3): el aviso
  trae el Message-ID de un correo `sent` de ese mismo espacio. Entonces
  marca `contact.email_invalid` (y `bounced`) con su motivo si la ficha es
  PROPIA del espacio, cancela los correos pendientes de ese espacio a esa
  dirección (no los de LinkedIn, ni los que ya van a otra dirección), y
  frena en ese espacio los correos nuevos a esa dirección, también a una
  ficha compartida (contacto global), que no se marca: un aviso en el
  buzón de un creador no le cierra el correo a los demás. No va a
  `contact_suppression`, que corta todos los canales. Corregir el correo
  de la ficha borra las dos marcas. La base no deja programar ni
  reclamar un correo a esa dirección (`outbound_touch_email_invalid`):
  lo rechaza con `check_violation`. La vuelta a la cola desde
  `processing` (el reintento, o el rescate de un zombi) no se rechaza:
  la base la **cancela en el sitio** (`canceled`, `email_invalid`), así
  que un correo reclamado cuando llegó el aviso ni vuelve a salir ni se
  queda atascado. `processing → sent` sí, porque ya salió. En la misma
  transacción del rebote, y en un **barrido idempotente al final de cada
  pasada** (`sweepInvalidEmail`, que solo mira los candidatos —fichas con
  `email_invalid` y espacios con un rebote duro verificado— por los
  índices parciales `contact_email_invalid_idx` y
  `outbound_touch_email_pending_idx`: una pasada sin rebotes no recorre
  `outbound_touch`), el job cancela lo que quede en draft,
  scheduled o held a esa dirección —un borrador creado después del
  rebote, por ejemplo— y **pausa los enrolamientos activos** de esa
  ficha en ese espacio cuya secuencia es solo de correo
  (`context.paused_reason = 'email_invalid'`): sin eso el enrolamiento
  seguía «activo» y el planificador chocaba con la regla en cada vuelta.
  Una secuencia con LinkedIn o Instagram sigue por ahí: **el planificador
  de VEN-10 salta los pasos de correo** de una ficha con el correo
  inválido (o con un rebote verificado de su espacio) en vez de
  insertarlos, y su consulta de reclamo filtra esas filas. Reanudar un
  enrolamiento pausado así es a mano, después de corregir el correo. El
  job lee cada buzón desde su cursor
  (`outreach_channel_account.bounces_read_at`), del más viejo al más
  nuevo y como mucho 300 avisos por pasada: una ráfaga no deja atrás a
  los viejos; y no vuelve a pedir entero (`messages.get`) un aviso que
  ya está en `outbound_bounce`, así que el solape de una hora del
  cursor no cuesta cuota. **Falta en el conector de VEN-9:**
  `GmailApi.searchBounces` tiene que aceptar `pageToken` y devolver
  `nextPageToken` (messages.list los tiene); con el arreglo de hoy, si la
  lista viene llena el job lo avisa en el registro.
- **Las alertas** (`outbound.alerts`, cada hora por workspace desde las
  8:00 locales) dejan una `notification` por tipo y día, en el idioma del
  espacio, con su propio enlace y sus plurales (`Intl.PluralRules`), y
  mandan UN resumen por correo al día (local) a todos los dueños por
  `SMTP_URL`, con los dueños en **Cco** (el «Para:» es el remitente): en
  una agencia con varios dueños ninguno ve la dirección de los demás. Sale en la primera corrida del día que tenga algo que
  contar. **Desde r5, lo urgente no espera:** si después del resumen cae
  una cuenta o se disparan los rebotes (`URGENT_ALERT_KINDS`, las dos
  'critical'), sale en esa misma corrida un correo corto aparte; lo demás
  va en el resumen del día siguiente. Leer lo pendiente, enviarlo y
  marcarlo va en una transacción bajo un candado por espacio: dos
  corridas que se solapen mandan un solo correo. La web todavía no tiene
  una campana de avisos (ni `shell.tsx` ni `nav.tsx` la tienen): los
  avisos de las últimas 24 horas se ven **arriba de «Salud de hoy»**
  (`listTodayOutreachAlerts`, los urgentes primero, con su enlace), y
  `/ventas` señala los urgentes junto a «Política de envío»
  (`countUrgentOutreachAlerts`). Así un aviso llega aunque el correo no
  esté configurado o falle. Hay un sexto tipo, `outreach_bounces_unread`: un
  Gmail conectado cuyo buzón de rebotes no se leyó nunca o lleva más de
  dos horas sin leerse (`readAlertSignalCounts.unreadMailboxes`), para
  que «ningún rebote» no se lea como «todo llegó» mientras la lectura no
  esté conectada. La tasa de
  rebotes cuenta solo los duros de lo enviado en la ventana; «no envió
  nada» solo salta si había toques que tocaba enviar
  (`readAlertSignalCounts`, `@mc/db`). La cuenta caída dice cuál es y
  lleva a `/ventas/canales`, donde se reconecta (`CANALES_URL`, que es
  `OUTREACH_URLS.channels` de `@mc/core/outreach/messages`); en la lista
  de cuentas caídas de `/ventas/politica#cuentas` cada una lleva su botón
  «Reconectar» (`reconectarUrl`, la misma URL). El texto del aviso no dice
  «en tu política de envío ves qué pasó»: se lee dentro de esa misma
  página, y el correo ya lleva su enlace. Los avisos guardan su frase ya en el idioma del espacio en
  `notification.title_es` y `body_es` (columnas de 0009, cuando todo era
  español; 0038 §4 lo dice en su `COMMENT`). Renombrarlas —`title`,
  `body` y un `locale`, o `kind` y los valores en `jsonb` para traducir al
  leer— toca a todos los que escriben avisos y queda para una migración
  propia. `last_error` guarda códigos
  (`CHANNEL_ERROR_CODES` de VEN-9 y `unipile_status:<X>`): la lista los
  traduce (`motivoCaida`, las frases en `ventas/politica/messages.ts`,
  las mismas de `CANALES_TEXTOS`), y uno desconocido —o una frase vieja
  con la jerga del proveedor— sale como «No tenemos más detalle», nunca
  crudo.
  Sin `APP_URL` el resumen sale sin enlaces —nunca a localhost— y el job
  lo avisa en el registro; en producción sin `MAIL_FROM` no sale (un
  remitente `.invalid` rebota) y el resultado lo cuenta en
  `emailSkipped` con su motivo.
- La política y la **salud de hoy** se ven en `/ventas/politica`. Solo
  la cambian 'owner' y 'admin' del espacio (0038 §7: políticas
  RESTRICTIVE de `outbound_policy`, y la pantalla lo dice); encender pide
  además una cuenta de envío conectada y confirmación con los mensajes
  aprobados que salen hoy.
- La demo (seed 0006) trae un rebote duro con su ficha marcada, uno
  blando y la alerta del día de la cuenta de LinkedIn caída. Desde la
  ronda 4 cuenta la historia al abrir `/ventas/politica`: cuatro correos
  salieron en las últimas 24 horas (uno rebotó, así que «Rebotes» tiene
  cifra) y la política de la demo es de 80 correos al día con 14 de
  calentamiento, así que se pinta la rampa. Desde la ronda 5 el Gmail de
  la demo tiene su buzón de rebotes leído hace 20 minutos (el cursor que
  deja el job), así que «Salud de hoy» no dice «todavía no leemos tus
  rebotes» encima de una tabla con dos.
- **Ronda 5 (24 de septiembre), en una línea cada cosa:** una sola regla
  de la baja para los toques (arriba, §5.2), el correo inválido también
  en el reclamo y en la vuelta desde `processing`; la baja en el idioma
  del espacio que envió; la tabla accesible de la curva dentro de un
  `div.sr-only` (una `<table>` con `sr-only` no se encoge y daba scroll
  horizontal a 400 y a 1280 px); el interruptor devuelve el foco a su
  título y anuncia «Envío encendido» o «Envío apagado»; con la dirección
  y una cuenta listas dice «Todo listo»; el tope de la dirección sale de
  `POSTAL_ADDRESS_MAX` y el código `manual` de `DISABLED_REASON_MANUAL`
  (`@mc/db`); la frase de la baja ya no dice «a este correo» y «por
  ningún canal» a la vez; y el enlace de baja de la demo no se fabrica en
  las pruebas ni sin una URL absoluta.

- **Ronda 6 (25 de septiembre), en una línea cada cosa:** la vuelta
  `processing → scheduled` de alguien dado de baja (de este espacio o de
  toda la plataforma) se cancela en el sitio con `opted_out`, así que el
  rescate por lotes de VEN-10 no aborta entero por un zombi (prueba con
  tres zombis en un `UPDATE`); el barrido del correo inválido parte de
  los candidatos con índices parciales; `/baja/<token>` responde 404 a un
  token desconocido; en el móvil «Últimos rebotes» es una lista (la
  tabla de cuatro columnas medía 505 px en 366 y escondía la fecha); la
  nota de «Rebotes» dice por qué 1 de 4 no avisa (`bounceRateStatus`,
  `@mc/core`, la misma regla que la alerta); los enlaces de los avisos
  dicen adónde llevan y son solo el ancla; `last_error` se traduce; y la
  demo guarda `unipile_status:CREDENTIALS` en vez de la frase de Unipile.

- **Ronda 7 (25 de septiembre), en una línea cada cosa:** la baja por
  enlace vale siempre para quien envió y nunca escribe
  `contact_suppression` (cierra el sabotaje de una persona con dos
  registros); `gmailMailboxFor` deja la lectura real de rebotes en una
  función de la integración; el resumen de alertas va con los dueños en
  Cco; el aviso de cuenta caída no pide reconectar si no hay cómo, y su
  texto no manda a la página donde ya se lee; con pocos envíos «Rebotes»
  dice «1 de 4» en vez de un 25 %; `deliverability.ts` queda como índice
  de `unsubscribe`, `footer`, `deliverability-messages`, `bounces`, `alerts` y `channels`, y
  los textos del pie viven en `outreach/deliverability-messages.ts` (no `messages.ts` ni `optout.ts`, que son de VEN-10: el enlace va en `unsubscribe.ts`) con una sola regla
  de idioma (`outreachLanguage`, por `Intl.Locale`) que usan también la
  página de baja y las alertas; y `@mc/db` abre cada base de pruebas
  desde una foto migrada (`dumpDataDir`/`loadDataDir`), así que el
  arranque de pglite ya no se come el tiempo límite de la primera prueba
  (CIM-12).

**Probar la baja a mano, en local.** El seed guarda solo hashes de
tokens al azar, así que ningún enlace suyo se puede pulsar.

*Sin nada instalado (modo demo, el de siempre).* Sin `.env.local` la web
arranca con el Postgres embebido y el seed. Al terminar de sembrar
fabrica un enlace de baja sobre el último correo enviado de la demo,
como el despachador (`crearEnlaceDeDemo`, `@mc/db/demo-baja`), y lo
imprime en el aviso del arranque:

```bash
cd platform
PORT=3100 pnpm --filter @mc/web dev --port 3100
# [db] Sin DATABASE_URL: Postgres embebido … Enlace de baja de prueba (…): http://localhost:3100/baja/<token> (a …)
```

Solo en modo embebido: con `DATABASE_URL` no se fabrica nada (sería un
enlace de baja real). Tampoco en las pruebas (`NODE_ENV=test`) ni sin
`APP_URL` o `PORT`: un enlace sin host no se puede pulsar. Cada arranque trae una base nueva y un enlace
nuevo.

*Con el Postgres de Docker:*

```bash
cd platform
make up && make seed
docker compose exec -T db psql -U mc -d oncue -c \
  "CREATE ROLE mc_app_ci LOGIN PASSWORD 'ci' IN ROLE mc_app; GRANT mc_worker TO mc_app_ci;"
pnpm --filter @mc/db demo:enlace-baja          # imprime /baja/<token> y el curl del un clic
DATABASE_URL=postgres://mc_app_ci:ci@localhost:5432/oncue pnpm --filter @mc/web dev --port 3100
```

Abre el enlace sin sesión (o en una ventana privada), pulsa «Dejar de
recibir mensajes» y la ficha queda de baja con sus toques cancelados. El
comando se niega con Supabase (escribiría un enlace de baja real) y no
sirve con la web en modo demo (el Postgres en memoria vive dentro del
proceso de la web: ahí el enlace lo imprime el arranque, arriba).

#### Cómo funciona el motor (VEN-10)

El motor de cadencias vive en tres sitios: la programación pura en
`packages/core/src/outreach/` (días hábiles, zona, ventana, dispersión,
reintentos, guardia de huecos, detector de bajas, textos de los avisos),
las consultas en `packages/db/src/queries/outreach/` (enrolar, reclamar,
enviar, respuestas, rebotes, la ficha) y los jobs en
`apps/worker/src/jobs/ventas/` (`outbound.dispatch` cada dos minutos,
`outbound.replies` cada cinco, `outbound.bounces` cada treinta, 0051).
Sus migraciones son `0051_motor_cadencias.sql`, `0052_motor_ritmo.sql`,
`0053_motor_intento_sin_confirmar.sql` y `0054_respuesta_detiene_la_marca.sql`.
Lo que hace hoy, por partes:

- **Enrolar** (`enrollContacts`). Solo fichas del workspace de la
  secuencia (`contact_visible_to`, 0051 §5). Cada paso nace con su hora
  (días hábiles, zona de la secuencia o del workspace, ventana laboral de
  la política y una dispersión determinista) y su estado: `draft` si lo
  completa una persona o el generador, `skipped` sin dirección (o con el
  correo rebotado, VEN-15), `held` si faltan datos (huecos, asunto, nota
  de LinkedIn de más de 300 caracteres) o si la revisión humana está
  encendida (`needs_review`, el valor por defecto), y si no `scheduled`.
  Una ficha que no se puede enrolar nunca tumba el lote; el resultado
  dice por qué (`not_found`, `opted_out`, `already_enrolled`,
  `email_invalid`, `no_address`, `invalid_address`) y avisa de lo que la
  política no va a dejar cumplir (`over_company_cap`,
  `steps_closer_than_min_gap`).
- **Reclamar** (`claimDueTouches`). Hasta cincuenta toques vencidos, con
  `UPDATE … WHERE status = 'scheduled' … RETURNING` y `FOR UPDATE SKIP
  LOCKED`, en una transacción que se confirma antes de llamar a nadie.
  Un reclamo a la vez: la transacción toma
  `pg_advisory_xact_lock(hashtext('outbound.dispatch/claim'))`, porque la
  separación con la marca y el ritmo por hora de la cuenta se leen de lo
  ya confirmado y dos reclamos a la vez (el cron y un `job:dispatch` a
  mano) leerían lo mismo; `outbound.dispatch` declara `max_concurrency =
  1` (0055). Lo prueba `packages/db/test/outreach-reclamo` contra
  Postgres 16 en el CI. Sin gastar intento: fuera de la ventana → a la apertura; un paso
  anterior sin salir → espera; sin cuenta conectada → espera una hora con
  un aviso por canal y día; la marca con `max_touches_per_company`
  mensajes en 90 días → cancelado (`company_cap`); menos de
  `min_days_between_touches` desde el último mensaje a la marca → espera;
  tope diario o semanal lleno (la curva de calentamiento de VEN-15 sobre
  el límite de la cuenta de VEN-9) → siguiente día hábil del workspace,
  con los pasos de detrás; ritmo por hora de la cuenta → su turno.
- **Enviar** (`sendOne`, tres transacciones). (1) Se relee todo con el
  toque y el enrolamiento bloqueados y se decide (`decideBeforeSend`: la
  baja, el interruptor, el enrolamiento, la cuenta, la dirección postal,
  los huecos, el asunto, la nota, una respuesta en el hilo sin hilo
  conocido); lo que no es enviar se aplica ahí. Si esta transacción
  falla, el toque no tiene `send_started_at` y los zombis lo devuelven a
  la cola sin aviso. (2) `send_started_at`, solo si toca enviar. (3) Se
  relee otra vez, se compone el mensaje (pie y `List-Unsubscribe` de
  VEN-15, el hilo), se pasa la guardia de huecos sobre lo que sale y se
  llama al adaptador. Un resultado ambiguo (un corte después del POST) no
  se reenvía a ciegas: el siguiente intento pregunta al proveedor
  (`findSent`) y, si no lo sabe, lo retiene para una persona.
- **Resultado.** Transitorio → reintento con espera creciente dentro de
  la ventana, hasta cinco; dirección que no sirve → `failed`, se cancela
  ese canal y la cadencia cierra en `bounced`; cuenta caída o sin token →
  espera sin gastar intento. Zombis de más de cinco minutos: sin
  `send_started_at` vuelven a la cola; con él, `failed` y aviso, sin
  reenviar. Lo reclamado que no se llegó a intentar vuelve con su plaza.
- **Respuestas** (`applyInboundEffects`, la misma función para el
  webhook de Unipile y para el lector del motor). Una respuesta de
  verdad detiene a la persona en todas sus secuencias del workspace
  (`replied`, lo pendiente cancelado) y, con
  `outbound_policy.stop_company_on_reply` (0054, encendido por defecto y
  editable en `/ventas/politica`), pone en pausa las cadencias de las
  demás personas de la misma marca. Una baja marca las fichas propias
  del workspace con ese correo y cancela todo lo suyo; si la pide un
  tercero en copia, la cadencia se detiene y una persona decide. Un
  «fuera de oficina» se guarda sin cancelar nada, salvo que pida la baja.
  Una respuesta de LinkedIn o Instagram que solo trae un adjunto es una
  respuesta (cuerpo `[adjunto]`), por las dos vías.
- **El intento sin confirmar.** En la ficha de la empresa, el bloque
  «Mensajes de la cadencia» enseña el asunto, las primeras líneas, la
  cuenta y el día del intento; «Sí, salió» lo anota como enviado
  (`outreach_resolve_unconfirmed`, 0053) y «No salió: enviarlo» pide
  confirmación antes de devolverlo a la cola. Un correo confirmado a mano
  no tiene hilo: la respuesta en el hilo del paso siguiente se retiene
  (`reply_without_thread`) y el lector de respuestas busca ese hilo en
  Gmail (`recordRecoveredThread`); al encontrarlo, la lee y la devuelve a
  la cola.
- **El interruptor.** Apagar (`disable_outreach`) cancela lo programado
  y lo retenido con `outreach_disabled` y deja vivas las cadencias.
  Encender (`enableOutreach`) lo devuelve a la cola en la misma
  transacción (`replanOutreach`): cada mensaje a su estado anterior y con
  su texto; si ya venció, replanificado desde ahora con los mismos días
  hábiles entre pasos. Lo de una ficha que se dio de baja mientras tanto
  no vuelve.
- **El canal falso** (`OUTREACH_CHANNELS=fake`, `--canal-falso`) sigue
  una sola regla (`fakeAllowed`): Postgres embebido, una base local, o
  una corrida limitada al workspace de la demo. Contra Supabase para
  todos los workspaces, o en producción, el worker no arranca.
- **Las pruebas**, sin red, en `apps/worker/test/`: `outreach-motor`
  (la punta a punta y el interruptor), `-enrolar`, `-ritmo`,
  `-politica-marca`, `-respuestas`, `-intento-ambiguo`, `-cuentas`,
  `-rebotes`, `outreach-canales` (los adaptadores) y `outreach-demo` (los
  comandos y la demo con el seed); con la RLS de la web, en
  `packages/db/test/outreach-aprobar`, `-respuestas` y `-encender`.

La historia de cómo se llegó aquí (las rondas de revisión) está en el
log de git de las ramas `rasheed/VEN-10-motor-cadencias*`.

**Renumeración al integrar.** Supabase (`schema_migrations`) tiene la
serie de main hasta `0042_metricas_al_corte_desempate.sql`. Las de esta
rama que chocan con ella pasan, en su orden, a 0043–0049; 0050 a 0055 ya
llevan su número final. Las rondas siguientes de VEN-9-canales traen
`0041_canales_reclamar_al_soltar`, `0042_canales_identidad_y_rotacion` y
`0043_contacto_codigo_de_baja`, que también chocan: al integrarlas van
detrás de 0049 y antes de 0050, y el script se amplía con ellas. Lo hace
`platform/scripts/renumerar-outreach.sh` (mueve los archivos y cambia las
referencias por nombre en las pruebas), después de mezclar main y antes de `make
db.check`:

| En esta rama | Al integrar |
|---|---|
| `0034_seguimientos.sql` | `0043_seguimientos.sql` |
| `0035_zona_del_espacio_valida.sql` | `0044_zona_del_espacio_valida.sql` |
| `0036_siguiente_accion_fijada.sql` | `0045_siguiente_accion_fijada.sql` |
| `0037_outreach.sql` | `0046_outreach.sql` |
| `0038_canales_outreach.sql` | `0047_canales_outreach.sql` |
| `0039_callback_de_canales.sql` | `0048_callback_de_canales.sql` |
| `0040_canales_liberar_y_limites.sql` | `0049_canales_liberar_y_limites.sql` |
| `0050_entregabilidad.sql` … `0055_motor_equipo_y_reclamo.sql` | igual |

**main borró `membership.role`.** `0034_access_control` (main, ya en
Supabase) la cambia por `role_id → role` y convierte los `client` en
`viewer`. El motor decide quién recibe un aviso (una respuesta, un toque
retenido o fallido) y a qué dueños les llegan las alertas con
`membership_is_team` y `membership_is_owner` (0055), que eligen su forma
al aplicarse: con o sin `role_id`. Los fixtures de las pruebas dan de alta
las membresías con `membershipSql` (`@mc/db/test/membresia`), que también
funciona en las dos series. `make db.check` en verde no demuestra nada de
esto: compila las migraciones, no el SQL de las consultas. Por eso el
paso 1 corre `pnpm verificar` después de renumerar.

**Lo que hace el integrador contra Supabase** (el «terminado cuando» de
VEN-10), un comando por paso, desde `platform/`, con
`W=00000002-0000-4000-8000-000000000001` (el workspace de la demo):

1. Mezclar main, `./scripts/renumerar-outreach.sh`, **`pnpm verificar`**
   (las pruebas del motor sobre la serie integrada; `db.check` no basta),
   `make db.check`, `make db.migrate` (hasta 0055) y el seed. Al
   resolver la mezcla de `packages/db/test/ventas.test.ts`, la lista de
   responsables del seed de main trae también a Andrés Pardo (mánager,
   0034): es del equipo y cuenta.
2. `./scripts/supabase-admin.sh sql "GRANT mc_worker TO mc_migrator"`.
3. `pnpm --filter @mc/worker run job:dispatch -- --preparar-demo --workspace $W`:
   deja la demo como `--demo` con el reloj de verdad (la dirección
   postal, el LinkedIn de la demo conectado, su mensaje vencido ya, lo
   enviado a Vitalé lo bastante atrás para cumplir los días entre
   mensajes) y el envío apagado. Si avisa de que está fuera del horario
   de envío, los pasos siguientes se corren dentro de él.
4. `pnpm --filter @mc/worker run job:dispatch -- --canal-falso --workspace $W`.
   Esperado: `Despacho: 0 reclamados, 0 enviados`.
5. `pnpm --filter @mc/worker run job:dispatch -- --encender --workspace $W`.
6. `pnpm --filter @mc/worker run job:dispatch -- --canal-falso --workspace $W`.
   Esperado: `Despacho: 1 reclamado, 1 enviado` y el toque en `sent` con
   `provider_message_id = fake-linkedin-…`.
7. Pegar las salidas de 4 y 6 en la nota de VEN-10 y pasarla a hecho.

La prueba `outreach-demo.test.ts` corre los pasos 3 a 6 sobre Postgres
embebido con las mismas migraciones y el mismo seed. El 25-sep-2026
corrió también sobre la serie integrada (las 0034–0042 de main, los
seeds mezclados y la renumeración): las pruebas del motor de
`apps/worker` pasan, `outreach-demo` incluida. Y los pasos 3 a 6, con el
reloj de verdad, contra un Postgres 16 local migrado con esa serie y el
seed (la ventana del workspace abierta a toda hora, porque eran las
03:00): el paso 4 dio `Despacho: 0 reclamados, 0 enviados` y el 6
`Despacho: 1 reclamado, 1 enviado`, con el toque en `sent` y
`provider_message_id = fake-linkedin-0001`. Contra Supabase, fuera del
horario, el paso 6 mueve el toque a la apertura («Fuera de la ventana:
1») y no envía: se corre dentro del horario.

### 5.3 La cadencia recomendada para un creador

Chief demostró dos cosas que valen la pena: que cada toque tenga un
ángulo propio y que esté prohibido repetir el de otro día, y que la
mezcla de canales (público, correo, directo) funciona mejor que un
solo canal. Trasladado a un creador que le escribe a una marca:

| Día | Canal | Ángulo (dueño del toque) | Qué se prohíbe aquí | Cifra o prueba que puede usar |
|---|---|---|---|---|
| 0 | Comentario público o like en el último post de la marca | **Presencia**: que vean el nombre antes del correo | Vender, mencionar tarifas | Ninguna |
| 1 | Correo | **Encaje de audiencia**: quién ve mis videos y por qué es su cliente | Hablar de tarifas, adjuntar el media kit completo | Demografía de audiencia, alcance en no seguidores |
| 3 | LinkedIn o Instagram DM | **Prueba de desempeño**: un video concreto, parecido a lo que la marca necesita, con sus cifras | Repetir la demografía | Views a 7 días frente a la mediana propia, guardados por mil, un post outlier |
| 5 | Respuesta en el hilo del correo | **Concepto creativo**: una idea específica para su producto o su temporada | Cifras de audiencia ya dichas | La señal del radar (campaña activa, lanzamiento, temporada) |
| 7 | Directo | **Prueba social**: una marca del mismo vertical con resultado medido | Inventar clientes | Una campaña con `campaign_result` calculado |
| 9 | Correo | **Síntesis y siguiente paso**: media kit y cotización con enlace | Presión, urgencia falsa | El media kit congelado y la cotización pública |

Cada fila es una fila de `outbound_angle`. El creador la puede editar;
el generador la respeta y el revisor la vigila. Las cifras solo pueden
venir de `creator_profile`, `creator_baseline`, `post_score`,
`media_kit.snapshot` y `campaign_result`: si una cifra no tiene origen,
el mensaje no se puede marcar como listo. Esto ya estaba en nuestra
tabla `outbound_touch.claims`; Chief lo hace con una lista de doce
clientes escrita a mano en el prompt, y nosotros con la base.

### 5.4 El perfil comercial del creador

Es la «persona remitente» de Chief, pero derivada de datos:

- **Identidad**: nombre, nicho, idiomas, país, redes conectadas.
- **Audiencia**: edad, género, país, alcance en no seguidores. De
  `audience_breakdown` y `post_metrics_latest`.
- **Desempeño**: mediana de views por red, sus cinco mejores videos
  con `outlier_tier` y por qué funcionaron (gancho, formato,
  duración). De `creator_baseline`, `post_score`, `creator_post_board`.
- **Formatos y tono**: qué hace (reels, tutoriales, historias) y cómo
  habla. En el MVP sale de los captions; en la fase 2, de las
  transcripciones y el análisis del laboratorio de video.
- **Prueba social**: campañas reportadas, con marca y resultado.
- **Tarifas**: el tarifario vigente de Cotizar.
- **Narrativa**: tres párrafos generados por un LLM que solo pueden
  citar lo anterior, con cada cifra enlazada a su origen. Se
  regenera cuando cambian los datos, y el creador la puede corregir.

Este perfil es lo que el usuario llamó «analizar el perfil y los
videos de la persona que va a montar sus redes». Se calcula al
conectar las cuentas o al importar el CSV, y alimenta el generador y
el recomendador.

#### Cómo funciona hoy (VEN-11)

- **Cálculo**: `buildPerfil` en `@mc/core/outreach/perfil` (puro) a
  partir de las filas que lee `readPerfilInputs` en
  `@mc/db/queries/perfil-comercial`. Cada cifra es un
  `Claim { id, kind, key, params, value, unit, source: { table, id, field, rows?, url?, asOf? } }`:
  una clave (`median`, `audience.gender`, `video.multiple`…) y sus
  parámetros (red, segmento, corte, título), sin texto. La pantalla lo
  escribe con su `messages.ts` y el locale del workspace; el prompt, con
  `claimLabelEs`. `source.asOf` es la fecha de la lectura (día de la
  demografía y de los seguidores, `computed_at` de la línea base, del
  puntaje, del resultado y del tarifario). Las secciones solo llevan ids.
- **Medianas y cortes**: la mediana de cada red sale de
  `creator_baseline` al corte de 168 h (o el más largo que haya), y cada
  una dice su corte. Los cinco mejores salen de TODO el historial con
  puntaje (`scoredPosts`: los 1 000 más recientes con puntaje y, siempre,
  los cinco de más «veces su mediana»), no solo de los 200 posts
  recientes que se leen para formatos y tono: un breakout de hace años
  entra. Se ordenan por
  `post_score.views_vs_median`, que ya está normalizado contra la línea
  base de SU corte (por eso es comparable entre cortes); cada video lleva
  además su corte y la mediana contra la que se midió
  (`post_score.baseline_id` → `baselineClaimId`), así «6× tu mediana»
  se puede comprobar: views ≈ veces × esa mediana (probado con el seed).
- **Por qué funcionó**: primero, cómo es el video (gancho, pieza, tipo y
  duración frente a la típica de su red): es la explicación que siempre
  se da. Después, solo si los datos la sostienen, lo que lo distingue:
  `whyContrast` compara los OTROS videos con el mismo rasgo contra los
  que no lo tienen, dejando fuera al video que se explica (si entrara,
  un 6× en un grupo de dos pondría él solo la mediana del grupo y la
  razón sería circular). Hace falta al menos tres videos a cada lado sin
  contarlo (`WHY_MIN_GROUP`) y que el grupo rinda la mitad más
  (`WHY_MIN_LIFT = 1,5`); de los ejes que pasan, se dice solo el de mayor
  contraste (`WHY_MAX_REASONS = 1`). Las dos medianas son claims por
  video (`porque-<video>-<eje>-<grupo>` y `…-resto`) con las filas que
  las forman. Con el seed de Laura ningún rasgo alcanza, y la pantalla y
  la plantilla describen el video sin inventarle una causa. Lo que se
  lee de los captions sigue en `perfil-captions.ts`; si
  `creator_post_board.hook_type` existe, gana.
- **Guardado**: `creator_profile.media_kit → perfil_comercial`
  (`StoredPerfil`, versión 3, con `computedAt`), escrito con
  `jsonb_set` sin tocar las demás claves. Trae la portada de cada uno de
  los cinco mejores (`post.cover_url`) y el índice de los posts que
  forman algún agregado (`perfil.posts`, título y enlace). Enlaces y
  portadas se sanean al calcular (`webUrlOrNull`: solo http(s);
  `coverSrcOrNull`: solo https, o una de las portadas de la demo,
  `/demo/portadas/<archivo>`; ninguna otra ruta de la web, para que una
  portada sembrada por CSV no haga pedir `/auth/salir` ni otra ruta con
  las cookies de quien mira, y ninguna http, que sería contenido mixto), porque `post.url` no tiene CHECK y la importación CSV
  guarda lo que venga: un enlace sin esquema queda en null y el perfil se
  guarda igual. `parseStoredPerfil` comprueba cada arreglo que la
  pantalla recorre y que enlaces (también `source.url` de cada cifra) y
  portadas tengan esa forma; un documento de otra versión, a medio
  escribir o editado a mano se lee como «sin calcular».
- **Un recálculo a la vez**: «Recalcular» toma una marca en
  `media_kit → perfil_comercial_recalculo` (`claimPerfilRecalc`, un
  UPDATE condicionado) en la misma transacción que lee las filas, y la
  suelta al guardar. Un segundo «Recalcular» mientras tanto dice que ya
  hay uno en curso y no llama al modelo, así dos pestañas no se pasan
  del tope diario por una llamada cada una. Si Vercel corta la función,
  la marca vence sola a los 90 s. La marca anota la narrativa que había:
  si al guardar la vigente es una edición del creador con otra fecha
  (alguien la editó mientras el modelo escribía), no se pisa
  (`stale_edit`).
- **Narrativa**: `@mc/core/outreach/narrativa`. El modelo recibe la
  lista de claims y escribe `[claim:id]` en vez de cifras;
  `verifyNarrative` rechaza un id que no está, cualquier dígito fuera
  de una marca, cualquier cantidad en letras de una lista cerrada
  («dos», «mil», «millones», «veintiún», «treintaitrés», «una veintena»,
  «un par», «el doble», «la mitad», «por ciento»), los
  verbos que multiplican («dupliqué», «cuadrupliqué», «doblé»), los
  ordinales y puestos de ranking («la segunda», «la primera en…»,
  «número uno», «top»), las proporciones sin cifra («la mayoría», «la
  cuarta parte», «tres cuartos»), los numerales en inglés («two
  million», «twice») y los signos % y × sueltos; y cualquier número
  Unicode, no solo los dígitos («²», «⅔», «½»), salvo dentro de
  términos del perfil (títulos, campañas,
  tarifas, franjas de edad, frases de corte), y los huecos de la guardia
  de VEN-10. Además, la palabra pegada a una marca tiene que ser lo que
  la cifra mide (`unit_mismatch`): «[claim:mediana-tiktok] seguidores» se
  rechaza porque es una mediana de views, aunque la cifra sea real; el
  vocabulario de unidades es cerrado y no juzga lo que no conoce («mi
  mediana», «de mis seguidores»). Las listas y el prompt de sistema van por idioma
  (`CANTIDADES`, `UNIDADES`, `SISTEMA`: hoy solo `'es'`; añadir un idioma es añadir
  sus datos), y la pantalla dice en qué idioma se redacta. Dos intentos con
  claude-sonnet-5, de 25 s cada uno y sin reintentos del SDK (caben en
  el `maxDuration` de 60 s de la página); el tope diario se consulta
  antes de cada intento y cada llamada va a `outbound_llm_call` con
  propósito `'profile'` (migración 0060) apenas responde. Si ninguno
  pasa, sin llave o con el tope alcanzado, la plantilla determinista,
  que cita la mediana de la red del mejor video y la de su corte. Los
  países de la narrativa y del prompt se nombran en el idioma de la
  narrativa, no en el locale del workspace (un workspace en-US no
  escribe «vive en United States» en un párrafo en español). El
  creador puede editarla sin ver ningún id: en el editor cada cifra es
  una ficha legible con su valor, ⟦115,4 mil⟧, que al guardar vuelve a su
  `[claim:id]` (`fichas.ts`); la vista previa corre el mismo verificador en
  el cliente (`verifyNarrativeWith` con `verifierContext`, datos planos)
  y subraya cada problema en su sitio (`narrativeIssueSpans`), con las
  marcas desconocidas escritas como fichas ⟦…⟧ y no como `[claim:…]`, y al
  guardar pasa la puerta del servidor. La plantilla dice el alcance en no
  seguidores como lo que es, una mediana: «en un video típico».
- **Pantalla**: `/ventas/perfil`, pestaña «Perfil comercial» de Ventas.
  Cada cifra es un botón que abre un globo (al pasar el cursor, con el
  teclado o al tocarla) con qué es, tabla, red y fecha, y «Abrir el
  origen». Con el teclado cada cifra es una sola parada de Tab: el foco
  abre el globo para leerlo, y su enlace entra en el orden de tabulación
  solo cuando Enter o un clic lo dejan fijo. El origen es el post, la campaña, el tarifario, la serie de seguidores en
  `/resumen?red=…#seguidores`, o su fila en «De dónde sale cada cifra»
  al final de la página (línea base, demografía, no seguidores y los
  agregados). Ese bloque empieza plegado (un media kit no termina en una
  cola técnica), se abre al seguir el enlace de una cifra, va por grupos
  (demografía y alcance, líneas base, puntajes y porqué, captions) y en
  cada fila dice qué es, cuánto, de dónde y qué videos la forman, con su
  enlace; la tabla, la columna y la fila quedan en el `title`, para
  soporte. Los cinco mejores llevan su portada 9:16, leída viva al pintar
  (`readPostCovers`): las de TikTok e Instagram son URLs firmadas que
  caducan, así que no se usa la congelada en el perfil. Una que ya no
  carga, o la que falta, cambia a un marcador con el color de su red, su
  nombre y la duración; si ninguno de los cinco tiene portada, la columna
  no se pinta. La demo trae ocho portadas ilustradas
  (`apps/web/public/demo/portadas`, seed 0007). Si la petición de una acción falla antes de
  responder, el error se dice en su región `role=status`, sin caer en
  `error.tsx`. «Recalcular» y «Editar» solo se ofrecen a owner, admin y
  member (`PUEDEN_EDITAR_PERFIL`), y las dos acciones lo vuelven a mirar.
- **Carpetas ajenas**: ninguna. Los nombres de las redes que usa el
  prompt viven en `@mc/core/plataformas`; la pantalla usa
  `PLATFORM_LABEL` del kit, que no se toca. Una prueba de la web
  (`ventas/perfil/plataformas.test.ts`) falla si las dos listas se
  separan, y la unificación (el kit importa de `@mc/core/plataformas`)
  queda en la rama `rasheed/kit-plataformas-desde-core`, para un PR que
  revise Nicolás. Todavía no se recalcula solo al conectar
  una cuenta o importar un CSV: la pantalla avisa cuando hay datos más
  nuevos que el cálculo.

### 5.5 El recomendador de cadencia

Chief tiene `suggest-outreach-strategy`, pero decide a quién contactar
primero dentro de una empresa, no qué pasos dar. Aquí el recomendador
recibe: el brief del creador (`outbound_brief`), la señal que originó
el deal, los canales conectados y los contactos disponibles de la
empresa. Devuelve una secuencia propuesta: pasos con día, canal,
ángulo y **una guía por paso** («Día 1: abre con la coincidencia entre
tu audiencia de 25 a 34 y su producto; no menciones precio; cierra con
una sola pregunta»). El creador la edita en una línea de tiempo y la
activa. Hay plantillas por nicho y por tipo de señal (lanzamiento,
campaña activa, temporada).

### 5.6 La puerta de calidad de cada mensaje

Igual que en Chief, dos niveles, y el segundo con rúbrica en tabla:

1. **Pre-vuelo, sin tokens**: placeholders, longitud por paso, lista
   de palabras prohibidas en español (sinergia, disruptivo, apalancar,
   quedo a tus órdenes, propuesta de valor), muletillas de IA, guiones
   largos, mayúsculas sostenidas, una sola pregunta de cierre, ninguna
   cifra fuera de `claims`.
2. **Juez con LLM**, cuatro dimensiones: relevancia (usa la señal y el
   ángulo del día), calidad (suena a persona), estructura (primera
   frase sobre ellos, una pregunta, sin repetir el toque anterior) y
   voz (coincide con el perfil del creador). Umbral por paso, banda
   muerta, hasta cinco regeneraciones con pistas cerradas (más corto,
   más específico, otro ángulo, otra señal, suavizar, añadir prueba),
   y «enviar el mejor» si alguno supera el mínimo.
3. **Disparadores de riesgo** que fuerzan revisión humana: cifra sin
   origen, marca inventada como cliente, urgencia falsa, tono de
   presión, mención de competidor de la marca, falta de divulgación
   cuando aplica.
4. **Revisión humana**: obligatoria por defecto (`outbound_policy`),
   con calentamiento por tipo de paso: los primeros diez toques de
   cada tipo pasan por la bandeja de aprobación; después, solo los que
   el juez marque.

### 5.7 Qué pasa cuando la marca responde

El webhook de mensajes nuevos de Unipile y la lectura del hilo de Gmail
llevan la respuesta a `outbound_message`. Un clasificador barato le
pone intención. Interesado: se cancelan los toques pendientes, el deal
pasa a «En conversación» y la siguiente acción es «Responder hoy».
Ahora no: enfriamiento de noventa días y aviso. Fuera de oficina:
retomar en la fecha. Baja: `contact.opted_out` de la ficha en el
workspace que recibió la respuesta, y ese workspace no vuelve a
escribirle (VEN-10; la lista global `contact_suppression` es solo
para una baja que la plataforma verifica: el enlace de baja, un rebote
duro o una queja, 0029 §1). En un correo, la baja la tiene que pedir la
ficha: si la escribe un tercero en copia, la cadencia se detiene y una
persona decide. Referido: se crea el contacto y se propone enrolarlo.
Nada queda pausado para siempre.

---

## 6. Las historias nuevas de Ventas

Las ocho de hoy (VEN-1 a VEN-8) se quedan. VEN-6, el pitch, se
absorbe en VEN-12. Se agregan ocho:

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| VEN-9 | **Canales de outreach.** Migración `0037_outreach` (tablas de la sección 5.2), conector de Unipile con hosted auth y webhook firmado para LinkedIn e Instagram, OAuth de Google con `gmail.send` y `gmail.modify`, pantalla de canales con estado, límites y keepalive diario. | L | CIM-2, CIM-3 | Un creador conecta su Gmail y su LinkedIn; el token de Google se refresca solo; una cuenta caída se ve en rojo con el botón de reconectar. |
| VEN-10 | **Motor de cadencias.** Pasos normalizados, enrolamiento, cola en `outbound_touch` con reclamo atómico, despachador por canal con interfaz común, días hábiles y zona horaria del workspace, límites diarios y semanales, reintentos con espera creciente, interruptor de apagado, cancelación al responder con relectura del estado antes de enviar. | L | VEN-9, CON-2 | Una secuencia de tres pasos con plantillas fijas se ejecuta sola contra un buzón de prueba; una respuesta cancela lo pendiente; el límite diario reprograma al día siguiente. |
| VEN-11 | **Perfil comercial del creador.** Cálculo del perfil de la sección 5.4 y su pantalla; narrativa con afirmaciones enlazadas. | M | CON-6, COT-1 | Con el seed, el perfil muestra los cinco mejores videos con sus cifras y cada cifra de la narrativa lleva a su origen. |
| VEN-12 | **Generación con afirmaciones trazables.** El generador de la sección 5.3 y la puerta de calidad de la 5.6: prompt con perfil, señal, ángulo del día y toques enviados; pre-vuelo, juez con rúbrica en tabla, regeneración con pistas, riesgos. | L | VEN-10, VEN-11 | Un mensaje con una cifra sin origen no pasa; dos marcas del mismo nicho reciben correos con similitud menor de 0,65; el juez registra nota, tokens y costo. |
| VEN-13 | **Recomendador de cadencia.** La sección 5.5: secuencia propuesta con guía por paso, plantillas por nicho y señal, línea de tiempo editable. | M | VEN-12 | Desde una señal de «campaña activa», el creador obtiene una secuencia de seis pasos con guía y la activa en dos clics. |
| VEN-14 | **Bandeja de aprobación y bandeja unificada.** Aprobar, editar o regenerar lo propuesto; hilos de correo, LinkedIn e Instagram en un solo lugar; clasificación de intención de la sección 5.7 y su efecto en el deal. | L | VEN-12 | Un mensaje retenido se aprueba desde la bandeja y sale; una respuesta «me interesa» mueve el deal y aparece en la bandeja con la conversación completa. |
| VEN-15 | **Entregabilidad y cumplimiento.** Pie de baja con página pública, cabecera `List-Unsubscribe` de un clic, rebotes asíncronos, calentamiento progresivo por cuenta, baja respetada en todos los canales, alertas diarias por correo (rebotes, cero envíos, cola atascada, cuenta caída). | M | VEN-10 | Un clic en el enlace de baja marca al contacto y cancela todo; un rebote marca el correo inválido; el día siguiente llega el resumen de salud. |
| VEN-16 | **Actividad y métricas de outreach.** Cola visible con reintento por tipo, uso por canal con límite blando y duro, embudo por paso (enviados, abiertos, respondidos, positivos), vista de flujo de la cadencia. | M | VEN-10 | Con una semana de envíos de prueba, el embudo cuadra con `outbound_touch` fila a fila. |

Tamaños: las ocho nuevas suman 28 a 31 días de trabajo estimado. Con
las ocho existentes, Ventas completo son 48 a 55 días de una persona.
Es el módulo más grande del producto, y por eso conviene construirlo
con agentes en paralelo, con la misma puerta de calidad de 9,5.

## 7. Cómo entra en el plan por fases

Ventas va después de los cimientos y en paralelo con Cotizar, porque
comparte con él la mitad de sus entradas.

| Fase | Piezas (un agente cada una) | Depende de |
|---|---|---|
| **Ventas A · CRM** | `crm` (VEN-1 a VEN-5: empresas, radar manual, pipeline, seguimientos, ficha) | Fase 1 de cimientos |
| **Ventas B · tubería** | `canales` (VEN-9) · `motor` (VEN-10) · `entregabilidad` (VEN-15) | Ventas A, el worker de Nicolás (CON-2) |
| **Ventas C · inteligencia** | `perfil` (VEN-11) · `generacion` (VEN-12) · `recomendador` (VEN-13) | Ventas B, la línea base de Nicolás (CON-6), el tarifario (COT-1) |
| **Ventas D · operación** | `bandejas` (VEN-14) · `metricas` (VEN-16) · `cierre` (VEN-7, VEN-8) | Ventas C |

Dentro de cada fase las piezas no comparten archivos: `canales`
escribe `packages/connectors/{unipile,gmail}.ts` y
`app/(app)/ventas/canales/`; `motor` escribe
`apps/worker/src/jobs/ventas/` y `queries/ventas.ts`; `entregabilidad`
escribe las páginas públicas de baja y el job de alertas. La
migración (`0037_outreach`) la escribe `canales` en su primer día y las demás
piezas la consumen.

Referencias de interfaz para los agentes, además de las de Chief:
**Lemlist** y **Instantly** para la línea de tiempo de la secuencia y
el calentamiento por cuenta; **Superhuman** y **Front** para la
bandeja unificada; **Linear** para la bandeja de aprobación (una fila,
teclado, acciones inmediatas); **Stripe Radar** para explicar por qué
un mensaje quedó retenido.

Cuando Rasheed confirme el alcance, las piezas se añaden al catálogo
del workflow `rasheed-fase-1` como fases 3 a 6, con los mismos
revisores técnico y de producto y el mismo umbral.

## 8. Decisiones que necesita tomar Rasheed

1. **Cuenta y plan de Unipile.** Es el costo variable del módulo y
   hay que abrirla para poder probar. Una cuenta de LinkedIn y una de
   Instagram de prueba, propias, para el desarrollo.
2. **Correo desde el Gmail del creador o desde un dominio nuestro.**
   Propuesta: el Gmail del creador en el MVP, con los límites de
   calentamiento de la sección 5.1. Un dominio propio de la plataforma
   con SPF, DKIM y DMARC es fase 2 y exige reputación que hoy no
   tenemos. Esto vuelve prescindible la bandera `outbound_send` global:
   se enciende por workspace cuando hay un canal conectado y una
   política aceptada.
3. **Instagram en el MVP o no.** Propuesta: se construye el conector
   porque es barato con Unipile, pero queda apagado por defecto y se
   enciende por workspace. El canal principal es el correo.
4. **Presupuesto de LLM por workspace.** Chief gasta hasta treinta
   dólares al día en el juez para una sola organización. Propuesta:
   un tope diario por workspace en `outbound_policy`, con el juez en
   un modelo pequeño para el pre-vuelo y uno grande solo para la nota.
5. **Divulgación y cumplimiento.** Un creador que escribe a marcas en
   Colombia entra en habeas data; si escribe a Estados Unidos o
   Europa, en CAN-SPAM y GDPR. Propuesta: pie de baja y dirección
   postal del workspace obligatorios desde el primer envío, y la
   `source` del contacto siempre visible en el mensaje retenido.
6. **Alcance de la baja por enlace (VEN-15).** El «terminado cuando»
   decía «un clic en el enlace de baja marca al contacto y cancela
   todo». Se entrega: el clic da de baja con **quien envió ese correo, en
   todos sus canales** (su ficha queda de baja —la propia con
   `contact.opted_out`, la compartida porque la ficha de ese espacio suma
   su fila de `outbound_workspace_optout`— y se cancela todo lo suyo), y
   **nunca en toda la plataforma**. Por qué: sin sesión nadie sabe quién
   pulsa, y la baja global por enlace era una vía de sabotaje entre
   inquilinos que ninguna confirmación cierra (rondas 3 y 4: un segundo
   espacio sin miembros en común; la revisión mostró que una sola persona
   lo fabrica con dos registros gratis). La ley pide la baja con quien
   envía, no con todos. La lista de toda la plataforma
   (`contact_suppression`) se llena con una respuesta de baja verificada
   (VEN-14) o un administrador. **Estado (25 de septiembre): implementado
   así como supuesto declarado**, igual que las decisiones 1 a 5 (el
   workflow avanza con la propuesta y Rasheed puede revertirla). El
   «terminado cuando» de VEN-15 en `backlog.ts` conserva la frase
   original y dice el cambio del criterio al lado, como COT-1. **Si
   Rasheed lo rechaza**, volver a la baja global al primer clic es una
   línea en `public_optout` (0038 §8.2, el `INSERT` en
   `contact_suppression` y el alcance de los `UPDATE`) más devolverle a
   `mc_public_share` ese `INSERT`; las pruebas de sabotaje de
   `entregabilidad.test.ts` dicen qué se pierde.
7. **El token de baja: opaco, no firmado (VEN-15).** La pieza pedía un
   «token de baja firmado por contacto y workspace». Se entrega un token
   opaco (32 bytes al azar) que la base reconoce por su sha256 en
   `outbound_optout_link`, donde el despachador guarda el contacto y el
   workspace al reclamar el envío: el enlace queda atado a los dos igual
   que con una firma, y además no lleva ningún id dentro (un enlace
   reenviado no enseña a quién ni desde dónde), no depende de un secreto
   (un `OUTREACH_OPTOUT_SECRET` mal configurado o rotado habría apagado
   la baja de toda la plataforma, y la ley pide que el enlace funcione al
   menos 30 días), y es la misma forma que ya genera el despachador de
   VEN-10. **Estado: supuesto declarado, como la 6**, con el cambio del
   criterio escrito junto al «terminado cuando». Si Rasheed prefiere la
   firma, `createOptoutToken` (`@mc/core/outreach/unsubscribe`) es el único
   sitio que la genera; la base seguiría buscando por el sha256.
8. **La plantilla recomendada contra la política por defecto**
   (VEN-10). El motor ya aplica «Mensajes por marca» (4) y «Días entre
   mensajes» (3). La plantilla de §5.3 manda cinco mensajes a dos días
   hábiles: con esos valores se estira y el quinto no sale. Propuesta:
   dejar la política como está (es la conservadora) y recortar la
   plantilla a cuatro mensajes separados tres días, o bajar la
   separación por defecto a dos días.

## 9. Los errores de Chief que no vamos a repetir

Están en la auditoría de su equipo y en el código. Cada uno tiene
dueño aquí:

| Lo que pasa en Chief | Cómo queda aquí | Historia |
|---|---|---|
| El mensaje puede salir después de que el contacto respondió (dos crones sin coordinación) | El despachador relee el enrolamiento en la transacción del envío; una respuesta detiene a la persona en todas sus secuencias y pausa a las demás personas de su marca (0054); el webhook de Unipile llega en segundos | VEN-10 |
| Un contacto que responde queda pausado para siempre, incluso por un «fuera de la oficina» | Clasificación de intención con fecha de retorno | VEN-14 |
| «Como te comenté el martes» sobre un mensaje que nunca salió | Toques anteriores leídos de `status = 'sent'` | VEN-12 |
| Los pasos de LinkedIn ignoran «no contactar» | La baja se comprueba por contacto en todos los canales, en el despachador | VEN-10 |
| Sin reintentos: un fallo de red mata el paso y avanza | `attempt_count` y `next_retry_at` con espera creciente | VEN-10 |
| Cuentas de canal sin organización; la conexión puede tomar la cuenta de otro | `workspace_id`, RLS y estado firmado en la hosted auth | VEN-9 |
| El webhook de LinkedIn no valida firma: cualquiera puede pausar cadencias | Secreto compartido y verificación en el webhook | VEN-9 |
| `In-Reply-To` con el id del hilo de Gmail en vez del `Message-ID` | Se guarda y se usa el `Message-ID` real | VEN-9 |
| El refresh token de Google en cuatro sitios; el keepalive deja uno caducado | Una fila por concesión, token en el vault | VEN-9 |
| Desconectar una cuenta la deja viva en el proveedor, cobrando y recibiendo avisos | Desconectar la deja pendiente de soltar (0040) y `sales.channels_release` revoca el permiso de Google o borra la cuenta y sus avisos en Unipile, sin tocar lo que siga vivo en otro espacio | VEN-9 |
| Topes por canal que solo miran el techo del proveedor | La vista `outreach_channel_account_limits` (0040): el máximo de cada cuenta es el menor entre la política del espacio y el proveedor (500 en un Gmail personal) | VEN-9 |
| Un envío que falla por red se reintenta a ciegas y la marca recibe el mensaje dos veces | Los POST que mandan algo a una persona (correo, DM, invitación, comentario, reacción) no se reintentan dentro del conector (`idempotent: false`): el error sube como `transient` y el despachador decide tras mirar el hilo | VEN-9 · VEN-10 |
| Todos los DM del creador (amigos, fans) entran a la base y al clasificador | Una respuesta solo se guarda si es de un toque `sent` de ESA cuenta (`outbound_touch.channel_account_id`, 0041): por su hilo o, en LinkedIn e Instagram, porque quien escribe es a quien se le envió (`recipient_address` = su provider_id: la invitación aceptada contesta en un chat nuevo); lo demás se ignora sin guardar el cuerpo | VEN-9 |
| El DM que acabamos de enviar vuelve por el aviso de mensajes y entra como respuesta: la cadencia se detiene sola | Es eco si el aviso trae `account_info.user_id` = quien escribe **o** si quien escribe es la identidad de la cuenta (`provider_identity`, 0042); un mensaje sin remitente se descarta antes que arriesgar la cadencia | VEN-9 |
| La baja pedida al aceptar una invitación de LinkedIn se pierde: la respuesta llega en un chat que no es el del toque | El segundo paso de arriba la reconoce, da de baja la ficha (código `reply_optout:linkedin` en `contact.opted_out_code`, 0043) y cancela lo pendiente en todos los canales | VEN-9 |
| Soltar una cuenta y reconectarla a la vez deja un permiso revocado en una fila «Conectado» | El job reclama la fila antes de hablar con el proveedor (`release_claimed_at`, 0041) y la conexión responde «espera un minuto» mientras dure; una fila desconectada no presta su ref del vault | VEN-9 |
| El mismo LinkedIn conectado dos veces con dos account_id (cada hosted auth estrena uno): topes sumados y doble cobro | `provider_identity` (connection_params.im.id) único entre las filas vivas de todos los espacios (0042): conectado aquí → la cuenta nueva se borra; caído → su fila adopta la nueva; vivo en otro espacio → «ocupada» | VEN-9 |
| Una hosted auth que termina bien en Unipile pero no se conecta aquí (canal equivocado, perfil ocupado, doble clic) deja una cuenta huérfana cobrando | La web la borra en Unipile si nadie la usa (`in_use` de outreach_channel_connect, 0042); si el borrado falla, el keepalive concilia `listAccounts` contra la base y borra las cuentas de NUESTRA hosted auth sin fila y con más de un día | VEN-9 |
| El aviso de cuenta creada confía en el account_id del cuerpo | Al crear, el `name` de la cuenta (que Unipile guarda tal cual) tiene que ser un estado nuestro con el MISMO nonce y espacio que el del aviso, y la cuenta tiene que haber nacido después de firmarlo; al reconectar, tiene que ser la que se firmó en él. Con un estado válido propio y el account_id de una cuenta ajena del tenant no se liga nada | VEN-9 |
| Un formulario de otra página puede empezar conexiones (crear pendientes y enlaces de hosted auth), sobre todo en modo demo, sin sesión | Los dos inicios por POST rechazan con 403 un `Origin` que no es el de la app ni el de la petición, o un `Sec-Fetch-Site` distinto de `same-origin` | VEN-9 |
| Se ofrece conectar un canal que el espacio no usa, y el proveedor lo cobra cada mes | `outbound_policy.allowed_channels` nace sin Instagram (0045); la fila de un canal fuera de la lista dice «Apagado en este espacio» con el botón deshabilitado, y el inicio lo rechaza también en el servidor | VEN-9 |
| Una respuesta de Outlook en windows-1252 llega con caracteres rotos; una solo en HTML, vacía; un rebote de otro servidor, sin destinatario | El cuerpo se decodifica con el charset de su parte, sin text/plain se lee el HTML sin la cita (o el snippet), y `Final-Recipient` se busca en la parte `message/delivery-status` del DSN | VEN-9 · VEN-15 |
| «No me escribas por LinkedIn, escríbeme a partnerships@…» da de baja en todos los canales | Con un correo o un «escríbeme» en la misma respuesta no se marca la baja: queda para el clasificador; y la baja se lee sin la cita ni la firma | VEN-9 · VEN-14 |
| Una concesión de Google canjeada y deshecha se queda viva en la cuenta de la persona | Se revoca si nadie usa ese buzón; si vive en otro espacio, NO (revocar tumbaría la concesión entera, también la de ese espacio) | VEN-9 |
| Cualquier miembro del espacio conecta o suelta el buzón de la creadora | `PUEDEN_GESTIONAR_CANALES` (owner, admin) en el servidor, en las tres acciones y en los dos inicios; la pantalla no ofrece los botones a los demás | VEN-9 |
| Sin `List-Unsubscribe`, sin pie de baja, sin rebotes asíncronos | VEN-15 completa | VEN-15 |
| Un `owner_id` escrito a mano en el validador de similitud | Filtro por workspace | VEN-12 |
| Ventana 09:00–16:59 en UTC en vez de la zona de la cadencia | Zona del workspace, una sola implementación en `core` | VEN-10 |
| Métricas de LinkedIn siempre en cero por un valor de estado que viola el `CHECK` | Las vistas se prueban contra datos reales en el CI | VEN-16 |
| Tres listas de variables de plantilla distintas y un renderizador muerto | Un solo renderizador en `core`, con pruebas | VEN-12 |
| Envíos masivos en bucles del navegador con tres segundos de espera | Todo envío pasa por la cola del worker | VEN-10 |
| Aprobación por WhatsApp que caduca a las cuatro horas sin escalar | Bandeja en la app, sin caducidad; el toque espera | VEN-14 |

### 9.1 Los avisos de Unipile: uno por cuenta, y el plan B

Cada cuenta conectada da de alta DOS avisos en Unipile (`messaging` y
`account_status`) con `account_ids` = esa cuenta y dos cabeceras
nuestras: el secreto compartido y la ruta firmada (workspace y fila).
Así el webhook sabe a qué espacio va el aviso sin buscar entre todos
los espacios y sin una función que cruce workspaces. Son 2N avisos
para N cuentas.

**El límite.** Unipile no publica un techo de avisos por cliente en
su documentación (leída el 23-sep-2026); su soporte habla de «cientos»
como uso normal. Con cientos de creadores podemos acercarnos. Lo que
ya está:

- Un alta que falla deja la cuenta conectada con el código
  `webhooks_missing`: la pantalla ofrece «Volver a intentar» (vuelve a
  dar de alta los avisos sin pasar por la hosted auth) y el keepalive
  diario lo reintenta solo para toda cuenta conectada con menos de dos
  avisos. Ninguna cuenta se queda sorda sin que nada lo intente.
- Al desconectar, `sales.channels_release` borra los avisos de la
  cuenta: el número de avisos vivos es el de cuentas conectadas, no el
  de cuentas que alguna vez lo estuvieron.

**Rotar el secreto sin perder avisos.** Cada aviso lleva
UNIPILE_WEBHOOK_SECRET en su cabecera, y la fila guarda la HUELLA del
secreto con el que se dio de alta (`provider_webhook_secret_fp`, 0042).
Para rotarlo (se filtró, o toca por calendario):

1. En la web y en el worker: `UNIPILE_WEBHOOK_SECRET_PREVIOUS` = el
   actual, y `UNIPILE_WEBHOOK_SECRET` = uno nuevo
   (`openssl rand -base64 32`). Desplegar los dos. Desde ahí la web
   acepta los dos secretos (comparados en tiempo constante): ningún
   aviso responde 401.
2. El keepalive (cada hora, por lotes) ve que la huella de cada cuenta
   conectada no es la del secreto nuevo: da de alta sus dos avisos con
   el nuevo y, si salen, borra los viejos en Unipile. Si falla, la
   cuenta conserva los viejos (siguen valiendo por el paso 1) y se
   reintenta en la corrida siguiente.
3. Cuando esta consulta devuelve cero, se borra
   `UNIPILE_WEBHOOK_SECRET_PREVIOUS` de los dos y se despliega:

   ```sql
   select count(*) from outreach_channel_account
    where provider = 'unipile' and status = 'connected'
      and provider_webhook_secret_fp is distinct from '<huella del nuevo>';
   ```

   (la huella: `webhookSecretFingerprint(secreto)` de @mc/connectors).

**El keepalive, por lotes.** Corre cada hora y toma, por proveedor, las
cuentas vivas que no se comprobaron en veinte horas
(`keepalive_checked_at`, 0042), de la más vieja a la más nueva, 200
como mucho y cuatro a la vez. Si el job se queda sin tiempo deja de
tomar cuentas y las que quedan van primero en la hora siguiente: cada
cuenta se mira una vez al día aunque haya miles.

**El plan B**, si Unipile pone un techo o lo alcanzamos: UN aviso
global por fuente (sin `account_ids`), con el secreto compartido y sin
ruta firmada. El webhook, tras validar el secreto, resuelve
`account_id` → fila por una función `SECURITY DEFINER` (como las de
0039) que devuelve SOLO el workspace y el id de la fila viva con ese
`provider_account_id` (el índice global de cuentas vivas ya garantiza
que es una), y con eso abre la transacción del espacio. Pasar a ese
modo es una migración (la función) y un cambio en `aviso.ts`; las
cuentas existentes se migran borrando sus avisos por cuenta.

### 9.2 Lo que la pantalla de canales le dice al creador

- **Nunca el texto de un proveedor, y nunca una frase en la base.** En
  `last_error` solo van códigos (desde 0044, un `CHECK` con la forma
  `^[a-z_]+(:[A-Z_]+)?$` lo impone a todos los roles; el seed de la demo
  también siembra un código) (`CHANNEL_ERROR_CODES` de `@mc/db`:
  `cancelled`, `provider_error`, `gmail_revoked`, `transient`…, y
  `unipile_status:<X>` para lo que Unipile dijo de la sesión), los
  escriba la web o el keepalive. La pantalla los traduce al pintar
  (`_lib/filas.ts` con `ventas/canales/messages.ts`), con el nombre del
  servicio («No pudimos conectar con Instagram…»), nunca «el proveedor»
  ni «Unipile»; así otro idioma del espacio no hereda un español
  congelado. Un código que la pantalla no conoce sale como una frase
  genérica, nunca crudo. Lo único con frase es el aviso de la campana
  (la tabla `notification` es de frases), de `@mc/core`. El `detail` de
  Unipile o el `message` de Google, en inglés, quedan en
  `api_call_log.error_message`.
- **Tampoco en la ficha del contacto.** Una baja pedida al responder
  queda como código en `contact.opted_out_code` (0043:
  `reply_optout:<canal>`), y la ficha de Ventas lo traduce. La columna
  `opted_out_reason` sigue siendo del texto de la persona (el «Motivo»
  que escribe al registrar la baja a mano) y de las bajas de 0026 y 0037.
- **Un motivo de un intento caduca.** «Cancelaste la autorización» o
  «Revisa el usuario y la contraseña» solo se enseñan si son de las
  últimas 24 horas; los fallos pasajeros del servicio («No pudimos
  conectar con Instagram ahora mismo», «No pudimos comprobar la
  cuenta»), solo durante una hora (`lastErrorFresh`): un fallo de un
  minuto no deja la fila en rojo todo el día. El keepalive borra el
  intento a los 7 días.
- **Desconectar a propósito no arrastra la caída.** `disconnectChannelAccount`
  borra `last_error`, y la fila «Sin conectar» solo enseña el motivo de
  un INTENTO que no terminó (una fila que nunca tuvo cuenta), nunca el de
  una cuenta que la persona quitó.
- **La frase genérica depende del estado.** Un código que la pantalla no
  conoce dice «Algo falló con esta cuenta. Si no se arregla sola, vuelve
  a conectarla.» solo en una cuenta conectada o con error; con la cuenta
  marcada para reconectar dice «No pudimos usar esta cuenta. Vuelve a
  conectarla.», que no contradice al botón.
- **«Comprobada» solo en las conectadas.** En una caída, `last_ok_at` es
  la última vez que funcionó: la línea dice «Funcionó por última vez
  hace 3 días».
- **Sin «outreach» en pantalla.** La persona lee «envíos automáticos a
  marcas» y «canales para escribir a marcas»; la palabra queda para el
  código y los documentos. Desconectar avisa que se detienen los envíos
  pendientes «desde esta cuenta» (los de otra cuenta del canal siguen).
- **Los nombres de variables, solo a quien administra y solo en
  desarrollo.** El bloque plegado de lo que falta en el servidor no se
  enseña en producción (tampoco en una demo pública con la base
  embebida) ni a quien no gestiona los canales.
- **No todo es un error.** Cancelar en Google va en texto neutro, en la
  fila y en el aviso de arriba; «LinkedIn todavía no está disponible en
  On Cue» (sin llaves) va en ámbar y dice lo mismo en el aviso y en la
  fila. En rojo, solo lo que falló.
- **El nombre de la cuenta es el de la persona.** Sale de
  `connection_params.im` de Unipile, nunca del `name` de la cuenta (con
  la hosted auth, Unipile guarda ahí el estado firmado que le mandamos).
- **«Conectar otra cuenta»** solo cuando el canal ya tiene una cuenta
  conectada, junto al título de la fila (como «Add» en Vercel). En el
  correo pide a Google elegir cuenta (`select_account`); «Reconectar» le
  propone el buzón caído (`login_hint`).
- **Desconectar vive aparte.** Al final de «Límites y cuenta», tras un
  separador y en tono de peligro: lo destructivo no se confunde con lo
  constructivo, tampoco a 400 px.
- **Cada máximo dice quién lo fija**, el diario y el semanal por igual:
  «Máximo 140 (política del espacio)», «Máximo 200 (LinkedIn)»
  (`daily_limited_by` y `weekly_limited_by` de la vista, 0045).
- **Un canal apagado en el espacio** (fuera de `allowed_channels`: así
  nace Instagram) sale «Apagado en este espacio», con el botón
  deshabilitado y el motivo en su nombre accesible; una cuenta que ya
  estaba conectada, «En pausa».
- **De vuelta de Unipile sin confirmación.** Si el aviso de cuenta
  creada no llega en el minuto que la pantalla se refresca sola, el
  aviso cambia a «LinkedIn tarda en confirmar…» y la fila deja de pedir
  que termine algo que ya terminó.
- **Roles.** Solo `owner` y `admin` conectan, desconectan o cambian
  topes; los demás ven la pantalla con una frase que lo explica.
- **Una pendiente por creador y canal.** Pulsar «Conectar» otra vez
  borra el intento que quedó a medias, y la fila muestra siempre el
  intento más reciente: nunca «Conectando» debajo de un «Cancelaste».
- **La vuelta fallida de Unipile** (contraseña mala, código de
  verificación sin resolver) pasa por `GET /ventas/canales/conectar
  ?fallo=<nonce>&canal=…`: la pendiente de ese intento dice qué revisar
  y deja de decir «Conectando» durante 24 horas.
- **Sin llaves**, la fila dice que el canal no está disponible, sin
  prometer un aviso que no existe; con los tres canales así, un solo
  aviso arriba de la lista.

### 9.3 La sesión real que falta grabar (condición de salida a clientes)

Todo lo anterior está probado contra dobles (`FakeGmail`, `FakeUnipile`)
y contra fixtures armados de la documentación de Google y de Unipile
(`meta.source = 'docs'`). Eso prueba NUESTRA lógica, no que el servicio
responda así. Tres cosas solo se saben con el servicio de verdad: si
Unipile acepta y devuelve sin cortar el `name` de la hosted auth (el
estado firmado: binario y cifrado, ~180 caracteres, ~210 al reconectar;
la versión 1 medía ~500 y se acortó para dejarle margen a un recorte),
la forma real del aviso de
`notify_url` y del de mensajes (en especial `sender.attendee_provider_id`
y `account_info`, de los que dependen casar la invitación aceptada y
reconocer el eco), y la del canje de Google. Por eso VEN-9 queda
**bloqueada** hasta grabarlas.

Qué hace falta (Rasheed; ninguna llave se inventa ni pasa por un chat):

1. Un cliente OAuth de Google en modo **Prueba** con la Gmail API, los
   alcances `gmail.send`, `gmail.modify` y `userinfo.email`, un buzón de
   pruebas como usuario de prueba y dos URI de redirección:
   `<APP_URL>/api/oauth/google/callback` y `http://localhost:8788/callback`.
2. Una cuenta de pruebas de Unipile (tiene periodo gratuito) y un
   LinkedIn de pruebas.
3. Las llaves en `platform/.env.local` (`GOOGLE_CLIENT_ID`,
   `GOOGLE_CLIENT_SECRET`, `UNIPILE_DSN`, `UNIPILE_ACCESS_TOKEN`,
   `UNIPILE_WEBHOOK_SECRET`, más `TOKEN_ENCRYPTION_KEY` de `make
   db.unlock`) y un túnel público hacia la web local.

La sesión, con `packages/connectors/scripts/record-outreach.ts`:

```bash
cd platform
pnpm --filter @mc/web dev --port 3100          # APP_URL = la URL del túnel
pnpm --filter @mc/connectors record:outreach -- avisos --port 8787 --forward http://localhost:3100   # el túnel apunta al 8787
pnpm --filter @mc/connectors record:outreach -- google --port 8788 --send-to <buzón de pruebas>
# En /ventas/canales: conectar el Gmail (el camino de la web) y el LinkedIn.
# Escribirle al LinkedIn desde otra cuenta, contestar desde él, y cerrar su sesión en LinkedIn.
pnpm --filter @mc/connectors record:outreach -- unipile --account <account_id> --app-url <túnel>
```

Deja `fixtures/<proveedor>/<endpoint>.recorded.json` (y
`fixtures/unipile/webhooks/<tipo>.recorded.json` con lo que respondió
la web), anonimizados por `anonymizeOutreach`: sin tokens, sin correos
reales, sin textos de personas, con los ids de LinkedIn en un hash
estable. Después:

- `pnpm --filter @mc/connectors test` pasa cada grabación por el
  normalizador de producción (`outreach-grabacion.test.ts`): la cuenta
  trae `connection_params.im.id` y `created_at`, el aviso de cuenta
  creada trae el estado entero y la web lo verificó (`appStatus` 200),
  el de mensajes trae quién escribe, el canje trae `refresh_token` y los
  dos alcances, el Message-ID tiene su forma. Si algo no casa, se ajusta
  `parseUnipileWebhook`, `normalizeUnipileAccount` o `normalizeGmailMessage`
  a lo que llegó de verdad.
- VEN-9 pasa a «hecho» en `apps/web/content/backlog.ts` con la fecha de
  la grabación en su nota. `ventas/canales/_lib/grabados.test.ts` no lo
  deja antes: exige las once de `REQUIRED_OUTREACH_RECORDINGS`.

### 9.4 Decisiones y cruces de carpeta

La pieza de canales tocó, a propósito y de forma aditiva, archivos que
no son de Ventas. Ninguno cambia el comportamiento de lo que ya estaba:

| Archivo | Dueño | Qué se agregó | Por qué es aditivo |
|---|---|---|---|
| `packages/connectors/src/unipile.ts`, `gmail.ts`, `outreach/*`, `testing/fake-*.ts`, `testing/grabacion.ts`, `scripts/record-outreach.ts`, `fixtures/gmail/`, `fixtures/unipile/` | Nicolás (carpeta) | Los conectores de los canales de Ventas | Asignados a VEN-9 en la tarea; archivos nuevos, ninguno reemplaza uno de Conexiones |
| `packages/connectors/src/crypto/sealed-cookie.ts` | Nicolás (Conexiones) | `openWithAnyKey` y su tipo `OpenedWithAnyKey`: abre un sello probando cada llave del llavero y dice cuál casó | `openSealedValue` y el sello de la cookie de CON-3 quedan igual; la función nueva solo la usa la ruta de los avisos (rotar `TOKEN_ENCRYPTION_KEY` no invalida los avisos de Unipile, que viven años). El estado de canal tiene desde la ronda 5 su propio formato binario (outreach/state.ts), con el mismo recorrido de llaves |
| `packages/connectors/src/index.ts`, `package.json` | Nicolás | Exporta los módulos de outreach; `exports` con el subpath `./testing` | `.` sigue apuntando a `src/index.ts`; el subpath aparta los dobles del barril de producción |
| `packages/connectors/eslint.config.mjs`, `apps/worker/eslint.config.mjs` | Nicolás | Un bloque `no-restricted-imports` que prohíbe `@mc/connectors/testing` fuera de las pruebas | Solo añade una regla; las demás reglas y archivos no cambian. Evita que un job o una pantalla conecte canales falsos sin aviso |
| `apps/web/lib/format.ts` | compartido | `formatRelativeSeconds` y `f.relative` («hace 2 horas», con Intl y el locale del espacio) | Funciones nuevas; las existentes no cambian. La usa la línea «Comprobada hace…» / «Funcionó por última vez…» |
| `apps/web/content/backlog.ts` | compartido | El estado y la nota de VEN-9 | Lo pide el protocolo de cada ronda |

