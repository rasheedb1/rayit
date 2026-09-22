# Plan de construcción · dos programadores en paralelo

Escrito para: los dos programadores que van a construir la plataforma, y
quien coordine el proyecto.

Fecha: 20 de septiembre de 2026. Punto de partida: la base de datos ya
existe, verificada, con ochenta y seis tablas, diez vistas y doscientos
nueve índices, y el entorno local se levanta con un comando.

> **Actualización del 21 de septiembre de 2026.** El alcance se recortó a
> un MVP de cinco módulos (Resumen, Ventas/CRM, Cotizar, Campañas y
> Finanzas); el laboratorio de video y el resto pasan a una segunda
> fase. El backlog vigente, con dueños e historias, está en
> [backlog-mvp.md](backlog-mvp.md). Las reglas de trabajo de la
> sección 5 de este documento siguen aplicando.
>
> **Avance al 21 de septiembre, 20:30.** Las cinco historias de
> Nicolás del sprint 1 (CIM-4, CIM-5, CIM-8, CON-2, FIN-1) están en
> `main`, verificadas dos veces y desplegadas en producción. El estado
> completo y lo que Rasheed tiene que destrabar están en la sección 8
> de [backlog-mvp.md](backlog-mvp.md#8-estado-del-sprint-1-al-21-de-septiembre-de-2026).
>
> **Avance al 22 de septiembre.** Del sprint 2 de Nicolás, CON-1, CAM-1,
> CAM-2 y CON-3 están en `main`, verificadas y desplegadas en producción.
> CON-3 (OAuth de TikTok e Instagram) está completa en código y bloqueada
> solo por la prueba en vivo, que depende del acceso a las apps. Detalle
> en la sección 9 de [backlog-mvp.md](backlog-mvp.md#9-estado-del-sprint-2-al-22-de-septiembre-de-2026).
>
> **Cambio de producto del 22 de septiembre (noche).** El MVP no pide
> autorización OAuth a cada creador: una cuenta se agrega por su @ y se
> lee con fuentes oficiales (CON-10, en `main`). La autorización del
> dueño (alcance, retención, demografía) pasa a una versión avanzada.

---

## 1. Lo primero, porque no depende de programar

Tres trámites bloquean funciones enteras del producto y tardan semanas.
**Hay que iniciarlos hoy**, antes de escribir una línea más. No los hace
un programador, los hace quien tenga las cuentas de empresa.

| Trámite | Qué desbloquea | Cuánto tarda | Sin él |
|---|---|---|---|
| **Accounts API Access Application Form** de TikTok | Retención por segundo, demografía por video, likes por segundo | Formulario, luego dos o tres días de permisos y hasta dos semanas de revisión | El producto se queda con cuatro contadores de vanidad |
| **App Review + Business Verification** de Meta | Métricas de Instagram y Facebook | Semanas | No hay datos de Instagram |
| **Auditoría de compliance** de Google | YouTube | Semanas | Los videos que subamos quedan privados |

Desde el veinte de marzo de 2026 el formulario de TikTok es obligatorio
**antes** de someter la aplicación a revisión. Es el camino crítico del
proyecto: todo lo demás se puede construir mientras tanto, pero nada de
esto se puede acelerar después.

Mientras los trámites corren, ambos programadores trabajan contra
respuestas grabadas. Eso no es una muleta: las respuestas grabadas son
también las pruebas automatizadas.

---

## 2. Cómo se reparte el trabajo

La regla que hace posible trabajar en paralelo: **cada uno es dueño de
carpetas distintas y nunca edita las del otro**. El contrato entre los
dos es el esquema de la base de datos, que ya está cerrado y verificado.

### Programador A — Datos

Dueño de `packages/connectors/`, `apps/worker/`, `packages/db/` y las
migraciones nuevas.

Construye la columna vertebral: conectar cuentas, traer datos, guardarlos
bien y calcular los puntajes. Nada de esto tiene pantalla, y por eso
puede avanzar sin discutir diseño con nadie.

### Programador B — Producto

Dueño de `apps/web/`, `apps/media/` y `packages/core/`.

Construye la aplicación y el laboratorio de video. Es el único módulo
que **no depende de ninguna aprobación de plataforma**: un creador sube
un archivo y recibe su análisis. Por eso puede ser lo primero que se
muestre a un usuario real.

### Si los perfiles no encajan

El reparto supone que A está cómodo con integraciones, colas y SQL, y
que B se mueve entre interfaz y Python. Si los dos son de perfil
parecido, el corte alternativo es por módulo completo: A se queda con
datos y laboratorio de video, B con la aplicación y el CRM de ventas.
Lo que **no** funciona es partir por capas, uno el frontend y otro el
backend: cada pantalla quedaría bloqueada esperando a la otra persona.

---

## 3. Seis semanas, semana por semana

### Semana 1 · que funcione la tubería de punta a punta

**A1. Paquete de conectores con respuestas grabadas.**
Cliente para TikTok Display, TikTok Accounts, Instagram Graph y YouTube.
Cada uno con su capa de reintentos, respeto de cuota y registro en
`api_call_log`. Respuestas grabadas en `fixtures/` para las pruebas.
*Terminado cuando:* `pnpm test` pasa sin red y `api_call_log` se llena.

**A2. Flujo OAuth completo para TikTok.**
Las dos aplicaciones, con rotación de refresh token y escritura en
`social_connection` y `data_consent`. En sandbox.
*Terminado cuando:* conectar una cuenta de prueba deja la fila correcta,
con sus scopes, y el trabajo `oauth.refresh` la renueva sola.

**A3. El worker arranca y corre un trabajo.**
pg-boss configurado, `job_definition` cargado, `job_run` registrando.
*Terminado cuando:* `make worker` toma un trabajo de la cola y lo
registra con su duración.

**B1. Esqueleto de la aplicación.**
Next.js con autenticación, cambio de espacio entre creador y agencia,
navegación de los nueve módulos, y los tokens de la dirección visual
elegida. Las pantallas pueden estar vacías: lo que importa es el marco.
*Terminado cuando:* se entra, se cambia de espacio y cada módulo tiene
su ruta.

**B2. Subir un archivo y guardarlo.**
Carga directa a S3 con URL firmada, fila en `video_asset`, y `ffprobe`
llenando la ficha técnica.
*Terminado cuando:* se sube un mp4 y aparece con su duración, resolución
y códec.

**Al final de la semana** los dos módulos deben verse en el mismo
`make dev`. Es el punto de integración y no se negocia.

### Semana 2 · el laboratorio de video empieza a decir algo

**A4. Recolector de posts y métricas.**
`collect.posts` descubre videos nuevos; `collect.post_metrics` guarda el
snapshot con su `age_hours`. Append-only, sin excepciones.
*Terminado cuando:* dos corridas seguidas producen dos filas y la vista
`post_metrics_daily_delta` muestra el crecimiento.

**A5. Curvas por segundo de TikTok.**
`video_view_retention`, `engagement_likes` e `impression_sources` hacia
`post_retention_curve`, `post_engagement_curve` y
`post_impression_source`, con las derivadas ya calculadas: retención a
un segundo, a tres, dónde cae a la mitad y cuál es la mayor caída.
*Terminado cuando:* con la respuesta grabada, las derivadas coinciden
con el cálculo a mano.

**B3. Análisis segundo a segundo, capa barata.**
El servicio en Python llena `video_second` y `video_shot`: cortes con
PySceneDetect, brillo, contraste, movimiento, rostros, y sonoridad por
segundo con ffmpeg. Sin modelos de lenguaje todavía.
*Terminado cuando:* un video de noventa segundos produce noventa filas
en menos de treinta segundos de proceso.

**B4. Transcripción con marca por palabra.**
faster-whisper llenando `video_transcript` y `video_transcript_word`,
con palabras por minuto y segundos de silencio.
*Terminado cuando:* la primera frase del video se puede reconstruir con
su tiempo exacto de inicio y fin.

### Semana 3 · el semáforo y los puntajes

**A6. Línea base y puntaje.**
`compute.baseline` calcula la mediana del creador por plataforma y corte
de edad; `compute.post_score` compara cada video contra ella y marca los
outliers. Con menos de ocho videos, `is_reliable` queda en falso y la
interfaz lo dice.
*Terminado cuando:* un video con el doble de views que la mediana
aparece marcado como outlier.

**A7. Administrador de cuota.**
Reparte las cuarenta consultas por minuto por cuenta, frena antes del
corte, y hace espera exponencial ante el código 40100.
*Terminado cuando:* una prueba que dispara cien llamadas no recibe
ningún 429.

**B5. Texto en pantalla y zonas seguras.**
OCR por fotograma agrupado en apariciones, con su caja normalizada, y la
marca de si cae bajo la interfaz de cada red.
*Terminado cuando:* un video con subtítulos abajo sale marcado como
inseguro para TikTok.

**B6. Motor de reglas del semáforo.**
Lee `preflight_rule`, evalúa contra los rasgos, escribe
`preflight_result` y `preflight_verdict` por plataforma. Las reglas son
datos: cambiar un umbral no es un despliegue.
*Terminado cuando:* subir un video devuelve un veredicto por red con sus
fallos ubicados en el segundo exacto.

### Semana 4 · las primeras pantallas de verdad

**A8. Demografía y cuentas.**
`collect.demographics` y `collect.account_metrics`, respetando los
prerrequisitos de `metric_requirement`: si falta algo, se explica en vez
de dejar la celda vacía.

**A9. Vigilancia del nicho.**
`watch.external` recorre las cuentas vigiladas, guarda `external_post` y
sus snapshots, y calcula la línea base ajena.

**B7. Pantalla del laboratorio de video.**
Reproductor con la línea de tiempo del análisis: cortes, texto en
pantalla, picos de sonoridad y, cuando el video ya se publicó, la curva
de retención real encima. Saltar al segundo del problema con un clic.

**B8. Pantallas de Resumen y Mis videos.**
Contra datos reales de la base, no contra el mock.

### Semana 5 · ventas

Los dos convergen aquí. A hace el radar, que es ingesta; B hace el CRM,
que es interfaz.

**A10. Radar de prospección.**
`radar.scan` sobre la biblioteca de anuncios de Meta, Top Ads de TikTok
y las colaboraciones pagadas de las cuentas vigiladas. Deduplicación por
`dedupe_key` y cálculo de encaje de audiencia.

**A11. Guardarraíles del outbound.**
El trabajo `outbound.dispatch` respeta `outbound_policy`: máximo de
toques, días entre toques, enfriamiento tras un no, y bloqueo absoluto
si el contacto pidió la baja. La base ya lo impone con un disparador; el
worker debe fallar elegante y registrar el motivo.

**B9. Pipeline y ficha de empresa.**
Tablero, lista, ficha con línea de tiempo y siguiente acción. Tal como
quedó en el mock.

**B10. Generador de pitch con afirmaciones trazables.**
Cada cifra del pitch apunta a la campaña o métrica de la que salió, en
el campo `claims`. Una cifra sin respaldo no se puede enviar.

### Semana 6 · cerrar el ciclo del dinero

**A12. Seguimiento de marcas en campaña.**
`brand.snapshot` diario de los seguidores públicos de la marca, y
`campaign.compute` calculando el resultado con su línea base.

**B11. Cotización, media kit y reporte.**
Los tres con enlace compartible. El reporte congela sus datos al
generarse.

**B12. Finanzas.**
Cuentas por cobrar, recordatorios y flujo de caja proyectado.

---

## 4. Lo que se decide en el camino

Tres cosas no se pueden cerrar hoy y hay que decidirlas con datos.

**Los umbrales del semáforo.** Están en la tabla `preflight_rule` con un
campo `evidence_level` que distingue cuatro procedencias: especificación
de la plataforma, investigación publicada, datos internos, o criterio del
oficio. Arrancamos con los dos primeros donde existan y marcamos el resto
como criterio. En cuanto haya cien videos analizados con su retención
real, los umbrales se recalibran y suben de categoría. La interfaz
muestra la procedencia: nunca presentamos folclore como dato duro.

**El predictor.** Queda apagado detrás de una bandera hasta que haya
datos para calibrarlo. La tabla `video_prediction` guarda la predicción
y, cuando el video madura, el resultado real y el error. Sin ese tablero
de calibración, encender el predictor es vender humo.

**Los CPM de referencia.** Los del seed son estimaciones marcadas como
manuales. Se reemplazan con los deals reales que pasen por la plataforma
y la fuente cambia a `deals`.

---

## 5. Acuerdos de trabajo

- **Ramas por función**, pull request obligatorio, el otro revisa. Con
  dos personas la revisión es rápida y evita que cada uno construya su
  propia versión de lo mismo.
- **El CI verifica las migraciones en cada pull request**, con Postgres
  embebido, sin levantar servicios. Tarda menos de un minuto.
- **Una migración aplicada es inmutable.** El runner y el CI rechazan un
  archivo modificado.
- **Integración los viernes.** Todo lo de la semana tiene que correr
  junto en un solo `make dev`.
- **Una rama de base de datos por pull request** (Neon lo hace solo), de
  forma que probar una migración no rompa el trabajo del otro.
- **Quince minutos diarios**, no más. Qué terminé, qué sigo, qué me
  bloquea.

---

## 6. Qué se puede enseñar y cuándo

| Momento | Qué se puede mostrar a un usuario real |
|---|---|
| Fin de semana 3 | Subir un video y recibir el semáforo por red. No necesita ninguna aprobación de plataforma. |
| Fin de semana 4 | Lo anterior más el dashboard con datos propios, si TikTok ya aprobó. |
| Fin de semana 5 | Radar de marcas y pipeline. |
| Fin de semana 6 | El ciclo completo: cotizar, medir la campaña, reportar y cobrar. |

El laboratorio de video es lo primero que se puede enseñar porque es lo
único que no espera a nadie. Conviene usarlo como punta de lanza para
conseguir los primeros creadores, y que ellos conecten sus cuentas
justo cuando las aprobaciones lleguen.

---

## 7. Preguntas abiertas para quien coordina

1. **¿Quién inicia los tres trámites y con qué cuenta de empresa?** Es
   el camino crítico y hoy no tiene dueño.
2. **¿El outbound lo entendimos bien?** Lo construido asume que el
   creador carga lo que busca (categorías, presupuesto mínimo,
   disponibilidad, y qué **no** acepta) y que el radar y el pitch
   trabajan a partir de eso, con límites éticos aplicados en la base:
   máximo de toques, baja voluntaria que se respeta en toda la
   plataforma, y ninguna cifra en un pitch sin origen trazable. Si la
   idea era otra, hay que corregirlo antes de la semana cinco.
3. **¿Cuál de las tres direcciones visuales?** El programador B necesita
   los tokens en la semana uno.
4. **¿Nombre del producto y dominio?** Hace falta para el correo de
   outbound, que necesita dominio propio con sus registros de
   autenticación configurados.
