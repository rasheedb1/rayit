# Cotizar (COT-1 … COT-4)

Tarifario, media kit público y cotización con enlace y aceptación. Es la
puerta entre Ventas y Campañas: una cotización nace de un negocio y, al
aceptarse, deja una campaña planeada.

## Mapa

| Ruta | Qué es |
|---|---|
| `/cotizar` | Tarifario (COT-1): rango por entregable y «Cómo se calcula» |
| `/cotizar/media-kit` | Media kits generados y su enlace (COT-2) |
| `/cotizar/cotizaciones` | Lista, detalle y creación (COT-3) |
| `/kit/<slug>` | Media kit **público**, sin sesión |
| `/cotizacion/<slug>` | Cotización **pública**, con «Aceptar cotización» (COT-4) |

| Archivo | Qué hace |
|---|---|
| `messages.ts` | **Todo** el texto de interfaz del módulo, incluidas las páginas públicas |
| `_lib/tarifario.ts` | Qué entregables se ofrecen y cómo se lee el desglose |
| `_lib/estado.ts` | La pastilla de cada estado de la cotización |
| `actions.ts` | Las Server Actions del panel |
| `../(public)/actions.ts` | Las dos acciones sin sesión: contraseña del kit y aceptar |
| `packages/core/src/tarifas.ts` | La fórmula. Pura, sin idioma y sin base |
| `packages/db/src/queries/cotizar.ts` | Las consultas, todas con `WorkspaceTx` |
| `db/migrations/0022_public_share.sql` | Las funciones y políticas del enlace público |

## Las tres decisiones que explican el resto

**1 · El rango se calcula en los dos lados con la misma función.**
`calcularItem()` de `@mc/core` corre en el navegador mientras el creador
mueve las views y corre otra vez en el servidor al guardar. El servidor
no confía en los precios que llegan del formulario: recalcula y solo
respeta los que el creador fijó a mano, que se guardan con
`overridden = true`. Un precio guardado siempre se puede explicar.

**2 · Lo que se comparte se congela.**
El media kit guarda `media_kit.snapshot` y la cotización guarda
`quote.public_snapshot` al enviarla. Editar después no cambia un
documento ya entregado, y la página pública no necesita leer
`quote_item`, `company` ni `creator_profile` en vivo. Las views, la
moneda, el locale y la zona del workspace viajan dentro del snapshot:
la página pública no tiene workspace que consultar.

**3 · El enlace es la credencial, y la base es quien la valida.**
`/kit/<slug>` y `/cotizacion/<slug>` se abren sin sesión. No consultan
tablas: llaman a `public_media_kit()`, `public_quote()` y
`public_quote_accept()` (migración 0022), que corren como el dueño del
esquema, acotan el permiso al slug de la llamada y lo devuelven al
salir. La contraseña opcional se compara por su derivado (scrypt con sal
por fila); en claro no llega nunca a la base.

## El contrato con Campañas (COT-4 · D5)

Aceptar una cotización **no** inserta en `campaign`. La campaña la crea
`createCampaignFromQuote()` de `packages/db/src/queries/campanas.ts`
(CAM-2, de Nicolás), y Cotizar la llama a través de un único envoltorio:

```ts
// packages/db/src/queries/cotizar.ts
createCampaignForQuote(tx, quoteId, { startsOn?, endsOn? })
  → { campaignId, campaignName, created }
```

Firma esperada de CAM-2, tal como se usa:

```ts
createCampaignFromQuote(tx: WorkspaceTx, {
  quoteId: string;
  startsOn: string;   // 'YYYY-MM-DD'
  endsOn: string;     // 'YYYY-MM-DD', ≥ startsOn
  name?: string;
  trackingCode?: string;
}): Promise<{ campaign: CampaignDetail; created: boolean }>
```

Las fechas salen de `quote.campaign_starts_on` / `campaign_ends_on`, que
se acuerdan **antes** de enviar la cotización (columnas de la migración
0022), así que al aceptar no hay nada que preguntar. Sin esa ventana
acordada, `createCampaignForQuote` lanza `FechasDeCampanaFaltan` en vez
de inventar fechas.

Por qué son dos pasos y no uno:

- **Desde el panel** («Marcar aceptada») el creador tiene workspace, así
  que `acceptQuote` y la creación de la campaña pueden ir en la misma
  transacción.
- **Desde el enlace público** quien acepta es la marca, sin sesión:
  `public_quote_accept()` deja la cotización aceptada y el negocio en
  «Ganado» —eso sí es atómico—, pero `createCampaignFromQuote()` es
  TypeScript y necesita el workspace del creador. Por eso la respuesta
  trae `campaignPending: true`, el detalle muestra **«Campaña: pendiente
  de Campañas»** y el creador la crea con un clic. Como CAM-2 es
  idempotente por `quote_id` (índice único parcial de 0016), repetir la
  llamada no duplica nada.

## Cosas que rompen si no las sabes

- **La migración 0022 no está aplicada en Supabase.** La aplica el
  integrador con `make db.migrate`. Verificada con `make db.check`.
- **El marco se movió una línea.** `Shell` estaba en `app/layout.tsx` y
  ahora se monta en `app/(app)/layout.tsx`, para que `app/(public)/`
  pueda servirse sin la navegación del creador. Es el único cambio en el
  marco de CIM-4.
- **Las historias no se miden.** No hay línea base de historias, así que
  sus views las escribe el creador y quedan marcadas como manuales
  (dependencia D4). Es a propósito: es más honesto que inventar un
  porcentaje sobre las views de un Reel.
- **El tarifario es una bitácora.** Guardar no actualiza: crea una
  versión nueva y baja la anterior. Un precio ya citado en una
  cotización tiene que seguir siendo consultable.
- **Ninguna pantalla formatea a mano.** Moneda, locale y zona salen del
  workspace (`lib/workspace/settings.ts`) y pasan por `lib/format.ts`.
