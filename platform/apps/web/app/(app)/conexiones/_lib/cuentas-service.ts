/**
 * Cuentas por @ con datos públicos (CON-10), como servicio puro para
 * poder probarlo sin Next: agregar, actualizar y quitar una cuenta, y
 * qué fuentes están disponibles en este entorno.
 *
 * Una lectura pública es: fuente oficial → (identidad, métricas o null)
 * → UNA transacción de workspace: alta o reactivación en
 * social_connection (access_mode 'public_profile'), data_consent con la
 * declaración de propiedad y, si hay cifras, el snapshot del día. Las
 * llamadas HTTP quedan en api_call_log con la fila.
 */
import {
  createPublicProfileSources, HttpCore, InMemoryCallLogSink, isPlatformId, PostgresCallLogSink, PublicLookupError, QuotaManager, redactSecrets,
  type FetchLike, type PlatformId, type PublicProfile, type PublicProfileSources,
} from "@mc/connectors";
import {
  addPublicAccount, CreatorNotInWorkspace, disconnectConnection, getDefaultCreatorId, listAccounts, markAccountLookupFailure, NoCreatorProfile,
  recordAccountSnapshot, recordConsent, type AccountRow, type WorkspaceTx,
} from "@mc/db";
import { CONSENT_POLICY_VERSION } from "./consent";

export const PUBLIC_PLATFORMS: readonly PlatformId[] = ["instagram", "tiktok", "youtube"];
export const PLATFORM_NAME: Record<PlatformId, string> = { tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" };

/** Lo que el usuario acepta al agregar una cuenta por @. Va tal cual a evidence.textShown. */
export const OWNERSHIP_DECLARATION_ES =
  "Declaro que esta cuenta es mía o la gestiono con permiso de su dueño. On Cue leerá únicamente lo que la plataforma publica de ella (perfil, seguidores y publicaciones) para mostrarme su rendimiento y guardar su historial diario. Puedo quitarla cuando quiera.";

export interface CuentasDeps {
  env: Readonly<Record<string, string | undefined>>;
  withWorkspace: <T>(fn: (tx: WorkspaceTx) => Promise<T>) => Promise<T>;
  fetch?: FetchLike;
  now?: () => Date;
  /** Fuentes ya construidas (pruebas); por defecto las oficiales sobre un HttpCore propio. */
  sources?: (core: HttpCore) => PublicProfileSources;
}

export interface Requester {
  ip: string | null;
  userAgent: string | null;
}

export type AgregarResult =
  | { ok: true; id: string; created: boolean; profile: PublicProfile }
  | { ok: false; code: PublicLookupError["code"] | "sin_creador" | "plataforma"; message: string };

export type ActualizarResult =
  | {
      ok: true; id: string; withMetrics: boolean; note: string | null;
      /** true si ya había lectura de hoy: no se guardó nada nuevo y last_synced_at no se movió. */
      alreadyReadToday: boolean;
    }
  | { ok: false; code: PublicLookupError["code"] | "no_existe" | "plataforma"; message: string };

export interface SourceAvailability {
  platformId: PlatformId;
  name: string;
  label: string;
  missing: readonly string[];
  /** Texto para la pantalla: qué se obtiene por @ en esta red. */
  offersEs: string;
}

const OFFERS_ES: Record<PlatformId, string> = {
  instagram: "Seguidores y número de publicaciones de cuentas profesionales (creador o empresa) públicas.",
  tiktok: "Confirmamos la cuenta; TikTok no publica seguidores ni vistas por @ (métricas pendientes de fuente).",
  youtube: "Suscriptores, vistas acumuladas y número de videos del canal.",
  facebook: "No disponible en esta versión.",
};

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function createCuentasService(deps: CuentasDeps) {
  const now = deps.now ?? (() => new Date());
  const build = (callLog: InMemoryCallLogSink) => {
    const core = new HttpCore({ callLog, fetch: deps.fetch, now, quota: new QuotaManager({ now }) });
    return deps.sources ? deps.sources(core) : createPublicProfileSources(core, deps.env);
  };

  async function flush(callLog: InMemoryCallLogSink, tx: WorkspaceTx, connectionId: string | null): Promise<void> {
    const sink = new PostgresCallLogSink(tx);
    for (const e of callLog.entries) await sink.record({ ...e, connection_id: e.connection_id ?? connectionId });
  }

  return {
    availability(): SourceAvailability[] {
      const src = build(new InMemoryCallLogSink());
      return PUBLIC_PLATFORMS.map((p) => ({ platformId: p, name: PLATFORM_NAME[p], label: src[p]?.label ?? "—", missing: src[p]?.missing ?? ["sin fuente"], offersEs: OFFERS_ES[p] }));
    },

    async agregar(input: { platformId: string; handle: string }, who: Requester): Promise<AgregarResult> {
      if (!isPlatformId(input.platformId) || !PUBLIC_PLATFORMS.includes(input.platformId)) return { ok: false, code: "plataforma", message: "Elige TikTok, Instagram o YouTube." };
      const platformId = input.platformId;
      const callLog = new InMemoryCallLogSink();
      const source = build(callLog)[platformId];
      if (!source) return { ok: false, code: "plataforma", message: "Esa red no está disponible en esta versión." };
      let profile: PublicProfile;
      try {
        profile = await source.lookup(input.handle);
      } catch (err) {
        if (err instanceof PublicLookupError) {
          await deps.withWorkspace((tx) => flush(callLog, tx, null)).catch(() => undefined);
          return { ok: false, code: err.code, message: err.messageEs };
        }
        throw err;
      }
      const handle = profile.profile.handle ?? input.handle.replace(/^@/, "");
      const externalAccountId = profile.profile.external_account_id ?? handle;
      const at = now();
      const evidence = redactSecrets({
        declaredOwner: true, handle, platformId, textShown: OWNERSHIP_DECLARATION_ES, policyVersion: CONSENT_POLICY_VERSION,
        source: profile.source, ip: who.ip, userAgent: who.userAgent, at: at.toISOString(),
      }) as Record<string, unknown>;
      try {
        const out = await deps.withWorkspace(async (tx) => {
          const creatorId = await getDefaultCreatorId(tx);
          const { id, created } = await addPublicAccount(tx, {
            creatorId, platformId, handle, externalAccountId,
            displayName: profile.profile.display_name, avatarUrl: profile.profile.avatar_url, profileUrl: profile.profile.profile_url, accountType: profile.profile.account_type,
          });
          await recordConsent(tx, { connectionId: id, creatorId, purpose: "analytics", policyVersion: CONSENT_POLICY_VERSION, evidence });
          if (profile.metrics) {
            await recordAccountSnapshot(tx, { connectionId: id, day: utcDay(at), ...profile.metrics, raw: profile.raw });
          }
          await flush(callLog, tx, id);
          return { id, created };
        });
        return { ok: true, ...out, profile };
      } catch (err) {
        if (err instanceof NoCreatorProfile || err instanceof CreatorNotInWorkspace) return { ok: false, code: "sin_creador", message: err.message };
        throw err;
      }
    },

    async actualizar(id: string): Promise<ActualizarResult> {
      const row = (await deps.withWorkspace((tx) => listAccounts(tx))).find((r) => r.id === id);
      if (!row) return { ok: false, code: "no_existe", message: "Esa cuenta ya no está en la lista." };
      const platformId = row.platformId;
      const callLog = new InMemoryCallLogSink();
      const source = build(callLog)[platformId];
      if (!source) return { ok: false, code: "plataforma", message: "Esa red no está disponible en esta versión." };
      try {
        const profile = await source.lookup(row.handle ?? row.externalAccountId);
        const outcome = await deps.withWorkspace(async (tx) => {
          const saved = profile.metrics
            ? await recordAccountSnapshot(tx, { connectionId: id, day: utcDay(now()), ...profile.metrics, raw: profile.raw })
            : null;
          if (!profile.metrics) await markAccountLookupFailure(tx, id, profile.metricsNote ?? "Sin métricas públicas.", false);
          await flush(callLog, tx, id);
          return saved;
        });
        return { ok: true, id, withMetrics: profile.metrics !== null, note: profile.metricsNote, alreadyReadToday: outcome === "ya_hay_lectura_de_hoy" };
      } catch (err) {
        if (err instanceof PublicLookupError) {
          const permanent = err.code === "not_found" || err.code === "not_discoverable";
          await deps.withWorkspace(async (tx) => {
            await markAccountLookupFailure(tx, id, err.messageEs, permanent);
            await flush(callLog, tx, id);
          }).catch(() => undefined);
          return { ok: false, code: err.code, message: err.messageEs };
        }
        throw err;
      }
    },

    async quitar(id: string): Promise<void> {
      await deps.withWorkspace((tx) => disconnectConnection(tx, id));
    },

    listar(): Promise<AccountRow[]> {
      return deps.withWorkspace((tx) => listAccounts(tx));
    },
  };
}

export type CuentasService = ReturnType<typeof createCuentasService>;
