/**
 * FakeUnipile: la misma interfaz que UnipileClient (UnipileApi), en
 * memoria. Es lo que usan las pruebas de la web, del keepalive y del
 * despachador (VEN-10), y lo que corre en desarrollo cuando no hay
 * UNIPILE_DSN ni UNIPILE_ACCESS_TOKEN: nada sale a la red y nada finge
 * ser una cuenta real fuera de la memoria del proceso.
 *
 * Cada método registra la llamada en `calls` y, si se le programó un
 * error con `failNext`, lo lanza como lo lanzaría el cliente real
 * (OutreachApiError con el mismo kind).
 */
import { OutreachApiError, type OutreachErrorKind } from './errors.ts';
import {
  LINKEDIN_INVITE_NOTE_MAX, type CreateWebhookRequest, type HostedAuthRequest, type UnipilePage, type SendMessageRequest, type UnipileAccount, type UnipileApi,
  type UnipileCallOptions, type UnipileChat, type UnipileMessage, type UnipileProfile,
} from '../unipile.ts';

export interface FakeUnipileCall {
  method: keyof UnipileApi;
  args: unknown;
  channelAccountId: string | null;
}

export class FakeUnipile implements UnipileApi {
  readonly calls: FakeUnipileCall[] = [];
  readonly accounts = new Map<string, UnipileAccount>();
  readonly profiles = new Map<string, UnipileProfile>();
  readonly chats = new Map<string, UnipileChat>();
  readonly messages = new Map<string, UnipileMessage[]>();
  readonly hostedLinks: HostedAuthRequest[] = [];
  readonly webhooks: (CreateWebhookRequest & { id: string })[] = [];
  readonly #failures = new Map<keyof UnipileApi, OutreachApiError[]>();
  #seq = 0;

  /** Una cuenta que Unipile conoce, como si la persona hubiera pasado por el hosted auth. */
  addAccount(account: Partial<UnipileAccount> & { id: string }): UnipileAccount {
    const full: UnipileAccount = { provider: 'LINKEDIN', name: null, username: null, health: 'ok', rawStatus: 'OK', ...account };
    this.accounts.set(full.id, full);
    return full;
  }

  /** El siguiente llamado a `method` lanza este error. */
  failNext(method: keyof UnipileApi, kind: OutreachErrorKind, code = `errors/${kind}`, httpStatus: number | null = null): void {
    const list = this.#failures.get(method) ?? [];
    list.push(new OutreachApiError({ provider: 'unipile', endpoint: `fake.${method}`, httpStatus, code, kind, messageEs: `Error simulado (${code}).` }));
    this.#failures.set(method, list);
  }

  #enter(method: keyof UnipileApi, args: unknown, opts?: UnipileCallOptions): void {
    this.calls.push({ method, args, channelAccountId: opts?.channelAccountId ?? null });
    const err = this.#failures.get(method)?.shift();
    if (err) throw err;
  }

  #id(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_${String(this.#seq).padStart(4, '0')}`;
  }

  #account(accountId: string, method: keyof UnipileApi): UnipileAccount {
    const a = this.accounts.get(accountId);
    if (!a) throw new OutreachApiError({ provider: 'unipile', endpoint: `fake.${method}`, httpStatus: 404, code: 'errors/resource_not_found', kind: 'permanent', messageEs: 'Cuenta desconocida.' });
    if (a.health === 'needs_reconnect') {
      throw new OutreachApiError({ provider: 'unipile', endpoint: `fake.${method}`, httpStatus: 401, code: 'errors/disconnected_account', kind: 'not_connected', messageEs: 'La cuenta está desconectada.' });
    }
    return a;
  }

  async request<T = unknown>(req: Parameters<UnipileApi['request']>[0], opts?: UnipileCallOptions): Promise<T> {
    this.#enter('request', req, opts);
    return {} as T;
  }

  async createHostedAuthLink(req: HostedAuthRequest, opts?: UnipileCallOptions): Promise<{ url: string }> {
    this.#enter('createHostedAuthLink', { ...req, state: '[estado]' }, opts);
    this.hostedLinks.push(req);
    return { url: `https://account.unipile.test/fake/${this.#id('link')}` };
  }

  async getAccount(accountId: string, opts?: UnipileCallOptions): Promise<UnipileAccount> {
    this.#enter('getAccount', { accountId }, opts);
    const a = this.accounts.get(accountId);
    if (!a) throw new OutreachApiError({ provider: 'unipile', endpoint: 'fake.getAccount', httpStatus: 404, code: 'errors/resource_not_found', kind: 'permanent', messageEs: 'Cuenta desconocida.' });
    return { ...a };
  }

  async listAccounts(opts?: UnipileCallOptions): Promise<UnipileAccount[]> {
    this.#enter('listAccounts', {}, opts);
    return [...this.accounts.values()].map((a) => ({ ...a }));
  }

  async sendMessage(req: SendMessageRequest, opts?: UnipileCallOptions): Promise<{ chatId: string | null; messageId: string | null }> {
    this.#enter('sendMessage', req, opts);
    this.#account(req.accountId, 'sendMessage');
    const chatId = req.chatId ?? this.#id('chat');
    if (!this.chats.has(chatId)) {
      this.chats.set(chatId, { id: chatId, accountId: req.accountId, attendeeProviderId: req.attendeeProviderId ?? null, name: null, lastMessageAt: null, unreadCount: 0 });
    }
    const messageId = this.#id('msg');
    const list = this.messages.get(chatId) ?? [];
    list.push({ id: messageId, chatId, senderId: req.accountId, text: req.text, isSender: true, sentAt: new Date(0) });
    this.messages.set(chatId, list);
    return { chatId, messageId };
  }

  async sendInvitation(req: { accountId: string; providerId: string; note?: string }, opts?: UnipileCallOptions): Promise<{ invitationId: string | null }> {
    this.#enter('sendInvitation', req, opts);
    if (req.note && [...req.note.trim()].length > LINKEDIN_INVITE_NOTE_MAX) {
      throw new OutreachApiError({ provider: 'unipile', endpoint: 'fake.sendInvitation', httpStatus: null, code: 'note_too_long', kind: 'permanent', messageEs: 'Nota demasiado larga.' });
    }
    this.#account(req.accountId, 'sendInvitation');
    return { invitationId: this.#id('inv') };
  }

  async getProfile(req: { accountId: string; identifier: string }, opts?: UnipileCallOptions): Promise<UnipileProfile> {
    this.#enter('getProfile', req, opts);
    this.#account(req.accountId, 'getProfile');
    return this.profiles.get(req.identifier) ?? { providerId: `prov_${req.identifier}`, publicIdentifier: req.identifier, name: null, headline: null };
  }

  async reactToPost(req: { accountId: string; postId: string; reaction?: string }, opts?: UnipileCallOptions): Promise<void> {
    this.#enter('reactToPost', req, opts);
    this.#account(req.accountId, 'reactToPost');
  }

  async commentOnPost(req: { accountId: string; postId: string; text: string }, opts?: UnipileCallOptions): Promise<void> {
    this.#enter('commentOnPost', req, opts);
    this.#account(req.accountId, 'commentOnPost');
  }

  async listChats(req: { accountId: string; cursor?: string; limit?: number }, opts?: UnipileCallOptions): Promise<UnipilePage<UnipileChat>> {
    this.#enter('listChats', req, opts);
    return { items: [...this.chats.values()].filter((c) => c.accountId === req.accountId), cursor: null };
  }

  async listMessages(req: { chatId: string; cursor?: string; limit?: number }, opts?: UnipileCallOptions): Promise<UnipilePage<UnipileMessage>> {
    this.#enter('listMessages', req, opts);
    return { items: [...(this.messages.get(req.chatId) ?? [])], cursor: null };
  }

  async createWebhook(req: CreateWebhookRequest, opts?: UnipileCallOptions): Promise<{ webhookId: string }> {
    this.#enter('createWebhook', { ...req, headers: Object.keys(req.headers) }, opts);
    const id = this.#id('wh');
    this.webhooks.push({ ...req, id });
    return { webhookId: id };
  }
}
