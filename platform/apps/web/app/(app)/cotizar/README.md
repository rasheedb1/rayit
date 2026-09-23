# Cotizar (COT-1 … COT-4)

Tarifario, media kit público y cotización con enlace y aceptación. Es la
puerta entre Ventas y Campañas: una cotización nace de un negocio y, al
aceptarse, deja una campaña planeada.

## Mapa

| Ruta | Qué es |
|---|---|
| `/cotizar` | Tarifario (COT-1): rango por entregable, paquetes y «Cómo se calcula» |
| `/cotizar/media-kit` | Media kits generados y su enlace (COT-2) |
| `/cotizar/media-kit/<id>` | Vista previa del media kit, **sin contar visita** |
| `/cotizar/cotizaciones` | Lista (COT-3), con el estado de hoy |
| `/cotizar/cotizaciones/nueva` | Nueva cotización. Acepta `?negocio=<id>` para llegar desde la ficha del negocio |
| `/cotizar/cotizaciones/<id>` | Detalle: historia con fechas, enviar, aceptar, rechazar, campaña |
| `/cotizar/cotizaciones/<id>/editar` | Editar un borrador sin gastar otro número |
| `/cotizar/cotizaciones/<id>/vista` | Vista previa del documento, **sin marcarlo como visto** |
| `/kit/<slug>` | Media kit **público**, sin sesión |
| `/cotizacion/<slug>` | Cotización **pública**, con «Aceptar cotización» y firma (COT-4) |

| Archivo | Qué hace |
|---|---|
| `messages.ts` | **Todo** el texto de interfaz del módulo, incluidas las páginas públicas y los errores |
| `_lib/tarifario.ts` | Qué entregables se ofrecen, qué le falta a cada fila, paquetes y el desglose en palabras |
| `_lib/acordado.ts` | «Lo acordado» y la etiqueta del impuesto con su tasa, iguales en los tres sitios |
| `_lib/robots.ts` | Los robots de chat que desenrollan enlaces: no cuentan como visita |
| `_lib/limite.ts` | El freno de intentos de contraseña en memoria |
| `_ui/documento-cotizacion.tsx` | La cotización como documento: la página pública y la vista previa son el mismo componente |
| `_ui/media-kit-vista.tsx` | El media kit, igual en `/kit/<slug>` y en la vista previa |
| `_ui/resumen-totales.tsx` | Subtotal, descuento, impuesto y total |
| `actions.ts` | Las Server Actions del panel |
| `../(public)/actions.ts` | Las dos acciones sin sesión: contraseña del kit y aceptar |
| `../../lib/db/index.ts` | `withPublicShare` y `acceptQuoteFromLink` |
| `packages/core/src/tarifas.ts` | La fórmula, los paquetes y la unidad de precio. Pura, sin idioma y sin base |
| `packages/core/src/zonas.ts` | El fin de un día en la zona del workspace |
| `packages/db/src/queries/cotizar.ts` | Las consultas, todas con `WorkspaceTx` salvo las tres públicas |
| `db/migrations/0022_public_share.sql` | Las columnas, funciones y políticas del enlace público |
| `db/migrations/0023_public_share_owner.sql` | El rol `mc_public_share` y las funciones recreadas |

## Las cuatro decisiones que explican el resto

**1 · El rango se calcula en los dos lados con la misma función.**
`calcularItem()` de `@mc/core` corre en el navegador mientras el creador
mueve las views o el CPM y corre otra vez en el servidor al guardar. El
servidor no confía en los precios que llegan del formulario: recalcula y
solo respeta los que el creador fijó a mano, que se guardan con
`overridden = true`. Un precio guardado siempre se puede explicar. En
pesos (y en las monedas de `MONEDAS_SIN_CENTAVOS`) cada paso se redondea
al peso: un tarifario con centavos parece un prototipo.

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
`public_quote_accept()`, que son **de `mc_public_share`** (0023): un rol
sin login, sin BYPASSRLS y con privilegios de columna (sumar una visita,
marcar vista o aceptada, pasar el deal a «Ganado»; nada más). Las
políticas del enlace son `TO mc_public_share`: para `mc_app`, fijar a
mano `app.public_share` no abre nada. La prueba «la sonda» de
`packages/db/test/cotizar.test.ts` lo fija. La contraseña opcional se
compara por su derivado (scrypt con sal por fila, comparado por su
sha256); en claro no llega nunca a la base.

**4 · Mirar no es visitar.**
El estado `viewed` dice «la marca la abrió»: si lo marca el propio
creador, o el robot de WhatsApp al desenrollar el enlace, deja de decir
nada. Por eso el panel tiene sus vistas previas (con `withWorkspace`, sin
pasar por las funciones públicas) y las páginas públicas llaman con
`p_count = false` cuando el User-Agent es de un robot de chat conocido.

## El contrato con Campañas (COT-4 · D5)

Aceptar una cotización **no** inserta en `campaign`. La campaña la crea
`createCampaignFromQuote()` de `packages/db/src/queries/campanas.ts`
(CAM-2, de Nicolás), y Cotizar la llama a través de un único envoltorio:

```ts
// packages/db/src/queries/cotizar.ts
createCampaignForQuote(tx, quoteId, { startsOn?, endsOn? })
  → { campaignId, campaignName, created }
```

Firma de CAM-2, tal como se usa:

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
se acuerdan **antes** de enviar la cotización, así que al aceptar no hay
nada que preguntar. Aceptar deja la campaña en `planned` **sin un
segundo clic**, por los dos caminos:

- **Desde el panel** («Marcar aceptada»): `acceptQuoteAndCreateCampaign`
  acepta, gana el negocio y llama a CAM-2 en **la misma transacción**. La
  llamada a CAM-2 va dentro de un `SAVEPOINT`: si la rechaza (sin ventana
  acordada, `FechasDeCampanaFaltan`), se deshace solo esa parte, la
  aceptación queda y el detalle dice «Campaña: pendiente de Campañas» y
  por qué.
- **Desde el enlace público**: `lib/db · acceptQuoteFromLink` hace dos
  transacciones. En la primera, sin workspace, `public_quote_accept()`
  acepta con la firma (nombre, correo) y gana el negocio, y devuelve el
  `workspaceId` de esa cotización — un dato que lee la base a partir del
  slug, nunca uno que mande el navegador. En la segunda, con ese
  workspace fijado por el cliente de base, `completePublicAcceptance`
  deja la actividad en el negocio, el aviso para el creador
  (`notification.kind = 'quote_accepted'`) y la campaña de CAM-2. Si la
  segunda falla, la aceptación ya está hecha y el detalle ofrece «Crear
  la campaña»: CAM-2 es idempotente por `quote_id`.

## Cosas que rompen si no las sabes

- **Las migraciones 0022 y 0023 no están aplicadas en Supabase.** Las
  aplica el integrador con `make db.migrate`, las dos juntas. **0023
  necesita antes el rol**, que `mc_migrator` no puede crear:

  ```bash
  ./scripts/supabase-admin.sh sql "CREATE ROLE mc_public_share NOLOGIN NOINHERIT; GRANT mc_public_share TO mc_migrator; GRANT USAGE, CREATE ON SCHEMA public TO mc_public_share"
  ```

  Sin eso, la migración se detiene con ese mismo comando en el mensaje.
  En PGlite (`make db.check`, pruebas) y en el Postgres del CI no hace
  falta: allí corre como superusuario o el embebido crea el rol antes.
- **El marco se movió una línea.** `Shell` estaba en `app/layout.tsx` y
  ahora se monta en `app/(app)/layout.tsx`, para que `app/(public)/`
  pueda servirse sin la navegación del creador.
- **`/kit` (sin slug) es la galería del kit de interfaz** de Nicolás
  (CIM-5), dentro de `(app)`: la protege la sesión de CIM-3 como a
  cualquier pantalla del panel. `/kit/<slug>` es otra ruta, la pública.
- **Las historias no se miden.** No hay línea base de historias, así que
  sus views las escribe el creador y quedan marcadas como manuales
  (dependencia D4). La línea base con menos de ocho videos tampoco entra
  sola: se sugiere y el creador la confirma.
- **El tarifario es una bitácora.** Guardar no actualiza: crea una
  versión nueva y baja la anterior. Un precio ya citado en una
  cotización tiene que seguir siendo consultable.
- **El impuesto por defecto sale del workspace**: `settings.taxRate` si
  existe; si no, el IVA general cuando el workspace es de Colombia, y 0
  en cualquier otro país.
- **Ninguna pantalla formatea a mano.** Moneda, locale y zona salen del
  workspace (`lib/workspace/settings.ts`) y pasan por `lib/format.ts`.
- **`?error=` lleva un código, nunca texto.** El texto sale de
  `MESSAGES.errores`; un código desconocido se enseña como el genérico.
