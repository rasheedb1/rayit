/** Tipos de foto.mjs para quien lo importa desde TypeScript. */
import type { PGlite } from '@electric-sql/pglite';
import type { MigrationExec } from './aplicar.mjs';

type Extensions = NonNullable<NonNullable<Parameters<typeof PGlite.create>[0]>['extensions']>;

/** node_modules/.cache/mc-pglite de platform, o MC_PGLITE_FOTO_DIR. */
export const FOTO_DIR: string;

/** Las extensiones de todas las bases de pruebas: citext y pg_trgm. */
export const EXTENSIONES: readonly string[];

/** La ruta real del @electric-sql/pglite que resuelve el módulo `desde` (su import.meta.url): lleva la versión. */
export function motorDe(desde: string | URL): string;

/** Las EXTENSIONES del mismo PGlite que `motor`. */
export function extensionesDe(motor: string): Promise<Extensions>;

/** exec() de PGlite como lo quiere el runner de aplicar.mjs. */
export function execPglite(pglite: PGlite): MigrationExec;

export interface FotoMigradaOptions {
  /** El constructor de PGlite de quien pide la foto (se carga con el mismo). */
  PGlite: typeof PGlite;
  /** Las extensiones con las que se crea y se cargará la base; sus nombres entran en la huella. */
  extensions: Extensions;
  /** motorDe(import.meta.url) de quien la pide: la versión de PGlite va en la ruta. */
  motor: string;
  /** Qué preparación es; su primer trozo (hasta «:») es el prefijo del archivo. */
  clave: string;
  /** Roles, migraciones o seeds sobre un PGlite nuevo (o abierto desde `desde`). */
  preparar(pglite: PGlite): Promise<void>;
  /** Directorio de migraciones; por defecto db/migrations. */
  dir?: string;
  /** Archivos o carpetas cuyo contenido entra en la huella (el módulo de `preparar`, los seeds). */
  fuentes?: readonly string[];
  /** La foto de la que parte, si no parte de una base vacía. */
  desde?: () => Promise<Blob>;
  /** Dónde se guarda; por omisión FOTO_DIR. */
  carpeta?: string;
}

/** Blob de dumpDataDir de una base preparada, compartido entre procesos por FOTO_DIR. */
export function fotoMigrada(opts: FotoMigradaOptions): Promise<Blob>;

/** La base del worker y de los conectores (migraciones como superusuario), abierta desde la foto. */
export function abrirSuperusuario(opts: { PGlite: typeof PGlite; desde: string | URL }): Promise<PGlite>;
