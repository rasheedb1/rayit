/**
 * Consentimiento explícito por finalidad (data_consent, migración 0002).
 * El texto que ve el creador se guarda tal cual en evidence.textShown
 * junto con la versión de la política: si el texto cambia, cambia la
 * versión, y el consentimiento viejo queda con el texto viejo.
 *
 * Habeas data (Ley 1581 de 2012) exige decir qué se recoge, para qué y
 * cómo se revoca. Sin jerga: es lo que lee una creadora en un diálogo.
 */
import type { ConsentPurpose } from "@mc/db";
import type { OAuthProviderId } from "@mc/connectors";

export const CONSENT_POLICY_VERSION = "2026-09-22";

export const PLATFORM_LABEL: Record<OAuthProviderId, string> = {
  tiktok: "TikTok",
  "tiktok-business": "TikTok (analítica avanzada)",
  instagram: "Instagram",
};

/** Scopes que habilitan la finalidad audience_demographics; el resto solo analytics. */
export const DEMOGRAPHICS_SCOPES: Record<OAuthProviderId, readonly string[]> = {
  tiktok: [],
  "tiktok-business": ["user.insights", "video.insights"],
  instagram: ["instagram_business_manage_insights"],
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
