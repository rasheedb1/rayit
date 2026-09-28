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
  brandAccountsOf, brandNoDataReasonFor, BRAND_PLATFORMS_WITHOUT_FOLLOWER_SOURCE, brandPlatformsReadOn, BRAND_SNAPSHOT_STATUSES, getCampaign,
  recordBrandSnapshot, type BrandNoDataReason, type BrandSnapshotInput, type BrandSnapshotOutcome, type WorkspaceTx,
} from "@mc/db";

export interface MarcaDeps {
  env: Readonly<Record<string, string | undefined>>;
  withWorkspace: <T>(fn: (tx: WorkspaceTx) => Promise<T>) => Promise<T>;
  fetch?: FetchLike;
  now?: () => Date;
  /** Fuentes ya construidas (pruebas); por defecto las oficiales sobre un HttpCore propio. */
  sources?: (core: HttpCore) => PublicProfileSources;
}

/**
 * Lo que no dejó fila, por red. Son códigos y no frases: la acción los
 * pasa por la URL y la página los traduce con messages.ts, así que nadie
 * puede escribir un aviso a mano en un enlace, y el nombre de una
 * variable del servidor no llega a la pantalla.
 *   sin_credencial  la fuente de esa red no está configurada (not_configured)
 *   transitorio     la plataforma no respondió; se puede volver a intentar
 *   sin_fuente      la red no tiene fuente pública en esta versión (Facebook)
 */
export const AVISO_CODES = ["sin_credencial", "transitorio", "sin_fuente"] as const;
export type AvisoCode = (typeof AVISO_CODES)[number];
export interface AvisoMarca {
  code: AvisoCode;
  platformId: string;
}

export const ERROR_CODES = ["no_existe", "sin_cuentas", "cerrada", "sin_permiso_base", "lectura"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type ActualizarMarcaResult =
  | {
      ok: true;
      /** guardada: al menos una fila nueva hoy. ya_hoy: todas las redes ya tenían su lectura de hoy. */
      resultado: "guardada" | "ya_hoy";
      /**
       * Lo que no dejó fila. Una cuenta que no existe o no se puede leer
       * sí deja su fila con la razón, y la sección la explica sola.
       */
      avisos: AvisoMarca[];
    }
  | { ok: false; code: ErrorCode; avisos: AvisoMarca[] };

type Fila = Omit<BrandSnapshotInput, "campaignId" | "companyId" | "day">;

/** Postgres rechazó el INSERT por privilegio (42501): la base aún no tiene 0035. */
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
      const day = now().toISOString().slice(0, 10);
      const leida = await deps.withWorkspace(async (tx) => {
        const campaign = await getCampaign(tx, campaignId);
        return campaign ? { campaign, yaLeidas: await brandPlatformsReadOn(tx, campaignId, day) } : null;
      });
      if (!leida) return { ok: false, code: "no_existe", avisos: [] };
      const { campaign, yaLeidas } = leida;
      if (!BRAND_SNAPSHOT_STATUSES.includes(campaign.status)) return { ok: false, code: "cerrada", avisos: [] };
      const cuentas = brandAccountsOf(campaign.brandAccounts);
      if (cuentas.length === 0) return { ok: false, code: "sin_cuentas", avisos: [] };

      // Cuota en memoria, por petición, como «Actualizar» de Conexiones (cuentas-service.ts).
      const callLog = new InMemoryCallLogSink();
      const core = new HttpCore({ callLog, fetch: deps.fetch, now, quota: new QuotaManager({ now }) });
      const sources = deps.sources ? deps.sources(core) : createPublicProfileSources(core, deps.env);

      const filas: Fila[] = [];
      const avisos: AvisoMarca[] = [];
      let yaHoy = 0;
      for (const c of cuentas) {
        const sinCifra = (source: BrandNoDataReason): Fila => ({ platformId: c.platform_id, handle: c.handle, externalAccountId: null, followers: null, mediaCount: null, source });
        // Ya hay cifra de hoy: la fila no entraría (ON CONFLICT DO NOTHING) y la llamada gastaría cuota de la casa.
        if (yaLeidas.includes(c.platform_id)) { yaHoy++; continue; }
        if (BRAND_PLATFORMS_WITHOUT_FOLLOWER_SOURCE.includes(c.platform_id)) {
          filas.push(sinCifra("no_public_source"));
          continue;
        }
        const source = isPlatformId(c.platform_id) ? sources[c.platform_id] : undefined;
        if (!source) {
          avisos.push({ code: "sin_fuente", platformId: c.platform_id });
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
          const reason = brandNoDataReasonFor(err.code);
          if (reason) filas.push(sinCifra(reason));
          else avisos.push({ code: err.code === "not_configured" ? "sin_credencial" : "transitorio", platformId: c.platform_id });
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
        if (esSinPrivilegio(err)) return { ok: false, code: "sin_permiso_base", avisos };
        throw err;
      }

      if (resultados.includes("guardada")) return { ok: true, resultado: "guardada", avisos };
      if (resultados.length > 0 || yaHoy > 0) return { ok: true, resultado: "ya_hoy", avisos };
      return { ok: false, code: "lectura", avisos };
    },
  };
}

export type MarcaService = ReturnType<typeof createMarcaService>;
