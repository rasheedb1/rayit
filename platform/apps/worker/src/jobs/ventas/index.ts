/** Jobs del módulo Ventas (dueño: Rasheed). */
import { canalesKeepaliveJob } from './canales.keepalive.ts';
import { canalesReleaseJob } from './canales.release.ts';
import { alertasJob } from './outbound.alerts.ts';
import { bouncesJob } from './outbound.bounces.ts';
import { dispatchJob } from './outbound.dispatch.ts';
import { repliesJob } from './outbound.replies.ts';
import { seguimientosJob } from './seguimientos.ts';

export const ventasJobs = [
  seguimientosJob,
  canalesKeepaliveJob,
  canalesReleaseJob,
  dispatchJob,
  repliesJob,
  bouncesJob,
  alertasJob,
];
