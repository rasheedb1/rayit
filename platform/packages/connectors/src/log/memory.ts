import type { CallLogEntry, CallLogSink } from './sink.ts';

/** Sink en memoria para pruebas: guarda cada entrada tal cual. */
export class InMemoryCallLogSink implements CallLogSink {
  readonly entries: CallLogEntry[] = [];
  /** Si se define, record() lanza: para probar que el fallo del log no tumba la llamada. */
  failWith: Error | null = null;

  async record(entry: CallLogEntry): Promise<void> {
    if (this.failWith) throw this.failWith;
    this.entries.push({ ...entry });
  }

  byEndpoint(endpoint: string): CallLogEntry[] {
    return this.entries.filter((e) => e.endpoint === endpoint);
  }
}

/** Sink que descarta: para un HttpCore cuyo registro ya hace otro (el job oauth.refresh escribe su propia fila). */
export const NULL_CALL_LOG: CallLogSink = { async record() {} };
