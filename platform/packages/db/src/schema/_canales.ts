/**
 * Los canales del outbound (0007, 0046). Viven en un módulo sin
 * dependencias porque ventas.ts y outreach.ts se referencian entre sí
 * (el toque apunta a su enrolamiento; el enrolamiento, a su contacto), y
 * una constante que se usa al cargar no puede estar en ninguno de los
 * dos: según cuál se importe primero, la otra aún no existiría.
 */
export const OUTBOUND_CHANNELS = ['email', 'linkedin', 'instagram_dm', 'whatsapp'] as const;
export type OutboundChannel = (typeof OUTBOUND_CHANNELS)[number];
