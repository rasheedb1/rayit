# CAM-2 · Crear campaña desde la cotización — el contrato con Cotizar

Escrito para: Rasheed, que llama a `createCampaignFromQuote()` desde
COT-4 (sprint 4), y quien revise el PR de CAM-2. Fecha: 22 de septiembre
de 2026. Rama `nicolas/CAM-2-campana-desde-cotizacion`, sobre
`nicolas/CAM-1-ficha-campana`.

---

## 0. Plan (escrito antes de tocar código)

### 0.1 Archivos

| Qué | Dónde |
|---|---|
| `createCampaignFromQuote()` y sus errores | `packages/db/src/queries/campanas.ts` (al final, sección «Desde la cotización») |
| Pruebas en Postgres embebido con una cotización insertada por la prueba | `packages/db/test/campanas.test.ts` (bloque nuevo) |
| Reglas puras: nombre por defecto, brief desde lo acordado, `brand_accounts` desde `socials`, línea base | `packages/core/src/campanas.ts` + `test/campanas.test.ts` |
| Exportación | ya sale por `packages/db/src/index.ts` (`export *`) |
| Estado de la historia | `apps/web/content/backlog.ts` (solo CAM-2) |
| Este contrato | `docs/propuestas/CAM-2.md` |

No toco nada de Cotizar ni de `deal`.

### 0.2 Decisiones

1. **Firma.** `createCampaignFromQuote(tx: WorkspaceTx, input: {
   quoteId: string; startsOn: string; endsOn: string; name?: string;
   trackingCode?: string }) → Promise<{ campaign: CampaignDetail;
   created: boolean }>`. Las fechas son obligatorias porque la cotización
   no las tiene: COT-4 las pide al aceptar. Se validan con
   `assertCampaignDates` de core (ISO real y `endsOn ≥ startsOn`) antes
   de tocar la base. El `tx` lo pasa Rasheed: aceptar la cotización y
   crear la campaña son UNA transacción, y si algo falla no queda ni lo
   uno ni lo otro. Descartado: abrir la transacción dentro (dos
   transacciones = una cotización aceptada sin campaña si la segunda
   falla).
2. **Qué copia y de dónde.** `workspace_id` por `current_workspace_id()`
   (nunca por parámetro); `company_id`, `creator_id`, `deal_id` y
   `quote_id` de la cotización; `name` = `input.name` o «<empresa> ·
   <descripción del primer ítem>» (o «<empresa> · <número de la
   cotización>» si no tiene ítems); `amount = quote.total` y `currency =
   quote.currency`, como string, sin aritmética; `status = 'planned'`;
   `brand_baseline_from = startsOn − 14` (`brandBaselineFrom` de core,
   sobre `'YYYY-MM-DD'`, sin `Date` local); `brand_accounts` desde
   `company.socials` con la forma `[{ platform_id, handle }]`
   (`brandAccountsFromSocials`, core); `utm = {}`; `tracking_code` solo
   si viene; `brief` con lo acordado en texto (`briefFromQuote`, core:
   métricas, cortes, derechos, exclusividad, plazo) para que la ficha lo
   muestre aunque la cotización cambie después. No toca `deal` (`won_at`
   lo pone Rasheed) ni crea factura.
   El seed 0003 guardaba `brand_accounts` como `[{ platform, handle }]`;
   tras la revisión se alineó a `[{ platform_id, handle }]` en esta rama
   (es mi archivo, `ON CONFLICT DO UPDATE`, `run-0003.mjs` en verde) para
   que la columna tenga UNA forma. Solo entran las llaves de `socials`
   que son redes del producto (`PLATFORM_IDS` en core: tiktok,
   instagram, facebook, youtube); `website`, `linkedin`… se ignoran.
3. **Reglas.** La cotización debe estar en `'accepted'`: la llamada va
   DESPUÉS del `UPDATE quote SET status = 'accepted'` en la misma
   transacción; si no, `QuoteNotAcceptedError`. Una cotización de otro
   workspace es «no encontrada» (RLS en `quote`): `QuoteNotFoundError`.
   Idempotente: bloqueo consultivo `pg_advisory_xact_lock(hashtext(
   'campaign-from-quote:' || quote_id))` (el mismo patrón de la
   numeración de FIN-1) y, dentro, si ya existe una campaña **no
   cancelada** con ese `quote_id` en el workspace, se devuelve con
   `created: false` sin tocar nada; dos aceptaciones concurrentes se
   serializan y la segunda ve la campaña de la primera. Tras la
   revisión, la garantía vive también en la base: **migración
   `0015_campaign_quote_unique.sql`**, índice único parcial sobre
   `campaign (quote_id) WHERE quote_id IS NOT NULL AND status <>
   'cancelled'` (precedente 0014; pasa `node db/migrate.mjs --pglite
   --seed` y `run-0003.mjs`; **la aplicas tú con `make db.migrate`**).
   Una campaña cancelada libera la cotización: si la marca vuelve a
   aceptar, se crea otra y la cancelada queda como historial.
   `InvalidDatesError` (core) para fechas inválidas; `InvalidNameError`
   si `name` viene en blanco (igual que `updateCampaign`: no cae al
   nombre por defecto sin avisar). Todos con `messageEs`. El orden es
   leer la cotización (RLS) → bloquear → buscar existente → insertar,
   para que una campaña ajena con ese `quote_id` nunca corte el camino.
4. **Qué devuelve.** El `CampaignDetail` de CAM-1 (con `agreed` leído de
   la cotización y `deliverables` desde `quote_item`), para que COT-4
   pueda redirigir a `/campanas/<id>` o mostrar el nombre sin otra
   consulta.

### 0.3 Dudas que resolví solo

- `quote.total` puede ser `0` en una cotización sin ítems: se copia tal
  cual (la ficha dirá «Sin monto acordado» solo si es null; con `0.00`
  mostrará COP 0, que es lo que dice la cotización). No se inventa.
- Sin `creator_id` en la campaña no hay problema: la columna admite
  null, pero la cotización siempre lo trae (NOT NULL en `quote`).

---

## 1. La firma

```ts
import { createCampaignFromQuote, QuoteNotFoundError, QuoteNotAcceptedError } from "@mc/db";
import { InvalidDatesError, type CampaignError } from "@mc/core";

/**
 * Crea la campaña de una cotización aceptada, dentro de la transacción
 * de quien llama. Devuelve la ficha completa (CampaignDetail de CAM-1) y
 * si la creó ahora o ya existía.
 */
export function createCampaignFromQuote(
  tx: WorkspaceTx,
  input: {
    quoteId: string;        // la cotización que acaba de pasar a 'accepted'
    startsOn: string;       // 'YYYY-MM-DD' · las pide COT-4 al aceptar
    endsOn: string;         // 'YYYY-MM-DD' · ≥ startsOn
    name?: string;          // por defecto «<empresa> · <primer entregable>»
    trackingCode?: string;  // 'LAURA15', opcional
  },
): Promise<{ campaign: CampaignDetail; created: boolean }>;
```

`WorkspaceTx` es la transacción con el workspace fijado que hoy da
`db.withWorkspace(workspaceId, fn)` (provisional, `packages/db`) y que
CIM-2 reemplazará con la misma forma.

## 2. Ejemplo de uso dentro de tu acción de aceptar (COT-4)

```ts
// apps/web/app/(app)/cotizar/[id]/actions.ts (tuyo)
"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { createCampaignFromQuote, type CampaignDetail } from "@mc/db";
import { CampaignError } from "@mc/core";
import { withWorkspace } from "@/lib/db";

export async function aceptarCotizacion(quoteId: string, startsOn: string, endsOn: string) {
  let result: { campaign: CampaignDetail; created: boolean };
  try {
    result = await withWorkspace(async (tx) => {
      // 1. La cotización pasa a aceptada (tu consulta, en queries/cotizar.ts).
      await tx.query("UPDATE quote SET status = 'accepted', accepted_at = now() WHERE id = $1 AND status IN ('sent', 'viewed')", [quoteId]);
      // 2. La campaña, DESPUÉS del UPDATE y en la misma transacción.
      const r = await createCampaignFromQuote(tx, { quoteId, startsOn, endsOn });
      // 3. El deal pasa a ganado (tuyo). Si esto lanza, se deshacen 1 y 2.
      await tx.query("UPDATE deal SET stage_id = 'ganado', won_at = now() WHERE id = (SELECT deal_id FROM quote WHERE id = $1)", [quoteId]);
      return r;
    });
  } catch (err) {
    // Todos los errores de campaña traen messageEs, listo para pantalla.
    const message = err instanceof CampaignError ? err.messageEs : "No se pudo aceptar la cotización.";
    redirect(`/cotizar/${quoteId}?error=${encodeURIComponent(message)}`);
  }
  // redirect() lanza: fuera del try para que el catch no lo trague.
  revalidatePath("/campanas");
  redirect(`/campanas/${result.campaign.id}${result.created ? "" : "?error=" + encodeURIComponent("Esta cotización ya tenía campaña.")}`);
}
```

La prueba `el flujo de COT-4 de punta a punta` en
`packages/db/test/campanas.test.ts` hace exactamente esto (con un fallo
simulado en el paso 3 para demostrar el rollback).

## 3. Errores

| Error | Cuándo | Qué mostrar (`messageEs`) |
|---|---|---|
| `InvalidDatesError` (core) | `startsOn`/`endsOn` no son fechas ISO reales o `endsOn < startsOn` | «La fecha de fin no puede ser anterior a la de inicio.» / «La fecha de inicio debe ser YYYY-MM-DD.» |
| `QuoteNotFoundError` | La cotización no existe **en este workspace** (RLS) o el id no es UUID | «La cotización … no existe en este workspace.» |
| `QuoteNotAcceptedError` (con `.status`) | La cotización no está en `accepted` (llamaste antes del UPDATE, o está en `sent`, `rejected`…) | «Solo una cotización aceptada crea campaña; esta está en «sent».» |
| `InvalidNameError` (core) | `name` viene definido pero en blanco | «La campaña necesita un nombre.» |

Todos extienden `CampaignError` (core): `code`, `messageEs` y el mismo
texto en `message`. No hay otros errores esperables; un fallo de base
llega como `Error` de node-postgres y se muestra genérico.

## 4. Garantías y lo que NO hace

- **Atomicidad.** Corre en tu `tx`. Si tu acción lanza después, la
  campaña se deshace con la cotización.
- **Idempotencia.** Con el mismo `quoteId` devuelve la campaña existente
  (no cancelada) y `created: false`, sin tocar nombre ni fechas. Dos
  llamadas concurrentes se serializan con `pg_advisory_xact_lock(
  hashtext('campaign-from-quote:' || quote_id))` (el mismo patrón que
  la numeración de facturas de FIN-1): una crea y la otra ve la creada.
  Y aunque alguien escriba `campaign` sin pasar por aquí, el índice
  único parcial de 0015 no deja dos campañas activas por cotización.
  Reintentar tu acción es seguro. Si la creadora cancela la campaña y la
  marca vuelve a aceptar, se crea una nueva.
- **RLS.** Nunca recibe `workspace_id`: la cotización se lee bajo la
  política de `quote` y la campaña se inserta con
  `current_workspace_id()`.
- **Sin aritmética de dinero.** `amount = quote.total` y `currency =
  quote.currency` como string.
- **Qué deja:** `status 'planned'`, `brand_baseline_from = startsOn −
  14`, `brand_accounts = [{ platform_id, handle }]` desde
  `company.socials`, `brief` con lo acordado en texto, `utm = {}`,
  `tracking_url = null`.
- **NO** toca `deal` (`won_at` es tuyo), **NO** crea factura (eso lo
  hace «Facturar» en la ficha, FIN-1), **NO** valida que la cotización
  tenga ítems (sin ítems el nombre usa el número de la cotización y el
  monto es `quote.total`, aunque sea 0).

## 5. Cómo lo probamos juntos el lunes del sprint 4

1. En tu rama, con la base embebida (sin `DATABASE_URL`):
   ```bash
   cd platform && pnpm --filter @mc/db test   # 36 pruebas, 9 de CAM-2
   ```
2. En Supabase, después de aceptar una cotización real desde tu pantalla:
   ```bash
   make db.sql Q="select c.id, c.name, c.status, c.starts_on, c.brand_baseline_from, c.brand_accounts, c.amount, c.currency, q.number
                  from campaign c join quote q on q.id = c.quote_id
                  where q.status = 'accepted' order by c.created_at desc limit 5"
   ```
   Debe salir una fila por cotización aceptada, en `planned`, con
   `brand_baseline_from = starts_on − 14` y `amount = quote.total`.
3. Aceptar la misma cotización dos veces (o pulsar dos veces el botón)
   deja **una** campaña: `select quote_id, count(*) from campaign group
   by 1 having count(*) > 1` no devuelve filas.
4. Abrir `/campanas`: la campaña aparece en «Planeada» y su ficha muestra
   «Acordado antes de publicar» desde tu cotización.

## 6. Pendiente de ti

- [ ] COT-4: pedir `startsOn` y `endsOn` al aceptar, y llamar después
      del `UPDATE` de `quote.status`, en la misma transacción.
- [ ] CIM-2: cuando `WorkspaceTx` sea el de Drizzle, si expone
      `tx.execute` o `tx.query(text, params)` esta función sigue igual.
- [ ] Aplicar `db/migrations/0015_campaign_quote_unique.sql` en
      Supabase (`make db.migrate`). Sin ella la función sigue siendo
      idempotente para quien la llame; con ella lo es para todos.

## 7. Verificación

- `pnpm --filter @mc/core test`: 36 pruebas (3 nuevas: cuentas de la
  marca, nombre por defecto, brief desde lo acordado).
- `pnpm --filter @mc/db test`: 36 (9 de CAM-2): crea con los campos
  esperados; aparece en la lista y la ficha lee lo acordado y los
  entregables desde la cotización; segunda llamada → misma campaña,
  `created false`, sin pisar nombre ni fechas; `Promise.all` de dos →
  una sola; `sent` → `QuoteNotAcceptedError` y nada creado; otro
  workspace o id inexistente → `QuoteNotFoundError`; fechas inválidas →
  `InvalidDatesError`; nombre en blanco → `InvalidNameError`; una
  campaña cancelada libera la cotización y el índice de 0015 rechaza un
  INSERT duplicado a mano; el flujo de COT-4 con rollback y luego
  completo. `node db/migrate.mjs --pglite --seed` (15 migraciones) y
  `node db/seed/verify/run-0003.mjs` en verde con la migración y el seed
  alineado.
  Nota: pglite serializa las transacciones, así que la concurrencia real
  del bloqueo consultivo se ejercita con `TEST_DATABASE_URL` contra un
  Postgres de verdad (el mismo aviso de FIN-1).
- Sin pantalla nueva: `typecheck` y `lint` de la web siguen en verde con
  el estado de la historia en `backlog.ts`.

## 8. Revisión (/code-review, nivel alto)

Diez hallazgos, todos resueltos en el commit «Revisión»:

| Hallazgo | Qué se hizo |
|---|---|
| La idempotencia dependía solo del bloqueo y de un SELECT | Migración 0015: índice único parcial sobre `campaign (quote_id)` salvo canceladas |
| `brand_accounts` tomaba cualquier llave de `socials` | Solo redes del producto (`PLATFORM_IDS`); `website`, `linkedin`… fuera |
| Dos formas de `brand_accounts` (seed vs. función) | Seed 0003 alineado a `platform_id` |
| Una campaña cancelada bloqueaba crear otra | Canceladas fuera de la búsqueda y del índice |
| Bloqueo y búsqueda antes de verificar la cotización bajo RLS | Orden: cotización → bloqueo → existente → insertar |
| `cutHoursLabel` redondeaba 60 h a «3 días» | Solo días exactos; si no, horas. La ficha usa la misma función |
| Cuarta copia de `UUID_RE` | `isUuid`/`UUID_RE` exportados desde `provisional/client.ts` |
| Dos normalizadores de handle | `handlesFromSocials` sale de `brandAccountsFromSocials` |
| `?? []` sobre columnas NOT NULL | Quitado |
| Nombre en blanco caía al nombre por defecto | `InvalidNameError`, el mismo criterio que `updateCampaign` |
