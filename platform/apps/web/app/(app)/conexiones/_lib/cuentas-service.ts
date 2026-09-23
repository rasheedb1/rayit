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
 *
 * Consentimiento delegado (ACC-8): la transacción que escribe empieza
 * comprobando el permiso (conexiones.cuenta.conectar) y devuelve quién
 * actúa; el consentimiento queda a nombre del creator_profile con esa
 * persona en evidence.actedBy si no es el titular; el titular recibe
 * el aviso connection_added. La bitácora la escriben las consultas
 * (audit() de ACC-2, con onBehalfOf y actedBy en `after`). Quitar sigue
 * la misma regla con conexiones.cuenta.desconectar.
 */
import {
  createPublicProfileSources, EncryptedSecretStore, HttpCore, InMemoryCallLogSink, InstagramClient, isPlatformApiError, isPlatformId, keyringFromEnv,
  MasterKeyError, PostgresCallLogSink, PublicLookupError, QuotaManager, redactSecrets, TikTokDisplayClient, TokenCipher,
  type FetchLike, type PlatformId, type PublicProfile, type PublicProfileSources,
} from "@mc/connectors";
import {
  addPublicAccount, API_SNAPSHOT_SOURCE, CreatorNotInWorkspace, disconnectConnection, getConsentCreator, listAccounts, markAccountLookupFailure, NoCreatorProfile,
  notifyConnectionAdded, recordAccountSnapshot, recordConsent, type AccountRow, type ConsentCreator, type SessionMember, type WorkspaceTx,
} from "@mc/db";
import { getWorkspaceSettings } from "@mc/db/queries/cimientos";
import { formatterFor } from "@/lib/format";
import { buildConsentEvidence, buildRevocationEvidence, CONSENT_POLICY_VERSION } from "./consent";
import { MESSAGES, nombreDe } from "./messages";
import { requireConexionesPermission, SinPermisoError } from "./permisos";

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

/**
 * Qué pasó con el aviso al titular (ACC-8):
 *   enviado        un tercero conectó la cuenta y el titular tiene aviso nuevo
 *   ya_habia       un tercero la conectó y el titular ya tenía ese aviso sin leer
 *   titular_actua  la conectó el propio titular: no hay a quién avisar
 *   sin_titular    el perfil del creador no tiene app_user (seed, alta por agencia)
 *   sin_sesion     copia sin llaves: no hay nadie en la sesión
 */
export type AvisoTitular = "enviado" | "ya_habia" | "titular_actua" | "sin_titular" | "sin_sesion";

export type AgregarResult =
  | { ok: true; id: string; created: boolean; profile: PublicProfile; aviso: AvisoTitular }
  | { ok: false; code: PublicLookupError["code"] | "sin_creador" | "sin_permiso" | "plataforma"; message: string };

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

/**
 * El aviso al titular cuando un tercero conectó su cuenta. Se arma aquí
 * (y no en @mc/db) porque la fecha va en el locale y la zona del
 * workspace, y @mc/db no escribe frases.
 */
async function avisarAlTitular(tx: WorkspaceTx, p: { creator: ConsentCreator; actor: SessionMember | null; connectionId: string; platformId: PlatformId; handle: string; at: Date }): Promise<AvisoTitular> {
  if (!p.actor) return "sin_sesion";
  if (p.actor.userId === p.creator.userId) return "titular_actua";
  if (!p.creator.userId) return "sin_titular";
  const f = formatterFor(await getWorkspaceSettings(tx));
  const body = MESSAGES.aviso.body({ who: nombreDe(p.actor) ?? p.actor.email, handle: p.handle, network: PLATFORM_NAME[p.platformId], when: f.dateTime(p.at.toISOString()) });
  const sent = await notifyConnectionAdded(tx, { userId: p.creator.userId, connectionId: p.connectionId, titleEs: MESSAGES.aviso.title, bodyEs: body });
  return sent ? "enviado" : "ya_habia";
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
      // Antes de gastar una llamada a la plataforma: quien no puede conectar no lee nada. La transacción que escribe lo vuelve a comprobar.
      try {
        await deps.withWorkspace((tx) => requireConexionesPermission(tx, "conexiones.cuenta.conectar"));
      } catch (err) {
        if (err instanceof SinPermisoError) return { ok: false, code: "sin_permiso", message: err.message };
        throw err;
      }
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
      try {
        const out = await deps.withWorkspace(async (tx) => {
          // Segunda barrera, en la transacción que escribe (la primera es requirePermission de la acción): ver _lib/permisos.ts.
          const actor = await requireConexionesPermission(tx, "conexiones.cuenta.conectar");
          const creator = await getConsentCreator(tx);
          const { id, created } = await addPublicAccount(tx, {
            creatorId: creator.id, platformId, handle, externalAccountId,
            displayName: profile.profile.display_name, avatarUrl: profile.profile.avatar_url, profileUrl: profile.profile.profile_url, accountType: profile.profile.account_type,
          });
          const evidence = redactSecrets(buildConsentEvidence({
            method: "public_handle", declaredOwner: true, ip: who.ip, userAgent: who.userAgent, textShown: OWNERSHIP_DECLARATION_ES, policyVersion: CONSENT_POLICY_VERSION, at,
            creatorId: creator.id, creatorUserId: creator.userId, actor, extra: { handle, platformId, source: profile.source },
          })) as Record<string, unknown>;
          await recordConsent(tx, { connectionId: id, creatorId: creator.id, purpose: "analytics", policyVersion: CONSENT_POLICY_VERSION, evidence });
          if (profile.metrics) {
            await recordAccountSnapshot(tx, { connectionId: id, day: utcDay(at), ...profile.metrics, raw: profile.raw });
          }
          const aviso = await avisarAlTitular(tx, { creator, actor, connectionId: id, platformId, handle, at });
          await flush(callLog, tx, id);
          return { id, created, aviso };
        });
        return { ok: true, ...out, profile };
      } catch (err) {
        if (err instanceof NoCreatorProfile || err instanceof CreatorNotInWorkspace) return { ok: false, code: "sin_creador", message: err.message };
        if (err instanceof SinPermisoError) return { ok: false, code: "sin_permiso", message: err.message };
        throw err;
      }
    },

    async actualizar(id: string): Promise<ActualizarResult> {
      const row = (await deps.withWorkspace((tx) => listAccounts(tx))).find((r) => r.id === id);
      if (!row) return { ok: false, code: "no_existe", message: "Esa cuenta ya no está en la lista." };
      const platformId = row.platformId;
      const callLog = new InMemoryCallLogSink();
      if (row.accessMode === "direct_oauth") return this.actualizarAutorizada(row, callLog);
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

    /**
     * Cuenta autorizada (CON-3): se lee con su propio token desde el almacén
     * cifrado (userInfo de TikTok, me de Instagram). Un token que la
     * plataforma rechaza deja el aviso; la renovación es de oauth.refresh.
     */
    async actualizarAutorizada(row: AccountRow, callLog: InMemoryCallLogSink): Promise<ActualizarResult> {
      let cipher: TokenCipher;
      try {
        cipher = new TokenCipher(keyringFromEnv(deps.env));
      } catch (err) {
        return { ok: false, code: "not_configured", message: err instanceof MasterKeyError ? err.message : "Falta la clave de cifrado." };
      }
      const core = new HttpCore({ callLog, fetch: deps.fetch, now, quota: new QuotaManager({ now }) });
      try {
        const metrics = await deps.withWorkspace(async (tx) => {
          const tokens = await new EncryptedSecretStore({ db: tx, cipher }).get(row.secretRef);
          if (!tokens) throw new PublicLookupError("not_configured", "No encontramos el permiso de esta cuenta; vuelve a autorizarla.");
          const auth = { connectionId: row.id, tokens };
          if (row.platformId === "tiktok") {
            const { data, raw } = await new TikTokDisplayClient(core, auth).userInfo();
            return { followers: data.metrics.followers, following: data.metrics.following, mediaCount: data.metrics.media_count, views: data.metrics.views, raw };
          }
          if (row.platformId === "instagram") {
            const { data, raw } = await new InstagramClient(core, auth).me();
            return { followers: data.metrics.followers, following: data.metrics.following, mediaCount: data.metrics.media_count, views: data.metrics.views, raw };
          }
          throw new PublicLookupError("not_configured", "Esta red autorizada todavía no tiene lectura de cuenta (CON-8).");
        });
        await deps.withWorkspace(async (tx) => {
          await recordAccountSnapshot(tx, { connectionId: row.id, day: utcDay(now()), ...metrics, source: API_SNAPSHOT_SOURCE });
          await flush(callLog, tx, row.id);
        });
        return { ok: true, id: row.id, withMetrics: true, note: null, alreadyReadToday: false };
      } catch (err) {
        const message = err instanceof PublicLookupError ? err.messageEs
          : isPlatformApiError(err) && err.kind === "auth" ? "La plataforma rechazó el permiso de esta cuenta; hay que volver a autorizarla."
          : isPlatformApiError(err) ? err.messageEs : "No se pudo leer la cuenta. Inténtalo de nuevo en unos minutos.";
        const permanent = isPlatformApiError(err) && err.kind === "auth";
        await deps.withWorkspace(async (tx) => {
          await markAccountLookupFailure(tx, row.id, message, permanent);
          await flush(callLog, tx, row.id);
        }).catch(() => undefined);
        return { ok: false, code: err instanceof PublicLookupError ? err.code : "transient", message };
      }
    },

    /**
     * «Quitar»: permiso conexiones.cuenta.desconectar como primera
     * sentencia; la revocación queda en la evidencia de cada
     * consentimiento (quién, cuándo, a nombre de quién) y en la bitácora.
     * Lanza SinPermisoError o ConnectionNotFound; la acción los traduce.
     */
    async quitar(id: string): Promise<void> {
      await deps.withWorkspace(async (tx) => {
        const actor = await requireConexionesPermission(tx, "conexiones.cuenta.desconectar");
        const creator = await getConsentCreator(tx);
        await disconnectConnection(tx, id, buildRevocationEvidence({ at: now(), creatorId: creator.id, actor, creatorUserId: creator.userId }));
      });
    },

    listar(): Promise<AccountRow[]> {
      return deps.withWorkspace((tx) => listAccounts(tx));
    },
  };
}

export type CuentasService = ReturnType<typeof createCuentasService>;
