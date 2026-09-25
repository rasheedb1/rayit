/**
 * Las alertas diarias del outreach (VEN-15): qué está mal hoy en un
 * workspace, a partir de su salud. Funciones puras; las usa el job
 * outbound.alerts del worker y la pantalla /ventas/politica.
 */

// ---------------------------------------------------------------------
// 6 · Las alertas diarias
// ---------------------------------------------------------------------
//
// Con la salud de un workspace (outbound_health, 24 h) y lo que ella no
// trae (rebotes duros de lo enviado, toques que tocaban y no salieron),
// qué está mal hoy. Una alerta por tipo; el job decide si ya se avisó hoy.

export type OutreachAlertKind =
  | 'bounce_rate'
  | 'no_sends'
  | 'queue_stuck'
  | 'account_down'
  | 'llm_budget'
  | 'bounces_unread';

export const OUTREACH_ALERT_KINDS: readonly OutreachAlertKind[] = [
  'bounce_rate', 'no_sends', 'queue_stuck', 'account_down', 'llm_budget', 'bounces_unread',
];

/**
 * Las alertas que no esperan al resumen del día siguiente (r5): si una
 * cuenta cae o los rebotes se disparan después del resumen de la mañana,
 * el correo sale en la corrida siguiente. Las demás van en el resumen.
 */
export const URGENT_ALERT_KINDS: readonly OutreachAlertKind[] = ['bounce_rate', 'account_down'];

/** Sobre esta proporción de rebotes DUROS, alerta… */
export const BOUNCE_RATE_THRESHOLD = 0.05;
/** …pero solo con al menos estos correos enviados en la ventana: 1 de 3 no dice nada. */
export const BOUNCE_MIN_ATTEMPTS = 10;
/**
 * Un toque cuenta como «tocaba y no salió» si lleva al menos esto vencido:
 * el despachador pasa cada pocos minutos, y lo que venció hace diez no es
 * una avería.
 */
export const NO_SENDS_GRACE_H = 1;

/** Lo mínimo de outbound_health que hace falta (la forma de @mc/db, sin depender de ella). */
export interface HealthForAlerts {
  enabled: boolean;
  queue: { stuck: number };
  window: { sent: number };
  accountsDown: number;
  llm: { spentToday: number; dailyCap: number };
}

export interface AlertInput {
  health: HealthForAlerts;
  /** Correos ENVIADOS en la ventana (sent_at dentro): el denominador de la tasa. */
  emailsSent: number;
  /**
   * Rebotes DUROS de esos mismos correos: toques enviados en la ventana
   * con al menos un rebote 'hard' en outbound_bounce. Los blandos y los
   * bloqueos no cuentan (no dicen que la lista esté mal), y uno de un
   * correo de otro día tampoco: así la tasa nunca pasa del 100 %.
   */
  hardBounces: number;
  /**
   * Toques (cualquier canal) que tocaba enviar en la ventana y no
   * salieron: scheduled_for (o el reintento) dentro de la ventana, vencido
   * hace más de NO_SENDS_GRACE_H, y todavía en 'scheduled' o en 'failed'.
   * Un domingo sin nada programado da 0: no hay nada que avisar.
   */
  dueToSend: number;
  /**
   * Cuentas de Gmail conectadas cuyo buzón de rebotes no se leyó nunca o
   * lleva más de BOUNCES_STALE_H horas sin leerse (r5): mientras nadie
   * lee los rebotes, «ningún rebote» no quiere decir «todo llegó», y la
   * tasa de rebotes no puede avisar. Sin el dato (un fixture de antes), 0.
   */
  unreadMailboxes?: number;
}

export interface OutreachAlert {
  kind: OutreachAlertKind;
  severity: 'warning' | 'critical';
  /** Las cifras que la explican, para el texto del aviso. */
  values: Readonly<Record<string, number>>;
}

/**
 * Dónde está la tasa de rebotes respecto del aviso, con la misma regla
 * que evaluateOutreachAlerts, para que «Salud de hoy» diga por qué una
 * tasa alta todavía no avisa (1 de 4 es un 25 %, pero con menos de
 * BOUNCE_MIN_ATTEMPTS envíos no dice nada):
 *   · 'no_data'  ningún correo enviado en la ventana;
 *   · 'too_few'  menos de BOUNCE_MIN_ATTEMPTS: no se avisa todavía;
 *   · 'over'     sobre BOUNCE_RATE_THRESHOLD: avisa;
 *   · 'under'    por debajo: todo en orden.
 */
export type BounceRateStatus = 'no_data' | 'too_few' | 'over' | 'under';

export function bounceRateStatus(input: { emailsSent: number; hardBounces: number }): BounceRateStatus {
  if (input.emailsSent <= 0) return 'no_data';
  if (input.emailsSent < BOUNCE_MIN_ATTEMPTS) return 'too_few';
  const duros = Math.min(input.hardBounces, input.emailsSent);
  return duros / input.emailsSent > BOUNCE_RATE_THRESHOLD ? 'over' : 'under';
}

export function evaluateOutreachAlerts(input: AlertInput): OutreachAlert[] {
  const { health } = input;
  const alertas: OutreachAlert[] = [];
  const duros = Math.min(input.hardBounces, input.emailsSent);
  if (bounceRateStatus(input) === 'over') {
    alertas.push({
      kind: 'bounce_rate',
      severity: 'critical',
      values: { bounces: duros, attempts: input.emailsSent, rate: duros / input.emailsSent },
    });
  }
  // Con el envío apagado, cero envíos es lo esperado; y sin nada que
  // tocara enviar (fin de semana, días entre toques), también.
  if (health.enabled && input.dueToSend > 0 && health.window.sent === 0) {
    alertas.push({ kind: 'no_sends', severity: 'warning', values: { dueToSend: input.dueToSend } });
  }
  if (health.queue.stuck > 0) {
    alertas.push({ kind: 'queue_stuck', severity: 'warning', values: { stuck: health.queue.stuck } });
  }
  if (health.accountsDown > 0) {
    alertas.push({ kind: 'account_down', severity: 'critical', values: { accountsDown: health.accountsDown } });
  }
  if (health.llm.dailyCap > 0 && health.llm.spentToday >= health.llm.dailyCap) {
    alertas.push({
      kind: 'llm_budget',
      severity: 'warning',
      values: { spentToday: health.llm.spentToday, dailyCap: health.llm.dailyCap },
    });
  }
  const sinLeer = input.unreadMailboxes ?? 0;
  if (sinLeer > 0) {
    alertas.push({ kind: 'bounces_unread', severity: 'warning', values: { mailboxes: sinLeer } });
  }
  return alertas;
}
