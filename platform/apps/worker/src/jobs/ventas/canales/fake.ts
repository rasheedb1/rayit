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
 *   · `deliverThenFail(n)` hace que los próximos n envíos SALGAN pero
 *     respondan con un corte ambiguo (el timeout después del POST): es
 *     lo que findSent tiene que descubrir para no duplicar;
 *   · `unverifiable` hace que findSent no lo sepa decir ('unknown');
 *   · `slow(ms)` hace que cada envío tarde (para cortar la corrida a mitad);
 *   · `reply(threadRef, texto)` deja una respuesta de la otra parte en el
 *     hilo (o una automática), que readThread entrega una vez.
 */
import type { InboundMessage, OpenThread, SendFailure } from '@mc/db/queries/outreach';
import type { ChannelReader, ChannelSender, FindSentResult, OutgoingMessage, SendResult } from './types.ts';
import type { DispatchChannel } from '@mc/db/queries/outreach';

export interface FakeSent extends OutgoingMessage {
  providerMessageId: string;
  threadRef: string;
  messageIdRfc: string | null;
}

export class FakeChannel implements ChannelSender, ChannelReader {
  readonly channel: DispatchChannel;
  readonly sent: FakeSent[] = [];
  readonly #failures: Array<SendFailure & { delivered?: boolean }> = [];
  #delayMs = 0;
  /** findSent responde 'unknown' (un canal que no sabe comprobar). */
  unverifiable = false;
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

  /** Los próximos `times` envíos salen, pero la respuesta se corta: el resultado es ambiguo. */
  deliverThenFail(times: number): void {
    for (let i = 0; i < times; i++) {
      this.#failures.push({ kind: 'transient', code: 'network_ambiguous', message: 'timeout después del POST', ambiguous: true, delivered: true });
    }
  }

  /** Cada envío tarda `ms`, como un proveedor lento. */
  slow(ms: number): void {
    this.#delayMs = ms;
  }

  async send(message: OutgoingMessage): Promise<SendResult> {
    if (this.#delayMs > 0) await new Promise((r) => setTimeout(r, this.#delayMs));
    const failure = this.#failures.shift();
    if (failure) {
      const { delivered, ...rest } = failure;
      if (delivered) this.#deliver(message);
      return { ok: false, ...rest };
    }
    const proof = this.#deliver(message);
    return { ok: true, ...proof };
  }

  async findSent(message: OutgoingMessage): Promise<FindSentResult> {
    if (this.unverifiable) return { found: 'unknown', reason: 'el canal falso no sabe comprobarlo' };
    const hit = this.sent.find((s) => s.touchId === message.touchId && s.attempt === message.attempt);
    return hit ? { found: true, proof: { providerMessageId: hit.providerMessageId, threadRef: hit.threadRef, messageIdRfc: hit.messageIdRfc } } : { found: false };
  }

  #deliver(message: OutgoingMessage): { providerMessageId: string; threadRef: string; messageIdRfc: string | null } {
    this.#seq += 1;
    const n = String(this.#seq).padStart(4, '0');
    const prev = this.sent.find((s) => s.recipient === message.recipient);
    const threadRef = message.reply?.threadRef ?? prev?.threadRef ?? `fake-thread-${this.channel}-${n}`;
    const providerMessageId = `fake-${this.channel}-${n}`;
    const messageIdRfc = this.channel === 'email' ? `<${providerMessageId}@fake.oncue.test>` : null;
    this.sent.push({ ...message, providerMessageId, threadRef, messageIdRfc });
    return { providerMessageId, threadRef, messageIdRfc };
  }

  /** La otra parte responde en un hilo. `automatic`: un «fuera de oficina» (Auto-Submitted). */
  reply(threadRef: string, body: string, at: Date, from?: string, opts: { automatic?: boolean } = {}): InboundMessage {
    this.#seq += 1;
    const msg: InboundMessage = {
      providerMessageId: `fake-${this.channel}-in-${String(this.#seq).padStart(4, '0')}`,
      messageIdRfc: this.channel === 'email' ? `<in-${this.#seq}@fake.brand.test>` : null,
      inReplyTo: this.sent.filter((s) => s.threadRef === threadRef).at(-1)?.messageIdRfc ?? null,
      fromAddress: from ?? this.sent.find((s) => s.threadRef === threadRef)?.recipient ?? null,
      subject: null,
      body,
      occurredAt: at,
      automatic: opts.automatic === true,
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
