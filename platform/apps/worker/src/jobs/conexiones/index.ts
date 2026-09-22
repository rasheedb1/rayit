/** Jobs del módulo Conexiones (dueño: Nicolás). */
import { collectAccountMetricsJob } from './collect-account-metrics.ts';
import { oauthRefreshJob } from './oauth-refresh.ts';

export const conexionesJobs = [oauthRefreshJob, collectAccountMetricsJob];
