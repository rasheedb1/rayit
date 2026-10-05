/** Tipos de foto.mjs para quien lo importa desde TypeScript. */
import type { PGlite } from '@electric-sql/pglite';

export const FOTO_DIR: string;

/** La ruta real del @electric-sql/pglite que resuelve el módulo `desde` (su import.meta.url): lleva la versión. */
export function motorDe(desde: string | URL): string;

export interface FotoMigradaOptions {
  /** El constructor de PGlite de quien pide la foto (se carga con el mismo). */
  PGlite: typeof PGlite;
  /** Las extensiones con las que se crea y se cargará la base. */
  extensions: NonNullable<Parameters<typeof PGlite.create>[0]>['extensions'];
  /** motorDe(import.meta.url) de quien la pide: la versión de PGlite va en la ruta. */
  motor: string;
  /** Qué preparación es; lo que cambie la base cambia la clave. */
  clave: string;
  /** Roles y migraciones sobre un PGlite nuevo. Nunca seeds. */
  preparar(pglite: PGlite): Promise<void>;
  /** Directorio de migraciones; por defecto db/migrations. */
  dir?: string;
}

/** Blob de dumpDataDir de una base migrada, compartido entre procesos por node_modules/.cache/mc-pglite. */
export function fotoMigrada(opts: FotoMigradaOptions): Promise<Blob>;
