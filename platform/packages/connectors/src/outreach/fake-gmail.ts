/**
 * FakeGmail: el OAuth de Google y el buzón de Gmail en memoria, detrás de
 * las mismas interfaces que GoogleOAuth y GmailClient (GoogleOAuthApi y
 * GmailApi). Solo lo usan las pruebas del callback de OAuth, del
 * keepalive y del despachador (VEN-10); sin GOOGLE_CLIENT_ID la web no
 * conecta Gmail y la pantalla de canales dice qué llave falta.
 *
 * Refrescar da un access token nuevo con una hora de vida y conserva el
 * refresh token, como Google. Un refresh token en `revoked` responde
 * invalid_grant (not_connected), que es lo que pasa cuando la persona
 * quita el acceso desde su cuenta de Google.
 */
import { OutreachApiError, type OutreachErrorKind } from './errors.ts';
import { buildMime, type OutgoingEmail } from './mime.ts';
import {
  GMAIL_SCOPES, type AuthorizationUrlOptions, type GmailApi, type GmailMessage, type GmailMessageRef, type GoogleOAuthApi, type SentEmail,
} from '../gmail.ts';
import type { OAuthTokens } from '../types.ts';

export interface FakeGmailOptions {
  now?: () => Date;
  /** El buzón que «autoriza» la persona en el OAuth falso. */
  email?: string;
  /** Alcances que concede; por defecto, los tres que se piden. */
  scopesGranted?: readonly string[];
}

export class FakeGmail implements GoogleOAuthApi, GmailApi {
  readonly sent: { mime: string; message: OutgoingEmail; result: SentEmail }[] = [];
  readonly inbox: GmailMessage[] = [];
  /** Refresh tokens que Google ya no acepta. */
  readonly revoked = new Set<string>();
  /** Cuántas veces se pidió un refresco. */
  refreshCalls = 0;
  readonly #now: () => Date;
  #seq = 0;
  #failNext: OutreachApiError | null = null;
  email: string;
  scopesGranted: readonly string[];

  constructor(opts: FakeGmailOptions = {}) {
    this.#now = opts.now ?? (() => new Date());
    this.email = opts.email ?? 'creadora@ejemplo.test';
    this.scopesGranted = opts.scopesGranted ?? GMAIL_SCOPES;
  }

  /** La siguiente llamada (de cualquier método) lanza este error. */
  failNext(kind: OutreachErrorKind, code: string, httpStatus: number | null = null): void {
    this.#failNext = new OutreachApiError({ provider: 'gmail', endpoint: 'fake', httpStatus, code, kind, messageEs: `Error simulado (${code}).` });
  }

  #enter(): void {
    const err = this.#failNext;
    this.#failNext = null;
    if (err) throw err;
  }

  #next(prefix: string): string {
    this.#seq += 1;
    return `${prefix}-${this.#seq}`;
  }

  #issue(refreshToken: string, scopes: readonly string[]): OAuthTokens {
    return { accessToken: this.#next('fake-access'), refreshToken, accessExpiresAt: new Date(this.#now().getTime() + 3600_000), scopes: [...scopes] };
  }

  authorizationUrl(state: string, opts: AuthorizationUrlOptions = {}): string {
    const u = new URL('https://accounts.google.test/o/oauth2/v2/auth');
    u.searchParams.set('state', state);
    u.searchParams.set('prompt', opts.selectAccount ? 'select_account consent' : 'consent');
    if (opts.loginHint) u.searchParams.set('login_hint', opts.loginHint);
    return u.toString();
  }

  async exchangeCode(code: string): Promise<{ tokens: OAuthTokens; scopesGranted: string[] }> {
    this.#enter();
    if (!code) throw new OutreachApiError({ provider: 'gmail', endpoint: 'fake.exchangeCode', httpStatus: 400, code: 'invalid_grant', kind: 'not_connected', messageEs: 'Código inválido.' });
    const tokens = this.#issue(this.#next('fake-refresh'), this.scopesGranted);
    return { tokens, scopesGranted: [...this.scopesGranted] };
  }

  async refresh(tokens: OAuthTokens): Promise<OAuthTokens> {
    this.refreshCalls += 1;
    this.#enter();
    const rt = tokens.refreshToken;
    if (!rt || this.revoked.has(rt)) {
      throw new OutreachApiError({ provider: 'gmail', endpoint: 'fake.refresh', httpStatus: 400, code: 'invalid_grant', kind: 'not_connected', messageEs: 'Token has been expired or revoked.' });
    }
    return this.#issue(rt, tokens.scopes);
  }

  /** Revocar deja el refresh token en `revoked` (Google ya no lo acepta) y lo apunta en `revokeCalls`. */
  readonly revokeCalls: string[] = [];

  async revoke(tokens: OAuthTokens): Promise<void> {
    this.#enter();
    const t = tokens.refreshToken ?? tokens.accessToken;
    this.revokeCalls.push(t);
    this.revoked.add(t);
  }

  async userEmail(): Promise<{ email: string; verified: boolean }> {
    this.#enter();
    return { email: this.email.trim().toLowerCase(), verified: true };
  }

  async send(message: OutgoingEmail): Promise<SentEmail> {
    this.#enter();
    const mime = buildMime(message, { boundary: (n) => `fake_${n}` });
    const id = this.#next('msg');
    const result: SentEmail = { providerMessageId: id, threadId: message.threadId ?? this.#next('thread'), messageIdRfc: `<${id}@mail.gmail.test>` };
    this.sent.push({ mime, message, result });
    return result;
  }

  async getMessage(id: string): Promise<GmailMessage> {
    this.#enter();
    const m = this.inbox.find((x) => x.id === id);
    if (!m) throw new OutreachApiError({ provider: 'gmail', endpoint: 'fake.getMessage', httpStatus: 404, code: 'notFound', kind: 'permanent', messageEs: 'No existe.' });
    return m;
  }

  async getThread(threadId: string): Promise<GmailMessage[]> {
    this.#enter();
    return this.inbox.filter((m) => m.threadId === threadId);
  }

  async searchReplies(opts: { since: Date; threadId?: string }): Promise<GmailMessageRef[]> {
    this.#enter();
    return this.inbox
      .filter((m) => !m.failedRecipient && (m.sentAt?.getTime() ?? 0) >= opts.since.getTime() && (!opts.threadId || m.threadId === opts.threadId))
      .map(({ id, threadId }) => ({ id, threadId }));
  }

  async searchBounces(opts: { since: Date }): Promise<GmailMessageRef[]> {
    this.#enter();
    return this.inbox.filter((m) => m.failedRecipient && (m.sentAt?.getTime() ?? 0) >= opts.since.getTime()).map(({ id, threadId }) => ({ id, threadId }));
  }
}
