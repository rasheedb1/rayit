# Investigación de APIs — publicación de video y analítica multi-cuenta

Investigación realizada el 18 de agosto de 2026 contra documentación oficial, con verificación adversarial independiente de cada tema (las cifras marcadas se contrastaron con segunda búsqueda; donde hubo discrepancia se indica).

## Respuesta corta a la pregunta central

**Sí: las cuatro plataformas permiten subir video por API oficialmente**, sin subida manual. Pero las dos más importantes para video corto (TikTok y YouTube) tienen el mismo bloqueo inicial: **hasta que tu app pase una auditoría, todo lo que publiques por API queda en modo privado**. Ese trámite —no el código— es el camino crítico del proyecto.

## Matriz comparativa

| | TikTok | Instagram | Facebook | YouTube |
|---|---|---|---|---|
| **API de publicación** | Content Posting API | Graph API (contenedor → publish) | Reels Publishing API / Video API | Data API v3 `videos.insert` |
| **Límite de posts por API** | ~15/día por cuenta (compartido entre apps; 6 req/min) | 100/día por cuenta (ventana móvil 24 h) | 30 reels/día por página | 100 subidas/día **por proyecto** (bucket propio desde jun-2026) |
| **Requisito crítico** | Auditoría de la app; sin ella: posts privados (SELF_ONLY) y máx. 5 usuarios/24 h | Cuenta profesional; App Review para Advanced Access | Permisos de página vía App Review + Business Verification | Auditoría de compliance; sin ella: videos quedan privados. App OAuth en "Testing": tokens caducan a los 7 días |
| **OAuth** | Por cuenta (access 24 h, refresh 365 días) | Por cuenta (2 variantes: IG Login o FB Login) | Token de página / system user (no caduca) | Por canal (refresh token por canal, incl. canales de marca) |
| **Métricas por video** | Views, likes, comments, shares (Display API); reach y watch time (Business API) | Views, reach, likes, saves, shares, avg watch time, skip rate | media_view, retención, tiempo reproducido | Todas (Analytics API) |
| **Demografía edad/sexo por video** | ❌ (solo país por video, Business API) | ❌ | ⚠️ Sí en videos clásicos de página (`total_video_views_by_age_bucket_and_gender`); no documentado para Reels | ✅ (`viewerPercentage` por ageGroup/gender con filtro `video==ID`) |
| **Demografía edad/sexo por cuenta** | ✅ Business Account API (cuenta Business, ≥100 seguidores) | ✅ `follower_demographics` / `engaged_audience_demographics` (≥100 seguidores) | ❌ eliminada en 2024 (solo queda geografía/idioma de seguidores) | ✅ |
| **Geografía** | Por cuenta y por video (país) | Por cuenta (hasta 45 países/ciudades) | Por página y por video | Por canal y por video |

**Implicación directa para el dashboard**: la demografía edad/sexo **por video** solo existirá en YouTube (y parcialmente en Facebook). Para TikTok e Instagram el dashboard debe modelar demografía **por cuenta** y cruzarla con las métricas por video — exactamente como quedó diseñado en [esquema-datos.md](esquema-datos.md) (`AUDIENCE_BREAKDOWN.scope = post | account`).

## Detalle por plataforma

### TikTok — Content Posting API

- **Registro**: app en TikTok for Developers con el producto Content Posting API. Scopes: `video.publish` (publicación directa) o `video.upload` (a borradores del usuario).
- **Antes de la auditoría**: posts forzados a SELF_ONLY (solo los ve la propia cuenta), cuentas en modo privado, máximo 5 usuarios publicando por 24 h. La auditoría toma ~5–10 días hábiles y en el formulario se declara cuántos creadores activos tendrás — **declarar desde el inicio la meta de 50–100 cuentas**.
- **Límites**: 6 requests/min por token; ~15 posts/día por cuenta (la verificación encontró fuentes que lo sitúan en 15–25 según el tier; planificar con 15). El límite es compartido entre todas las apps que publiquen en esa cuenta.
- **OAuth**: cada cuenta autoriza individualmente. Access token de 24 h, refresh token de 365 días → hay que rotar tokens continuamente.
- **Video**: MP4/WebM/MOV, H.264 recomendado, hasta 4 GB, 360–4096 px, 23–60 FPS. La duración máxima real la dicta `creator_info` por cuenta (típicamente 3 min).
- **Analítica**: Display API da views/likes/comments/shares por video. La demografía (edad/sexo/país de audiencia) requiere convertir la cuenta a **Business** y usar la Business Account API (app separada en business-api.tiktok.com, ≥100 seguidores, refresco cada 24–48 h). Por video solo hay país.
- **⚠️ Conflicto a decidir**: TikTok Creator Rewards (monetización) exige cuenta **personal**; la demografía por API exige cuenta **Business**. No se puede tener ambas en la misma cuenta.
- **Atajo ya disponible**: la integración de TikTok de **Higgsfield** (verificado) usa la Content Posting API oficial con app ya auditada — sirve para publicar en público desde el día 1 con las primeras 5 cuentas, mientras se tramita app propia. Autolimita a 13 posts/24 h por cuenta.

### Instagram — Graph API

- **Dos variantes hoy**: "Instagram API with Instagram Login" (sin necesidad de página de Facebook, host graph.instagram.com) y "with Facebook Login" (requiere página vinculada, host graph.facebook.com). Para una red de cuentas nuevas, la variante con Instagram Login simplifica mucho.
- **Solo cuentas profesionales** (Business/Creator).
- **Flujo**: `POST /{IG_ID}/media` con `media_type=REELS` y `video_url` pública → sondear `status_code` → `POST /{IG_ID}/media_publish`. Contenedores caducan a las 24 h.
- **Límite**: **100 posts por API por cuenta por 24 h** (ventana móvil; verificado en la guía oficial — ojo: una página de referencia de Meta aún dice 50, está desactualizada). Verificable en vivo con `GET /{IG_ID}/content_publishing_limit`.
- **Video Reels**: MP4/MOV, H.264/HEVC, 9:16 recomendado, máx 1920 px horizontal, 3 s–15 min, ≤300 MB, ≤25 Mbps.
- **Cuentas por app**: sin límite documentado; el cuello reportado (no oficial) es ~25 cuentas IG por Business Portfolio (máx. 2 portfolios por persona) — para 100 cuentas: varios portfolios o la vía Instagram Login que no exige Business Manager.
- **Analítica**: por Reel: views, reach, likes, saves, shares, avg watch time, skip rate (`impressions` deprecada desde jul-2024). Demografía **solo por cuenta**: `follower_demographics` y `engaged_audience_demographics` (edad/sexo/ciudad/país; ≥100 seguidores o ≥100 interacciones).

### Facebook — Reels Publishing API

- **Requisitos**: página + app Live + token **de página** (ideal: system user de Business Manager, no caduca). Permisos `pages_show_list`, `pages_read_engagement`, `pages_manage_posts` (+ `read_insights`) — todos vía App Review + Business Verification.
- **Flujo Reels**: `start` en `/PAGE_ID/video_reels` → subir binario o `file_url` a rupload.facebook.com → `finish` con `video_state=PUBLISHED` (o DRAFT/SCHEDULED; programable de 10 min a 29 días).
- **Límite**: 30 reels publicados por API por página por 24 h. Specs: 3–90 s, 9:16, mín. 540×960, 24–60 fps.
- **Escala**: sin límite documentado de páginas por Business Manager — 100 páginas caben en uno solo verificado. Permite **crossposting** de un video entre páginas sin re-subirlo.
- **⚠️ Deprecaciones recientes que condicionan el dashboard**: edad/sexo a nivel página eliminados en 2024 sin reemplazo; `impressions` → `views` (nov-2025); desde jun-2026 todas las métricas `*_unique` de reach devuelven error → usar `post_media_view`, `post_total_media_view_unique`, `page_follows`. A nivel de video clásico, `/VIDEO_ID/video_insights` aún documenta edad+sexo y país por video — la única demografía orgánica que le queda a Facebook; validar en producción dado el historial de recortes de Meta.

### YouTube — Data API v3 + Analytics API

- **Subida**: `videos.insert` estándar; no hay flag "Short" — todo video ≤3 min con aspecto 1:1 o vertical se clasifica Short automáticamente (máx. 1080p).
- **Cuota (corregida en verificación — cambió el 1-jun-2026)**: `videos.insert` ahora cuesta 1 unidad en un bucket propio de **100 subidas/día por proyecto** (ya no ~6/día como con el esquema viejo de 1600 unidades). 100 cuentas × 1 Short/día = justo el tope → pedir extensión vía el formulario de auditoría al escalar.
- **Doble trámite**: (1) auditoría de compliance de la API — sin ella los videos suben **privados** (proyectos creados después de jul-2020); (2) verificación OAuth de Google — en modo "Testing" los refresh tokens caducan a los 7 días (inviable en producción).
- **Multi-canal**: canales de marca (Brand Accounts) bajo una cuenta Google (hasta ~100). Un refresh token **por canal**.
- **Analítica (la mejor de las cuatro)**: YouTube Analytics API expone `viewerPercentage` por `ageGroup` × `gender` **por video** (con filtro `video==VIDEO_ID`, una consulta por video — no en bloque) y geografía por video (`country` como dimensión). Cuota independiente de la Data API. Umbral de anonimato: videos con muy pocas vistas no devuelven filas demográficas.

## Agregadores (una sola API para todas las redes)

Todos los evaluados usan las APIs oficiales por OAuth (ninguno automatiza navegador, que es lo que sí arriesga baneos). Con cualquiera de ellos aplican igual los límites nativos de cada plataforma.

| Servicio | Precio 5 cuentas | Precio ~100 cuentas | Analítica | Demografía por API |
|---|---|---|---|---|
| **Zernio** (ex-Late/getlate.dev) | ~$18/mes (2 gratis + $6/cuenta) | ~$318/mes ($3/cuenta en tramo 11–100) | Sí | No documentada |
| **Post Bridge** | ~$14–34/mes (API = add-on $5) | ~$54/mes (Pro "ilimitado" + $5) | Básica | No |
| **upload-post.com** | $24/mes (5 perfiles) | ~$147–438/mes (~$2/perfil) | Por post | No |
| **Blotato** | $29/mes (20 cuentas) | $97–499/mes | Básica | No |
| **Ayrshare** | $149–299/mes | ~$599–1.228/mes | Completa | ✅ **el único** (edad/sexo/geo por cuenta) |
| **Publer** | ~$8–21/mes | +$4/cuenta | Solo web-app | No — no recomendado como backbone API |
| **Postiz** (open source) | $0 self-hosted (o nube ~$29/mes) | $0 + infra | Sí | Depende de tus apps propias |

Notas de la verificación: el rebrand Late→Zernio (2026) ilustra que varios son startups jóvenes — riesgo de cambios de precio/cierre; en Zernio, X/Twitter se cobra aparte (tarifas de la API de X sin margen). Postiz self-hosted elimina la dependencia del proveedor pero exige registrar y auditar apps propias en cada plataforma.

**Recomendación**:
- **Fase 1 (5 cuentas)**: Higgsfield para TikTok (ya integrado y auditado) + Zernio o Post Bridge para el resto (~$20–35/mes total). Validar el pipeline completo.
- **Fase 2 (50–100)**: multiposter barato para publicar (Post Bridge Pro o upload-post) + **lectura de demografía directa contra las APIs nativas con apps propias** (es gratis y más completa que pagar Ayrshare, aunque Ayrshare es la opción llave en mano si no quieren mantener 4 integraciones de lectura).

## Políticas: lo que las plataformas permiten y lo que castigan

Esto es lo más importante del informe para la viabilidad del negocio:

1. **Operar muchas cuentas propias es legítimo** si se hace por el camino oficial: Meta Business Manager (system users para automatizar), TikTok Business Center, canales de marca de YouTube. Los límites "3 cuentas por dispositivo" (TikTok) o "5 por app" (Instagram) son de las apps móviles, no del camino empresarial.
2. **Lo que provoca baneos no es la cantidad de cuentas, es el patrón**: las políticas de comportamiento inauténtico coordinado (Meta CIB, TikTok Integrity, spam de YouTube) castigan redes de cuentas que simulan ser independientes, se amplifican entre sí, o publican **el mismo contenido idéntico en N cuentas**. Cuentas temáticas diferenciadas, con identidad transparente y contenido adaptado por cuenta/nicho = seguro. El mismo video clonado en 50 cuentas = exactamente el patrón que detectan.
3. **Etiqueta de IA obligatoria en las 3 plataformas** para contenido realista generado/alterado con IA (toggle AIGC de TikTok, casilla de YouTube Studio, "AI info" de Meta; auto-detección por metadatos C2PA — los videos de Higgsfield los llevan). Omitirla reiteradamente = sanciones. Contenido claramente estilizado/animado no la requiere.
4. **Monetización — el listón subió para el contenido IA**:
   - YouTube "inauthentic content" (jul-2025): contenido producido en masa/repetitivo no es elegible para el Partner Program. Umbral YPP completo: 1.000 subs + 4.000 h/12 meses o 10 M vistas de Shorts/90 días (por canal).
   - TikTok Creator Rewards: 10.000 seguidores + 100.000 vistas/30 días, videos originales >1 min, y **solo cuenta personal** (conflicto con la cuenta Business que exige la demografía por API).
   - Facebook Content Monetization (unificado desde ago-2025): típicamente ~10.000 seguidores; Meta también persigue "unoriginal content".
   - Conclusión: el modelo de ingresos más robusto para esta operación no es la monetización nativa de las plataformas sino el que ya tenían en mente: **campañas con marcas y referidos**, donde lo que vale es el alcance demostrable — justo lo que mide el dashboard.

## Decisiones que esto deja tomadas (propuesta)

1. Empezar con **app propia de Meta** (IG + FB, un solo App Review) + **Higgsfield para TikTok** + **proyecto GCP propio para YouTube** (iniciar auditorías de TikTok y YouTube desde el día 1, en paralelo).
2. Diseñar el contenido como **nichos temáticos por cuenta** (no clones): mismo asset base → variantes por cuenta (hook, voz, idioma, formato) para no caer en las políticas de contenido duplicado.
3. Dashboard: demografía por cuenta (TikTok/IG) + por video (YT/FB clásico), como ya refleja el esquema y el mock.
4. Presupuesto de APIs fase 1: ~$0–35/mes (todo lo oficial es gratis; el agregador es opcional).
