/**
 * Cotizar · las tres funciones públicas, sin sesión ni workspace (PublicShareTx).
 *
 * Parte de @mc/db/queries/cotizar (la entrada es ../cotizar.ts, que
 * reexporta cada pieza). Las reglas del módulo están en su cabecera.
 */
import type { PublicShareTx } from '../../client.ts';
import type { QuotePublicSnapshot, QuoteStatus } from './cotizacion.ts';
import { hashSharePassword } from './enlace.ts';
import type { MediaKitSnapshot } from './media-kit.ts';

// ---------------------------------------------------------------------
// Las tres funciones públicas (sin sesión ni workspace)
// ---------------------------------------------------------------------

export type PublicMediaKitResult =
  | { status: 'not_found' }
  | { status: 'expired'; expiresAt: string }
  | { status: 'locked'; lockedUntil: string }
  | { status: 'password_required'; algo: string; salt: string }
  | { status: 'password_invalid'; algo: string; salt: string; attemptsLeft: number }
  | { status: 'ok'; slug: string; snapshot: MediaKitSnapshot; viewCount: number; createdAt: string };

/** Qué cuenta como visita. La vista previa del panel y los robots que desenrollan enlaces, no. */
export interface PublicReadOptions {
  /** false: leer sin sumar visita ni marcar la cotización como vista. Por defecto, true. */
  count?: boolean;
}

/**
 * Abre un media kit por su enlace. `password` es la que escribió la
 * visita: se deriva AQUÍ con la sal que devuelve la base, para que la
 * contraseña en claro no salga de este proceso.
 */
export async function readPublicMediaKit(
  tx: PublicShareTx,
  slug: string,
  password?: string | null,
  opts: PublicReadOptions = {},
): Promise<PublicMediaKitResult> {
  const count = opts.count ?? true;
  const primera = await llamarPublicMediaKit(tx, slug, null, count);
  if (primera.status !== 'password_required' || !password) return primera;
  const hash = await hashSharePassword(password, primera.salt);
  return llamarPublicMediaKit(tx, slug, hash, count);
}

async function llamarPublicMediaKit(tx: PublicShareTx, slug: string, hash: string | null, count: boolean): Promise<PublicMediaKitResult> {
  const { rows } = await tx.query<{ r: PublicMediaKitResult }>('SELECT public_media_kit($1, $2, $3) AS r', [slug, hash, count]);
  return rows[0]?.r ?? { status: 'not_found' };
}

export interface PublicQuoteView extends QuotePublicSnapshot {
  slug: string;
  status: QuoteStatus;
  validUntil: string | null;
  sentAt: string | null;
  viewedAt: string | null;
  acceptedAt: string | null;
  acceptedByName?: string | null;
  rejectedAt?: string | null;
  expiredAt?: string | null;
}

export type PublicQuoteResult = { status: 'not_found' } | { status: 'ok'; quote: PublicQuoteView };

/** Abre una cotización por su enlace. Con `count` (por defecto), la marca queda registrada como vista. */
export async function readPublicQuote(tx: PublicShareTx, slug: string, opts: PublicReadOptions = {}): Promise<PublicQuoteResult> {
  const { rows } = await tx.query<{ r: PublicQuoteResult }>('SELECT public_quote($1, $2) AS r', [slug, opts.count ?? true]);
  return rows[0]?.r ?? { status: 'not_found' };
}

/** Quién acepta: la firma mínima que piden Bonsai y HoneyBook. */
export interface FirmaAceptacion {
  name: string;
  email: string;
}

export type PublicQuoteAcceptResult =
  | { status: 'not_found' }
  | { status: 'invalid_signer' }
  | { status: 'not_acceptable'; quoteStatus: QuoteStatus }
  | {
      status: 'ok';
      quoteId: string;
      quoteNumber: string;
      dealId: string | null;
      /**
       * El workspace de la cotización, leído por la función de la base.
       * Solo lo usa el servidor para abrir la transacción que crea la
       * campaña (COT-4); nunca viaja a la página pública.
       */
      workspaceId: string;
      acceptedAt: string;
    };

/**
 * «Aceptar cotización» desde el enlace público. Deja la cotización
 * aceptada (con nombre y correo de quien acepta) y el deal en «Ganado»
 * en una sola transacción. La campaña la crea después
 * `completePublicAcceptance` con el workspace que devuelve.
 *
 * `not_acceptable` trae el estado real (aceptada en otra pestaña,
 * rechazada por el creador mientras la marca la tenía abierta, vencida)
 * para que la página diga lo que pasó y no «venció» para todo.
 */
export async function acceptPublicQuote(tx: PublicShareTx, slug: string, firma: FirmaAceptacion): Promise<PublicQuoteAcceptResult> {
  const { rows } = await tx.query<{ r: PublicQuoteAcceptResult }>(
    'SELECT public_quote_accept($1, $2, $3) AS r',
    [slug, firma.name, firma.email],
  );
  return rows[0]?.r ?? { status: 'not_found' };
}
