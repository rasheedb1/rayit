/** Tipos de aplicar.mjs para quien lo importa desde TypeScript (packages/db). */

/** Ejecuta una o varias sentencias SQL sin parámetros y devuelve las filas de la última. */
export type MigrationExec = (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }>;

export interface ApplyMigrationsOptions {
  /** Directorio con *.sql; por defecto db/migrations. */
  dir?: string;
  onApplied?: (file: string, ms: number) => void;
  onSkipped?: (file: string) => void;
}

export interface ApplyMigrationsResult {
  applied: string[];
  skipped: string[];
}

export interface ApplySeedsOptions {
  /** Directorio con *.sql; por defecto db/seed. */
  dir?: string;
  onApplied?: (file: string, ms: number) => void;
}

export const MIGRATIONS_DIR: string;
export const SEED_DIR: string;
export const REGISTRY_SQL: string;

export function checksumOf(sql: string): string;
export function listSql(dir: string): Promise<string[]>;
export function applyMigrations(exec: MigrationExec, opts?: ApplyMigrationsOptions): Promise<ApplyMigrationsResult>;
export function applySeeds(exec: MigrationExec, opts?: ApplySeedsOptions): Promise<string[]>;

export class DuplicateMigrationNumberError extends Error {
  files: string[];
  constructor(files: string[]);
}
export class MigrationChangedError extends Error {
  readonly file: string;
  constructor(file: string);
}

export class MigrationFailedError extends Error {
  readonly file: string;
  constructor(file: string, cause: unknown);
}

export class SeedFailedError extends Error {
  readonly file: string;
  constructor(file: string, cause: unknown);
}
