/**
 * Grabar una sesión REAL de los canales de Ventas (VEN-9) sin que un
 * secreto ni el contenido de un buzón o de un chat toquen el disco.
 *
 * Lo usa scripts/record-outreach.ts (la sesión con Google y Unipile de
 * verdad) y lo prueba test/outreach-grabacion.test.ts. Aquí no hay red:
 * RecordingFetch envuelve el fetch que le den y anota lo que vuelve;
 * anonymizeOutreach tapa lo que no puede quedar; los dos constructores
 * de fixtures dejan `meta.source = 'recorded'` y el nombre
 * `<endpoint>.recorded.json`, al lado de los armados de la documentación
 * (que las pruebas actuales siguen usando: sus ids y textos son fijos).
 *
 * Qué se tapa y qué se conserva:
 *   · tokens y llaves (access_token, refresh_token, id_token, X-API-KEY):
 *     [REDACTADO], por nombre de campo (redact.ts) y por valor (`secrets`);
 *   · correos: la parte local pasa a demo-<hash>; el dominio se conserva
 *     solo si es de Google (gmail.com, googlemail.com) o el de un rebote
 *     (mailer-daemon, postmaster conservan también su parte local:
 *     searchBounces depende de ella); los demás, example.test;
 *   · texto de personas (snippet, asunto, cuerpo, mensaje de un chat,
 *     nombres y usuarios de perfil): una frase fija o demo-<hash>;
 *   · ids de LinkedIn (ACo…) e Instagram (numéricos largos): un hash
 *     ESTABLE, así la misma persona sigue casando consigo misma entre
 *     fixtures (quien escribe === la identidad de la cuenta);
 *   · Message-ID, In-Reply-To y References: la forma <local@dominio> se
 *     conserva con la parte local en hash, porque el hilo depende de ella;
 *   · el estado firmado que mandamos en el `name` de la hosted auth (y
 *     que Unipile devuelve en la cuenta y en el aviso de cuenta creada):
 *     queda como una marca con su largo (stateMark). Que volvió intacto
 *     lo prueba la web al verificar su firma y LIGAR la cuenta: el guion
 *     anota en meta.appStatus y meta.appReply lo que respondió al aviso
 *     (un 200 con `ignored` es un aviso que no ligó nada).
 */
import { createHash } from 'node:crypto';
import type { FetchLike } from '../http/client.ts';
import { isSecretKey, REDACTED } from '../redact.ts';

export interface CapturedCall {
  /** La etiqueta que puso el guion antes de la llamada: el nombre del fixture sin extensión (p. ej. 'accounts.get'). */
  tag: string;
  method: string;
  url: string;
  status: number;
  body: unknown;
}

/** Envuelve un fetch real y anota cada respuesta con la etiqueta vigente. No toca la petición. */
export class RecordingFetch {
  readonly calls: CapturedCall[] = [];
  tag = 'sin-etiqueta';
  readonly #inner: FetchLike;

  constructor(inner: FetchLike) {
    this.#inner = inner;
  }

  get fetch(): FetchLike {
    return async (url, init) => {
      const res = await this.#inner(url, init);
      const text = await res.clone().text();
      this.calls.push({ tag: this.tag, method: (init.method ?? 'GET').toUpperCase(), url, status: res.status, body: parseJson(text) });
      return res;
    };
  }

  /** Corre `fn` con la etiqueta `tag` (y la devuelve a la anterior al terminar, también si lanza). */
  async as<T>(tag: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tag;
    this.tag = tag;
    try {
      return await fn();
    } finally {
      this.tag = prev;
    }
  }
}

function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** La marca que reemplaza al estado firmado: solo su largo (el estado de On Cue ronda los 180 caracteres). */
export const stateMark = (len: number): string => `[estado firmado de ${len} caracteres]`;
export const STATE_MARK_RE = /^\[estado firmado de (\d+) caracteres\]$/;
/** Un `name` que es nuestro estado: base64url con puntos, largo. Un nombre de persona no tiene esa forma. */
const LOOKS_LIKE_STATE = /^[A-Za-z0-9_.~-]{100,}$/;

export interface AnonymizeOptions {
  /** Valores que no pueden quedar en ninguna parte (tokens, la llave de Unipile, el secreto de los avisos). */
  secrets?: readonly string[];
}

const KEEP_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
const KEEP_LOCAL = new Set(['mailer-daemon', 'postmaster']);
const PERSON_TEXT_KEYS = new Set(['snippet', 'message', 'text', 'subject']);
const PROFILE_KEYS = new Set([
  'username', 'publicIdentifier', 'public_identifier', 'attendee_name', 'attendee_profile_url', 'display_name', 'first_name', 'last_name',
  'headline', 'profile_picture_url', 'picture', 'given_name', 'family_name',
]);
const THREAD_HEADERS = new Set(['message-id', 'in-reply-to', 'references']);
const ADDRESS_HEADERS = new Set(['from', 'to', 'cc', 'bcc', 'reply-to', 'delivered-to', 'return-path', 'x-failed-recipients', 'sender']);

const hash = (s: string, n = 8): string => createHash('sha256').update(s).digest('hex').slice(0, n);

function anonEmail(local: string, domain: string): string {
  const d = domain.toLowerCase();
  if (KEEP_LOCAL.has(local.toLowerCase())) return `${local}@${d}`;
  return `demo-${hash(`${local}@${d}`, 6)}@${KEEP_DOMAINS.has(d) ? d : 'example.test'}`;
}

/** Correos, ids de LinkedIn e Instagram y secretos dentro de cualquier texto. */
function anonString(value: string, o: AnonymizeOptions): string {
  let s = value;
  for (const sec of o.secrets ?? []) if (sec.length >= 8) s = s.split(sec).join(REDACTED);
  s = s.replace(/([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, (_m, l: string, d: string) => anonEmail(l, d));
  s = s.replace(/\bACo[A-Za-z0-9_-]{10,}\b/g, (m) => `ACoAA${hash(m, 16)}`);
  if (/^\d{12,}$/.test(s)) return `9${createHash('sha256').update(s).digest('hex').replace(/\D/g, '').slice(0, s.length - 1)}`;
  return s;
}

/** Message-ID, In-Reply-To, References: cada <local@dominio> con la parte local en hash. */
function anonThreadHeader(value: string): string {
  return value.replace(/<([^@<>\s]+)@([^<>\s]+)>/g, (_m, l: string, d: string) => `<${hash(l, 16)}@${d.toLowerCase()}>`);
}

/**
 * Devuelve una copia sin secretos ni contenido de personas (ver arriba).
 * Pura y determinista: la misma entrada da la misma salida.
 */
export function anonymizeOutreach(value: unknown, o: AnonymizeOptions = {}, key = ''): unknown {
  if (typeof value === 'string') {
    if (key && isSecretKey(key) && key !== 'token_type') return REDACTED;
    // El estado firmado vuelve en `name` (la cuenta y el aviso de cuenta creada): su marca, antes que cualquier otra regla.
    if (key === 'name' && LOOKS_LIKE_STATE.test(value)) return stateMark(value.length);
    if (key === 'data' && value.length > 0) return '';
    // Un estado de Unipile (AccountStatus.message = 'CREDENTIALS') es un código, no texto de una persona.
    if (PERSON_TEXT_KEYS.has(key)) return value === '' || /^[A-Z_]+$/.test(value) ? value : 'Texto de la prueba (omitido).';
    if (PROFILE_KEYS.has(key) || key === 'name') return `demo-${hash(value, 6)}`;
    return anonString(value, o);
  }
  if (Array.isArray(value)) return value.map((v) => anonymizeOutreach(v, o, key));
  if (typeof value !== 'object' || value === null) return value;
  const rec = value as Record<string, unknown>;
  // Una cabecera de Gmail: { name, value }.
  if (typeof rec['name'] === 'string' && typeof rec['value'] === 'string' && Object.keys(rec).length === 2) {
    const h = rec['name'].toLowerCase();
    if (THREAD_HEADERS.has(h)) return { name: rec['name'], value: anonThreadHeader(rec['value']) };
    if (h === 'subject') return { name: rec['name'], value: 'Asunto de la prueba' };
    if (ADDRESS_HEADERS.has(h)) return { name: rec['name'], value: anonString(rec['value'].replace(/"[^"]*"/g, '"Demo"'), o) };
    return { name: rec['name'], value: anonString(rec['value'], o) };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = anonymizeOutreach(v, o, k);
  return out;
}

// ---------------------------------------------------------------------
// Los fixtures grabados
// ---------------------------------------------------------------------

/** La fecha de la grabación, en UTC (va en meta.recordedAt y en la note de VEN-9). */
export const recordedDay = (now: Date): string => now.toISOString().slice(0, 10);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Un fixture con la forma de FixtureFetch a partir de una llamada
 * capturada. La URL queda como patrón de su ruta (cualquier host, con o
 * sin query): el DSN de Unipile es de cada cliente y la query lleva
 * fechas. El cuerpo sale anonimizado.
 */
export function recordedFixture(call: CapturedCall, now: Date, notes: string, o: AnonymizeOptions = {}): {
  meta: { source: 'recorded'; recordedAt: string; notes: string };
  request: { method: string; urlPattern: string };
  response: { status: number; body: unknown };
} {
  const path = anonString(new URL(call.url).pathname, o);
  return {
    meta: { source: 'recorded', recordedAt: recordedDay(now), notes },
    request: { method: call.method, urlPattern: `^https://[^/]+${escapeRegex(path)}(\\?.*)?$` },
    response: { status: call.status, body: anonymizeOutreach(call.body, o) },
  };
}

/**
 * Un aviso de Unipile tal como llegó (su cuerpo, anonimizado) y qué
 * cabeceras NUESTRAS traía (solo los nombres: sus valores son el secreto
 * compartido y la ruta firmada).
 */
export function recordedWebhook(body: unknown, headerNames: readonly string[], now: Date, notes: string, o: AnonymizeOptions = {}): {
  meta: { source: 'recorded'; recordedAt: string; notes: string; headers: string[] };
  body: unknown;
} {
  return {
    meta: { source: 'recorded', recordedAt: recordedDay(now), notes, headers: [...headerNames].map((h) => h.toLowerCase()).sort() },
    body: anonymizeOutreach(body, o),
  };
}

/** El nombre del archivo de un fixture grabado: `<endpoint>.recorded.json` (y `webhooks/<tipo>.recorded.json`). */
export const recordedFileName = (tag: string): string => `${tag}.recorded.json`;

/**
 * Lo que tiene que haberse grabado contra el servicio real antes de dar
 * VEN-9 por hecha: el camino de conectar Gmail y LinkedIn, recibir un
 * mensaje y un cambio de salud. Cada entrada es la ruta dentro de
 * fixtures/ sin `.recorded.json`. La prueba de la web
 * (canales/_lib/grabados.test.ts) no deja pasar VEN-9 a «hecho» sin
 * todos, y test/outreach-grabados.test.ts valida lo que haya contra los
 * normalizadores.
 */
export const REQUIRED_OUTREACH_RECORDINGS = [
  'gmail/oauth.token.code',
  'gmail/oauth.token.refresh',
  'gmail/userinfo',
  'gmail/messages.send',
  'gmail/messages.get.metadata',
  'gmail/threads.get',
  'unipile/hosted.link',
  'unipile/accounts.get',
  'unipile/webhooks/account.created',
  'unipile/webhooks/message.received',
  'unipile/webhooks/account.status',
] as const;
