# Análisis segundo a segundo de video vertical corto y predicción de desempeño pre-publicación

**Estado del arte 2025–2026 · investigación técnica para producto**
Fecha de elaboración: 2026-09-20
Alcance: TikTok / Instagram Reels / YouTube Shorts. Idioma primario del contenido: español.

---

## 1. Extracción técnica por segundo

### 1.1 ffmpeg — el caballo de batalla

ffmpeg resuelve solo la mayoría de las métricas objetivas. Comandos concretos y verificados contra la documentación de filtros (https://ffmpeg.org/ffmpeg-filters.html):

**Metadatos base y duración exacta**
```bash
ffprobe -v error -select_streams v:0 \
  -show_entries stream=width,height,r_frame_rate,nb_frames,duration,bit_rate,codec_name \
  -show_entries format=duration,size,bit_rate \
  -of json input.mp4
```

**Fotogramas a 1 fps (muestreo base para OCR y LLM), reescalados y con timestamp en el nombre**
```bash
ffmpeg -i input.mp4 -vf "fps=1,scale=540:-2" -q:v 4 frames/f_%04d.jpg
```
Para el análisis del hook conviene densificar los primeros 3 s a 5–10 fps:
```bash
ffmpeg -i input.mp4 -t 3 -vf "fps=10,scale=540:-2" -q:v 3 hook/h_%03d.jpg
```

**Detección de cortes con ffmpeg (rápida, aproximada)**
```bash
ffmpeg -i input.mp4 -filter:v "select='gt(scene,0.3)',showinfo" -f null - 2>&1 \
  | grep showinfo
```
`select='gt(scene,X)'` filtra fotogramas cuyo puntaje de cambio de escena supera X (0–1). Umbral típico 0.3–0.4. Es un detector burdo; para producción usar PySceneDetect (§1.2).

**Loudness EBU R128 — integrada, rango dinámico, true peak**
```bash
ffmpeg -i input.mp4 -af ebur128=peak=true:framelog=verbose -f null - 2>&1 | tail -20
```
El filtro `ebur128` reporta por defecto a 10 Hz: Momentary (M), Short-term (S), Integrated (I) y Loudness Range (LRA); `peak=true` añade True Peak (https://ffmpeg.org/ffmpeg-filters.html#ebur128). Alternativa con salida parseable en JSON:
```bash
ffmpeg -i input.mp4 -af loudnorm=I=-14:TP=-1:LRA=11:print_format=json -f null - 2>&1 | tail -15
```
(https://ffmpeg.org/ffmpeg-filters.html#loudnorm)

Para la **curva de loudness segundo a segundo** (clave para detectar caídas de energía), volcar la metadata por frame:
```bash
ffmpeg -i input.mp4 -af ebur128=metadata=1,ametadata=print:file=loudness.txt -f null -
```

**Silencios / pausas**
```bash
ffmpeg -i input.mp4 -af silencedetect=noise=-35dB:duration=0.35 -f null - 2>&1 | grep silence_
```
`silencedetect` acepta `noise` (umbral, por defecto −60 dB) y `duration` (mínimo de silencio, por defecto 2 s) e imprime `silence_start` / `silence_end` / `silence_duration` (https://ffmpeg.org/ffmpeg-filters.html#silencedetect). Para voz humana en video corto, −35 dB y 0.3–0.4 s detectan pausas retóricas reales sin fragmentar cada sílaba.

**Estadísticas de imagen por fotograma: brillo, contraste, saturación**
```bash
ffmpeg -i input.mp4 -vf "fps=2,signalstats,metadata=print:file=signalstats.txt" -f null -
```
`signalstats` expone `YAVG` (brillo medio), `YMIN`/`YMAX` (de donde sale el contraste), `YDIF` (diferencia entre fotogramas ≈ movimiento barato), `SATAVG`/`SATMAX` (saturación) y `HUEAVG` (https://ffmpeg.org/ffmpeg-filters.html#signalstats).

**Patologías: negro, congelado**
```bash
ffmpeg -i input.mp4 -vf "blackdetect=d=0.3:pic_th=0.98,freezedetect=n=-60dB:d=1" -f null - 2>&1 | grep -E "black|freeze"
```
(https://ffmpeg.org/ffmpeg-filters.html#blackdetect, https://ffmpeg.org/ffmpeg-filters.html#freezedetect)

**Estadísticas de audio detalladas (RMS, crest factor, pico por ventana)**
```bash
ffmpeg -i input.mp4 -af "astats=metadata=1:reset=1,ametadata=print:file=astats.txt" -f null -
```
(https://ffmpeg.org/ffmpeg-filters.html#astats)

**Extracción de la pista de audio para ASR**
```bash
ffmpeg -i input.mp4 -vn -ac 1 -ar 16000 -c:a pcm_s16le audio.wav
```

**Nota de rendimiento:** `ffmpeg-normalize` (https://pypi.org/project/ffmpeg-normalize/) envuelve `loudnorm` en dos pasadas si además quieres *corregir* y no solo medir.

### 1.2 PySceneDetect — detección de cortes de calidad

Versión actual 0.7.1 (https://www.scenedetect.com/docs/latest/api/detectors.html). Detectores y sus defaults verificados:

| Detector | Parámetro clave (default) | Qué mide |
|---|---|---|
| `ContentDetector` | `threshold=27.0`, `min_scene_len=15` frames, `weights=(hue 1.0, sat 1.0, lum 1.0, edges 0.0)`, `luma_only=False` | Cambio medio de intensidad/color en HSV entre fotogramas adyacentes. El de uso general. |
| `AdaptiveDetector` | `adaptive_threshold=3.0`, `min_scene_len=15`, `window_width=2`, `min_content_val=15.0` | Igual que ContentDetector pero con umbral móvil (media deslizante). Reduce falsos positivos con cámara en movimiento — **el correcto para TikTok**, donde hay mucho handheld. |
| `ThresholdDetector` | `threshold=12`, `fade_bias=0.0`, `method=FLOOR` | Fundidos a negro/blanco. |
| `HashDetector` | `threshold=0.395`, `size=16`, `lowpass=2` | Distancia de Hamming entre hashes perceptuales. Muy rápido. |
| `HistogramDetector` | `threshold=0.05`, `bins=256` | Diferencia de histograma del canal Y (YUV). |

CLI:
```bash
scenedetect -i input.mp4 detect-adaptive list-scenes -f scenes.csv
```
(https://www.scenedetect.com/features/)

De aquí salen directamente: **número de planos**, **duración de cada plano**, **cortes por minuto**, **duración del primer plano** (el número más importante del hook), **duración mediana y desviación** (ritmo regular vs. errático).

### 1.3 OpenCV y visión por computador

- **Flujo óptico denso (movimiento global por segundo):** `cv2.calcOpticalFlowFarneback` (https://learnopencv.com/optical-flow-in-opencv/). Para tiempo real hay `cv2.DISOpticalFlow_create()` con presets ULTRAFAST/FAST/MEDIUM, que maneja mejor desplazamientos grandes y es el estándar de facto cuando Farnebäck es inestable y las redes tipo RAFT son demasiado lentas (https://learnopencv.com/optical-flow-in-opencv/). Con clips a 1–2 fps reescalados a 240 px de ancho, el costo es despreciable.
  - Atajo barato sin OpenCV: `YDIF` de `signalstats` (§1.1) ya da una proxy de movimiento por fotograma.
- **Enfoque / desenfoque:** varianza del Laplaciano (`cv2.Laplacian(img, cv2.CV_64F).var()`). Métrica estándar de "blur score"; umbral depende de la resolución, hay que calibrarlo sobre el propio corpus. **[FOLCLORE TÉCNICO con base razonable, sin umbral universal publicado]**
- **Estabilidad de cámara:** magnitud de la componente de traslación global del flujo óptico, o `vidstabdetect` de ffmpeg (https://ffmpeg.org/ffmpeg-filters.html#vidstabdetect), que produce un fichero de transformaciones por fotograma del que se puede leer el jitter.
- **Rostro y tamaño en cuadro:**
  - **YuNet** (incluido en OpenCV Zoo, `cv2.FaceDetectorYN`): el más eficiente en un benchmark sobre WIDER FACE, ~0.03 s por rostro, pensado para CPU sin enviar imágenes a la nube (https://learnopencv.com/what-is-face-detection-the-ultimate-guide/).
  - **MediaPipe Face Detector / Face Landmarker**: ~0.04 s, 180–200 fps, y además entrega blendshapes (expresión) y 3D landmarks (https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker). BlazeFace está diseñado para rostros cercanos tipo selfie — exactamente el caso de TikTok (https://learnopencv.com/what-is-face-detection-the-ultimate-guide/).
  - **Tamaño del rostro en cuadro:** área del bounding box normalizada (w×h sobre el frame). Ver §7 para el umbral que usa Google.
- **Relación de aspecto y zonas seguras:** cálculo puro a partir de `width`/`height`. Ver §3.3 para las zonas de UI.

### 1.4 Catálogo de métricas objetivas extraíbles

Por segundo (o por plano), todo lo siguiente es calculable sin ningún modelo de lenguaje:

**Ritmo / montaje**
- duración de cada plano, duración del primer plano, planos por minuto, mediana y σ de duración de plano, planos en los primeros 3 s, proporción de planos < 1 s.

**Imagen**
- brillo medio (YAVG), contraste (YMAX−YMIN o σ de luminancia), saturación media (SATAVG), temperatura de color aproximada (HUEAVG), blur score (varianza del Laplaciano), magnitud de flujo óptico por segundo, jitter/estabilidad, fotogramas negros, fotogramas congelados.

**Encuadre**
- resolución, relación de aspecto, presencia de rostro por segundo, área normalizada del rostro mayor, posición del rostro (centro/tercios), número de personas.

**Audio** (detalle en §2)
- LUFS integrada, LUFS short-term por segundo, LRA, true peak, dBTP, silencios (inicio/fin/duración), proporción de segundos con voz.

**Texto en pantalla** (detalle en §3)
- segundo de aparición y desaparición de cada bloque de texto, altura del texto en px y en % de la pantalla, posición del bounding box, colisión con zona segura, número de palabras en pantalla simultáneas.

---

## 2. Audio y voz: transcripción con marcas por palabra

### 2.1 Quién da timestamps por palabra, y a qué precio

| Motor | Word timestamps | Diarización | Precio oficial | Local |
|---|---|---|---|---|
| **Deepgram Nova-3** (batch) | Sí, nativo: `words[]` con `start`/`end`/`confidence`/`punctuated_word` (https://developers.deepgram.com/docs/pre-recorded-audio) | Sí, incluida en pre-grabado | **$0.0043/min** PAYG; multilingüe **$0.0052/min** (https://deepgram.com/pricing) | Self-host existe pero **el precio no está publicado** |
| **AssemblyAI Universal-3.5 Pro** | Sí, `words[]` con tiempos en **ms** + `confidence` + `speaker` (https://www.assemblyai.com/docs/api-reference/transcripts/get) | Sí, +$0.02/hr | **$0.21/hr = $0.0035/min** (https://www.assemblyai.com/pricing) | No |
| **AssemblyAI Universal-2** | Sí | Sí | **$0.15/hr = $0.0025/min** | No |
| **ElevenLabs Scribe v2** | Sí, "precise word-level timestamps" (https://elevenlabs.io/docs/models) | Sí, hasta **32 hablantes** (https://elevenlabs.io/docs/capabilities/speech-to-text) | **$0.22/hr = $0.00367/min** (https://elevenlabs.io/pricing/api) | No |
| **OpenAI `whisper-1`** | **Sí — el único modelo de OpenAI con `timestamp_granularities=["word"]`** | No | **$0.006/min** (https://developers.openai.com/api/docs/pricing) | No |
| **OpenAI `gpt-4o-transcribe`** | **NO** — rechaza `timestamp_granularities` | No | $0.006/min | No |
| **Google STT v2 / Chirp** | `enableWordTimeOffsets` **[NO VERIFICADO en esta sesión]** | **[NO VERIFICADO]** | $0.016/min estándar; **Dynamic Batch $0.003/min** (resultado ≤24 h) (https://cloud.google.com/speech-to-text/pricing) | No |
| **Azure Speech batch** | `requestWordLevelTimestamps` **[NO VERIFICADO]** | add-on | **$0.18/hora = $0.003/min** (SKU `S1 Speech to Text Batch`, eastus, Azure Retail Prices API) | Contenedor desconectado: $12.960/año por 2.000K tx |
| **faster-whisper** (SYSTRAN) | Sí, `word_timestamps=True` → `word.start`/`word.end` (https://github.com/SYSTRAN/faster-whisper) | No | **$0** | Sí |
| **WhisperX** | Sí, vía **forced alignment con wav2vec2** | **Sí, con pyannote 3.x** | **$0** | Sí |
| **whisper.cpp** | Sí, vía **DTW sobre pesos de cross-attention**, flag `--dtw-timestamps` (https://github.com/ggml-org/whisper.cpp/discussions/2307) | No | **$0** | Sí, incluso en CPU |
| **NVIDIA Parakeet-TDT-0.6B-v3** | **Sí, word-level y segment-level nativos**, licencia **CC-BY-4.0**, ≥2 GB RAM, 25 idiomas europeos incl. español (https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3) | No | **$0** | Sí |
| **NVIDIA Canary-1B-v2** | Sí, vía NeMo Forced Aligner, CC-BY-4.0, ≥6 GB RAM (https://huggingface.co/nvidia/canary-1b-v2) | No | **$0** | Sí |

**Depreciados:** AssemblyAI Slam-1 (migrar a Universal-3.5 Pro) y ElevenLabs Scribe v1 ("outclassed by v2 models", https://elevenlabs.io/docs/models).

### 2.2 Precisión en ESPAÑOL — la única tabla con fuente revisada

Del paper de NVIDIA arXiv:2509.14128, tablas 11–13, columna `es`, extraídas del PDF oficial (https://arxiv.org/pdf/2509.14128). WER en %, menor es mejor:

| Modelo | FLEURS es | MLS es | CoVoST2 es |
|---|---|---|---|
| **Canary-1B-v2** | **2.90** | **2.94** | 3.81 |
| Phi-4-multimodal-instruct | 3.23 | 3.72 | 3.81 |
| Voxtral-Mini-3B-2507 | 3.34 | 3.85 | 4.23 |
| whisper-large-v3 | 3.12 | 4.89 | 4.32 |
| Parakeet-TDT-0.6B-v3 | 3.45 | 4.39 | **3.41** |
| seamless-m4t-v2-large | 5.10 | 3.08 | 4.20 |

**Conclusión dura: en español, Canary-1B-v2 (2.90 en FLEURS) supera a Whisper large-v3 (3.12), y es open weights CC-BY-4.0.** Velocidad (RTFx, HF Open ASR Leaderboard, tabla 5 del mismo paper): Parakeet-TDT-0.6B-v3 **3332×**, Canary-1B-v2 **749×**, whisper-large-v3 **145×**.

Advertencia del propio paper: los modelos NVIDIA obtienen timestamps con **NeMo Forced Aligner + modelo CTC auxiliar**, y para salidas de *traducción* hay que usar timestamps de segmento porque los de palabra pueden ser inexactos.

**El leaderboard agregado de Artificial Analysis (https://artificialanalysis.ai/speech-to-text/non-streaming)** da Scribe v2 2.2% AA-WER, AssemblyAI Universal-3 Pro 3.1%, GPT-4o Transcribe 4.0%, Whisper Large v3 4.1%, Deepgram Nova-3 5.2%. **Pero no tiene desglose por español** — verificado explícitamente. **No usar como proxy de español.**

### 2.3 Velocidad local real

Benchmark oficial del README de faster-whisper, 13 minutos de audio, **RTX 3070 Ti 8 GB, CUDA 12.4** (https://github.com/SYSTRAN/faster-whisper):

| Implementación (large-v2) | Precisión | Tiempo (13 min audio) | VRAM |
|---|---|---|---|
| openai/whisper | fp16 | 2m23s | 4708 MB |
| whisper.cpp (Flash Attention) | fp16 | 1m05s | 4127 MB |
| **faster-whisper** | fp16 | **1m03s** | 4525 MB |
| **faster-whisper `batch_size=8`** | fp16 | **17s** | 6090 MB |
| faster-whisper `batch_size=8` | int8 | **16s** | 4500 MB |

En CPU, modelo **small**, 13 min: whisper.cpp **2m05s / 1049 MB**, faster-whisper 2m37s.

**Extrapolación a un clip de 60 s** (aritmética sobre las cifras anteriores, **no son cifras publicadas**):

| Config | RTF | ≈ tiempo para 60 s |
|---|---|---|
| faster-whisper large-v2 fp16 beam5 (3070 Ti) | 0.081 | ~4.8 s |
| faster-whisper large-v2 fp16 batch=8 | 0.022 | ~1.3 s |
| faster-whisper large-v3-turbo fp16 | 0.025 | ~1.5 s |
| faster-whisper small fp32 **CPU** | 0.201 | ~12 s |

> **Advertencia práctica:** en clips de 60 s el wall-clock lo domina el **overhead fijo** (carga de modelo, VAD, alineación), no el RTF. Hay que mantener el modelo residente y batchear varios videos.
>
> **[NO VERIFICADO]** No existe benchmark primario de faster-whisper large-v3 en T4 / L4 / A10G. El README solo publica RTX 3070 Ti.

### 2.4 Métricas de voz derivadas

Una vez que el ASR devuelve marcas de tiempo **por palabra**, estas métricas son aritmética pura y son las que realmente sirven para dar feedback:

- **Palabras por minuto global** = nº de palabras / duración total × 60.
- **WPM en ventana deslizante de 5 s** — detecta el tramo donde el creador se acelera o se apaga. Es lo que permite decir "del segundo 18 al 23 hablas a 280 wpm, ahí se pierde la gente".
- **Densidad de habla** = suma de duraciones de palabras / duración total. Proporción del video con voz.
- **Pausas retóricas** = huecos entre palabra_n.end y palabra_n+1.start > 0.35 s. Su número, su duración media y su posición.
- **Tiempo hasta la primera palabra** — cuántos segundos pasan antes de que alguien hable. Un video que tarda 2 s en arrancar la voz ya perdió.
- **Rango dinámico de voz** = LRA de `ebur128` restringido a los segmentos con voz.
- **Relación música/voz**: separar pistas con **Demucs** (https://github.com/adefossez/demucs) o **Spleeter**, medir LUFS short-term de cada stem y calcular la diferencia en LU durante los segmentos con voz. Si la música está a menos de ~6 LU por debajo de la voz, la voz compite. **[Umbral de folclore de mezcla, sin fuente publicada.]**

**Calibración del umbral de WPM para español:** no se puede copiar de guías en inglés. El estudio de Pellegrino et al. en *Language* midió el español en **7.82 sílabas/segundo** frente a 6.19 del inglés (~26% más rápido), con menor densidad informativa por sílaba de modo que la tasa de información resulta comparable (https://www.scientificamerican.com/article/fast-talkers/). Traducción: un umbral tipo "máximo 150 wpm" importado del inglés marcará como "demasiado rápido" a un hablante de español perfectamente normal. **Hay que calibrar percentiles sobre corpus propio en español antes de fijar cualquier umbral.**

**Librerías:**

| Necesidad | Librería | Dato duro |
|---|---|---|
| VAD / pausas | **Silero VAD** | Licencia **MIT**, modelo JIT ~2 MB, **<1 ms por chunk de 30 ms en 1 hilo de CPU** (https://github.com/snakers4/silero-vad) |
| VAD + diarización | **pyannote.audio 4.0** `speaker-diarization-community-1` | CC-BY-4.0; **31 s por hora de audio** en AMI, 37 s/hora en DIHARD 3 (https://huggingface.co/pyannote/speaker-diarization-community-1) |
| Tasa de habla, prosodia | **praat-parselmouth** | Expone el código de Praat: "los algoritmos y su salida son exactamente los mismos que en Praat" (https://github.com/YannickJadoul/Parselmouth) |
| Convención de medición | — | *speaking rate* = sílabas / duración total; *articulation rate* = sílabas / duración sin pausas; silencios **>0.1 s cuentan como pausa** (https://arxiv.org/pdf/2209.13260) |
| Loudness por stem | **pyloudnorm** | Implementa **ITU-R BS.1770-4** (LUFS integrado con gating) + LRA en LU (https://github.com/csteinmetz1/pyloudnorm) |
| Separación música/voz | **Demucs v4 (htdemucs)** | **MIT**; **9.0 dB SDR en MUSDB HQ**; CPU ≈ 1.5× la duración del track; GPU mínimo 3 GB VRAM; **`--two-stems=vocals` = modo karaoke** (https://github.com/adefossez/demucs) |
| Alternativas | Spleeter / open-unmix | Spleeter sin actualizaciones mayores desde 2019; brecha ≈3 dB SDR frente a Demucs v4 **[fuente secundaria]** |

---

## 3. Texto en pantalla: OCR por fotograma

### 3.1 Motores open source

| Motor | Español | Precisión | Velocidad | Licencia |
|---|---|---|---|---|
| **PaddleOCR PP-OCRv5** | 106 idiomas; `latin_PP-OCRv5_mobile_rec` cubre 45 incl. español, `--lang es` (http://www.paddleocr.ai/latest/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5_multi_languages.html) | latin mobile rec **84.7%** (+46.8% vs generación previa); det Hmean 0.827 server / 0.770 mobile | **V100: 0.62 s/img mobile, 0.74 s/img server. CPU: 1.75 s mobile, 4.34 s server** (http://www.paddleocr.ai/main/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html) | Apache 2.0 |
| **PaddleOCR PP-OCRv6** | — | 83.2% rec acc / 86.2% det Hmean; supera a Qwen3-VL-235B, GPT-5.5 y Gemini-3.1-Pro con órdenes de magnitud menos parámetros (https://arxiv.org/abs/2606.13108, 11-jun-2026) | tiny **3.9× más rápido** que v5_mobile en Xeon | **[Paper verificado; release en el repo NO verificada]** |
| **Surya 2** | 91 idiomas, **español 90.7% pass rate** (https://github.com/datalab-to/surya) | olmOCR-bench 83.3%, top <3B params | RTX 5090+vllm: 5.35 páginas/s @128 concurrencia | ⚠ **código Apache 2.0, pesos bajo AI Pubs Open Rail-M modificada: gratis solo research/personal/startups <$5M** |
| **docTR** | Vocabulario francés que "incluye la mayoría de caracteres europeos y americanos" (https://github.com/mindee/doctr/discussions/837) | CER 0.197, empata al mejor VLM en impreso limpio | CPU+GPU optimizado | Apache 2.0 |
| **EasyOCR** | latín incl. español | intermedio | ~715 ms/img CPU **[benchmark de terceros sin hardware declarado]** | Apache 2.0 |
| **Tesseract** | latín incl. español | el más débil (~45% en manuscrito vs ~73% PaddleOCR) (https://gigagpu.com/paddleocr-vs-tesseract-vs-easyocr/) | ~453 ms/img CPU, el más rápido | Apache 2.0 |
| **RapidOCR** | modelos PaddleOCR convertidos a ONNX | — | backends ONNX Runtime, OpenVINO, MNN, TensorRT (https://github.com/RapidAI/RapidOCR) | **Apache 2.0** código y pesos |
| **Apple Vision** `VNRecognizeTextRequest` | Revision 2 nivel *accurate* incluye **ES** (https://developer.apple.com/forums/thread/121048) | on-device | on-device | Gratis, solo macOS/iOS |

**Veredicto para texto estilizado de TikTok/Reels (outline, sombra, fondo en movimiento):** `PP-OCRv5_server_det` está explícitamente diseñado para "handwriting, vertical, rotated, and curved text… complex layouts, varying text sizes, and challenging backgrounds" (https://huggingface.co/PaddlePaddle/PP-OCRv5_server_det). Es el detector más adecuado. Benchmarks de terceros lo describen como el que "rara vez quedó primero en ninguna categoría y rara vez falló mal en ninguna", que para un pipeline en producción importa más que un pico aislado.

### 3.2 Precios cloud verificados

| Servicio | Precio | Free tier |
|---|---|---|
| **Google Cloud Vision** `TEXT_DETECTION` | **$1.50 / 1000 unidades** (1.001–5M/mes); $0.60/1000 (5M+) (https://cloud.google.com/vision/pricing) | 1000 unidades/mes |
| **AWS Rekognition `DetectText`** (imagen) | **$1.00 / 1000 img** (primer 1M); $0.80 (siguientes 4M); $0.60 (siguientes 30M) (https://aws.amazon.com/rekognition/pricing/) | 1000 img/mes, 12 meses |
| **Azure AI Vision Read** | **$1.50 / 1K transacciones** (0–1M); $0.60/1K (1M+), eastus (Azure Retail Prices API) | **5.000 tx/mes** |

**APIs de texto sobre VIDEO (tu pregunta explícita sobre AWS):**

**Sí, `StartTextDetection` existe** — API asíncrona de Rekognition Video para texto en video almacenado en S3, con su par `GetTextDetection` (https://docs.aws.amazon.com/rekognition/latest/APIReference/API_StartTextDetection.html). **Precio: $0.10 / minuto de video** en us-east-1, us-east-2, us-west-2 y eu-west-1 (AWS Price List API, meter `MinsOfArchVideoProcessed`); $0.12–0.14 en otras regiones. Free tier: 60 min/mes durante 12 meses. Idiomas: "most **Latin scripts** and numbers", sin lista por idioma (https://aws.amazon.com/rekognition/faqs/). **[Matiz: la `groupDescription` del meter no enumera TextDetection explícitamente, aunque la página pública sí lo lista ligado a esa variable de precio.]**

**Google Video Intelligence API** (https://cloud.google.com/video-intelligence/pricing), tras 1.000 min gratis/mes:

| Feature | Precio |
|---|---|
| **Text detection** | **$0.15/min** |
| Object tracking / Logo detection | $0.15/min |
| Label detection | $0.10/min |
| **Speech transcription** | **$0.048/min** |

### 3.3 La aritmética que decide la arquitectura

Coste de OCR para **un** video de 60 s:

| Enfoque | Coste/video |
|---|---|
| AWS Rekognition `StartTextDetection` (video) | **$0.100** |
| Google Video Intelligence text detection | **$0.150** |
| 60 fotogramas a 1 fps → Google Cloud Vision | **$0.090** |
| 60 fotogramas → Azure Read | **$0.090** |
| 60 fotogramas → AWS DetectText | **$0.060** |
| 60 fotogramas → **PaddleOCR self-host** | **$0** (≈37 s CPU mobile; ≈37 s en serie en V100, paralelizable) |

Comparado con STT: Deepgram Nova-3 multilingüe **$0.0052**, ElevenLabs Scribe v2 **$0.00367**, Chirp Dynamic Batch **$0.003**, OpenAI whisper-1 **$0.006** por el mismo minuto.

> **Conclusión económica dura: el OCR de video en la nube cuesta 20–40× más que el STT en la nube por el mismo minuto. Para un producto que analiza miles de clips, el OCR TIENE que ser self-hosted (PaddleOCR PP-OCRv5 mobile); el STT en la nube sigue siendo barato incluso a escala.**

### 3.4 Zonas seguras de la UI: dónde NO puede caer el texto

Esta es la comprobación más fácil de implementar y la que más valor inmediato da al creador, porque es binaria y verificable a ojo.

**El problema:** cada plataforma superpone su propia interfaz sobre el video. Texto que en el editor se ve perfecto queda tapado por el caption, la barra de música o la columna de botones.

**TikTok.** TikTok **reconoce oficialmente que su zona segura no es fija**: depende del formato (vertical/horizontal/cuadrado), de la longitud del caption y de los add-ons interactivos — a mayor caption, menor zona segura — y recomienda previsualizar el resultado real y descargar sus plantillas (https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads?lang=en). Por eso **no existe un número oficial único**, y las cifras de terceros discrepan entre sí:

| Fuente | Superior | Inferior | Izquierda | Derecha |
|---|---|---|---|---|
| Kreatli (https://kreatli.com/guides/tiktok-safe-zone) | 130 px | 484 px | — | 140 px |
| Zeely (https://zeely.ai/blog/tiktok-safe-zones/) | 108 px | 320 px | 60 px | 120 px |

**Recomendación de ingeniería:** implementar el perfil **conservador** (130 px arriba / 484 px abajo / 140 px derecha / 60 px izquierda sobre lienzo 1080×1920) como default, exponer el perfil permisivo como opción, y **avisar en la UI de que la zona real varía con el caption**. Nunca presentar la cifra como si fuera especificación oficial de TikTok.

**Meta (Instagram Reels / Stories, Facebook Reels / Stories).** Meta publica guía oficial de texto superpuesto y zona segura (https://www.facebook.com/business/help/980593475366490) y ofrece la herramienta **Safe Zone Guardrail** dentro de Ads Manager, que superpone las regiones seguras e inseguras durante la configuración del anuncio. Las cifras que circulan son **14% arriba (270 px), 35% abajo (670 px), 6% a cada lado (65 px)** sobre 1080×1920, unificadas desde marzo de 2026 para las cuatro ubicaciones (https://behaviour.digital/post/meta-reels-safe-zone-14-top-35-bottom-6-sides-the-2026-official-guide). **[NO VERIFICADO contra la página de Meta: la URL oficial existe y trata exactamente de esto, pero no pude extraer sus cifras.]**

**YouTube Shorts.** No encontré especificación oficial de zona segura publicada por Google. **[NO VERIFICADO.]** La práctica de la industria es aplicar un margen conservador similar al de Meta.

**Implementación.** Con los bounding boxes que devuelve el OCR (§3.1), la comprobación es trivial: para cada bloque de texto detectado, normalizar el box a coordenadas 0–1 y comprobar intersección con los rectángulos de UI de cada plataforma. El resultado útil para el creador es: *"el texto «X» del segundo 4 al 9 queda tapado en un 38% por el caption de TikTok"*, con un fotograma renderizado con el overlay encima.

### 3.5 Tracking temporal: cuándo aparece y desaparece cada texto

Técnicas con respaldo en literatura:

1. **Tracking-by-detection** — el paradigma dominante: detectar texto en cada frame y asociar instancias entre frames adyacentes por **IoU, transcripción y similitud de features** (https://arxiv.org/pdf/2203.10539).
2. **IoU + distancia de edición** — los trackers enlazan objetos de texto por IoU **y edit distance de las transcripciones**, manteniendo un historial acotado por track (https://arxiv.org/pdf/2203.10539, https://arxiv.org/html/2607.03131).
3. **Voto mayoritario ponderado por confianza** — el texto final del track sale de un voto ponderado sobre su historial; **corrige errores de un solo carácter que aparecen solo en una minoría de frames** (https://arxiv.org/html/2607.03131).
4. **Coste de matching multi-métrica** — suma ponderada de IoU de caja, similitud textual, proximidad de tamaño y vecindad geométrica (https://arxiv.org/pdf/2304.04376).

**Pipeline recomendado:** muestrear a **2–4 fps** → PP-OCRv5 det+rec por frame → asociar tracks por **IoU > 0.5 Y normalized edit distance < 0.3** → cerrar track tras N frames sin match → emitir `(texto_consensuado, t_inicio, t_fin, bbox_medio, confianza_media)`. Esto da exactamente la semántica "apareció / desapareció" que necesita el producto, y el voto ponderado limpia el jitter del OCR.

**[NO VERIFICADO]** No hay literatura que respalde perceptual hashing (pHash/dHash) como método estándar de dedup de texto en video. Es heurística práctica común, sin validación publicada para este caso.

---

## 4. Análisis semántico con modelos multimodales

### 4.1 Quién acepta video nativo y quién no

**Gemini — sí, video nativo, y es el único de los tres grandes con soporte de primera clase.**
Límites oficiales (https://ai.google.dev/gemini-api/docs/video-understanding):
- Modelos con ventana de 1 M de contexto procesan **hasta 3 horas** de video a resolución media baja, o **1 hora** a resolución alta.
- Muestreo por defecto: **1 fotograma por segundo**; configurable vía el argumento `fps` (p. ej. 0.5 fps = 1 frame cada 2 s).
- Coste en tokens en modo estático: **~100 tokens/segundo** a `media_resolution` baja (66 tokens/frame) o **~300 tokens/segundo** a alta (258 tokens/frame). El audio suma **32 tokens/segundo** y se procesa a 1 Kbps mono.
- Entrada: **File API hasta 20 GB** (2 GB en tier gratuito), **inline < 100 MB**, o URL de YouTube pública.
- Recorte: `start_offset` / `end_offset` en milisegundos (solo modo estático).
- Formatos: MP4, MPEG, MOV, AVI, FLV, MPG, WebM, WMV, 3GPP.
- El "modo agéntico" muestrea dinámicamente y usa hasta **88% menos tokens** en contenido largo.

Precios vigentes (https://ai.google.dev/gemini-api/docs/pricing), por millón de tokens:

| Modelo | Input | Output |
|---|---|---|
| `gemini-3.5-flash-lite` | $0.30 | $2.50 |
| `gemini-3.1-flash-lite` | $0.25 (texto/imagen/video) · $0.50 (audio) | $1.50 |
| `gemini-3.8-flash` / `3.7` / `3.6` | $0.75 (hasta 31-dic-2026; $1.50 después) | $3.75 ($7.50 después) |
| `gemini-3.5-flash` | $1.50 | $9.00 |
| `gemini-3.1-pro-preview` | $2.00 (≤200k) / $4.00 (>200k) | $12.00 / $18.00 |
| `gemini-2.5-flash` | $0.30 (texto/imagen/video) · $1.00 (audio) | $2.50 |
| `gemini-2.5-pro` | $1.25 (≤200k) / $2.50 (>200k) | $10.00 / $15.00 |

**Cuenta concreta para un video de 60 s:**
- Resolución baja: 60 s × ~100 tok/s ≈ **6.000 tokens** de entrada. Con `gemini-3.8-flash` a $0.75/M → **$0.0045**. Con `gemini-2.5-flash` a $0.30/M → **$0.0018**.
- Resolución alta (necesaria si quieres que el modelo lea el texto pequeño en pantalla): 60 × 300 ≈ **18.000 tokens** → **$0.0135** con 3.8-flash.
- Es decir: **menos de 2 centavos de dólar por video**. El LLM no es el cuello de botella de costo.

**Claude — no acepta video; solo imágenes.** La Messages API admite bloques `image` (base64, URL o `file_id` de la Files API) y documentos PDF; las animaciones GIF no se procesan, "solo se usa el primer fotograma" (https://platform.claude.com/docs/en/build-with-claude/vision). Límites relevantes:
- **100 imágenes por request** en modelos de 200k de contexto; **600 por request** en el resto; 20 por mensaje en claude.ai.
- Máximo **10 MB por imagen** (base64) vía API directa; **8000×8000 px**.
- Si el request lleva **más de 20 imágenes**, aplica un límite de dimensión más estricto a *todas*: hay que redimensionar a **≤2000 px** por lado o quedarse en ≤20 bloques.
- Límite de tamaño de request: **32 MB**.
- Coste en tokens: Claude ve parches de 28×28 px, así que una imagen cuesta `⌈ancho/28⌉ × ⌈alto/28⌉` tokens visuales. Modelos 4.7+ son de "alta resolución" (borde largo hasta 2576 px, máximo 4784 tokens visuales); el resto, 1568 px / 1568 tokens.
- Precios (https://claude.com/pricing): Opus 5 $5/$25 por M, Sonnet 5 $2/$10, Haiku 4.5 $1/$5.
- **Cuenta para 60 fotogramas de 540×960:** ⌈540/28⌉×⌈960/28⌉ = 20×35 = **700 tokens visuales por frame** → 42.000 tokens → con Sonnet 5 a $2/M = **$0.084**. Reduciendo a 20 frames clave (uno por plano) baja a **$0.028**. Sigue siendo barato, pero ~5–20× más caro que Gemini en video nativo.

**OpenAI — no acepta video nativo en la API.** La Responses API admite imágenes, PDFs, documentos, hojas de cálculo y código, pero **no** archivos de video (mp4/webm/mov); el cookbook oficial recomienda extraer fotogramas con ffmpeg y enviarlos como array de imágenes (https://github.com/openai/openai-node/issues/1778). Hay un feature request abierto pidiendo paridad con Gemini. **[Verificado vía issue del SDK oficial, no vía página de docs — el comportamiento puede haber cambiado después de septiembre 2026.]**

### 4.2 Cómo usarlo bien: la arquitectura correcta es híbrida

El error caro es mandarle el video crudo al LLM y pedirle "dime si va a funcionar". Lo que funciona en producción —y lo demuestra el único sistema de referencia abierto de Google, el **ABCDs Detector** (https://github.com/google-marketing-solutions/abcds-detector)— es una **doble verificación**:

1. **Primero anotaciones deterministas** (Video Intelligence API en el caso de Google; en nuestro caso ffmpeg + PySceneDetect + ASR + OCR). Estas dan hechos duros: cuántos planos, en qué segundo, dónde está el rostro, qué texto aparece cuándo.
2. **Luego el LLM**, alimentado con esas anotaciones como contexto, responde solo las preguntas **semánticas** que las anotaciones no pueden responder: ¿el hook promete algo concreto?, ¿la promesa se cumple?, ¿el CTA es claro?, ¿el tono es nativo de la plataforma?

El propio README de Google es explícito sobre el límite: "dado que el enfoque LLM es propenso a alucinaciones, se esperan falsos positivos o falsos negativos, y la solución seguirá requiriendo QA humano si se requiere 100% de exactitud" (https://github.com/google-marketing-solutions/abcds-detector/blob/main/README.md). Esa frase debería estar en la UI de nuestro producto.

**Prácticas recomendadas concretas, derivadas de los prompts reales del ABCDs Detector** (https://github.com/google-marketing-solutions/abcds-detector/blob/main/features_repository/shorts_features.py):

- **Un prompt por feature, no un prompt gigante.** Google define ~20 features de Shorts, cada una con su `evaluation_criteria`, su `prompt_template` y su formato de respuesta. Esto hace el sistema auditable y permite cachear.
- **Pedir siempre cuatro campos:** `detected` (bool), `confidence_score` (0–1), `feature_density_score` (fracción del video donde ocurre) y `feature_quality_score` (0–1), **más timestamps de evidencia**. Sin timestamps citados no hay feedback accionable.
- **Darle al modelo un rol y una rúbrica de clasificación explícita.** Ejemplo textual de su prompt de encuadre: "Extreme Close-Up (ECU): el sujeto llena >80% del cuadro. Close-Up (CU): 60%–80%. Medium Shot: 30%–59%. Wide/Long: <30%."
- **Definir "zonas Goldilocks" en vez de máximos.** Su métrica de encuadre cerrado puntúa mejor una densidad de **30%–60%** del video, con bonus si los **primeros 3 segundos** contienen encuadre cerrado. Ni poco ni todo.
- **Inyectar `metadata_summary`** (duración, número de planos, transcripción con tiempos) en cada prompt, para que el modelo no tenga que inferir lo que ya sabemos con certeza.
- **Muestreo denso en el hook.** Si el presupuesto de tokens aprieta, gasta la resolución alta en los primeros 3 s y baja el resto.

---

### 4.3 La palanca de coste: empaquetar fotogramas en hojas de montaje

**Los tokens de Claude escalan con píxeles, no con número de imágenes** (§4.1: `⌈ancho/28⌉ × ⌈alto/28⌉`). Por tanto, meter 9 fotogramas en una hoja 3×3 del mismo tamaño total cuesta lo mismo que un solo fotograma:

| Empaquetado | Tokens visuales |
|---|---|
| 60 fotogramas @614×1092, sueltos | 60 × (22×39) = **51.480** |
| 24 fotogramas @614×1092, sueltos | **20.592** |
| 60 fotogramas @448×784, sueltos | 60 × (16×28) = **26.880** |
| **60 fotogramas en 7 hojas de 3×3 @614×1092** | 7 × 858 = **6.006** ← **8,6× más barato** |

Cada sub-fotograma de la hoja 3×3 mide 204×364 px: suficiente para composición, cortes, movimiento, encuadre, presencia de rostro y disposición general; **insuficiente para texto pequeño de subtítulo**. Y eso está bien, porque **PaddleOCR ya leyó el texto a resolución completa** y se le pasa al modelo como texto.

> **Esta es la arquitectura correcta: OCR a resolución completa para el texto, montaje a baja resolución para la narrativa visual.** Se implementa con un filtro `tile` de ffmpeg y reduce el coste del LLM 3,5× (§8.10, config G → C).

```bash
# 9 fotogramas en una hoja 3x3
ffmpeg -i input.mp4 -vf "fps=1,scale=205:-2,tile=3x3" -q:v 3 sheets/s_%02d.jpg
```

**Trampa que se va a encontrar sí o sí:** por encima de **20 bloques de imagen por request**, Claude aplica un límite de dimensión más estricto a *todas* las imágenes — hay que redimensionar a ≤2000 px por lado o quedarse en ≤20 bloques (https://platform.claude.com/docs/en/build-with-claude/vision). El empaquetado en hojas resuelve esto de paso: 60 fotogramas caben en 7 bloques.

**Con Gemini no aplica** — su video nativo cobra ~100 tok/s a resolución baja y ~300 tok/s a alta, independientemente del empaquetado, e ingiere el audio a 32 tok/s. Por eso su configuración sale 2–3× más barata todavía (§8.10).

---

## 5. Predicción de desempeño: qué dice la evidencia (y qué vende el mercado)

### 5.1 El hallazgo central, replicado en tres fuentes independientes

**Cuando el objetivo es "cuántas views va a hacer", las features del creador y la tracción temprana dominan abrumadoramente a las features del contenido. Cuando el objetivo es "retención temprana normalizada", el contenido solo llega a SROCC ≈ 0.66–0.71 — señal genuinamente útil.**

Ablaciones concretas:

**MVP, ganador del SMP Challenge 2025, pista de video** (https://arxiv.org/html/2507.00950v1). Dataset SMPD-Video: 6.000 posts de 4.500 usuarios, 24 meses, 120 categorías. Modelo CatBoost.

| Configuración | MAPE (menor = mejor) | Degradación |
|---|---|---|
| Modelo completo | 0.1754 | — |
| **sin features de usuario** | **0.3010** | **+72%** |
| sin embeddings de video | 0.1818 | +3.6% |
| sin embeddings de texto | 0.1810 | +3.2% |

Es decir: **quitar todo el contenido visual cuesta ~4% de exactitud; quitar las features del creador cuesta ~72%.** Conclusión de los propios autores: "el historial de engagement del usuario y las características de su red social representan los predictores primarios de viralidad" (https://arxiv.org/html/2507.00950v1).

**SMTPD, CVPR 2025** (https://openaccess.thecvf.com/content/CVPR2025/html/Xu_SMTPD_A_New_Benchmark_for_Temporal_Prediction_of_Social_Media_CVPR_2025_paper.html, arXiv https://arxiv.org/html/2503.04446v1). 282.400 muestras de YouTube, 152.700 usuarios únicos, seguimiento diario de views a 30 días.

| Condición | AMAE (log views) | ASRC |
|---|---|---|
| Modelo completo (con views del día 1) | 0.717 | 0.959 |
| **sin views del día 1** | **1.630** | 0.849 |

"Pronosticar con exactitud la popularidad del primer día es clave para predecir la popularidad futura" (https://arxiv.org/html/2503.04446v1). **La feature más predictiva de toda la literatura es precisamente la que no existe antes de publicar.**

**Virality of Dance Clips, ACM TOMM 2021** (https://ar5iv.labs.arxiv.org/html/2111.03819). 4.292 clips de TikTok. Los autores **eliminaron deliberadamente los videos de creadores con >1.000 seguidores** "para asegurar que la viralidad dependa principalmente del contenido". Resultado: **Spearman 0.34** global (rango 0.24–0.54 por reto). Este es el techo realista para predicción de engagement bruto solo con contenido.

**TikTok virality indicators, ACM 2022** (https://dl.acm.org/doi/fullHtml/10.1145/3501247.3531551, preprint https://arxiv.org/abs/2111.02452). Solo 400 videos (200 virales / 200 no) — muestra pequeña, tómese como direccional:

| Grupo de features | Mejor AUC |
|---|---|
| Perfil del creador (verificado, ≥10k seguidores) | **0.86** |
| Elementos de contenido (sujeto, escala de plano, POV, texto, emoción, estilo) | 0.81 |
| Contexto/recomendación (lifespan, tipo de hashtag) | 0.71 |
| Todo combinado | 0.93 |

90% de los videos virales vs 24% de los no virales tenían ≥10.000 seguidores. Hallazgo secundario relevante para nosotros: **la escala de plano (close-up y medium) sí importa** (https://dl.acm.org/doi/fullHtml/10.1145/3501247.3531551).

### 5.2 La buena noticia: la retención temprana SÍ se predice desde el contenido

Este es el hilo que sostiene el producto.

**SnapUGC + métrica ECR, ECCV 2024** (https://www.ecva.net/papers/eccv_2024/papers_ECCV/papers/07122.pdf, código https://github.com/dasongli1/SnapUGC_Engagement). 90.000 videos UGC reales de Snapchat Spotlight, cada uno con engagement agregado de al menos 2.000 usuarios reales. Define dos métricas independientes de la duración:
- **NAWP** — porcentaje medio de visualización normalizado.
- **ECR** — *engagement continuation rate*, probabilidad de que el espectador siga viendo **más allá de los 5 segundos**.

ECR correlaciona **0.928** con NAWP y aísla los primeros 5 s: es, literalmente, un "hook score" medible (https://arxiv.org/html/2509.02969v1).

**VQualA 2025 Challenge on Engagement Prediction for Short Videos, ICCV 2025** (https://arxiv.org/html/2509.02969v1). SnapUGC ampliado a **120.651 videos** (106.192 train / 6.000 val / 8.459 test). Tarea explícitamente **cold-start: sin datos de interacción previos, solo contenido + título/descripción/audio**.

| Puesto | Equipo | SROCC | PLCC |
|---|---|---|---|
| 1 | ECNU-SJTU VQA | **0.707** | 0.714 |
| 2 | IMCL-DAMO | 0.696 | 0.702 |
| — | Baseline oficial | 0.660 | 0.657 |
| — | Solo texto | 0.439 | 0.444 |

**Este es el número honesto para el pitch: ~0.71 de Spearman en retención temprana, solo con contenido, sin ninguna feature de cuenta.**

**LMMs para engagement, 2025** (https://arxiv.org/html/2508.02516v2). En el test de SnapUGC: VideoLLaMA2 SROCC 0.691 / PLCC 0.701; Qwen2.5-VL 0.665 / 0.662; baseline 0.657 / 0.665. **VideoLLaMA2 (audio + visual + lenguaje) supera al más moderno Qwen2.5-VL (solo visual + lenguaje)** — evidencia de que el audio aporta materialmente. Casi todos los clippers comerciales son transcript-first y se pierden esto.

**Trabajo específico sobre el hook:** "Decoding the Hook: A Multimodal LLM Framework for Analyzing the Hooking Period of Video Ads", arXiv:2602.22299, 25-feb-2026 (https://arxiv.org/abs/2602.22299). Estudia explícitamente "los primeros tres segundos" con MLLMs + BERTopic. **Advertencia: el abstract solo reporta "correlaciones", sin cifras. No pude verificar su desempeño cuantitativo.**

### 5.3 Otros trabajos 2024–2026 relevantes

| Paper | Año/venue | Dataset | Métrica reportada |
|---|---|---|---|
| Shorts-Cast (https://arxiv.org/html/2605.18653) | may-2026, Yonsei | **WebShorts: 14.000 YouTube Shorts, views diarias a 7 días** | SRC 0.612 offline / **0.677 online**; nMSE 0.701 |
| STAP (https://arxiv.org/html/2604.20311v2) | abr-2026 | MicroLens 19.307 / SMPD-video 4.000 / Informs 1.846 | SRC 0.5346 / 0.6794 / 0.6460 (vs. baseline ICPF 0.5102 / 0.4980 / 0.4985) — **sin features de creador** |
| M3TR (https://arxiv.org/abs/2411.15455) | 2024 | MicroLens-100k + TikTok INFORMS | "hasta 19.3% de mejora en nMSE" (valores absolutos no recuperables) |
| MMRA (https://dl.acm.org/doi/10.1145/3626772.3657929) | SIGIR 2024 | MicroLens-100k | **[NO VERIFICADO: PDF 404, ACM de pago]** |
| EvoPro (https://dl.acm.org/doi/abs/10.1145/3726302.3730184) | SIGIR 2025 | 3 benchmarks | "supera significativamente" (sin números accesibles) |
| XS-Video / NetGPT (https://arxiv.org/abs/2503.23746) | 2025 | **117.720 videos, 381.926 muestras, 5 plataformas chinas, grafo de 5.5M nodos / 1.7B aristas** | Ablación: quitar features de video o aristas de fans "degrada fuertemente" |
| Anchoring Trends (https://arxiv.org/html/2507.19863v1) | ACM MM 2025 | SMPD | Aborda el *drift* temporal |

**Datasets públicos utilizables para arrancar:**
- **SnapUGC** con ECR — el más alineado con nuestro problema (https://github.com/dasongli1/SnapUGC_Engagement).
- **MicroLens** — 1.000 millones de interacciones, 34M usuarios, 1M micro-videos con títulos, portadas, audio y video completo; subset público MicroLens-100K con 719.405 interacciones / 19.738 videos (https://arxiv.org/abs/2309.15379, https://github.com/westlake-repl/MicroLens). Publicado en CIKM 2025.
- **SMPD** vía SMP Challenge, ~500.000 posts de ~70.000 usuarios (https://smp-challenge.com/, https://github.com/social-media-prediction/SMPChallenge).
- **SMTPD** (https://github.com/zhuwei321/SMTPD).

**Advertencia de ingeniería:** MicroLens demuestra que los *video encoders* entrenados end-to-end superan a las features congeladas tipo CLIP **hasta 2× en NDCG** (https://dl.acm.org/doi/epdf/10.1145/3746252.3761655). STAP, con CLIP ViT-L/14 congelado, se queda en SRC 0.53 (https://arxiv.org/html/2604.20311v2). **Las embeddings congeladas son una trampa de MVP.**

### 5.4 Productos comerciales: qué prometen y qué prueban

**Ninguno del sector publica validación.** Esto no es una opinión; es el resultado de buscar la metodología en cada web oficial.

**Higgsfield Virality Predictor** (https://higgsfield.ai/apps/virality-predictor). Salidas declaradas: "un virality score, un timestamp de pico del hook, un hold rate, y un heatmap que muestra exactamente qué regiones del cerebro está activando tu clip". Método declarado, textual: *"Una audiencia modelada mira mientras mapeamos la respuesta cerebral a través de visión, sonido, memoria, atención, lenguaje"*. **Sin datos de entrenamiento, sin validación, sin cifra de exactitud en ninguna parte.** En "experimental preview, no consume créditos" (https://x.com/higgsfield/status/2053232302004830309). Lanzamiento reportado el 9-may-2026, clips de **máximo 15 segundos** (https://pasqualepillitteri.it/en/news/2273/higgsfield-virality-predictor-hook-score-hold-rate-2026).

> **Veredicto:** la afirmación de "qué regiones del cerebro se activan" a partir de subir un clip de 15 s **no tiene base científica localizable**. Inferir activación cerebral regional sin neuroimagen de un espectador real no es una capacidad validada. Existe trabajo serio adyacente —**TRIBE (TRImodal Brain Encoder) de Meta FAIR**, 1B de parámetros, que fusiona Llama 3.2 (texto) + Wav2Vec2-BERT (audio) + V-JEPA 2 (video) para predecir fMRI de cuerpo entero, 1º de 262 equipos en Algonauts 2025, capturando **~54% de la señal explicable** (https://arxiv.org/abs/2507.22229)— pero TRIBE predice fMRI sobre películas en un setup de laboratorio, no "viralidad en TikTok". Son problemas distintos.

**OpusClip** (https://help.opus.pro/docs/article/virality-score). Virality score 0–99 compuesto de **Hook** (¿el intro engancha y se relaciona con el tema?), **Flow** (progresión lógica, conclusión satisfactoria), **Value** (resonancia emocional) y **Trend** (alineación con tendencias actuales). **La documentación no revela datos de entrenamiento, metodología de validación ni advertencia de exactitud.** Precio: Free (60 min/mes, marca de agua), Starter $15/mes (150 créditos), Pro $29/mes; 1 crédito = 1 minuto subido (https://www.eesel.ai/blog/opusclip-pricing).
El único dato cuasi-empírico del sector completo es de un tercero: un tester reporta que los clips con score 80+ promediaron ~2.3× las views de TikTok de los clips bajo 50, **pero el clip con mejor desempeño real puntuó 64 y el peor puntuó 87** (https://bigvu.tv/blog/opus-clip-tested-2026-where-ai-wins-40-percent-discard/). Es un blog, sin n declarado.

**Resto del sector de clipping (todos sin metodología publicada):** Munch $49/$116/$220 por mes según minutos (https://coldiq.com/tools/munch); Vidyo.ai ~$29/mes; Klap ~$14–23/mes, dice estar "entrenado con datos virales de formato corto" sin revelar cuáles (https://klap.app/alternatives/vizard-ai); Submagic $19/$39; Vizard ~$16.90–29 (https://www.choppity.com/blog/best-ai-clip-maker/). **FeedHive** es la excepción parcialmente honesta: declara haberse entrenado con 1.5M+ posts usando engagement rate como target (https://docs.feedhive.com/how-engagement-prediction-works), aunque tampoco publica métrica de validación.

**Analítica de TikTok (post-publicación, no predicción):** Exolyt ofrece un "Growth Prediction" de seguidores futuros a partir del desempeño actual; desde gratis hasta $950/mes por 300 cuentas rastreadas (https://exolyt.com/features/video-performance, https://coldiq.com/tools/exolyt). Pentos ~$49/mes, rastrea sonidos virales antes del pico (https://virlo.ai/compare/exolyt-vs-pentos). Trendpop fue adquirida por Collab en enero de 2022, analiza ~2M posts diarios; su precio de $250/mes es **de 2022 y no está verificado hoy** (https://www.tubefilter.com/2022/10/20/trendpop-analytics-platform-all-users-now-available-collab/).

**Predicción de atención / neuromarketing:**

| Proveedor | Afirmación | Base real | Precio |
|---|---|---|---|
| Neurons Predict | ">95% de exactitud"; heatmaps "estadísticamente equivalentes a eye-tracking real con 100–150 personas viendo la **imagen** 5 segundos" (https://knowledge.neuronsinc.com/how-neurons-attention-prediction) | BD interna de "bastante más de 20.000 participantes", ~200 modelos comparados | ~€15.000/año por 5 asientos (https://www.trustradius.com/products/neurons-predict/pricing) |
| Attention Insight | 92.5% imágenes generales, "hasta 96%"; 93% en webs (https://attentioninsight.com/technology/) | AUC sobre **las 300 imágenes de MIT300**; 5.5M+ fijaciones de entrenamiento, ~4 s de visualización media | Solo $23/mes (20 créditos); Team $479/mes. **Video se cobra a 1 crédito por segundo analizado** (https://attentioninsight.com/billing-plans/) |
| Expoze.io | "~95% de exactitud vs eye-tracking tradicional", declarado como **0.87 en el benchmark MIT** (https://www.alpha.one/products/expoze-io) | Red entrenada con "decenas de miles de estudios de eye-tracking" | Desde $19.99/mes (https://www.capterra.com/p/251718/expozeio/) |
| Realeyes | 75% de exactitud distinguiendo anuncios de alto vs bajo lift de ventas; 78% del modelo sintético vs medición humana (https://www.realeyesit.com/case_studies/using-attention-to-scale-creative-performance-and-sales/) | Panel por webcam + modelo sintético; validación con un solo cliente (Mars) | No publicado |

> **Advertencia crítica sobre el "95% de exactitud".** La propia página de Expoze.io muestra la aritmética: un score de benchmark de **0.87** se reporta como "95% de exactitud" (https://www.alpha.one/products/expoze-io). Esa "exactitud" es un AUC normalizado sobre **imágenes estáticas** en visualización libre. **Ninguno de estos proveedores publica una cifra de validación específica para video.** Además, la literatura documenta que "el significado predice los movimientos oculares más allá del sesgo central, mientras que la saliencia no" (https://www.ncbi.nlm.nih.gov/pmc/articles/PMC7399206/). Vender predicción de atención en video vertical citando MIT300 (300 imágenes, visualización libre de 3–5 s en laboratorio) es extrapolar muy fuera del dominio validado.

**Plataformas de creative intelligence:** Vidmob afirma predecir "qué anuncios van a funcionar antes de servir una sola impresión" (https://vidmob.com/creative-scoring); su afirmación más específica es haber analizado 400+ anuncios de 10 marcas de Kellanova e identificado 19 guidelines predictivas con **83% de exactitud** — pero su propia página de metodología no declara tamaños de muestra, pruebas de significancia ni intervalos de confianza (https://help.vidmob.com/en/articles/8411518-what-is-the-methodology-for-analytics). 83% sobre 400 anuncios de un solo anunciante, con guidelines derivadas de los mismos datos, tiene alto riesgo de sobreajuste. **CreativeX** no es un predictor: es *compliance* de marca por visión computacional (https://improvado.io/blog/creative-analytics). **Pencil** es el más candoroso: declara 84% de exactitud sobre $2.000M de inversión publicitaria y, por separado, una **correlación de 70.5 entre CTR predicho y real** (https://trypencil.com/blog/articles/pencil-media-performance-score) — cifra que casualmente cae en el mismo rango que el leaderboard académico de SnapUGC, buena señal de que **~0.70 es donde topa esta clase de problema**.

**Google ABCD** es el marco mejor evidenciado, aunque no sea un predictor: construido y validado sobre 17.000+ campañas con Ipsos, Nielsen y Kantar; Kantar analizó 11.000+ anuncios con 180 features creativas (https://www.kantar.com/industries/technology-and-telecoms/validating-googles-abcd-framework-with-the-power-of-artificial-intelligence); efectos reportados de +30% en probabilidad de venta a corto plazo y +17% en contribución de marca a largo plazo (https://ppc.land/mastering-youtube-advertising-with-the-abcd-framework). **Advertencia: todos esos estudios fueron encargados por Google; no encontré réplica independiente.**

**Meta y TikTok no tienen herramienta nativa de predicción pre-publicación.** Los diagnósticos de relevancia de Meta (quality ranking, engagement rate ranking, conversion rate ranking) son post-entrega y relativos a la competencia (https://adlibrary.com/posts/meta-ads-diagnostic-matrix). TikTok Studio es analítica post-publicación.

### 5.5 Cifras que NO se deben citar

- **"Estudio de atención de Meta 2025: 12 millones de impresiones en Reels, los espectadores deciden en 1,3 segundos."** Aparece literal en varios blogs de 2026 (https://www.moonb.io/blog/how-to-create-video-hooks). Búsqueda dirigida de la fuente primaria: **nada de Meta**. El estudio real de atención de Meta más cercano usó 16.835 impresiones con 300+ participantes por ubicación (https://adverteyes.ai/resource/meta-decodes-advertising-attention-by-environments-in-the-wild/). **NO CITAR.**
- **"Estudio interno de Meta: 65% de quienes ven los primeros 3 s se quedan 10 s, 45% se quedan 30 s."** Solo en blogs. **NO CITAR.**
---

## 6. Benchmarks de retención de video corto: qué está publicado y qué es reciclaje

### 6.1 El hallazgo más incómodo de toda esta investigación

**Ninguna plataforma publica un porcentaje de abandono en los primeros 1–3 segundos. Ni TikTok, ni Meta, ni YouTube.** Se revisaron directamente todas las páginas oficiales de guía creativa y de definición de métricas alcanzables, y ninguna contiene esa cifra.

Lo que sí dicen literalmente:

| Fuente | Texto exacto | Nivel |
|---|---|---|
| TikTok Ads creative best practices, actualizado **junio 2025** (https://ads.tiktok.com/help/article/creative-best-practices) | "Introduce your content proposition in the first 3 seconds for better recall and awareness"; "Prioritize your hook in the first 6 seconds to boost engagement and increase watch time" | **(a) plataforma — cero estadísticas en la página** |
| Meta, "Apply creative best practices for reels" (https://www.facebook.com/business/learn/lessons/create-fb-ig-reels) | "Capture attention in the **first two seconds** with a striking visual or an unexpected moment" | **(a) — nótese: DOS segundos, no tres. Sin porcentajes** |
| YouTube Help, métricas de Shorts (https://support.google.com/youtube/answer/12220281?hl=en) | Define "Stayed to watch" pero **no publica ningún benchmark** | **(a)** |

**Consecuencia de producto: no hay benchmark externo que alcanzar. Las líneas base hay que construirlas con datos propios de primera mano.**

**Pero sí existe una medición de abandono con muestra grande, y es revisada por pares.** Masood et al., **CHI '26** (Barcelona, abril 2026), *"Counting How the Seconds Count"* (https://arxiv.org/abs/2503.20030). Muestra: historiales de navegación donados que cubren **más de 2,65 millones de videos** (3.870.540 puntos de datos de visualización), más un estudio controlado con 68 usuarios. Textual:

> "Elegimos un umbral del 10% porque produce un problema de clasificación balanceado, es decir, **el 50% de los videos de nuestro dataset se vieron más allá del 10%**."

**Es decir: ≈50% de los TikToks servidos se abandonan antes del 10% de su duración.** Para un video de 20–30 s, eso son **2–3 segundos**. **Esta es la única respuesta creíble a "cuánta gente abandona en los primeros segundos" — usar esta, no los blogs.**

Excepción verificada por extracción directa: el PDF oficial **"9 Creative Tips to drive performance"** de TikTok for Business sí contiene cifras (§7.1). El blog de TikTok sobre best practices **no las contiene** — se verificó por descarga y búsqueda de texto (https://ads.tiktok.com/business/en/blog/creative-best-practices-top-performing-ads). Es decir: **el 63% existe, pero en el PDF, no en el blog al que suelen apuntar los artículos que lo citan.**

### 6.2 Qué significa cada métrica según la propia plataforma

**TikTok Ads Manager** (https://ads.tiktok.com/help/article/video-play?lang=en), textual:
- **Video views:** "Number of times your video started to play. Para cada impresión de video, las reproducciones se cuentan por separado y **los replays se excluyen**."
- **2-second / 6-second video views:** al menos 2 s / 6 s en una sesión de impresión; replays excluidos. La de 6 s cuenta también si el video dura menos de 6 s y se reproduce entero, o si recibe al menos 1 interacción en los primeros 6 s.
- **Video views at 25/50/75/100%:** al menos ese % de la duración; replays excluidos.
- **Average play time per video view:** "**incluyendo** cualquier tiempo de replay." Asimetría deliberada: el contador de views excluye replays, el de tiempo los incluye.
- **Focused view** (https://ads.tiktok.com/resources/help/article/video-views-objective?lang=en): 6 s, o 15 s, o interacción positiva en los primeros 6 s. "**Las interacciones dentro del primer segundo no cuentan como focused view y se excluyen de la facturación.**"

> **Hueco crítico:** las métricas *orgánicas* de TikTok Studio — "retention rate", "watched full video", "average watch time" — **no tienen artículo público de TikTok que las defina**. Todas las definiciones que circulan son paráfrasis de terceros. **Tratar la semántica de las métricas orgánicas de TikTok como indocumentada.**

**Instagram Reels.** Fuente primaria: changelog de la Graph API v22.0 (https://developers.facebook.com/docs/graph-api/changelog/version22.0/), lanzado el **21-ene-2025**. Introduce `views`; deprecia `clips_replays_count`, `ig_reels_aggregated_all_plays_count`, `impressions` y `plays`; "aplica a todas las versiones el **21 de abril de 2025**".
- **Views:** "the number of times your reel starts to play **or replay**".
- **Average watch time:** watch time dividido por **initial views**, donde "una initial view es cuando tu reel empieza a reproducirse por primera vez en una sesión de reels". Instagram etiqueta esta métrica como **"estimada y en desarrollo"**.
- Instagram **no publica ningún umbral de "bueno"**.

**YouTube Shorts** (https://support.google.com/youtube/answer/12220281?hl=en), textual:
- **"Stayed to watch":** "El porcentaje de veces que los espectadores se quedaron a ver más allá de los segundos iniciales de un Short."
- **"Engaged views":** "cuántas veces los espectadores se quedaron a ver más allá de los segundos iniciales, **sin incluir loops**."
- **"Average view duration" / "Average percentage viewed":** "**entre quienes se quedaron a ver**."

**Tres consecuencias de ingeniería:** (1) lo que antes se llamaba "Viewed vs. swiped away" ahora se llama **"Stayed to watch"**; (2) AVD y APV están **condicionadas al subconjunto de engaged views**, así que **sobreestiman sistemáticamente la retención** sobre el total de impresiones; (3) YouTube **nunca define numéricamente "los segundos iniciales"**.

Además: el informe de retención de audiencia **exige que el video dure al menos 60 s y tenga al menos 100 views, y no cubre Shorts** (https://support.google.com/youtube/answer/9314415?hl=en). **No existe curva de retención segundo a segundo para Shorts.**

### 6.3 Qué cuenta como "view" en 2025–2026 (las tres son distintas)

| Plataforma | Definición | ¿Replays? | Vigente desde | Fuente |
|---|---|---|---|---|
| **TikTok (Ads)** | "started to play" | **Excluidos** | actual | (a) https://ads.tiktok.com/help/article/video-play?lang=en |
| **Instagram** | "starts to play or replay" | **Incluidos** | **2025-04-21**, todas las versiones de API | (a) https://developers.facebook.com/docs/graph-api/changelog/version22.0/ |
| **YouTube Shorts** | se cuenta en cuanto "starts to play or replay", sin mínimo de tiempo | **Incluidos** | **2025-03-31** | (a) anuncio de TeamYouTube |
| **YouTube todos los formatos** | "views are counted the moment a video starts to play across all formats, including Shorts, long-form videos (VOD), and live streams" | — | **2026-08-24** | (a) https://support.google.com/youtube/answer/2991785?hl=en |

**Implicaciones que hay que codificar:**
1. **`completion rate = completions / views` NO es comparable entre plataformas.** Instagram y YouTube inflan el denominador con replays; TikTok Ads no.
2. **Las series temporales de YouTube Shorts se rompen el 2025-03-31 y otra vez el 2026-08-24.** Comparar antes/después sin ajuste de discontinuidad es inválido. Los ingresos del YPP siguen corriendo sobre **engaged views** y **engaged watch hours**.
3. El "views corre ~25% por encima de impressions" aparece en docs de migración de proveedores (Zoomph, Emplifi, Sprinklr), **no en el changelog de Meta**. **(c) observado por proveedor, no publicado por plataforma.**

### 6.4 Duración óptima — la evidencia de muestra grande

**El benchmark de completion rate que sí existe.** **Metricool TikTok Study 2026** (https://metricool.com/wp-content/uploads/tiktok-study-2026-EN.pdf, p.8; nota de prensa https://metricool.com/press-release-tiktok-study-2026/), **n = 2.314.756 posts de más de 92.000 cuentas**, ene–feb 2025 vs ene–feb 2026, extraídos de la API de TikTok. Metricool define **"Full watched ratio = el porcentaje de personas que ven el video hasta el final."**

| Métrica | 2025 | 2026 |
|---|---|---|
| **TikTok Full Watch Rate** | **7%** | **6,30%** (−10% interanual) |
| Duración media del video | 45,76 s | 45,94 s |
| Views por post | 47.883 | 32.895 (−31%) |

> **Este es el número más importante de todo el informe.** Todos los benchmarks de "40–80% de completion" que circulan están equivocados por **un orden de magnitud**. Si el producto muestra al creador un objetivo de completion, **6–7% es el ancla defendible, no 50%.** Lectura de la propia Metricool (p.8): *"no es que los espectadores pierdan interés a mitad de video… el problema es que menos gente lo está viendo en primer lugar."*
> Advertencia: es un agregado único sobre todas las duraciones. **No existe en ninguna parte una curva de completion por duración.**

**Metricool YouTube Study 2026** (https://metricool.com/wp-content/uploads/youtube-study-2026-EN.pdf, p.23; **n = 799.718 videos / 71.177 cuentas**, feb-2025 vs feb-2026): **duración media de visualización de Shorts 47,4 s → 15,6 s, −67% interanual**; views de Shorts +127%; engagement 4,94% → 1,85%. Un vuelco violento que casi con seguridad refleja el cambio de conteo de views de marzo de 2025 propagándose al denominador — otra razón para no comparar series a través de esa fecha.

**Buffer, "Longer TikToks Get More Views"** (https://buffer.com/resources/longer-tiktoks-get-more-views-data/, **2025-03-17**, **n = 1,1 millones de TikToks**; **no declara ventana de muestreo — es una carencia real**):

| Duración | Alcance mediano | Watch time mediano |
|---|---|---|
| 5–10 s | 194 | 3,1 s |
| 10–30 s | 302 | 6,9 s |
| 30–60 s | 302 | 6,9 s |
| **60 s+** | **432,5** | **11,3 s** |

60 s+ frente a 30–60 s: **+43,2% de alcance, +63,8% de watch time**. Alrededor del 86% de los posts duran menos de un minuto.

**Socialinsider, estudio de duración en TikTok** (https://www.socialinsider.io/blog/how-long-are-tiktok-videos/, 2026-07-10, **6 millones de videos**, ene–jun 2026): el engagement rate es **en forma de U** (15–30 s: 6,00%; valle en 30–60 s: 4,20%; vuelve a 5,90% por encima de 180 s) mientras las views medianas **se multiplican ~8,7×** de 15–30 s (1.000) a 120–180 s (11.136). **Engagement y views apuntan en direcciones opuestas.**
> ⚠️ Este estudio y la página de 111.000 videos de Socialinsider cubren **la misma ventana y la misma plataforma con muestras que difieren ~54×** y reportan valores distintos. Socialinsider nunca los reconcilia.

**Socialinsider, "Social media video statistics"** — **111.000 videos** de páginas de empresa, **enero–junio 2026**, publicado **2026-08-21** (https://www.socialinsider.io/social-media-benchmarks/social-media-video-statistics). Es el mejor dataset de duración-vs-desempeño encontrado, y **contradice el folclore de "más corto es mejor"**:

| | 0–30 s | 45–60 s | 120–180 s | >180 s |
|---|---|---|---|---|
| **IG Reels** engagement rate | 0.28% | **0.35%** | 0.33% | 0.15% |
| **IG Reels** views medianas | — | **10.374** | 9.000 | 4.428 |
| **TikTok** engagement rate | **6.00%** | — | 5.50% | — |
| **TikTok** views medianas (60–90 s: 8.000) | — | — | **12.000** | — |

Dos advertencias: Socialinsider calcula engagement de Instagram/Facebook **sobre seguidores** y el de TikTok **sobre views** — las columnas no están en la misma escala. Y **nada de esto es retención ni completion**; es engagement y views.

**Lo que las otras grandes muestras NO contienen:**

| Estudio | Muestra | Ventana | ¿Datos de retención? |
|---|---|---|---|
| Socialinsider benchmarks (https://www.socialinsider.io/social-media-benchmarks) | **70M posts** | ene-2024–dic-2025 | **No hay watch time ni completion** |
| Socialinsider TikTok (https://www.socialinsider.io/social-media-benchmarks/tiktok) | **2M videos, 214.507 perfiles** | ene-2024–dic-2025 | **"no incluye métricas de duración, watch time ni completion rate"** |
| Socialinsider Instagram (https://www.socialinsider.io/social-media-benchmarks/instagram) | **35M posts, 447.613 páginas** | ene–dic 2025 | No trata duración ni watch time |
| Socialinsider TikTok vs Reels vs Shorts (https://www.socialinsider.io/blog/tiktok-vs-reels-vs-shorts/) | **69M videos** | ene-2025–jul-2026 | Solo engagement: TikTok 2.60%, Reels 0.45%, Shorts 0.30% (2026) |
| **Metricool Instagram** (https://metricool.com/press-release-instagram-study-2026/) | **24.364.803 posts, 375.118 cuentas** | ene/feb-2025 – ene/feb-2026 | **Watch time medio de Reels: 8,5 segundos**, aproximadamente el doble interanual |
| Metricool TikTok (https://metricool.com/press-release-tiktok-study-2026/) | **2.314.756 posts, 92.000+ cuentas** | ene/feb-2025 – ene/feb-2026 | Views −31.30%, alcance −28.73%, interacciones −31.17%. **Sin cifra de watch time** |
| Buffer (https://buffer.com/resources/state-of-social-media-engagement-2026/) | **52M+ posts, 200.000+ cuentas** | ene-2024–dic-2025 | **"no contiene hallazgos sobre duración de video"** |
| Dash Social (https://www.dashsocial.com/social-media-benchmarks/fashion-industry) | TikTok n=1.361, IG n=3.363, YouTube n=616 | jul–dic 2025 | TikTok **"retention promedió 23%"** — **pero retention nunca se define** |
| Emplifi (https://emplifi.io/resources/social-media-benchmark-report/) | "más de 200.000 cuentas de marcas líderes" | no declarada | Sin watch time ni completion en la página pública |

> **Los 8,5 segundos de watch time medio de Reels de Metricool son la cifra proxy de retención más útil de todo este informe**: muestra real, ventana declarada, herramienta con acceso a API.

### 6.5 Cifras sobre hooks y creatividad que SÍ tienen fuente

**Blog creativo de TikTok** (https://ads.tiktok.com/business/en/blog/creative-best-practices-top-performing-ads) — la única página de TikTok con cifras con nota al pie. **No muestra fecha de publicación** y varios estudios tienen 4–6 años:

| Cifra | Nota al pie de TikTok |
|---|---|
| "90% del impacto en ad recall se captura en los primeros seis segundos" | TikTok Creative Guide: Driving Brand Equity, **2020** |
| Producto en pantalla → **+65% brand affinity, +25% recall** | TikTok Marketing Science US SMB Creative Effectiveness Study **2021** (Lumen) |
| Tarjetas de CTA → **+45% recall, +19% likeability** | TikTok Marketing Science Top-Performing BLS Creative Analysis, **2020** |
| **88%** de los usuarios dice que el sonido es vital | TikTok Marketing Science US Cross-Platform Sound On Research **2022** (Kantar) |
| "la mitad de nuestros usuarios dice que la música hace el contenido más animado" | TikTok Marketing Science EU Consumer Empathy Research, **2020** — **base de 138–148 encuestados en Reino Unido** |

**(a/b) Publicado por la plataforma con socios de investigación nombrados — pero son resultados de brand lift y encuesta, no de retención, y una base de ~140 encuestados no generaliza.**

**Google Ads Help, video vertical en Shorts** (https://support.google.com/google-ads/answer/9128498?hl=en) — **(a), todo atribuido a "Google internal data, Global 2024"**:
- Añadir un video vertical a un grupo de anuncios solo horizontal → **VTR en Shorts +40%** (campañas Video View).
- → **Viewability en Shorts +45%** y **average watch time +20%** (Video Reach).
- → **+35% conversiones en Shorts** (Demand Gen).
- De https://support.google.com/google-ads/answer/16041697?hl=en: "Usa sonido (música, voz en off, o ambos) en tus anuncios de Shorts, lo que ha demostrado **aumentar las conversiones en más de un 20%**"; "**solo los primeros 60 segundos se reproducen en el feed de Shorts**"; duración recomendada **10–30 s** para campañas de acción, 6–60 s para Video Reach.

**Google/YouTube ABCD** — **(b) bien documentado**: "+30% de lift en probabilidad de venta a corto plazo y +17% en contribución de marca a largo plazo", con nota al pie **"Google/Kantar Link AI, Global, The Short and the Long of ABCDs Effectiveness, 2021"** (https://business.google.com/us/think/future-of-marketing/youtube-video-ad-creative/). **Corrección importante: ese "+30%" es salida de modelo, no ventas medidas.** Según el propio texto de Kantar (https://www.kantar.com/industries/technology-and-telecoms/validating-googles-abcd-framework-with-the-power-of-artificial-intelligence), la base son **11.000 anuncios puntuados por el modelo predictivo Link AI de Kantar en un mes**, examinando 180 features creativas; Kantar señala que un estudio equivalente con encuestas "habría sido prohibitivo en coste". Por tanto **"+30% de lift en *probabilidad* de venta a corto plazo" es predicción de un modelo, no venta medida.** Es el número más sobreinterpretado del conjunto. La muestra de "17.000+ campañas" que se cita por todas partes **no aparece en la nota al pie de Google**.

El playbook más antiguo (https://www.thinkwithgoogle.com/_qs/documents/8472/ABCD_Complete_V7b_HR_1.pdf, oct-2019) **sí** publica muestras reales — Nielsen Neuro **n=6.000 anuncios**, Google/Ipsos **n=5.000 anuncios TrueView**, Kantar MB Link **>15.000 anuncios** — pero sus reglas de hook **no llevan porcentaje de lift**: *"Apunta a dos o más planos en los primeros cinco segundos… es un factor positivo para Ad Recall y Consideration."* Solo direccional.

**Meta** — **(a) pero sin números.** La única página propia de Meta legible dice "capta la atención en los **primeros dos segundos**" y **no contiene porcentajes, ni duración recomendada, ni estudios fechados**.

### 6.5b La premisa de los subtítulos está invertida para el video vertical de 2026

Esto reformula por completo la pregunta de "¿subtítulos sí o no?". Las plataformas a las que enviamos contenido dicen **lo contrario** del canon sound-off de 2016:

- **TikTok: "el 93% de los usuarios de TikTok pasa tiempo en la plataforma con el sonido activado"**; "el 15% de los usuarios es más propenso a saltarse un anuncio Sound-Off" (https://ads.tiktok.com/business/creativecenter/quicktok/online/Power_Creative_Elements/pc/en).
- **YouTube: "95% — la cantidad de video visto en YouTube que se reproduce con sonido"** (playbook ABCD p.4, nota: Google Internal Data, Global, sept-2018).
- **Instagram: "⅓ de las reproducciones de video en Instagram son con el sonido apagado"** (https://about.instagram.com/blog/tips-and-tricks/advancing-accessibility-on-instagram, 2022-05-19) — **un tercio, no el 85%.**

La cadena "el sonido está apagado ⇒ los subtítulos suben el watch time" **no se transfiere** del feed de autoplay de Facebook de 2016 al video vertical de 2026. **Ninguna plataforma ha publicado una cifra de lift de subtítulos sobre watch time desde 2016.** Los subtítulos siguen siendo defendibles por **accesibilidad, comprensión y valor del texto como hook** — pero no hay número actual que poner en una especificación.

**Corolario para el producto: el audio no es opcional.** Con 93–95% de consumo con sonido, un video mudo o con audio mal mezclado pierde por partida doble. Esto refuerza R9, R11 y R12.

### 6.6 Lista explícita de cifras RECICLADAS / NO VERIFICABLES

**Ninguna de estas debe entrar en una especificación de producto ni en material de marketing:**

1. **"71% / 87% de los espectadores deciden en los primeros 3 segundos"** — sin fuente primaria.
2. **"50–60% del abandono ocurre en los primeros 3 segundos"** — sin fuente primaria.
3. **"47% del ad recall ocurre en los primeros 3 segundos"** — estudio real (Nielsen/Facebook, **2015**, 173 estudios Brand Effect **filtrados solo a los de lift positivo**) pero **mal citado**: mide **lift de recall entre quienes vieron 0–3 s**, no abandono, y es anterior al video vertical (https://martech.org/even-brief-video-views-drive-brand-lift-facebook-nielsen-study-finds/).
4. **"85% del video de Facebook se ve sin sonido"** — origen **Digiday, 2016-05-17** (https://digiday.com/media/silent-world-facebook-video/): son cifras **autodeclaradas por editores** sobre su propio tráfico, **Facebook no es la fuente**, sin metodología, y tiene **diez años**. **Retirar — y además la premisa está invertida para 2026 (§6.5b).**
5. **"Los subtítulos aumentan el view time 12%"** — **la fuente primaria SÍ existe y está viva**: *"Internal tests show that captioned video ads increase video view time by an average of 12%"* (https://www.facebook.com/business/news/updated-features-for-video-ads). Meta le quita la fecha; la prensa especializada la sitúa en **2016-02-11**. **Sin n, sin control, sin diseño de test declarado.** El "80% más probable de ver el video entero" de Verizon/Publicis es **n=5.616 adultos estadounidenses de 18–54, abril 2019**, pero es **intención autodeclarada en encuesta**, no completion medida — y su documento primario está permanentemente muerto. **Conclusión: la regla de poner subtítulos es correcta; estas cifras no se pueden citar.**
6. **"La duración óptima de TikTok es 21–34 segundos"** — atribuida a TikTok; **TikTok nunca la ha publicado.**
7. **"21–34 s → 62% de completion vs 48% para 60 s+", "pattern interrupt cada 4 s → 58% de retención"** — trazadas a **un solo post de blog: OpusClip, 2025-11-11** (https://www.opus.pro/blog/tiktok-length-format-retention-data), cuya base declarada es *"cuando analicé 500 videos de distintos nichos"*, **sin metodología, sin desglose, sin cita externa**. **Es la fuente de contaminación de buena parte del contenido "data-backed" de 2026 sobre duración.**
8. **"Informe de Meta 2025: hooks fuertes en los primeros 3 s → hasta 89% más completion"** — no existe página de Meta con esa cifra.
9. **"Los mejores creadores apuntan a 75–80% de view rate en Shorts", "mantén el swipe-away bajo 25%"** — **YouTube no publica ningún benchmark**; es consenso de creadores.
10. **Dash Social "retention promedió 23%"** — la muestra es real (n=1.361, jul–dic 2025), pero **retention nunca se define**, así que el número es inutilizable.
11. **"Estudio de atención de Meta 2025: 12 millones de impresiones, deciden en 1,3 segundos"** — sin fuente de Meta. El estudio real más cercano usó 16.835 impresiones (https://adverteyes.ai/resource/meta-decodes-advertising-attention-by-environments-in-the-wild/).

### 6.7 Páginas que no se pudieron leer en origen

`help.instagram.com/202865988324236` (muro de login), páginas de Meta Business Help `1708053352711643` y `304846896685564` (bloqueadas por JS), `tiktok.com/creator-academy/.../tool-analytics-intro` (solo navegación), TikTok Creative Center Creative Accelerator (timeout), `support.google.com/youtube/thread/333869549` (truncada).
---

## 7. Cómo convertir todo eso en reglas accionables

Aquí es donde hay que ser honesto sobre la procedencia de cada umbral. Los clasifico en tres niveles.

### 7.1 Umbrales con fuente primaria (nivel A)

**Del PDF oficial de TikTok for Business, "9 Creative Tips to drive performance"** (https://ads.tiktok.com/business/library/Auction_Ads_Creative_Tips.pdf). Cifras textuales:

- *"Más del 63% de todos los videos con el mayor click-through rate (CTR) destacan su mensaje clave o producto dentro de los primeros 3 segundos."*
- *"Hemos visto que los TikToks grabados verticalmente tienen en promedio un 25% más de watch-through rate a 6 segundos."*
- *"33% de los auction ads con el mayor VTR rompen la cuarta pared"* (el creador mira a cámara y habla al espectador).
- *"40% de los auction ads con el mayor VTR"* usan **superposición de texto**.
- *"Intenta incluir pistas rápidas por encima de 120 BPM, que a menudo generan mayor view-through rate."*
- *"61% de los mejores auction ads usan la mitad o más de estos consejos."*

> **Nota crítica doble, y hay que entenderla antes de usar estas cifras.**
> **(1) Es prevalencia entre los mejores, no un lift.** "El 63% de los videos con mayor CTR hace X" no dice nada sin la tasa base de X entre **todos** los videos: si el 63% de todos los TikToks adelanta su mensaje, el dato es ruido. Casi todos los blogs lo renderizan como "hacer el hook en 3 s da mayor CTR", lo cual es una **inversión de tasa base**. El PDF no declara muestra, ni control, ni fecha.
> **(2) Es viejo.** Los metadatos del PDF lo fechan el **2020-11-12**, y es de **anuncios de subasta**, no de contenido orgánico.
> **Uso correcto: "TikTok dice que sus mejores anuncios tienden a adelantar el mensaje", nunca "adelantar el mensaje sube el CTR un 63%".**

**Del código fuente del ABCDs Detector de Google** — constantes reales del repositorio (https://github.com/google-marketing-solutions/abcds-detector/blob/main/configuration.py):

| Constante | Valor por defecto | Significado |
|---|---|---|
| `dynamic_cutoff_ms` | **3000** | El primer plano debe durar **menos de 3 s** para contar como "Dynamic Start". |
| `avg_shot_duration_seconds` | **2** | La duración media de plano debe ser **≤ 2 s** para contar como "Overall Pacing" bueno. |
| Quick Pacing | **≥5 planos en los primeros 5 s** | Constantes `required_secs_for_quick_pacing = 5`, `required_shots_for_quick_pacing = 5` (https://github.com/google-marketing-solutions/abcds-detector/blob/main/annotations_evaluation/features/a_quick_pacing.py). |
| `face_surface_threshold` | **0.15** | El rostro debe ocupar **≥15% del área del cuadro** para contar como close-up. |
| `early_time_seconds` | **5** | Ventana de "temprano": marca/producto/voz deben aparecer en los primeros **5 s**. |
| `logo_size_threshold` | **3.5** | Tamaño mínimo de logo. |
| `confidence_threshold` | **0.5** | Confianza mínima de la anotación para contarla. |

Y de sus rúbricas de Shorts (https://github.com/google-marketing-solutions/abcds-detector/blob/main/features_repository/shorts_features.py):
- Close-up = sujeto llena **60–80%** del cuadro; extreme close-up **>80%**; medium **30–59%**; wide **<30%**.
- Densidad ideal de encuadre cerrado: **30%–60%** de la duración total, con bonus si los **primeros 3 s** lo tienen.

**De la documentación de plataforma:**
- TikTok in-feed: vertical 9:16, **≥540×960 px**, `.mp4/.mov/.mpeg/.3gp/.avi`, hasta 10 minutos, **≤500 MB**, bitrate ≥516 kbps; las captions muestran **máximo 4 líneas** (https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads?lang=en).
- TikTok reconoce oficialmente que **la zona segura no es fija**: depende del formato, de la longitud del caption y de los add-ons interactivos; recomienda previsualizar (https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads?lang=en).
- Meta publica guía oficial de zona segura para Stories y Reels (https://www.facebook.com/business/help/980593475366490) y ofrece la herramienta "Safe Zone Guardrail" dentro de Ads Manager.

### 7.2 Umbrales de convención de industria, no de plataforma (nivel B)

**Zonas seguras en píxeles.** Las cifras concretas circulan en guías de terceros, no en las páginas oficiales:
- TikTok 1080×1920: margen superior **~130 px**, inferior **~484 px**, derecho **~140 px**, dejando un área útil de ~896×1306 px (https://kreatli.com/guides/tiktok-safe-zone). Otras guías dan 108 px arriba / 320 px abajo / 60 px izq / 120 px der (https://zeely.ai/blog/tiktok-safe-zones/). **La discrepancia entre fuentes es real y significativa** — por eso conviene implementar el margen más conservador y, sobre todo, permitir al usuario elegir perfil.
- Meta Reels/Stories 1080×1920: **14% arriba (270 px), 35% abajo (670 px), 6% a cada lado (65 px)**, unificado en marzo 2026 para Facebook Stories, Facebook Reels, Instagram Stories e Instagram Reels (https://behaviour.digital/post/meta-reels-safe-zone-14-top-35-bottom-6-sides-the-2026-official-guide). **[NO VERIFICADO contra la página de Meta: la URL oficial existe pero no pude extraer sus cifras.]**

**Loudness.** Los objetivos por plataforma que circulan (YouTube ~−14 LUFS, Instagram/TikTok −10 a −12 LUFS, Facebook −13 LUFS) provienen de mediciones de la comunidad de audio, no de especificaciones publicadas por las plataformas (https://www.criticallisteninglab.com/en/learn/loudness/social-media, https://apu.software/tiktok-instagram-reels-loudness/). **[NO VERIFICADO contra fuente de plataforma.]** Lo que sí es estándar formal es la medición: ITU-R BS.1770 / EBU R128, implementada en `ebur128`. Dos hechos operativos con respaldo razonable:
- YouTube **atenúa** lo que supera su objetivo pero **no amplifica** lo que está por debajo — subir material demasiado bajo queda audiblemente más débil que la competencia (https://clickyapps.com/creator/video/guides/lufs-targets-2025). **[NO VERIFICADO contra Google.]**
- Mantener true peak por debajo de **−1 dBTP** (algunos recomiendan −1.5) evita distorsión tras el transcodificado con pérdida.

**Velocidad de habla en español.** Un estudio publicado en *Language* (Pellegrino et al., Univ. de Lyon; 59 hablantes, 20 textos, 7 lenguas) midió el español en **7.82 sílabas/segundo** frente a 6.19 del inglés — ~26% más rápido en sílabas — pero con menor densidad informativa por sílaba, de modo que la **tasa de información es comparable** (https://www.scientificamerican.com/article/fast-talkers/). Traducción práctica: **un umbral de palabras por minuto copiado de guías en inglés está mal calibrado para español.** Hay que calibrarlo sobre corpus propio. La cifra de "~218 wpm en español" que circula no tiene fuente primaria localizable (https://www.voices.com/blog/languages-in-usa-speaking-rates-per-minute/). **[NO VERIFICADO.]**

### 7.3 Folclore del oficio (nivel C) — usar solo como heurística, nunca como afirmación

- **"El 71% de si siguen viendo se decide en los primeros 3 segundos."** Circula en decenas de blogs (https://www.teleprompter.com/blog/tiktok-3-second-rule). **No encontré fuente primaria.** **[FOLCLORE.]**
- **"Un 3-second view rate de 35–45% es bueno; por debajo de 25% el hook está dañando la campaña."** Solo en blogs de agencias (https://www.stackmatix.com/blog/tiktok-hook-first-3-seconds). **[FOLCLORE.]**
- **"Los subtítulos aumentan el tiempo de visualización un 12%."** Atribuido a un estudio de Facebook y repetido en todas partes (https://www.3playmedia.com/blog/captions-increase-viewership-for-facebook-video-ads/), pero **no localicé el documento original de Meta**. **[FOLCLORE con alta probabilidad de ser real pero sin verificar.]** Nota: aunque el 12% no se verifique, poner subtítulos sigue siendo correcto por accesibilidad y por consumo sin sonido; simplemente no se debe *citar la cifra*.
- **"El primer corte antes del segundo 1,5."** No tiene fuente. Lo más cercano con respaldo es el `dynamic_cutoff_ms = 3000` de Google (§7.1), que es **3 s, no 1.5 s**. **[FOLCLORE; usar 3 s.]**

---

## 8. Arquitectura de procesamiento en producción

### 8.1 ffmpeg medido, no estimado

Se generó un clip sintético de **60 s, 1080×1920, H.264, 30 fps, 6,1 Mbps, 45,8 MB** (con ruido temporal y rotación de tono, para que el decodificador no pueda hacer trampa con fotogramas estáticos) y se cronometró ffmpeg 8.1.2 sobre Apple M3 Pro fijando `-threads`:

| Operación | 2 hilos | 4 hilos | 8 hilos |
|---|---|---|---|
| Decodificación completa `-f null -` | 4,89 s | **2,88 s** | 5,48 s (regresión) |
| `fps=1,scale=540:-2` → 60 JPEG | 6,39 s | **3,69 s** | — |
| `select='not(mod(n,30))'` + `-vsync vfr` → 60 JPEG | — | **3,46 s** | — |
| Detección de escena `select='gt(scene,0.3)'` + metadata | — | **2,65 s** | — |
| Audio → WAV PCM 16 kHz mono | — | **0,10 s** | — |

Tamaño de los fotogramas (60 frames a 1 fps): 480×853 `-q:v 5` → **1,4 MB** (~23 KB/frame); 614×1092 `-q:v 3` → **3,1 MB** (~52 KB/frame).

> **Advertencias sobre estas cifras:** (a) los núcleos de rendimiento del M3 Pro son bastante más rápidos por core que un vCPU de nube, que en x86 es un *hyperthread*, no un core — **hay que derating de 2,5–3×**; (b) la fuente sintética con ruido es peor caso tanto para decodificar como para el tamaño del JPEG; (c) **`-threads 8` empeoró**: el threading por fotograma tiene coste de coordinación pasados ~4 hilos. **4 hilos es el punto óptimo**, y coincide con la forma de instancia más barata razonable.

**→ Estimación práctica: 9–12 s de reloj para decodificar + extraer fotogramas a 1 fps + demux de audio sobre 4 vCPU de nube. Presupuestar 12 s.**

**Optimización que importa:** para muestreo disperso, usar `select=` + `-vsync vfr` en lugar de `fps=`, porque ffmpeg puede saltarse fotogramas en lugar de decodificarlo todo. En un clip de 60 s apenas cambia (3,46 s vs 3,69 s); en una fuente de 30 minutos cambia enormemente.

**Principio de diseño, tomado de Meta:** Meta ejecuta ffmpeg **"decenas de miles de millones de veces al día"** sobre más de 1.000 millones de subidas diarias, y sus dos decisiones que generalizan son **transcodificación multi-carril** (decodificar una vez y repartir los fotogramas a varios codificadores dentro de un único proceso ffmpeg, eliminando el arranque por proceso) y **decodificación en bucle** para calcular métricas de calidad durante la codificación (https://engineering.fb.com/2026/03/02/video-engineering/ffmpeg-at-meta-media-processing-at-scale/). Aplicado aquí: **una sola pasada de decodificación debe emitir fotogramas, audio y límites de escena a la vez.**

### 8.2 El cuello de botella real es el OCR, no el modelo

Benchmark oficial de PP-OCRv5 (200 imágenes, NVIDIA Tesla V100 / Intel Xeon Gold 6271C, incluye I/O de disco) (http://www.paddleocr.ai/main/en/version3.x/algorithm/PP-OCRv5/PP-OCRv5.html):

| Config | GPU s/imagen | CPU s/imagen |
|---|---|---|
| **v5_mobile** | **0,62** | **1,75** |
| v4_mobile | 0,29 | 1,37 |
| v5_server | 0,74 | 4,34 |

La documentación dice explícitamente que **v5 es más lento que v4** porque usa un diccionario de reconocimiento mayor.

**Esta es la cifra que rompe un diseño ingenuo:**
- **60 fotogramas × 0,62 s = 37 s en GPU clase V100** — la mitad del presupuesto de latencia, en serie.
- **60 fotogramas × 1,75 s = 105 s en CPU** — revienta el presupuesto entero.

**Mitigaciones, por orden de impacto:**
1. **Hacer OCR solo de keyframes, no de cada fotograma muestreado.** Usar los límites de escena de la pasada de ffmpeg para elegir **12–20 fotogramas**. 16 × 0,62 = **~10 s**. Un video vertical de 60 s tiene como mucho 5–15 estados de texto distintos; hacer OCR de 60 casi-duplicados es puro desperdicio.
2. **Deduplicar por hash perceptual** antes del OCR.
3. **Usar v4_mobile (0,29 s) en vez de v5_mobile (0,62 s)** si el texto es latino y grande: 2× más rápido según la tabla oficial.
4. **Batchear en GPU.** Los 0,62 s incluyen I/O de disco y sobrecarga por llamada.

**[NO VERIFICADO]** No existe benchmark publicado de PP-OCRv5 en T4 / L4 / A10. La cifra de V100 es la única oficial; asumir V100 ≈ L4 para esta carga es una estimación, no un hecho medido.

### 8.3 Precios verificados de cómputo GPU

| Plataforma | T4 | L4 | A10/A10G | L40S | A100 80GB | H100 |
|---|---|---|---|---|---|---|
| **Modal** ($/s) | **$0.000164** | **$0.000222** | $0.000306 | $0.000542 | $0.000694 | $0.001097 |
| **Modal** ($/h) | $0.59 | $0.80 | $1.10 | $1.95 | $2.50 | $3.95 |
| **Replicate** ($/s) | $0.000225 | — | — | $0.000975 | $0.0014 | $0.001525 |
| **Replicate** ($/h) | $0.81 | — | — | $3.51 | $5.04 | $5.49 |
| **Baseten** ($/h) | $0.6312 | $0.8484 | $1.2072 | — | $4.0002 | $6.4998 |
| **RunPod serverless** ($/h) | $0.58 | $0.69 | — | $1.75 | $2.72 | $4.79 |

Fuentes: https://modal.com/pricing, https://replicate.com/pricing, https://www.baseten.co/pricing/, https://www.runpod.io/pricing

**CPU en las mismas plataformas:** Modal $0.0000131/core-s + $0.00000222/GiB-s (mínimo 0,125 cores); Replicate CPU $0.0001/s ($0.36/h), CPU-small $0.000025/s ($0.09/h); Beam $0.0000125/core-s.

**Créditos gratis:** Modal **$30/mes** (Starter), **$100/mes** (Team); Beam plan Developer $0/mes + uso, almacenamiento gratis hasta 1 TB, **sin cargos de egreso**. Replicate, RunPod y Fal no declaran free tier.

**Facturación de Replicate, textual:** en **modelos públicos** "solo pagas el tiempo que tarda en procesar tu petición"; en **modelos privados** se factura "el tiempo que pasan configurándose; el tiempo que pasan inactivos esperando peticiones; y el tiempo que pasan activos". **Un modelo privado ocioso se paga.**

**Fal.ai** publica solo tarifas horarias y solo Blackwell/Hopper/RTX-Pro (B200 $6.25/h, H200 $4.50/h, H100 $4.50/h) — **[NO VERIFICADO: sin T4/L4/A10G/A100 listados y sin tarifa por segundo]** (https://fal.ai/pricing). Es efectivamente una API por modelo, no un proveedor de GPU-segundos: mal encaje aquí. **Together** es por token o por clúster horario (HGX H100 $3.99/GPU-h on-demand, $1.99 preemptible) pero **hospeda Whisper Large v3 a $0.0015/min de audio** (https://www.together.ai/pricing), lo cual sí es directamente útil.

### 8.4 Cold starts — todo son afirmaciones de proveedor, ningún SLA

| Plataforma | Afirmación publicada |
|---|---|
| **Modal** | "Los contenedores arrancan en alrededor de un segundo" (https://modal.com/docs/guide/cold-start). Con *GPU memory snapshots*: **NVIDIA Parakeet ASR 20 s → 2 s**; ViT+torch.compile 8,5 s → 2,25 s; vLLM Qwen2.5-0.5B 45 s → 5 s (https://modal.com/blog/gpu-mem-snapshots) |
| **RunPod** | FlashBoot promocionado como "sub-200 ms"; en su prueba con Whisper, **95% de los cold starts < 2,3 s**. ⚠️ Matiz de pruebas de terceros: el *primer* cold start sigue siendo ~30 s (llenado de caché de imagen) y los snapshots son por (host, SHA de imagen) |
| **Baseten** | **5–10 s** en su flota; SDXL en A100 9 s de cero a inferencia (https://www.baseten.co/blog/how-the-baseten-delivery-network-bdn-makes-cold-starts-fast/) |
| **Replicate** | No publica cifra general; los modelos afinados "arrancan en menos de un segundo" (https://replicate.com/blog/fine-tune-cold-boots). Recomienda deployments con `min-instances ≥ 1` |
| Terceros, mediana en A100 | **Modal 1,8 s · RunPod 4,2 s · Replicate 6,5 s** (https://dev.to/mrzitoun/benchmarking-serverless-gpus-modal-vs-runpod-vs-replicate-cold-starts-2026-a5c) ⚠️ metodología delgada, direccional |

**Veredicto: Modal es el mejor encaje** — facturación real por segundo, T4/L4 baratos, ingeniería de cold start publicada, y contenedores solo-CPU en la misma plataforma para que ffmpeg y la GPU compartan plano de control. RunPod es ~10% más barato en las gamas de 16–24 GB pero cotiza por hora y tiene cold starts menos predecibles. Replicate es 35–40% más caro en T4 con el peor cold start medido.

### 8.5 Colas, workers y sus límites

| Runtime | Duración máx | Memoria máx | CPU | Disco efímero |
|---|---|---|---|---|
| **AWS Lambda** | **900 s (15 min)** | **10.240 MB** | ~1 vCPU a 1.769 MB, ~6 vCPU a 10.240 MB | **512 MB–10.240 MB `/tmp`** |
| **Cloud Run jobs** | **168 h (7 días)**, pero **1 h si se usa GPU** | **32 GiB** | **8 vCPU** | limitado por memoria |
| **Fargate** | sin límite | 120 GB | 16 vCPU | **20 GB incluidos** |
| Modal / RunPod / Beam | sin límite práctico | por GPU | configurable | configurable |

(https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html, https://docs.cloud.google.com/run/quotas, https://aws.amazon.com/fargate/pricing/)

**El payload asíncrono de 1 MB y el síncrono de 6 MB de Lambda significan que el video nunca pasa por Lambda** — se pasan claves de S3. Lambda sirve como *orquestador* y es marginal como worker de ffmpeg: a 10.240 MB da ~6 vCPU y 10 GB de `/tmp`, suficiente para un clip de 90 s, pero a $0.0000166667/GB-s son **$0.0020 por 12 s**, es decir **3–10× Fargate/EC2** por el mismo trabajo. **Lambda para control de flujo, contenedores para ffmpeg.**

**El "1 hora si se usa GPU" de Cloud Run jobs** es la trampa para quien piense meter ASR+OCR ahí: bien para un clip de 90 s, fatal para reprocesar el histórico.

**Coste de 12 vCPU-segundos (4 vCPU / 8 GB durante 12 s):**

| Plataforma | Tarifa | Coste |
|---|---|---|
| EC2 c7i.xlarge spot | $0.068/h | **$0.00023** |
| **Fargate ARM/Graviton2** | $0.0000089944/vCPU-s + $0.0000009889/GB-s | **$0.00053** |
| Fargate x86 on-demand | $0.000011244/vCPU-s | $0.00066 |
| EC2 c7i.xlarge on-demand | $0.179/h | $0.00060 |
| Modal CPU | $0.0000131/core-s | $0.00084 |
| Cloud Run | $0.000024/vCPU-s | $0.00140 |
| **AWS MediaConvert equivalente** | $0.0075/min normalizado; 1080p30 = ×2 | **$0.015 ← 25×** |

> **ffmpeg en CPU cuesta $0.0002–$0.0014 por video de 60 s. Es error de redondeo. No usar un transcodificador gestionado para esto, ni ponerlo en GPU.**

**Precios de colas y orquestadores:** AWS SQS **$0.40 por millón** de peticiones (1M/mes gratis permanente); Cloudflare Queues **$0.40 por millón** de operaciones (10.000/día gratis); Temporal Cloud **$50 por millón de actions** (hasta $25/M a volumen), $150 de crédito 90 días; Inngest Pro desde **$99/mes** con 1M de ejecuciones, plan Hobby 50.000/mes; Trigger.dev por segundo, Large-1x (4 vCPU/8 GB) **$0.00034/s** + $0.000025 por invocación, **"sin timeouts"**, plan Pro $50/mes.
⚠️ **Trigger.dev cuesta ~2× Fargate x86 por la misma forma de 4 vCPU/8 GB y no lista máquinas con GPU** (https://trigger.dev/pricing): puede alojar la etapa de ffmpeg, no la de ASR/OCR. Inngest y Temporal son orquestadores, no cómputo — siguen necesitando workers debajo.

### 8.6 Quién hace esto en producción de verdad

Esta es la parte más pobre del registro público. **No existe blog de ingeniería de primera mano de OpusClip, Descript, Submagic, Veed, Kapwing ni Riverside describiendo su pipeline.** Lo que sí hay:

- **Mux** — la única fuente primaria real. Su arquitectura publicada es **basada en Kafka con procesos "Worker"** y semántica exactly-once (https://www.mux.com/blog/processing-cdn-logs-exactly-once-with-kafka-transactions). Para flujos de IA sobre video promueven un patrón **dirigido por webhooks**: los webhooks disparan los flujos de IA cuando el asset está listo, "de modo que la experiencia de subida nunca se bloquea" (https://www.mux.com/articles/build-ai-video-content-processing-for-better-engagement-and-product-experience).
- **Meta** — ver §8.1.
- **Mixpeek** — Celery + Redis en Render, dos servicios worker a **`-c 4` de concurrencia**, Redis como broker y backend de resultados, `max_retries=3` con 5 s de espera (https://mixpeek.com/blog/using-celery-to-process-thousands-of-videos/).
- Consenso de la comunidad: **mover ffmpeg a workers en background con cola (BullMQ+Redis o Celery+Redis) a concurrencia ≈ núcleos / 2**, porque ffmpeg es CPU-bound y dos trabajos concurrentes en una máquina de 2 núcleos ahogan al listener HTTP. **Autoescalar por profundidad de cola, no por CPU.**

### 8.7 Forma recomendada del pipeline

```
POST /upload → PUT firmado a R2/S3 → encolar job
                         │
                    [SQS / Redis]
                         │
        ┌────────────────▼─────────────────┐
        │ Worker CPU (Fargate ARM, 4 vCPU) │  ~12 s
        │ UNA sola pasada de ffmpeg:       │
        │  • WAV 16 kHz mono      (0,1 s)  │
        │  • N fotogramas @1 fps (a tmpfs) │
        │  • límites de escena (fusionado) │
        └───────┬──────────────────┬───────┘
                │  fan-out en paralelo
        ┌───────▼───────┐   ┌──────▼─────────┐
        │ ASR (L4)      │   │ OCR PaddleOCR  │  ~4 s / ~10 s
        │               │   │ 12-20 keyframes│
        └───────┬───────┘   └──────┬─────────┘
                └────────┬─────────┘
                    ┌────▼──────┐
                    │ 1 llamada │  ~8-25 s
                    │    LLM    │
                    └────┬──────┘
                     informe
```

Mantener el contenedor GPU **caliente con `min-instances ≥ 1`** en horario laboral: una L4 ociosa en Modal cuesta $0.80/h, más barato que incumplir el SLA. **Ejecutar ASR y OCR en el mismo contenedor GPU** para pagar un solo cold start y una sola ventana de facturación, y **en paralelo** porque el OCR es el poste largo.

### 8.8 Almacenamiento y la decisión sobre los fotogramas

| Store | Almacenamiento | Ops escritura | Ops lectura | Egreso |
|---|---|---|---|---|
| **Cloudflare R2** | **$0.015/GB-mes** (IA $0.01) | Clase A $4.50/M | Clase B $0.36/M | **$0 — gratis** |
| AWS S3 Standard | $0.023/GB-mes | PUT $0.005/1.000 | GET $0.0004/1.000 | **$0.09/GB** tras 100 GB/mes |
| Backblaze B2 | **$0.00695/GB-mes** | gratis | gratis | gratis hasta 3× lo almacenado; **ilimitado hacia Cloudflare/Fastly/bunny** |

(https://developers.cloudflare.com/r2/pricing/, https://aws.amazon.com/s3/pricing/, https://www.backblaze.com/cloud-storage/pricing)

**La aritmética con los 3,1 MB / 60 fotogramas medidos:**
- **Regenerar:** ~12 s en 4 vCPU = **$0.00044** (Fargate ARM) — pero solo si aún se tiene el video original.
- **Guardar como 60 objetos sueltos en R2:** 60 ops Clase A = **$0.00027** + $0.0000465/mes. **Las operaciones de escritura cuestan 6× el almacenamiento.**
- **Guardar como UN tar/zip:** 1 op Clase A = $0.0000045 + **$0.0000465/mes**. ~10× más barato que regenerar, para siempre.
- **Punto de equilibrio (archivo único vs regenerar):** ≈ **9,5 meses**.

**Recomendación:**
1. **No persistir fotogramas en la ruta síncrona** — dejarlos en el tmpfs del contenedor (Fargate da 20 GB gratis; 3 MB no es nada) y que mueran con el job.
2. **Si hacen falta después**, escribir **un solo objeto archivo**, nunca 60. A este tamaño de fichero manda el coste por operación.
3. **La decisión real de almacenamiento es el video fuente, no los fotogramas.** Un original de 25 MB cuesta $0.000375/mes en R2 — **8× lo que cuestan los fotogramas**. Si se guarda el original, siempre se pueden regenerar.
4. **Usar R2 o B2, no S3**, si algo sale de la nube: el egreso de S3 a $0.09/GB supera por sí solo toda la factura de cómputo. El de R2 es **$0**.

### 8.9 Servicios gestionados de video (solo si además hay reproducción)

| Servicio | Ingesta/codificación | Almacenamiento | Entrega | Free tier |
|---|---|---|---|---|
| **Mux** | **Gratis** (1080p Basic on-demand) | **$0.00300/min/mes** | **$0.00100/min** | **100.000 min de entrega/mes** + $20/mes de crédito (https://www.mux.com/pricing/video) |
| **Cloudflare Stream** | **Gratis** (ingesta y codificación siempre gratis) | **$5 por 1.000 min/mes** | **$1 por 1.000 min** | Sin free tier autónomo; mínimo $5/mes (https://developers.cloudflare.com/stream/pricing/) |
| **AWS MediaConvert** | Basic **$0.0075/min normalizado**; Professional $0.0120 | n/a | n/a | Sin asignación específica declarada (https://aws.amazon.com/mediaconvert/pricing/) |
| **Bunny Stream** | Gratis | desde $0.01/GB | desde $0.005/GB | Prueba de 14 días (https://bunny.net/stream/) |
| **api.video** | Gratis, minutos ilimitados | desde $0.00285/min | desde $0.0017/min | Sandbox 30 s, con marca de agua (https://api.video/pricing/) |

Multiplicadores de MediaConvert: SD ×1 (≤30 fps), **HD ×2**, 4K ×4. **Para un pipeline de análisis no hace falta ninguno de estos.** Si además hay que reproducir el video en el producto: **Mux sale más barato en almacenamiento, Cloudflare en entrega** — elegir según la proporción entrega:almacenamiento.

### 8.10 Coste total por video de 60 s

**Coste fijo del pipeline (idéntico en todas las configuraciones):**

| Etapa | Detalle | Coste |
|---|---|---|
| Ingesta + PUT firmado | R2, 1 op Clase A | $0.000005 |
| Cola | SQS ~3 peticiones a $0.40/M | $0.0000012 |
| **ffmpeg** (decode + 60 frames + audio + escenas) | 12 s × 4 vCPU/8 GB Fargate ARM | **$0.00053** |
| **ASR** faster-whisper en L4, 3 s | $0.000222/s | **$0.00067** |
| **OCR** 16 keyframes × 0,62 s = 10 s en L4 | $0.000222/s | **$0.0022** |
| Amortización de cold start GPU | ~3 s facturados, ~30% de los jobs | $0.0002 |
| Almacenamiento transitorio | 25 MB + 3 MB, 1 día, R2 | $0.000014 |
| **Subtotal (sin LLM)** | | **$0.0037** |

**Coste del LLM por configuración** (asumiendo transcripción ~1.200 tok, texto OCR ~800 tok, prompt+rúbrica ~1.000 tok, informe de salida ~1.500 tok):

| # | Configuración | Tok entrada | Coste LLM | **Total/video** |
|---|---|---|---|---|
| **A** | **Gemini 3.8 Flash, video nativo** (incl. audio) | 8.000 | $0.0116 | **$0.015** |
| **B** | Gemini 2.5 Flash, video nativo | 8.000 | $0.0062 | **$0.010** |
| **C** | **Claude Sonnet 5, 7 hojas de montaje (60 frames empaquetados)** | 9.006 | $0.033 | **$0.037** |
| **D** | Claude Haiku 4.5, 7 hojas de montaje | 9.006 | $0.0165 | **$0.020** |
| **E** | Claude Haiku 4.5, 24 frames sueltos @614×1092 | 23.592 | $0.031 | **$0.035** |
| **F** | Claude Sonnet 5, 24 frames sueltos | 23.592 | $0.062 | **$0.066** |
| **G** | Claude Sonnet 5, **60 frames sueltos (ingenuo)** | 54.480 | $0.124 | **$0.128** |
| **H** | Claude Opus 5, 7 hojas de montaje | 9.006 | $0.083 | **$0.086** |

**Conclusiones:**
1. **La llamada al LLM es el 76%–97% del coste total en todas las configuraciones.** Optimizar ffmpeg, almacenamiento o la cola es perder el tiempo. **Optimizar píxeles enviados al modelo lo es todo.**
2. **El empaquetado en montaje es la mayor victoria: de G a C es 3,5× más barato con los mismos 60 fotogramas.** Es gratis de implementar — un filtro `tile` de ffmpeg (§4.3).
3. **El video nativo de Gemini es 2–3× más barato todavía**, porque cobra 100 tok/s de video en lugar de por píxel, e ingiere el audio de forma nativa — con lo que **puede que no haga falta una etapa de ASR separada**, ahorrando otros $0.0007 y 4 s de latencia. ⚠️ A cambio se pierden las marcas por palabra y la capacidad de cambiar de modelo de ASR.
4. **Rango realista: $0.01–$0.07 por video de 60 s.** A 100.000 videos/mes son **$1.000–$7.000/mes**, de los cuales **$370 es infraestructura** y el resto son tokens.
5. **Pagar ASR gestionado en vez de auto-alojarlo añade ~$0.001–$0.004/video** — ruido frente a la línea del LLM. **Empezar con ASR gestionado** (Together Whisper Large v3 a **$0.0015/min**, o Deepgram) y auto-alojar solo al cruzar ~500.000 videos/mes o si se necesitan marcas por palabra que la API no dé.

### 8.11 Presupuesto de latencia: ¿se llega a 2 minutos?

| Etapa | Caliente | Frío |
|---|---|---|
| Subida (cliente → R2, 25 MB a 10 Mbps) | ~20 s | ~20 s |
| Recogida de la cola | 0,5–2 s | 0,5–2 s |
| ffmpeg (4 vCPU, pasada única fusionada) | **10–12 s** | +30–60 s si arranca la tarea Fargate |
| Arranque del contenedor GPU | 0 s | **1,8 s (Modal) / 4,2 s (RunPod) / 6,5 s (Replicate)** |
| Carga de pesos (Whisper + Paddle) | 0 s | **2–20 s**; 2 s con snapshots de memoria GPU de Modal |
| ASR (60 s de audio, L4, int8 batch) | **3–4 s** | igual |
| OCR (16 keyframes), en paralelo con ASR | **10 s** | igual |
| Llamada al LLM | **8–25 s** | igual |
| Montaje del informe + webhook | 1 s | 1 s |
| **Total (sin subida)** | **~35–55 s** | **~70–130 s** |

**La ruta caliente entra cómodamente en 2 minutos. La fría está en riesgo.** Las dos correcciones, por orden:
1. **Nunca arrancar Fargate en frío por job.** Servicio ECS permanente escalado por profundidad de cola. El arranque de una tarea Fargate son 30–60 s, la mitad del presupuesto.
2. **Mantener ≥1 contenedor GPU caliente.** Una L4 en Modal son $0.80/h = $576/mes 24/7, o ~$190/mes en horario laboral. Frente a $1.000–$7.000/mes de tokens, es seguro barato.
3. **ASR y OCR en paralelo** — son independientes y el OCR es el poste largo. Ahorra ~4 s.
4. **Hacer streaming de la respuesta del LLM** para que el usuario vea el informe formarse en vez de un spinner.

**La vara de la competencia está baja:**
- **Submagic:** subtítulos en **~40 s**; un video de 2 minutos va de crudo a exportable **en menos de 2 minutos** (https://care.submagic.co/en/article/how-to-use-submagic-step-by-step-guide-pafx7o/).
- **OpusClip ClipAnything:** su propia documentación dice **"típicamente entre 20 y 40 minutos"** (https://help.opus.pro/docs/article/clipanything-qa-4).
- **Descript:** no publica cifra de latencia.
- **Higgsfield:** su herramienta de análisis escena a escena declara **3–5 minutos de media**.

> **Un tiempo de respuesta por debajo de 2 minutos en un clip de 60–90 s dejaría al producto muy por delante de OpusClip y a la par de Submagic. Es alcanzable, y la restricción es el número de fotogramas para OCR y la temperatura del contenedor, no la velocidad del modelo.**

### 8.12 Lo que NO se pudo verificar

- **Ningún proveedor publica un SLA de cold start.** Todas las cifras de §8.4 son afirmaciones de marketing o benchmarks de terceros con metodología delgada.
- **Fal.ai** no publica precios de T4/L4/A10G/A100 ni tarifa por segundo; **RunPod** solo renderizó valores horarios (los por segundo son hora÷3600) y no distingue *flex* de *active worker*; **Together** ya no lista A100 ni L40S.
- Páginas de AWS que **no renderizaron sus propias tablas de precios**: CloudFront pay-as-you-go, SQS por millón, EC2 on-demand, tarifas de Fargate Spot. Se usó `instances.vantage.sh` (refleja la API de precios de AWS, pero es tercero) y fuentes secundarias, marcadas en línea.
- **Multiplicadores de prompt caching de Claude** — el texto de la página de precios leído resulta ambiguo. Verificar contra la documentación de la API antes de modelarlos.
- **Mux Data no tiene precio por vista separado** — va incluido con Mux Video.
- **PySceneDetect publica benchmarks de exactitud (F1/precisión/recall sobre BBC y AutoShot) pero no de velocidad** (https://www.scenedetect.com/benchmarks/).
- **No hay benchmark de PP-OCRv5 en T4/L4/A10**, solo el de V100.
- **Las cifras de ffmpeg de §8.1 se midieron en Apple M3 Pro, no en un vCPU de nube x86**, con una fuente sintética de peor caso. El derating de 2,5–3× es razonamiento, no medición. **Repetir la prueba sobre la instancia objetivo real antes de comprometer un SLA.**

---

## 9. Tabla maestra: señal → cómo se mide → herramienta → costo

Costos expresados **por video de 60 s**. "Self-host" = coste marginal cero, se paga el worker (§8).

| # | Señal | Cómo se mide | Herramienta | Costo |
|---|---|---|---|---|
| 1 | Duración, resolución, aspect ratio, fps, bitrate | Lectura de contenedor | `ffprobe -show_entries` | $0 |
| 2 | Duración del primer plano | Primer límite de escena | PySceneDetect `AdaptiveDetector` | $0 |
| 3 | Nº de planos, cortes/min, duración mediana y σ | Lista de escenas | PySceneDetect `detect-adaptive` | $0 |
| 4 | Planos en los primeros 5 s | Filtrar escenas con `start < 5` | PySceneDetect | $0 |
| 5 | Movimiento / flujo óptico por segundo | Flujo denso sobre frames a 2 fps, 240 px | `cv2.DISOpticalFlow` (o `YDIF` de ffmpeg) | $0 |
| 6 | Brillo, contraste, saturación por segundo | Metadata por frame | ffmpeg `signalstats` + `metadata=print` | $0 |
| 7 | Desenfoque / foco | Varianza del Laplaciano | OpenCV | $0 |
| 8 | Fotogramas negros / congelados | Filtros dedicados | ffmpeg `blackdetect`, `freezedetect` | $0 |
| 9 | Estabilidad de cámara | Transformaciones por frame | ffmpeg `vidstabdetect` | $0 |
| 10 | Presencia y **área** del rostro por segundo | Bounding box normalizado, `w×h` | YuNet (`cv2.FaceDetectorYN`) ~0.03 s/rostro, o MediaPipe ~0.04 s | $0 |
| 11 | Loudness integrada (LUFS), LRA, true peak | Análisis EBU R128 | ffmpeg `ebur128=peak=true` | $0 |
| 12 | Curva de loudness segundo a segundo | Short-term por frame | ffmpeg `ebur128=metadata=1` + `ametadata=print` | $0 |
| 13 | Silencios y pausas | Umbral + duración mínima | ffmpeg `silencedetect=noise=-35dB:duration=0.35` | $0 |
| 14 | Segmentos con voz (VAD) | Detección de actividad vocal | **Silero VAD** (MIT, <1 ms/chunk) | $0 |
| 15 | Transcripción con **marcas por palabra** (ES) | ASR + alineación | **Canary-1B-v2** (2.90 WER FLEURS es) o **Parakeet-TDT-0.6B-v3** (RTFx 3332), ambos CC-BY-4.0 | $0 |
| 15b | Ídem, gestionado | API | Deepgram Nova-3 multilingüe | **$0.0052** |
| 15c | Ídem, gestionado, mejor WER agregado | API | ElevenLabs Scribe v2 | **$0.00367** |
| 15d | Ídem + diarización en un solo pipeline OSS | faster-whisper + wav2vec2 + pyannote | **WhisperX** | $0 |
| 16 | WPM global y en ventana de 5 s | Aritmética sobre word timestamps | código propio | $0 |
| 17 | Pausas retóricas, tiempo hasta la primera palabra | Huecos entre palabras > 0.35 s | código propio | $0 |
| 18 | Tasa de articulación / habla (sílabas) | Praat vía Python | **praat-parselmouth** | $0 |
| 19 | Relación música/voz en LU | Separación de stems + LUFS por stem | **Demucs v4** `--two-stems=vocals` + **pyloudnorm** (BS.1770-4) | $0 |
| 20 | Texto en pantalla: contenido, bbox, tamaño | OCR por fotograma a 2–4 fps | **PaddleOCR PP-OCRv5** `--lang es` (0.62 s/img V100, 1.75 s/img CPU) | $0 |
| 20b | Ídem, gestionado (imagen) | API por fotograma | AWS DetectText / Google Vision / Azure Read | **$0.060 / $0.090 / $0.090** |
| 20c | Ídem, gestionado (video nativo) | API de video | AWS `StartTextDetection` / Google Video Intelligence | **$0.100 / $0.150** |
| 21 | Segundo de aparición y desaparición de cada texto | Tracking por IoU>0.5 + edit distance<0.3 + voto ponderado | código propio sobre PaddleOCR | $0 |
| 22 | Colisión con zona segura de UI | Intersección de bbox normalizado con rectángulos por plataforma | código propio | $0 |
| 23 | Hook: promesa, claridad, gancho | LLM sobre frames densos (0–3 s a 10 fps) + transcripción | **Gemini 3.8 Flash** video nativo, res. alta | **~$0.0135** |
| 23b | Ídem con Claude (frames, no video) | 20 frames clave 540×960 = ~14k tokens visuales | **Claude Sonnet 5** | **~$0.028** |
| 24 | Estructura narrativa, cumplimiento de promesa, CTA | LLM sobre transcripción + anotaciones deterministas | Gemini 3.8 Flash, res. baja | **~$0.0045** |
| 25 | Encuadre (ECU/CU/MS/LS) y densidad de plano cerrado | LLM con rúbrica explícita + verificación por área de rostro | Gemini + YuNet | incluido en 23/24 |

**Coste total por video de 60 s, arquitectura recomendada** (ffmpeg en Fargate ARM + ASR y OCR sobre keyframes en una L4 de Modal + una llamada a Gemini 3.8 Flash con video nativo): **≈$0.015**, de los cuales **$0.0037 es infraestructura y el resto tokens** (desglose completo en §8.10). El camino ingenuo —60 fotogramas sueltos a Claude Sonnet 5 y OCR en API gestionada— cuesta **$0.128**, es decir **8,5× más.**

---

## 10. Propuesta: 16 reglas medibles para el semáforo "listo para publicar"

**Marco.** Verde = cumple. Ámbar = fuera de rango pero recuperable. Rojo = corregir antes de publicar. **El semáforo NO predice views: certifica cumplimiento de reglas correlacionadas con retención.** Cada regla dice explícitamente de dónde sale su umbral.

**Anclas de realidad que deben aparecer en la UI junto al score, para no vender humo:**
- **≈50% de los TikToks servidos se abandonan antes del 10% de su duración** (CHI '26, n=2,65M videos, https://arxiv.org/abs/2503.20030).
- **El full watch rate medio de TikTok es 6,30%** (Metricool 2026, n=2,31M posts, https://metricool.com/wp-content/uploads/tiktok-study-2026-EN.pdf). Cualquier objetivo de completion por encima del 10% que el creador haya leído en un blog es un orden de magnitud falso.
- **El watch time medio de un Reel es 8,5 segundos** (Metricool 2026, n=24,3M posts, https://metricool.com/press-release-instagram-study-2026/).

### Bloque A — Hook (segundos 0–3). Peso: 40% del score.

**R1 · El primer plano dura menos de 3 s.**
Umbral: `duración_primer_plano < 3.0 s`. Ámbar 3.0–4.5 s, rojo > 4.5 s.
Justificación: **fuente primaria.** Es exactamente la constante `dynamic_cutoff_ms = 3000` que Google usa para marcar "Dynamic Start" en su ABCDs Detector (https://github.com/google-marketing-solutions/abcds-detector/blob/main/configuration.py). *Nota: el folclore dice "corte antes del segundo 1,5"; no tiene fuente. Usar 3 s.*

**R2 · Hay al menos 3 planos en los primeros 5 segundos.**
Umbral: `planos(t<5s) >= 3`. Verde con ≥5.
Justificación: **fuente primaria con ajuste.** Google exige **5 planos en 5 s** para su feature "Quick Pacing" (`required_shots_for_quick_pacing = 5`). Se rebaja a 3 como mínimo aceptable porque el criterio de Google está calibrado sobre anuncios, no sobre contenido orgánico de creador, donde un talking-head con un solo plano puede funcionar.

**R3 · Hay voz o texto en pantalla dentro de los primeros 1,5 s.**
Umbral: `min(primer_word_start, primer_texto_start) <= 1.5 s`.
Justificación: **fuente primaria con margen.** Google marca "Audio Speech Early" con `early_time_seconds = 5`; TikTok recomienda "introducir la propuesta de contenido en los primeros 3 segundos" (https://ads.tiktok.com/help/article/creative-best-practices) y Meta dice "captar la atención en los **primeros dos segundos**" (https://www.facebook.com/business/learn/lessons/create-fb-ig-reels). 1,5 s es la lectura conservadora de la guía de Meta.

**R4 · El mensaje clave o el producto aparece en los primeros 3 s.**
Verificación: LLM sobre los frames densos del hook + transcripción, con evidencia de timestamp obligatoria.
Justificación: **fuente primaria, leída con cuidado.** *"Más del 63% de todos los videos con el mayor CTR destacan su mensaje clave o producto dentro de los primeros 3 segundos"* — TikTok for Business, "9 Creative Tips to drive performance", PDF fechado **2020-11-12** (https://ads.tiktok.com/business/library/Auction_Ads_Creative_Tips.pdf). **Es prevalencia entre los mejores anuncios de subasta, no un lift causal, y no hay tasa base publicada (§7.1). La regla se sostiene, la cifra no se puede presentar como promesa.** Refuerzo independiente y más sólido: ≈50% de los TikToks se abandonan antes del 10% de su duración (CHI '26, n=2,65M videos, https://arxiv.org/abs/2503.20030).

**R5 · Hay un rostro visible en los primeros 5 s y ocupa al menos el 15% del cuadro en algún momento.**
Umbral: `max(área_rostro_normalizada, t<5s) >= 0.15`.
Justificación: **fuente primaria.** `face_surface_threshold = 0.15` en el ABCDs Detector marca "Visible Face (Close Up)". Refuerzo independiente: el estudio ACM 2022 sobre 400 videos de TikTok encontró que **la escala de plano (close-up y medium) discrimina virales de no virales** (https://dl.acm.org/doi/fullHtml/10.1145/3501247.3531551). *Regla desactivable: no aplica a contenido sin personas.*

### Bloque B — Ritmo y montaje. Peso: 15%.

**R6 · La duración media de plano es ≤ 2 s (o el video es un talking-head declarado de un solo plano).**
Umbral: `duración_media_plano <= 2.0 s`.
Justificación: **fuente primaria.** `avg_shot_duration_seconds = 2` en el ABCDs Detector marca "Overall Pacing" bueno.

**R7 · La densidad de plano cerrado está entre el 30% y el 60% de la duración.**
Umbral: `0.30 <= (duración CU+ECU / duración total) <= 0.60`.
Justificación: **fuente primaria.** Es la "Goldilocks Zone" literal de la rúbrica de Shorts de Google, con bonus si los primeros 3 s tienen encuadre cerrado (https://github.com/google-marketing-solutions/abcds-detector/blob/main/features_repository/shorts_features.py). Clasificación de la misma rúbrica: ECU >80% del cuadro, CU 60–80%, MS 30–59%, LS <30%.

**R8 · No hay ningún plano estático de más de 6 s sin movimiento de cámara ni cambio de texto.**
Umbral: ningún tramo con `flujo_óptico < p10` y sin evento de texto durante > 6 s.
Justificación: **derivada, no de fuente.** Se construye sobre R6 y sobre la guía de TikTok de "priorizar el hook en los primeros 6 segundos". **Marcar en producto como heurística propia.**

### Bloque C — Audio. Peso: 20%.

**R9 · Loudness integrada entre −16 y −9 LUFS, con true peak ≤ −1 dBTP.**
Medición: `ffmpeg -af ebur128=peak=true`.
Justificación: **convención de industria, NO especificación de plataforma.** Los objetivos que circulan (YouTube ~−14, Instagram/TikTok −10 a −12, Facebook −13) provienen de mediciones de la comunidad de audio (https://www.criticallisteninglab.com/en/learn/loudness/social-media). El rango −16 a −9 los cubre a todos. Lo que sí es estándar formal es la **medición**: ITU-R BS.1770-4 / EBU R128. **Declararlo como convención en la UI, no como regla de plataforma.**

**R10 · No hay silencio de más de 1,2 s en ningún punto del video.**
Medición: `silencedetect=noise=-35dB:duration=0.35`, agregar y buscar el máximo.
Justificación: **heurística propia con fundamento en la métrica ECR.** La retención temprana es la variable objetivo demostrada (SROCC 0.707 en el leaderboard ICCV 2025, https://arxiv.org/html/2509.02969v1) y un hueco de audio es un punto natural de abandono. **Umbral sin fuente publicada: calibrar sobre corpus propio.**

**R11 · La música no está a menos de 6 LU por debajo de la voz durante los segmentos con voz.**
Medición: Demucs `--two-stems=vocals` → pyloudnorm short-term por stem → diferencia en LU.
Justificación: **folclore de mezcla de audio, sin fuente publicada.** Se incluye porque es barata de medir y el fallo es audible y objetivo. Refuerzo indirecto: VideoLLaMA2 (con audio) supera a Qwen2.5-VL (sin audio) en el mismo benchmark de engagement (https://arxiv.org/html/2508.02516v2) — el audio pesa.

**R12 · Hay voz humana durante al menos el 50% de la duración, o hay subtítulos quemados cubriendo toda la voz.**
Medición: densidad de habla de Silero VAD; cobertura de OCR sobre segmentos con voz.
Justificación: **guía de plataforma.** Google: "usa sonido (música, voz en off, o ambos) en tus anuncios de Shorts, lo que ha demostrado **aumentar las conversiones en más de un 20%**" (https://support.google.com/google-ads/answer/16041697?hl=en). TikTok: 88% de los usuarios dice que el sonido es vital (TikTok Marketing Science / Kantar 2022).

### Bloque D — Texto en pantalla y encuadre. Peso: 15%.

**R13 · Hay texto en pantalla dentro de los primeros 3 s.**
Justificación: **fuente primaria.** *"40% de los auction ads con el mayor VTR"* usan superposición de texto — TikTok, "9 Creative Tips" (https://ads.tiktok.com/business/library/Auction_Ads_Creative_Tips.pdf). Combinado con R4.

**R14 · Ningún bloque de texto invade la zona segura de la plataforma destino en más de un 10% de su área.**
Umbrales por plataforma (lienzo 1080×1920): **TikTok** 130 px arriba / 484 px abajo / 140 px derecha / 60 px izquierda (perfil conservador); **Meta Reels/Stories** 270 px arriba (14%) / 670 px abajo (35%) / 65 px lados (6%).
Justificación: **mixta.** TikTok **reconoce oficialmente** que la zona segura varía con el formato, la longitud del caption y los add-ons, y recomienda previsualizar (https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads?lang=en). Meta publica guía oficial (https://www.facebook.com/business/help/980593475366490) y la herramienta Safe Zone Guardrail en Ads Manager. **Las cifras en píxeles son de guías de terceros y discrepan entre sí — presentarlas como estimación, nunca como especificación oficial.**

**R15 · Hay subtítulos quemados que cubren al menos el 90% de la voz.**
Medición: solapamiento entre tracks de OCR y segmentos de VAD.
Justificación: **accesibilidad, comprensión y el texto como hook — NO la cifra del 12% ni el "85% sin sonido".** La premisa clásica está invertida para 2026: **TikTok dice que el 93% de sus usuarios consume con sonido activado** y YouTube que **el 95% del video se reproduce con sonido** (§6.5b); Instagram declara **un tercio** sin sonido, no el 85%. La cifra del 12% existe (https://www.facebook.com/business/news/updated-features-for-video-ads) pero es de **2016, sin n y sin control**. **La regla es correcta; ninguna de las cifras habituales se puede citar.**

### Bloque E — Formato y sanidad técnica. Peso: 10%.

**R16 · Vertical 9:16 nativo, ≥1080×1920, sin barras ni reencuadre, sin fotogramas negros ni congelados > 0,5 s.**
Medición: `ffprobe` + `blackdetect` + `freezedetect`.
Justificación: **fuente primaria doble.** TikTok: *"Hemos visto que los TikToks grabados verticalmente tienen en promedio un **25% más de watch-through rate a 6 segundos**"* (https://ads.tiktok.com/business/library/Auction_Ads_Creative_Tips.pdf). Google, datos internos globales 2024: añadir un video vertical a un grupo solo horizontal sube **VTR en Shorts +40%**, **viewability +45%** y **average watch time +20%** (https://support.google.com/google-ads/answer/9128498?hl=en). Mínimo técnico de TikTok: 9:16, ≥540×960 (https://ads.tiktok.com/help/article/tiktok-auction-in-feed-ads?lang=en).

### Reglas deliberadamente EXCLUIDAS y por qué

- **"Duración entre 21 y 34 segundos".** Atribuida a TikTok; **TikTok nunca la publicó**. Además, el mayor estudio disponible (Socialinsider, 111.000 videos, ene–jun 2026) apunta en dirección contraria: en Reels, 45–60 s rinde mejor que 0–30 s en engagement y views (https://www.socialinsider.io/social-media-benchmarks/social-media-video-statistics). **No hay regla defendible de duración óptima; dar el dato comparativo y dejar decidir.**
- **"Máximo N palabras por minuto".** No se puede fijar sin calibrar sobre corpus propio en español: el español se habla a **7,82 sílabas/segundo** frente a 6,19 del inglés, ~26% más rápido (https://www.scientificamerican.com/article/fast-talkers/). Un umbral importado del inglés marcaría como "demasiado rápido" a un hablante normal. **Implementar como percentil sobre el propio corpus, no como constante.**
- **"Pattern interrupt cada 4 segundos".** Única fuente: un post de blog de OpusClip con n=500 y sin metodología. **Folclore.**

### Cómo presentar el resultado al creador

1. **Nunca dar un número de views.** Dar un **score de cumplimiento** (0–100) desglosado por bloque, y ser explícito: *"esto mide si tu video respeta patrones correlacionados con retención temprana; no predice cuántas views hará."*
2. **Todo hallazgo lleva timestamp y fotograma.** "Tu primer corte está en el segundo 4,2" vale; "tu ritmo es lento" no vale.
3. **Etiquetar la procedencia de cada regla en la propia UI:** *fuente de plataforma* / *convención de industria* / *heurística propia*. Es un diferenciador real: ningún competidor lo hace.
4. **Publicar una validación honesta en cuanto haya datos.** Correlacionar el score con la retención real post-publicación de los usuarios y publicar el Spearman. **Ningún competidor del sector tiene una cifra de validación publicada** — ni OpusClip, ni Munch, ni Klap, ni Vizard, ni Submagic, ni Higgsfield. El referente honesto del mercado es Pencil, con 70.5 de correlación entre CTR predicho y real (https://trypencil.com/blog/articles/pencil-media-performance-score), que casualmente coincide con el techo académico de ~0.71 del leaderboard de SnapUGC.
