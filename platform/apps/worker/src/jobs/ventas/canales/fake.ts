/**
 * El canal falso (VEN-10): un buzón en memoria detrás de la misma
 * interfaz que Gmail y Unipile. Lo usan las pruebas de punta a punta y
 * la demo (`job:dispatch -- --demo`, o OUTREACH_CHANNELS=fake). No hace
 * red, no necesita llaves y es determinista:
 *
 *   · cada envío queda en `sent`, con un id y un hilo propios (el
 *     segundo mensaje a la misma dirección va al mismo hilo, como en
 *     Gmail);
 *   · `failNext(n, falla)` hace que los próximos n envíos fallen con lo
 *     que se le diga (transitorio o permanente);
 *   · `reply(threadRef, texto)` deja una respuesta de la otra parte en el
 *     hilo, que readThread entrega una vez.
 */
import type { InboundMessage, OpenThread, SendFailure } from '@mc/db/queries/outreach';
import type { ChannelReader, ChannelSender, OutgoingMessage, SendResult } from './types.ts';
import type { DispatchChannel } from '@mc/db/queries/outreach';

export interface FakeSent extends OutgoingMessage {
  providerMessageId: string;
  threadRef: string;
  messageIdRfc: string | null;
}

export class FakeChannel implements ChannelSender, ChannelReader {
  readonly channel: DispatchChannel;
  readonly sent: FakeSent[] = [];
  readonly #failures: SendFailure[] = [];
  readonly #inbox = new Map<string, InboundMessage[]>();
  #seq = 0;

  constructor(channel: DispatchChannel) {
    this.channel = channel;
  }

  configured(): boolean {
    return true;
  }

  /** Los próximos `times` envíos fallan con `failure`. */
  failNext(times: number, failure: SendFailure): void {
    for (let i = 0; i < times; i++) this.#failures.push(failure);
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    const failure = this.#failures.shift();
    if (failure) return { ok: false, ...failure };
    this.#seq += 1;
    const n = String(this.#seq).padStart(4, '0');
    const prev = this.sent.find((s) => s.recipient === message.recipient);
    const threadRef = message.reply?.threadRef ?? prev?.threadRef ?? `fake-thread-${this.channel}-${n}`;
    const providerMessageId = `fake-${this.channel}-${n}`;
    const messageIdRfc = this.channel === 'email' ? `<${providerMessageId}@fake.oncue.test>` : null;
    this.sent.push({ ...message, providerMessageId, threadRef, messageIdRfc });
    return { ok: true, providerMessageId, threadRef, messageIdRfc };
  }

  /** La otra parte responde en un hilo. */
  reply(threadRef: string, body: string, at: Date, from?: string): InboundMessage {
    this.#seq += 1;
    const msg: InboundMessage = {
      providerMessageId: `fake-${this.channel}-in-${String(this.#seq).padStart(4, '0')}`,
      messageIdRfc: this.channel === 'email' ? `<in-${this.#seq}@fake.brand.test>` : null,
      inReplyTo: this.sent.filter((s) => s.threadRef === threadRef).at(-1)?.messageIdRfc ?? null,
      fromAddress: from ?? this.sent.find((s) => s.threadRef === threadRef)?.recipient ?? null,
      subject: null,
      body,
      occurredAt: at,
    };
    const list = this.#inbox.get(threadRef) ?? [];
    list.push(msg);
    this.#inbox.set(threadRef, list);
    return msg;
  }

  async readThread(thread: OpenThread): Promise<InboundMessage[]> {
    return (this.#inbox.get(thread.threadRef) ?? []).filter((m) => !thread.knownMessageIds.includes(m.providerMessageId));
  }
}

/** Un canal falso por cada canal del despachador. */
export function fakeChannels(): Record<DispatchChannel, FakeChannel> {
  return { email: new FakeChannel('email'), linkedin: new FakeChannel('linkedin'), instagram_dm: new FakeChannel('instagram_dm') };
}
