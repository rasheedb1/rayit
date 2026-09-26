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
| Funciones `increment_if_under_cap` e `increment_weekly_*` por `action_type` | Migración `0046_outreach.sql`, mismas funciones por workspace | Se corrige el bloqueo: el `FOR UPDATE` de la semanal bloquea la fila de hoy pero cuenta la semana entera |
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
| **Instagram DM** | Unipile con usuario y contraseña; reto 2FA de cinco minutos | Mensaje directo, leer bandeja | 100 acciones al día, 10 por hora; empezar bajo | **Opcional, apagado por defecto** (`outbound_policy.allowed_channels` nace con correo y LinkedIn, canales_instagram_apagado_y_semana). Se enciende por workspace cuando la marca no tiene otro contacto |
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

### 5.2 El modelo de datos: migración `0046_outreach.sql` (en el plan original, «0015»)

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
`platform/db/migrations/0046_outreach.sql`: el número 0015 lo tomó
`connection_secret` y las fases 1 a 3 llegaron hasta 0045. Además de lo
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
- Antes de cada llamada, outbound.generate y outbound.review apartan su
  estimación en `outbound_llm_reservation` (0075) con un candado de
  transacción por espacio (`reserveLlmBudget`): comprobar el saldo y
  apartarlo son una sola cosa, y dos jobs a la vez ya no gastan el mismo
  saldo. Registrar la llamada (`recordOutreachLlmCall` con su
  `reservationId`) suelta la reserva en la misma transacción; una que
  nadie soltó deja de contar a los diez minutos. `outbound_llm_call`
  sigue siendo la bitácora append-only con el costo real.
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
  En 0046 daba de baja a la persona en toda la plataforma
  (`contact_suppression`, todas las fichas con esa dirección en cualquier
  workspace). **Desde entregabilidad §8 (VEN-15) vale para el workspace que envió
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
  base rechaza el reclamo entero. **Desde VEN-15 r5 (entregabilidad §8.3) es una
  sola regla con una fuente más:** `enforce_outbound_optout` mira también
  `outbound_workspace_optout` (la baja por enlace de ESE workspace, que en
  un contacto global no marca la ficha), con las mismas transiciones. Así
  que el reclamo de VEN-10 filtra además `outbound_workspace_optout` (por
  `workspace_id` y por la dirección de la ficha o la del envío) y, en
  correo, `contact.email_invalid` y los rebotes duros verificados del
  workspace (`outbound_touch_email_invalid`, entregabilidad §2). **La vuelta a la
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
  (entregabilidad §5) por el sha256 del token, sin `asWorker`), pide una
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
  `public_optout_preview(token, espacios de quien la abre)` (entregabilidad §5,
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
- **La baja por enlace vale para quien envió (entregabilidad §8; alcance cerrado
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
  rehecha en entregabilidad §8). Probado en pglite: dos espacios recién creados por
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
  `GOOGLE_OUTREACH_CLIENT_ID/SECRET`, o con el canal falso, cada cuenta sale como
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
  español; entregabilidad §4 lo dice en su `COMMENT`). Renombrarlas —`title`,
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
  la cambian 'owner' y 'admin' del espacio (entregabilidad §7: políticas
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
`outbound.replies` cada cinco, `outbound.bounces` cada treinta, 0056).
Sus migraciones son `0056_motor_cadencias.sql`, `0057_motor_ritmo.sql`,
`0058_motor_intento_sin_confirmar.sql` y `0059_respuesta_detiene_la_marca.sql`.
Lo que hace hoy, por partes:

- **Enrolar** (`enrollContacts`). Solo fichas del workspace de la
  secuencia (`contact_visible_to`, 0056 §5). Cada paso nace con su hora
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
  1` (0060). Lo prueba `packages/db/test/outreach-reclamo` contra
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
  `outbound_policy.stop_company_on_reply` (0059, encendido por defecto y
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
  (`outreach_resolve_unconfirmed`, 0058) y «No salió: enviarlo» pide
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

**Numeración (pulido r2, 26-sep-2026).** Supabase (`schema_migrations`)
tiene la serie de main hasta `0042_metricas_al_corte_desempate.sql`
(0034–0042: accesos, CAM y CON). La de integración va entera detrás, de
`0043_seguimientos.sql` a `0075_presupuesto_llm_reservas.sql`, en el
orden en que se escribió, y ninguna está aplicada en ningún sitio. Ya no
hay renumeración al integrar: el script `renumerar-outreach.sh` se borró
(su mapa movía siete de los doce archivos que chocaban y los mandaba a
números que la propia rama ya usaba). Los números de antes del pulido r2
eran: 0034–0045 → 0043–0054 (+9), 0050–0067 → 0055–0072 (+5) y
0070–0072 → 0073–0075 (+3); el código, las pruebas y este documento ya
citan los nuevos. `packages/db/test/aplicar.test.ts` («esta rama mezclada
con main no repite número») corre `listSql` sobre la unión de
`db/migrations` y las de `origin/main`, así que un choque nuevo sale en
`pnpm verificar` y no en el integrador.

**main borró `membership.role`.** `0034_access_control` (main, ya en
Supabase) la cambia por `role_id → role` y convierte los `client` en
`viewer`. Las cuatro funciones de esta serie que miran el rol eligen su
forma al aplicarse, con o sin `role_id`: `outreach_can_manage` (0055 §7:
owner, admin de agencia o mánager del creador), `membership_is_team` y
`membership_is_owner` (0060) y `outreach_can_operate` (0072: todo rol
que no sea `viewer` ni `finance`). Con eso la unión (0001–0042 de main y
0043–0075 de esta serie) se aplica entera en Postgres embebido
(comprobado el 26-sep-2026). Los fixtures de las pruebas dan de alta las
membresías con `membershipSql` (`@mc/db/test/membresia`), que también
funciona en las dos series. `make db.check` en verde no demuestra nada
del SQL de las consultas: compila las migraciones. Por eso el paso 1
corre `pnpm verificar` después de mezclar.

**Lo que hace el integrador contra Supabase** (el «terminado cuando» de
VEN-10), un comando por paso, desde `platform/`, con
`W=00000002-0000-4000-8000-000000000001` (el workspace de la demo):

1. La cola única del integrador: mezclar main, **`pnpm verificar`**
   (las pruebas del motor sobre la serie integrada; `db.check` no
   basta), `make db.check`, `make db.migrate` (aplica 0043…0075 en
   orden), `make db.guardia` y los seeds. Al resolver la mezcla de
   `packages/db/test/ventas.test.ts`, la lista de responsables del seed
   de main trae también a Andrés Pardo (mánager, 0034_access_control):
   es del equipo y cuenta.
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
8. Al mezclar con los permisos de main (ACC, `requirePermission`): añadir
   al catálogo de `@mc/core/permisos` `ventas.outreach.aprobar` y
   `ventas.outreach.politica`, abrir con `await requirePermission(...)`
   `aprobarMensaje`, `resolverIntento`, `saltarMensaje` y
   `reanudarCadencia` (ficha) y `encenderEnvio` y `apagarEnvio`
   (/ventas/politica), y añadir `ventas` a `MODULOS_CON_CONVENCION`.
   Hasta entonces las acciones de la ficha piden `puedeOperarVentas`
   (owner, admin, member) y las del interruptor `puedeCambiarLaPolitica`
   (owner, admin); en la base, `outreach_resolve_unconfirmed` exige
   `membership_is_team` (0058, pulido r1), que con la serie de main deja
   fuera al rol `viewer`.

**Pulido r1 (25-sep-2026), lo que cambió en el esquema de esta serie**
(0046, 0051, 0056 y 0058, todas sin aplicar): la web no cambia `channel`,
`provider`, `warmup_started_at` ni `last_ok_at` de una cuenta, ni la
vuelve a `pending`, ni borra una que se autenticó (sus contadores del día
cuelgan de ella); no apaga `require_optout_link`; un Gmail personal tiene
techo de 500 al día y 3.500 a la semana; un toque en `scheduled` tiene
hora; al crear un toque la web no elige `status_changed_at`; el costo del
modelo va solo en USD; `enable_outreach` pide un canal conectado; y los
días hábiles saltan los festivos del país del workspace
(`@mc/core/outreach/holidays`, Colombia 2026–2027; un país sin tabla
trabaja de lunes a viernes).

La prueba `outreach-demo.test.ts` corre los pasos 3 a 6 sobre Postgres
embebido con las mismas migraciones y el mismo seed. El 25-sep-2026
corrió también sobre la serie integrada (las 0034–0042 de main, los
seeds mezclados y la renumeración de entonces): las pruebas del motor de
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
  las forman. Cuando ningún rasgo alcanza, la pantalla y la plantilla
  describen el video sin inventarle una causa. En la demo, el seed
  `0010_demo_porque.sql` deja lo que dejaría el laboratorio de video
  tras analizar cinco videos de Laura que abren con un reto
  (`hook.type = 'challenge'`): dos de los cinco mejores (la arepa sin
  plancha y la pasta en cuatro minutos) muestran «Lo distingue» con un
  contraste de 1,7 veces (verify/0010.sql y
  `packages/db/test/perfil-comercial.test.ts` lo exigen). Lo que se lee
  de los captions sigue en `perfil-captions.ts`; si
  `creator_post_board.hook_type` existe, gana.
- **De dónde sale cada cifra**: la mediana de cada red y la de cada uno
  de los mejores listan los videos que la forman (`readBaselinePosts`:
  la regla de `creator_baseline`, y solo si cuadra con su
  `sample_size`); la demografía dice de qué informe sale y el resto del
  reparto de esa lectura. Resumen no tiene sección de demografía, así
  que no hay otra pantalla a la que enlazarla.
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
  propósito `'profile'` (migración 0066) apenas responde. Si ninguno
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
- **Historial de rondas** (lo que antes vivía en la nota de VEN-11 en
  `backlog.ts`):
  - r3: el porqué deja fuera al video que explica y la vista previa
    subraya lo que el verificador rechaza; la narrativa solo se redacta
    en español y la pantalla lo dice.
  - r4: el verificador rechaza ordinales («la segunda»), «doblé»,
    proporciones («la mayoría», «la cuarta parte»), numerales en inglés
    y cualquier número Unicode («²³», «⅔»). Los cinco mejores salen de
    todo el historial con puntaje. Enlaces y portadas se sanean al
    calcular; las portadas se leen vivas al pintar y la demo trae las
    suyas (seed 0007). El editor muestra fichas legibles (⟦115,4 mil⟧).
  - r5: el verificador rechaza la palabra de unidad que no es la de la
    cifra y las cantidades que se colaban («veintiún», «treintaitrés»,
    «un par»); portadas solo https o de la demo; cada cifra es una parada
    de Tab; una prueba ata los nombres de las redes del kit a los de
    @mc/core (unificación en `rasheed/kit-plataformas-desde-core`).
  - Pulido r1: dos cuentas en la misma red no rompen el cálculo (la de
    más seguidores lleva `seguidores-<red>`, las demás el id de su
    cuenta) y solo cuentan las cuentas autenticadas; el verificador
    rechaza lo pegado a una marca («[claim:x]k»), mira la unidad tras
    «de», «nuevos» o «más», acepta la franja de edad solo dicha como
    edad y rechaza «puesto uno» y «se cuadriplicó»; guardar exige que la
    marca de recálculo siga siendo suya; la mediana lista sus videos y
    la demografía su informe; el seed 0010 enseña el porqué en la demo.

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

**Cómo quedó (VEN-13, 25 de septiembre).**

- **El recomendador es puro** (`packages/core/src/outreach/recomendar.ts`,
  con pruebas sin base ni red). Reglas, en orden: (1) la plantilla de su
  tipo de señal y su nicho, luego la de su señal, luego una genérica,
  nunca la de otra señal; (2) el canal de cada paso: el de la plantilla
  si llega (la política lo deja, hay cuenta, aunque esté por reconectar,
  y la persona tiene dirección ahí), si no el siguiente en un orden fijo
  por tipo de paso (un directo prueba LinkedIn, Instagram y correo; un
  gesto público, la otra red o una tarea a mano), y el primer correo
  siempre abre el hilo; (3) **la política del espacio**
  (`outbound_policy`): la propuesta nace cumpliéndola (`fitToPolicy`). Si
  hay más mensajes que `max_touches_per_company`, los del medio se
  sacrifican en orden (prueba social, concepto creativo, prueba de
  desempeño) pasando a una reacción pública en su red, que no es un
  mensaje y no cuenta para el tope, o, sin red, quitándose; el primer
  mensaje y la síntesis (media kit y cotización) no se tocan. Luego los
  días se estiran para dejar `min_days_between_touches` entre mensajes,
  sin pasar del día 60. Con la política por defecto (4 y 3), la campaña
  activa del seed queda en seis pasos (día 0 comentario, 1 correo, 4
  LinkedIn, 7 respuesta, 9 reacción, 11 síntesis) y
  `checkSequenceAgainstPolicy` no marca nada; (4) la guía de la plantilla
  si el paso no cambió, una compuesta con ángulo, canal y señal si cambió,
  y la divulgación del brief en el cierre. Lo que decide va en códigos
  (`ProposalNote`, con `fitted_to_policy` para el ajuste) que la
  pantalla traduce.
- **El modelo solo redacta la guía**: `refineGuidance` recibe un
  `GuidanceWriter` (el real, con `claude-sonnet-5` y salida estructurada,
  vive en `apps/web/app/(app)/ventas/cadencias/_lib/redactor.ts`; las
  pruebas usan uno falso), valida paso a paso y se queda con la regla
  donde el texto no sirve. Sin `ANTHROPIC_API_KEY`, o con el tope diario
  gastado, no se llama. Cada llamada deja su fila en `outbound_llm_call`
  (`recommend`) con el costo de `llmCostUsd`. Al modelo no le llega nada
  de la persona a la que se escribe. Solo le llegan los pasos de
  mensaje: un comentario, una reacción o una tarea a mano
  (`TEXTLESS_STEP_TYPES`, una sola lista en `@mc/core`) conservan su guía
  de plantilla o de reglas, y lo que el modelo devolviera para ellos se
  descarta. Si la llamada se corta después de salir (tiempo de espera o
  red), `GuidanceWriterError` lleva una cota de lo que pudo cobrarse y
  también queda en `outbound_llm_call`: el tope diario no cuenta de menos.
  Reordenar la línea de tiempo recompone la guía de plantilla o del
  modelo de los pasos que cambian de puesto (`guidanceAfterMove`).
- **Tipos de señal**: `signal_source.kind` → `ads`, `marketplace` y
  `jobs` son campaña activa; `press`, lanzamiento; `season`, temporada;
  `collab`, colaboración de un competidor (nunca se nombra); lo demás,
  manual.
- **Migración `0067_recomendador_cadencias.sql`** (la generación de VEN-12 es
  0061–0065, el perfil de VEN-11 0066 y las dos de VEN-13 0067 y 0068;
  ninguna depende de la otra): `outbound_sequence.signal_id` (con su referencia
  visible) y `proposal` (la propuesta en códigos), y siete plantillas:
  lanzamiento, temporada, colaboración de un competidor, señal manual,
  cocina con campaña activa, belleza con lanzamiento y fitness con
  temporada. Son la cadencia ideal; el recomendador las ajusta a la
  política de cada espacio. Copiadas tal cual («Empezar desde una
  plantilla»), la pantalla avisa de lo que no cabe (§8, pregunta 8).
- **Consultas** en `@mc/db/queries/cadencias`; **pantallas** en
  `/ventas/cadencias` (señales con «Proponer cadencia», lista con estado,
  personas dentro y respuesta, arranque desde plantilla) y
  `/ventas/cadencias/[id]` (resumen «Día 0: … →», por qué la propuesta,
  línea de tiempo editable con arrastre o Subir/Bajar, «Proponer otra
  vez» para otra persona o para nadie, y enrolar desde un negocio).
  «Activar» enrola a la persona para la que se propuso: son los dos
  clics. Una señal tiene como mucho un borrador (proponer otra vez
  reemplaza sus pasos, con un bloqueo por señal contra el doble envío);
  duplicar copia la propuesta sin su persona, y Activar no enrola a quien
  ya está vivo en otra cadencia del espacio. Enrolar comprueba en el
  servidor que cada persona es de la marca del negocio y que el negocio
  sigue abierto. La línea de tiempo es un riel con un nodo por paso (el
  icono de su canal) y la espera entre pasos en días hábiles; el foco de
  teclado vuelve a su botón tras mover un paso o cerrar el editor.
  WhatsApp (fase 2) no se ofrece en el editor ni lo acepta la base al
  editar.
- **La regla de la edición**: con alguien enrolado, sus toques ya tienen
  día y canal, así que día, canal, orden y número de pasos se bloquean
  (`has_enrollments`) y se ofrece duplicar; guía, ángulo, texto y hora sí
  se cambian, para quien entre después. Reordenar mueve los mensajes y
  deja los días en su puesto, como Lemlist. Reordenar, añadir, quitar o
  cambiar un paso deja siempre un correo nuevo (no una respuesta) como
  primer correo, y un paso añadido nace con el primer ángulo que la
  cadencia no usa y su guía. Si los mensajes ya llegan al tope de la
  política, «Añadir paso» pone un gesto de presencia (una reacción en la
  red que llegue, o una tarea a mano) y lo dice: un mensaje de más
  nacería marcado «no sale».
- **Las reglas de quién entra, en todos los caminos**: «Activar» (y
  «Reanudar», que pasa por la misma acción) y «Enrolar desde un
  negocio» comprueban en la misma transacción que el negocio sigue
  abierto, que la persona es de su marca y que no está viva en otra
  cadencia del espacio. La propuesta nunca guarda un negocio ganado o
  perdido, y la etiqueta del botón solo dice «y escribir a X» cuando X
  de verdad va a entrar. Tras activar, el aviso lleva a la ficha de la
  empresa, donde se aprueban los mensajes retenidos.
- **Desde dónde se propone**: la portada de cadencias muestra las seis
  señales más recientes y «Ver todas las señales (N)»; la ficha de la
  empresa pone «Proponer cadencia» (o «Ver su cadencia») junto a cada
  negocio abierto que salió de una señal.
- **La guía compuesta sale de una tabla por idioma**
  (`packages/core/src/outreach/guidance-phrases.ts`): el recomendador no
  escribe frases fuera de ella y recibe el idioma del espacio. Hoy solo
  hay tabla en español, como las plantillas y los ángulos; un idioma sin
  tabla usa la española hasta que lleguen sus plantillas. El redactor
  recibe el mismo idioma en la petición (`GuidanceRequest.locale`) y su
  instrucción lo dice con la frase de la tabla (`promptLanguage`): la
  guía del modelo nunca sale en otro idioma que la de reglas.
- **Quién «llega», en todos los caminos (r4)**: una persona llega si la
  cadencia tiene un paso de mensaje (`DISPATCHABLE_STEP_TYPES`) por un
  canal que la política deja, con cuenta (aunque esté por reconectar), y
  la persona tiene dirección ahí (`reachForSequence`, `reachChannels`).
  Un comentario o una reacción públicos no cuentan. «Enrolar desde un
  negocio» solo deja marcar a quien llega («Llega por» dice solo esos
  canales; si no, «No llega por los canales de esta cadencia») y el
  servidor lo comprueba otra vez; «Activar» igual. Tras enrolar, cada
  persona dice qué le queda, con las mismas partes que «Activar»:
  mensajes programados, por revisar, por redactar, **gestos a mano**
  (la reacción y el comentario públicos, que no se redactan) y pasos
  saltados.
- **El hilo de correo y la guía, una sola regla (r4)**:
  `normalizeThread` (`packages/core/src/outreach/thread.ts`) la usan el
  recomendador y la línea de tiempo: el primer correo abre el hilo, los
  siguientes responden, salvo el cierre que ya es correo nuevo (las
  plantillas lo piden así) y el paso que la persona acaba de poner como
  correo nuevo. Cada paso guarda quién escribió su guía
  (`outbound_step.guidance_source`: plantilla, reglas, modelo o persona)
  y para qué tipo (`guidance_for_type`). Si un paso cambia de tipo
  (reordenar, quitar, añadir o el editor), la guía que no escribió la
  persona se recompone para el tipo nuevo (`guidanceAfterRetype`); la
  suya se queda y la tarjeta pide revisarla («Esta guía se escribió para
  «Correo»…»), hasta que la guarde sin cambiar el tipo. Cambiar el
  ángulo de un paso con guía automática también la recompone.
- **El creador del negocio (r4)**: el nicho y el brief son los del
  creador del negocio abierto de la señal, no la unión del espacio: en
  una agencia con varios creadores, los de otro elegirían otra plantilla,
  otra divulgación y le mandarían al modelo notas ajenas. Sin creador en
  el negocio vale el único del espacio; con varios, ni nicho ni brief y
  la nota `no_creator` lleva a asignarlo. La secuencia guarda su
  `brief_id` para el generador (VEN-12).
- **La persona por defecto (r4)** no es la que ya está viva en otra
  cadencia (Activar no la enrolaría); en «Para» se ve «· ya está en
  «X»», y si se elige igual, la nota `contact_busy` lo dice.
- **El cierre pide solo el activo que declara (r4)**: las guías de
  síntesis dicen «enlaza el media kit y, si tienes una cotización
  pública, su enlace» (o al revés en las de temporada, que declaran la
  cotización), para que quien revisa pueda vigilar lo que exigen. 0067
  corrige también la de «Marca con campaña activa» de 0046, con una
  política de actualización del catálogo solo para quien migra.
- **Las notas guardadas se leen con zod (r4)**: `ProposalNote` y la
  propuesta guardada son esquemas de `@mc/core`
  (`proposal-notes.ts`); una nota que no tiene la forma de su código se
  descarta. Las consultas viven partidas en
  `packages/db/src/queries/cadencias/` (lista, contexto, propuesta,
  pasos, edición, estado).
- **La baja del espacio antes de enrolar (r5)**: «Activar» y «Enrolar
  desde un negocio» miran la baja con la misma expresión que la etiqueta
  de la pantalla (`optedOutAmong`: la ficha, la lista global, un
  enrolamiento en baja y `outbound_workspace_optout`, el enlace de un
  correo del espacio) antes de llamar a `enrollContacts`. Si la persona
  pulsó la baja entre «Proponer» y «Activar», la cadencia se activa sin
  ella y lo dice; en un lote, esa persona sale entre las saltadas y las
  demás entran. Sin esto, el disparador de 0055 revertía la transacción
  entera y la cadencia no se podía activar nunca. Quién está viva en
  otra cadencia se pregunta en una sola consulta para todo el lote
  (`liveEnrollmentsElsewhere`).
- **Lo que hace una persona no lleva texto, en todas las capas (r5)**:
  un paso que el despachador no envía (comentario y reacción públicos,
  tarea a mano) no se redacta. La pantalla (`sinTexto`), la base
  (`TEXTLESS_STEP_TYPES`, que el recomendador, las plantillas copiadas,
  «Añadir paso» y el editor usan para dejar `generate_with_ai` en false)
  y «Activar» al contar gestos a mano usan la misma regla. 0068 afloja
  el CHECK de `outbound_step` de 0046 para que un comentario pueda
  guardarse sin generación ni texto fijo, y apaga la generación de los
  que ya había. La reacción tiene su propia guía («reacciona a su última
  publicación…; no comentes ni escribas»): comentar es otro paso. El
  canal principal de la secuencia cuenta solo los mensajes.

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

#### Cómo quedó (VEN-12, con VEN-6 dentro)

- **Un solo renderizador** en `@mc/core/outreach/render` (sustituye a
  `template.ts`): la lista canónica de variables por origen (contacto,
  empresa, señal, creador) y `templateValuesFrom`, la única traducción
  entre la base y las plantillas. Lo usan el motor, el generador y el editor.
- **Afirmaciones trazables** (`@mc/core/outreach/claims`): un
  `SalesClaim` es una cifra con su fila de origen. Las lee
  `listSalesClaims` (`@mc/db`): la mediana a 7 días fiable por red, el
  grupo mayor de edad, género y país, los cinco mejores videos frente a
  la mediana, los seguidores del último media kit, las campañas con
  resultado y las cifras de la señal del deal, cada una formateada con
  el locale del espacio. Es la lectura mínima del perfil de §5.4: cuando
  VEN-11 publique el perfil completo, esta función puede leer de él sin
  cambiar la forma. El generador escribe cada cifra con `[claim:id]`
  detrás; al guardar, las marcas salen del texto y los claims citados
  van a `outbound_touch.claims`.
- **Pre-vuelo** (`preflight.ts`, sin tokens): huecos, largo por paso (la
  rúbrica manda), palabras prohibidas y muletillas en español e inglés,
  guiones largos y punto y coma, mayúsculas sostenidas, una sola
  pregunta al cierre, sin enlace de agenda en el primer toque, y cada
  cifra con su marca, que exista, que el ángulo la deje citar y que
  diga lo mismo (5 % de redondeo: «400 mil» por 412.000). No cuentan
  como cifra las fechas, las horas, los rangos de edad, los años («en
  2026») y los conteos sueltos hasta 12 sin unidad («3 ideas»); pero un
  número seguido de un sustantivo de desempeño de una lista cerrada
  (marcas, campañas, clientes, videos, ventas, seguidores, views,
  colaboraciones…) sí es una cifra, por pequeño que sea o aunque parezca
  un año («11 marcas», «12 videos», «2000 seguidores»). Los números
  escritos con palabras también cuentan: «diez mil views», «un millón»,
  «once marcas» y los múltiplos «el doble», «el triple» (ronda 2).
- **Compuertas** (`gates.ts`): A, el asunto; B, Jaccard sobre 5-shingles
  contra los últimos 20 enviados del mismo tipo en el mismo espacio
  (0,65 directos, 0,80 correo); C, al escribir el resultado: el toque
  sigue en borrador, el turno sigue siendo del job, su cuerpo sigue
  siendo el que había cuando el job lo tomó (`base_body_md5`, 0062: si
  una persona escribió, manda lo suyo, código `edited_by_person`) y el
  mismo texto no le llegó ya a esa persona.
- **Generador y juez** (`generate.ts`, `judge.ts`, prompts en
  `outreach/prompts/*.md`) detrás de `LlmClient`: `claude-sonnet-5`
  con salida estructurada, tope de tokens por tipo de paso y sin
  pensamiento extendido. La temperatura que pedía el diseño (0,7 y 0) no
  se envía: los modelos posteriores a Opus 4.6 la rechazan con un 400
  (`temperatureFor`). Sin `ANTHROPIC_API_KEY` no se redacta nada; el
  generador y el juez falsos (`fake.ts`) son para las pruebas y la demo
  (`OUTREACH_WRITER=fake`, con la regla del canal falso).
- **La puerta** (`quality-gate.ts`): pre-vuelo y compuertas → juez →
  decisión; riesgo o nota bajo el mínimo → una persona; entre el mínimo
  y el umbral, otra versión con una pista cerrada, hasta los intentos de
  la rúbrica, y «enviar el mejor». Antes de cada llamada mira lo que
  queda del tope diario (`outbound_health`), y cada llamada deja su fila
  en `outbound_llm_call` en su propia transacción.
- **Los jobs** (`0061_generacion_trazable.sql`): `outbound.generate`
  (cada dos minutos) redacta los borradores con `generate_with_ai` cuya
  hora cae en el próximo día y cuyos pasos anteriores ya salieron, y los
  deja en `outbound_generation` con sus marcas; `outbound.review`
  (desfasado un minuto) los juzga, escribe una fila de `outbound_review`
  por intento (nota por dimensión, nota ponderada, pista, riesgos,
  decisión, y tokens y costo de escribir Y juzgar ese intento, con el
  desglose en `gates.usage`; la frase del juez en `gates.judge_note`)
  y deja el toque en `scheduled` o en `held` con su
  motivo (`quality_warmup`, `quality_risk`, `quality_low`,
  `quality_preflight`, `quality_duplicate`, `llm_budget`, `llm_error` o
  el `needs_review` de la política). Los diez primeros de cada tipo de
  paso siempre esperan a una persona. No se redacta (ni se gasta) para
  quien pidió la baja o tiene el correo rebotado, y `outbound.review` no
  toma un borrador cuyo texto escribió una persona.
- **El pitch a mano** (VEN-6): «Redactar pitch» en la ficha abre
  `/ventas/empresas/<id>/pitch` con el último borrador (el generado, con
  la nota de la revisión, o uno guardado) o vacío; las cifras del perfil
  y las variables son fichas que se insertan donde está el cursor; la
  vista previa enseña lo que recibe la marca; la revisión corre en línea
  y el servidor la repite al guardar (`savePitch`). «Programar» no se
  puede con una cifra sin origen; «Copiar» copia el texto limpio y lo
  guarda como borrador.

#### Ronda 2 (0062)

- **Lo que escribe una persona manda.** Guardar el pitch
  (`savePitch`) guarda también su marcado con las `[claim:id]` en
  `outbound_generation` (`outbound_generation_save_manual`, outcome
  `manual`): al reabrirlo, cada cifra sigue teniendo su origen, y ningún
  job escribe encima. Mientras la IA trabaja, el editor abre su borrador
  aunque el toque todavía esté vacío.
- **Pedir a la IA desde el editor**, como el generador de Chief: un panel
  con la señal que usa, instrucciones (tono, qué destacar), «Redactar con
  IA» y tres pistas cerradas (más corto, más específico, otro ángulo).
  La web no llama al modelo: `outbound_generation_request` deja la fila en
  `requested` con la pista y las instrucciones; `outbound.generate` la
  toma antes que las cadencias y le pasa al generador la versión
  anterior; `outbound.review` la juzga y el toque vuelve a `draft` con la
  nota a la vista (lo programa la persona). El editor dice en qué va y se
  actualiza solo.
- **La llave vive en el worker.** La web sabe si la IA está encendida por
  la última corrida de `outbound.generate` (`outreach_writer_status`:
  `anthropic`, `fake`, `off` o `unknown`), no por su propio entorno.
- **Una sola lectura de variables** (`loadTemplateSources`, `@mc/db`): el
  motor al enrolar y el pitch rellenan las doce variables de la misma
  forma. El creador que firma es el del negocio (`deal.creator_id`) o el
  primero activo; los enlaces del media kit y de la cotización los arma
  el servidor con `APP_URL` y el slug de la base, nunca el navegador.
- **Cada creador cita solo lo suyo**: en una agencia, las campañas de otro
  creador del mismo espacio no se ofrecen ni pasan el pre-vuelo. El
  negocio del pitch tiene que ser de la empresa.

#### Ronda 3 (0063)

- **Lo que el pre-vuelo no veía.** Un multiplicador delante («crecieron
  x3», «×2»), «3-fold», los puntos porcentuales («5 pp») y los puestos
  («#1», «top 1», «número uno», «number one») son cifra siempre, por
  pequeños que sean. Un puesto no lo respalda ninguna cifra del perfil:
  siempre sale «sin origen». «Medio millón» es 500.000.
- **Lo que veía de más.** Lo que una creadora ofrece no es una cifra de
  desempeño: «te propongo 3 videos y 2 historias», «el paquete de 4
  reels», «mis 3 mejores videos». Tampoco las duraciones («un reel de 30
  segundos», «en 48 horas») ni las direcciones («la calle 85», «Cra. 7 #
  71-21»). «Publiqué 12 videos» y «trabajé con 11 marcas» siguen siéndolo.
  Una cifra sin origen impide programar, pero ya no copiar: la creadora
  envía desde su correo y puede ser algo que On Cue no sabe leer. Un
  correo corto y bueno pasa: el mínimo es de 150 caracteres.
- **La aprobación de lo retenido también exige origen.** Lo que la IA deja
  en `held` (los diez primeros, los de riesgo, los que pide la política)
  se aprueba en la ficha con `releaseHeldTouch`, que ahora marca cada
  cifra con su origen (la marca de la IA si el texto sigue siendo el
  suyo, o una cifra del perfil que diga lo mismo) y no aprueba una sin
  origen (`unsourced_figure`, con cuál). `outbound_touch.claims` se
  recalcula con lo que cita el texto aprobado.
- **Ningún intento se pierde.** `outbound_review.run` numera las corridas
  de la puerta de calidad sobre un toque; los intentos van de 1 a 10
  dentro de su corrida y la clave es `(touch_id, run, attempt)`. La nota
  que enseña el editor es la del intento elegido (`chosen_attempt`,
  `judge_note` y `total_score` en `outbound_generation`), no la del último.
- **Sin bucles de gasto.** Cada fallo suma en `outbound_generation.failures`
  y fija `next_attempt_at`: 2, 8, 30 y 120 minutos. Sin presupuesto se
  mira cada media hora. Tras tres respuestas ilegibles del modelo, la IA
  se rinde (stage `failed`): el toque de una cadencia queda retenido con
  `llm_error` y el editor lo dice. `last_error` guarda un código
  (`llm_budget`, `interrupted`, `llm_output`, `error`); el texto del error
  va al registro del worker, nunca a la pantalla.
- **El plazo del job.** La señal del job llega a la llamada al modelo (la
  corta ahí mismo), `outbound.review` toma tres toques por corrida y ni
  uno más si quedan menos de 90 s; si se corta a mitad, los intentos ya
  pagados se escriben en `outbound_review` antes de soltar el turno.
- **La compuerta B compara con lo que va a salir.** Además de lo enviado,
  lo programado, lo retenido y lo que la IA redactó en el mismo lote. Los
  nombres propios cuentan como uno solo: el mismo correo con la marca y
  la persona cambiadas es el mismo correo. La baja de este espacio
  (`outbound_workspace_optout`) también frena la redacción.
- **El editor.** Las cifras y las variables son fichas dentro del mensaje
  (el origen al pasar el cursor), no marcas. El pitch se guarda con sus
  `{{variables}}` sin rellenar: si cambia la persona, cambia el saludo.
  Junto a «Programar», una línea dice por qué está apagado; recién
  abierto y vacío no hay errores en rojo. El aviso de guardar no se
  pierde al repintar la página. En la demo embebida (sin worker),
  «Redactar con IA» lo redacta el redactor falso en el mismo proceso,
  por el mismo camino (`redactRequestedInProcess`).

#### Ronda 4 (0064)

- **Las cifras en palabras que se escapaban.** Un porcentaje escrito con
  palabras («el ochenta por ciento», «eighty percent», «80 per cent»),
  las fracciones («la mitad de mis seguidores», «dos tercios», «half of
  my followers»), las proporciones («tres de cada cuatro», «9 out of
  10») y los múltiplos por su raíz y no por una lista de conjugaciones
  («triplicamos», «duplicó», «tripling») son cifra siempre. También los
  puestos «primer lugar», «1er lugar», «la primera creadora», «first
  place». No lo son «media hora», «a mitad de semana», «half an hour»,
  «el cuarto video» ni «hace 2 años».
- **Los números de la marca y la trayectoria.** «Anuncios», «años»,
  «tiendas» (y sus pares en inglés) son sustantivos de desempeño: «6
  anuncios activos» y «9 años creando contenido» necesitan su origen. Y
  un número pequeño que dice lo mismo que un conteo del perfil, seguido
  de lo que ese conteo cuenta («4 locales abiertos» frente a «Locales
  abiertos de Fresko: 4»), es la cita de ese conteo sin su marca.
- **El redactor falso escribe como una creadora.** Cita por prioridad
  (una campaña con esa marca, la mediana de su red principal, su
  interacción, su audiencia), con frases propias de cada cifra («Mis
  videos de TikTok tienen una mediana de 115.446 views…»). No copia una
  señal con números fuera de su fecha: la cifra de la señal la dice con
  su marca si el ángulo la deja citar, o no la dice.
- **Los datos de fuera entran como dato.** El titular de la señal, la
  bio, el brief, las instrucciones de la persona y los mensajes
  anteriores van al prompt entre etiquetas (`<senal>`,
  `<instrucciones_del_creador>`, `<mensaje_anterior>`…), con sus «<» y
  «>» neutralizados, y el sistema dice que su contenido es información,
  nunca una orden. El juez recibe igual el mensaje que califica.
- **El calentamiento cuenta solo lo de la IA.** Los diez primeros de cada
  tipo de paso son diez redactados por la IA (outcome `approved` o
  `held` en `outbound_generation`) que salieron o aprobó una persona. Un
  pitch escrito a mano o una plantilla fija no cuentan.
- **La guardia del pitch a mano, en la base.**
  `outbound_generation_save_manual` solo guarda sobre un correo en
  `draft` o `held` sin intento sin confirmar (la guardia de
  `outbound_generation_request`); si no, `not_editable`. `savePitch` la
  llama antes de programar.
- **El editor.** Una cifra sin origen se subraya dentro del mensaje (API
  de resaltado del navegador, sin tocar el texto) y se dice justo debajo,
  con `aria-describedby` desde el campo. «Programar», «Copiar» y
  «Guardar borrador» van pegados al mensaje, antes de la biblioteca de
  fichas, que abre solo lo propio de la marca. «Copiar» dice su motivo
  exacto y calla con el editor vacío. La nota del juez falso nombra las
  dimensiones de la rúbrica en el idioma del espacio.

#### Ronda 5 (0065)

- **El camino principal no pierde el pitch.** El editor se monta de
  nuevo solo cuando la IA trae un borrador nuevo o se pone a redactar
  (`montaje.tsx` compara la clave que manda el servidor con la montada).
  Guardar, copiar o programar no lo remontan: el aviso («Programado»,
  «Copiado») sigue a la vista con el foco. Tras programar, el correo
  queda en solo lectura con «Ver la ficha» y «Escribir otro pitch».
  Cuando llega otra versión de la IA, el foco va a su aviso; un error al
  guardar o programar también se lleva el foco.
- **La persona es una variable, no un nombre.** Lo que escribe la IA se
  guarda en `outbound_generation.body_marked` con quien recibe y quien
  firma como `{{first_name}}`, `{{full_name}}` y `{{sender_name}}`
  (`templatizeKnownValues` en `render.ts`, aplicado en
  `generationFinalFrom`, que usan el worker y la demo). Si la creadora
  cambia «Para», el saludo cambia con la persona. Como red, la revisión
  del editor no deja programar un mensaje que nombra a otra persona de
  la marca («El borrador se escribió para Camilo…»). La variable del
  creador es `sender_name`, la de la lista canónica: no hay otra.
- **Lo que impide programar sin estar en el mensaje, se dice antes.** Sin
  dirección postal en el pie (con la misma regla que `savePitch`), la
  revisión lo dice con el enlace a la política y «Programar» se apaga;
  sin correo conectado, una nota neutra con el enlace a Canales.
- **Redondear no es inflar.** Una cifra vale si redondea el dato hacia
  abajo (hasta un 5 %) o si es el dato redondeado a la precisión con que
  está escrita, sin alejarse más de un 5 % («58 %» por 0,576; «1,2 M» por
  1.180.000). «120 mil» por 115.446 no pasa: escrito a miles, el dato es
  115 mil. «x3» por 3,4× tampoco.
- **Más cifras sin origen.** «Dupliqué», «dupliquemos», «cuadrupliqué»
  (la «c» pasa a «qu»), «gané 3 premios» (premios, reconocimientos,
  menciones, awards) y «mi tasa de interacción es del 12» (un número
  detrás de «tasa de…», «engagement rate», «interacción» es un
  porcentaje aunque le falte el signo).
- **Una sola regla de porcentaje.** `formatShare` (`claim-labels.ts`) la
  usan las cifras del pitch y `formatPct` de la web: la ficha y el correo
  dicen «58 %» igual.
- **La marca también es dato de fuera.** El juez recibe el nombre y el
  sector entre `<marca>` y `<sector>`, como el generador.
- **Quién pidió el borrador lo dice la sesión.** 0065 rehace
  `outbound_generation_request` con la misma firma: `requested_by` es
  `current_user_id()`; sin sesión, `p_user` solo vale si es miembro del
  espacio.
- **Copiar dice la verdad.** Si el navegador no deja copiar, la pantalla
  lo dice en vez de «Copiado»; sin asunto se copia solo el cuerpo. Tocar
  una ficha dice su origen debajo del mensaje. Enter usa la selección
  viva, no la última guardada.
- **El redactor falso no escribe en frío a quien ya conoce.** Con una
  campaña con esa marca abre con la relación («Después de la campaña que
  hicimos juntos con…») y nombra la marca dos veces como mucho.

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

#### Cómo quedó (VEN-14)

Migración `0069_bandejas.sql` (sin aplicar en Supabase: la aplica el
integrador), seed `0008_demo_bandejas.sql` con su verify, y tres piezas:

- **La intención** (`@mc/core/outreach/intent`, prompt en
  `outreach/prompts/classify.md`). `LlmIntentClassifier` pide a
  `claude-haiku-4-5-20251001` una salida estructurada (intención,
  confianza, fecha de vuelta, referido y una frase), con temperatura 0 y
  sin pensamiento extendido, sobre el mismo `LlmClient` del generador;
  lo de fuera va entre etiquetas neutralizadas. Una sola regla de
  confianza (`finalIntent`): por debajo de 0,7, `ambiguous`. Sin llave no
  se clasifica (la bandeja dice «sin clasificar»); el clasificador falso
  (`createFakeIntentClassifier`, reglas de palabras en español, inglés y
  portugués, y el mismo detector de bajas de VEN-10) es para las pruebas,
  la demo y `OUTREACH_WRITER=fake`.
- **El job `outbound.intent`** (cada tres minutos, 0069). Primero devuelve
  lo que tenía fecha: una pausa por «fuera de la oficina» vuelve a
  `active`; un enfriamiento que terminó devuelve sus mensajes cancelados a
  la bandeja de aprobación, replanificados desde ese día y retenidos con
  `cooldown_over` (nada sale sin una persona; sin nada que devolver, la
  cadencia queda completa y se avisa). Después clasifica lo entrante sin
  clasificar y aplica los efectos en una transacción por mensaje
  (`applyIntent`, `@mc/db`): **interesado** → el negocio pasa a «En
  conversación» con `deal_move_stage` solo hacia delante, siguiente acción
  «Responder hoy» con vencimiento al final del día local y aviso;
  **ahora no** → el enrolamiento del hilo a `cooldown` con `resume_at` a
  noventa días (`NOT_NOW_COOLDOWN_DAYS`) y aviso con la fecha; **fuera de
  oficina** → `outbound_message.resume_at` con la fecha leída (sin fecha, a
  la semana; tope de 120 días) y la cadencia en pausa hasta entonces; si
  la respuesta llegó sin cabecera de respuesta automática y la había
  detenido, sus pasos cancelados vuelven replanificados desde la fecha de
  vuelta y el toque deja de contar como respondido; **baja** → la misma
  baja que el detector (`applyReplyOptOut`, que ahora comparten las dos
  puertas): las fichas del espacio de baja con `reply_optout:<canal>`, lo
  suyo cancelado, y un tercero en copia no da de baja a nadie; **referido**
  → `outbound_message.referral` con nombre, correo y cargo, y aviso; nada
  se crea solo; **ambigua** → aviso para que una persona la lea. Cada
  llamada deja su fila en `outbound_llm_call` (`classify`, con el
  mensaje) y antes mira el tope diario; una respuesta ilegible del modelo
  se registra, queda ambigua con confianza 0 y no se vuelve a pagar.
  `outbound_message.intent_source` dice quién clasificó (`detector`,
  `model`, `fake`, `person`).
- **Las bandejas** (`@mc/db/queries/bandejas`, con la RLS de la web y el
  workspace nombrado en cada lectura):
  - `/ventas/aprobaciones`: los retenidos, uno por fila, con la empresa,
    la persona, el paso y el canal, el mensaje completo y **por qué quedó
    retenido** (la categoría —reglas de estilo y cifras, revisión
    automática, calentamiento, revisión humana, enfriamiento, envío— con
    la frase del motor, y si lo redactó la IA la nota del intento elegido
    por dimensión, los riesgos y lo que el pre-vuelo no dejó pasar).
    Aprobar y «editar y aprobar» van por `releaseHeldTouch` (las mismas
    reglas de la ficha) y anotan quién y cuándo; «regenerar» deja la
    petición con una pista cerrada para `outbound.generate` (en la demo la
    redacta el redactor falso en el proceso) y la versión nueva vuelve a
    la cola; «saltar» pide confirmación, deja el paso en `skipped` y la
    cadencia sigue. Un intento sin confirmar se resuelve en la ficha, no
    aquí. Teclado: j/k mueven la fila activa, a aprueba, e edita, r
    regenera, s salta; en un campo de texto las teclas escriben. Los
    avisos de un retenido llevan aquí (`/ventas/aprobaciones#fila-<id>`).
  - `/ventas/bandeja`: los hilos (una ficha por un canal) con al menos una
    respuesta, sin leer primero; la conversación completa con la
    intención de cada respuesta y quién la clasificó, la fecha de vuelta
    de un «fuera de la oficina» y «Crear contacto» para un referido.
    Abrir el hilo lo marca leído. **Responder no envía desde la web**: deja
    UN toque programado sin enrolamiento con `reply_to_message_id` (0069),
    con el id que trae el formulario (el mismo envío repetido no crea otro
    mensaje). El despachador lo envía en el hilo de ese mensaje (en correo,
    como `email_reply` con In-Reply-To y «Re:»), solo por la cuenta que lo
    recibió, con el pie de baja, y sin la política de la marca (el tope
    de mensajes y los días entre uno y otro son para escribir en frío).
    Los avisos de una respuesta llevan a su hilo.

Decisiones que la integración tiene que conocer: `0069` pone
`assert_reference_visible` en sus dos claves nuevas
(`reply_to_message_id`, `referral_contact_id`) y un disparador que exige
que la respuesta apunte a un mensaje entrante de la misma ficha, canal y
espacio. `outbound_message` tiene un CHECK nuevo: una intención lleva
`classified_at`. El enfriamiento usa los noventa días de §5.7, no
`outbound_policy.cooldown_days_after_no`, que sigue siendo del «no» de
una marca en la política. Las otras cadencias de la misma marca que una
respuesta pausó (`stop_company_on_reply`) no se tocan: las reanuda una
persona.

#### Ronda 2 (0070)

- **El lote es justo y nada se paga dos veces.** `listUnclassifiedInbound`
  reparte el lote entre workspaces (`INTENT_PER_WORKSPACE`, cinco de cada
  uno, alternados) y deja fuera, en SQL, a los que hoy no tienen
  presupuesto: uno con cien respuestas y sin tope ya no deja a los demás
  sin «interesado → mover el negocio». La llamada al modelo y su decisión
  se guardan en UNA transacción (`recordClassification`,
  `outbound_message.intent_decision`); si aplicar los efectos falla, la
  corrida siguiente reintenta solo los efectos, y al tercer fallo
  (`INTENT_MAX_ATTEMPTS`, `intent_attempts`) la respuesta queda ambigua
  con confianza 0 y un aviso. El lector del correo guarda si la respuesta
  llegó con cabeceras automáticas (`outbound_message.automatic`) y el
  clasificador lo recibe; la frase del modelo queda en `intent_reason` y
  la bandeja la enseña («Por qué: …»).
- **Una persona corrige la intención** (`reclassifyInboxMessage`, con la
  RLS de la web): «Corregir» junto a cada respuesta aplica los mismos
  efectos que el job (`reapplyIntent`) con `intent_source = 'person'`.
  Antes deshace lo que la intención anterior dejó en la cadencia (un
  «fuera de la oficina» o un «ahora no» corregidos devuelven el
  enrolamiento a `replied` y cancelan lo que se había devuelto a la cola).
  Una baja no se corrige (es de una sola dirección) y pide confirmación;
  la etapa del negocio no retrocede sola.
- **La bandeja unificada**: «Pendientes», «Hechas» y «Todas» (`done_at`:
  «Marcar como hecha», que vuelve sola a pendientes si responden); el
  teclado de Superhuman (j/k entre hilos, r a la respuesta, e hecha, Esc a
  la lista; la leyenda solo con teclado); en escritorio abre el primero
  sin leer, que en un teléfono no se marca leído. Una respuesta en cola se
  **cancela o se edita** mientras el despachador no la tome
  (`cancelInboxReply`, `canceled_by_person`); las que no salieron se ven
  aparte con su motivo hasta que se descartan
  (`outbound_touch.inbox_dismissed_at`). Con el envío apagado el aviso dice
  que queda en cola, no que sale en la próxima pasada. Sin clasificador
  (`outreach_classifier_status`, como el del redactor) la conversación lo
  dice en vez de prometer «la IA la lee en unos minutos». Un «ahora no»
  enseña hasta cuándo se enfría la cadencia, y un referido creado propone
  «Enrolar en una cadencia» (la de su hilo, con el negocio elegido). Una
  respuesta con un id que ya es de otro workspace es `not_found`, y el
  referido solo se crea desde un mensaje que lo es.
- **La bandeja de aprobación**: la cola está siempre montada (el aviso de
  aprobar la última no se pierde) y ofrece «Deshacer» diez segundos
  (`undoApproval`: vuelve a `held` con su motivo si sigue programado con
  esa aprobación); el contador dice «Mostrando 100 de N» cuando la cola es
  más larga; la leyenda de atajos solo sale con teclado y sin «r» si nada
  se puede regenerar.
- **La demo cuenta la historia** (seed 0008): cuatro retenidos con su
  código (revisión automática con nota por dimensión, riesgos y
  pre-vuelo; calentamiento; revisión humana en LinkedIn), la dirección
  postal en la política, un Instagram conectado sin secreto y los hilos de
  un referido (LinkedIn, con la cuenta caída), una ambigua (Instagram) y
  un «fuera de la oficina» automático (correo).

#### Ronda 3 (0071)

- **La demo vive en fichas suyas.** El seed 0008 colgaba sus retenidos e
  hilos de Fresko, Granos del Valle, Café Alma, Nutrivé y Hogar Lindo y
  conectaba el Instagram de Laura: el recomendador (VEN-13) veía Instagram
  conectado y la baja por respuesta de canales cancelaba toques de más, y
  `pnpm verificar` quedaba en rojo. Ahora son cinco marcas propias (Molino
  Andino, Casa Olivo, Tostadores del Sur, Huerta Viva y Cereal Aurora,
  `00000008-…`) y el Instagram está desconectado y soltado; el hilo de
  Instagram enseña «reconéctala para responder». verify/0008 (f) comprueba
  que nada del seed cuelga de una ficha ajena.
- **«Deshacer» no confía en el navegador.** Aprobar guarda el motivo con
  el que estaba retenido en `outbound_touch.approved_from_reason` (0071) y
  `undoApproval` lo restaura desde ahí; la acción de la pantalla ya no lo
  acepta. «Saltar» solo toma lo que la cola ofrece (un retenido, o un
  borrador de cadencia con petición de regenerar). Con el envío apagado,
  aprobar dice «sale cuando enciendas el envío». La nota baja de una fila
  remite a su propio «Regenerar», o solo a editarlo si la fila no lo tiene.
- **La bandeja**: la columna de la lista es `grid-cols-[minmax(0,1fr)]`
  (la pista `auto` crecía con los extractos a 894 px, quedaba debajo de la
  conversación y los clics no llegaban; a 400 px la página se desplazaba
  de lado). `scripts/ancho-movil.mjs` mide ahora también un tope de ancho
  (`TOPE`). Cada hilo tiene su propio estado (`key`): un borrador ya no
  pasa de una marca a otra. Los no leídos salen de la conversación
  (`InboxConversation.unread`); el hilo que la página abre sola solo se
  marca como elegido en escritorio. «Corregir» a «fuera de la oficina»
  acepta la fecha de vuelta o la lee del mensaje (`findReturnDate`).
- **Una palabra, un lugar.** «Bandeja» es la de conversaciones; los textos
  del radar dicen «radar».

#### Ronda 4 (sin migración nueva)

- **Una cifra sin origen no sale ni por la bandeja.** Aprobar tal cual un
  texto de la IA usa SUS marcas: lo que dejó sin marca sigue sin origen
  (antes se volvía a marcar por valor y el «40 %» de una tasa de compra
  salía respaldado por el 40 % de la audiencia de 25 a 34 años). Editado,
  se marca por valor solo lo que encaja también en unidad (un porcentaje
  con una proporción, un «x3» con un múltiplo, un número con un conteo o
  un monto), y nunca lo que la IA ya había dejado sin origen, aunque se
  toque una coma (`markFiguresByValue` con `skip`, `unsourcedFigures`). El
  retenido de Molino Andino (seed 0008) cita ahora un «23 %» que no está
  en ningún claim del perfil de Laura: «Aprobar» devuelve la cifra sin
  origen y abre el editor. verify/0008 (g) y la prueba del worker lo fijan.
- **Un «me interesa» sin negocio abre uno.** La prospección en frío
  enrola sin negocio; antes el interesado solo avisaba. Ahora, si la marca
  no tiene uno abierto, nace en «En conversación» con «Responder hoy», su
  vencimiento al final del día local, el dueño que enroló y la cadencia y
  el mensaje enlazados. «Ahora no» sin cadencia que enfriar (un pitch
  suelto, una ficha de baja) ya no promete el enfriamiento: dice cuándo
  volver a escribir.
- **Quién opera las bandejas.** `PUEDEN_OPERAR_VENTAS` (owner, admin,
  member, `lib/auth/reglas.ts`): cada acción de las dos bandejas lo mira en
  el servidor antes de tocar la base o el modelo, y las pantallas no
  ofrecen botones ni atajos a un 'viewer' o un 'client' (en una agencia,
  la marca misma). Tampoco marcan como leído lo que el equipo no leyó.
- **El teclado no atraviesa una confirmación.** Con «¿Saltar este paso?»
  (o el editor, o la pista de «Regenerar») abiertos en la fila activa, a,
  e, r y s no hacen nada. La fila activa solo se marca desde `sm`: en un
  teléfono no hay atajos. `escribiendo()` vive en `lib/teclado.ts`.
- **La procedencia del contacto** («Procedencia del contacto: Web de la
  empresa») va en cada fila retenida (§8, decisión 5).
- **La bandeja**: creado un referido, el mensaje enseña «Enrolar en una
  cadencia» (con el negocio y la persona elegidos: `?contacto=` en la
  cadencia) y el enlace a su ficha. «Editar» una respuesta en cola no la
  deja además en «no salió» (se descarta en el mismo `UPDATE`).
  «Descartar» tiene su estado de carga y su error. El tope de la
  respuesta es uno solo, `INBOX_REPLY_MAX_CHARS`, en el campo y en la
  acción. La clasificación sin llave es la decisión 9 de §8.

#### Ronda 5 (sin migración nueva)

- **La baja de un tercero se decide en la bandeja.** Si la pide alguien
  en copia (`applyReplyOptOut`: el remitente no es la ficha), el mensaje
  queda `unsubscribe` y la ficha sin baja. La bandeja ya no dice «la
  ficha ya no recibe mensajes»: dice quién la pidió («Lo pidió
  otra@marca.test, no la ficha») y deja «Corregir»; elegir «Pidió la
  baja: dar de baja a la ficha» (con su confirmación en rojo) sí la da de
  baja, porque lo decide una persona (`senderConfirmed`), y corregirla a
  otra intención quita la marca. `reclassifyInboxMessage` solo se niega
  cuando la ficha está de baja de verdad (la misma condición que el
  despachador: su marca, su correo suprimido o dado de baja en el
  espacio).
- **Quién escribió cada mensaje.** Cada mensaje dice «Tú», el nombre de
  la ficha o la dirección de quien respondió, y «no es Paula» si no es
  ella (`fromContact`, la misma comparación que la baja).
- **«Me interesa» cancela lo pendiente** (lo que pide esta sección): la
  respuesta ya detenía sus cadencias, pero un pitch suelto programado a
  la misma ficha salía días después, en frío. Ahora se cancela
  (`replied_interested`); una respuesta escrita en la bandeja, no.
- **El falso ve la negación.** «No me interesa», «No, no nos interesa»,
  «Not interested», «Não nos interessa» dan `not_now` con 0,8 (antes
  `interested` con 0,9: abrían un negocio). El prompt del modelo dice lo
  mismo: un «no» que no pide la baja es `not_now`. Fixtures `rechazo*` en
  `marcas.json`.
- **La respuesta retenida es una respuesta.** Una respuesta de la bandeja
  que el despachador retiene entra a la cola de aprobación como «Tu
  respuesta desde la bandeja»: en el hilo (`email_reply`, «Responde en el
  hilo «…»»), sin campo de asunto y sin «Regenerar»; se aprueba tal cual
  (`releaseHeldTouch` no pide asunto con `reply_to_message_id`). En la
  bandeja se ve «Retenida» con el motivo y el enlace a aprobaciones. Sin
  la dirección postal del pie, la bandeja no deja escribir una respuesta
  por correo y lleva a guardarla (`no_postal_address`).
- **El borrador no se pierde.** «Tu respuesta» se guarda por hilo
  (sessionStorage, ficha y canal) y vuelve al volver; con texto sin
  enviar, j, k, e y Esc avisan la primera vez y siguen a la segunda.
- **«e» pasa a la siguiente** en «Pendientes» (la de detrás, la de
  delante si era la última, o la lista), como en Superhuman.
- **Stripe Radar de verdad.** La nota dice el mínimo de la rúbrica del
  paso («7,4 de 10 · mínimo 8») y la dimensión que queda por debajo va en
  ámbar; en una versión nueva el título es «La revisión de la versión
  nueva». Una cifra sin origen al aprobar va en el campo del mensaje
  (aria-invalid, con el foco, una sola vez) y su frase se enseña debajo
  con la cifra subrayada: un `<textarea>` no se puede resaltar por dentro
  con la API del editor del pitch.
- **Detalles.** El nombre de los avisos («Aprobado: el mensaje a Paula…»)
  lo devuelve la base; `editar` pasa por zod; el canal es
  `BandejaChannel`; la fila dice paso y canal a un lector de pantalla; el
  anillo de foco no depende de `sm`; tras «Pedir otra versión» el foco
  vuelve a la fila y, en la demo, el aviso dice que la versión nueva ya
  está; un borrador regenerado que no se puede aprobar tal cual sigue
  como estaba (SAVEPOINT) y no queda retenido por «Revisión humana».

#### Pulido r1 (0071, sin migración nueva)

- **Cualquier respuesta detiene el pitch suelto.** `stopOnReply` cancela
  lo programado a la ficha fuera de una cadencia (`replied`); si la
  respuesta llegó sin enlazar a un toque, lo hace la intención: «ahora
  no» (`not_now`), un referido o una dudosa (`replied`), solo lo creado
  antes de que llegara el mensaje (lo que la creadora programó después de
  leerla es decisión suya). Antes solo «me interesa» lo cancelaba y un
  «ahora no» salía en frío tres días después.
- **Un `client` no lee las bandejas** (`PUEDEN_VER_BANDEJAS`: owner,
  admin, member y viewer). En una agencia es la marca misma: las dos
  páginas ni cargan los hilos ni la cola, y enseñan un vacío «no está a
  tu alcance». Los permisos de Ventas pasan por una sola función,
  `tieneRol` (`lib/workspace/rol.ts`).
- **La abierta sola no marca en cascada.** En escritorio, sin hilo en la
  URL, la página abre el primero sin leer; al marcarlo leído queda fijado
  en la URL (`router.replace`) y el siguiente render no salta al
  siguiente sin leer. Antes, a 1,5 s la bandeja entera estaba leída.
- **«Regenerar» también para un seguimiento en el hilo** (`email_reply`):
  0071 redefine `outbound_generation_request` para aceptarlo (nunca una
  respuesta escrita en la bandeja); `outbound.generate` ya lo redacta como
  «Re:», sin asunto propio. El retenido de Vitalé de la demo (7,4) se
  puede regenerar.
- **Aprobar bajo el mínimo pregunta** («¿Aprobar con 7,4 de 10?», con
  `ConfirmInline`, como Stripe Radar) y la frase del motivo ya no ordena
  editar («puedes editarlo o aprobarlo tal cual»).
- **«Deshacer» devuelve el mensaje a su lugar**: la cola ordena por hora
  prevista y antigüedad del toque (`created_at`, que aprobar no cambia) y
  la fila vuelve con el foco.
- **La demo cuenta el criterio**: Frutos del Páramo (seed 0008 §7) dijo
  «me interesa» hoy y su negocio pasó de «Contactado» a «En
  conversación» con «Responder hoy»; los mensajes de la bandeja van a una
  hora de oficina de su día local, y el «fuera de la oficina» de Esteban
  vuelve diez días después de su respuesta.

### 5.8 El brief como regla (VEN-7, 25 de septiembre)

El brief (`outbound_brief`, `/ventas/brief`) tiene dos mitades que no
pesan igual. **Qué buscas** (categorías, países, presupuesto, formatos,
fechas) es una preferencia: no oculta nada, pero el radar MARCA en cada
tarjeta lo que la aparta del brief, calculado en SQL
(`briefSignalLateralSql`): «Bajo tu mínimo» (presupuesto estimado por
debajo del mínimo, en la misma moneda), «Fuera de tus países» (el país
de la señal o de su marca no está entre los buscados) y «Fuera de lo
que buscas» (el brief busca categorías y la marca no tiene ninguna).
Con varios briefs activos, cada marca solo si lo está para todos. La
categoría buscada que SÍ tiene va dentro de la Pill del encaje («82 %
· alimentos»): hasta la ronda 3 era una Pill aparte («Buscas
«alimentos»») y, en la demo, la llevaban las cinco tarjetas, así que no
distinguía ninguna. Los formatos y la ventana de disponibilidad los
usan las cadencias (VEN-7 r4): el contexto del recomendador y el del
generador los traen (`getRecommendationContext`,
`loadGenerationContext`), y el prompt dice «Formatos que ofrece el
creador: … Si propones una colaboración, propón solo estos formatos» y
«Disponible para campañas del … al …; nunca fuera de esa ventana»
(`briefOfferLines` de `@mc/core`). Hasta la ronda 3 se guardaban y no
los leía nadie. **Qué no aceptas** (categorías y marcas excluidas, y la
divulgación obligatoria) es una regla. La divulgación pasó a este bloque
en la ronda 4, como en Passionfroot, donde las condiciones no
negociables van juntas: no filtra marcas, pero es algo que el creador
no acepta («No acepto contenido pagado sin la marca de publicidad de la
red») y la cumplen los mensajes. Las exclusiones se cumplen en cuatro
sitios con la misma definición de «esta marca» y de «esta categoría»
(`packages/db/src/queries/brief.ts`):

- **El radar** (`briefVerdictSql`): la señal no entra en la bandeja, y
  la bandeja dice cuántas dejó fuera, con «Verlas». Vistas, van al final
  en su propio grupo («Ocultas por tu brief») y cada una dice la regla
  que la dejó fuera, como la escribió el creador («Tu brief no acepta
  «harinas»», «… a Molino Andino»). La marca de la señal se reconoce por
  id, por dominio o, sin dominio, por nombre entre las del CRM; la
  categoría, por el sector y los nichos de esa marca y por lo que trae la
  señal en `evidence`. KPI, pestaña, bandeja y la ficha de la empresa
  cuentan igual.
- **Enrolar** (`enrollContacts`): una ficha de una marca excluida sale
  como `brief_excluded` y no nace ningún toque.
- **El despachador** (`claimDueTouches`): cancela con `brief_excluded`
  lo que ya estaba en la cola cuando el brief cambió.
- Las dos últimas corren en el worker, sin RLS: usan
  `briefCompanyVerdictSql` con el workspace del toque o de la secuencia
  explícito, para que el brief de un espacio nunca frene a otro.

Cada brief es de un creador, con uno activo por creador (0073 §1),
porque el recomendador ya lee el del creador del negocio (§5.5, r4). La
pantalla edita el brief de UN creador: en una agencia, un selector
(`?creador=id`) elige cuál, y `getBrief`/`saveBrief` reciben su id y
comprueban que sea del espacio (`UnknownCreator`). Hasta la ronda 2 la
pantalla decía «Brief del espacio» y guardaba en el primer creador, así
que la regla anunciada no se cumplía para los demás. Con varios
creadores:

- enrolar y el despachador usan el brief del creador del negocio y, si
  ese creador no tiene brief activo, lo que excluyen TODOS los activos
  del espacio (en una agencia, un creador sin brief no se salta las
  reglas de los demás);
- el radar, que no es de nadie, oculta solo lo que excluyen todos los
  activos: lo que un creador no acepta, otro del mismo espacio puede
  aceptarlo. La pantalla lo dice donde se edita la regla («Ana también
  tiene brief activo…»).

**Excluir una marca que no está en el CRM (ronda 4).** «Marcas que no
aceptas» solo guarda empresas del CRM (`CompanyNotInCrm`). Hasta la
ronda 3 se elegían en un `<select>` con las primeras 1 000 del CRM, que
cortaba las demás sin avisar, y una marca que llegaba al radar por el
catálogo o por una señal automática no se podía excluir sin darla antes
de alta. Ahora:

- en el brief, las marcas se BUSCAN en el servidor, en todo el CRM
  (`searchBriefCompanies`, por `name_key`, sin tildes ni mayúsculas;
  un combobox con flechas, Enter y Escape);
- en la tarjeta del radar, «No aceptar esta marca» (solo para owner y
  admin, y solo con algún brief activo) hace en UNA transacción
  (`rejectSignalBrand`): resuelve la marca de la señal como al aceptarla
  (la conocida o una nueva con lo que trae), la enlaza al CRM con la
  relación `blocked` si no estaba (si estaba, su relación no se toca) y
  la agrega a los briefs activos elegidos (`addExcludedCompany`: mismo
  tope, mismo candado por workspace y creador, traza
  `ventas.brief.excluir_marca`). Con varios briefs activos, el diálogo
  pregunta en cuáles; el aviso dice si la bandeja ya no la enseña o si
  otro brief la sigue aceptando.

**A escala.** El veredicto corre por cada señal pendiente en la
cabecera de Ventas, la pestaña, la bandeja y la lista de Empresas. Lee
los briefs activos una vez por consulta (un CTE `MATERIALIZED`) y
resuelve la marca de cada señal con tres búsquedas indexadas unidas con
`UNION ALL` (id, dominio, nombre dentro del CRM), nunca con un `OR`
sobre `company`. Bajo RLS, Postgres solo usa un índice si la condición
es leakproof: ni `brand_key(co.name)` ni `citext = citext` lo son, así
que 0074 agrega `company.name_key` (brand_key(name), calculada por la
base) y un índice sobre `domain::text`. Medido: con 5 000 empresas en
el catálogo y 100 señales, `countHiddenSignals` pasó de recorrer el
catálogo por señal (28,6 s con 10 000) a unos 15 ms. Desde la ronda 4
la prueba (`brief.test.ts`) no mide el reloj, que dependía de la carga
de la máquina: lee el PLAN de `HIDDEN_SIGNALS_SQL` como `mc_app`
(`EXPLAIN (FORMAT JSON)`, con 2 000 empresas y `ANALYZE`) y exige que
toda lectura de `company` vaya por índice (llave primaria,
`company_domain_text_idx` y, por nombre, `company_name_key_idx` o la
llave de `company_link` cuando el CRM es chico), sin un solo `Seq Scan`.
La medición de tiempo queda detrás de `MC_PERF=1`.

Un brief en pausa no oculta ni frena nada. Es el brief de un creador,
pero lo que excluye se oculta del radar de todo el equipo cuando lo
excluyen todos los briefs activos, y frena las cadencias de sus
negocios; por eso lo cambian owner y admin (la pantalla, la acción y las
políticas RESTRICTIVE de 0073 con `outreach_can_manage`) y cada cambio
deja traza en `audit_log` (`ventas.brief.guardar`, antes y después).

Las frases que dicen un tope del brief («hasta 30», «2.000
caracteres») lo reciben de `BRIEF_LIMITS` ya formateado con el locale
del workspace (`brief/limites.ts`): ningún número va escrito a mano en
`messages.ts`. La moneda del mínimo se elige junto al monto (la del
workspace si el brief no tiene mínimo) y una inválida es
`InvalidCurrency`, no un error de presupuesto.

**El brief es de un creador (ronda 3).** Uno activo por creador: lo
que excluye se oculta del radar de todo el equipo solo cuando lo
excluyen todos los briefs activos, y frena las cadencias de los negocios
de su creador. 0073 lo dice así en sus comentarios (corregidos en el
pulido, antes de aplicarse), igual que `lib/auth/reglas.ts` y el JSDoc
de `saveBrief`.

**Pulido: una marca excluida se reconoce por su identidad, no por su
id.** «No aceptar «Bebidas Luna»» crea una ficha propia sin dominio, y
las señales automáticas casi siempre traen dominio o una ficha del
catálogo. El veredicto (`briefVerdictSql`, `briefCompanyVerdictSql`)
compara la empresa de la señal con las excluidas por id, por dominio o
por nombre (`brand_key`) cuando a una de las dos le falta el dominio, y
la búsqueda por nombre dentro del CRM corre también cuando la señal trae
un dominio que nadie tiene (contra fichas sin dominio). `resolveCompany`
sigue la misma regla, así que aceptar esa señal no crea una marca
duplicada fuera del brief. Dos marcas con el mismo nombre y dominios
distintos siguen siendo dos («dos Alma de dos países»).

**La conversión cuenta a quien pasó por la etapa.** Un negocio que salta
de Contactado a Propuesta no cuenta en «En conversación», así que una
columna puede tener más negocios que la anterior; la pantalla lo dice
bajo el título de la Lista y en el `title` de cada fila.

**La conversión es la de un periodo (VEN-8 r4).** `getStageConversion`
cuenta por defecto los negocios que ENTRARON por primera vez en la etapa
en los últimos 90 días (`CONVERSION_WINDOW_DAYS`), contados en la zona
del workspace desde el inicio del día, y la fila lo dice («58 % avanza ·
de 12 negocios en 90 días»; en la Lista, «Conversión por etapa ·
últimos 90 días»). Lo que pasó después de esa entrada cuenta aunque sea
de hoy. `since` cambia el inicio y `since: null` vuelve a toda la
historia. Hasta la ronda 3 era toda la historia: lo de hace un año
pesaba igual que lo de esta semana, y la cifra no decía de cuándo era.

**El aviso de guardado va junto al botón (ronda 4).** El brief mide unos
2 000 px a 400 px: el «Guardado» arriba quedaba a −1 115 px y quien
pulsaba «Guardar el brief» en el móvil no veía nada. Ahora el aviso va
pegado al botón y se lleva el foco (y el scroll, `block: "nearest"`).

**Checkbox y Dialog, en el kit (ronda 4).** Lo que era propuesta ya está
en `components/ui/` con su prueba, su sección en `/kit` y su fila en el
README: `Checkbox` (casilla nativa con etiqueta y ayuda) y `Dialog` (el
modal del pipeline, ahora también el de «No aceptar esta marca»).
Agregar al kit es libre, y ninguno existente cambió: la regla larga de
una tarjeta va en `TruncatedPill` (nuevo, en `pill.tsx`), que corta el
texto con «…» por CSS y lo deja entero en `title`, en vez de recortar la
cadena a mano, que podía partir un emoji. Meter el `truncate` dentro de
`Pill` rompía a quien parte su frase en dos líneas (el asistente de
importación de Resumen). La copia de `Casilla` en
`finanzas/gastos/form.tsx` no existe en `rasheed/integracion`: cuando
llegue, puede usar el `Checkbox` del kit.

**Para el kit (ronda 3):** hecha en la ronda 4; `Checkbox`, `Dialog` y
`TruncatedPill` viven en `components/ui/` (ver arriba).

**Ronda 5: nada se pierde en silencio en «Marcas que no aceptas».**

- **Un nombre a medias no se guarda como si nada.** Lo escrito en el
  combobox solo viaja si es exactamente una marca de la lista. Si queda
  texto sin resolver («cafe mon»), «Guardar el brief» no envía: el campo
  dice «Elige la marca de la lista o borra lo escrito» y se lleva el
  foco. Enter sin opción marcada agrega la única que se ofrece; con
  varias, abre la lista en la primera y deja lo escrito. Hasta la ronda 4
  el texto se borraba y el aviso decía «Guardado» con la marca fuera.
- **Excluir por adelantado una marca que no está en el CRM**, como en el
  formulario de preferencias de Passionfroot (la competencia de un
  cliente): si la búsqueda no encuentra nada, el combobox ofrece «No
  aceptar «…»». La Server Action `noAceptarMarcaNueva` llama a
  `rejectBrandByName` (queries/ventas.ts), que reutiliza el alta de
  `rejectSignalBrand` (`findOrCreateCompany` + `linkBlocked`: la conocida
  por dominio o por nombre en el CRM, o una nueva; enlazada como
  `blocked`), exige owner o admin en la base (`outreach_can_manage`) y
  deja traza (`ventas.brief.no_aceptar_marca`). Lo escrito es el nombre y,
  si tiene forma de dominio, también el dominio. La marca entra como
  etiqueta y viaja al guardar; desde entonces una señal con ese nombre o
  ese dominio queda oculta (probado en db/test/brief.test.ts). Sin esquema
  nuevo.
- **Los dos diálogos, un solo pie.** «¿No aceptar esta marca?» usa el de
  «¿Por qué lo pierdes?»: a la derecha, Cancelar primero y la acción
  destructiva al final; con un solo brief el foco inicial cae en
  Cancelar. El orden queda escrito en la fila de `Dialog` del README del
  kit. Con una sola creadora la descripción ya no habla de «todos los
  briefs activos». Al confirmar, el foco va al aviso del radar (la
  tarjeta se desmonta con la revalidación y el foco caía en `<body>`).
  La acción está junto a «Descartar», no en una franja propia.
- **La conversión no habla de lo que no se ve.** Con el filtro «Para
  hoy», ni el tablero ni la Lista la ponen (`conversion: null`). En la
  Lista es una línea por etapa sin caja, y «en 90 días» solo va en el
  título.

---

## 6. Las historias nuevas de Ventas

Las ocho de hoy (VEN-1 a VEN-8) se quedan. VEN-6, el pitch, se
absorbe en VEN-12. Se agregan ocho:

| Id | Historia | Tam. | Depende de | Terminado cuando |
|---|---|---|---|---|
| VEN-9 | **Canales de outreach.** Migración `0046_outreach` (tablas de la sección 5.2), conector de Unipile con hosted auth y webhook firmado para LinkedIn e Instagram, OAuth de Google con `gmail.send` y `gmail.modify`, pantalla de canales con estado, límites y keepalive diario. | L | CIM-2, CIM-3 | Un creador conecta su Gmail y su LinkedIn; el token de Google se refresca solo; una cuenta caída se ve en rojo con el botón de reconectar. |
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

#### Cómo quedó la actividad (VEN-16, 25 de septiembre; ronda 5)

- **Migración `0072_actividad_outreach.sql`** (va detrás de las bandejas de
  VEN-14, 0069–0071. En el pulido r1 absorbió las de las rondas 4 y 5,
  que no estaban aplicadas, así que hay una sola definición de cada
  vista). Una
  función y cuatro vistas de solo lectura, con `security_invoker` y sin
  escritura para `mc_app`:
  - `outbound_touch_retry_block(outbound_touch)`: por qué un fallido **no**
    puede volver a la cola (`not_retryable`, `too_many_attempts`,
    `sequence_archived`, `enrollment_closed`, `superseded`, `opted_out`,
    `email_invalid`, `account_down`), o NULL si puede. Es la única regla:
    la usan la vista, los botones por tipo y el propio reintento (dentro
    de su `FOR UPDATE`). `too_many_attempts` protege al despachador: con
    `attempt_count` en 19 el siguiente reclamo lo deja en 20, el techo del
    CHECK de 0046; uno más rompería el UPDATE del reclamo, que es uno por
    lote y para todos los workspaces. `account_down`: el fallo fue de la
    cuenta del canal y el espacio no tiene ninguna conectada de ese canal.
    `opted_out` mira las **tres** fuentes de `enforce_outbound_optout`: la
    ficha dada de baja, la baja global y la baja por enlace de **este**
    espacio (`outbound_workspace_optout`, 0055 §8.1), que en una ficha
    pública compartida no marca `contact.opted_out`. Sin la tercera, el
    fallido de alguien que pulsó el enlace salía con «Reintentar» y el
    reintento terminaba en `blocked`: un botón muerto justo con quien pidió
    la baja (ronda 3).
  - `outbound_queue`: un toque por fila con su paso, su contacto, su
    cuenta (y su estado), el código de su motivo y `retry_block`;
    `bucket` = `queue` o `history`.
  - `outbound_usage_daily`: uso de cada cuenta viva en 14 días locales
    contra los **tres topes del reclamo**: el diario de la cuenta, el
    semanal de la cuenta y el diario de correos del espacio
    (`max_emails_per_day`, contador sin cuenta), más el techo del
    proveedor, el servicio de la cuenta (`provider`: «Gmail permite hasta
    2.000 al día»; en Unipile, la red), el día del calentamiento y el
    interruptor del outreach. Cada CTE de contadores filtra su ventana (14
    días, y las semanas que los contienen: 19 días), así que la lectura no
    crece con el historial de `outbound_counter`.
  - `outbound_funnel_by_step`: enviados, abiertos, respondidos y positivos
    **dentro de lo enviado**, más en cola, fallidos y detenidos (cada
    toque del paso cae en una sola columna).
  - `outbound_sequence_health`: enrolamientos por estado, cola, 7 días,
    tasas y un semáforo `inactive`/`failing`/`attention`/`healthy`.
  «Positivo» es una respuesta entrante del toque con `intent =
  'interested'` (la clasifica VEN-14, con su `classified_at`).
- **Las consultas** están en `@mc/db/queries/actividad` y validan cada
  fila (`oneOf`, `int`, `text` de `queries/outreach/shared`). El
  semáforo del uso lo pone `listChannelUsage` con `warmupDailyLimit` de
  `@mc/core`, la misma curva que usa el reclamo: el límite duro es lo
  usado más el **menor cupo** entre el día (con la curva), la semana y el
  espacio (`limitedBy` dice cuál manda); el blando, el 80 % de él. Una
  cuenta que no está conectada, o un espacio con el envío apagado, sale
  `off` («Sin envío», en gris), nunca verde.
- **Páginas**: la cola y el historial paginan por cursor (keyset), como
  la lista de eventos de Stripe: el historial por `(status_changed_at,
  touch_id)` hacia atrás, la cola por (fallido primero, la hora a la que
  toca, `touch_id`). El cursor va en la URL (`?siguiente=` o
  `?anterior=`), con el instante en UTC y microsegundos; 50 filas por
  página. Los conteos de las pestañas y los reintentables por tipo salen
  de **una** pasada por `outbound_touch` (`count(*) FILTER` con
  `GROUPING SETS`), no de la vista; las secuencias, de `outbound_sequence`
  y los tipos, de `outbound_step`.
- **Reintentar** (`retryFailedTouches`) devuelve `failed → scheduled` a
  la hora a la que lo reclamará el despachador (`retryScheduledFor`:
  `nextWindowSlot` con la zona de la cadencia o del espacio, la ventana de
  la política y la misma semilla que el reclamo). Dentro de la ventana es
  ahora; un viernes a las 20:00, el lunes al abrir. La fila dice esa hora,
  no una que no se cumple. No toca `attempt_count` (cada intento tiene su enlace
  de baja), y reabre la cadencia que se completó por ese fallo. Lo que
  `outbound_touch_retry_block` bloquea ni se ofrece ni vuelve; cada toque
  va en su SAVEPOINT, así que una regla de la base (baja, correo inválido,
  paso con otro vivo) salta ese y no el lote. **Cancelar**
  (`cancelQueuedTouches`) cancela borradores, programados y retenidos, y
  descarta fallidos, con `blocked_reason = 'canceled_by_user'`; la
  cadencia avanza o se completa como tras un envío.
- **Pantallas**: `/ventas/actividad` (pestañas Cola e Historial, filtros
  por cadencia, tipo de paso y contacto, reintento por tipo, cancelación
  en masa con confirmación en el sitio, el motivo cortado que se
  **despliega en la fila** con su código —un `<details>`: ratón, dedo o
  teclado—, el aviso del resultado que sobrevive a que la lista se vacíe
  y se lleva el foco, y las páginas); `<UsoPorCanal />` montado en
  `/ventas/canales` (desde la ronda 3 es el único sitio del uso: la
  tarjeta del canal dice cómo está la conexión y ya no repite «Hoy N de
  M»; «Reconectar» baja a la fila del canal por su ancla, `canalHref`); `<MetricasCadencia sequenceId />` (KPIs, embudo por
  paso y vista de flujo con una explicación por cifra que Escape cierra)
  montado en `/ventas/cadencias/[id]`. Las dos piezas montadas traen su
  `Suspense` y su frontera de error: si su consulta falla, cae solo la
  pieza. Los textos, en `ventas/actividad/messages.ts`.
- **Lo que no se guarda**: el texto del proveedor de un fallo. El detalle
  de un fallido es su código traducido (§9.2: nunca el texto de un
  proveedor, nunca una frase en la base).
- **Demo**: el seed `0009_demo_actividad.sql` deja un LinkedIn fallido con
  la cuenta caída (se ofrece reconectar), un correo fallido reintentable y
  los contadores de las cuentas de Laura **sacados de los toques que el
  reclamo tomó** (verify/0009.sql lo comprueba en los dos sentidos): el
  widget de uso dice lo mismo que el historial, día por día. La historia
  de la demo es que el envío salió unas horas (los correos de hoy de
  0006) y después se apagó.
- **Prueba**: `packages/db/test/actividad.test.ts`, una semana de envíos
  en los ocho estados; el embudo cuadra con `outbound_touch` fila a fila,
  la regla del bloqueo es la misma en la vista, los botones y el
  reintento, las páginas no repiten filas (también con 205 envíos) y el
  semáforo sigue a los tres topes.

**Ronda 4** (sin cambiar lo anterior):

- **`outbound_step_position` y `outbound_touch_is_positive`** (hoy en
  0072 §1b; nacieron en una 0068 que el pulido fundió): el
  número de un paso sale de una sola vista, `outbound_step_position`, y
  «positivo» de una sola función, `outbound_touch_is_positive(t)`
  (enviado, **con `replied_at`** y con una respuesta entrante
  `interested`). `outbound_queue`, `outbound_funnel_by_step` y
  `outbound_sequence_health` se reemplazan con las mismas columnas y las
  usan: la cola y el embudo ya no pueden numerar distinto, y una
  clasificación «me interesa» sin `replied_at` (una importación, un
  reproceso) no hace crecer el embudo hacia abajo. El orden del paso es
  el de la línea de tiempo (`outbound_step_order_idx` lo hace único).
- **La cola no promete lo que no va a pasar.** Solo lo programado dice
  «Sale …»: lo retenido dice «Previsto para … si lo apruebas» y lleva
  **«Revisar y aprobar»** a la cadencia de su ficha
  (`OUTREACH_URLS.companyCadence`); el borrador, «Sale cuando lo
  programes». `getQueueBlockers` (una consulta) dice qué para la cola
  como la para el reclamo: el envío del espacio apagado, los canales sin
  ninguna cuenta conectada y los que la política no deja. Con cualquiera,
  la fila dice «En espera · envío apagado» (o «sin cuenta de LinkedIn»)
  con su enlace (el interruptor de la política, la fila del canal); con
  el envío apagado, además, un aviso arriba de las pestañas y la ayuda
  del reintento deja de decir «en la próxima pasada».
- **Textos**: el motivo va en el idioma de la interfaz
  (`IDIOMA_MENSAJES`), no en el locale del espacio: una fila ya no mezcla
  español e inglés; las cifras y las fechas siguen el locale. El detalle
  dice «código: …» solo cuando el motivo **es** un código
  (`parseHoldReason` en lo retenido). Las explicaciones del flujo
  concuerdan con la cifra («Un mensaje de este paso falló», «Ningún…»).
  La fecha corta lleva el año cuando no es el del espacio. Con más de
  una página, la casilla de todo dice «de esta página» y cuántos hay con
  los filtros.
- **Teclado**: cada paso del flujo es una sola parada de tabulación
  (roving tabindex); las flechas, Inicio y Fin recorren sus cifras.
- **Salud en la lista**: `/ventas/cadencias` pinta el semáforo de cada
  cadencia con `columnaSalud(salud)` (una línea de montaje) y
  `listSequenceHealth(tx, ids)`, el mismo color que el detalle.
- **Canales**: `listChannelAccounts` ya no calcula `usedToday` ni
  `usedThisWeek` (nadie los pintaba): el uso sale solo de
  `outbound_usage_daily`.

**Ronda 5** (sin cambiar lo anterior):

- **`outbound_queue.sequence_status`** (hoy en 0072; nació en una
  migración aparte que el pulido r1 fundió), al final de la vista. Con la
  cadencia en pausa (o en borrador), o con la inscripción de esa persona
  en `paused` o `cooldown` (tras un «ahora no»), `decideBeforeSend` aplaza
  el toque cada día: la fila ya no dice «Sale mañana 8:12» con una fecha
  que avanza sola, sino «En espera · cadencia en pausa» (con «Ir a la
  cadencia»), «en pausa para esta persona» o «dijo «ahora no»» (con su
  cadencia en la ficha). El orden es el del despachador: el envío
  apagado, la cadencia, el canal.
- **Permisos**: reintentar y cancelar en masa piden `owner`, `admin` o
  `member` (`ventas/actividad/_lib/permiso.ts`, `puedeOperarLaCola`, el
  patrón de la política y del perfil). La RLS de `outbound_touch` es solo
  por workspace: sin esta guarda un `viewer` o un `client` cancelaba la
  cola entera. La página no ofrece casillas ni «Reintentar» a quien no
  puede; las acciones lo vuelven a mirar antes de abrir la transacción.
- **El envío apagado se dice una vez**: el aviso de arriba lleva al
  interruptor; la fila dice solo «En espera · envío apagado» junto a la
  pastilla. La frase entera con su enlace queda para los motivos de esa
  fila (su canal, su cadencia), que sí varían. Así lo fallido (en rojo)
  no se pierde entre líneas naranjas iguales.
- **El embudo es el flujo**: sin el gráfico de barras agrupadas (seis
  pasos por cuatro series daban barras de 2 px y repetían el flujo). La
  vista de flujo, con una explicación por cifra, es la pieza principal,
  como el flow viewer de Chief. «Detenidos» cuenta también lo que se
  canceló a mano desde la actividad, y su explicación lo dice.
- **Uso por canal**: la franja de 14 días lleva el primer día y «Hoy»
  debajo, y un día con algo de uso no baja de 2 px (no se confunde con un
  cero).
- **El cursor tiene una sola regla**: la web acepta un cursor de la URL
  con `isQueueCursorToken` de `@mc/db` (la misma función que lo lee), no
  con una copia de su formato; `_lib/cursor.test.ts` pasa el token que
  genera `listOutboundQueue` por `filtrosDe`.
- **Selección por página**: «Solo los 48 mensajes de esta página; con
  estos filtros hay 120 que se pueden cancelar» (en plural o singular), y
  el total es lo cancelable (`getQueueFacets().cancelable`), no la cola
  entera con lo que se está enviando.
- **Demo**: antes de sumar los contadores, el seed 0009 anota en cada
  toque reclamado la cuenta con la que salió (los correos sueltos de 0006
  no la traían): el widget («Correo 4 de 20 · laura@…») y el historial
  («Desde laura@…») cuentan lo mismo. verify/0009.sql (e) lo comprueba.
- **Pruebas**: el reintento por tipo de paso en su caso bueno (vuelve el
  fallido que puede, con los filtros, y los bloqueados siguen fallidos),
  la cadencia en pausa en la vista y en la fila, y las acciones con un
  `viewer`.

**Pulido r1**:

- **Una sola migración**: 0072 funde las de las rondas 4 y 5 (ver
  arriba).
- **La base también guarda la cola** (0072 §6): el disparador
  `outbound_touch_guard_operator` rechaza (42501) que `mc_app`, con una
  persona en la sesión, cancele un toque o devuelva a la cola uno
  fallido si no es owner, admin o member (`outreach_can_operate`). Antes
  solo lo miraba la Server Action; ahora falla cerrada como la política.
- **Reintentar por tipo pregunta antes** («¿Volver a enviar 37 mensajes
  de Correo?», con cuándo salen), como «Cancelar seleccionados».
- **La fila dice las dos cosas**: con el envío apagado y la cadencia en
  pausa, «En espera · envío apagado · cadencia en pausa» con «Ir a la
  cadencia»: encender el envío no bastaría.
- **El embudo cuenta y se ve**: `outbound_funnel_by_step` suma
  `failed_retryable` (la misma regla que el botón), así que «fallidos»
  dice si se pueden reintentar, si ninguno o cuántos, y lleva a la cola
  de ese tipo; y `*_share_of_first` (lo enviado, abierto y respondido
  sobre lo enviado en el paso 1) pinta una barra fina por cifra: la caída
  de un paso al siguiente se ve sin leer números.
- **La franja de 14 días se lee**: más alta y los días normales en el
  acento suave, no en gris sobre gris.
- **La demo no crece hacia abajo**: Daniel y Carolina tienen su paso 1
  (seed 0009) y el paso 3 de Carolina, cancelado por su «ahora no».
  verify/0009.sql (x) lo vigila paso a paso.

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
migración (`0046_outreach`) la escribe `canales` en su primer día y las demás
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
   «terminado cuando» de VEN-15 en `backlog.ts` es el original, sin
   tocar: cambiarlo no le toca al constructor. El cambio del criterio va
   en su `note`, como pendiente del visto bueno de Rasheed (el de esta
   decisión y el de la 7); al aprobarlas, se escribe aquí «Aprobado por
   Rasheed, fecha» y la nota deja de decirlo. **Si
   Rasheed lo rechaza**, volver a la baja global al primer clic es una
   línea en `public_optout` (entregabilidad §8.2, el `INSERT` en
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
   criterio en la nota de VEN-15, pendiente del visto bueno. Si Rasheed prefiere la
   firma, `createOptoutToken` (`@mc/core/outreach/unsubscribe`) es el único
   sitio que la genera; la base seguiría buscando por el sha256.
8. **La plantilla recomendada contra la política por defecto**
   (VEN-10). El motor ya aplica «Mensajes por marca» (4) y «Días entre
   mensajes» (3). La plantilla de §5.3 manda cinco mensajes a dos días
   hábiles: con esos valores se estira y el quinto no sale. Propuesta:
   dejar la política como está (es la conservadora) y recortar la
   plantilla a cuatro mensajes separados tres días, o bajar la
   separación por defecto a dos días.
9. **Sin llave de Anthropic, las respuestas no se clasifican solas
   (VEN-14).** La pieza pedía un «clasificador falso determinista sin
   llave». Se entrega: el clasificador falso existe
   (`createFakeIntentClassifier`, `@mc/core/outreach/intent`) y es el que
   usan las pruebas, la demo embebida y quien pone `OUTREACH_WRITER=fake`
   fuera de producción (con Postgres embebido, una base local o el
   workspace de la demo, la misma regla que el redactor falso); pero sin
   `ANTHROPIC_API_KEY` y sin esa variable, `outbound.intent` **no
   clasifica nada**, salvo las bajas explícitas que ya ve el detector de
   VEN-10. La bandeja lo dice arriba de cada conversación («la
   clasificación con IA no está encendida: léelas tú») y cada respuesta
   sin clasificar se puede «Corregir» a mano con los mismos efectos. Por
   qué: el falso decide por palabras sueltas, y una intención mueve
   negocios, enfría cadencias noventa días y da de baja a una persona
   (irreversible); hacerlo en un espacio de verdad sin que nadie lo sepa
   es peor que no hacerlo. **Estado (25 de septiembre): supuesto
   declarado, pendiente de que Rasheed lo confirme antes de mergear.**
   Por eso VEN-14 está en `en_curso` en `backlog.ts` (pulido r1): el
   criterio, tal como se escribió, no se cumple hasta que la decisión se
   tome.
   El criterio de aceptación de VEN-14 (`done` en `backlog.ts`) sigue
   siendo el original: cambiarlo no le toca al constructor; el supuesto
   está en la `note` de la historia. En la ronda 5 el falso dejó de leer
   «no me interesa» como interés (la regla de la negación va antes y da
   «ahora no», igual que el prompt del modelo), así que lo que sigue en
   pie de este supuesto es solo la pregunta de si un espacio de verdad
   sin llave debe clasificar con palabras. **Si Rasheed lo rechaza**, basta con
   que `intentClassifierFrom` (`apps/worker/src/jobs/ventas/outbound.intent.ts`)
   devuelva `createFakeIntentClassifier()` cuando no hay llave (y la
   bandeja deje de avisar: `outreach_classifier_status` diría `fake`). Lo
   que se pierde entonces: un «ok 👍» o un «ahora estoy con otra marca»
   leído por palabras puede mover un negocio o enfriar una cadencia que
   no tocaba, y nadie lo revisa porque llega como clasificado.

## 9. Los errores de Chief que no vamos a repetir

Están en la auditoría de su equipo y en el código. Cada uno tiene
dueño aquí:

| Lo que pasa en Chief | Cómo queda aquí | Historia |
|---|---|---|
| El mensaje puede salir después de que el contacto respondió (dos crones sin coordinación) | El despachador relee el enrolamiento en la transacción del envío; una respuesta detiene a la persona en todas sus secuencias y pausa a las demás personas de su marca (0059); el webhook de Unipile llega en segundos | VEN-10 |
| Un contacto que responde queda pausado para siempre, incluso por un «fuera de la oficina» | Clasificación de intención con fecha de retorno | VEN-14 |
| «Como te comenté el martes» sobre un mensaje que nunca salió | Toques anteriores leídos de `status = 'sent'` | VEN-12 |
| Los pasos de LinkedIn ignoran «no contactar» | La baja se comprueba por contacto en todos los canales, en el despachador | VEN-10 |
| Sin reintentos: un fallo de red mata el paso y avanza | `attempt_count` y `next_retry_at` con espera creciente | VEN-10 |
| Cuentas de canal sin organización; la conexión puede tomar la cuenta de otro | `workspace_id`, RLS y estado firmado en la hosted auth | VEN-9 |
| El webhook de LinkedIn no valida firma: cualquiera puede pausar cadencias | Secreto compartido y verificación en el webhook | VEN-9 |
| `In-Reply-To` con el id del hilo de Gmail en vez del `Message-ID` | Se guarda y se usa el `Message-ID` real | VEN-9 |
| El refresh token de Google en cuatro sitios; el keepalive deja uno caducado | Una fila por concesión, token en el vault | VEN-9 |
| Desconectar una cuenta la deja viva en el proveedor, cobrando y recibiendo avisos | Desconectar la deja pendiente de soltar (canales_liberar_y_limites) y `sales.channels_release` revoca el permiso de Google o borra la cuenta y sus avisos en Unipile, sin tocar lo que siga vivo en otro espacio | VEN-9 |
| Topes por canal que solo miran el techo del proveedor | La vista `outreach_channel_account_limits` (canales_liberar_y_limites): el máximo de cada cuenta es el menor entre la política del espacio y el proveedor (500 en un Gmail personal) | VEN-9 |
| Un envío que falla por red se reintenta a ciegas y la marca recibe el mensaje dos veces | Los POST que mandan algo a una persona (correo, DM, invitación, comentario, reacción) no se reintentan dentro del conector (`idempotent: false`): el error sube como `transient` y el despachador decide tras mirar el hilo | VEN-9 · VEN-10 |
| Todos los DM del creador (amigos, fans) entran a la base y al clasificador | Una respuesta solo se guarda si es de un toque `sent` de ESA cuenta (`outbound_touch.channel_account_id`, canales_reclamar_al_soltar): por su hilo o, en LinkedIn e Instagram, porque quien escribe es a quien se le envió (`recipient_address` = su provider_id: la invitación aceptada contesta en un chat nuevo); lo demás se ignora sin guardar el cuerpo | VEN-9 |
| El DM que acabamos de enviar vuelve por el aviso de mensajes y entra como respuesta: la cadencia se detiene sola | Es eco si el aviso trae `account_info.user_id` = quien escribe **o** si quien escribe es la identidad de la cuenta (`provider_identity`, canales_identidad_y_rotacion); un mensaje sin remitente se descarta antes que arriesgar la cadencia | VEN-9 |
| La baja pedida al aceptar una invitación de LinkedIn se pierde: la respuesta llega en un chat que no es el del toque | El segundo paso de arriba la reconoce, da de baja la ficha (código `reply_optout:linkedin` en `contact.opted_out_code`, contacto_codigo_de_baja) y cancela lo pendiente en todos los canales | VEN-9 |
| Soltar una cuenta y reconectarla a la vez deja un permiso revocado en una fila «Conectado» | El job reclama la fila antes de hablar con el proveedor (`release_claimed_at`, canales_reclamar_al_soltar) y la conexión responde «espera un minuto» mientras dure; una fila desconectada no presta su ref del vault | VEN-9 |
| El mismo LinkedIn conectado dos veces con dos account_id (cada hosted auth estrena uno): topes sumados y doble cobro | `provider_identity` (connection_params.im.id) único entre las filas vivas de todos los espacios (canales_identidad_y_rotacion): conectado aquí → la cuenta nueva se borra; caído → su fila adopta la nueva; vivo en otro espacio → «ocupada» | VEN-9 |
| Una hosted auth que termina bien en Unipile pero no se conecta aquí (canal equivocado, perfil ocupado, doble clic) deja una cuenta huérfana cobrando | La web la borra en Unipile si nadie la usa (`in_use` de outreach_channel_connect, canales_identidad_y_rotacion); si el borrado falla, el keepalive concilia `listAccounts` contra la base y borra las cuentas de NUESTRA hosted auth sin fila y con más de un día | VEN-9 |
| El aviso de cuenta creada confía en el account_id del cuerpo | Al crear, el `name` de la cuenta (que Unipile guarda tal cual) tiene que ser un estado nuestro con el MISMO nonce y espacio que el del aviso, y la cuenta tiene que haber nacido después de firmarlo; al reconectar, tiene que ser la que se firmó en él. Con un estado válido propio y el account_id de una cuenta ajena del tenant no se liga nada | VEN-9 |
| Un formulario de otra página puede empezar conexiones (crear pendientes y enlaces de hosted auth), sobre todo en modo demo, sin sesión | Los dos inicios por POST rechazan con 403 un `Origin` que no es el de la app ni el de la petición, o un `Sec-Fetch-Site` distinto de `same-origin` | VEN-9 |
| Se ofrece conectar un canal que el espacio no usa, y el proveedor lo cobra cada mes | `outbound_policy.allowed_channels` nace sin Instagram (canales_instagram_apagado_y_semana); la fila de un canal fuera de la lista dice «Apagado en este espacio» con el botón deshabilitado, y el inicio lo rechaza también en el servidor | VEN-9 |
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
secreto con el que se dio de alta (`provider_webhook_secret_fp`, canales_identidad_y_rotacion).
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
(`keepalive_checked_at`, canales_identidad_y_rotacion), de la más vieja a la más nueva, 200
como mucho y cuatro a la vez. Si el job se queda sin tiempo deja de
tomar cuentas y las que quedan van primero en la hora siguiente: cada
cuenta se mira una vez al día aunque haya miles.

**El plan B**, si Unipile pone un techo o lo alcanzamos: UN aviso
global por fuente (sin `account_ids`), con el secreto compartido y sin
ruta firmada. El webhook, tras validar el secreto, resuelve
`account_id` → fila por una función `SECURITY DEFINER` (como las de
callback_de_canales) que devuelve SOLO el workspace y el id de la fila viva con ese
`provider_account_id` (el índice global de cuentas vivas ya garantiza
que es una), y con eso abre la transacción del espacio. Pasar a ese
modo es una migración (la función) y un cambio en `aviso.ts`; las
cuentas existentes se migran borrando sus avisos por cuenta.

### 9.2 Lo que la pantalla de canales le dice al creador

- **Nunca el texto de un proveedor, y nunca una frase en la base.** En
  `last_error` solo van códigos (desde canales_last_error_codigo, un `CHECK` con la forma
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
  queda como código en `contact.opted_out_code` (contacto_codigo_de_baja:
  `reply_optout:<canal>`), y la ficha de Ventas lo traduce. La columna
  `opted_out_reason` sigue siendo del texto de la persona (el «Motivo»
  que escribe al registrar la baja a mano) y de las bajas de 0026 y 0046.
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
  (`daily_limited_by` y `weekly_limited_by` de la vista, canales_instagram_apagado_y_semana).
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
responda así. Tres cosas solo se saben con el servicio de verdad:

1. **Que `GET /accounts/{id}` devuelve en `name` el mismo `name` que se
   mandó al pedir el enlace de hosted auth** (el estado firmado: binario
   y cifrado, ~180 caracteres, ~210 al reconectar; la versión 1 medía
   ~500 y se acortó para dejarle margen a un recorte). La documentación
   de Unipile solo promete que `name` vuelve en el aviso de `notify_url`,
   no en el objeto Account, y el fixture `accounts.get.hosted_auth.json`
   se escribió suponiéndolo. De esto depende ligar una cuenta NUEVA por
   la prueba estricta (`matchAttempt` en `ventas/canales/_lib/aviso.ts`:
   el `name` de la cuenta es un estado nuestro con el mismo nonce). **El
   plan B ya está en el código** por si el supuesto es falso: una cuenta
   cuyo `name` no tiene forma de estado (vacío, el nombre de la persona,
   uno recortado) se liga si nació durante el intento, es del proveedor
   del canal y ninguna fila viva de ningún espacio la nombra
   (`outreach_channel_connect` responde `taken` si no); el registro dice
   «se liga por el plan B». Al recibir el aviso, la cuenta queda anotada
   en la pendiente (`notified_account_id`, migración
   `canales_identidad_y_rotacion` §8), y la conciliación del keepalive
   reconoce por ahí una cuenta nuestra sin mirar su `name`. Lo que el
   plan B pierde frente a la prueba estricta: quien conociera el
   `account_id` de una cuenta ajena recién creada (solo lo ven Unipile y
   nuestro servidor) podría ligarla antes que su dueño. Un `name` con
   forma de estado que no abre nunca cae al plan B. Y una cuenta que no
   es de ese intento no se liga ni se borra: la pendiente de ese nonce
   pasa a «No pudimos confirmar la cuenta que conectaste» (`not_this_attempt`).
2. La forma real del aviso de `notify_url` y del de mensajes (en especial
   `sender.attendee_provider_id` y `account_info`, de los que dependen
   casar la invitación aceptada y reconocer el eco).
3. La del canje de Google.

Por eso VEN-9 queda **bloqueada** hasta grabarlas. La puerta de la
grabación (`outreach-grabacion.test.ts`) mira justo esto: la cuenta
grabada tiene que traer en `name` el estado entero, y el aviso de cuenta
creada tiene que haber LIGADO la cuenta (la respuesta de la web, en
`meta.appReply`, sin `ignored`; un 200 solo no basta: la web también
responde 200 cuando ignora un aviso).

Qué hace falta (Rasheed; ninguna llave se inventa ni pasa por un chat):

1. Un cliente OAuth de Google **propio del outreach** (`GOOGLE_OUTREACH_CLIENT_ID`,
   no el `GOOGLE_CLIENT_ID` de YouTube: una concesión compartida se
   revoca entera al desconectar el correo) en modo **Prueba** con la Gmail API, los
   alcances `gmail.send`, `gmail.modify` y `userinfo.email`, un buzón de
   pruebas como usuario de prueba y dos URI de redirección:
   `<APP_URL>/api/oauth/google/callback` y `http://localhost:8788/callback`.
2. Una cuenta de pruebas de Unipile (tiene periodo gratuito) y un
   LinkedIn de pruebas.
3. Las llaves en `platform/.env.local` (`GOOGLE_OUTREACH_CLIENT_ID`,
   `GOOGLE_OUTREACH_CLIENT_SECRET`, `UNIPILE_DSN`, `UNIPILE_ACCESS_TOKEN`,
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
  trae `connection_params.im.id`, `created_at` y el estado entero en
  `name`, el aviso de cuenta creada trae el estado entero y la web lo
  verificó y ligó la cuenta (`appStatus` 200 y `appReply` sin `ignored`),
  el de mensajes trae quién escribe, el canje trae `refresh_token` y los
  dos alcances, el Message-ID tiene su forma. Si algo no casa, se ajusta
  `parseUnipileWebhook`, `normalizeUnipileAccount` o `normalizeGmailMessage`
  a lo que llegó de verdad.
- VEN-9 pasa a «hecho» en `apps/web/content/backlog.ts` con la fecha de
  la grabación en su nota. `ventas/canales/_lib/grabados.test.ts` no lo
  deja antes: exige las once de `REQUIRED_OUTREACH_RECORDINGS`.

### 9.4 Decisiones y cruces de carpeta

**Las migraciones se citan por su nombre.** Las de canales (de
`canales_outreach` a `canales_instagram_apagado_y_semana`) y la de
entregabilidad nacieron con números que main ya usó con otro contenido.
Por eso el código, sus pruebas y este documento las nombran por lo que
va detrás del número (`canales_identidad_y_rotacion §8`,
`entregabilidad §2`). Desde el pulido r2 la serie entera va detrás de la
0042 de main con su número definitivo (0047–0054 los canales, 0055 la
entregabilidad; §5.2), y las citas por número del resto del código ya
usan esos números.

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

