/** Jobs del módulo Ventas (dueño: Rasheed). */
import { canalesKeepaliveJob } from './canales.keepalive.ts';
import { seguimientosJob } from './seguimientos.ts';

export const ventasJobs = [seguimientosJob, canalesKeepaliveJob];
