# Proyecto: crecimiento y monetización de influencers y agencias

Cuaderno vivo del proyecto. Se actualiza en cada conversación. Lo que dice **ABIERTO** está por decidir; lo que dice **DECIDIDO** lleva fecha.

Última actualización: 16 sep 2026 (cuarta ronda: competencia, sección 13).

## 1. Visión

Un producto que ayuda a dos clientes distintos:

1. **Influencers**: crecer (qué publicar, cuándo, en qué formato) y monetizar (saber cuánto cobrar, cotizar, cerrar deals, cobrar).
2. **Agencias de influencers** que hacen community management para varias marcas: producir contenido, medir, reportar y entregar reportes a sus clientes.

El núcleo común es **análisis de datos de video**:

- **Interno**: las cuentas del cliente (métricas propias, audiencia, qué le funciona).
- **Externo**: tendencias de nichos específicos para traer recomendaciones.

Relación con MultiCampaign: comparte los conectores a las APIs, el esquema de métricas y el dashboard. MultiCampaign es la red propia de cuentas; este proyecto es el producto para terceros. Todo lo verificado en [investigacion-apis.md](investigacion-apis.md) aplica aquí (auditorías, límites, demografía por video solo en YouTube, TikTok personal vs. Business).

**Hilo que une las ideas (16 sep, segunda ronda)**: cotizar, conseguir marcas, cobrar, manejar gastos y flujo de caja son un solo problema. El producto puede ser el **back office comercial y financiero del influencer**, y el que demuestra a la marca lo que la campaña produjo (sección 8). Eso refuerza la vía del money flow en la sección 3.

## 1b. Mock del producto

Publicado el 16 sep 2026 como Artifact: [dashboard/creadores-mock.html](../dashboard/creadores-mock.html) → https://claude.ai/artifact/Gw6u4k7MorX6fRHBFPBhCW (actualizar ese Artifact, no crear otro). Nueve módulos con datos simulados: Resumen, Mis videos, Tendencias del nicho, Ideas y guiones, Cotizar, Campañas, Ventas (radar + CRM, sustituye a Marcas desde la quinta ronda), Finanzas y Vista agencia. Usa la misma identidad visual de MultiCampaign (paleta validada, acento violeta, Archivo).

Versión local con diseño minimal tipo Vercel/Notion (blanco, negro, grises, Geist y Geist Mono, bordes finos, sin sombras, con botón de tema): [dashboard/local/](../dashboard/local/). Se sirve con `python3 -m http.server 4173 --bind 127.0.0.1` desde esa carpeta y se abre en http://localhost:4173. Comparte el mismo JavaScript que el Artifact; solo cambia la hoja de estilos. Se regenera con `python3 dashboard/build-local.py` después de editar el Artifact.

### Dirección visual y marca (sexta ronda, 16 sep 2026) — ABIERTO

Exploración publicada como Artifact: [dashboard/direcciones-visuales.html](../dashboard/direcciones-visuales.html). Referentes verificados: Vercel Geist (Geist Sans/Mono, principios suizos, en Google Fonts), Stripe (Söhne ss01, índigo #533afd, lienzo blanco, cifras tabulares), Linear (Inter Variable + Berkeley Mono, temas LCH desde base + acento + contraste, oscuro nativo), Notion (Inter modificada, grises cálidos #f6f5f4/#31302e, azul solo en lo interactivo), Attio (dashboard nativo de IA que prioriza), shadcn/ui (Base UI por defecto desde jul-2026, Tremor para gráficos).

Tres direcciones implementadas como hojas de estilo completas en `dashboard/local/`, con selector en la barra superior:

| Dirección | Archivo | Idea | Tipografía | Acento |
|---|---|---|---|---|
| Geist | styles.css | Blanco, negro, gris; infraestructura | Geist + Geist Mono | Negro |
| Signal (recomendada) | theme-signal.css | Lienzo gris frío, tarjetas con sombra mínima; Stripe/Linear | Instrument Sans + JetBrains Mono | Violeta #5A4FCF (hereda el de MultiCampaign) |
| Studio | theme-studio.css | Papel cálido, serif en titulares y cifras; Notion editorial | Newsreader + Figtree | Tinta negra; verde solo positivo |

Recomendación de Claude: **Signal para el producto, Studio para los documentos que ven las marcas (media kit, cotización, reporte), Geist como modo denso**. Marca: los cuatro puntos como sello, un solo acento violeta, estado en verde/ámbar/rojo, voz precisa y cómplice. Pendiente: nombre del producto (corto, bilingüe, dominio libre, sin "creator"), afinar el violeta en LCH, decidir si el oscuro es el predeterminado.

Mejoras de UX independientes del estilo, en orden: paleta de comandos ⌘K, cambio de espacio creador ↔ agencia, estados vacíos que enseñan, onboarding en lista de tareas; después "por qué este número", bandeja de notificaciones, vistas guardadas, densidad ajustable, navegación móvil inferior, atajos visibles.

Hallazgo de competencia: Beacons ya incluye media kit con IA, facturación de deals y outreach a marcas con IA en su plan gratuito (Pro subió de 9 a 15 USD en nov-2025). Nuestra diferencia: métricas con puntaje frente a la mediana + tendencias del nicho que terminan en guion + radar que alimenta el CRM y el reporte, en español y con pesos.

Decisión: pendiente (elegir dirección probando las tres en el localhost).

Lo que el mock ya decide de forma implícita y conviene confirmar o cambiar:

- El puntaje central de todo el producto es **× mediana** (views del video sobre la mediana de su propia cuenta), tanto para lo interno como para el nicho.
- Las ideas se explican con evidencia etiquetada **Tuyo** (interno) o **Nicho** (externo) y traen una probabilidad de superar 2× la mediana.
- El guion sale en la rejilla de 9 bloques × 10 s de MultiCampaign, con roles hook, build, giro y cierre y conteo de palabras por bloque.
- La cotización muestra la fórmula (views promedio × CPM del nicho × ajustes) y no esconde el rango.
- El reporte de campaña incluye una lista de "acordado antes de publicar" con lo que falta de la marca.

## 1c. Construcción (arranca el 20 sep 2026)

El código vive en [platform/](../platform/). Ver [arquitectura.md](arquitectura.md) y [plan-equipo.md](plan-equipo.md).

Estado: **base de datos lista y verificada** (doce migraciones, 86 tablas, 10 vistas, 209 índices), entorno local con un comando, CI que valida el esquema sin levantar servicios, y el paquete de puntajes con pruebas.

### Dos hallazgos de investigación que cambiaron el diseño

**1. TikTok sí entrega retención segundo a segundo.** No por la Display API de la que habla todo el mundo (dieciséis campos, cuatro contadores) sino por la **Accounts API** de TikTok for Business, con el permiso `video.insights`: `video_view_retention` (porcentaje que sigue viendo en cada segundo), `engagement_likes` (likes por segundo del timeline), fuente de las vistas, y **demografía por video**. Son dos aplicaciones y dos trámites distintos. Detalle en [research/tiktok-api-campos.md](research/tiktok-api-campos.md). Corrige lo que creíamos en agosto.

**2. Predecir views desde el contenido no funciona; predecir retención sí.** En el SMP Challenge 2025 quitar los rasgos del creador degradó el error un 72 %, y quitar todo el contenido visual solo un 4 %. En SMTPD (CVPR 2025) la variable más predictiva son las views del primer día, que no existen antes de publicar. En cambio, el reto VQualA 2025 (ICCV, 120 mil videos, arranque en frío) alcanzó Spearman 0,71 prediciendo **retención temprana** solo con contenido. Detalle en [research/analisis-video.md](research/analisis-video.md).

Consecuencia: el laboratorio de video predice retención, no views. Y como TikTok nos da la curva real, el modelo se calibra contra la verdad medida en vez de contra folclore.

**3. Descargar el mp4 de TikTok está prohibido por sus términos.** Por eso el creador sube su máster a la plataforma, lo analizamos antes de publicar y publicamos nosotros por API. No es un rodeo: es lo que hace que el análisis ocurra cuando todavía sirve.

### Laboratorio de video: los filtros quedaron definidos

Veintiséis reglas en la tabla `preflight_rule`, cada una con su umbral, su severidad y **la procedencia del umbral**: especificación de plataforma, investigación publicada, datos internos o criterio del oficio. Trece tienen fuente dura (el PDF de consejos creativos de TikTok for Business y las constantes del detector ABCDs de Google, que es código abierto). Las otras trece están marcadas como criterio y la interfaz lo dice.

Lo que **no** vamos a repetir: la cifra de que "el 71 % de si te siguen viendo se decide en tres segundos" circula en toda la industria y no tiene fuente primaria localizable.

### Camino crítico: tres trámites

El **Accounts API Access Application Form** de TikTok es obligatorio desde el 20 de marzo de 2026 y va antes de la revisión de la app. Más App Review de Meta y auditoría de Google. Sin dueño asignado a hoy.

## 2. Qué le damos a cada segmento

### Influencers

- Panel de métricas propias cruzando redes.
- Recomendaciones: qué está funcionando en su nicho y qué de lo suyo funciona (sección 4.3).
- Onboarding de monetización → media kit → cotizaciones (sección 5).
- Búsqueda de marcas, inbound y outbound (sección 7), con radar de prospección continua y CRM (sección 7b).
- Cobro, gastos y flujo de caja (sección 6).
- Reporte de resultados de cada campaña a la marca que lo contrató (sección 8).
- Ideas y guiones de contenido con IA.

### Agencias (lista del 16 sep)

- Generación de contenido.
- Generación de métricas.
- Formas de llegar mejor al usuario.
- Reporteo.
- Cómo se envían los reportes a los clientes de la agencia.

Propuestas para aterrizar esa lista: espacios por marca, calendario y flujo de aprobación con el cliente, generación de contenido con voz de marca, reportes automáticos semanales/mensuales con marca blanca, envío por correo o WhatsApp con enlace, portal donde el cliente ve sus números, alertas cuando algo se dispara o se cae.

## 3. Monetización — ABIERTO

Pregunta original: ¿estar dentro del money flow y cobrar al influencer por transacción, cobrar suscripción mensual, u otra cosa?

| Modelo | Cómo cobra | A favor | En contra |
|---|---|---|---|
| Suscripción mensual | Plan por número de cuentas, marcas o asientos | Predecible, simple, es lo que las agencias ya pagan hoy | El influencer promedio paga poco por herramientas |
| Take rate en el money flow | % del deal que se cobra a través de la plataforma | Escala con el valor generado; es el moat a largo plazo | Exige marketplace, pagos, confianza y volumen; no arranca solo |
| Créditos por uso | Cobrar el contenido generado con IA | Cubre el costo real de generación | Ingreso variable |
| Por marca gestionada | La agencia paga por cada cliente activo | Se alinea con el ingreso de la agencia | Hay que definir qué es "activo" |
| Add-ons | Reportes marca blanca, portal de cliente, más usuarios | Sube el ticket sin subir el plan base | |
| Servicio gestionado | Fee mensual por hacerlo nosotros | Ingreso desde el día 1 y aprendizaje directo | No escala; sirve para validar |
| Adelanto de pagos | Fee por pagarle al influencer antes de que pague la marca | Margen alto, dolor real (las marcas pagan a 60-90 días) | Riesgo de crédito y regulación |

**Propuesta inicial (Claude, 16 sep)**: híbrido por etapas.

1. **Etapa 1**: suscripción a agencias (son quienes tienen el dolor de reportar y ya pagan herramientas) y plan gratuito o muy barato a influencers para construir base. Créditos por contenido IA para no perder plata.
2. **Etapa 2**: cuando exista el ciclo cotización → deal → pago dentro del producto, take rate sobre lo que pasa por ahí. La cotización es la puerta natural.
3. **Etapa 3**: adelanto de pagos como producto financiero, si el volumen lo justifica.

Decisión: pendiente.

## 4. Datos

### 4.1 Internos (cuentas del cliente) — ABIERTO

Pregunta original: ¿conectarse al ad manager de cada cuenta con permisos, o cómo debería ser mejor?

Respuesta propuesta:

- **Ad manager no es la vía para lo orgánico.** Meta Ads, TikTok Ads y Google Ads solo dan datos de pauta. Las métricas orgánicas (views, retención, audiencia) salen de las APIs de creador: TikTok Display/Business API, Instagram Graph API, YouTube Analytics API. El ad manager se conecta solo si el cliente hace pauta y quiere verla junto.
- **Influencer individual**: botón "conectar cuenta" con OAuth por plataforma. Es lo que hacen Metricool, Later o Hootsuite. El influencer autoriza y nosotros leemos.
- **Agencia**: el acceso ya existe a nivel Business Portfolio (Meta) y Business Center (TikTok). Un solo token de system user cubre todas las páginas e IG que la agencia gestiona. La marca le da acceso de partner a la agencia, no a nosotros.
- **Atajo para arrancar**: agregadores con apps ya auditadas. Phyllo está hecho para datos de creadores (incluye demografía de audiencia con consentimiento del creador). Ayrshare cubre publicación y analítica. Cuestan por cuenta conectada, pero evitan meses de auditoría.
- **Restricciones que ya conocemos**: demografía edad/sexo por video solo en YouTube; en TikTok la demografía por API exige cuenta Business y los influencers que monetizan con Creator Rewards tienen cuenta personal; sin auditoría propia los tokens y alcances quedan limitados.

Decisión: pendiente.

Los campos concretos de Instagram están en el Anexo A.

### 4.2 Externos (tendencias por nicho) — propuesta

Fuentes:

- TikTok Creative Center: hashtags, sonidos y creadores en tendencia por país e industria, público.
- YouTube Data API: búsqueda pública por palabra clave con views y fechas, sin auditoría.
- Instagram: Business Discovery (métricas de cuentas ajenas) y hashtag search (30 hashtags por semana). Ver Anexo A, parte E.
- Google Trends.
- Herramientas de Higgsfield ya disponibles: predictor de viralidad, música en tendencia en TikTok, análisis de video.

Método: lista de vigilancia por nicho (cuentas de referencia + hashtags) → snapshot diario → detectar videos que crecen por encima de la mediana de su cuenta → analizar hook, formato, duración, sonido → recomendaciones concretas al cliente.

### 4.3 Cómo analizamos videos para encontrar lo que tienen en común y recomendar

Pregunta del usuario (16 sep): veamos cómo analizamos ciertos videos, cosas en común, para dar recomendaciones.

**Paso 1. Definir "funcionó" de forma relativa, no absoluta.** Las views absolutas premian a las cuentas grandes. El puntaje que sirve es views del video dividido por la mediana de views de los últimos 20 o 30 videos de esa misma cuenta, medido a la misma edad (48 h, 7 días). Un video con puntaje mayor a 2 o 3 es un outlier. Es el método que usan 1of10 y ViewStats en YouTube y funciona igual en TikTok e Instagram.

**Paso 2. Extraer rasgos de cada video.** Tres capas:

| Capa | Rasgos | De dónde salen |
|---|---|---|
| Metadatos | Duración, día y hora, caption, hashtags, sonido (música vs. original), colaboradores, carrusel o video, etiqueta IA | API de la plataforma |
| El video en sí | Hook (qué se dice y qué se ve en los primeros 3 s), texto en pantalla, cortes por cada 10 s, rostro o no, subtítulos, CTA al final, estructura (lista, historia, tutorial, opinión, reacción), tono, tema | IA multimodal sobre fotogramas y audio: Higgsfield video analysis, Claude con visión, transcripción con Whisper o ElevenLabs |
| Reacción | Sentimiento de comentarios, preguntas repetidas, ratio de saves y shares sobre views | API + clasificación con IA |

**Paso 3. Comparar outliers contra el resto** dentro del nicho o de la cuenta: en qué rasgos aparecen más los outliers (lift). Con 100 a 300 videos basta con frecuencias; con miles se entrena un modelo.

**Paso 4. Traducir a recomendaciones concretas**, no a estadística. Ejemplo del tono buscado: "En tu nicho, 7 de los 10 videos que más crecieron abren con una pregunta y duran menos de 35 s. Tus últimos 20 abren con saludo y duran 60 s." Y a continuación tres ideas con guion listo, usando la rejilla de miniclips de MultiCampaign donde aplique.

**Paso 5. Pre-check antes de publicar.** El predictor de viralidad de Higgsfield y el mismo extractor de rasgos sirven para evaluar un video antes de subirlo y sugerir cambios en hook o duración.

**Restricción real**: el archivo de video externo se consigue fácil en TikTok y YouTube (enlaces públicos). En Instagram no: los enlaces exigen login y la API solo entrega el archivo de los medios propios del usuario conectado. El análisis de video externo arranca por TikTok y YouTube; en Instagram se trabaja con métricas y captions ajenos, y con video solo de cuentas conectadas.

## 5. Onboarding de monetización → cotizaciones

Flujo propuesto:

1. Conecta sus cuentas (sección 4.1).
2. Declara nicho, país, idioma y tipos de contenido que hace.
3. Calculamos: seguidores, views promedio, engagement, demografía y geografía de audiencia.
4. Elige entregables: historia, reel, video dedicado, integración, derechos de uso, exclusividad, paquetes.
5. Sugerimos rango de precio por entregable a partir de un CPM de referencia por nicho y país, ajustado por engagement y demografía.
6. Sale un media kit y una cotización compartibles (enlace o PDF) para mandar a la marca.

Esto es el gancho más fuerte para influencers ("cuánto cobro" es su pregunta número uno) y la puerta al money flow.

Pendiente: definir la tabla de CPM de referencia por nicho y país, y validar con influencers reales.

## 6. Carga operativa y financiera — ideas

Pregunta del usuario (16 sep): cómo quitarles carga operativa, sea financiera, gastos y flujo de caja.

Lo que hoy hace el influencer a mano o no hace:

- **Cotizar → contrato → factura → cobrar** desde un solo lugar. La factura sale con los datos fiscales correctos y el contrato con entregables, fechas, derechos de uso y exclusividad.
- **Cuentas por cobrar**: qué marca debe cuánto y desde cuándo, con recordatorios automáticos. Las marcas pagan a 30, 60 o 90 días.
- **Flujo de caja proyectado**: deals cerrados más fechas esperadas de pago, menos gastos recurrentes (editor, community manager, software, viajes, equipo).
- **Gastos**: registro con foto del recibo y categorías típicas del creador, para deducir.
- **Impuestos**: apartar automáticamente un porcentaje de cada cobro y avisar de las fechas de declaración. Varía por país; arrancar por uno.
- **Ingresos de plataformas** (Creator Rewards, AdSense, bonos de Reels) consolidados en un solo panel, por API o carga de CSV.
- **Pagos a su equipo** desde la misma cuenta.
- **Adelanto de pagos** sobre facturas a marcas conocidas (sección 3, etapa 3).

Referentes en Estados Unidos: Karat, Creative Juice, Lumanu. En Latinoamérica no hay un jugador claro. Esta capa es la que justifica cobrar por transacción.

## 7. Cómo consiguen marcas: inbound y outbound — ideas

Pregunta del usuario (16 sep): ¿cómo buscan marcas nuevas? ¿Siempre inbound? ¿Se puede outbound?

**Inbound hoy**: DM, correo del perfil, agencias, marketplaces (TikTok Creator Marketplace, Instagram Creator Marketplace, Collabstr, Upfluence). El influencer espera.

**Outbound sí se puede**, y se puede automatizar en gran parte:

1. **Detectar marcas que ya pagan influencers en el nicho**: posts con etiqueta de colaboración pagada, #ad, #publicidad, y menciones de marca en cuentas del nicho (Business Discovery, hashtag search, TikTok público).
2. **Detectar marcas que están pautando**: la Biblioteca de anuncios de Meta es pública y muestra qué marcas tienen anuncios activos por país. TikTok Creative Center tiene "Top Ads". Una marca que paga anuncios tiene presupuesto de marketing.
3. **Construir la lista con contacto**: equipo de marketing en LinkedIn, correo de prensa o de agencia.
4. **Pitch personalizado** con media kit, cotización y una referencia concreta: "así le fue a otro creador de mi nicho con ustedes".
5. **Seguimiento** con recordatorios y estado por marca (pipeline simple).

Lo mismo sirve para agencias que buscan marcas nuevas para sus creadores.

## 7b. Ventas: prospección continua que alimenta un CRM

Pedido del usuario (16 sep, quinta ronda): un módulo de ventas donde el influencer prospecte de forma continua empresas que puedan traerle campañas, y que eso alimente un CRM para influencers.

**Principio**: el influencer no debería buscar marcas; el radar las trae cada día y él solo aprueba, descarta y atiende los seguimientos que vencen. Diez minutos diarios. Todo lo que se aprueba entra al pipeline con una siguiente acción y una fecha. Nada queda sin dueño ni sin fecha.

### Radar (prospección continua)

Fuentes que corren cada madrugada, quitan duplicados y califican:

| Fuente | Qué detecta | Público |
|---|---|---|
| Biblioteca de anuncios de Meta | Marcas con pauta activa por país y categoría | Sí |
| Cuentas vigiladas del nicho | Colaboraciones pagadas con creadores parecidos | Sí (captions y etiquetas) |
| TikTok Creative Center · Top Ads | Marcas que pautan en TikTok por país | Sí |
| Marketplaces (TikTok Creator Marketplace, Instagram) | Marcas que buscan creadores del nicho | Con cuenta |
| Vacantes de influencer marketing (LinkedIn) | Empresas que están armando equipo para esto | Sí |
| Prensa y lanzamientos del sector | Productos nuevos que necesitan difusión | Sí |
| Calendario de temporada | Fechas comerciales (Amor y Amistad, Halloween, Navidad) | Sí |

Criterios de calificación: nicho, país, presupuesto estimado (por volumen de pauta y tamaño), encaje de audiencia (coincidencia demográfica entre la marca y el creador), recencia de la señal. Solo se muestran las que superan el umbral.

### Pipeline (el CRM)

Etapas con probabilidad por defecto: Nuevo 5 % → Contactado 15 % → En conversación 35 % → Propuesta enviada 55 % → Negociación 80 % → Ganado / Perdido. Cada deal tiene empresa, entregables, valor, probabilidad, fecha esperada de cierre, fuente, último contacto y **siguiente acción con fecha**. Tablero kanban y vista de lista. KPIs: señales por revisar, deals abiertos y valor, cierre ponderado, ganado en el trimestre, tasa de respuesta, seguimientos vencidos.

### Ficha de empresa

Contactos (nombre, rol, canal, último contacto), línea de tiempo de toda la actividad desde que el radar la detectó, secuencia de toques (pitch → +3 d → +7 d → +14 d → +30 d), "lo que sabemos" (pauta, historial, lanzamientos, temporada) y la cadena Deal → Cotización → Campaña → Factura → Cobro, que conecta este módulo con los de cotizar, campañas y finanzas.

### Modelo de datos

Empresa, Contacto, Señal (fuente, fecha, encaje, presupuesto estimado, estado), Deal (etapa, valor, probabilidad, cierre esperado, fuente), Actividad, Tarea (siguiente acción), Secuencia. La señal crea o actualiza la empresa; el deal ganado crea la cotización aceptada, la campaña y la factura.

### Para agencias

El mismo CRM con un roster de creadores: cada deal se asigna a uno o varios creadores, la relación con la marca es de la agencia, y el radar filtra por los nichos de todo el roster.

Estado en el mock: implementado como módulo "Ventas" con tres vistas (Radar, Pipeline, Empresa). Reemplaza al módulo "Marcas", cuya tabla de prospectos vive ahora dentro del Radar.

## 8. Resultados de campaña: qué le entrega el influencer a quien lo contrató

Pedido del usuario (16 sep, tercera ronda): tener métricas sobre el resultado de cada campaña para que el influencer sepa qué debe entregar a quien lo contrató, con las mejores métricas posibles de cuánto ayudó a vender y cuánto hizo crecer en seguidores, y así justificar mejor las campañas que hace.

**Principio**: el influencer controla la mitad del embudo (lo que pasa en su cuenta). Lo que pasa en la cuenta y en la caja de la marca exige algo que la marca ponga (código, enlace, datos de ventas) o un proxy público. La medición se acuerda antes de publicar, no después. Eso es lo que convierte el reporte en justificación.

### 8.1 Objeto "campaña"

Marca, entregables, fechas, posts asociados (se detectan por fecha y mención, o se eligen a mano), código de descuento y enlace rastreado generados desde la plataforma, y el acuerdo de qué métricas se reportan y cuándo.

### 8.2 Métricas por nivel

| Nivel | Métrica | De dónde sale | ¿Necesita a la marca? |
|---|---|---|---|
| Contenido | Views, alcance, likes, comentarios, guardados, compartidos, tiempo de reproducción, tasa de salto | API del influencer | No |
| Audiencia nueva | % del alcance en no seguidores, visitas al perfil, seguidores ganados desde el post | API del influencer (Instagram lo da por post) | No |
| Quién lo vio | Demografía de la cuenta (edad, sexo, país, ciudad); en YouTube por video | API del influencer | No |
| Tráfico | Clics en el enlace rastreado, país, dispositivo, hora | Enlace corto propio con UTM | No |
| Crecimiento de la marca | Seguidores de la cuenta de la marca antes, durante y después, contra su línea base | Snapshot diario público: Business Discovery (Instagram), estadísticas de canal (YouTube), perfil público (TikTok) | No |
| Interés | Búsquedas del nombre de la marca, menciones y uso de su hashtag | Google Trends, hashtag search | No |
| Ventas | Canjes del código, pedidos con el UTM, ingresos atribuidos | Integración de la marca con Shopify, WooCommerce, VTEX o Tiendanube; postback; o CSV de pedidos | Sí |
| Ventas sin integración | Lift: ventas de la ventana de campaña contra las 4 semanas previas | CSV de ventas diarias de la marca | Sí |
| Eficiencia | CPM y CPV reales (costo sobre views), costo por seguidor ganado, CPA si hay ventas, EMV | Cálculo nuestro | No |

### 8.3 Cómo se captura

- Las métricas por post en Instagram y TikTok son acumuladas. Hay que tomar snapshot diario y guardarlo para tener la curva y los cortes a 24 h, 72 h, 7 y 30 días.
- Los seguidores de la marca se empiezan a medir mínimo 2 semanas antes de la campaña para tener línea base.
- Cada resultado se compara con la mediana propia del influencer ("esta campaña alcanzó 1,8 veces tu alcance habitual") y con el nicho.

### 8.4 Vías nativas que conviene usar

- Instagram: etiquetar la colaboración pagada le da a la marca acceso a los insights del post en su Business Suite, y habilita partnership ads (la marca pauta el post del creador y ve métricas de anuncio).
- TikTok: Spark Ads y los reportes de TikTok Creator Marketplace.
- YouTube: el creador puede compartir la analítica del video; BrandConnect.

### 8.5 Entregable

Reporte por campaña con enlace compartible o PDF, con marca blanca para agencias. El mismo motor sirve para el reporte de la agencia a su cliente (sección 2) y alimenta la cotización siguiente (sección 5): "en la última campaña generé X views y Y seguidores para la marca".

## 9. Preguntas para influencers

Del usuario:

1. ¿Qué métricas realmente ven en las redes?
2. ¿Cómo analizan los trends nuevos?
3. ¿Cómo quitarles carga operativa, sea financiera, gastos y flujo de caja?
4. ¿Cómo buscan marcas nuevas? ¿Siempre inbound? ¿Se puede outbound?
5. ¿Qué campos de Instagram están disponibles para análisis de datos? (respondido en el Anexo A)

Propuestas para sumar:

6. ¿Cómo deciden hoy cuánto cobrar? ¿Tienen media kit?
7. ¿Cuánto tardan en cobrar después de entregar una campaña?
8. ¿Cuánto tiempo gastan armando el reporte para la marca después de la campaña?
9. ¿Qué herramientas pagan hoy y cuánto?
10. ¿Qué es lo que más les cuesta al crear contenido: ideas, guion, grabación, edición?
11. ¿Miran lo que hacen otros creadores de su nicho? ¿Cómo?
12. ¿Aceptarían que un tercero cobre a la marca por ellos a cambio de una comisión?
13. ¿Les interesaría cobrar antes de que pague la marca, pagando un fee?
14. ¿Facturan ellos mismos? ¿Quién les lleva los impuestos?
15. ¿Alguna vez le escribieron a una marca primero? ¿Qué pasó?
16. ¿Qué les pide la marca al terminar la campaña y cómo se lo entregan hoy?
17. ¿Alguna vez les dieron código de descuento o enlace propio? ¿Supieron cuánto vendió?

## 10. Preguntas para agencias

1. ¿Cuántas marcas y cuántas cuentas maneja cada community manager?
2. ¿Cómo hacen los reportes hoy y cuánto tiempo les toma cada uno?
3. ¿Qué formato y frecuencia piden sus clientes?
4. ¿Qué herramientas pagan y cuánto?
5. ¿Cómo mide el cliente si el trabajo del CM funciona?
6. ¿Cómo consiguen acceso a las cuentas de sus clientes hoy?
7. ¿Cómo consiguen marcas nuevas para sus creadores?
8. ¿Qué métricas de resultado de campaña piden sus clientes y cuáles no pueden darles hoy?

## 11. Decisiones tomadas

Ninguna todavía.

## 12. Siguientes pasos

- [ ] Decidir el modelo de monetización de la etapa 1 (sección 3).
- [ ] Decidir la vía de acceso a datos internos: OAuth propio vs. agregador para arrancar (sección 4.1).
- [ ] Cerrar el cuestionario para influencers y agencias y hacer las primeras 5 entrevistas.
- [ ] Armar la tabla de CPM de referencia por nicho y país para las cotizaciones.
- [ ] Prototipo del análisis de outliers con 100 videos de un nicho en TikTok (sección 4.3).
- [ ] Definir el reporte mínimo de campaña (sección 8) y el snapshot diario de posts y seguidores de marca.
- [ ] Revisar el mock módulo por módulo y anotar qué sobra, qué falta y qué se prioriza para la etapa 1.
- [ ] Elegir la dirección visual (Geist, Signal o Studio) y convertirla en tokens para el desarrollo real.
- [ ] Decidir el nombre del producto y registrar el dominio.
- [ ] Iniciar los tres trámites de plataforma (TikTok, Meta, Google). Es el camino crítico.
- [ ] Confirmar si el outbound se entendió bien (ver sección 7 del plan de equipo).
- [ ] Probar con cuenta propia Virlo, Deelo, Bisket, Metricool y Spotter (sección 13.11) y anotar cómo calculan outliers y precios.

## 13. Competencia: quién hace ya partes de esto

Investigado el 16 sep 2026 (cuarta ronda). Pregunta del usuario: qué competencia existe para una plataforma que organice todo lo relacionado con influencers, analice los videos propios y ajenos para detectar tendencias, recomiende los videos futuros y compare entre todas las redes.

**Respuesta corta**: nadie ofrece las tres cosas juntas (inteligencia de video entre redes + organización/back office del influencer y la agencia + reporte de campaña a la marca). El mercado está partido en ocho categorías que se tocan pero no se cruzan, y en español/Latam el hueco es todavía más grande. Precios en USD por mes salvo que se indique.

### 13.1 Inteligencia de video corto entre redes (lo más parecido a la idea)

| Jugador | Qué hace | Redes | Precio | Para quién |
|---|---|---|---|---|
| **Virlo** | Social listening de video corto: búsqueda de videos virales, nichos personalizados con outliers y creadores emergentes, alertas, estudio de contenido con IA sobre lo que está tendiendo, inteligencia de Meta Ads. Tiene servidor MCP. | TikTok, Reels, Shorts | 49 (2.000 créditos) / 199 (12.000) / enterprise | Creadores, agencias y marcas |
| **Grocalo** | "AI brain that runs content for creators": entiende los videos y la analítica de cada plataforma para personalizar y distribuir contenido por audiencia. YC verano 2026. Reporta 2.000 M de views y 4 M de seguidores para sus clientes en 2 meses; clientes con 6 a 72 M de seguidores. | Instagram, TikTok, YouTube, Facebook, LinkedIn, Threads | No público; parece servicio para creadores grandes | Creadores top |
| **ViralDeck** | Panel único por creador con análisis de hook y punto de abandono en los primeros segundos, recomendaciones. API y MCP. | TikTok, Reels, Shorts | No publicado | Creadores |
| **Eden** | Outliers multi-plataforma + brainstorming con IA sobre tableros guardados + redacción + programación. Se posiciona contra Spotter por ser multi-red. | X, LinkedIn, Threads, Instagram, TikTok, Substack; programa en Shorts y Facebook | Gratis / 9 / 15 / 29 / 79 | Creadores multi-red, agencias |
| **Dash Social (ex Dash Hudson) Vision AI** | Predice el rendimiento de un post antes de publicarlo a partir del historial; reconoce tonos, temas y productos. | Multi-red | Desde 1.999 (plan Advance) | Marcas |
| **Predictores de viralidad** (Higgsfield, quso.ai, Go Viral, WayIn) | Puntaje de hook, ritmo y curva de atención de un video antes de subirlo. | Archivo de video | Gratis a bajo costo | Creadores |

Lectura: Virlo es el competidor más directo en "tendencias del nicho entre redes". Grocalo es el más directo en "IA que decide qué contenido hacer", pero apunta a creadores de millones de seguidores. Ninguno de los dos tiene cotizaciones, deals, facturación ni reporte a la marca.

### 13.2 Outliers y research por plataforma (casi todo YouTube)

| Jugador | Qué hace | Precio |
|---|---|---|
| **1of10** | Base de datos de outliers y explorador de nichos, solo YouTube | 29 a 69 |
| **OutlierKit** | Outliers + keywords con volumen + tendencias + audiencia; API y MCP | 29 (Pro 49) |
| **ViewStats** (MrBeast) | Analítica pública, outliers, historial de miniaturas, A/B, alertas | Tiene plan gratis |
| **Spotter Studio** | Brainstorm con IA sobre 50 M de videos outlier, títulos y miniaturas, planificador | 49 (299/año) |
| **vidIQ** | SEO, keywords, ideas diarias, AI Coach que ve tus Reels (no TikTok), clipping a Shorts/TikTok/Reels | Gratis / 199 al año / 468 al año |
| **TubeBuddy, NexLev, TubeLab, Social Blade** | SEO, canales faceless, stats públicas | 5 a 15 |
| **Exolyt** | Analítica por video de TikTok: sonidos, captions, sentimiento de comentarios | Por cotización |
| **Pentos** | Rastrea canciones, hashtags, retos y cuentas de TikTok con snapshots diarios | Bajo costo |
| **TrendTok** | Detección temprana de tendencias de TikTok | Bajo costo |
| **Kalodata / FastMoss** | Analítica de TikTok Shop: GMV, productos, afiliados | Por cotización |

Lectura: el método de outliers (video sobre la mediana de su cuenta) que propusimos en la sección 4.3 ya es estándar en YouTube y está empezando en TikTok. Nadie lo aplica a Instagram con datos de nicho porque la API no da el archivo de video ajeno (Anexo A).

### 13.3 Gestión de redes con analítica (SMM)

| Jugador | Qué tiene relevante | Precio |
|---|---|---|
| **Metricool** (España) | Analítica de todas las redes, competidores, mejor hora, pauta + orgánico, MCP con Claude. Muy usado por freelancers y pymes en español. Sin módulo de influencers ni outliers de nicho. | 22 a 54 |
| **Later** | Planificador visual, UGC, y Later Influence para marcas | Desde 25 |
| **Hootsuite** | Enterprise, listening con Talkwalker | 99 a 399 por usuario |
| **Sprout Social** | Inbox, CRM, analítica premium; Tagger para influencers | 79 a 299 por asiento |
| **Socialinsider** | Benchmarking entre redes, reportes por industria | Desde ~100 |
| **Emplifi, Tubular Labs** | Benchmarking enterprise de video social | Por cotización |

Lectura: Metricool es a quien más se parece la capa de "métricas propias entre redes" y ya está en la mesa de las agencias pequeñas de Latam. No lo vamos a ganar en programación de posts; sí en inteligencia de video, influencers y cotizaciones.

### 13.4 Plataformas de influencer marketing del lado de la marca

| Jugador | Enfoque | Precio |
|---|---|---|
| **CreatorIQ** | Enterprise, multi-marca, brand safety | ~2.350 en adelante |
| **Traackr** | Enterprise, gobernanza | 25.000 a 55.000 al año |
| **Grin** | DTC con Shopify, seeding y atribución | ~2.200 |
| **Aspire** | eCommerce, marketplace con creadores opt-in | ~2.499 |
| **Upfluence** | WooCommerce, Magento, BigCommerce | ~478 |
| **Modash** | Discovery de 350 M de perfiles, vetting | 199 a 299 |
| **HypeAuditor** | Detección de fraude, 207 M de perfiles | 299 a 399 |
| **Favikon** | Rankings de creadores, fuerte en LinkedIn/B2B | 199 a 299 |
| **Influencity** (España) | 200 M de creadores, IRM (CRM de creadores con historial de precios), campañas, reportes marca blanca, Social Hub; en español | 168 a 998 |
| **Kolsquare** (Francia) | Discovery, campañas, benchmarking; precio por módulos | Por cotización |
| **Later Influence, Sprout/Tagger, Brandwatch, Meltwater/Klear** | Suites enterprise | Por cotización |

Lectura: caros y hechos para que la marca encuentre y gestione creadores. Al influencer no le sirven, y a una agencia de community management de varias marcas pequeñas tampoco. Influencity es el que más se acerca a agencias de habla hispana.

### 13.5 Marketplaces y agencias con tecnología en Latam y España

| Jugador | País | Qué hace | Modelo |
|---|---|---|---|
| **Fluvip** | Colombia (Miami, MX, PE, EC, VE, BR, AR) | Red de 500.000 creadores, 650 marcas; el algoritmo fija el precio por publicación al registrarse; onboarding por campaña; pagos auditados por Deloitte. No ofrece analítica al creador. | Comisión sobre campañas |
| **Influur** | Miami, MX, AR | 30.000 creadores y 5.000 marcas; paga a 30 días (el mercado paga a 90) o retiro inmediato con 15 % de comisión; Influur Premium a 30/mes con media kit automático y precios; 50 % del ingreso viene de campañas musicales; 15 M USD levantados (Point72). | Fee de marketplace + suscripción + comisión financiera |
| **BrandMe** | México | Marketplace marca-creador con análisis de creadores | Comisión |
| **VoxFeed** | México | Marketplace con 40.000 creadores, muy simple | Comisión |
| **SamyRoad, SocialPubli, Coobis, Publisuites** | España con oficinas en Latam | Marketplaces de campañas | Comisión |
| **WeCollab** | Latam | App freemium que conecta creadores con marcas sin comisión | Freemium |
| **2bpay** (2btube) | España / Latam | Fintech: adelantos sobre ingresos futuros de redes, sin avales | Interés sobre el adelanto |
| **Noodle** | Brasil | Crédito adelantado sobre ingresos proyectados de Instagram/TikTok (3 % mensual) + ERP de facturas para agencias | Interés + software |
| **Pay With Influence** | Latam | Pagos formales entre creadores y pequeños negocios | Comisión |

Lectura: en Latam todo es marketplace o fintech. Le dan deals o plata al creador, no le dicen qué video hacer ni le miden la campaña entre redes. Influur ya cobra 15 % por adelantar el pago: el take rate del money flow (sección 3) tiene precedente regional.

### 13.6 Back office del creador y software para agencias de talento

| Jugador | Qué hace | Precio |
|---|---|---|
| **Deelo** | CRM de deals por etapas, contratos con firma, facturación con NET-30/60, media kit, agenda, outreach en frío, analítica entre redes | 19 por asiento |
| **Passionfroot** | Vitrina de patrocinios donde la marca compra el espacio, propuestas, cobro con FrootWallet | Free + comisión/planes |
| **Beacons** | Link in bio, media kit, calculadora de tarifas, tienda, email | Gratis a 99 |
| **Collabstr** | Marketplace + calculadora de precios y verificador de seguidores falsos | Comisión |
| **July** | Para agencias de talento: media kits y rosters que se actualizan solos, pitch decks, CRM de deals, facturación, split de pagos con el talento, comisiones, reportes de campaña | Por planes, con prueba gratis |
| **Bisket** | Roster sincronizado en 6 redes, puntaje de "deal-readiness", matching de briefs con IA, detección de marcas en los videos, motor de precios, reportes de campaña marca blanca | Gratis hasta 5 creadores; desde 99 |
| **rostr, CreatorsJet, RosterGrid, Creator.co** | CRM de talento, media kits, deals, pagos | 20 a 100 |
| **Karat, Creative Juice, Lumanu** (EE. UU.) | Banca y tarjeta para creadores; Lumanu factura gratis y cobra por EarlyPay | Free + fee financiero |

Lectura: esta capa cubre casi punto por punto la sección 6 del cuaderno (cotizar, contratar, facturar, cobrar, flujo de caja), pero en inglés, para EE. UU., y sin inteligencia de video. Bisket ya tiene motor de precios y reportes de campaña para agencias de talento; July ya tiene split de pagos y comisiones.

### 13.7 Reporteo para agencias

AgencyAnalytics (79/mes o 20 por cliente), Swydo (69), DashThis (54), Whatagraph (812). Casi todos con marca blanca desde el plan base. Sirven para el reporte que la agencia le manda a su cliente (sección 2), pero no saben nada de influencers ni de video.

### 13.8 Herramientas nativas gratis (el competidor que más pesa para el influencer pequeño)

- **TikTok Creator Search Insights**: temas con alta demanda de búsqueda y poca oferta, filtro de "content gap", búsquedas de tus seguidores, analítica de búsqueda por video.
- **TikTok Creative Center**: hashtags, sonidos, creadores y anuncios en tendencia por país e industria.
- **TikTok One**: reemplazó al Creator Marketplace en 2025; mínimo 10.000 seguidores, 3 posts y 1.000 views en 30 días.
- **YouTube Ask Studio**: asistente de ideas; la pestaña Inspiración se retira desde agosto 2026. A/B de títulos y miniaturas nativo.
- **YouTube Creator Partnerships** (ex BrandConnect): relanzado en 2026 con Gemini; 3 M de creadores del programa de socios; los que comparten sus insights aparecen 60 % más en búsquedas de marcas.
- **Instagram Creator Marketplace**: matching con IA desde 2025; sin mínimo formal de seguidores.
- **Instagram Panel profesional**: lista de 50 audios en tendencia (solo EE. UU. por ahora) y audios originales.

Lectura: las plataformas están cerrando el hueco de "qué publicar" dentro de una sola red y de "encontrar marcas" con sus propios marketplaces. Lo que no van a hacer es cruzar redes, ni darle al creador un back office, ni medir la campaña para la marca de forma neutral.

### 13.9 Infraestructura de datos (proveedor y riesgo a la vez)

Phyllo (20+ plataformas, precio a medida, sin plan gratis) y Ayrshare (149 a 599). Son la vía rápida de la sección 4.1 y a la vez lo que cualquier competidor nuevo puede contratar en una semana: los conectores no son moat; el análisis y el flujo comercial sí.

### 13.10 Dónde queda el hueco y qué implica

1. **La intersección está vacía.** Video intelligence entre redes (Virlo, Grocalo) por un lado; back office comercial (Deelo, July, Bisket) por otro; reporte de campaña a la marca lo hacen solo las plataformas de marca (CreatorIQ, Influencity) y no lo entregan al creador. Nadie une los tres.
2. **En español y con datos de nicho local no hay nada.** Metricool e Influencity son españolas pero una es SMM genérico y la otra es lado marca. Fluvip, Influur, BrandMe y VoxFeed son marketplaces: dan deals, no inteligencia. Un "qué video hacer la semana que viene, con datos de tu nicho en Colombia o México" no existe.
3. **Las agencias de community management pequeñas están mal atendidas.** Hoy eligen entre Metricool (sin influencers ni video intelligence) y AgencyAnalytics (sin video ni influencers). July y Bisket son para agencias de talento, no de CM.
4. **Anclas de precio que el mercado ya aceptó**: creador 19 a 49/mes (Deelo, Virlo Starter, Spotter, vidIQ Boost); agencia 79 a 199/mes (AgencyAnalytics, Bisket, Virlo Pro); Influur Premium 30/mes prueba que un creador latino paga por media kit + precios; 15 % por cobrar antes (Influur) y adelantos con interés (2bpay, Noodle) prueban que la etapa 3 de la sección 3 es viable en la región.
5. **Amenazas reales**: (a) las herramientas nativas gratis para el influencer pequeño; (b) Grocalo si baja al segmento medio; (c) Metricool si agrega outliers de nicho e influencers, porque ya tiene la base instalada en español; (d) Virlo si agrega deals y facturación; (e) dependencia de las APIs de Meta y TikTok, igual que todos.
6. **Consecuencia para las decisiones abiertas**: la suscripción a agencias (etapa 1 de la sección 3) es consistente con lo que cobran Bisket, July y AgencyAnalytics. El diferenciador que hay que construir primero es el que nadie tiene: análisis de video propio y del nicho entre redes (sección 4.3) unido a la cotización (sección 5) y al reporte de campaña (sección 8). Los conectores y el CRM se pueden comprar o copiar.

### 13.11 Qué probar con cuenta propia antes de diseñar

Registrarse y usar una semana: Virlo (Starter), Deelo, Bisket (plan gratis), Metricool (gratis), Spotter Studio (prueba), TikTok Creator Search Insights y YouTube Ask Studio. Anotar en la sección 4.3 qué señales usan para "outlier" y en la sección 5 cómo calculan precios Bisket, Beacons y Collabstr.

Fuentes consultadas el 16 sep 2026: sitios oficiales de Virlo, ViralDeck, Eden, Deelo, July, Bisket, Influencity, Passionfroot, Fluvip, Grocalo (YC) y comparativas 2026 de Meltwater, Syncly, OutlierKit, 1of10, Overseeros, HypeAuditor, Virlo, Kalodata, Swydo, Archive, Kolsquare, Favikon, Branch (Colombia), Blind Creator, Forbes Colombia (Influur), Infobae (WeCollab), LatamFintech (Noodle), 2btube (2bpay), Google Support (Inspiration tab), TikTok Creator Academy (Creator Search Insights).

---

## Anexo A. Instagram: qué campos hay para análisis de datos

Verificado el 16 sep 2026 contra la documentación de Meta (Instagram Platform / Graph API). Aplica a cuentas profesionales (Business o Creator). Hay dos variantes de login: "Instagram Login" y "Facebook Login"; algunos campos solo salen con Facebook Login y se marcan.

### A. Campos del objeto media (cada post, reel o historia propia)

`id`, `media_type` (IMAGE, VIDEO, CAROUSEL_ALBUM), `media_product_type` (AD, FEED, STORY, REELS), `caption` (solo Facebook Login), `timestamp`, `permalink`, `shortcode`, `media_url`, `thumbnail_url`, `username`, `owner`, `like_count`, `comments_count`, `reposts_count`, `saved_count`, `shares_count`, `view_count` (solo vía Business Discovery), `total_like_count`, `total_comments_count`, `total_views_count` (los `total_*` suman orgánico más pauta), `media_audio_type` (MUSIC u ORIGINAL_SOUND), `is_shared_to_feed`, `is_comment_enabled`, `is_ai_generated`, `alt_text`, `boost_ads_list`, `boost_eligibility_info`, `copyright_check_information`.

Edges: `comments` (texto, usuario, likes, respuestas), `children` (fotos del carrusel), `collaborators`, `insights`.

### B. Insights por media

| Métrica | Feed | Reels | Historias | Nota |
|---|---|---|---|---|
| `views` | ✅ | ✅ | ✅ | Reemplaza a `impressions` y `plays` |
| `reach` | ✅ | ✅ | ✅ | Cuentas únicas, estimado |
| `likes`, `comments` | ✅ | ✅ | | Solo orgánico |
| `saved` | ✅ | ✅ | | |
| `shares` | ✅ | ✅ | ✅ | |
| `reposts` | ✅ | ✅ | ✅ | |
| `total_interactions` | ✅ | ✅ | ✅ | |
| `ig_reels_avg_watch_time` | | ✅ | | Tiempo promedio de reproducción |
| `ig_reels_video_view_total_time` | | ✅ | | Tiempo total incluyendo repeticiones |
| `reels_skip_rate` | | ✅ | | % que saltó en los primeros 3 s |
| `profile_visits`, `profile_activity`, `follows` | ✅ | | ✅ | Visitas y seguidores ganados desde ese post |
| `navigation` | | | ✅ | Con desglose: salida, siguiente, atrás, respuesta |
| `replies`, `link_clicks` | | | ✅ | `replies` devuelve 0 en Europa y Japón |
| `facebook_views`, `crossposted_views` | ✅ | ✅ | | Solo si se compartió a Facebook |
| `total_likes`, `total_comments`, `total_views` | ✅ | ✅ | | Incluyen pauta; solo Facebook Login |
| `impressions` | | | | **Deprecado** para medios creados después del 2 jul 2024 |

Lo que **no** existe por video: curva de retención segundo a segundo, demografía de quién lo vio, lista de quién lo vio.

### C. Insights de cuenta (por día, `metric_type=total_value`)

`views` (desglose por `follower_type` y `media_product_type`), `reach` (desglose por `media_product_type` y `follow_type`: seguidores vs. no seguidores), `accounts_engaged`, `total_interactions`, `likes`, `comments`, `saves`, `shares`, `replies`, `reposts`, `follows_and_unfollows` (desglose `follow_type`), `profile_links_taps` (desglose `contact_button_type`), `follower_count`, `profile_views`, `website_clicks`, `online_followers` (seguidores conectados por hora, últimos 30 días: la base para "cuándo publicar").

`impressions` de cuenta está deprecado desde abril 2025. Datos con hasta 48 h de retraso. `follower_count` y `online_followers` no salen con menos de 100 seguidores.

### D. Demografía (solo por cuenta, nunca por video)

`follower_demographics`, `engaged_audience_demographics` y `reached_audience_demographics`, con desglose por `age`, `gender`, `city` y `country`. Exigen mínimo 100 seguidores o 100 interacciones en el período. Devuelven solo los 45 valores principales. Los timeframes de 14, 30 y 90 días dejaron de soportarse después de la v20; queda `this_week`, `this_month` y lifetime.

### E. Lo que se puede ver de OTRAS cuentas (análisis externo)

- **Business Discovery**: de cualquier cuenta profesional pública, por username: `followers_count`, `media_count`, y de sus medios `like_count`, `comments_count`, `view_count` (orgánico más pauta), caption, tipo, fecha y permalink. Sin insights, sin demografía, sin cuentas con restricción de edad. Requiere Facebook Login.
- **Hashtag search**: máximo 30 hashtags únicos por ventana de 7 días. Edges `top_media` y `recent_media` con id, caption, tipo, likes, comentarios, fecha y permalink; **sin username del autor** (dato de memoria, no verificado hoy). Requiere la función "Instagram Public Content Access" aprobada.
- **Etiquetas de colaboración pagada**: no hay endpoint público para buscarlas en cuentas ajenas; se detectan por caption (#ad, #publicidad) y menciones.

### F. Lo que Instagram no da por API

Demografía por video, retención segundo a segundo, quién vio o guardó, historias de cuentas ajenas, lista de seguidores, datos de cuentas personales (no profesionales), y el archivo de video de cuentas ajenas.
