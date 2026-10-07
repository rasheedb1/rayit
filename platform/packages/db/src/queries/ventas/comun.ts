/**
 * Ventas · lo común: los errores de dominio (VentasError y su código, que
 * la web traduce en su messages.ts), los tipos de las filas que devuelven
 * las consultas, la búsqueda y la forma comparable de un dominio.
 * Dueño: Rasheed. Las reglas del módulo están en ../ventas.ts.
 */
import { CONTACT_SOURCES, LOST_REASONS, NEXT_ACTION_KINDS, RELATIONSHIPS, SIGNAL_STATUSES } from '../../schema/ventas.ts';
import { type ReplyOptOutChannel } from '../canales.ts';
import { type BriefVerdict } from '../brief.ts';
import { type SignalVia } from './radar.ts';

export { CONTACT_SOURCES, LOST_REASONS, NEXT_ACTION_KINDS, RELATIONSHIPS, SIGNAL_STATUSES };

/** Procedencia de un contacto. Sin ella no se guarda (VEN-1). */
export type ContactSource = (typeof CONTACT_SOURCES)[number];
/** Relación del workspace con la empresa (company_link). */
export type Relationship = (typeof RELATIONSHIPS)[number];
/** Por qué se perdió un negocio (deal.lost_reason, CHECK de 0007). */
export type LostReason = (typeof LOST_REASONS)[number];

/**
 * Los códigos de error de Ventas. Esta capa no tiene idioma: lleva el
 * código (y, si hace falta, los datos para componer la frase) y la
 * pantalla lo traduce con su messages.ts (MESSAGES.errores), igual que
 * Cotizar. Traducir Ventas no toca @mc/db.
 */
export const VENTAS_ERROR_CODES = [
  'CompanyNotFound',
  'CompanyNotEditable',
  'CompanyCreateFailed',
  'ContactNotFound',
  'ContactNotOwned',
  'ContactCreateFailed',
  'DealNotFound',
  'DealCreateFailed',
  'DealCreatorRequired',
  'DealLocked',
  'DuplicateDomain',
  'DuplicateEmail',
  'EmptyContact',
  'InvalidAmount',
  'InvalidCompany',
  'InvalidCreator',
  'InvalidDealName',
  'InvalidHeadline',
  'InvalidName',
  'NoCreatorInScope',
  'InvalidOwner',
  'InvalidReason',
  'InvalidRelationship',
  'InvalidSource',
  'InvalidStage',
  'LostReasonRequired',
  'AmountRequired',
  'DuplicateCompanyName',
  'SignalAlreadyReviewed',
  'SignalNotFound',
  'SignalWithoutCompany',
] as const;

export type VentasErrorCode = (typeof VENTAS_ERROR_CODES)[number];

/**
 * Base de los errores de Ventas: un código y sus datos, sin frase.
 * `message` es el código, que es lo que sirve en un registro.
 */
export class VentasError extends Error {
  readonly code: VentasErrorCode;
  /** Lo que la frase necesita: el nombre de la empresa que ya tiene el dominio, el motivo de un bloqueo… */
  readonly params: Readonly<Record<string, string>>;
  constructor(code: VentasErrorCode, params: Record<string, string> = {}) {
    super(code);
    this.name = code;
    this.code = code;
    this.params = params;
  }
}

export class CompanyNotFound extends VentasError {
  constructor() {
    super('CompanyNotFound');
  }
}

/**
 * Editar el nombre, el dominio o la ficha de una empresa del catálogo
 * compartido (sin dueño). Se puede vincular y trabajar con ella —su
 * relación y sus notas son de este workspace—, pero sus datos son de
 * todos y solo los escribe el worker (0024 §4, company_write).
 */
export class CompanyNotEditable extends VentasError {
  constructor() {
    super('CompanyNotEditable');
  }
}

export class ContactNotFound extends VentasError {
  constructor() {
    super('ContactNotFound');
  }
}

export class SignalNotFound extends VentasError {
  constructor() {
    super('SignalNotFound');
  }
}

export class DealNotFound extends VentasError {
  constructor() {
    super('DealNotFound');
  }
}

export class SignalAlreadyReviewed extends VentasError {
  constructor() {
    super('SignalAlreadyReviewed');
  }
}

/** El dominio ya es de otra empresa: `params.name` dice cuál. */
export class DuplicateDomain extends VentasError {
  constructor(name: string) {
    super('DuplicateDomain', { name });
  }
}

/**
 * Ya hay en el CRM de este workspace una empresa con el mismo nombre
 * (brand_key: sin tildes, mayúsculas ni signos, «Zumos Ñandú» =
 * «ZUMOS ÑANDU») y sin un dominio distinto que las separe.
 * `params.name` y `params.companyId` dicen cuál, para enlazarla. No es
 * un error de verdad: la pantalla ofrece «Crear igual»
 * (CreateCompanyInput.allowSameNameAs).
 */
export class DuplicateCompanyName extends VentasError {
  constructor(name: string, companyId: string) {
    super('DuplicateCompanyName', { name, companyId });
  }
}

/**
 * Escribir un contacto ajeno. La política de 0020 no distingue «no
 * existe» de «no es tuyo» a propósito (decir cuál sería filtrar la
 * existencia de la fila), así que el código tampoco.
 */
export class ContactNotOwned extends VentasError {
  constructor() {
    super('ContactNotOwned');
  }
}

/**
 * Sacar de «Ganado» un negocio que ya tiene campaña (no cancelada) o
 * una cotización aceptada cuya campaña aún no existe (0031,
 * deal_move_stage). `params.reason` es 'campaign' o 'quote'.
 */
export class DealLocked extends VentasError {
  constructor(reason: 'campaign' | 'quote') {
    super('DealLocked', { reason });
  }
}

export interface CompanyListRow {
  id: string;
  name: string;
  domain: string | null;
  country: string | null;
  city: string | null;
  industry: string | null;
  nicheSlugs: string[];
  sizeBucket: string | null;
  relationship: Relationship;
  /** 0..1 como string decimal, o null. */
  fitScore: string | null;
  ownerUserId: string | null;
  ownerName: string | null;
  notes: string | null;
  /** Contactos visibles de la empresa (los míos y los de fuente pública). */
  contactCount: number;
  /** De esos, cuántos pidieron la baja. */
  optedOutCount: number;
  /** Negocios ni ganados ni perdidos. */
  openDealCount: number;
  /**
   * Suma de los abiertos que tienen monto, en la moneda del workspace,
   * como string decimal. NULL si ninguno lo tiene (un negocio que nace
   * de una señal sin presupuesto): la pantalla dice «Sin monto», no
   * «COP 0», igual que el pipeline.
   */
  openDealAmount: string | null;
  /** Última actividad registrada para la empresa, ISO o null. */
  lastActivityAt: string | null;
  /** Señales pendientes de revisar de esta empresa que se ven en la bandeja. */
  pendingSignalCount: number;
  /** Las pendientes que el brief activo deja fuera de la bandeja (VEN-7): se ven con «Verlas» (/ventas?ocultas=1). */
  hiddenSignalCount: number;
  linkedAt: string;
}

export interface CompanyDetail extends CompanyListRow {
  /**
   * La ficha es de este workspace (company.owner_workspace_id) y se
   * edita desde aquí. False en una empresa del catálogo compartido: de
   * ella solo son de este workspace la relación, el responsable y las
   * notas (company_link).
   */
  isOwn: boolean;
  legalName: string | null;
  socials: Record<string, string>;
  runsAds: boolean | null;
  adsPlatforms: string[];
  logoUrl: string | null;
  enrichedAt: string | null;
}

export interface ContactRow {
  id: string;
  companyId: string;
  fullName: string | null;
  roleTitle: string | null;
  email: string | null;
  phone: string | null;
  linkedinUrl: string | null;
  instagramHandle: string | null;
  source: ContactSource;
  sourceUrl: string | null;
  optedOut: boolean;
  optedOutAt: string | null;
  optedOutReason: string | null;
  /**
   * Se dio de baja al responder pidiéndolo por ese canal (contact.opted_out_code,
   * 0052). La pantalla lo traduce; opted_out_reason, si lo hay, manda.
   */
  optedOutByReply: ReplyOptOutChannel | null;
  bounced: boolean;
  /**
   * Por qué y cuándo rebotó (contact.email_invalid_reason y _at, 0055):
   * el diagnóstico del servidor que lo rechazó. Null si no rebotó, o si
   * rebotó antes de 0055 (solo bounced, sin motivo).
   */
  bouncedReason: string | null;
  bouncedAt: string | null;
  /**
   * Lo guardó este workspace. Un contacto visible pero ajeno (fuente
   * pública, guardado por otro) se lee y no se edita: la pantalla lo
   * muestra sin los botones, y la base lo rechazaría igual.
   */
  isOwn: boolean;
  createdAt: string;
}

export interface SignalRow {
  id: string;
  /**
   * La empresa de la señal: la enlazada o, si la señal todavía no tiene
   * (una manual o de CSV de una marca que se anotó después en el CRM),
   * la que acceptSignal resolvería (resolveCompany: dominio o, sin él,
   * nombre dentro del CRM). Null si al aceptarla nacería una empresa.
   */
  companyId: string | null;
  companyName: string | null;
  companyDomain: string | null;
  /** La empresa ya está vinculada a este workspace («Ya en tu CRM»). */
  companyLinked: boolean;
  /**
   * El negocio abierto de esa empresa al que se sumaría la señal al
   * aceptarla (el mismo que elige acceptSignal); null si aceptarla abre
   * uno nuevo (pulido r8).
   */
  openDealId: string | null;
  openDealName: string | null;
  /**
   * Cuántos negocios abiertos tiene esa empresa: «No aceptar esta marca»
   * avisa que sus toques programados se cancelan (brief_excluded).
   */
  openDealCount: number;
  sourceId: string;
  sourceLabel: string;
  headlineEs: string;
  detectedAt: string;
  evidenceUrl: string | null;
  fitScore: string | null;
  budgetEstimate: string | null;
  budgetCurrency: string | null;
  dedupeKey: string;
  status: SignalStatus;
  discardReason: string | null;
  reviewedAt: string | null;
  /** 'csv' si entró por una lista importada; 'manual' si la escribió alguien. */
  via: SignalVia;
  /**
   * Por qué el brief activo la deja fuera de la bandeja (VEN-7): su
   * empresa o su categoría están excluidas. Null si se ve. Solo llega
   * distinto de null en las pendientes pedidas con `brief: 'show_hidden'`.
   */
  hiddenBy: BriefVerdict | null;
  /**
   * La regla que la oculta, como la escribió el creador: la categoría
   * excluida («harinas») o el nombre de la marca excluida. Null si se ve.
   */
  hiddenMatch: string | null;
  /** Cómo encaja con «Qué buscas» del brief activo (VEN-7). No oculta nada: la tarjeta lo dice. */
  briefFit: SignalBriefFit;
}

/**
 * El encaje de una señal pendiente con lo que busca el brief activo,
 * calculado en SQL (briefSignalLateralSql). Todo en falso y null sin
 * brief activo, y en las que no están pendientes.
 */
export interface SignalBriefFit {
  /** El presupuesto estimado está por debajo del mínimo del brief, en la misma moneda. */
  belowMinBudget: boolean;
  /** El país de la señal (o de su empresa) no está entre los que busca el brief. */
  countryOutside: boolean;
  /** La primera categoría buscada que tiene la marca, como la escribió el creador; null si ninguna. */
  wantedCategory: string | null;
  /**
   * El brief busca categorías y la marca no tiene ninguna de ellas (para
   * todos los briefs activos que buscan alguna). Es lo que la tarjeta
   * marca: una señal que encaja no necesita nota, una que no, sí.
   */
  categoryOutside: boolean;
}

export type SignalStatus = (typeof SIGNAL_STATUSES)[number];

export interface PipelineDealRow {
  id: string;
  companyId: string;
  companyName: string;
  name: string;
  stageId: string;
  stageLabel: string;
  stagePosition: number;
  amount: string | null;
  currency: string;
  probability: string;
  weightedAmount: string | null;
  nextAction: string | null;
  /** El instante en que vence la siguiente acción, ISO en UTC. */
  nextActionDue: string | null;
  /** El día en que vence, en la zona del espacio: «2026-09-24». Para el <input type="date"> del editor (VEN-4). */
  nextActionDueDate: string | null;
  /** La hora en que vence, en la zona del espacio: «15:00». */
  nextActionDueTime: string | null;
  /** Quien tiene que hacer la siguiente acción (deal.next_action_user_id) y su nombre. */
  nextActionUserId: string | null;
  nextActionUserName: string | null;
  dueState: DueState;
  /** La última llamada, correo o reunión con la marca por este negocio, ISO en UTC (logActivity la mueve). */
  lastContactAt: string | null;
  /**
   * Hace cuántos días fue, contados por días de calendario en la zona del
   * espacio (0 hoy, 1 ayer); null sin contacto. Sale de SQL para que la
   * pantalla no reste fechas: «Último contacto: hace 3 días».
   */
  lastContactDays: number | null;
  expectedCloseDate: string | null;
  isWon: boolean;
  isLost: boolean;
  /** Días en la etapa actual: desde el último cambio, o desde que nació. */
  daysInStage: number;
  /** El responsable del negocio: el que se propone para la siguiente acción cuando no tiene. */
  ownerUserId: string | null;
  ownerName: string | null;
  /** Por qué se perdió; solo en un negocio en una etapa perdida. */
  lostReason: LostReason | null;
  /**
   * De qué creador es (ACC-7) y su nombre; null es «sin creador», que con
   * alcance por creador solo ve quien ve a todos. Se cambia con
   * setDealCreator.
   */
  creatorId: string | null;
  creatorName: string | null;
}

export type DueState = 'sin_fecha' | 'vencido' | 'hoy' | 'futuro';

export interface SalesKpis {
  /** Señales en la bandeja. */
  pendingSignals: number;
  openDeals: number;
  /** Suma de los abiertos, string decimal. */
  openAmount: string;
  /** Suma de amount × probabilidad de los abiertos, string decimal. */
  weightedAmount: string;
  /** Ganados en el trimestre en curso (won_at). */
  wonQuarter: string;
  wonQuarterCount: number;
  /**
   * De esos, los que no tienen monto (ganados antes de que «Ganado» lo
   * pidiera, pulido r7): el conteo sube y la suma no, y la pantalla lo
   * dice para que las dos cifras cuadren.
   */
  wonQuarterNoAmountCount: number;
  /** Abiertos sin siguiente acción: la fila que hay que arreglar. */
  noNextActionCount: number;
  /** Abiertos con la siguiente acción vencida. */
  overdueCount: number;
  /** La del workspace: los KPI suman sin convertir, así que todo va en ella. */
  currency: string;
}

/** Longitud mínima de una búsqueda por nombre. Debajo de esto no se consulta. */
export const MIN_SEARCH = 3;

/** Texto de búsqueda listo para el trigram, o null si no llega al mínimo. */
export function searchTerm(raw: string | undefined | null): string | null {
  const q = (raw ?? '').trim();
  return q.length >= MIN_SEARCH ? q : null;
}

/**
 * Un dominio como lo escribe una persona: con https://, con www, con
 * una ruta detrás, o en mayúsculas. Sale siempre el host en minúsculas,
 * que es lo que compara el índice único de `company (domain)`.
 */
export function normalizeDomain(raw: string | null | undefined): string | null {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return null;
  const sinEsquema = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const host = sinEsquema.split('/')[0]?.split('?')[0]?.replace(/^www\./, '') ?? '';
  return host || null;
}
