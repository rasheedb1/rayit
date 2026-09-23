/**
 * Bitácora de auditoría (ACC-2): una fila en audit_log por cada
 * escritura de dinero, publicación o cuenta conectada.
 *
 *   audit(tx, { action, entityType, entityId, before, after })
 *
 * Se llama DENTRO de la transacción de la escritura, con el mismo tx,
 * desde la función de consulta que escribe (queries/<módulo>.ts), no
 * desde la Server Action: así audita igual quien llame a la consulta
 * (COT-4 llama a createCampaignFromQuote y no tiene que saberlo), y si
 * la escritura hace rollback la bitácora se va con ella. La prueba
 * test/audit-convencion.test.ts recorre las escrituras de queries/ y
 * falla si alguna no la llama.
 *
 * Lo que la fila guarda y de dónde sale:
 *   workspace_id    current_workspace_id(): el de la transacción. Nunca
 *                   por parámetro; RLS rechaza cualquier otro.
 *   actor_user_id   current_user_id(): lo que fijó withWorkspace(…,
 *                   identity) desde la sesión. En SQL, no en JS: nada
 *                   que venga por parámetro puede cambiarlo.
 *   actor_kind      'user' si hay persona; 'system' si la transacción
 *                   no tiene identidad (copia de desarrollo sin llaves,
 *                   pruebas): decir 'user' sin saber cuál sería mentir.
 *                   'job' desde el worker (auditAsJob). 'delegate' es
 *                   de ACC-3/AGE-2.
 *   action          '<entidad>.<evento>' de la lista cerrada AUDIT_ACTIONS.
 *   entity_type     la tabla ('invoice', 'campaign', 'social_connection'…).
 *   before / after  jsonb REDACTADOS (ver sanitizeForAudit). Cada
 *                   llamada los construye a mano con los campos de SU
 *                   entidad —nunca `...row`—; la redacción es la red,
 *                   no el plan.
 *   ip              no se escribe: es PII y la evidencia de
 *                   consentimiento ya la guarda data_consent.evidence.
 *
 * Lo que NO hace: devolver el id (bigserial, contador global; CIM-2 §3),
 * leer la bitácora (la pantalla es de la fase 2, AGE-2) ni corregirla
 * (mc_app no tiene UPDATE ni DELETE sobre audit_log, 0025 §5).
 */
// Solo el redactor, por su subruta: el barril de @mc/connectors trae
// clientes, OAuth y ayudas de prueba que ninguna consulta necesita.
import { redactSecrets } from '@mc/connectors/redact';
import { assertWorkspaceId, type WorkspaceTx } from './client.ts';

// ---------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------

/**
 * Lista cerrada de acciones, '<entidad>.<evento>'. Agregar una es editar
 * esta lista (y su etiqueta en español cuando exista la pantalla), no
 * pasar un string: dos módulos no inventan dos formas del mismo evento.
 */
export const AUDIT_ACTIONS = [
  // Finanzas (FIN-1; FIN-2 agrega payment.*)
  'invoice.created',
  'invoice.sent',
  'invoice.payment_recorded',
  'invoice.paid',
  'invoice.voided',
  'invoice.reopened',
  'invoice.marked_overdue',
  // Campañas (CAM-1, CAM-2; CAM-6 usa report_sent)
  'campaign.created',
  'campaign.updated',
  'campaign.status_changed',
  'campaign.post_linked',
  'campaign.post_unlinked',
  'campaign.primary_post_set',
  'campaign.report_sent',
  // Conexiones (CON-3, CON-10)
  'connection.added',
  'connection.reconnected',
  'connection.authorized',
  'connection.disconnected',
  'consent.recorded',
  'consent.revoked',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

const ACTION_RE = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const ENTITY_TYPE_RE = /^[a-z][a-z_]*$/;

/** Se lanza antes de tocar la base si la acción no tiene la forma '<entidad>.<evento>' o no está en AUDIT_ACTIONS. */
export class InvalidAuditActionError extends Error {
  constructor(action: string) {
    super(
      `Acción de bitácora inválida: "${action}". Tiene la forma '<entidad>.<evento>' y está en AUDIT_ACTIONS ` +
        '(packages/db/src/audit.ts).',
    );
    this.name = 'InvalidAuditActionError';
  }
}

/** La forma y la lista, en tiempo de ejecución: un cast no cuela una acción inventada. */
export function assertAuditAction(action: string): asserts action is AuditAction {
  if (!ACTION_RE.test(action) || !(AUDIT_ACTIONS as readonly string[]).includes(action)) {
    throw new InvalidAuditActionError(action);
  }
}

// ---------------------------------------------------------------------
// Redacción
// ---------------------------------------------------------------------

/** Con qué se reemplaza un valor que parece un correo. */
export const CORREO_OMITIDO = '[correo omitido]';

/**
 * Claves que se ELIMINAN de before/after a cualquier profundidad, además
 * de lo que redactSecrets tapa (tokens, secretos, contraseñas,
 * authorization, apiKey, OAuthTokens por forma). Se comparan en
 * minúsculas y sin `_`, `-` ni espacios.
 *
 * Exactas: la clave entera.
 *   secretref   redactSecrets la deja a propósito (es una referencia,
 *               sirve para depurar el almacén); en la bitácora no va ni eso.
 *   ip          PII; la evidencia de consentimiento ya la guarda donde toca.
 *               También sus variantes (clientip, remoteip, ipaddress,
 *               remoteaddr, xforwardedfor, xrealip). 'ip' no va como
 *               fragmento: taparía zip, description o recipient.
 *   raw         la respuesta cruda de una API: trae lo que la API quiera.
 *   evidence    ip, user agent, texto mostrado: vive en data_consent.
 *   email(s)    correos de terceros (contact) o del propio usuario.
 * Por fragmento: la clave la contiene.
 *   email, correo, phone, telefono, celular, whatsapp, useragent,
 *   cookie, sessionid, authuserid, password.
 */
export const CLAVES_PROHIBIDAS_EN_BITACORA: { readonly exactas: readonly string[]; readonly fragmentos: readonly string[] } = {
  exactas: ['secretref', 'ip', 'ips', 'clientip', 'remoteip', 'userip', 'raw', 'evidence', 'email', 'emails'],
  fragmentos: [
    'email', 'correo', 'phone', 'telefono', 'celular', 'whatsapp', 'useragent', 'cookie', 'sessionid', 'authuserid', 'password',
    'ipaddr', 'ipaddress', 'direccionip', 'remoteaddr', 'forwardedfor', 'realip',
  ],
};

const EXACTAS = new Set(CLAVES_PROHIBIDAS_EN_BITACORA.exactas);
const FRAGMENTOS = CLAVES_PROHIBIDAS_EN_BITACORA.fragmentos;
/**
 * Un correo: parte local de caracteres de correo que NO viene pegada a
 * otro de esos caracteres ni a '/', y dominio con TLD de letras. Así no
 * se come una URL con @ (tiktok.com/@selva.thegolden/…) ni una mención
 * entre paréntesis ((@cafe.alma)): antes de su @ no hay parte local.
 */
const EMAIL_RE = /(?<![A-Za-z0-9._%+\-/])[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9\-])/g;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[-_\s]/g, '');
}

/** ¿Esta clave no puede llegar a la bitácora? */
export function isForbiddenAuditKey(key: string): boolean {
  const k = normalizeKey(key);
  if (EXACTAS.has(k)) return true;
  return FRAGMENTOS.some((f) => k.includes(f));
}

/**
 * Deja un valor listo para audit_log.before / after: primero
 * redactSecrets (tokens y secretos tapados), después las claves
 * prohibidas fuera, todo lo que parezca un correo dentro de un string
 * reemplazado por CORREO_OMITIDO (también en medio de una frase), los
 * bigint como texto (JSON no los serializa) y las fechas en ISO. No
 * muta la entrada. `undefined` y `null` quedan en null.
 */
export function sanitizeForAudit(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return strip(redactSecrets(value));
}

function strip(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string') return value.replace(EMAIL_RE, CORREO_OMITIDO);
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(strip);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (isForbiddenAuditKey(k)) continue;
    out[k] = strip(v);
  }
  return out;
}

// ---------------------------------------------------------------------
// Escritura
// ---------------------------------------------------------------------

export interface AuditEntry {
  action: AuditAction;
  /** La tabla de la entidad: 'invoice', 'campaign', 'social_connection', 'data_consent'. */
  entityType: string;
  /** El uuid de la fila, o null si el hecho no tiene una (raro). */
  entityId: string | null;
  /** Estado anterior, solo los campos que cambian. null u omitido si la fila es nueva. */
  before?: Record<string, unknown> | null;
  /** Estado posterior o lo creado, solo los campos permitidos de ESTA entidad. */
  after?: Record<string, unknown> | null;
}

/** Lo mínimo que hace falta para insertar: WorkspaceTx, WorkerTx y el JobDatabase del worker lo cumplen. */
export interface AuditExecutor {
  query(text: string, params?: readonly unknown[]): Promise<unknown>;
}

const UUID_OR_NULL = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/i;

/** jsonb o SQL NULL: un before ausente es NULL en la columna, no el JSON `null`. */
function toJsonb(value: unknown): string | null {
  const clean = sanitizeForAudit(value);
  return clean === null ? null : JSON.stringify(clean);
}

function prepare(entry: AuditEntry): { action: AuditAction; entityType: string; entityId: string | null; before: string | null; after: string | null } {
  assertAuditAction(entry.action);
  if (!ENTITY_TYPE_RE.test(entry.entityType)) {
    throw new Error(`entity_type de bitácora inválido: "${entry.entityType}". Es el nombre de la tabla, en minúsculas.`);
  }
  if (entry.entityId !== null && !UUID_OR_NULL.test(entry.entityId)) {
    throw new Error(`entity_id de bitácora inválido: "${entry.entityId}". Es un UUID o null.`);
  }
  return {
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId || null,
    before: toJsonb(entry.before),
    after: toJsonb(entry.after),
  };
}

/**
 * Deja la fila de bitácora en la transacción de quien escribe. El
 * workspace y el actor los pone la base (current_workspace_id(),
 * current_user_id()); before y after pasan por sanitizeForAudit. No
 * devuelve nada: el id de audit_log no sale de la base.
 */
export async function audit(tx: WorkspaceTx, entry: AuditEntry): Promise<void> {
  const p = prepare(entry);
  await tx.query(
    `INSERT INTO audit_log (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, before, after)
     VALUES (current_workspace_id(), current_user_id(),
             CASE WHEN current_user_id() IS NULL THEN 'system' ELSE 'user' END,
             $1, $2, $3::uuid, $4::jsonb, $5::jsonb)`,
    [p.action, p.entityType, p.entityId, p.before, p.after],
  );
}

export interface JobAuditEntry extends AuditEntry {
  /** Explícito: el worker corre como mc_worker y RLS no lo fija por él. */
  workspaceId: string;
  /** Qué job y qué corrida (job_run.id). Va en after._job; no sale de la base. */
  job: { id: string; runId: number };
}

/**
 * La misma fila desde un job del worker: actor_kind 'job', actor_user_id
 * null, workspace_id explícito y `after._job = { id, runId }`. Acepta
 * el `ctx.db` del worker (dentro de ctx.db.transaction si la escritura
 * va en una) o un WorkerTx de asWorker.
 */
export async function auditAsJob(exec: AuditExecutor, entry: JobAuditEntry): Promise<void> {
  assertWorkspaceId(entry.workspaceId);
  if (!entry.job.id || !Number.isInteger(entry.job.runId)) {
    throw new Error('auditAsJob necesita job.id (job_definition) y job.runId (job_run.id, entero).');
  }
  const p = prepare({ ...entry, after: { ...(entry.after ?? {}), _job: { id: entry.job.id, runId: entry.job.runId } } });
  await exec.query(
    `INSERT INTO audit_log (workspace_id, actor_user_id, actor_kind, action, entity_type, entity_id, before, after)
     VALUES ($1::uuid, NULL, 'job', $2, $3, $4::uuid, $5::jsonb, $6::jsonb)`,
    [entry.workspaceId, p.action, p.entityType, p.entityId, p.before, p.after],
  );
}
