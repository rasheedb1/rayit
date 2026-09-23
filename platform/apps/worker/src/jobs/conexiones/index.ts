/** Jobs del módulo Conexiones (dueño: Nicolás). */
import { collectAccountMetricsJob } from './collect-account-metrics.ts';
import { collectDemographicsJob } from './collect-demographics.ts';
import { collectPostMetricsJob } from './collect-post-metrics.ts';
import { collectPostsJob } from './collect-posts.ts';
import { oauthRefreshJob } from './oauth-refresh.ts';

export const conexionesJobs = [oauthRefreshJob, collectAccountMetricsJob, collectPostsJob, collectPostMetricsJob, collectDemographicsJob];
