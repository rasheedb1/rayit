/**
 * El flujo OAuth de Conexiones como funciones puras de Request → Response,
 * para probarlas sin Next: las rutas app/(app)/conexiones/oauth/[platform]/
 * {start,callback}/route.ts solo delegan aquí.
 *
 *   POST …/start     el diálogo de consentimiento envía el formulario →
 *                    state de 32 bytes, cookie sellada (HMAC) de un solo
 *                    uso y 10 minutos, 303 a la plataforma.
 *   GET  …/callback  la cookie se borra siempre; error de la plataforma →
 *                    /conexiones?error=cancelada; cookie inválida, state
 *                    distinto o vencido → 400 sin tocar la base; con code →
 *                    intercambio → identidad → UNA transacción de workspace:
 *                    set() en el almacén cifrado, upsert de social_connection,
 *                    data_consent por finalidad, api_call_log → 303 a
 *                    /conexiones?conectada=<id>.
 *
 * Ni el code ni los tokens tocan logs, errores, URLs nuestras ni la cookie.
 *
 * Consentimiento delegado (ACC-8): start comprueba el permiso
 * conexiones.cuenta.conectar antes de mandar a la plataforma; el
 * callback lo vuelve a comprobar como primera sentencia de la
 * transacción, deja la evidencia v2 (onBehalfOf el creador, actedBy si
 * actúa un tercero), la bitácora y el aviso al titular.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  currentMasterKey, EncryptedSecretStore, HttpCore, InMemoryCallLogSink, isOAuthProviderId, isPlatformApiError, keyringFromEnv, loadOAuthApps,
  MasterKeyError, newSecretRef, OAUTH_PROVIDERS, openSealedValue, PostgresCallLogSink, QuotaManager, redactSecrets, sealingKey, sealValue,
  TokenCipher, type FetchLike, type OAuthProviderId, type OAuthTokens,
} from "@mc/connectors";
import {
  CreatorNotInWorkspace, findConnectionByAccount, findPublicAccountByHandle, getConsentCreator, NoCreatorProfile, notifyConnectionAdded, recordConnectionAudit, recordConsent,
  upgradePublicAccountToOAuth, upsertConnection, type ConsentPurpose, type WorkspaceTx,
} from "@mc/db";
import { getWorkspaceSettings } from "@mc/db/queries/cimientos";
import { formatterFor } from "@/lib/format";
import { buildConsentEvidence, CONSENT_POLICY_VERSION, consentText, PLATFORM_LABEL, purposesFor } from "./consent";
import { MESSAGES, nombreDe } from "./messages";
import { PermisoDenegado, requireConexionesPermission } from "./permisos";

export const OAUTH_COOKIE = "oc_oauth";
export const OAUTH_COOKIE_PATH = "/conexiones/oauth";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const STATE_BYTES = 32;

/** Códigos que viajan en /conexiones?error=… y su texto. La página los traduce; nunca va el detalle de la plataforma en la URL. */
export const OAUTH_ERROR_MESSAGES = {
  cancelada: "Cancelaste la autorización en la plataforma. Tu cuenta no se conectó.",
  plataforma: "La plataforma devolvió un error al autorizar. Inténtalo de nuevo en unos minutos.",
  consentimiento: "Para conectar una cuenta tienes que aceptar el tratamiento de datos.",
  sin_creador: "Este workspace no tiene un perfil de creador; no se puede conectar una cuenta.",
  no_configurada: "Esa red todavía no está configurada en este entorno.",
  intercambio: "La plataforma no aceptó el código de autorización. Vuelve a intentar conectar la cuenta.",
  temporal: "La plataforma no respondió. Inténtalo de nuevo en unos minutos.",
  identidad: "La plataforma no nos dijo qué cuenta autorizaste. Vuelve a intentar conectar la cuenta.",
  sin_permiso: MESSAGES.permiso.conectar,
} as const;
export type OAuthErrorCode = keyof typeof OAUTH_ERROR_MESSAGES;

export interface OAuthHandlerDeps {
  env: Readonly<Record<string, string | undefined>>;
  withWorkspace: <T>(fn: (tx: WorkspaceTx) => Promise<T>) => Promise<T>;
  /** Inyectables para las pruebas (fixtures, reloj fijo, state conocido). */
  fetch?: FetchLike;
  now?: () => Date;
  random?: (bytes: number) => Uint8Array;
}

export interface OAuthHandlers {
  start(req: Request, provider: string): Promise<Response>;
  callback(req: Request, provider: string): Promise<Response>;
}

interface StatePayload {
  state: string;
  verifier: string | null;
  provider: OAuthProviderId;
  creatorId: string;
  policyVersion: string;
  textShown: string;
  scopesRequested: string[];
}

const startSchema = z.object({
  acepto: z.literal("on", { message: "Tienes que aceptar el tratamiento de datos." }),
  policy_version: z.literal(CONSENT_POLICY_VERSION, { message: "La versión de la política no coincide; recarga la página." }),
});

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function redirect(req: Request, path: string, headers: Record<string, string> = {}): Response {
  const location = new URL(path, req.url).toString();
  return new Response(null, { status: 303, headers: { Location: location, ...headers } });
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", ...headers } });
}

function cookieHeader(value: string, maxAgeS: number, secure: boolean): string {
  const parts = [`${OAUTH_COOKIE}=${value}`, `Path=${OAUTH_COOKIE_PATH}`, "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeS}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

function clientIp(req: Request): string | null {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim() || null;
  return req.headers.get("x-real-ip");
}

export function createOAuthHandlers(deps: OAuthHandlerDeps): OAuthHandlers {
  const now = deps.now ?? (() => new Date());
  const random = deps.random ?? ((n) => new Uint8Array(randomBytes(n)));
  const secure = deps.env["NODE_ENV"] === "production";
  const { apps, missing } = loadOAuthApps(deps.env);

  // La clave se resuelve una vez; si falta, cada petición responde 503 con el nombre de la variable y nada más.
  let keys: { cipher: TokenCipher; seal: Uint8Array } | { error: string };
  try {
    const keyring = keyringFromEnv(deps.env);
    // El sello se deriva de la clave ACTUAL: al rotar, la v1 puede retirarse y las cookies viejas simplemente dejan de abrir.
    keys = { cipher: new TokenCipher(keyring), seal: sealingKey(currentMasterKey(keyring)) };
  } catch (err) {
    keys = { error: err instanceof MasterKeyError ? err.message : "No se pudo preparar la clave de cifrado." };
  }

  const clear = cookieHeader("", 0, secure);

  return {
    async start(req, providerRaw) {
      if (req.method !== "POST") return text(405, "Usa el botón «Conectar» de /conexiones: el inicio del flujo va por POST con tu consentimiento.", { Allow: "POST" });
      if (!isOAuthProviderId(providerRaw)) return text(404, "Esa red no existe.");
      const provider = providerRaw;
      if ("error" in keys) return text(503, keys.error);
      const cfg = apps[provider];
      if (!cfg) return text(503, `${PLATFORM_LABEL[provider]} no está configurado en este entorno: faltan ${(missing[provider] ?? []).join(", ")}.`);

      const form = await req.formData();
      const parsed = startSchema.safeParse({ acepto: form.get("acepto"), policy_version: form.get("policy_version") });
      if (!parsed.success) return redirect(req, "/conexiones?error=consentimiento");

      let creatorId: string;
      try {
        creatorId = await deps.withWorkspace(async (tx) => {
          // TODO(ACC-1): requirePermission('conexiones.cuenta.conectar'). A quien no puede conectar no se le manda a la plataforma.
          await requireConexionesPermission(tx, "conexiones.cuenta.conectar");
          return (await getConsentCreator(tx)).id;
        });
      } catch (err) {
        if (err instanceof NoCreatorProfile) return redirect(req, "/conexiones?error=sin_creador");
        if (err instanceof PermisoDenegado) return redirect(req, "/conexiones?error=sin_permiso");
        throw err;
      }

      const state = b64url(random(STATE_BYTES));
      const payload: StatePayload = { state, verifier: null, provider, creatorId, policyVersion: CONSENT_POLICY_VERSION, textShown: consentText(provider), scopesRequested: [...cfg.scopes] };
      const sealed = sealValue(payload, keys.seal, now());
      const url = OAUTH_PROVIDERS[provider].authorizationUrl(cfg, { state });
      return new Response(null, { status: 303, headers: { Location: url, "Set-Cookie": cookieHeader(sealed, OAUTH_STATE_TTL_MS / 1000, secure) } });
    },

    async callback(req, providerRaw) {
      const headers = { "Set-Cookie": clear };
      if (!isOAuthProviderId(providerRaw)) return text(404, "Esa red no existe.", headers);
      const provider = providerRaw;
      const params = new URL(req.url).searchParams;

      // El creador canceló (Instagram: error=access_denied&error_reason=user_denied; TikTok: error + error_description).
      if (params.get("error")) {
        const code: OAuthErrorCode = params.get("error") === "access_denied" || params.get("error_reason") === "user_denied" ? "cancelada" : "plataforma";
        return redirect(req, `/conexiones?error=${code}`, headers);
      }
      if ("error" in keys) return text(503, keys.error, headers);

      const opened = openSealedValue<StatePayload>(readCookie(req, OAUTH_COOKIE), keys.seal, now(), OAUTH_STATE_TTL_MS);
      if (!opened.ok) {
        const why = opened.reason === "expired" ? "El inicio de la conexión venció (tiene 10 minutos)." : "No encontramos el inicio de esta conexión en tu navegador.";
        return text(400, `${why} Vuelve a /conexiones y pulsa «Conectar» otra vez.`, headers);
      }
      const saved = opened.payload;
      const state = params.get("state");
      if (!state || state !== saved.state || saved.provider !== provider) {
        return text(400, "La respuesta de la plataforma no coincide con el inicio de esta conexión. Vuelve a /conexiones y pulsa «Conectar» otra vez.", headers);
      }
      const code = params.get("code");
      if (!code) return text(400, "La plataforma no devolvió un código de autorización.", headers);

      const cfg = apps[provider];
      if (!cfg) return redirect(req, "/conexiones?error=no_configurada", headers);
      const prov = OAUTH_PROVIDERS[provider];

      // Fase HTTP fuera de la transacción; el log se acumula y se escribe con la fila.
      const callLog = new InMemoryCallLogSink();
      const core = new HttpCore({ callLog, fetch: deps.fetch, now, quota: new QuotaManager({ now }) });
      let tokens: OAuthTokens;
      let scopesGranted: string[];
      let externalAccountId: string | null;
      let profile: Awaited<ReturnType<typeof prov.identity>>;
      try {
        const exchanged = await prov.exchangeCode(core, cfg, code, { codeVerifier: saved.verifier ?? undefined });
        tokens = exchanged.tokens;
        scopesGranted = exchanged.scopesGranted;
        profile = await prov.identity(core, tokens, { businessId: exchanged.externalAccountId ?? undefined });
        externalAccountId = profile.external_account_id ?? exchanged.externalAccountId;
      } catch (err) {
        await flushCallLog(deps, callLog).catch(() => undefined);
        const codeOut: OAuthErrorCode = isPlatformApiError(err) && (err.kind === "transient" || err.kind === "quota") ? "temporal" : "intercambio";
        return redirect(req, `/conexiones?error=${codeOut}`, headers);
      }
      if (!externalAccountId) {
        await flushCallLog(deps, callLog).catch(() => undefined);
        return redirect(req, "/conexiones?error=identidad", headers);
      }

      const at = now();
      const ip = clientIp(req);
      const userAgent = req.headers.get("user-agent");
      const cipher = keys.cipher;
      let connectionId: string;
      try {
        connectionId = await deps.withWorkspace(async (tx) => {
        // TODO(ACC-1): requirePermission('conexiones.cuenta.conectar'): primera sentencia, antes de guardar nada.
        const actor = await requireConexionesPermission(tx, "conexiones.cuenta.conectar");
        // El titular es el perfil del workspace, el mismo que start guardó en la cookie; si no coincide, alguien cambió de espacio a mitad del flujo.
        const creator = await getConsentCreator(tx);
        if (creator.id !== saved.creatorId) throw new CreatorNotInWorkspace(saved.creatorId);
        const evidence = redactSecrets(buildConsentEvidence({
          method: "oauth", declaredOwner: false, ip, userAgent, textShown: saved.textShown, policyVersion: saved.policyVersion, at,
          creatorId: creator.id, creatorUserId: creator.userId, actor, extra: { scopesRequested: saved.scopesRequested, scopesGranted },
        })) as Record<string, unknown>;
        const existing = await findConnectionByAccount(tx, prov.platformId, externalAccountId);
        // Híbrido CON-10: si la cuenta ya se agregó por @, «Autorizar» convierte ESA fila (mismo id, mismo historial).
        const publicRow = provider !== "tiktok-business" && profile.handle ? await findPublicAccountByHandle(tx, prov.platformId, profile.handle) : null;
        // Se reutiliza la ref solo si es de ESTE proveedor: una fila de Login Kit no puede acabar con tokens de la Accounts API bajo 'enc:tiktok:'.
        const secretRef = existing && existing.secretRef.startsWith(`enc:${provider}:`) ? existing.secretRef : newSecretRef(provider);
        await new EncryptedSecretStore({ db: tx, cipher }).set(secretRef, tokens);
        let id: string;
        if (publicRow) {
          id = publicRow.id;
          await upgradePublicAccountToOAuth(tx, id, {
            externalAccountId, handle: profile.handle, displayName: profile.display_name, avatarUrl: profile.avatar_url, profileUrl: profile.profile_url, accountType: profile.account_type,
            secretRef, scopes: scopesGranted, accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt ?? null, connectedAt: now(),
          });
        } else {
          id = (await upsertConnection(tx, {
            creatorId: creator.id, platformId: prov.platformId, externalAccountId,
            handle: profile.handle, displayName: profile.display_name, avatarUrl: profile.avatar_url, profileUrl: profile.profile_url, accountType: profile.account_type,
            secretRef, scopes: scopesGranted, accessExpiresAt: tokens.accessExpiresAt, refreshExpiresAt: tokens.refreshExpiresAt ?? null, connectedAt: now(),
          })).id;
        }
        const purposes: ConsentPurpose[] = purposesFor(provider, scopesGranted);
        for (const purpose of purposes) {
          await recordConsent(tx, { connectionId: id, creatorId: creator.id, purpose, policyVersion: saved.policyVersion, evidence });
        }
        const delegated = actor !== null && actor.userId !== creator.userId;
        // TODO(ACC-2): withAudit() cuando esté en @mc/db; la forma de `after` se conserva.
        await recordConnectionAudit(tx, {
          action: "connection.added", connectionId: id,
          after: {
            connectionId: id, platformId: prov.platformId, handle: profile.handle, accessMode: "direct_oauth", onBehalfOf: { creatorId: creator.id },
            ...(delegated ? { actedBy: { userId: actor.userId, roleKey: actor.roleKey } } : {}),
          },
        });
        if (delegated && creator.userId) {
          const f = formatterFor(await getWorkspaceSettings(tx));
          const body = MESSAGES.aviso.body({ who: nombreDe(actor) ?? actor.email, handle: profile.handle ?? externalAccountId, network: PLATFORM_LABEL[provider], when: f.dateTime(at.toISOString()) });
          await notifyConnectionAdded(tx, { userId: creator.userId, connectionId: id, titleEs: MESSAGES.aviso.title, bodyEs: body });
        }
        const sink = new PostgresCallLogSink(tx);
        for (const entry of callLog.entries) await sink.record({ ...entry, connection_id: entry.connection_id ?? id });
        return id;
        });
      } catch (err) {
        // El code ya se consumió: se registra lo que se llamó y se vuelve con un mensaje; la plataforma dará otro code al reintentar.
        await flushCallLog(deps, callLog).catch(() => undefined);
        const codeOut: OAuthErrorCode = err instanceof CreatorNotInWorkspace || err instanceof NoCreatorProfile ? "sin_creador"
          : err instanceof PermisoDenegado ? "sin_permiso" : "temporal";
        return redirect(req, `/conexiones?error=${codeOut}`, headers);
      }
      return redirect(req, `/conexiones?conectada=${encodeURIComponent(connectionId)}`, headers);
    },
  };
}

/** Las llamadas de un intento fallido también quedan en api_call_log, en su propia transacción. */
async function flushCallLog(deps: OAuthHandlerDeps, callLog: InMemoryCallLogSink): Promise<void> {
  if (callLog.entries.length === 0) return;
  await deps.withWorkspace(async (tx) => {
    const sink = new PostgresCallLogSink(tx);
    for (const entry of callLog.entries) await sink.record(entry);
  });
}
