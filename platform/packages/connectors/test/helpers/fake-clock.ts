/** Reloj falso: `now()` devuelve el instante simulado y `sleep()` lo avanza sin timers reales. */
export class FakeClock {
  nowMs: number;
  readonly sleeps: number[] = [];

  constructor(start = Date.parse('2026-09-22T10:00:00Z')) {
    this.nowMs = start;
  }

  now = (): Date => new Date(this.nowMs);

  sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    this.sleeps.push(ms);
    if (signal?.aborted) return;
    this.nowMs += ms;
  };

  advance(ms: number): void {
    this.nowMs += ms;
  }
}

/** Respuesta JSON mínima para un fetch falso. */
export function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}
