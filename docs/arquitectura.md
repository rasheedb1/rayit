# Arquitectura

Decisiones tomadas el 20 de septiembre de 2026, al iniciar la
construcción. Cada una dice por qué, y qué la haría cambiar.

## Principio que ordena todo

El producto es una **máquina de datos con tres bocas**: lo que entra por
las APIs de las plataformas, lo que entra por los archivos que sube el
creador, y lo que entra por el radar público de empresas. Todo lo demás
(dashboard, ideas, CRM, reportes) es lectura de esos tres flujos.

Por eso el orden de construcción es: primero la base de datos y las
colas, después los recolectores, y solo entonces las pantallas. Una
pantalla bonita sobre datos que no llegan no sirve de nada; datos que
llegan sin pantalla se pueden consultar con SQL.

## La pila

| Capa | Elección | Por qué | Qué la cambiaría |
|---|---|---|---|
| Base de datos | Postgres 16 | Series temporales, jsonb, búsqueda por similitud y RLS en una sola pieza. El volumen real (millones de filas, no miles de millones) cabe de sobra. | Si un día hay que analizar cientos de millones de segundos de video, se agrega un almacén columnar al lado, no se reemplaza Postgres. |
| Alojamiento de la base | Supabase (desde el 20-sep-2026; antes Neon) | Trae autenticación, almacenamiento de secretos y API REST sobre el mismo Postgres. Nos ahorra construir tres piezas. Ver [base-de-datos.md](base-de-datos.md). | Volver a Neon si las ramas de base por pull request pesan más que lo anterior. |
| Colas | pg-boss (sobre Postgres) | Con dos programadores, un Redis más es una pieza más que mantener. Transacciones y trabajos en la misma base: si falla el commit, no queda un trabajo huérfano. | Cuando los trabajos pasen de unos cientos de miles al día. |
| Web | Next.js 15 + TypeScript | El ecosistema donde viven shadcn/ui y los componentes que ya evaluamos para la dirección visual. | Nada a la vista. |
| Interfaz | shadcn/ui sobre Base UI + Tremor | Base UI es la primitiva por defecto de shadcn desde julio de 2026. Tremor cubre los gráficos de tablero. Los gráficos finos (curvas segundo a segundo) van en SVG propio, como en los mocks. | |
| Acceso a datos | Drizzle | SQL a la vista. En un producto que vive de consultas analíticas, un ORM que esconde el SQL es un problema, no una ayuda. | |
| Worker | Node + TypeScript | Comparte tipos y clientes de API con la web. | |
| Analizador de video | Python + FastAPI | ffmpeg, PySceneDetect, faster-whisper y OCR viven en Python. Forzarlos a Node sería remar contra la corriente. | |
| Archivos | S3 (Cloudflare R2 en producción, MinIO en local) | R2 no cobra por salida de datos, y vamos a mover mucho video. | |
| Despliegue | Vercel (web) · Railway o Fly (worker y media) · Neon (base) · R2 (archivos) | Cada pieza escala por separado. El analizador de video necesita CPU y ffmpeg; la web no. | Un solo proveedor cuando el equipo crezca y la factura de operación pese más que la velocidad. |

## Las tres bocas

### 1. APIs de plataforma

El hallazgo que define esta capa: **TikTok entrega retención segundo a
segundo**, pero no por la API que documenta todo el mundo.

- **Display API** (`developers.tiktok.com`): dieciséis campos y cuatro
  contadores. Sirve para descubrir los videos del creador y poco más.
- **Accounts API** (`business-api.tiktok.com`): con el permiso
  `video.insights` entrega `video_view_retention` (porcentaje de
  espectadores que sigue viendo en cada segundo), `engagement_likes`
  (likes en cada segundo del timeline), la fuente de las vistas, y
  demografía **por video**.

Son dos aplicaciones, dos OAuth y dos trámites. La capa de identidad
guarda dos `open_id` por creador y la interfaz lo presenta como una sola
cuenta conectada.

Consecuencias que el código debe respetar:

- **Nada es en vivo.** Todo llega con veinticuatro a cuarenta y ocho
  horas de retraso. Cada pantalla muestra hasta qué fecha hay datos.
- **Somos la memoria del creador.** TikTok deja de actualizar un post a
  los trescientos sesenta y cinco días. Nuestros snapshots diarios son
  el único archivo histórico que tendrá.
- **Cuarenta consultas por minuto** por cuenta y por endpoint, y veinte
  videos por página. El planificador reparte la cuota entre cuentas y
  frena antes de que la API corte.
- **Un valor nulo no es un cero.** TikTok deja campos vacíos en videos
  sin interacción reciente. Confundirlos arruina cualquier promedio.
- **El creador tiene que activar Analytics** en la app de TikTok. Es un
  paso manual del onboarding, con captura de pantalla incluida.

### 2. Archivos de video

Descargar el mp4 de TikTok está **prohibido por sus términos**. Eso no
es un obstáculo: es lo que define el flujo correcto.

El creador sube su máster a la plataforma. Nosotros lo analizamos antes
de que se publique, le decimos si está listo, y publicamos por API. Así
nos quedamos con el original sin transcodificar, y el análisis ocurre
cuando todavía sirve para algo, que es antes de publicar.

Para los videos ya publicados y para los ajenos del nicho, el análisis
trabaja con lo que sí es público: portada, descripción, duración, sonido
y métricas.

### 3. Radar de empresas

Datos públicos: biblioteca de anuncios de Meta, Top Ads de TikTok,
colaboraciones pagadas visibles en las cuentas vigiladas, marketplaces,
vacantes y prensa. Nada que requiera raspar zonas privadas.

## Cómo se cruzan las tres

Aquí está el valor que nadie más tiene hoy:

```
video_second (qué pasa en el segundo 7 del video)
        +
post_retention_curve (qué porcentaje seguía viendo en el segundo 7)
        =
"Perdiste el treinta y uno por ciento de la audiencia en el segundo
 siete, donde hay un plano fijo de cuatro segundos sin texto"
```

La vista `second_by_second` hace exactamente ese cruce. Es la pantalla
que justifica el producto.

Y tiene una segunda consecuencia: el predictor del laboratorio de video
no se entrena contra "views", que dependen de mil cosas ajenas al video.
Se entrena contra **retención real medida por la plataforma**, que sí
depende del video. Eso convierte la predicción en algo defendible.

## Costo y forma del análisis de video

La investigación del 20 de septiembre dejó tres decisiones cerradas.

**El OCR va en casa, sin discusión.** Los servicios gestionados de texto
en video cuestan entre diez y quince centavos de dólar por minuto; la
transcripción cuesta entre tres y cinco milésimas. Es veinte a cuarenta
veces más caro, y es justo la parte que más veces hay que correr.
PaddleOCR en español resuelve, alimentado solo con fotogramas clave.

**Los fotogramas van empaquetados.** Mandar sesenta fotogramas sueltos a
un modelo multimodal gasta cincuenta y un mil tokens visuales.
Empaquetarlos en siete hojas de tres por tres gasta seis mil. Es la
misma información y cuesta casi nueve veces menos.

**El orden importa.** Primero las medidas deterministas (ffmpeg,
detección de cortes, OCR, transcripción) y solo después el modelo, con
esas medidas ya en el prompt y la obligación de citar el segundo exacto
de cada observación. Es la arquitectura del detector ABCDs de Google, y
evita que el modelo invente lo que una medición ya sabe.

Con eso, analizar un video de sesenta segundos cuesta alrededor de un
centavo y medio de dólar. El camino ingenuo cuesta trece centavos.

Tiempos objetivo: entre treinta y cinco y cincuenta y cinco segundos con
el worker caliente. El cuello es el OCR, y por eso se limita a veinte
fotogramas clave en vez de uno por segundo.

**En español conviene Canary sobre Whisper.** Mide 2,90 de tasa de error
contra 3,12 de Whisper large-v3 en el mismo conjunto de prueba, y su
licencia permite uso comercial.

## Honestidad con las cifras

El producto va a poner números en pantallas y en reportes que leerán las
marcas. Dos tablas sostienen eso: `benchmark`, con cada cifra de
referencia, su muestra y su fuente; y `blocked_claim`, con las cifras
que la industria repite sin respaldo y que este producto no cita.

Tres ejemplos de lo vetado, con lo que usamos en su lugar:

| Lo que circula | Por qué no | Qué decimos |
|---|---|---|
| «El setenta y uno por ciento de si te siguen viendo se decide en tres segundos» | Sin fuente primaria localizable | La mitad de los videos se abandona antes del diez por ciento de su duración (revisado por pares, dos coma seis millones de casos) |
| «El ochenta y cinco por ciento ve sin sonido» | Cifra de 2016 mal extrapolada | TikTok reporta noventa y tres por ciento **con** sonido |
| «Una finalización del sesenta y dos por ciento es normal» | Blog comercial, quinientos videos, sin método | Seis coma tres por ciento de media en TikTok, sobre dos coma tres millones de publicaciones |

Y una consecuencia de producto: **no hay regla de duración óptima en el
semáforo**. La evidencia de muestra grande apunta en sentido contrario
al folclore, así que no imponemos un límite que no podemos defender.

Esto también es el diferenciador comercial. Ninguna herramienta del
mercado publica la validación de su puntaje. Nosotros podemos publicar
la correlación de nuestro semáforo contra la retención real que mide
TikTok, y compararla con el techo académico de cero coma setenta y uno.

## Seguridad y datos personales

- Tokens fuera de la base: solo una referencia al vault.
- Aislamiento por fila activo desde la primera migración. Una tabla de
  negocio sin `workspace_id` hace fallar la migración.
- Consentimiento explícito por finalidad y por cuenta conectada, con
  evidencia guardada. Requisito de habeas data en Colombia y de las
  propias plataformas.
- Bitácora de cada llamada saliente y de cada acción que toque dinero o
  publique contenido.
- El archivo original del video se borra pasado un plazo; el análisis
  queda. El creador puede pedir el borrado completo.

## Lo que no vamos a hacer

- **Descubrimiento y ranking de creadores.** TikTok lo prohíbe
  explícitamente en sus términos. El producto se posiciona como
  analítica para el dueño de la cuenta.
- **Predicciones absolutas.** Nunca "este video hará quinientas mil
  views". Siempre relativo a la propia mediana del creador, con
  intervalo y con los rasgos que empujaron la predicción a la vista.
- **Tiempo real.** Las plataformas no lo dan. Prometerlo es mentir.
