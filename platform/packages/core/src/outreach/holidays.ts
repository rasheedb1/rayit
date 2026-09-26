/**
 * Los festivos nacionales en los que el motor no envía outreach en frío
 * (VEN-10): un correo a una marca el 25 de diciembre, o el lunes festivo
 * del 12 de octubre en Colombia, se ve como un descuido.
 *
 * Una tabla por país (ISO 3166-1 alfa-2, el de workspace.country), con
 * los días ya trasladados al lunes donde la ley lo dice (en Colombia, la
 * Ley 18 de 1983 «Emiliani»). Un país que no está no tiene festivos: los
 * días hábiles son de lunes a viernes, como hasta ahora. Añadir un país
 * es añadir su lista aquí, sin tocar el motor; los años que faltan se
 * añaden antes de que empiecen (la prueba de holidays avisa si el año
 * siguiente no está).
 */

/** Festivos por país, 'YYYY-MM-DD' en el calendario local. */
export const PUBLIC_HOLIDAYS: Readonly<Record<string, readonly string[]>> = {
  CO: [
    // 2026 (Pascua: 5 de abril)
    '2026-01-01', '2026-01-12', '2026-03-23', '2026-04-02', '2026-04-03', '2026-05-01', '2026-05-18', '2026-06-08',
    '2026-06-15', '2026-06-29', '2026-07-20', '2026-08-07', '2026-08-17', '2026-10-12', '2026-11-02', '2026-11-16',
    '2026-12-08', '2026-12-25',
    // 2027 (Pascua: 28 de marzo)
    '2027-01-01', '2027-01-11', '2027-03-22', '2027-03-25', '2027-03-26', '2027-05-01', '2027-05-10', '2027-05-31',
    '2027-06-07', '2027-07-05', '2027-07-20', '2027-08-07', '2027-08-16', '2027-10-18', '2027-11-01', '2027-11-15',
    '2027-12-08', '2027-12-25',
  ],
};

/** Los festivos del país del workspace; ninguno si no hay país o no está en la tabla. */
export function holidaysFor(country: string | null | undefined): readonly string[] {
  if (!country) return [];
  return PUBLIC_HOLIDAYS[country.trim().toUpperCase()] ?? [];
}
