/**
 * Entregabilidad · la baja desde el enlace y la política de outreach
 * editable (VEN-15). Dueño: Rasheed.
 *
 * La pantalla /ventas/politica lee y guarda outbound_policy con un
 * WorkspaceTx: el workspace es el de la transacción (current_workspace_id()),
 * nunca uno que mande la pantalla, y la RLS de 0017 aísla la fila.
 *
 * Lo que NO se escribe desde aquí:
 *   · enabled: el interruptor va por enableOutreach / disableOutreach
 *     (@mc/db/queries/outreach), que además cancelan lo pendiente al
 *     apagar;
 *   · llm_daily_cap_usd: lo fija la plataforma (outbound_policy_llm_cap);
 *   · require_optout_link: el pie de baja es obligatorio (CAN-SPAM), no
 *     un ajuste.
 */
import { looksLikeOptoutToken } from '@mc/core/outreach/deliverability';
import { WARMUP_MAX_DAYS } from '@mc/core/outreach/warmup';
import { isUuid, type PublicShareTx, type WorkspaceTx } from '../client.ts';
import { OutreachShapeError, publicOptout } from './outreach.ts';

// ---------------------------------------------------------------------
// La baja desde el enlace de un correo
// ---------------------------------------------------------------------
//
// La página /baja/<token> y el POST de un clic (List-Unsubscribe) pasan
// por aquí. El token es opaco (32 bytes al azar, @mc/core): TODO se
// decide por su sha256 en la base, sin secretos. En orden:
//   1. lo que no tiene forma de token no llega a la base;
//   2. public_optout_preview (0038 §5) dice si el enlace existe, para qué
//      dirección (enmascarada), quién la escribe y si quien lo abre con
//      sesión es miembro del workspace que envió: el enlace también queda
//      en la carpeta de enviados del Gmail del creador, y su clic
//      suprimiría a la marca en toda la plataforma (docs/ventas-outreach.md
//      §5.2, «Obligatorio para VEN-15»);
//   3. public_optout, sin sesión: marca la ficha, suprime la dirección y
//      cancela lo pendiente en todos los workspaces.

/** Las dos puertas que necesita la baja; la web las arma con su sesión y su cliente. */
export interface OptoutGates {
  withPublicShare<T>(fn: (tx: PublicShareTx) => Promise<T>): Promise<T>;
  /** Los workspaces de quien abre el enlace, si tiene sesión; [] si no la tiene. */
  sessionWorkspaceIds(): Promise<readonly string[]>;
}

/** Lo que responde public_optout_preview (0038 §5), comprobado. */
export type OptoutPreview =
  | { status: 'not_found' }
  | { status: 'ok'; maskedAddress: string; senderName: string | null; isSender: boolean; alreadyOptedOut: boolean };

/** Comprueba la forma del jsonb de public_optout_preview. */
export function parseOptoutPreview(value: unknown): OptoutPreview {
  const fn = 'public_optout_preview';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new OutreachShapeError(fn, '$', 'se esperaba un objeto');
  const r = value as Record<string, unknown>;
  if (r.status === 'not_found') return { status: 'not_found' };
  if (r.status !== 'ok') throw new OutreachShapeError(fn, '$.status', `estado desconocido «${String(r.status)}»`);
  if (typeof r.maskedAddress !== 'string' || !r.maskedAddress.includes('@')) {
    throw new OutreachShapeError(fn, '$.maskedAddress', 'se esperaba una dirección enmascarada');
  }
  if (r.senderName !== null && typeof r.senderName !== 'string') throw new OutreachShapeError(fn, '$.senderName', 'se esperaba texto o null');
  for (const k of ['isSender', 'alreadyOptedOut'] as const) {
    if (typeof r[k] !== 'boolean') throw new OutreachShapeError(fn, `$.${k}`, 'se esperaba boolean');
  }
  return {
    status: 'ok',
    maskedAddress: r.maskedAddress,
    senderName: (r.senderName as string | null) ?? null,
    isSender: r.isSender as boolean,
    alreadyOptedOut: r.alreadyOptedOut as boolean,
  };
}

/**
 * Lo que la página de baja puede decir del enlace antes del clic. Sin
 * sesión, `viewerWorkspaces` es []; los que no son uuid se descartan.
 */
export async function publicOptoutPreview(
  tx: PublicShareTx,
  token: string,
  viewerWorkspaces: readonly string[],
): Promise<OptoutPreview> {
  const mios = viewerWorkspaces.filter((id) => isUuid(id));
  const r = (await tx.query<{ r: unknown }>('SELECT public_optout_preview($1::text, $2::uuid[]) AS r', [token, mios])).rows[0]?.r;
  return parseOptoutPreview(r);
}

export type OptoutLinkCheck =
  | { status: 'valid'; maskedAddress: string; senderName: string | null; alreadyOptedOut: boolean }
  | { status: 'not_found' }
  | { status: 'sender' };

export type OptoutFromLinkResult =
  | { status: 'ok'; alreadyOptedOut: boolean }
  | { status: 'not_found' }
  | { status: 'sender' };

/**
 * Lo que la página puede decir ANTES de pedir la confirmación: si el
 * enlace es de un correo que la plataforma envió, para qué dirección y
 * de quién, y si quien lo abre es quien lo envió. No escribe nada.
 */
export async function checkOptoutLink(gates: OptoutGates, token: string): Promise<OptoutLinkCheck> {
  if (!looksLikeOptoutToken(token)) return { status: 'not_found' };
  const mios = await gates.sessionWorkspaceIds();
  const p = await gates.withPublicShare((tx) => publicOptoutPreview(tx, token, mios));
  if (p.status === 'not_found') return p;
  if (p.isSender) return { status: 'sender' };
  return { status: 'valid', maskedAddress: p.maskedAddress, senderName: p.senderName, alreadyOptedOut: p.alreadyOptedOut };
}

/**
 * La baja de punta a punta. `alreadyOptedOut` es para el texto («ya
 * estabas dado de baja»); el workspace y el toque no salen de aquí: quien
 * pulsa el enlace no tiene por qué saber cuántos creadores le escriben.
 */
export async function optoutFromLink(gates: OptoutGates, token: string): Promise<OptoutFromLinkResult> {
  const chequeo = await checkOptoutLink(gates, token);
  if (chequeo.status !== 'valid') return chequeo;
  const r = await gates.withPublicShare((tx) => publicOptout(tx, token));
  if (r.status === 'not_found') return { status: 'not_found' };
  return { status: 'ok', alreadyOptedOut: r.alreadyOptedOut };
}

/** Los rangos que acepta la pantalla. max_emails_per_day no pasa del techo del correo (CHANNEL_CAP_LIMITS). */
export const POLICY_LIMITS = {
  maxTouchesPerCompany: { min: 1, max: 12 },
  minDaysBetweenTouches: { min: 1, max: 30 },
  maxEmailsPerDay: { min: 1, max: 2000 },
  cooldownDaysAfterNo: { min: 0, max: 730 },
  warmupDays: { min: 0, max: WARMUP_MAX_DAYS },
} as const;

export const POSTAL_ADDRESS_MAX = 300;

/** Los valores de una política que todavía no existe: los DEFAULT de 0007 y 0037. */
export const POLICY_DEFAULTS = {
  maxTouchesPerCompany: 4,
  minDaysBetweenTouches: 3,
  maxEmailsPerDay: 20,
  cooldownDaysAfterNo: 180,
  requireHumanReview: true,
  claimsMustBeSourced: true,
  warmupDays: 14,
  postalAddress: null as string | null,
} as const;

export interface OutboundPolicyView {
  /** false si el workspace nunca guardó su política: lo de abajo son los valores por defecto. */
  saved: boolean;
  maxTouchesPerCompany: number;
  minDaysBetweenTouches: number;
  maxEmailsPerDay: number;
  cooldownDaysAfterNo: number;
  requireHumanReview: boolean;
  claimsMustBeSourced: boolean;
  warmupDays: number;
  postalAddress: string | null;
  enabled: boolean;
  disabledReason: string | null;
  disabledAt: string | null;
  /** Tope diario de gasto en el modelo, en USD, como decimal en texto. Solo lectura. */
  llmDailyCapUsd: string;
  updatedAt: string | null;
}

export type OutboundPolicyInput = Pick<
  OutboundPolicyView,
  | 'maxTouchesPerCompany'
  | 'minDaysBetweenTouches'
  | 'maxEmailsPerDay'
  | 'cooldownDaysAfterNo'
  | 'requireHumanReview'
  | 'claimsMustBeSourced'
  | 'warmupDays'
  | 'postalAddress'
>;

interface PolicyRow {
  max_touches_per_company: number;
  min_days_between_touches: number;
  max_emails_per_day: number;
  cooldown_days_after_no: number;
  require_human_review: boolean;
  claims_must_be_sourced: boolean;
  warmup_days: number;
  postal_address: string | null;
  enabled: boolean;
  disabled_reason: string | null;
  disabled_at: Date | string | null;
  llm_daily_cap_usd: string;
  updated_at: Date | string | null;
}

const COLUMNAS = `max_touches_per_company, min_days_between_touches, max_emails_per_day, cooldown_days_after_no,
  require_human_review, claims_must_be_sourced, warmup_days, postal_address, enabled, disabled_reason, disabled_at,
  llm_daily_cap_usd::text AS llm_daily_cap_usd, updated_at`;

function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function toView(r: PolicyRow | undefined, defaultCap: string): OutboundPolicyView {
  if (!r) {
    return { saved: false, ...POLICY_DEFAULTS, enabled: false, disabledReason: null, disabledAt: null, llmDailyCapUsd: defaultCap, updatedAt: null };
  }
  return {
    saved: true,
    maxTouchesPerCompany: r.max_touches_per_company,
    minDaysBetweenTouches: r.min_days_between_touches,
    maxEmailsPerDay: r.max_emails_per_day,
    cooldownDaysAfterNo: r.cooldown_days_after_no,
    requireHumanReview: r.require_human_review,
    claimsMustBeSourced: r.claims_must_be_sourced,
    warmupDays: r.warmup_days,
    postalAddress: r.postal_address,
    enabled: r.enabled,
    disabledReason: r.disabled_reason,
    disabledAt: iso(r.disabled_at),
    llmDailyCapUsd: r.llm_daily_cap_usd,
    updatedAt: iso(r.updated_at),
  };
}

/** La política del workspace de la transacción, o los valores por defecto si nunca se guardó. */
export async function getOutboundPolicy(tx: WorkspaceTx): Promise<OutboundPolicyView> {
  const { rows } = await tx.query<PolicyRow>(
    `SELECT ${COLUMNAS} FROM outbound_policy WHERE workspace_id = current_workspace_id()`,
  );
  const cap = rows[0]
    ? rows[0].llm_daily_cap_usd
    : ((await tx.query<{ c: string }>('SELECT outreach_default_llm_daily_cap()::text AS c')).rows[0]?.c ?? '5.00');
  return toView(rows[0], cap);
}

/** La dirección postal se quitó con el envío encendido: la base lo rechaza (outbound_policy_enabled_needs_address). */
export class PolicyNeedsAddressError extends Error {
  constructor() {
    super('Con el envío encendido la política necesita dirección postal.');
    this.name = 'PolicyNeedsAddressError';
  }
}

function assertInRange(campo: keyof typeof POLICY_LIMITS, v: number): void {
  const { min, max } = POLICY_LIMITS[campo];
  if (!Number.isInteger(v) || v < min || v > max) throw new RangeError(`${campo} fuera de rango: ${v} (de ${min} a ${max}).`);
}

/**
 * Guarda la política (la crea si no existía, apagada). Devuelve la fila
 * como queda. El interruptor y el tope del modelo no se tocan.
 */
export async function saveOutboundPolicy(tx: WorkspaceTx, input: OutboundPolicyInput): Promise<OutboundPolicyView> {
  assertInRange('maxTouchesPerCompany', input.maxTouchesPerCompany);
  assertInRange('minDaysBetweenTouches', input.minDaysBetweenTouches);
  assertInRange('maxEmailsPerDay', input.maxEmailsPerDay);
  assertInRange('cooldownDaysAfterNo', input.cooldownDaysAfterNo);
  assertInRange('warmupDays', input.warmupDays);
  const direccion = input.postalAddress?.trim() || null;
  if (direccion && direccion.length > POSTAL_ADDRESS_MAX) {
    throw new RangeError(`postalAddress pasa de ${POSTAL_ADDRESS_MAX} caracteres.`);
  }
  try {
    const { rows } = await tx.query<PolicyRow>(
      `INSERT INTO outbound_policy AS p (workspace_id, max_touches_per_company, min_days_between_touches,
         max_emails_per_day, cooldown_days_after_no, require_human_review, claims_must_be_sourced, warmup_days,
         postal_address)
       VALUES (current_workspace_id(), $1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (workspace_id) DO UPDATE SET
         max_touches_per_company = EXCLUDED.max_touches_per_company,
         min_days_between_touches = EXCLUDED.min_days_between_touches,
         max_emails_per_day = EXCLUDED.max_emails_per_day,
         cooldown_days_after_no = EXCLUDED.cooldown_days_after_no,
         require_human_review = EXCLUDED.require_human_review,
         claims_must_be_sourced = EXCLUDED.claims_must_be_sourced,
         warmup_days = EXCLUDED.warmup_days,
         postal_address = EXCLUDED.postal_address
       RETURNING ${COLUMNAS}`,
      [
        input.maxTouchesPerCompany, input.minDaysBetweenTouches, input.maxEmailsPerDay, input.cooldownDaysAfterNo,
        input.requireHumanReview, input.claimsMustBeSourced, input.warmupDays, direccion,
      ],
    );
    return toView(rows[0], rows[0]?.llm_daily_cap_usd ?? '5.00');
  } catch (err) {
    const e = err as { code?: string; constraint?: string };
    if (e.code === '23514' && e.constraint === 'outbound_policy_enabled_needs_address') throw new PolicyNeedsAddressError();
    throw err;
  }
}
