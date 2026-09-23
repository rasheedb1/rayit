/**
 * Consentimiento explícito por finalidad (data_consent, migración 0002).
 * El texto que ve el creador se guarda tal cual en evidence.textShown
 * junto con la versión de la política: si el texto cambia, cambia la
 * versión, y el consentimiento viejo queda con el texto viejo.
 *
 * Habeas data (Ley 1581 de 2012) exige decir qué se recoge, para qué y
 * cómo se revoca. Sin jerga: es lo que lee una creadora en un diálogo.
 *
 * Evidencia v2 (ACC-8): quien conecta una cuenta ajena no es quien
 * consiente. Cada fila de data_consent dice a nombre de quién queda
 * (onBehalfOf: el creator_profile) y, si actuó un tercero, quién fue
 * (actedBy: id, correo y rol de ese día). Es la respuesta el día que
 * Meta o TikTok pregunten quién dio el consentimiento.
 */
import { createHash } from "node:crypto";
import type { ConsentPurpose, SessionMember } from "@mc/db";
import type { OAuthProviderId } from "@mc/connectors";

export const CONSENT_POLICY_VERSION = "2026-09-22";

/** Versión de la forma de `evidence`. v1 (CON-3/CON-10) llevaba la IP en claro y no decía quién actuó. */
export const CONSENT_EVIDENCE_VERSION = 2;

/** Quién actuó, tal como queda escrito en la evidencia: sin nombre (cambia), con el rol de ese día. */
export interface ConsentActor {
  userId: string;
  email: string;
  /** membership.role hoy; role.key con ACC-3. */
  roleKey: string;
}

export interface ConsentEvidenceInput {
  method: "public_handle" | "oauth";
  /** Por @: la casilla marcada. En OAuth es false: la prueba de titularidad la da la plataforma. */
  declaredOwner: boolean;
  ip: string | null;
  userAgent: string | null;
  textShown: string;
  policyVersion: string;
  at: Date;
  /** A nombre de quién: el creator_profile del workspace. */
  creatorId: string;
  /** Quién abrió la sesión (getSessionMember), o null sin sesión (modo demo). */
  actor: SessionMember | null;
  /** app_user del titular, o null si el perfil no tiene cuenta. Si actor es el titular, actedBy se omite. */
  creatorUserId: string | null;
  /** Lo que cada camino ya guardaba en v1: handle, platformId, source | scopesRequested, scopesGranted. */
  extra?: Record<string, unknown>;
}

export interface ConsentEvidence extends Record<string, unknown> {
  v: typeof CONSENT_EVIDENCE_VERSION;
  method: "public_handle" | "oauth";
  declaredOwner: boolean;
  ipHash: string | null;
  userAgent: string | null;
  textShown: string;
  policyVersion: string;
  at: string;
  onBehalfOf: { creatorId: string };
  actedBy?: ConsentActor;
}

/**
 * sha256 de la IP en hex: sirve para confirmar una IP conocida sin
 * guardar la dirección en claro. Sin sal a propósito: una sal por
 * despliegue haría la evidencia inverificable cuando rote.
 */
export function ipHash(ip: string | null): string | null {
  const v = ip?.trim();
  return v ? createHash("sha256").update(v).digest("hex") : null;
}

/** ¿Actúa un tercero? Sí cuando hay sesión y no es la del titular. */
export function actedByFor(actor: SessionMember | null, creatorUserId: string | null): ConsentActor | undefined {
  if (!actor || actor.userId === creatorUserId) return undefined;
  return { userId: actor.userId, email: actor.email, roleKey: actor.roleKey };
}

/** La evidencia v2 de una fila de data_consent. Sin tokens: quien la escribe la pasa por redactSecrets. */
export function buildConsentEvidence(input: ConsentEvidenceInput): ConsentEvidence {
  const actedBy = actedByFor(input.actor, input.creatorUserId);
  return {
    ...input.extra,
    v: CONSENT_EVIDENCE_VERSION,
    method: input.method,
    declaredOwner: input.declaredOwner,
    ipHash: ipHash(input.ip),
    userAgent: input.userAgent,
    textShown: input.textShown,
    policyVersion: input.policyVersion,
    at: input.at.toISOString(),
    onBehalfOf: { creatorId: input.creatorId },
    ...(actedBy ? { actedBy } : {}),
  };
}

/** La misma forma para la revocación (evidence.revocation): quién quitó la cuenta, cuándo y a nombre de quién. */
export function buildRevocationEvidence(input: { at: Date; creatorId: string; actor: SessionMember | null; creatorUserId: string | null }): Record<string, unknown> {
  const actedBy = actedByFor(input.actor, input.creatorUserId);
  return { v: CONSENT_EVIDENCE_VERSION, at: input.at.toISOString(), onBehalfOf: { creatorId: input.creatorId }, ...(actedBy ? { actedBy } : {}) };
}

export const PLATFORM_LABEL: Record<OAuthProviderId, string> = {
  tiktok: "TikTok",
  "tiktok-business": "TikTok (analítica avanzada)",
  instagram: "Instagram",
  youtube: "YouTube",
};

/** Scopes que habilitan la finalidad audience_demographics; el resto solo analytics. */
export const DEMOGRAPHICS_SCOPES: Record<OAuthProviderId, readonly string[]> = {
  tiktok: [],
  "tiktok-business": ["user.insights", "video.insights"],
  instagram: ["instagram_business_manage_insights"],
  // yt-analytics.readonly es lo que abre reports.query, de donde salen la
  // demografía y la retención del canal (CON-8).
  youtube: ["https://www.googleapis.com/auth/yt-analytics.readonly"],
};

export function consentText(provider: OAuthProviderId): string {
  const red = PLATFORM_LABEL[provider];
  return (
    `Al conectar tu cuenta de ${red}, On Cue leerá tu perfil público, la lista de tus publicaciones y sus métricas ` +
    `(vistas, me gusta, comentarios, compartidos y, si la red lo entrega, alcance y retención) para mostrarte tu ` +
    `rendimiento, calcular tu línea base y preparar tus reportes. Guardamos una copia diaria de esas métricas: ` +
    `las plataformas dejan de actualizarlas con el tiempo y esa copia es tu archivo. No publicamos nada en tu ` +
    `nombre ni compartimos tus datos con marcas sin un consentimiento aparte. El acceso se guarda cifrado y puedes ` +
    `revocarlo cuando quieras con «Desconectar», o desde los ajustes de ${red}.`
  );
}

/** Qué finalidades quedan consentidas según los scopes que la plataforma concedió de verdad. */
export function purposesFor(provider: OAuthProviderId, scopesGranted: readonly string[]): ConsentPurpose[] {
  const out: ConsentPurpose[] = ["analytics"];
  if (DEMOGRAPHICS_SCOPES[provider].some((s) => scopesGranted.includes(s))) out.push("audience_demographics");
  return out;
}
