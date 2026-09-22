/**
 * Cuota en memoria por proceso.
 *
 *   acquire()  antes de cada intento: ESPERA (con el sleep inyectado) si
 *              la siguiente llamada superaría una ventana por minuto u
 *              hora, y LANZA kind 'quota' sin llamar si el presupuesto del
 *              día ya no alcanza. Reserva la llamada al salir, así dos
 *              llamadas concurrentes no se cuelan por la misma rendija.
 *
 * El presupuesto diario se siembra desde api_quota_usage la primera vez
 * que se toca (un reinicio o un segundo proceso no parten de cero) y
 * cada reserva se persiste con UPSERT; si la persistencia falla se avisa
 * en el logger y se sigue: la cuota en memoria sigue protegiendo.
 *
 * El día es UTC (regla del repo). Cada intento de un reintento cuenta:
 * YouTube cobra también las peticiones que fallan.
 */
import { PlatformApiError } from '../http/errors.ts';
import type { PlatformId } from '../types.ts';
import { realSleep, type SleepFn } from '../http/retry.ts';
import { DEFAULT_LIMITS, unitCostFor, type LimitsTable, type PlatformLimits, type QuotaFamily, type RateRule } from './limits.ts';

export interface QuotaKey {
  family: QuotaFamily;
  platformId: PlatformId;
  connectionId: string | null;
  endpoint: string;
}

export interface QuotaUsageRow {
  unitsUsed: number;
  calls: number;
}

/** Persistencia diaria (api_quota_usage). Implementación en quota/postgres.ts. */
export interface QuotaUsageStore {
  load(platformId: PlatformId, connectionId: string | null, day: string): Promise<QuotaUsageRow | null>;
  add(platformId: PlatformId, connectionId: string | null, day: string, units: number, calls: number, unitsLimit: number | null): Promise<void>;
}

export interface QuotaLogger {
  warn(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
}

export interface QuotaManagerOptions {
  limits?: LimitsTable;
  now?: () => Date;
  sleep?: SleepFn;
  store?: QuotaUsageStore;
  logger?: QuotaLogger;
  /** Si una ventana obliga a esperar más que esto, se lanza 'quota' en vez de esperar. */
  maxWaitMs?: number;
}

export const DEFAULT_MAX_WAIT_MS = 120_000;

interface DayCounter {
  day: string;
  used: number;
  calls: number;
  seeded: Promise<void> | null;
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export class QuotaManager {
  readonly limits: LimitsTable;
  readonly #now: () => Date;
  readonly #sleep: SleepFn;
  readonly #store: QuotaUsageStore | null;
  readonly #logger: QuotaLogger | null;
  readonly #maxWaitMs: number;
  /** Marcas de tiempo (ms) de las llamadas reservadas, por ventana. */
  readonly #windows = new Map<string, number[]>();
  readonly #days = new Map<string, DayCounter>();

  constructor(opts: QuotaManagerOptions = {}) {
    this.limits = opts.limits ?? DEFAULT_LIMITS;
    this.#now = opts.now ?? (() => new Date());
    this.#sleep = opts.sleep ?? realSleep;
    this.#store = opts.store ?? null;
    this.#logger = opts.logger ?? null;
    this.#maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  }

  unitsFor(key: QuotaKey): number {
    return unitCostFor(this.limits[key.family], key.endpoint);
  }

  /**
   * Espera lo que haga falta y reserva la llamada; lanza 'quota' si el día
   * no alcanza. La comprobación de las ventanas y la reserva son un solo
   * paso síncrono (#tryReserve): dos llamadas concurrentes no pueden pasar
   * por la misma rendija entre el check y el push.
   */
  async acquire(key: QuotaKey, units: number, signal?: AbortSignal): Promise<void> {
    const limits = this.limits[key.family];
    await this.#waitForWindows(key, limits, signal);
    try {
      await this.#reserveDaily(key, limits, units);
    } catch (err) {
      this.#unreserve(key, limits);
      throw err;
    }
  }

  /** Cuánto lleva consumido hoy la conexión (o la app) en esta familia, según la memoria del proceso. */
  usedToday(key: Pick<QuotaKey, 'family' | 'platformId' | 'connectionId'>): QuotaUsageRow {
    const limits = this.limits[key.family];
    const counter = this.#days.get(this.#dayKey(key, limits));
    const day = utcDay(this.#now());
    if (!counter || counter.day !== day) return { unitsUsed: 0, calls: 0 };
    return { unitsUsed: counter.used, calls: counter.calls };
  }

  /** Síncrono a propósito: comprueba todas las ventanas y, si caben, reserva en todas. Devuelve los ms a esperar (0 = reservado). */
  #tryReserve(key: QuotaKey, limits: PlatformLimits): number {
    const nowMs = this.#now().getTime();
    let waitMs = 0;
    for (const rule of limits.rates) {
      const stamps = this.#timestamps(key, rule);
      const from = nowMs - rule.windowS * 1000;
      while (stamps.length > 0 && stamps[0]! <= from) stamps.shift();
      if (stamps.length >= rule.max) {
        const oldest = stamps[stamps.length - rule.max]!;
        waitMs = Math.max(waitMs, oldest + rule.windowS * 1000 - nowMs);
      }
    }
    if (waitMs > 0) return waitMs;
    for (const rule of limits.rates) this.#timestamps(key, rule).push(nowMs);
    return 0;
  }

  #unreserve(key: QuotaKey, limits: PlatformLimits): void {
    for (const rule of limits.rates) this.#timestamps(key, rule).pop();
  }

  async #waitForWindows(key: QuotaKey, limits: PlatformLimits, signal?: AbortSignal): Promise<void> {
    for (;;) {
      if (signal?.aborted) throw abortedError(key);
      const waitMs = this.#tryReserve(key, limits);
      if (waitMs <= 0) return;
      if (waitMs > this.#maxWaitMs) {
        throw new PlatformApiError({
          platformId: key.platformId, endpoint: key.endpoint, kind: 'quota', code: 'rate_window_full',
          messageEs: `La ventana de llamadas de ${key.family} está llena; se reintenta en ${Math.ceil(waitMs / 1000)} s.`,
          retryAfterS: Math.ceil(waitMs / 1000),
        });
      }
      this.#logger?.debug('cuota: esperando la ventana', { family: key.family, endpoint: key.endpoint, connectionId: key.connectionId, waitMs });
      await this.#sleep(waitMs, signal);
    }
  }

  async #reserveDaily(key: QuotaKey, limits: PlatformLimits, units: number): Promise<void> {
    if (!limits.daily) return;
    const day = utcDay(this.#now());
    const dayKey = this.#dayKey(key, limits);
    let counter = this.#days.get(dayKey);
    if (!counter || counter.day !== day) {
      counter = { day, used: 0, calls: 0, seeded: null };
      this.#days.set(dayKey, counter);
    }
    const connectionId = limits.daily.scope === 'connection' ? key.connectionId : null;
    // api_quota_usage no distingue familias: solo persiste la principal de cada plataforma (daily.persist).
    const store = limits.daily.persist ? this.#store : null;
    if (store && counter.seeded === null) {
      const c = counter;
      c.seeded = store.load(key.platformId, connectionId, day).then(
        (row) => { if (row) { c.used += row.unitsUsed; c.calls += row.calls; } },
        (err: unknown) => { this.#logger?.warn('cuota: no se pudo leer api_quota_usage; se parte de la memoria del proceso', { family: key.family, err }); },
      );
    }
    if (counter.seeded) await counter.seeded;
    const budget = limits.daily.units;
    if (budget !== null && counter.used + units > budget) {
      throw new PlatformApiError({
        platformId: key.platformId, endpoint: key.endpoint, kind: 'quota', code: 'quota_exhausted',
        messageEs: `Se agotó la cuota diaria de ${key.family} (${counter.used} de ${budget} unidades usadas hoy); se reintenta mañana.`,
      });
    }
    counter.used += units;
    counter.calls += 1;
    if (store) {
      // Se espera el UPSERT a propósito: una escritura perdida subcuenta la cuota
      // de YouTube, y la ida a la base es corta frente a la llamada HTTP que sigue.
      try {
        await store.add(key.platformId, connectionId, day, units, 1, budget);
      } catch (err) {
        this.#logger?.warn('cuota: no se pudo persistir api_quota_usage; la cuota en memoria sigue vigente', { family: key.family, err });
      }
    }
  }

  #timestamps(key: QuotaKey, rule: RateRule): number[] {
    const scope = rule.scope === 'connection' ? key.connectionId ?? 'app' : 'app';
    const id = `${key.family}|${scope}|${rule.perEndpoint ? key.endpoint : '*'}|${rule.windowS}`;
    let list = this.#windows.get(id);
    if (!list) {
      list = [];
      this.#windows.set(id, list);
    }
    return list;
  }

  #dayKey(key: Pick<QuotaKey, 'family' | 'connectionId'>, limits: PlatformLimits): string {
    const scope = limits.daily?.scope === 'connection' ? key.connectionId ?? 'app' : 'app';
    return `${key.family}|${scope}`;
  }
}

function abortedError(key: QuotaKey): PlatformApiError {
  return new PlatformApiError({ platformId: key.platformId, endpoint: key.endpoint, kind: 'transient', code: 'aborted', messageEs: 'La llamada se canceló antes de terminar.' });
}
