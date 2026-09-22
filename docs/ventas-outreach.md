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
| Funciones `increment_if_under_cap` e `increment_weekly_*` por `action_type` | Migración `0015_outreach.sql`, mismas funciones por workspace | Se corrige el bloqueo: el `FOR UPDATE` de la semanal bloquea la fila de hoy pero cuenta la semana entera |
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

### 5.2 El modelo de datos: migración `0015_outreach.sql`

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
| VEN-9 | **Canales de outreach.** Migración `0015` (tablas de la sección 5.2), conector de Unipile con hosted auth y webhook firmado para LinkedIn e Instagram, OAuth de Google con `gmail.send` y `gmail.modify`, pantalla de canales con estado, límites y keepalive diario. | L | CIM-2, CIM-3 | Un creador conecta su Gmail y su LinkedIn; el token de Google se refresca solo; una cuenta caída se ve en rojo con el botón de reconectar. |
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
migración `0015` la escribe `canales` en su primer día y las demás
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
