# Esquema de datos — On Cue

Modelo de datos para operar una red de cuentas propias (5 → 50–100) en TikTok, Instagram, Facebook y YouTube, publicar video corto generado con IA (Higgsfield / ElevenLabs) vía API, y analizar rendimiento segmentado por **red social, geografía, edad, sexo y tipo de usuario**.

## Principio de diseño

Separamos tres conceptos que suelen mezclarse y que aquí importan mucho:

1. **Asset** — el video generado con IA (existe una vez, se produce con Higgsfield/ElevenLabs).
2. **Post** — una publicación concreta de ese asset en UNA cuenta de UNA red. Un mismo asset puede publicarse en 20 cuentas → 20 posts, cada uno con sus propias métricas.
3. **Snapshot de métricas** — las métricas se leen por API cada día y se guardan como serie temporal (nunca se sobreescriben), para poder ver crecimiento y comparar períodos.

Y una restricción real del ecosistema que el esquema debe reflejar: **no todas las plataformas exponen demografía al mismo nivel**. YouTube da edad/sexo/país **por video**; TikTok y Meta la dan principalmente **a nivel de cuenta/audiencia**. Por eso la tabla de demografía lleva un campo `scope` (`post` | `account`) en lugar de asumir que siempre hay desglose por video.

## Diagrama entidad-relación

```mermaid
erDiagram
    PLATFORM ||--o{ ACCOUNT : tiene
    ACCOUNT ||--o{ POST : publica
    ASSET ||--o{ POST : "se publica como"
    POST ||--o{ POST_METRICS_DAILY : "snapshot diario"
    ACCOUNT ||--o{ ACCOUNT_METRICS_DAILY : "snapshot diario"
    POST ||--o{ AUDIENCE_BREAKDOWN : "demografía (si la red la da)"
    ACCOUNT ||--o{ AUDIENCE_BREAKDOWN : "demografía de audiencia"
    CAMPAIGN ||--o{ POST : agrupa

    PLATFORM {
        string id PK "tiktok | instagram | facebook | youtube"
        string nombre
        json   limites_api "posts/dia, cuota, etc."
    }

    ACCOUNT {
        uuid   id PK
        string platform_id FK
        string handle
        string nombre_publico
        string tema "nicho de contenido de la cuenta"
        string pais_base
        string estado "activa | en_crecimiento | pausada | bloqueada"
        string oauth_ref "referencia al token cifrado (vault)"
        date   creada_en
    }

    ASSET {
        uuid   id PK
        string titulo
        string herramienta "higgsfield | elevenlabs | otra"
        string prompt_ref
        string tema
        int    duracion_seg
        string formato "9:16, 1:1..."
        string url_archivo
        date   generado_en
    }

    POST {
        uuid   id PK
        uuid   asset_id FK
        uuid   account_id FK
        string platform_post_id "id que devuelve la API"
        string url
        string estado "programado | publicado | fallido | eliminado"
        string via "api_directa | agregador | manual"
        datetime publicado_en
    }

    POST_METRICS_DAILY {
        uuid   post_id FK
        date   fecha
        bigint views
        bigint reach "alcance: cuentas unicas"
        int    likes
        int    comments
        int    shares
        int    saves
        float  avg_watch_time_seg
        float  completion_rate
        float  engagement_rate "calculada: interacciones / reach"
    }

    ACCOUNT_METRICS_DAILY {
        uuid   account_id FK
        date   fecha
        int    followers
        int    followers_ganados
        bigint reach_total
        int    profile_views
    }

    AUDIENCE_BREAKDOWN {
        uuid   id PK
        string scope "post | account"
        uuid   ref_id "post_id o account_id"
        date   fecha
        string dimension "edad | sexo | pais | ciudad | tipo_usuario"
        string valor "18-24 | F | CO | seguidor..."
        float  porcentaje
        bigint valor_absoluto "si la API lo da"
    }

    CAMPAIGN {
        uuid   id PK
        string cliente
        string tipo "referidos | pauta_marca | contenido_pago"
        float  tarifa
        date   inicio
        date   fin
    }
```

## Dimensiones de segmentación (las que pide el dashboard)

| Dimensión | Valores | Fuente por plataforma |
|---|---|---|
| **Red social** | tiktok, instagram, facebook, youtube | propia del post |
| **Geografía** | país (ISO-3166), ciudad donde exista | YT: por video · TikTok/IG: audiencia de cuenta |
| **Edad** | 13–17, 18–24, 25–34, 35–44, 45–54, 55+ | YT: por video · TikTok/IG: audiencia de cuenta |
| **Sexo** | F, M, no especificado | igual que edad |
| **Tipo de usuario** | seguidor / no seguidor (y ampliable: nuevo vs recurrente) | TikTok e IG lo dan por contenido (reach de seguidores vs no) |

La lista de dimensiones es abierta a propósito: `AUDIENCE_BREAKDOWN.dimension` es un string, así que agregar "dispositivo" o "fuente de tráfico" mañana no requiere migración, solo un valor nuevo.

## Métricas derivadas (se calculan, no se almacenan crudas)

- **Engagement rate** = (likes + comments + shares + saves) / reach
- **Tasa de finalización** = completions / views (donde la red la dé)
- **Crecimiento de seguidores** = Δ followers período vs período anterior
- **Alcance por seguidor** (eficiencia viral) = reach / followers de la cuenta
- **Score de video** (para ranking interno): combinación ponderada de reach, ER y completion — los pesos se calibran cuando haya data real.

## Pipeline de datos

```mermaid
flowchart LR
    A[Generación<br/>Higgsfield / ElevenLabs] --> B[Cola de publicación<br/>asset × cuentas destino]
    B --> C[Publicador<br/>API oficial o agregador]
    C --> D[(Base de datos<br/>posts)]
    E[Recolector diario<br/>cron por cuenta] --> F[(Métricas<br/>snapshots)]
    D --> E
    F --> G[Dashboard<br/>filtros: red · geo · edad · sexo · tipo]
```

1. **Generación**: el asset se produce y se registra con su metadata (tema, prompt, duración).
2. **Publicación**: por cada asset se decide en qué cuentas sale (no siempre en todas — contenido duplicado idéntico en muchas cuentas es señal de spam para las plataformas; ver investigación de políticas). El publicador llama la API correspondiente y guarda el `platform_post_id`.
3. **Recolección**: un job diario por cuenta pide métricas de cada post activo y de la cuenta, y las inserta como snapshot del día.
4. **Dashboard**: lee de los snapshots; todos los filtros operan sobre las mismas tablas.

## Almacenamiento sugerido para empezar

Con 5–100 cuentas y decenas de videos/semana el volumen es pequeño: **Postgres** (Supabase para ir rápido) sobra durante mucho tiempo. Los snapshots diarios de 100 cuentas × ~50 posts activos son ~5.000 filas/día — años de datos sin problema. No hace falta warehouse hasta mucho después.
