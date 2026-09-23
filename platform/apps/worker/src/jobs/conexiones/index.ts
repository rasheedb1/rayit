/** Jobs del módulo Conexiones (dueño: Nicolás). */
import { collectAccountMetricsJob } from './collect-account-metrics.ts';
import { collectDemographicsJob } from './collect-demographics.ts';
import { oauthRefreshJob } from './oauth-refresh.ts';

export const conexionesJobs = [oauthRefreshJob, collectAccountMetricsJob, collectDemographicsJob];
