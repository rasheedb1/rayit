/** Jobs del módulo Ventas (dueño: Rasheed). */
import { canalesKeepaliveJob } from './canales.keepalive.ts';
import { canalesReleaseJob } from './canales.release.ts';
import { seguimientosJob } from './seguimientos.ts';

export const ventasJobs = [seguimientosJob, canalesKeepaliveJob, canalesReleaseJob];
