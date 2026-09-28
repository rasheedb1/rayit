/**
 * Cómo recorre un turno del worker (CIM-7) la pila de lo vencido: el
 * `walk` que src/tick.ts le pasa a runOnce (runner/once.ts). Lo que
 * --once no usa vive aquí, fuera de runner/:
 *
 *   · el presupuesto: no empieza una corrida si quedan menos de
 *     `minSliceMs`, y a la que empieza le pasa `deadline`, así su
 *     timeout_s es lo que queda del turno (`budget` si no empieza);
 *   · varios recorredores (`concurrency`) sobre la misma pila;
 *   · lo urgente primero (`first`: outbound.dispatch);
 *   · una corrida que lanza fuera de su job (el reclamo, la cuota, el
 *     cierre de su fila) queda como `error` y el turno sigue: nunca se
 *     responde sin el resumen de lo que sí corrió.
 *
 * Con más de un recorredor, el orden «lo de arriba antes que lo de
 * abajo» de planOnce no basta: si collect.post_metrics y compute.baseline
 * están vencidos a la vez (la puesta al día tras un despliegue o una
 * caída), el recorredor 2 tomaría compute.baseline en cuanto el 1 empieza
 * collect.post_metrics y lo calcularía con los datos de ayer; después
 * `ran` impediría el encadenado. Por eso un recorredor no saca de la pila
 * un job cuyo `after` sigue pendiente o corriendo en esta pasada
 * (blockedBy): toma el siguiente que no lo esté o, si no queda ninguno,
 * espera a que termine una corrida (settled).
 */
import type { Logger } from '../runner/logger.ts';
import type { PendingRun, Walk } from '../runner/once.ts';

export interface TurnoBudget {
  /** Hasta cuándo puede correr una corrida, en milisegundos de reloj de pared (Date.now()). */
  deadline: number;
  /** Lo mínimo que tiene que quedar para EMPEZAR una corrida. */
  minSliceMs: number;
}

export interface TurnoWalkOptions {
  budget: TurnoBudget;
  /** Cuántas corridas a la vez (≥ 1). */
  concurrency: number;
  /**
   * Jobs que, si están vencidos, empiezan antes que el resto (un toque
   * atrasado lo nota un cliente; un compute.* cinco minutos tarde, no).
   * Solo reordena lo que no corre después de nada.
   */
  first?: readonly string[];
  /** Donde queda el error de una corrida que lanzó (reclamo, cuota o cierre de su fila). */
  logger: Logger;
}

export function turnoWalk(opts: TurnoWalkOptions): Walk {
  return async (c) => {
    const { pending, ran } = c;
    if (opts.first?.length) {
      // La pila sale por el final: lo urgente al final. sort es estable, el resto conserva su orden.
      const first = new Set(opts.first);
      const urgent = (p: PendingRun) => (first.has(p.def.id) && (p.registration.options.after ?? []).length === 0 ? 1 : 0);
      pending.sort((a, b) => urgent(a) - urgent(b));
    }

    const inFlight = new Set<string>();
    let wake: () => void = () => undefined;
    let settled = new Promise<void>((resolve) => { wake = resolve; });
    const notify = (): void => {
      const w = wake;
      settled = new Promise<void>((resolve) => { wake = resolve; });
      w();
    };
    const blockedBy = (item: PendingRun): boolean =>
      (item.registration.options.after ?? []).some((id) => inFlight.has(id) || pending.some((p) => p.def.id === id && !ran.has(id)));
    /** El siguiente de la pila que puede empezar ya; 'wait' si todos esperan a una corrida en marcha; null si no queda nada. */
    const take = (): PendingRun | 'wait' | null => {
      for (let i = pending.length - 1; i >= 0; i--) {
        const item = pending[i]!;
        if (ran.has(item.def.id)) {
          pending.splice(i, 1); // ya corrió en esta pasada (el encadenado y su tick): una vez por pasada
          continue;
        }
        if (!blockedBy(item)) return pending.splice(i, 1)[0]!;
      }
      if (pending.length === 0) return null;
      // Nada en marcha a lo que esperar (no debería pasar: `after` no tiene ciclos): el de arriba de la pila.
      return inFlight.size > 0 ? 'wait' : pending.pop()!;
    };
    const walker = async (): Promise<void> => {
      for (let next = take(); next; next = take()) {
        if (next === 'wait') {
          await settled;
          continue;
        }
        if (c.signal?.aborted) {
          c.skip(next, 'shutting_down');
          continue;
        }
        if (opts.budget.deadline - Date.now() < opts.budget.minSliceMs) {
          c.skip(next, 'budget');
          continue;
        }
        inFlight.add(next.def.id);
        try {
          await c.run(next, opts.budget.deadline);
        } catch (err) {
          // Una corrida que lanza (el reclamo, la cuota o el cierre de su
          // fila, con la base caída o el pooler lleno) no tumba el turno:
          // con Promise.all, los demás recorredores seguirían corriendo
          // jobs mientras el turno ya respondió 500 sin su resumen, y el
          // pool se cerraría con sus filas todavía abiertas. Queda en el
          // resumen (`error`) y el recorredor sigue con el siguiente.
          opts.logger.error('una corrida del turno falló fuera de su job: el turno sigue con lo demás', { job: next.def.id, err });
          c.skip(next, 'error');
        } finally {
          inFlight.delete(next.def.id);
          notify();
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.floor(opts.concurrency)) }, walker));
  };
}
