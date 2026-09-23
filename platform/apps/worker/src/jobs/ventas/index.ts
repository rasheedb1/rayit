/** Jobs del módulo Ventas (dueño: Rasheed). */
import { dispatchJob } from './outbound.dispatch.ts';
import { repliesJob } from './outbound.replies.ts';
import { seguimientosJob } from './seguimientos.ts';

export const ventasJobs = [seguimientosJob, dispatchJob, repliesJob];
