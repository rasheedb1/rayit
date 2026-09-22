/** Lee job_definition, la fuente de verdad de qué corre, cuándo y con qué límites. */
import type { Queryable } from './db.ts';
import type { JobDefinition } from './registry.ts';

interface DefinitionRow extends Record<string, unknown> {
  id: string;
  label_es: string;
  queue: string;
  default_cron: string | null;
  timeout_s: number;
  max_attempts: number;
  max_concurrency: number;
  enabled: boolean;
}

export async function loadJobDefinitions(db: Queryable): Promise<JobDefinition[]> {
  const { rows } = await db.query<DefinitionRow>(
    `SELECT id, label_es, queue, default_cron, timeout_s, max_attempts, max_concurrency, enabled
       FROM job_definition ORDER BY queue, id`,
  );
  return rows.map((r) => ({
    id: r.id,
    labelEs: r.label_es,
    queue: r.queue,
    defaultCron: r.default_cron,
    timeoutS: Number(r.timeout_s),
    maxAttempts: Number(r.max_attempts),
    maxConcurrency: Number(r.max_concurrency),
    enabled: r.enabled,
  }));
}
