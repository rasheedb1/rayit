/**
 * Outreach · el pitch a mano con afirmaciones trazables (VEN-6, dentro de
 * VEN-12): lo que el editor de la ficha necesita, cómo se guarda y cómo se
 * le pide un borrador a la IA.
 *
 * El editor abre el último borrador de la empresa con sus marcas
 * [claim:id] (de outbound_generation: el que redactó la IA o el que la
 * persona guardó, 0062) o uno vacío; ofrece los claims del creador que
 * firma como fichas insertables y corre el pre-vuelo en línea. Guardar
 * deja un outbound_touch en 'draft' y el marcado en outbound_generation
 * (outcome 'manual': ningún job escribe encima); programar, en
 * 'scheduled', y solo si el pre-vuelo pasa entero: un pitch con una cifra
 * sin origen no se puede marcar como listo. El servidor vuelve a correr
 * el pre-vuelo: lo que diga la pantalla no basta.
 *
 * «Redactar con IA» y las pistas («Más corto», «Más específico», «Otro
 * ángulo») no llaman al modelo desde la web: dejan la petición en
 * outbound_generation (outbound_generation_request, 0062) y el worker la
 * redacta y la juzga; el toque vuelve a 'draft' con la nota del juez.
 *
 * Con la RLS del workspace (WorkspaceTx): la pantalla nunca fija el workspace.
 */
import { claimsCitedIn, stripClaimMarkers, type SalesClaim } from '@mc/core/outreach/claims';
import { subjectGate } from '@mc/core/outreach/gates';
import { namesOtherPerson } from '@mc/core/outreach/people';
import { preflight, type PreflightIssue, type RegenerateHint } from '@mc/core/outreach/preflight';
import { renderTemplate, templateValuesFrom, type TemplateSources, type TemplateValues } from '@mc/core/outreach/render';
import type { WorkspaceTx } from '../../client.ts';
import { listSalesClaims } from './claims.ts';
import { assertIds } from './shared.ts';
import { loadTemplateSources } from './template-sources.ts';

/**
 * Qué toque se edita como pitch: un correo nuevo (manual, o el paso
 * 'email' de una cadencia), nunca una respuesta en el hilo ni uno retenido
 * por un intento sin confirmar, que tienen su propio flujo en la ficha
 * (releaseHeldTouch).
 */
const EDITABLE_PITCH_SQL = `t.unconfirmed_attempt IS NULL
  AND (t.step_id IS NULL OR EXISTS (SELECT 1 FROM outbound_step st WHERE st.id = t.step_id AND st.step_type = 'email'))`;

/** Las etapas en las que la IA todavía está con el borrador: el editor dice «redactando». */
export const PITCH_PENDING_STAGES = ['requested', 'generating', 'generated', 'reviewing'] as const;

export interface PitchDraft {
  touchId: string;
  status: string;
  contactId: string | null;
  dealId: string | null;
  /**
   * Con sus marcas [claim:id] y sus {{variables}} tal cual los escribió la
   * persona (o con las marcas de la IA); si no hay marcado, el texto del toque.
   */
  subject: string | null;
  body: string;
  heldReason: string | null;
  /**
   * La nota de la revisión automática del texto que se abre: la del
   * intento ELEGIDO (el que pasó, el mejor o el que se retuvo), no la del
   * último intento (0063). null si el texto no es el de la IA.
   */
  review: { total: number | null; note: string | null; attempt: number | null } | null;
  /**
   * Cuándo terminó la IA con este borrador (outbound_generation.reviewed_at,
   * solo si no lo escribió una persona). El editor se vuelve a montar
   * cuando cambia: cuando llega un borrador nuevo de la IA, no cuando la
   * propia persona guarda.
   */
  generationStamp: string | null;
  /**
   * La IA está redactando o revisando este borrador (lo pidió alguien o es
   * de una cadencia). lastError es un código ('llm_budget', 'interrupted',
   * 'llm_output', 'error'): la pantalla lo traduce, nunca lo enseña crudo.
   */
  pending: { stage: string; hint: RegenerateHint | null; lastError: string | null } | null;
  /** La IA se rindió con este borrador (el modelo no devolvió nada legible, 0063): lo escribe la persona o pide otra versión. */
  failed: boolean;
  /** Se copió con tantas cifras sin origen (UNSOURCED_COPY_MARK): el editor lo dice. null si no. */
  unsourcedCopy: number | null;
}

/**
 * La marca que deja «Copiar» en un borrador con cifras sin origen:
 * held_reason = 'unsourced_copy:<n>' con el toque en 'draft' (la CHECK de
 * 0046 solo exige motivo cuando está retenido; en un borrador es una nota).
 * No es un código de retención (HOLD_CODES): nada lo detiene por ella, y
 * guardar o programar el borrador la limpia con el texto nuevo.
 */
export const UNSOURCED_COPY_MARK = 'unsourced_copy';
const UNSOURCED_COPY_RE = new RegExp(`^${UNSOURCED_COPY_MARK}:(\\d+)$`);

/** Lo que cambia según el negocio elegido: quién firma, qué cifras puede citar y con qué se rellenan las variables. */
export interface PitchVariant {
  creator: { id: string; name: string; handle: string | null; niche: string | null } | null;
  claims: SalesClaim[];
  /** Los orígenes de las variables salvo el contacto (lo pone el editor según a quién escribe). */
  sources: Omit<TemplateSources, 'contact'>;
}

export interface PitchComposer {
  /** Los negocios de la empresa, con la señal que originó cada uno. */
  deals: Array<{ id: string; name: string; signalHeadline: string | null; open: boolean }>;
  /** Por negocio (su id) y sin negocio (''). */
  variants: Record<string, PitchVariant>;
  draft: PitchDraft | null;
  /**
   * enabled: el envío está encendido. hasEmailAccount: hay un correo
   * conectado para enviar. hasPostalAddress: el pie lleva dirección postal
   * o la política no la pide; es la misma regla con la que savePitch
   * niega programar (no_postal_address), para que el editor lo diga antes.
   */
  policy: { enabled: boolean; hasEmailAccount: boolean; hasPostalAddress: boolean };
  /** Las personas de la empresa a las que este espacio ya les envió algo: para ellas no es el primer correo. */
  contactedIds: string[];
  /** Cuántas señales vivas tiene la empresa (ni descartadas ni duplicadas): con más de una, el editor ofrece «Otra señal». */
  signalCount: number;
}

export interface LoadPitchOptions {
  /** El origen público de la app (APP_URL o el de la petición, ya validado): arma {{media_kit_url}} y {{quote_url}}. */
  appUrl?: string | null;
}

async function variantFor(tx: WorkspaceTx, companyId: string, dealId: string | null, locale: string, appUrl: string | null): Promise<PitchVariant> {
  const src = await loadTemplateSources(tx, { companyId, dealId, appUrl });
  const claims = await listSalesClaims(tx, { locale, dealId, creatorId: src.creatorId });
  const c = src.sources.creator;
  return {
    creator: src.creatorId && c ? { id: src.creatorId, name: c.senderName ?? '', handle: c.handle ?? null, niche: c.niche ?? null } : null,
    claims,
    sources: { company: src.sources.company, signal: src.sources.signal, creator: src.sources.creator },
  };
}

export async function loadPitchComposer(tx: WorkspaceTx, companyId: string, locale: string, opts: LoadPitchOptions = {}): Promise<PitchComposer> {
  assertIds('loadPitchComposer', [companyId]);
  const appUrl = opts.appUrl ?? null;
  const deals = (
    await tx.query<{ id: string; name: string; headline: string | null; open: boolean }>(
      `SELECT d.id, d.name, s.headline_es AS headline, (d.won_at IS NULL AND d.lost_at IS NULL) AS open
         FROM deal d LEFT JOIN signal s ON s.id = d.origin_signal_id
        WHERE d.company_id = $1::uuid
        ORDER BY (d.won_at IS NULL AND d.lost_at IS NULL) DESC, d.created_at DESC`,
      [companyId],
    )
  ).rows;
  // Una variante por negocio (su creador, sus cifras y las de su señal) y una sin negocio.
  const variants: Record<string, PitchVariant> = { '': await variantFor(tx, companyId, null, locale, appUrl) };
  for (const d of deals) variants[d.id] = await variantFor(tx, companyId, d.id, locale, appUrl);

  const d = (
    await tx.query<{
      id: string; status: string; contact_id: string | null; deal_id: string | null; subject: string | null; body: string;
      held_reason: string | null; g_subject: string | null; g_body: string | null; g_stage: string | null; g_outcome: string | null;
      g_hint: RegenerateHint | null; g_error: string | null; g_note: string | null; g_total: string | null; g_chosen: number | null;
      g_reviewed_at: unknown;
    }>(
      `SELECT t.id, t.status, t.contact_id, t.deal_id, t.subject, t.body, t.held_reason,
              g.subject AS g_subject, g.body_marked AS g_body, g.stage AS g_stage, g.outcome AS g_outcome,
              g.requested_hint AS g_hint, g.last_error AS g_error, g.judge_note AS g_note, g.total_score AS g_total,
              g.chosen_attempt AS g_chosen, g.reviewed_at AS g_reviewed_at
         FROM outbound_touch t LEFT JOIN outbound_generation g ON g.touch_id = t.id
        WHERE t.company_id = $1::uuid AND t.channel = 'email' AND t.status IN ('draft','held') AND ${EDITABLE_PITCH_SQL}
          AND (g.body_marked IS NOT NULL OR btrim(t.body) <> '' OR g.stage = ANY($2::text[]))
        ORDER BY t.status_changed_at DESC, t.id LIMIT 1`,
      [companyId, [...PITCH_PENDING_STAGES, 'failed']],
    )
  ).rows[0];
  // Las variables con los datos de la persona y el negocio del borrador: con ellas se sabe si el marcado dice lo que dice el toque.
  const draftValues = d
    ? templateValuesFrom((await loadTemplateSources(tx, { contactId: d.contact_id, companyId, dealId: d.deal_id, appUrl })).sources)
    : {};
  const policy = (
    await tx.query<{ enabled: boolean | null; postal: boolean | null; account: boolean }>(
      `SELECT p.enabled,
              coalesce(nullif(btrim(p.postal_address), '') IS NOT NULL OR NOT p.require_optout_link, false) AS postal,
              EXISTS (SELECT 1 FROM outreach_channel_account a WHERE a.channel = 'email' AND a.status = 'connected') AS account
         FROM (SELECT 1) x LEFT JOIN outbound_policy p ON p.workspace_id = current_workspace_id()`,
    )
  ).rows[0];
  const contacted = (
    await tx.query<{ contact_id: string }>(
      `SELECT DISTINCT contact_id FROM outbound_touch WHERE company_id = $1::uuid AND status = 'sent' AND contact_id IS NOT NULL`,
      [companyId],
    )
  ).rows.map((r) => r.contact_id);
  const signalCount = (
    await tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM signal WHERE company_id = $1::uuid AND status NOT IN ('discarded', 'duplicate')`,
      [companyId],
    )
  ).rows[0]!.n;
  return {
    contactedIds: contacted,
    signalCount,
    deals: deals.map((x) => ({ id: x.id, name: x.name, signalHeadline: x.headline, open: x.open })),
    variants,
    draft: d ? draftFrom(d, draftValues) : null,
    policy: { enabled: policy?.enabled ?? false, hasEmailAccount: policy?.account ?? false, hasPostalAddress: policy?.postal ?? false },
  };
}

type DraftRow = {
  id: string; status: string; contact_id: string | null; deal_id: string | null; subject: string | null; body: string;
  held_reason: string | null; g_subject: string | null; g_body: string | null; g_stage: string | null; g_outcome: string | null;
  g_hint: RegenerateHint | null; g_error: string | null; g_note: string | null; g_total: string | null; g_chosen: number | null;
  g_reviewed_at: unknown;
};

/** Lo que sale de un marcado: las variables rellenas y sin marcas. */
const outgoing = (marked: string | null, values: TemplateValues) => stripClaimMarkers(renderTemplate(marked, values) ?? '').trim();

/**
 * Qué texto abre el editor: el marcado de outbound_generation (con sus
 * [claim:id] y sus {{variables}}) si, rellenado con los datos de la
 * persona y el negocio del toque, dice lo mismo que el toque —lo guardó
 * la persona o lo aprobó la revisión— o si el toque todavía está vacío (la
 * IA ya lo redactó y espera al juez); si no, el texto del toque, que
 * alguien editó por otro camino.
 */
function draftFrom(d: DraftRow, values: TemplateValues): PitchDraft {
  const touchBody = d.body.trim();
  const marked = d.g_body !== null && (touchBody === '' || outgoing(d.g_body, values) === touchBody);
  const byAi = d.g_outcome !== null && d.g_outcome !== 'manual';
  const copia = UNSOURCED_COPY_RE.exec(d.held_reason ?? '');
  const reviewedAt = d.g_reviewed_at === null || d.g_reviewed_at === undefined ? null : new Date(d.g_reviewed_at as string);
  return {
    touchId: d.id, status: d.status, contactId: d.contact_id, dealId: d.deal_id,
    subject: marked ? (d.g_subject ?? d.subject) : d.subject,
    body: marked ? d.g_body! : d.body,
    heldReason: copia ? null : d.held_reason,
    unsourcedCopy: copia ? Number(copia[1]) : null,
    review: byAi && marked && (d.g_note !== null || d.g_total !== null)
      ? { total: d.g_total === null ? null : Number(d.g_total), note: d.g_note, attempt: d.g_chosen }
      : null,
    generationStamp: byAi && reviewedAt ? reviewedAt.toISOString() : null,
    pending: d.g_stage && (PITCH_PENDING_STAGES as readonly string[]).includes(d.g_stage)
      ? { stage: d.g_stage, hint: d.g_hint, lastError: d.g_error }
      : null,
    failed: d.g_stage === 'failed',
  };
}

export interface SavePitchInput {
  companyId: string;
  contactId: string;
  dealId: string | null;
  /** El borrador que se edita (generado o guardado antes), o null para uno nuevo. */
  touchId: string | null;
  subject: string | null;
  /** Con sus marcas [claim:id]: aquí se comprueban y se quitan. */
  body: string;
  intent: 'draft' | 'schedule';
  /**
   * Se guarda porque la persona lo copió para enviarlo desde su correo.
   * Si el texto lleva cifras sin origen, el borrador queda marcado
   * (UNSOURCED_COPY_MARK) para que el editor lo diga al volver.
   */
  copied?: boolean;
  userId: string | null;
  locale: string;
  /**
   * El origen público de la app, que arma el servidor (APP_URL o la
   * petición validada), nunca el navegador: {{media_kit_url}} y
   * {{quote_url}} salen con ese dominio y el slug de la base.
   */
  appUrl?: string | null;
  now: Date;
}

export type SavePitchResult =
  /** sendingEnabled: ¿el envío del espacio está encendido? (outbound_policy.enabled): la pantalla dice si sale ya o cuando lo encienda. */
  | { ok: true; touchId: string; status: 'draft' | 'scheduled'; sendingEnabled: boolean }
  | {
      ok: false;
      code: 'contact' | 'deal' | 'no_email' | 'opted_out' | 'preflight' | 'not_editable' | 'no_postal_address' | 'other_person';
      issues?: PreflightIssue[];
      subjectCodes?: string[];
      /** other_person: el nombre de pila de la otra persona de la marca que el mensaje nombra. */
      person?: string;
    };

export async function savePitch(tx: WorkspaceTx, input: SavePitchInput): Promise<SavePitchResult> {
  assertIds('savePitch', [input.companyId, input.contactId, ...(input.dealId ? [input.dealId] : []), ...(input.touchId ? [input.touchId] : [])]);
  const c = (
    await tx.query<{ email: string | null; blocked: boolean; company: string; full_name: string | null; others: (string | null)[] }>(
      `SELECT c.email::text AS email, co.name AS company, c.full_name,
              ARRAY(SELECT o.full_name FROM contact o WHERE o.company_id = c.company_id AND o.id <> c.id ORDER BY o.created_at, o.id) AS others,
              (c.opted_out OR coalesce(c.email_invalid, false) OR address_is_suppressed(c.email)
               OR EXISTS (SELECT 1 FROM outbound_workspace_optout wo WHERE wo.workspace_id = current_workspace_id() AND wo.email = c.email)) AS blocked
         FROM contact c JOIN company co ON co.id = c.company_id WHERE c.id = $1::uuid AND c.company_id = $2::uuid`,
      [input.contactId, input.companyId],
    )
  ).rows[0];
  if (!c) return { ok: false, code: 'contact' };
  if (!c.email) return { ok: false, code: 'no_email' };
  if (c.blocked) return { ok: false, code: 'opted_out' };
  // El negocio tiene que ser de ESTA empresa: si no, el pitch citaría las cifras de la señal de otro negocio.
  if (input.dealId) {
    const own = (await tx.query('SELECT 1 FROM deal WHERE id = $1::uuid AND company_id = $2::uuid', [input.dealId, input.companyId])).rows.length > 0;
    if (!own) return { ok: false, code: 'deal' };
  }

  // Las variables se rellenan aquí con los datos de la base, como las ve la marca (la misma lectura que el motor):
  // lo que no tenga valor queda a la vista y el pre-vuelo lo marca como hueco.
  const src = await loadTemplateSources(tx, { contactId: input.contactId, companyId: input.companyId, dealId: input.dealId, appUrl: input.appUrl });
  const values = templateValuesFrom(src.sources);
  const subject = renderTemplate(input.subject, values);
  const body = renderTemplate(input.body, values) ?? '';
  const claims = await listSalesClaims(tx, { locale: input.locale, dealId: input.dealId, creatorId: src.creatorId });
  const firstTouch = (
    await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_touch WHERE contact_id = $1::uuid AND status = 'sent'`, [input.contactId])
  ).rows[0]!.n === 0;
  // La marca se escribe como se escribe («NIVEA»): no es gritar.
  const pf = preflight({ stepType: 'email', subject, body, claims, firstTouch, allowedUppercase: [c.company] });
  const sg = subjectGate('email', subject);
  const policy = (await tx.query<{ enabled: boolean; postal: boolean }>(
    `SELECT coalesce(p.enabled, false) AS enabled,
            coalesce(nullif(btrim(p.postal_address), '') IS NOT NULL OR NOT p.require_optout_link, false) AS postal
       FROM (SELECT 1) x LEFT JOIN outbound_policy p ON p.workspace_id = current_workspace_id()`,
  )).rows[0]!;
  if (input.intent === 'schedule') {
    if (!pf.ok || !sg.ok) return { ok: false, code: 'preflight', issues: pf.issues, subjectCodes: sg.codes };
    if (!policy.postal) return { ok: false, code: 'no_postal_address' };
    // El mismo aviso que la revisión del editor: un mensaje que nombra a otra persona de la marca no se programa.
    const person = namesOtherPerson(`${subject ?? ''}\n${body}`, c.full_name, c.others, src.sources.creator?.senderName ?? null);
    if (person) return { ok: false, code: 'other_person', person };
  }
  const status = input.intent === 'schedule' ? 'scheduled' : 'draft';
  const cited = JSON.stringify(claimsCitedIn(claims, subject, body));
  const approved = input.intent === 'schedule';
  // Primero el toque queda en borrador con el texto nuevo; luego se guarda el marcado de la persona (la
  // función de la base solo lo acepta sobre un correo en draft o held, 0064); y al final, si se programa,
  // pasa a 'scheduled' con su aprobación. Todo en la misma transacción.
  let touchId = input.touchId;
  if (touchId) {
    const r = await tx.query<{ id: string }>(
      `UPDATE outbound_touch t
          SET contact_id = $2::uuid, deal_id = $3::uuid, subject = $4, body = $5, claims = $6::jsonb, status = 'draft', held_reason = NULL
        WHERE id = $1::uuid AND company_id = $7::uuid AND channel = 'email' AND status IN ('draft','held') AND ${EDITABLE_PITCH_SQL}
        RETURNING id`,
      [touchId, input.contactId, input.dealId, pf.cleanSubject, pf.cleanBody, cited, input.companyId],
    );
    if (r.rows.length === 0) return { ok: false, code: 'not_editable' };
  } else {
    touchId = (
      await tx.query<{ id: string }>(
        `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, deal_id, channel, subject, body, claims, status, scheduled_for)
         VALUES (current_workspace_id(), $1::uuid, $2::uuid, $3::uuid, 'email', $4, $5, $6::jsonb, 'draft', $7::timestamptz)
         RETURNING id`,
        [input.companyId, input.contactId, input.dealId, pf.cleanSubject, pf.cleanBody, cited, input.now.toISOString()],
      )
    ).rows[0]!.id;
  }
  // El marcado de la persona TAL CUAL lo escribió, con sus {{variables}} y
  // sus [claim:id]: el editor lo vuelve a abrir así (si cambia «Para», el
  // saludo cambia con la persona) y ningún job lo pisa (0062, 0063). Lo que
  // sale, ya rellenado, está en outbound_touch.
  const saved = (
    await tx.query<{ r: string }>('SELECT outbound_generation_save_manual($1::uuid, $2, $3) AS r', [touchId, input.subject, input.body])
  ).rows[0]!.r;
  if (saved !== 'ok') return { ok: false, code: 'not_editable' };
  const unsourced = new Set(pf.issues.filter((i) => i.code === 'unsourced_figure').map((i) => i.detail ?? '')).size;
  if (input.copied && !approved && unsourced > 0) {
    await tx.query(`UPDATE outbound_touch SET held_reason = $2 WHERE id = $1::uuid AND status = 'draft'`, [
      touchId, `${UNSOURCED_COPY_MARK}:${unsourced}`,
    ]);
  }
  if (approved) {
    await tx.query(
      `UPDATE outbound_touch
          SET status = 'scheduled', scheduled_for = greatest(coalesce(scheduled_for, $2::timestamptz), $2::timestamptz),
              approved_by = $3::uuid, approved_at = $2::timestamptz
        WHERE id = $1::uuid AND status = 'draft'`,
      [touchId, input.now.toISOString(), input.userId],
    );
  }
  return { ok: true, touchId, status, sendingEnabled: policy.enabled };
}

export type RequestPitchDraftResult = { ok: true } | { ok: false; code: 'not_found' | 'not_editable' | 'opted_out' | 'busy' };

/**
 * Pide a la IA un borrador del pitch, o regenerarlo con una pista cerrada
 * y, si la persona quiere, sus instrucciones (tono, qué destacar). No
 * llama al modelo: deja la petición para outbound.generate (0062).
 */
export async function requestPitchDraft(
  tx: WorkspaceTx,
  input: { touchId: string; hint: RegenerateHint | null; instructions: string | null; userId: string | null },
): Promise<RequestPitchDraftResult> {
  assertIds('requestPitchDraft', [input.touchId, ...(input.userId ? [input.userId] : [])]);
  const r = (
    await tx.query<{ r: string }>('SELECT outbound_generation_request($1::uuid, $2, $3, $4::uuid) AS r', [
      input.touchId, input.hint, input.instructions?.trim().slice(0, 500) || null, input.userId,
    ])
  ).rows[0]!.r;
  return r === 'ok' ? { ok: true } : { ok: false, code: r as 'not_found' | 'not_editable' | 'opted_out' | 'busy' };
}

/** ¿El worker redacta con IA? 'anthropic' o 'fake' sí; 'off' le falta la llave; 'unknown' no corrió en el último día (0062). */
export type WriterStatus = 'anthropic' | 'fake' | 'off' | 'unknown';

export async function outreachWriterStatus(tx: WorkspaceTx): Promise<WriterStatus> {
  const s = (await tx.query<{ s: string }>('SELECT outreach_writer_status() AS s')).rows[0]?.s;
  return s === 'anthropic' || s === 'fake' || s === 'off' ? s : 'unknown';
}
