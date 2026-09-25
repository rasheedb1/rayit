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
| **Instagram DM** | Unipile con usuario y contraseña; reto 2FA de cinco minutos | Mensaje directo, leer bandeja | 100 acciones al día, 10 por hora; empezar bajo | **Opcional, apagado por defecto.** Se enciende por workspace cuando la marca no tiene otro contacto |
| **WhatsApp** | Unipile | Mensaje | Esperar 24 h tras conectar; intervalos cortos entre mensajes | **Fase 2.** Solo para contactos que ya respondieron |

Unipile cobra por cuenta conectada al mes. Es el costo variable
dominante del módulo y hay que modelarlo en el precio por plan: un
creador con correo y LinkedIn son dos cuentas.

Los valores por defecto de `outbound_policy` que ya tenemos (cuatro
toques por empresa, tres días entre toques, veinte correos al día,
ciento ochenta días de enfriamiento tras un no, revisión humana
obligatoria, afirmaciones con origen) son más conservadores que los de
Chief. Se mantienen.

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
- `public_optout` es de `mc_public_share`, como los enlaces de Cotizar,
  y da de baja a la persona en toda la plataforma: la dirección entra en
  `contact_suppression` con `unsubscribe_link`, se marcan la ficha que
  recibió el correo y todas las fichas con esa dirección en cualquier
  workspace, y se cancela lo pendiente (los enrolamientos, con
  `finished_at`). Cancela exactamente `CANCELABLE_TOUCH_STATUSES`
  (`draft`, `scheduled`, `held`): todo lo vivo (`LIVE_TOUCH_STATUSES`)
  menos `processing`. Responde `workspaceId` y `touchId`, que son `null`
  si ya no existen.
- **Cada baja global es atribuible y reversible.** `public_optout` deja
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
  workspace (`outbound_touch_email_invalid`, 0038 §2); y el rescate del
  zombi y el reintento (`processing → scheduled`) pasan esas filas a
  `canceled`, porque la base los rechaza con 23514. Hasta r4 la baja del
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
  uuid en claro; esa llave ya no existe. **Para VEN-10 al integrar:**
  cambiar `newOptoutToken` por `createOptoutToken` + `optoutTokenHash`,
  `withOptoutFooter` por `buildEmailFooter` + `listUnsubscribeHeaders`, y
  borrar su `optoutUrl` duplicado de `@mc/core/outreach/optout.ts`.
  Mientras tanto los dos contratos son compatibles: un token de VEN-10 da
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
  del `Accept-Language` del navegador. El clic va por `public_optout`.
  Después del clic no se promete lo que el producto no cumple: quien
  escribía no puede deshacer la baja (solo un operador, a pedido de la
  persona), así que el «listo» da `SUPPORT_EMAIL` como la vía para
  deshacerla por error, y sin él no ofrece ninguna. El POST de un clic
  de Gmail va a `/baja/<token>/un-clic`, que acepta el cuerpo en
  `multipart/form-data` (el SHOULD de la RFC 8058 §3.1) y en
  `application/x-www-form-urlencoded` (lo que manda Gmail).
- **La baja por enlace va en dos tiempos (ronda 3, 0038 §8).** Sin
  sesión nadie sabe quién pulsa: el propio creador, en una ventana
  privada o con un `curl` a `/un-clic`, suprimía a la marca para toda la
  plataforma. Ahora el clic vale YA para el espacio que envió ese correo
  (`outbound_workspace_optout`: no le vuelve a escribir por ningún canal,
  se cancela lo suyo y se marca su ficha si es propia) y pasa a
  `contact_suppression` (toda la plataforma, como decía 0007) cuando la
  confirma un SEGUNDO espacio: la misma dirección pulsa el enlace de un
  correo de otro creador. Eso el remitente no lo puede fabricar sin que
  otro espacio le haya escrito de verdad. **Desde la ronda 4 ese segundo
  espacio tiene que ser de OTRAS personas:** uno que comparte algún
  miembro con el primero no confirma nada (una agencia, o cualquiera que
  sea miembro de dos espacios que escriben a la misma marca, pulsaba sus
  dos enlaces y la suprimía para todos). La política
  `membership_public_optout` abre, solo mientras dura la llamada, las
  membresías de esos espacios y de ninguno más. Lo que queda abierto es
  el sabotaje de dos personas distintas en connivencia, y eso ya no es un
  clic: queda en `outbound_optout_event` para verlo y deshacerlo. La base
  guarda el motivo como código (`contact.opted_out_reason =
  'unsubscribe_link'`, `outbound_policy.disabled_reason = 'manual'`) y la
  pantalla lo traduce. No se usa «una ventana corta
  sin señal del remitente»: la única señal sería la IP o el navegador de
  sus sesiones, que la plataforma no guarda, y con una ventana el
  remitente por VPN volvía a suprimir a la marca, solo que más tarde.
  **Pendiente de la firma de Rasheed (§8, decisión 6):** una persona que
  pide la baja a un solo creador deja de recibir mensajes de ese creador,
  no de todos; la ley (CAN-SPAM, RGPD) pide lo primero.
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
  FakeGmail. **Falta al integrar VEN-9:** construir el `GmailApi` de cada
  cuenta (con su token del vault) en `bouncesMailboxFor`
  (`outbound.bounces.ts`), que devuelva `gmailBounceMailbox(api)`, y poner
  `BOUNCE_READING_CONNECTED` (`@mc/core/outreach/deliverability`) en
  `true`. **Condición de integración, con dueño (r5):** quien integre
  VEN-9 en `rasheed/integracion` (el integrador de la fase, con Rasheed
  como responsable de la historia) hace esos dos cambios en el mismo
  merge y deja en verde la prueba «cuando llegue el conector…» de
  `outbound-bounces.test.ts`; hasta entonces VEN-15 queda `bloqueada` en
  el backlog y la mitad de los rebotes no funciona en producción. Hasta
  entonces cada cuenta sale como «canal no configurado», la alerta
  diaria trae `outreach_bounces_unread`, y `/ventas/politica` dice en
  «Salud de hoy» que la lectura de rebotes no está conectada. Desde r5
  eso lo decide el cursor de cada Gmail (`readSendReadiness.
  bouncesReading`): «todavía no leemos» si un buzón no se leyó nunca, y
  «la lectura está parada desde…» con la hora si el cursor tiene más de
  dos horas; `BOUNCE_READING_CONNECTED` queda solo como interruptor del
  job. Así, un job parado después de la integración no vuelve a enseñar
  «Ningún rebote» como si todo fuera bien. Una prueba del worker (`outbound-bounces.test.ts`) falla
  en cuanto exista `packages/connectors/src/gmail.ts` y el job registrado
  siga sin leer. La hora de cada aviso es la de llegada al buzón
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
  pasada** (`sweepInvalidEmail`), el job cancela lo que quede en draft,
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
  `SMTP_URL`: sale en la primera corrida del día que tenga algo que
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
  lleva a la lista de cuentas caídas de `/ventas/politica#cuentas` (lo
  que dijo el proveedor y el paso para volver a enviar) hasta que exista
  `/ventas/canales` (se cambia en `CANALES_URL`,
  `apps/worker/src/jobs/ventas/messages.ts`); mientras, esa lista dice
  dónde se hace (con `SUPPORT_EMAIL`, a quién escribir para reconectar).
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
retomar en la fecha. Baja: `contact.opted_out` global, y nadie en la
plataforma vuelve a escribirle. Referido: se crea el contacto y se
propone enrolarlo. Nada queda pausado para siempre.

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
6. **Alcance de la baja por enlace (VEN-15, ronda 3).** Hoy va en dos
   tiempos: el clic vale para el creador que envió ese correo, y pasa a
   toda la plataforma cuando la persona pide la baja a un segundo
   creador (0038 §8). Es lo que cierra el sabotaje del remitente que
   pulsa su propio enlace sin sesión. La alternativa —toda la plataforma
   al primer clic, descartando los clics que vengan de las IP de las
   sesiones del remitente— pide guardar la IP de cada sesión de cada
   miembro, que hoy no se guarda. Propuesta: quedarse con los dos
   tiempos. **Estado (ronda 4): implementado así y pendiente de su
   firma.** Un agente no puede cerrarla por él. Si la aprueba, el
   «terminado cuando» de VEN-15 en `backlog.ts` pasa a «un clic da de
   baja con quien envió, y en toda la plataforma cuando un segundo
   creador lo confirma». Si no, se vuelve al alcance global del primer
   clic, que la ronda 4 ya deja menos expuesto: el segundo espacio no
   puede compartir miembros con el primero, y el mismo filtro serviría
   para el primer clic.
7. **El token de baja: opaco, no firmado (VEN-15, ronda 2).** La pieza
   pedía un «token de baja firmado por contacto y workspace». Se entrega
   un token opaco (32 bytes al azar) que la base reconoce por su sha256
   en `outbound_optout_link`: no lleva ningún id dentro (un enlace
   reenviado no enseña a quién ni desde dónde), no depende de un secreto
   (un `OUTREACH_OPTOUT_SECRET` mal configurado o rotado habría apagado
   la baja de toda la plataforma, y la ley pide que el enlace funcione al
   menos 30 días), y es la misma forma que ya genera el despachador de
   VEN-10. El contacto y el workspace no viajan en el token: los guarda
   la fila del enlace, que solo escribe el despachador. Propuesta:
   quedarse con el token opaco. **Estado (ronda 5): implementado así y
   pendiente de su firma, junto con la 6.** Si Rasheed firma las dos, el
   «terminado cuando» de VEN-15 en `backlog.ts` se reescribe con los dos
   cambios a la vez (la baja con quien envió y en toda la plataforma al
   confirmarla un segundo creador; el enlace por token opaco).

## 9. Los errores de Chief que no vamos a repetir

Están en la auditoría de su equipo y en el código. Cada uno tiene
dueño aquí:

| Lo que pasa en Chief | Cómo queda aquí | Historia |
|---|---|---|
| El mensaje puede salir después de que el contacto respondió (dos crones sin coordinación) | El despachador relee el enrolamiento en la transacción del envío; el webhook de Unipile llega en segundos | VEN-10 |
| Un contacto que responde queda pausado para siempre, incluso por un «fuera de la oficina» | Clasificación de intención con fecha de retorno | VEN-14 |
| «Como te comenté el martes» sobre un mensaje que nunca salió | Toques anteriores leídos de `status = 'sent'` | VEN-12 |
| Los pasos de LinkedIn ignoran «no contactar» | La baja se comprueba por contacto en todos los canales, en el despachador | VEN-10 |
| Sin reintentos: un fallo de red mata el paso y avanza | `attempt_count` y `next_retry_at` con espera creciente | VEN-10 |
| Cuentas de canal sin organización; la conexión puede tomar la cuenta de otro | `workspace_id`, RLS y estado firmado en la hosted auth | VEN-9 |
| El webhook de LinkedIn no valida firma: cualquiera puede pausar cadencias | Secreto compartido y verificación en el webhook | VEN-9 |
| `In-Reply-To` con el id del hilo de Gmail en vez del `Message-ID` | Se guarda y se usa el `Message-ID` real | VEN-9 |
| El refresh token de Google en cuatro sitios; el keepalive deja uno caducado | Una fila por concesión, token en el vault | VEN-9 |
| Sin `List-Unsubscribe`, sin pie de baja, sin rebotes asíncronos | VEN-15 completa | VEN-15 |
| Un `owner_id` escrito a mano en el validador de similitud | Filtro por workspace | VEN-12 |
| Ventana 09:00–16:59 en UTC en vez de la zona de la cadencia | Zona del workspace, una sola implementación en `core` | VEN-10 |
| Métricas de LinkedIn siempre en cero por un valor de estado que viola el `CHECK` | Las vistas se prueban contra datos reales en el CI | VEN-16 |
| Tres listas de variables de plantilla distintas y un renderizador muerto | Un solo renderizador en `core`, con pruebas | VEN-12 |
| Envíos masivos en bucles del navegador con tres segundos de espera | Todo envío pasa por la cola del worker | VEN-10 |
| Aprobación por WhatsApp que caduca a las cuatro horas sin escalar | Bandeja en la app, sin caducidad; el toque espera | VEN-14 |
