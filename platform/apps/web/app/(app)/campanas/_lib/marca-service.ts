/**
 * «Actualizar ahora» de la sección «Seguidores de la marca» (CAM-3), como
 * servicio puro para probarlo sin Next (el molde es cuentas-service.ts de
 * Conexiones).
 *
 * Lee la fuente pública de cada cuenta de la marca en el momento y deja
 * la fila del día con recordBrandSnapshot, la MISMA función que usa el
 * job brand.snapshot: ON CONFLICT DO NOTHING, la primera lectura del día
 * queda. Las llamadas HTTP van primero, fuera de la transacción; después,
 * una sola transacción de workspace escribe las filas y la bitácora
 * (api_call_log).
 */
import {
  createPublicProfileSources, HttpCore, InMemoryCallLogSink, isPlatformId, PostgresCallLogSink, PublicLookupError, QuotaManager,
  type FetchLike, type PublicProfileSources,
} from "@mc/connectors";
import {
  brandAccountsOf, BRAND_SNAPSHOT_STATUSES, getCampaign, recordBrandSnapshot, type BrandNoDataReason, type BrandSnapshotInput,
  type BrandSnapshotOutcome, type WorkspaceTx,
} from "@mc/db";
import { isPlatformId as esRedConNombre, PLATFORM_LABEL } from "@/components/ui/platform-pill";
import { MESSAGES } from "./messages";

const t = MESSAGES.seguidores;

export interface MarcaDeps {
  env: Readonly<Record<string, string | undefined>>;
  withWorkspace: <T>(fn: (tx: WorkspaceTx) => Promise<T>) => Promise<T>;
  fetch?: FetchLike;
  now?: () => Date;
  /** Fuentes ya construidas (pruebas); por defecto las oficiales sobre un HttpCore propio. */
  sources?: (core: HttpCore) => PublicProfileSources;
}

export type ActualizarMarcaResult =
  | {
      ok: true;
      /** guardada: al menos una fila nueva hoy. ya_hoy: ya había lectura de hoy en todas. */
      resultado: "guardada" | "ya_hoy";
      /**
       * Lo que no dejó fila (fuente sin configurar, fallo transitorio, red
       * sin fuente), en español. Una cuenta que no existe o no se puede leer
       * sí deja su fila con la razón, y la sección la explica sola.
       */
      avisos: string[];
    }
  | { ok: false; code: "no_existe" | "sin_cuentas" | "cerrada" | "sin_permiso_base" | "lectura"; message: string };

type Fila = Omit<BrandSnapshotInput, "campaignId" | "companyId" | "day">;

/** Postgres rechazó el INSERT por privilegio (42501): la base aún no tiene 0034. */
function esSinPrivilegio(err: unknown): boolean {
  for (let e: unknown = err; e && typeof e === "object"; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "42501") return true;
  }
  return false;
}

export function createMarcaService(deps: MarcaDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    async actualizar(campaignId: string): Promise<ActualizarMarcaResult> {
      const campaign = await deps.withWorkspace((tx) => getCampaign(tx, campaignId));
      if (!campaign) return { ok: false, code: "no_existe", message: t.errores.no_existe };
      if (!BRAND_SNAPSHOT_STATUSES.includes(campaign.status)) return { ok: false, code: "cerrada", message: t.errores.cerrada };
      const cuentas = brandAccountsOf(campaign.brandAccounts);
      if (cuentas.length === 0) return { ok: false, code: "sin_cuentas", message: t.errores.sin_cuentas };

      const callLog = new InMemoryCallLogSink();
      const core = new HttpCore({ callLog, fetch: deps.fetch, now, quota: new QuotaManager({ now }) });
      const sources = deps.sources ? deps.sources(core) : createPublicProfileSources(core, deps.env);
      const day = now().toISOString().slice(0, 10);

      const filas: Fila[] = [];
      const avisos: string[] = [];
      for (const c of cuentas) {
        const red = esRedConNombre(c.platform_id) ? PLATFORM_LABEL[c.platform_id] : c.platform_id;
        const sinCifra = (source: BrandNoDataReason): Fila => ({ platformId: c.platform_id, handle: c.handle, externalAccountId: null, followers: null, mediaCount: null, source });
        if (c.platform_id === "tiktok") {
          filas.push(sinCifra("no_public_source"));
          continue;
        }
        const source = isPlatformId(c.platform_id) ? sources[c.platform_id] : undefined;
        if (!source) {
          avisos.push(t.sinFuente(red));
          continue;
        }
        try {
          const p = await source.lookup(c.handle);
          filas.push({
            platformId: c.platform_id, handle: p.profile.handle ?? c.handle, externalAccountId: p.profile.external_account_id,
            followers: p.metrics?.followers ?? null, mediaCount: p.metrics?.mediaCount ?? null, source: p.metrics ? p.source : "no_public_source",
          });
        } catch (err) {
          if (!(err instanceof PublicLookupError)) throw err;
          if (err.code === "not_found" || err.code === "invalid_handle") {
            filas.push(sinCifra("not_found"));
          } else if (err.code === "not_discoverable") {
            filas.push(sinCifra("not_discoverable"));
          } else {
            // not_configured o transitorio: sin fila; la frase de la fuente dice qué pasó.
            avisos.push(err.messageEs);
          }
        }
      }

      let resultados: BrandSnapshotOutcome[];
      try {
        resultados = await deps.withWorkspace(async (tx) => {
          const out: BrandSnapshotOutcome[] = [];
          for (const f of filas) out.push(await recordBrandSnapshot(tx, { ...f, campaignId, companyId: campaign.companyId, day }));
          const sink = new PostgresCallLogSink(tx);
          for (const e of callLog.entries) await sink.record(e);
          return out;
        });
      } catch (err) {
        if (esSinPrivilegio(err)) return { ok: false, code: "sin_permiso_base", message: t.errores.sin_permiso_base };
        throw err;
      }

      if (resultados.includes("guardada")) return { ok: true, resultado: "guardada", avisos };
      if (resultados.length > 0) return { ok: true, resultado: "ya_hoy", avisos };
      return { ok: false, code: "lectura", message: avisos[0] ?? t.errores.generico };
    },
  };
}

export type MarcaService = ReturnType<typeof createMarcaService>;
