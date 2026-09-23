/**
 * Cotizar · los errores del dominio, con su código para messages.ts.
 *
 * Parte de @mc/db/queries/cotizar (la entrada es ../cotizar.ts, que
 * reexporta cada pieza). Las reglas del módulo están en su cabecera.
 */
import type { RangoInvalido } from '@mc/core';

// ---------------------------------------------------------------------
// Errores
// ---------------------------------------------------------------------

export class CotizarError extends Error {
  readonly code: string;
  /** Lo que se le puede enseñar a una persona, en español. */
  readonly messageEs: string;
  constructor(code: string, messageEs: string) {
    super(messageEs);
    this.name = 'CotizarError';
    this.code = code;
    this.messageEs = messageEs;
  }
}

export class QuoteNotFound extends CotizarError {
  constructor() {
    super('QuoteNotFound', 'Esa cotización no existe en este espacio de trabajo.');
  }
}

export class QuoteNotEditable extends CotizarError {
  constructor(status: string) {
    super('QuoteNotEditable', `Una cotización en «${status}» ya no se edita: duplícala si necesitas cambiarla.`);
  }
}

export class QuoteTransitionError extends CotizarError {
  constructor(from: string, to: string) {
    super('QuoteTransitionError', `Una cotización en «${from}» no puede pasar a «${to}».`);
  }
}

export class RateCardNotFound extends CotizarError {
  constructor() {
    super('RateCardNotFound', 'Ese creador todavía no tiene tarifario.');
  }
}

export class MediaKitNotFound extends CotizarError {
  constructor() {
    super('MediaKitNotFound', 'Ese media kit no existe en este espacio de trabajo.');
  }
}

export class QuoteNotDraft extends CotizarError {
  constructor(status: string) {
    super('QuoteNotDraft', `Solo un borrador se borra; esta cotización está en «${status}».`);
  }
}

/** El código de cada motivo de validarRangoPrecio (@mc/core), para messages.ts. */
const CODIGO_RANGO: Record<RangoInvalido, string> = {
  vacio: 'RangoVacio',
  no_numero: 'RangoNoNumero',
  invertido: 'RangoInvertido',
  cero: 'RangoEnCero',
};

/**
 * Un rango de tarifario que no vale (al revés, vacío, en cero). Nunca
 * llega a la base: saveRateCard y overrideRateCardItemPrice lo paran
 * antes, con la misma regla que la pantalla y la acción.
 */
export class RangoDeTarifaInvalido extends CotizarError {
  readonly motivo: RangoInvalido;
  readonly deliverable: string | null;
  constructor(motivo: RangoInvalido, deliverable: string | null = null) {
    super(CODIGO_RANGO[motivo], `El rango${deliverable ? ` de «${deliverable}»` : ''} no es válido (${motivo}).`);
    this.motivo = motivo;
    this.deliverable = deliverable;
  }
}

/** Enviar una cotización cuya «válida hasta» ya pasó: nacería vencida. */
export class ValidezVencida extends CotizarError {
  constructor() {
    super('ValidezVencida', 'La fecha de validez ya pasó: cámbiala antes de enviar.');
  }
}
