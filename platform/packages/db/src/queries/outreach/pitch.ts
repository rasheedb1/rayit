/**
 * Outreach · el pitch a mano con afirmaciones trazables (VEN-6, dentro de
 * VEN-12): lo que el editor de la ficha necesita y cómo se guarda.
 *
 * El editor abre el último borrador generado de la empresa (con sus
 * marcas [claim:id], de outbound_generation) o uno vacío; ofrece los
 * claims del perfil como fichas insertables y corre el pre-vuelo en línea.
 * Guardar deja un outbound_touch en 'draft'; programar, en 'scheduled',
 * y solo si el pre-vuelo pasa entero: un pitch con una cifra sin origen no
 * se puede marcar como listo. El servidor vuelve a correr el pre-vuelo:
 * lo que diga la pantalla no basta.
 *
 * Con la RLS del workspace (WorkspaceTx): la pantalla nunca fija el workspace.
 */
import { claimsCitedIn, stripClaimMarkers, type SalesClaim } from '@mc/core/outreach/claims';
import { subjectGate } from '@mc/core/outreach/gates';
import { preflight, type PreflightIssue } from '@mc/core/outreach/preflight';
import { renderTemplate, templateValuesFrom } from '@mc/core/outreach/render';
import type { WorkspaceTx } from '../../client.ts';
import { listSalesClaims } from './claims.ts';
import { assertIds } from './shared.ts';

/**
 * Qué toque se edita como pitch: un correo nuevo (manual, o el paso
 * 'email' de una cadencia), nunca una respuesta en el hilo ni uno retenido
 * por un intento sin confirmar, que tienen su propio flujo en la ficha
 * (releaseHeldTouch).
 */
const EDITABLE_PITCH_SQL = `t.unconfirmed_attempt IS NULL
  AND (t.step_id IS NULL OR EXISTS (SELECT 1 FROM outbound_step st WHERE st.id = t.step_id AND st.step_type = 'email'))`;

export interface PitchDraft {
  touchId: string;
  status: string;
  contactId: string | null;
  dealId: string | null;
  /** Con marcas si vino del generador; si no, el texto del toque. */
  subject: string | null;
  body: string;
  heldReason: string | null;
  /** La última nota de la puerta de calidad, si pasó por ella. */
  review: { total: number | null; decision: string; note: string | null; attempt: number } | null;
}

export interface PitchComposer {
  claims: SalesClaim[];
  creator: { name: string; handle: string | null; niche: string | null } | null;
  /** El slug del último media kit público y vigente (la página /kit/<slug>). */
  mediaKitSlug: string | null;
  draft: PitchDraft | null;
  policy: { enabled: boolean; hasEmailAccount: boolean; hasPostalAddress: boolean };
}

export async function loadPitchComposer(tx: WorkspaceTx, companyId: string, locale: string): Promise<PitchComposer> {
  assertIds('loadPitchComposer', [companyId]);
  // Los claims del perfil, más las cifras de la señal de cada negocio de la empresa.
  const deals = (await tx.query<{ id: string }>('SELECT id FROM deal WHERE company_id = $1::uuid AND origin_signal_id IS NOT NULL', [companyId])).rows;
  const claims = await listSalesClaims(tx, { locale });
  const seen = new Set(claims.map((c) => c.id));
  for (const d of deals) {
    for (const c of await listSalesClaims(tx, { locale, dealId: d.id })) {
      if (!seen.has(c.id)) {
        seen.add(c.id);
        claims.push(c);
      }
    }
  }
  const creator = (
    await tx.query<{ display_name: string; handle: string | null; niche: string | null; slug: string | null }>(
      `SELECT cp.display_name, cp.handle, cp.niche_slugs[1] AS niche,
              (SELECT mk.slug FROM media_kit mk
                WHERE mk.creator_id = cp.id AND mk.is_public AND (mk.expires_at IS NULL OR mk.expires_at > now())
                ORDER BY mk.created_at DESC LIMIT 1) AS slug
         FROM creator_profile cp
        WHERE cp.deleted_at IS NULL
        ORDER BY (cp.status = 'active') DESC, cp.created_at LIMIT 1`,
    )
  ).rows[0];
  const d = (
    await tx.query<{ id: string; status: string; contact_id: string | null; deal_id: string | null; subject: string | null; body: string;
      held_reason: string | null; g_subject: string | null; g_body: string | null }>(
      `SELECT t.id, t.status, t.contact_id, t.deal_id, t.subject, t.body, t.held_reason, g.subject AS g_subject, g.body_marked AS g_body
         FROM outbound_touch t LEFT JOIN outbound_generation g ON g.touch_id = t.id
        WHERE t.company_id = $1::uuid AND t.channel = 'email' AND t.status IN ('draft','held') AND ${EDITABLE_PITCH_SQL}
          AND (g.body_marked IS NOT NULL OR btrim(t.body) <> '')
        ORDER BY t.status_changed_at DESC, t.id LIMIT 1`,
      [companyId],
    )
  ).rows[0];
  const review = d
    ? (await tx.query<{ total_score: string | null; decision: string; gates: { judge_note?: string }; attempt: number }>(
        'SELECT total_score, decision, gates, attempt FROM outbound_review WHERE touch_id = $1::uuid ORDER BY attempt DESC LIMIT 1',
        [d.id],
      )).rows[0]
    : undefined;
  const policy = (
    await tx.query<{ enabled: boolean | null; postal: boolean | null; account: boolean }>(
      `SELECT p.enabled, nullif(btrim(p.postal_address), '') IS NOT NULL AS postal,
              EXISTS (SELECT 1 FROM outreach_channel_account a WHERE a.channel = 'email' AND a.status = 'connected') AS account
         FROM (SELECT 1) x LEFT JOIN outbound_policy p ON p.workspace_id = current_workspace_id()`,
    )
  ).rows[0];
  return {
    claims,
    creator: creator ? { name: creator.display_name, handle: creator.handle, niche: creator.niche } : null,
    mediaKitSlug: creator?.slug ?? null,
    draft: d
      ? {
          touchId: d.id, status: d.status, contactId: d.contact_id, dealId: d.deal_id,
          // Si el mensaje vino del generador y nadie lo tocó, el marcado; si una persona lo editó, el texto del toque.
          subject: d.g_body && stripClaimMarkers(d.g_body).trim() === d.body.trim() ? d.g_subject : d.subject,
          body: d.g_body && stripClaimMarkers(d.g_body).trim() === d.body.trim() ? d.g_body : d.body,
          heldReason: d.held_reason,
          review: review
            ? { total: review.total_score === null ? null : Number(review.total_score), decision: review.decision, note: review.gates.judge_note ?? null, attempt: review.attempt }
            : null,
        }
      : null,
    policy: { enabled: policy?.enabled ?? false, hasEmailAccount: policy?.account ?? false, hasPostalAddress: policy?.postal ?? false },
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
  userId: string | null;
  locale: string;
  /** La URL pública del media kit ({{media_kit_url}}), si la web la conoce. */
  mediaKitUrl?: string | null;
  now: Date;
}

export type SavePitchResult =
  | { ok: true; touchId: string; status: 'draft' | 'scheduled' }
  | { ok: false; code: 'contact' | 'no_email' | 'opted_out' | 'preflight' | 'not_editable' | 'no_postal_address'; issues?: PreflightIssue[]; subjectCodes?: string[] };

export async function savePitch(tx: WorkspaceTx, input: SavePitchInput): Promise<SavePitchResult> {
  assertIds('savePitch', [input.companyId, input.contactId, ...(input.dealId ? [input.dealId] : []), ...(input.touchId ? [input.touchId] : [])]);
  const c = (
    await tx.query<{
      email: string | null; blocked: boolean; full_name: string | null; role_title: string | null;
      company: string; industry: string | null; city: string | null;
    }>(
      `SELECT c.email::text AS email, c.full_name, c.role_title, co.name AS company, co.industry, co.city,
              (c.opted_out OR coalesce(c.email_invalid, false) OR address_is_suppressed(c.email)
               OR EXISTS (SELECT 1 FROM outbound_workspace_optout wo WHERE wo.workspace_id = current_workspace_id() AND wo.email = c.email)) AS blocked
         FROM contact c JOIN company co ON co.id = c.company_id WHERE c.id = $1::uuid AND c.company_id = $2::uuid`,
      [input.contactId, input.companyId],
    )
  ).rows[0];
  if (!c) return { ok: false, code: 'contact' };
  if (!c.email) return { ok: false, code: 'no_email' };
  if (c.blocked) return { ok: false, code: 'opted_out' };

  // Las variables se rellenan aquí con los datos de la base, como las ve la marca: lo que no tenga valor queda
  // a la vista y el pre-vuelo lo marca como hueco.
  const extra = (
    await tx.query<{ creator: string | null; handle: string | null; niche: string | null; signal: string | null }>(
      `SELECT (SELECT display_name FROM creator_profile WHERE deleted_at IS NULL ORDER BY (status = 'active') DESC, created_at LIMIT 1) AS creator,
              (SELECT handle FROM creator_profile WHERE deleted_at IS NULL ORDER BY (status = 'active') DESC, created_at LIMIT 1) AS handle,
              (SELECT niche_slugs[1] FROM creator_profile WHERE deleted_at IS NULL ORDER BY (status = 'active') DESC, created_at LIMIT 1) AS niche,
              (SELECT s.headline_es FROM deal d JOIN signal s ON s.id = d.origin_signal_id WHERE d.id = $1::uuid) AS signal`,
      [input.dealId],
    )
  ).rows[0]!;
  const values = templateValuesFrom({
    contact: { fullName: c.full_name, roleTitle: c.role_title },
    company: { name: c.company, industry: c.industry, city: c.city },
    signal: { headline: extra.signal },
    creator: { senderName: extra.creator, handle: extra.handle, niche: extra.niche, mediaKitUrl: input.mediaKitUrl ?? null },
  });
  const subject = renderTemplate(input.subject, values);
  const body = renderTemplate(input.body, values) ?? '';
  const claims = await listSalesClaims(tx, { locale: input.locale, dealId: input.dealId });
  const firstTouch = (
    await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_touch WHERE contact_id = $1::uuid AND status = 'sent'`, [input.contactId])
  ).rows[0]!.n === 0;
  const pf = preflight({ stepType: 'email', subject, body, claims, firstTouch });
  const sg = subjectGate('email', subject);
  if (input.intent === 'schedule') {
    if (!pf.ok || !sg.ok) return { ok: false, code: 'preflight', issues: pf.issues, subjectCodes: sg.codes };
    const postal = (await tx.query<{ ok: boolean }>(
      `SELECT coalesce((SELECT nullif(btrim(postal_address), '') IS NOT NULL OR NOT require_optout_link FROM outbound_policy
                         WHERE workspace_id = current_workspace_id()), false) AS ok`,
    )).rows[0]!.ok;
    if (!postal) return { ok: false, code: 'no_postal_address' };
  }
  const status = input.intent === 'schedule' ? 'scheduled' : 'draft';
  const cited = JSON.stringify(claimsCitedIn(claims, subject, body));
  const approved = input.intent === 'schedule';
  if (input.touchId) {
    const r = await tx.query<{ id: string }>(
      `UPDATE outbound_touch t
          SET contact_id = $2::uuid, deal_id = $3::uuid, subject = $4, body = $5, claims = $6::jsonb, status = $7, held_reason = NULL,
              scheduled_for = CASE WHEN $8 THEN greatest(coalesce(scheduled_for, $9::timestamptz), $9::timestamptz) ELSE scheduled_for END,
              approved_by = CASE WHEN $8 THEN $10::uuid ELSE approved_by END,
              approved_at = CASE WHEN $8 THEN $9::timestamptz ELSE approved_at END
        WHERE id = $1::uuid AND company_id = $11::uuid AND channel = 'email' AND status IN ('draft','held') AND ${EDITABLE_PITCH_SQL}
        RETURNING id`,
      [input.touchId, input.contactId, input.dealId, pf.cleanSubject, pf.cleanBody, cited, status, approved, input.now.toISOString(), input.userId, input.companyId],
    );
    if (r.rows.length === 0) return { ok: false, code: 'not_editable' };
    return { ok: true, touchId: input.touchId, status };
  }
  const r = await tx.query<{ id: string }>(
    `INSERT INTO outbound_touch (workspace_id, company_id, contact_id, deal_id, channel, subject, body, claims, status, scheduled_for,
                                 approved_by, approved_at)
     VALUES (current_workspace_id(), $1::uuid, $2::uuid, $3::uuid, 'email', $4, $5, $6::jsonb, $7, $8::timestamptz,
             CASE WHEN $9 THEN $10::uuid END, CASE WHEN $9 THEN $8::timestamptz END)
     RETURNING id`,
    [input.companyId, input.contactId, input.dealId, pf.cleanSubject, pf.cleanBody || stripClaimMarkers(body), cited, status,
      input.now.toISOString(), approved, input.userId],
  );
  return { ok: true, touchId: r.rows[0]!.id, status };
}
