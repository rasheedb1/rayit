/** Jobs del módulo Conexiones (dueño: Nicolás). */
import { collectAccountMetricsJob } from './collect-account-metrics.ts';
import { collectPostMetricsJob } from './collect-post-metrics.ts';
import { collectPostsJob } from './collect-posts.ts';
import { computeBaselineJob } from './compute-baseline.ts';
import { computePostScoreJob } from './compute-post-score.ts';
import { oauthRefreshJob } from './oauth-refresh.ts';

export const conexionesJobs = [
  oauthRefreshJob,
  collectAccountMetricsJob,
  // CON-5 recolecta; CON-6 calcula sobre lo recolectado, cinco minutos después.
  collectPostsJob,
  collectPostMetricsJob,
  computeBaselineJob,
  computePostScoreJob,
];
