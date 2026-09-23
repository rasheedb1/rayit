/** Jobs del módulo Ventas (dueño: Rasheed). */
import { alertasJob } from './outbound.alerts.ts';
import { bouncesJob } from './outbound.bounces.ts';
import { seguimientosJob } from './seguimientos.ts';

export const ventasJobs = [seguimientosJob, bouncesJob, alertasJob];
