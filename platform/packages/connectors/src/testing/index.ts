/**
 * @mc/connectors/testing: los dobles de los canales de outreach (VEN-9),
 * FakeGmail y FakeUnipile, detrás de las mismas interfaces que los
 * clientes reales (GmailApi, GoogleOAuthApi, UnipileApi).
 *
 * Viven fuera del barril de producción (@mc/connectors) a propósito: un
 * import equivocado en una pantalla o en un job compilaría sin aviso y
 * conectaría canales falsos. La regla no-restricted-imports de la web,
 * del worker y de este paquete prohíbe este subpath (y los archivos de
 * los dobles) fuera de las pruebas.
 */
export * from './fake-gmail.ts';
export * from './fake-unipile.ts';
