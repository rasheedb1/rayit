/**
 * Límites de cada API, en código y con fuente por fila. Es la tabla que
 * el QuotaManager consulta; `platform.limits` (migración 0002, vacío
 * hoy) la sobreescribe cuando exista con el JSON de docs/propuestas/CON-1.md §1.
 *
 * Una «familia» de cuota agrupa los endpoints que comparten límite:
 * TikTok Display y TikTok Accounts son dos apps con dos cuotas aunque
 * las dos sean platform_id = 'tiktok'; YouTube Data y YouTube Analytics
 * tienen presupuestos distintos. En api_quota_usage se persiste por
 * platform_id, y solo las familias con presupuesto diario numérico.
 */
import type { PlatformId } from '../types.ts';

export type QuotaFamily = 'tiktok' | 'tiktok-accounts' | 'ensembledata' | 'instagram' | 'youtube' | 'youtube-search' | 'youtube-analytics';

export type QuotaScope = 'connection' | 'app';

/** Ventana deslizante: a lo sumo `max` llamadas en `windowS` segundos. */
export interface RateRule {
  scope: QuotaScope;
  /** true: una ventana por endpoint lógico; false: una ventana para toda la familia. */
  perEndpoint: boolean;
  windowS: number;
  max: number;
  source: string;
  checkedAt: string;
  note?: string;
}

/**
 * Presupuesto diario en unidades. `units` null = existe pero no se conoce
 * el número. `persist`: api_quota_usage no tiene columna de familia, así
 * que solo UNA familia por platform_id puede persistir su acumulado (la
 * principal: YouTube Data); las demás cuentan solo en memoria.
 */
export interface DailyBudget {
  scope: QuotaScope;
  units: number | null;
  persist?: boolean;
  source: string;
  checkedAt: string;
  note?: string;
}

export interface PlatformLimits {
  platformId: PlatformId;
  rates: RateRule[];
  daily: DailyBudget | null;
  /** Unidades por endpoint lógico; lo que no esté aquí cuesta 1. */
  unitCost: Record<string, number>;
}

export type LimitsTable = Record<QuotaFamily, PlatformLimits>;

const TIKTOK_RATE_LIMIT_DOC = 'developers.tiktok.com/doc/tiktok-api-v2-rate-limit (página del 4-ago-2026)';
const ARCHITECTURE_DOC = 'docs/arquitectura.md «APIs de plataforma»';
const META_RATE_LIMIT_DOC = 'developers.facebook.com/docs/graph-api/overview/rate-limiting';
const YOUTUBE_QUOTA_DOC = 'developers.google.com/youtube/v3/determine_quota_cost (actualizada 15-sep-2026)';
const YOUTUBE_ANALYTICS_DOC = 'developers.google.com/youtube/analytics/reference/reports/query';
const ENSEMBLEDATA_DOC = 'ensembledata.com/apis/docs y ensembledata.com/pricing (leídas el 23-sep-2026)';
const CHECKED_AT = '2026-09-22';
const ENSEMBLEDATA_CHECKED_AT = '2026-09-23';

export const DEFAULT_LIMITS: LimitsTable = {
  tiktok: {
    platformId: 'tiktok',
    rates: [
      { scope: 'connection', perEndpoint: true, windowS: 60, max: 40, source: ARCHITECTURE_DOC, checkedAt: CHECKED_AT, note: 'DECISIÓN PENDIENTE DE NICOLÁS: la documentación de hoy no distingue por cuenta.' },
      { scope: 'app', perEndpoint: true, windowS: 60, max: 600, source: TIKTOK_RATE_LIMIT_DOC, checkedAt: CHECKED_AT, note: 'user/info, video/list y video/query; ventana deslizante de un minuto; 429 rate_limit_exceeded.' },
    ],
    daily: null,
    unitCost: {},
  },
  'tiktok-accounts': {
    platformId: 'tiktok',
    rates: [
      { scope: 'connection', perEndpoint: true, windowS: 60, max: 40, source: ARCHITECTURE_DOC, checkedAt: CHECKED_AT, note: 'El portal de la Accounts API es JavaScript y no se pudo leer; se aplica el límite del documento de arquitectura hasta CON-9.' },
    ],
    daily: null,
    unitCost: {},
  },
  // CON-12. Proveedor de datos de TikTok: platform_id 'tiktok' con cuota
  // propia, porque es otro contrato y otro presupuesto que el de la
  // Display API. Es la única familia de 'tiktok' con presupuesto diario,
  // así que es la que puede persistir en api_quota_usage.
  ensembledata: {
    platformId: 'tiktok',
    rates: [
      { scope: 'app', perEndpoint: false, windowS: 60, max: 60, source: ENSEMBLEDATA_DOC, checkedAt: ENSEMBLEDATA_CHECKED_AT, note: 'DECISIÓN PENDIENTE DE NICOLÁS: el proveedor dice que «no impone límites de tasa», pero su SDK reconoce un 429 (STATUS_429_RATE_LIMIT_EXCEEDED). La ventana es nuestra, conservadora, no suya.' },
    ],
    daily: { scope: 'app', units: null, persist: true, source: ENSEMBLEDATA_DOC, checkedAt: ENSEMBLEDATA_CHECKED_AT, note: 'El presupuesto depende del plan contratado (Wood 1 500 · Bronze 5 000 · Silver 11 000 · Gold 25 000 · Platinum 50 000 unidades/día; se reinician a las 00:00 UTC). units null = existe pero no se conoce: no se corta aquí, se persiste lo gastado y el 495 del proveedor (ed_units_depleted) corta. DECISIÓN PENDIENTE DE NICOLÁS: al aprobar el plan, su número entra por platform.limits.' },
    unitCost: {
      // Todos los endpoints de TikTok del proveedor cuestan 1 unidad. El
      // catálogo se cobra por bloques de diez, así que user.posts declara
      // sus unidades por llamada (`units` = depth) en vez de fijarlas aquí.
      'ensembledata.tt.user.info': 1,
      'ensembledata.tt.user.posts': 1,
    },
  },
  instagram: {
    platformId: 'instagram',
    rates: [
      { scope: 'connection', perEndpoint: false, windowS: 3_600, max: 200, source: META_RATE_LIMIT_DOC, checkedAt: CHECKED_AT, note: 'Límite de plataforma: 200 llamadas/hora × usuarios, repartido por conexión. El BUC (4800 × impresiones/24 h) no se puede calcular: se respeta por sus códigos (4, 17, 32, 613, 80002).' },
    ],
    daily: null,
    unitCost: {},
  },
  youtube: {
    platformId: 'youtube',
    rates: [],
    daily: { scope: 'app', units: 10_000, persist: true, source: YOUTUBE_QUOTA_DOC, checkedAt: CHECKED_AT, note: 'Por proyecto de Google Cloud; se reinicia a medianoche del Pacífico, aquí el día es UTC (conservador).' },
    unitCost: {
      'youtube.channels.list': 1,
      'youtube.playlist_items.list': 1,
      'youtube.videos.list': 1,
    },
  },
  'youtube-search': {
    platformId: 'youtube',
    rates: [],
    daily: { scope: 'app', units: 100, source: YOUTUBE_QUOTA_DOC, checkedAt: CHECKED_AT, note: 'search.list cuesta 1 en un cubo propio de 100/día desde jun-2026 (antes 100 unidades del cubo general). No se usa en el MVP.' },
    unitCost: { 'youtube.search.list': 1 },
  },
  'youtube-analytics': {
    platformId: 'youtube',
    rates: [],
    daily: { scope: 'app', units: null, source: YOUTUBE_ANALYTICS_DOC, checkedAt: CHECKED_AT, note: 'Cuota aparte de la Data API; Google no publica el número. DECISIÓN PENDIENTE DE NICOLÁS: leerlo del proyecto en Google Cloud.' },
    unitCost: {},
  },
};

export const QUOTA_FAMILIES: readonly QuotaFamily[] = ['tiktok', 'tiktok-accounts', 'ensembledata', 'instagram', 'youtube', 'youtube-search', 'youtube-analytics'];

export function isQuotaFamily(value: unknown): value is QuotaFamily {
  return typeof value === 'string' && (QUOTA_FAMILIES as readonly string[]).includes(value);
}

export function unitCostFor(limits: PlatformLimits, endpoint: string): number {
  return limits.unitCost[endpoint] ?? 1;
}

/**
 * Aplica `platform.limits` (jsonb por fila de `platform`) sobre la tabla
 * por defecto. El JSON lleva una llave por familia:
 *   { "tiktok": { "rates": [...], "daily": null, "unit_cost": {...} }, "tiktok-accounts": {...} }
 * Lo que no se entiende se ignora y se devuelve en `ignored` para que el
 * llamador lo registre. Nunca lanza: un JSON malo no puede frenar al worker.
 */
export function mergeLimits(base: LimitsTable, overrides: Partial<Record<PlatformId, unknown>>): { limits: LimitsTable; ignored: string[] } {
  const ignored: string[] = [];
  const limits: LimitsTable = { ...base };
  for (const [platformId, json] of Object.entries(overrides)) {
    if (json === null || json === undefined) continue;
    if (typeof json !== 'object' || Array.isArray(json)) {
      ignored.push(`${platformId}: limits no es un objeto`);
      continue;
    }
    for (const [family, value] of Object.entries(json as Record<string, unknown>)) {
      if (!isQuotaFamily(family) || base[family].platformId !== platformId) {
        ignored.push(`${platformId}.${family}: familia desconocida para esta plataforma`);
        continue;
      }
      const parsed = parseFamily(value, base[family]);
      if (!parsed) {
        ignored.push(`${platformId}.${family}: forma inválida`);
        continue;
      }
      limits[family] = parsed;
    }
  }
  return { limits, ignored };
}

function parseFamily(value: unknown, fallback: PlatformLimits): PlatformLimits | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const out: PlatformLimits = { ...fallback, rates: [...fallback.rates], unitCost: { ...fallback.unitCost } };
  if ('rates' in v) {
    if (!Array.isArray(v['rates'])) return null;
    const rates: RateRule[] = [];
    for (const r of v['rates']) {
      const rule = parseRate(r);
      if (!rule) return null;
      rates.push(rule);
    }
    out.rates = rates;
  }
  if ('daily' in v) {
    if (v['daily'] === null) out.daily = null;
    else {
      const d = parseDaily(v['daily']);
      if (!d) return null;
      out.daily = d;
    }
  }
  if ('unit_cost' in v) {
    if (typeof v['unit_cost'] !== 'object' || v['unit_cost'] === null) return null;
    for (const [k, cost] of Object.entries(v['unit_cost'] as Record<string, unknown>)) {
      if (typeof cost !== 'number' || !Number.isInteger(cost) || cost < 0) return null;
      out.unitCost[k] = cost;
    }
  }
  return out;
}

function parseRate(r: unknown): RateRule | null {
  if (typeof r !== 'object' || r === null) return null;
  const o = r as Record<string, unknown>;
  const scope = o['scope'];
  const windowS = o['window_s'];
  const max = o['max'];
  if ((scope !== 'connection' && scope !== 'app') || typeof windowS !== 'number' || windowS <= 0 || typeof max !== 'number' || max <= 0) return null;
  return {
    scope,
    perEndpoint: o['per_endpoint'] === true,
    windowS,
    max,
    source: typeof o['source'] === 'string' ? o['source'] : 'platform.limits',
    checkedAt: typeof o['checked_at'] === 'string' ? o['checked_at'] : 'platform.limits',
    note: typeof o['note'] === 'string' ? o['note'] : undefined,
  };
}

function parseDaily(d: unknown): DailyBudget | null {
  if (typeof d !== 'object' || d === null) return null;
  const o = d as Record<string, unknown>;
  const scope = o['scope'];
  const units = o['units'];
  if ((scope !== 'connection' && scope !== 'app') || (units !== null && (typeof units !== 'number' || units < 0))) return null;
  return {
    scope,
    units: units as number | null,
    persist: o['persist'] === true,
    source: typeof o['source'] === 'string' ? o['source'] : 'platform.limits',
    checkedAt: typeof o['checked_at'] === 'string' ? o['checked_at'] : 'platform.limits',
    note: typeof o['note'] === 'string' ? o['note'] : undefined,
  };
}
