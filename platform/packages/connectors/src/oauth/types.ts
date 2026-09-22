/**
 * OAuth de las plataformas (CON-3): el primer token de cada conexión.
 *
 * Un "proveedor" es una app: TikTok son DOS (Login Kit para el sandbox,
 * Accounts API cuando CON-9 dé acceso) sobre el mismo platform_id
 * 'tiktok'; el secret_ref ('enc:<proveedor>:<uuid>') las distingue.
 */
import type { HttpCore } from '../http/client.ts';
import type { NormalizedAccountProfile } from '../normalize/types.ts';
import type { OAuthTokens, PlatformId } from '../types.ts';

export type OAuthProviderId = 'tiktok' | 'tiktok-business' | 'instagram';
export const OAUTH_PROVIDER_IDS: readonly OAuthProviderId[] = ['tiktok', 'tiktok-business', 'instagram'];

export function isOAuthProviderId(value: unknown): value is OAuthProviderId {
  return typeof value === 'string' && (OAUTH_PROVIDER_IDS as readonly string[]).includes(value);
}

/** Lo que identifica a nuestra app ante la plataforma. Los valores salen del vault; aquí solo viajan. */
export interface OAuthAppConfig {
  provider: OAuthProviderId;
  clientId: string;
  clientSecret: string;
  /** Exactamente la registrada en la app (TikTok: https, sin query ni #). */
  redirectUri: string;
  scopes: readonly string[];
}

export interface AuthorizationUrlInput {
  /** 32 bytes aleatorios en base64url; vuelve tal cual en el callback. */
  state: string;
  /** Solo si el proveedor admite PKCE en web (hoy ninguno de los tres lo documenta). */
  codeChallenge?: string;
}

export interface ExchangeOptions {
  codeVerifier?: string;
  signal?: AbortSignal;
}

/** Resultado del intercambio del code: tokens listos para el SecretStore y lo que la plataforma dijo de la cuenta. */
export interface CodeExchange {
  tokens: OAuthTokens;
  /** open_id / user_id que devuelve el endpoint de token; puede faltar y entonces manda la identidad. */
  externalAccountId: string | null;
  scopesGranted: string[];
}

export interface IdentityOptions {
  signal?: AbortSignal;
  /** open_id devuelto por el intercambio; solo lo usa TikTok Accounts API. */
  businessId?: string;
}

export interface RefreshCallOptions {
  signal?: AbortSignal;
  connectionId?: string | null;
}

export interface OAuthProvider {
  readonly id: OAuthProviderId;
  readonly platformId: PlatformId;
  /** Nombre en la interfaz: «TikTok», «TikTok (analítica avanzada)», «Instagram». */
  readonly labelEs: string;
  readonly defaultScopes: readonly string[];
  readonly usesPkce: boolean;
  authorizationUrl(cfg: OAuthAppConfig, input: AuthorizationUrlInput): string;
  exchangeCode(core: HttpCore, cfg: OAuthAppConfig, code: string, opts?: ExchangeOptions): Promise<CodeExchange>;
  /** Quién es la cuenta que acaba de autorizar (userInfo / me de CON-1). La Accounts API necesita el open_id del intercambio (businessId). */
  identity(core: HttpCore, tokens: OAuthTokens, opts?: IdentityOptions): Promise<NormalizedAccountProfile>;
  /** Renovación; lanza TokenRefreshError clasificado. */
  refresh(core: HttpCore, cfg: OAuthAppConfig, tokens: OAuthTokens, opts?: RefreshCallOptions): Promise<OAuthTokens>;
}

/** Endpoints lógicos de api_call_log para el flujo OAuth. */
export const OAUTH_ENDPOINTS = {
  token: 'oauth.token',
  longLived: 'oauth.long_lived',
  refresh: 'oauth.refresh',
} as const;

export function splitScopes(raw: unknown, separator: ',' | ' ' = ','): string[] {
  if (typeof raw !== 'string') return [];
  return raw.split(separator).map((s) => s.trim()).filter(Boolean);
}

/** `expires_in` en segundos → fecha absoluta. Sin dato válido, `fallbackS`. */
export function expiresAt(now: Date, expiresInS: unknown, fallbackS: number): Date {
  const n = typeof expiresInS === 'number' && Number.isFinite(expiresInS) && expiresInS > 0 ? expiresInS : fallbackS;
  return new Date(now.getTime() + n * 1000);
}
