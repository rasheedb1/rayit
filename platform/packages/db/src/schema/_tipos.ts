/**
 * Helpers de columna compartidos por todo el esquema.
 *
 * Fijan las convenciones del proyecto (docs/base-de-datos.md) en un
 * solo sitio para que ninguna tabla las reinterprete:
 *   - fechas: timestamptz, y en TypeScript llegan como string ISO;
 *   - dinero: numeric(14,2) como string decimal, con la moneda aparte;
 *   - identificadores: uuid v4 generado en la base.
 */
import { char, customType, numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Texto insensible a mayúsculas (extensión citext): correos, slugs, dominios. */
export const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

/**
 * Hora de reloj sin fecha ni zona ('09:30:00'), como string. Es la hora
 * LOCAL de un paso de una cadencia: la zona la pone la secuencia. El
 * tipo se declara con su nombre largo porque así lo escribe
 * information_schema, que es contra lo que se compara el esquema.
 */
export const localTime = customType<{ data: string; driverData: string }>({
  dataType: () => 'time without time zone',
});

/** timestamptz que viaja como string ISO, nunca como Date del driver. */
export const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'string' });

/** numeric(14,2) como string decimal. Nunca se convierte a number. */
export const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

/** Moneda ISO-4217 (tres letras). */
export const currency = (name: string) => char(name, { length: 3 });

/** País ISO-3166-1 alfa-2. */
export const country = (name: string) => char(name, { length: 2 });

/** Clave primaria uuid generada por la base. */
export const uuidPk = () => uuid('id').defaultRandom().primaryKey();

export const createdAt = () => timestamptz('created_at').defaultNow().notNull();
export const updatedAt = () => timestamptz('updated_at').defaultNow().notNull();
