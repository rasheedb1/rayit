/**
 * Respuestas grabadas para probar sin red.
 *
 * Un fixture vive en fixtures/<plataforma>/<endpoint>[.<caso>].json:
 *   { meta: { source: 'docs' | 'recorded', recordedAt, notes },
 *     request: { method, urlPattern, body? },
 *     response: { status, headers, body } | [ …varias en orden… ] }
 *
 * FixtureFetch casa método, URL (regex) y cuerpo (subconjunto) y FALLA
 * con la lista de lo que esperaba si llega una llamada no prevista.
 * withoutNetwork() reemplaza globalThis.fetch por uno que lanza, para
 * que «sin red» sea demostrable y no una promesa.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FetchLike } from '../http/client.ts';
import { redactSecrets } from '../redact.ts';

export interface FixtureResponse {
  status: number;
  headers?: Record<string, string>;
  body: unknown;
  /** Simula un fallo de red: fetch rechaza con este mensaje en vez de responder. */
  networkError?: string;
}

export interface Fixture {
  meta: { source: 'docs' | 'recorded'; recordedAt: string; notes?: string };
  /** `method` '*' casa cualquier método (solo para fixtures sintetizados en pruebas). */
  request: { method: string; urlPattern: string; body?: unknown };
  response: FixtureResponse | FixtureResponse[];
}

export interface RecordedCall {
  method: string;
  /** Con los parámetros secretos de la query tapados (Meta exige client_secret en la URL de ig_exchange_token). */
  url: string;
  /** Cabeceras con Authorization / Access-Token tapadas. */
  headers: Record<string, string>;
  body: unknown;
}

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = join(HERE, '..', '..', 'fixtures');

export async function loadFixture(platform: string, endpoint: string, variant?: string): Promise<Fixture> {
  const name = variant ? `${endpoint}.${variant}.json` : `${endpoint}.json`;
  const path = join(FIXTURES_DIR, platform, name);
  const parsed = JSON.parse(await readFile(path, 'utf8')) as Fixture;
  if (!parsed.request?.urlPattern || !parsed.response) throw new Error(`Fixture inválido: ${path}`);
  return parsed;
}

export async function loadFixtures(platform: string, names: ReadonlyArray<[endpoint: string, variant?: string]>): Promise<Fixture[]> {
  return Promise.all(names.map(([e, c]) => loadFixture(platform, e, c)));
}

export class UnexpectedCallError extends Error {
  constructor(call: RecordedCall, expected: readonly string[]) {
    super(
      `FixtureFetch: llamada no prevista ${call.method} ${call.url}. ` +
      (expected.length ? `Fixtures cargados: ${expected.join(' | ')}` : 'No hay fixtures cargados.'),
    );
    this.name = 'UnexpectedCallError';
  }
}

interface Loaded {
  fixture: Fixture;
  regex: RegExp;
  queue: FixtureResponse[];
}

export class FixtureFetch {
  readonly calls: RecordedCall[] = [];
  readonly #loaded: Loaded[];

  constructor(fixtures: readonly Fixture[]) {
    this.#loaded = fixtures.map((f) => ({ fixture: f, regex: new RegExp(f.request.urlPattern), queue: Array.isArray(f.response) ? [...f.response] : [f.response] }));
  }

  /** Para pasar como `fetch` al HttpCore. */
  get fetch(): FetchLike {
    return (url, init) => this.#handle(url, init);
  }

  async #handle(url: string, init: RequestInit): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? parseBody(init.body, init.headers) : undefined;
    // El cuerpo grabado pasa por el redactor: un client_secret o un refresh_token de un formulario no queda ni en memoria de pruebas.
    const call: RecordedCall = { method, url: redactUrl(url), headers: redactHeaders(init.headers), body: redactSecrets(maskCodes(body)) };
    this.calls.push(call);
    const match = this.#loaded.find((l) => (l.fixture.request.method === '*' || l.fixture.request.method.toUpperCase() === method) && l.regex.test(url) && subset(l.fixture.request.body, body));
    if (!match) throw new UnexpectedCallError(call, this.#loaded.map((l) => `${l.fixture.request.method} ${l.fixture.request.urlPattern}`));
    const next = match.queue.length > 1 ? match.queue.shift()! : match.queue[0];
    if (!next) throw new Error(`FixtureFetch: el fixture ${match.fixture.request.urlPattern} no tiene más respuestas`);
    if (next.networkError) throw new TypeError(next.networkError);
    const headers = new Headers({ 'content-type': 'application/json', ...next.headers });
    return new Response(next.body === null || next.body === undefined ? '' : JSON.stringify(next.body), { status: next.status, headers });
  }
}

/** JSON, o application/x-www-form-urlencoded como objeto (así `request.body` de un fixture casa por subconjunto también en formularios). */
function parseBody(text: string, headers: RequestInit['headers'] | undefined): unknown {
  const type = headerValue(headers, 'content-type') ?? '';
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  return tryJson(text);
}

function headerValue(h: RequestInit['headers'] | undefined, name: string): string | undefined {
  if (!h) return undefined;
  const entries = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h);
  return entries.find(([k]) => k.toLowerCase() === name)?.[1];
}

/** El `code` de OAuth no es una llave que el redactor reconozca por nombre; aquí se tapa aparte. */
function maskCodes(body: unknown): unknown {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return body;
  const out: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  for (const k of ['code', 'auth_code', 'code_verifier']) if (typeof out[k] === 'string') out[k] = '[REDACTADO]';
  return out;
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const SECRET_QUERY_KEYS = new Set(['client_secret', 'access_token', 'code', 'refresh_token', 'code_verifier', 'app_secret', 'key', 'token']);

function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    let touched = false;
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_QUERY_KEYS.has(k)) {
        u.searchParams.set(k, 'REDACTADO');
        touched = true;
      }
    }
    return touched ? u.toString() : url;
  } catch {
    return url;
  }
}

function redactHeaders(h: RequestInit['headers'] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  const entries = h instanceof Headers ? [...h.entries()] : Array.isArray(h) ? h : Object.entries(h);
  for (const [k, v] of entries) out[k] = /authorization|access-token/i.test(k) ? '[REDACTADO]' : String(v);
  return out;
}

/** `expected` es subconjunto de `actual` (a cualquier profundidad). undefined = no se compara. */
export function subset(expected: unknown, actual: unknown): boolean {
  if (expected === undefined) return true;
  if (typeof expected !== 'object' || expected === null) return expected === actual;
  if (typeof actual !== 'object' || actual === null) return false;
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((e, i) => subset(e, actual[i]));
  }
  return Object.entries(expected as Record<string, unknown>).every(([k, v]) => subset(v, (actual as Record<string, unknown>)[k]));
}

export interface NetworkGuard {
  /** Cuántas veces algo intentó salir por globalThis.fetch. */
  attempts: number;
  restore(): void;
}

/** Sustituye globalThis.fetch por uno que lanza. Llamar en before() y restore() en after(). */
export function withoutNetwork(): NetworkGuard {
  const original = globalThis.fetch;
  const guard: NetworkGuard = {
    attempts: 0,
    restore() {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = ((input: unknown) => {
    guard.attempts += 1;
    return Promise.reject(new Error(`Sin red en las pruebas: se intentó fetch(${String(input)})`));
  }) as typeof fetch;
  return guard;
}
