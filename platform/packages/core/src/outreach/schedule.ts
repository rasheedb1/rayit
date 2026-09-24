/**
 * Cuándo sale cada toque de una cadencia (VEN-10).
 *
 * Una sola implementación, en la zona de la cadencia: Chief tenía una
 * copia en el frontend y otra en el backend con la ventana 09:00–16:59
 * en UTC (docs/ventas-outreach.md §9). Aquí todo es local a la zona
 * IANA que se pasa, con Intl (zonas.ts): el cambio de horario lo
 * resuelve el motor de Intl, sin tablas a mano.
 *
 *   · Días hábiles: lunes a viernes. Los festivos no están (dependen del
 *     país y no hay tabla); es lo mismo que next_business_day de 0037.
 *   · day_offset se cuenta en DÍAS HÁBILES desde el día del enrolamiento
 *     (o el siguiente hábil si se enroló en fin de semana): el paso del
 *     día 9 nunca cae en sábado, y el orden de los pasos se conserva.
 *   · La hora del paso (outbound_step.scheduled_time) es la hora local;
 *     se le suma una dispersión DETERMINISTA (la semilla es el
 *     enrolamiento y el paso) y se encierra en la ventana laboral. La
 *     misma semilla da la misma hora: reprogramar no la cambia, y una
 *     prueba la puede afirmar.
 *   · Los reintentos esperan cada vez más (1, 4, 16, 64 minutos… hasta
 *     un tope), con una dispersión determinista de hasta un 20 %.
 *
 * Todo es puro: recibe instantes (Date) y devuelve instantes. Nada de
 * `new Date()` aquí dentro, para que el reloj lo ponga quien llama.
 */
import { desfase } from '../zonas.ts';

/** Un día de calendario local. month va de 1 a 12. */
export interface LocalDate {
  year: number;
  month: number;
  day: number;
}

/** La ventana laboral local en la que puede salir un toque: [start, end). */
export interface SendWindow {
  /** 'HH:MM' o 'HH:MM:SS'. */
  start: string;
  /** 'HH:MM' o 'HH:MM:SS'; exclusivo. */
  end: string;
}

/** La ventana por defecto (la de outbound_policy.send_window_*, 0038). */
export const DEFAULT_SEND_WINDOW: SendWindow = { start: '09:00', end: '17:00' };

/** Minutos de dispersión por defecto sobre la hora del paso. */
export const DEFAULT_SPREAD_MINUTES = 40;

/** Intentos de envío antes de dar un toque por fallido (fallos transitorios). */
export const MAX_SEND_ATTEMPTS = 5;

/** Espera del primer reintento y tope de la espera. */
export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 6 * 60 * 60 * 1000;

const DAY_S = 24 * 60 * 60;
const CLOCK_RE = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/;

/** 'HH:MM[:SS]' → segundos desde medianoche. Lanza si no es una hora. */
export function parseClock(value: string): number {
  const m = CLOCK_RE.exec(value.trim());
  if (!m) throw new Error(`No es una hora 'HH:MM': "${value}".`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

/** Comprueba que la zona sea IANA; Intl lanza RangeError si no. */
export function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
  } catch {
    throw new RangeError(`Zona horaria desconocida: "${timeZone}". Usa un nombre IANA, como America/Bogota.`);
  }
}

/** El día local y los segundos desde la medianoche local de un instante. */
export function zonedParts(at: Date, timeZone: string): { date: LocalDate; seconds: number } {
  const t = at.getTime();
  if (Number.isNaN(t)) throw new TypeError('zonedParts: la fecha no es válida.');
  const local = new Date(Math.floor(t / 1000) * 1000 + desfase(t, timeZone));
  return {
    date: { year: local.getUTCFullYear(), month: local.getUTCMonth() + 1, day: local.getUTCDate() },
    seconds: local.getUTCHours() * 3600 + local.getUTCMinutes() * 60 + local.getUTCSeconds(),
  };
}

/**
 * El instante de un día local a una hora local (segundos desde la
 * medianoche). Dos pasadas, como finDelDiaEnZona: la segunda corrige si
 * entre la conjetura y el resultado hay un cambio de horario. Una hora
 * que no existe (el salto de primavera) sale una hora después.
 */
export function zonedInstant(date: LocalDate, seconds: number, timeZone: string): Date {
  const local = Date.UTC(date.year, date.month - 1, date.day) + seconds * 1000;
  let t = local - desfase(local, timeZone);
  t = local - desfase(t, timeZone);
  return new Date(t);
}

function toUtcDay(d: LocalDate): number {
  return Date.UTC(d.year, d.month - 1, d.day) / 1000 / DAY_S;
}

function fromUtcDay(n: number): LocalDate {
  const d = new Date(n * DAY_S * 1000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Compara dos días: negativo si a va antes. */
export function compareDates(a: LocalDate, b: LocalDate): number {
  return toUtcDay(a) - toUtcDay(b);
}

export function addLocalDays(date: LocalDate, days: number): LocalDate {
  return fromUtcDay(toUtcDay(date) + days);
}

/** Día ISO de la semana: 1 lunes … 7 domingo. */
export function isoWeekday(date: LocalDate): number {
  const dow = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
  return dow === 0 ? 7 : dow;
}

export function isBusinessDay(date: LocalDate): boolean {
  return isoWeekday(date) <= 5;
}

/** El mismo día si es hábil; si no, el lunes siguiente. */
export function businessDayOnOrAfter(date: LocalDate): LocalDate {
  let d = date;
  while (!isBusinessDay(d)) d = addLocalDays(d, 1);
  return d;
}

/** El siguiente día hábil, estrictamente después de `date`. */
export function nextBusinessDate(date: LocalDate): LocalDate {
  return businessDayOnOrAfter(addLocalDays(date, 1));
}

/** `days` días hábiles después de `date` (que se lleva antes al hábil más cercano). */
export function addBusinessDays(date: LocalDate, days: number): LocalDate {
  if (!Number.isInteger(days) || days < 0) throw new RangeError(`addBusinessDays: días inválidos (${days}).`);
  let d = businessDayOnOrAfter(date);
  for (let i = 0; i < days; i++) d = nextBusinessDate(d);
  return d;
}

// ---------------------------------------------------------------------
// Dispersión determinista y ventana laboral
// ---------------------------------------------------------------------

/**
 * Un número en [0, 1) que depende solo de la semilla: FNV-1a de 32 bits
 * sobre el texto y una vuelta de mulberry32 para repartir los bits. No es
 * criptográfico: sirve para que dos contactos de la misma secuencia no
 * salgan en el mismo minuto, y para que la misma semilla dé siempre la
 * misma hora.
 */
export function seededUnit(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  let t = (h + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** Segundos de dispersión en [0, spreadMinutes·60), deterministas por semilla. */
export function spreadSeconds(seed: string, spreadMinutes: number = DEFAULT_SPREAD_MINUTES): number {
  if (!Number.isFinite(spreadMinutes) || spreadMinutes < 0) throw new RangeError(`Dispersión inválida (${spreadMinutes}).`);
  return Math.floor(seededUnit(seed) * spreadMinutes * 60);
}

/** La ventana en segundos, validada: el inicio va antes del final. */
export function windowSeconds(window: SendWindow): { start: number; end: number } {
  const start = parseClock(window.start);
  const end = parseClock(window.end);
  if (end <= start) throw new RangeError(`La ventana ${window.start}–${window.end} no tiene sentido: el final va antes del inicio.`);
  return { start, end };
}

/**
 * Encierra una hora del día (segundos) en la ventana [start, end): lo que
 * cae antes del inicio va al inicio, y lo que pasa del final da la vuelta
 * desde el inicio (así la dispersión no amontona todo al cierre).
 */
export function clampToWindow(seconds: number, window: SendWindow): number {
  const { start, end } = windowSeconds(window);
  if (seconds < start) return start;
  if (seconds < end) return seconds;
  return start + ((seconds - start) % (end - start));
}

/** ¿Está `at` dentro de la ventana de un día hábil, en la zona? */
export function isInsideWindow(at: Date, timeZone: string, window: SendWindow = DEFAULT_SEND_WINDOW): boolean {
  const { date, seconds } = zonedParts(at, timeZone);
  const { start, end } = windowSeconds(window);
  return isBusinessDay(date) && seconds >= start && seconds < end;
}

// ---------------------------------------------------------------------
// La hora de cada paso
// ---------------------------------------------------------------------

/** Lo que el motor sabe de un paso para programarlo (outbound_step). */
export interface PlanStep {
  id: string;
  /** Días HÁBILES desde el inicio de la cadencia. */
  dayOffset: number;
  orderInDay: number;
  /** outbound_step.scheduled_time, hora local 'HH:MM[:SS]'. */
  scheduledTime: string;
}

export interface PlanOptions {
  /** Cuándo se enroló (el reloj de quien llama). */
  enrolledAt: Date;
  /** Zona IANA de la cadencia (la de la secuencia o la del workspace). */
  timeZone: string;
  window?: SendWindow;
  spreadMinutes?: number;
  /** La semilla del enrolamiento (su id): cada paso le suma el suyo. */
  seed: string;
}

/** Separación mínima entre dos pasos del mismo enrolamiento. */
export const MIN_STEP_GAP_MS = 5 * 60 * 1000;

/**
 * La hora local de un paso, ya dispersa y dentro de la ventana, en
 * segundos desde la medianoche. Una hora anterior a la ventana arranca en
 * su inicio y se dispersa desde ahí.
 */
export function stepClockSeconds(
  step: Pick<PlanStep, 'id' | 'scheduledTime'>,
  opts: Pick<PlanOptions, 'seed' | 'window' | 'spreadMinutes'>,
): number {
  const window = opts.window ?? DEFAULT_SEND_WINDOW;
  const base = clampToWindow(parseClock(step.scheduledTime), window);
  return clampToWindow(base + spreadSeconds(`${opts.seed}:${step.id}`, opts.spreadMinutes), window);
}

/**
 * Cuándo sale cada paso de un enrolamiento: un instante por paso, en el
 * orden (day_offset, order_in_day), estrictamente creciente.
 *
 * El día 0 es el del enrolamiento si es hábil y la hora del primer paso
 * todavía no pasó; si no, el siguiente día hábil. Toda la cadencia se
 * corre junta: el paso del día 1 nunca cae el mismo día que el del día 0
 * por haberse enrolado tarde.
 */
export function planSteps(steps: readonly PlanStep[], opts: PlanOptions): Array<{ stepId: string; at: Date }> {
  assertTimeZone(opts.timeZone);
  if (steps.length === 0) return [];
  const ordered = [...steps].sort((a, b) => a.dayOffset - b.dayOffset || a.orderInDay - b.orderInDay);
  const { date: today } = zonedParts(opts.enrolledAt, opts.timeZone);
  const first = ordered[0]!;
  let start = businessDayOnOrAfter(today);
  const firstAt = zonedInstant(addBusinessDays(start, first.dayOffset), stepClockSeconds(first, opts), opts.timeZone);
  if (firstAt.getTime() <= opts.enrolledAt.getTime()) start = nextBusinessDate(start);

  const out: Array<{ stepId: string; at: Date }> = [];
  let prev = opts.enrolledAt.getTime();
  for (const step of ordered) {
    let at = zonedInstant(addBusinessDays(start, step.dayOffset), stepClockSeconds(step, opts), opts.timeZone).getTime();
    if (at < prev + MIN_STEP_GAP_MS) at = prev + MIN_STEP_GAP_MS;
    out.push({ stepId: step.id, at: new Date(at) });
    prev = at;
  }
  return out;
}

/**
 * El siguiente hueco para algo que hoy no pudo salir (el límite diario se
 * agotó): el siguiente día hábil local, estrictamente después del día de
 * `at`, a la misma hora de reloj si cae en la ventana, o encerrada en
 * ella si no. Es next_business_day de 0037 con la ventana del workspace.
 */
export function nextBusinessSlot(at: Date, timeZone: string, window: SendWindow = DEFAULT_SEND_WINDOW): Date {
  assertTimeZone(timeZone);
  const { date, seconds } = zonedParts(at, timeZone);
  return zonedInstant(nextBusinessDate(date), clampToWindow(seconds, window), timeZone);
}

/** Minutos de dispersión por defecto al abrir la ventana (lo que se acumuló de noche no sale todo a las 09:00:00). */
export const DEFAULT_OPENING_SPREAD_MINUTES = 30;

/**
 * El primer instante en que algo puede salir, a partir de `at` (VEN-10 r2).
 * Es lo que el despachador aplica a TODO lo que reclama, no solo a lo que
 * programa: un reintento, un resume_at, un retenido que se aprueba de
 * noche o lo que se acumuló con el worker caído el fin de semana.
 *
 *   · `at` dentro de la ventana de un día hábil → `at`, tal cual;
 *   · día hábil antes de que abra → hoy, al abrir;
 *   · después del cierre o en fin de semana → el siguiente día hábil, al
 *     abrir.
 *
 * Con `seed`, la apertura lleva una dispersión determinista de hasta
 * `spreadMinutes` (encerrada en la ventana), para que cincuenta toques
 * atrasados no salgan en el mismo segundo. Sin semilla, la apertura exacta.
 */
export function nextWindowSlot(
  at: Date,
  timeZone: string,
  window: SendWindow = DEFAULT_SEND_WINDOW,
  opts: { seed?: string; spreadMinutes?: number } = {},
): Date {
  assertTimeZone(timeZone);
  const { start } = windowSeconds(window);
  if (isInsideWindow(at, timeZone, window)) return at;
  const { date, seconds } = zonedParts(at, timeZone);
  const day = isBusinessDay(date) && seconds < start ? date : nextBusinessDate(date);
  const spread = opts.seed ? spreadSeconds(`${opts.seed}:opening`, opts.spreadMinutes ?? DEFAULT_OPENING_SPREAD_MINUTES) : 0;
  return zonedInstant(day, clampToWindow(start + spread, window), timeZone);
}

/** Un paso que ya tiene hora y todavía no salió, para correrlo detrás de otro. */
export interface ShiftStep {
  id: string;
  dayOffset: number;
  orderInDay: number;
  /** Su hora programada actual. */
  at: Date;
}

/**
 * Cuando un paso se mueve (un tope lo mandó al siguiente día hábil), los
 * que van detrás en el mismo enrolamiento se corren con él (VEN-10 r2):
 * cada uno conserva su separación en DÍAS HÁBILES respecto del que se
 * movió (day_offset) y su hora local de reloj, encerrada en la ventana,
 * con la separación mínima entre pasos. Nunca adelanta un paso: si su
 * hora ya iba después, se queda. Devuelve solo los que cambian.
 *
 * Así el paso 2 («Como te comenté ayer…») no sale antes que el paso 1,
 * ni el mismo día.
 */
export function shiftFollowingSteps(
  moved: { dayOffset: number; orderInDay: number; at: Date },
  following: readonly ShiftStep[],
  timeZone: string,
  window: SendWindow = DEFAULT_SEND_WINDOW,
): Array<{ id: string; at: Date }> {
  assertTimeZone(timeZone);
  const { date: anchor } = zonedParts(moved.at, timeZone);
  const ordered = [...following]
    .filter((s) => s.dayOffset > moved.dayOffset || (s.dayOffset === moved.dayOffset && s.orderInDay > moved.orderInDay))
    .sort((a, b) => a.dayOffset - b.dayOffset || a.orderInDay - b.orderInDay);
  const out: Array<{ id: string; at: Date }> = [];
  let prev = moved.at.getTime();
  for (const s of ordered) {
    const { seconds } = zonedParts(s.at, timeZone);
    let at = zonedInstant(addBusinessDays(anchor, s.dayOffset - moved.dayOffset), clampToWindow(seconds, window), timeZone).getTime();
    if (at < prev + MIN_STEP_GAP_MS) at = prev + MIN_STEP_GAP_MS;
    if (at > s.at.getTime()) {
      out.push({ id: s.id, at: new Date(at) });
      prev = at;
    } else {
      prev = s.at.getTime();
    }
  }
  return out;
}

// ---------------------------------------------------------------------
// Reintentos
// ---------------------------------------------------------------------

/**
 * Cuánto esperar después del intento número `attempt` (1, 2, 3…):
 * RETRY_BASE_MS · 4^(attempt−1) hasta RETRY_MAX_MS, más una dispersión
 * determinista de hasta un 20 %.
 */
export function retryDelayMs(attempt: number, seed: string): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new RangeError(`retryDelayMs: intento inválido (${attempt}).`);
  const base = Math.min(RETRY_BASE_MS * 4 ** (attempt - 1), RETRY_MAX_MS);
  return Math.round(base * (1 + 0.2 * seededUnit(`${seed}:retry:${attempt}`)));
}

/** Dónde vive la cadencia: su zona y su ventana. Sin ella, el reintento no se encierra (solo para pruebas puras). */
export interface SendPlace {
  timeZone: string;
  window?: SendWindow;
}

/**
 * El instante del siguiente intento, o null si `attempt` ya era el
 * último. Con `place`, encerrado en la ventana laboral de un día hábil
 * (nextWindowSlot): el reintento de 64 minutos de un viernes a las 16:50
 * sale el lunes al abrir, no el viernes a las 18:00.
 */
export function nextRetryAt(
  now: Date,
  attempt: number,
  seed: string,
  place?: SendPlace,
  maxAttempts: number = MAX_SEND_ATTEMPTS,
): Date | null {
  if (attempt >= maxAttempts) return null;
  const raw = new Date(now.getTime() + retryDelayMs(attempt, seed));
  return place ? nextWindowSlot(raw, place.timeZone, place.window, { seed: `${seed}:retry:${attempt}` }) : raw;
}

// ---------------------------------------------------------------------
// Calentamiento
// ---------------------------------------------------------------------

/**
 * El tope diario de una cuenta en calentamiento: sube en línea recta
 * desde cap/(días+1) hasta el tope entero en `warmupDays` días (§5.1: una
 * cuenta nueva empieza bajo). El día 0 es el de warmup_started_at; sin
 * fecha, o pasados los días, el tope entero. Nunca menos de 1 si el tope
 * deja pasar algo.
 */
export function warmupDailyCap(input: { cap: number; warmupStartedAt: Date | null; warmupDays: number; now: Date }): number {
  const { cap, warmupStartedAt, warmupDays, now } = input;
  if (!Number.isInteger(cap) || cap <= 0) return 0;
  if (!warmupStartedAt || warmupDays <= 0) return cap;
  const day = Math.max(0, Math.floor((now.getTime() - warmupStartedAt.getTime()) / (DAY_S * 1000)));
  if (day >= warmupDays) return cap;
  return Math.max(1, Math.ceil((cap * (day + 1)) / (warmupDays + 1)));
}
