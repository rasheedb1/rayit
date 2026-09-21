# MultiCampaign

Operación de contenido multi-cuenta: generar video corto con IA (Higgsfield, ElevenLabs), publicarlo por API en TikTok, Instagram, Facebook y YouTube desde una red propia de cuentas (5 → 50–100), y medir alcance/engagement segmentado por red, geografía, edad, sexo y tipo de usuario para luego monetizar con campañas de marcas y referidos.

## Estado (18 ago 2026)

- ✅ **Investigación de APIs** completada y verificada — [docs/investigacion-apis.md](docs/investigacion-apis.md)
- ✅ **Esquema de datos** diseñado — [docs/esquema-datos.md](docs/esquema-datos.md)
- ✅ **Mock del dashboard** con datos simulados — [dashboard/mock.html](dashboard/mock.html) (publicado como Artifact; filtros funcionales por período, red, país, edad, sexo y tipo de usuario, con modo claro/oscuro y vista de tabla por gráfico)
- ✅ **Manual de producción de miniclips de historia** — [docs/miniclips-historia.html](docs/miniclips-historia.html) (estructura de 9 bloques, pipeline con Higgsfield/ElevenLabs, guiones completos verificados y referentes del nicho)
- ⬜ Registrar apps de desarrollador (Meta, TikTok, Google) e iniciar auditorías
- ⬜ Crear las 5 cuentas iniciales (nichos temáticos diferenciados)
- ⬜ Pipeline de publicación (asset → cola → API)
- ⬜ Recolector diario de métricas → Postgres
- ⬜ Conectar el dashboard a data real

## Los 3 hallazgos que definen el plan

1. **Publicar por API es oficial en las 4 plataformas**, pero TikTok y YouTube exigen **auditoría de la app** antes de que los posts salgan públicos → iniciar esos trámites es lo primero. Mientras tanto, la integración TikTok de Higgsfield (ya auditada) sirve para las primeras cuentas.
2. **Demografía edad/sexo por video solo existe en YouTube** (y parcialmente en Facebook). TikTok e Instagram la dan por cuenta. El esquema y el dashboard ya lo modelan así.
3. **El riesgo real no es tener muchas cuentas, es el contenido idéntico duplicado** (políticas de comportamiento inauténtico y de monetización "inauthentic content"). La operación debe producir variantes por cuenta/nicho, no clones, y etiquetar el contenido IA realista.

## Estructura

```
docs/investigacion-apis.md   Qué permite cada API, límites verificados, agregadores, políticas
docs/esquema-datos.md        Modelo de datos (ERD), dimensiones, pipeline
dashboard/mock.html          Mock interactivo del dashboard (datos simulados deterministas)
docs/proyecto-influencers.md Cuaderno vivo del proyecto hermano: crecimiento y monetización de influencers y agencias
dashboard/creadores-mock.html Mock del producto para creadores y agencias (9 módulos; publicado como Artifact)
dashboard/local/            Versión local del mock con diseño minimal (Vercel/Notion): index.html + styles.css + app.js
dashboard/build-local.py    Regenera dashboard/local a partir del mock del Artifact
dashboard/direcciones-visuales.html Exploración de dirección visual: referentes, tres direcciones, recomendación (Artifact)
dashboard/local/theme-*.css  Direcciones Signal y Studio (styles.css es Geist); se cambian con el selector de la barra
platform/                   El producto real: esquema, migraciones, pipeline y CI
platform/apps/web/          El dashboard real (Next.js). Publicado en https://multicampaign-web.vercel.app
docs/arquitectura.md        Decisiones de arquitectura y por qué
docs/plan-equipo.md         Reparto de tareas para dos programadores, seis semanas
docs/backlog-mvp.md         Backlog del MVP (Resumen, Ventas/CRM, Cotizar, Campañas, Finanzas) repartido entre Nicolás y Rasheed
docs/research/              Investigación verificada: campos de TikTok, análisis de video
```
