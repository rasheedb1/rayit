/** Jobs del módulo Conexiones (dueño: Nicolás). */
import { collectAccountMetricsJob } from './collect-account-metrics.ts';
import { computeBaselineJob } from './compute-baseline.ts';
import { computePostScoreJob } from './compute-post-score.ts';
import { oauthRefreshJob } from './oauth-refresh.ts';

export const conexionesJobs = [oauthRefreshJob, collectAccountMetricsJob, computeBaselineJob, computePostScoreJob];
