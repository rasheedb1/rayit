/**
 * Outreach · de la base a las variables de las plantillas: una sola
 * lectura (VEN-12, ronda 2).
 *
 * render.ts (@mc/core) tiene la lista canónica de variables y
 * templateValuesFrom, la única traducción de los orígenes a valores. Esto
 * es la otra mitad: de DÓNDE sale cada origen en la base, en una sola
 * consulta que usan el motor al enrolar (las plantillas fijas de
 * outbound_step), el pitch (guardar y la vista del editor) y quien venga.
 * Antes, cada uno armaba su mapa y el motor se quedaba con cinco de las
 * doce variables: una plantilla con {{creator_handle}} salía retenida.
 *
 *   contacto  → nombre, nombre de pila y cargo de la ficha
 *   empresa   → nombre, sector y ciudad
 *   señal     → el titular de la señal que originó el negocio
 *   creador   → el del negocio (deal.creator_id) o, si no, el primero
 *               activo del workspace: su nombre (o el del workspace),
 *               usuario y nicho; el media kit público y vigente y la
 *               cotización enviada del negocio, como URL absolutas con el
 *               origen de la app (APP_URL). Sin origen, esas dos quedan a
 *               la vista y el toque se retiene: nunca un enlace relativo
 *               ni uno a un dominio que no sea el de la app.
 *
 * Corre con la RLS del workspace (WorkspaceTx) o como el worker nombrando
 * el workspace.
 */
import type { TemplateSources } from '@mc/core/outreach/render';
import type { SqlExecutor, WorkspaceTx } from '../../client.ts';
import { assertIds } from './shared.ts';

export interface TemplateSourcesQuery {
  /** El workspace, si la transacción no es una WorkspaceTx (el worker). */
  workspaceId?: string;
  contactId?: string | null;
  /** La empresa, si no se deduce del contacto. */
  companyId?: string | null;
  dealId?: string | null;
  /** El creador que firma, si se eligió; si no, el del negocio o el primero activo. */
  creatorId?: string | null;
  /** El origen público de la app («https://on-cue-web.vercel.app»). Sin él no hay enlaces. */
  appUrl?: string | null;
}

export interface LoadedTemplateSources {
  sources: TemplateSources;
  /** El creador que firma (null si el workspace no tiene ninguno). */
  creatorId: string | null;
  mediaKitSlug: string | null;
  quoteSlug: string | null;
}

interface Row {
  full_name: string | null; role_title: string | null; company: string | null; industry: string | null; city: string | null;
  signal: string | null; creator_id: string | null; sender: string | null; handle: string | null; niche: string | null;
  kit_slug: string | null; quote_slug: string | null;
}

/** El origen sin barra final, y solo http(s): cualquier otra cosa no arma enlaces. */
export function appOrigin(appUrl: string | null | undefined): string | null {
  const raw = appUrl?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null;
  } catch {
    return null;
  }
}

export async function loadTemplateSources(tx: SqlExecutor, q: TemplateSourcesQuery): Promise<LoadedTemplateSources> {
  const ws = (tx as Partial<WorkspaceTx>).workspaceId ?? q.workspaceId;
  if (!ws) throw new TypeError('loadTemplateSources: falta el workspace (una WorkspaceTx o workspaceId).');
  const ids = [ws, q.contactId, q.companyId, q.dealId, q.creatorId].filter((x): x is string => Boolean(x));
  assertIds('loadTemplateSources', ids);
  const r = (
    await tx.query<Row>(
      `SELECT c.full_name, c.role_title, co.name AS company, co.industry, co.city, sg.headline_es AS signal,
              cp.id AS creator_id, coalesce(cp.display_name, w.name) AS sender, cp.handle, cp.niche_slugs[1] AS niche,
              (SELECT mk.slug FROM media_kit mk
                WHERE mk.creator_id = cp.id AND mk.is_public AND (mk.expires_at IS NULL OR mk.expires_at > now())
                ORDER BY mk.created_at DESC LIMIT 1) AS kit_slug,
              (SELECT qt.slug FROM quote qt
                WHERE qt.deal_id = d.id AND qt.workspace_id = w.id AND qt.status IN ('sent','viewed','accepted')
                ORDER BY qt.created_at DESC LIMIT 1) AS quote_slug
         FROM workspace w
         LEFT JOIN contact c ON c.id = $2::uuid
         LEFT JOIN company co ON co.id = coalesce($3::uuid, c.company_id)
         LEFT JOIN deal d ON d.id = $4::uuid AND d.workspace_id = w.id
         LEFT JOIN signal sg ON sg.id = d.origin_signal_id
         LEFT JOIN LATERAL (
           SELECT x.* FROM creator_profile x
            WHERE x.workspace_id = w.id AND x.deleted_at IS NULL AND ($5::uuid IS NULL OR x.id = $5::uuid)
            ORDER BY (x.id = d.creator_id) DESC NULLS LAST, (x.status = 'active') DESC, x.created_at
            LIMIT 1) cp ON true
        WHERE w.id = $1::uuid`,
      [ws, q.contactId ?? null, q.companyId ?? null, q.dealId ?? null, q.creatorId ?? null],
    )
  ).rows[0];
  const origin = appOrigin(q.appUrl);
  const link = (path: string, slug: string | null | undefined) => (origin && slug ? `${origin}/${path}/${encodeURIComponent(slug)}` : null);
  return {
    sources: {
      contact: r ? { fullName: r.full_name, roleTitle: r.role_title } : null,
      company: r ? { name: r.company, industry: r.industry, city: r.city } : null,
      signal: r ? { headline: r.signal } : null,
      creator: r
        ? { senderName: r.sender, handle: r.handle, niche: r.niche, mediaKitUrl: link('kit', r.kit_slug), quoteUrl: link('cotizacion', r.quote_slug) }
        : null,
    },
    creatorId: r?.creator_id ?? null,
    mediaKitSlug: r?.kit_slug ?? null,
    quoteSlug: r?.quote_slug ?? null,
  };
}
