/**
 * Consultas del módulo Ventas: empresas y contactos (VEN-1), el radar
 * de señales (VEN-2) y el pipeline (VEN-3). Dueño: Rasheed.
 *
 * Pulido r6: el archivo pasaba de 2 800 líneas. Vive partido en
 * queries/ventas/, como queries/cadencias/, y este archivo solo
 * reexporta: la API de @mc/db/queries/ventas no cambia.
 *
 *   ventas/comun.ts         errores de dominio, tipos de fila, búsqueda
 *   ventas/empresas.ts      empresas (VEN-1)
 *   ventas/contactos.ts     contactos de una empresa (VEN-1)
 *   ventas/radar.ts         el radar de señales (VEN-2)
 *   ventas/pipeline.ts      el pipeline y las etapas (VEN-3)
 *   ventas/seguimientos.ts  el seguimiento a una cotización
 *   ventas/interno.ts       lo compartido que no es API (no se reexporta)
 *
 * Reglas que no cambian (las mismas de queries/finanzas.ts):
 *   - Toda función recibe un WorkspaceTx: una transacción con el
 *     workspace ya fijado. Ninguna recibe un workspace_id suelto. Las
 *     lecturas las filtra RLS; los INSERT escriben
 *     `current_workspace_id()`, nunca un valor que venga de la pantalla.
 *   - El dinero entra y sale como string decimal. Postgres devuelve
 *     numeric como texto y aquí no se convierte a number nunca.
 *   - Ningún número derivado se calcula en React: lo que la pantalla
 *     muestra ya viene sumado, contado o ponderado desde SQL (los KPI
 *     salen de getSalesKpis, el pipeline de la vista deal_pipeline).
 *   - Un id que llega de fuera se valida con `isUuid` antes de
 *     consultar; una búsqueda por id devuelve `null` cuando el id es
 *     imposible, igual que cuando no existe.
 *
 * Sobre el aislamiento de esta parte del esquema, que no es uniforme y
 * es fácil de leer mal (migraciones 0020, 0024, 0025 y 0026):
 *   - `company` tiene dueño (`owner_workspace_id`, que pone la base) y
 *     se lee «sin dueño o mía»: la empresa de otro workspace no se ve
 *     ni se nombra. Las filas sin dueño son el catálogo compartido: se
 *     leen, se vinculan, y no se editan desde aquí. Que una empresa esté
 *     en MI CRM lo sigue diciendo `company_link`, y por eso cada lectura
 *     de empresas entra por company_link con un JOIN: el catálogo solo
 *     no es mi lista.
 *   - `contact` lleva PII y su candado es `owner_workspace_id`, que pone
 *     la base sola (DEFAULT current_workspace_id()). Aquí NO se escribe
 *     a mano en ningún INSERT: si apareciera en una lista de columnas
 *     sería un error, no una optimización. El correo es único POR
 *     DUEÑO: que otro workspace tenga a la misma persona no impide
 *     guardarla, y la baja global la aplica la base (contact_suppression,
 *     que solo llena el worker con una baja verificada: la que marca
 *     un workspace se queda en su contacto, 0029 §1).
 *   - `opted_out` no vuelve a false: un trigger lo impide. La pantalla
 *     lo muestra como estado inamovible y esta capa no ofrece la
 *     operación contraria.
 */
export * from './ventas/comun.ts';
export * from './ventas/empresas.ts';
export * from './ventas/contactos.ts';
export * from './ventas/radar.ts';
export * from './ventas/pipeline.ts';
export * from './ventas/seguimientos.ts';
