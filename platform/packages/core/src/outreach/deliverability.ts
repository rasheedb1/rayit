/**
 * Entregabilidad y cumplimiento del correo saliente (VEN-15). Dueño: Rasheed.
 *
 * Índice: cada pieza vive en su módulo (r5) y aquí solo se reexporta,
 * para que ningún import cambie.
 *
 *   ./unsubscribe.ts El enlace de baja: createOptoutToken / looksLikeOptoutToken /
 *                   optoutTokenHash, maskEmailAddress, optoutUrl,
 *                   oneClickUnsubscribeUrl, listUnsubscribeHeaders
 *   ./footer.ts     El pie obligatorio: complianceReadiness / buildEmailFooter
 *   ./deliverability-messages.ts  Los textos del pie por idioma y la regla del idioma
 *                   (outreachLanguage, footerTextsFor)
 *   ./warmup.ts     El calentamiento: warmupDay / warmupDailyLimit / warmupCurve
 *   ./bounces.ts    Los rebotes: detectBounce
 *   ./alerts.ts     Las alertas: evaluateOutreachAlerts, bounceRateStatus
 *   ./channels.ts   Cómo se nombra una cuenta de canal (channelAccountLabel)
 *
 * Funciones puras: ni base, ni red, ni reloj propio (el instante y el azar
 * entran como parámetro cuando hacen falta). Las usan el despachador
 * (VEN-10) al armar cada correo, la página pública de baja y los jobs de
 * rebotes y alertas del worker. Ver docs/ventas-outreach.md §4 y §5.1.
 *
 * Se importa por su ruta (`@mc/core/outreach/deliverability`), no desde
 * `@mc/core`: unsubscribe.ts usa node:crypto, y el índice del paquete también
 * lo leen componentes de cliente. Un componente de cliente importa el
 * módulo que necesita (`@mc/core/outreach/warmup`, `…/alerts`).
 */
export * from './unsubscribe.ts';
export * from './footer.ts';
export * from './deliverability-messages.ts';
export * from './warmup.ts';
export * from './bounces.ts';
export * from './alerts.ts';
export * from './channels.ts';
