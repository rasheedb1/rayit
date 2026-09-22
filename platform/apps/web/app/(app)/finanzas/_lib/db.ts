// La conexión vive en lib/db/ desde CAM-1, compartida con Campañas.
// Finanzas la sigue importando desde aquí para no tocar sus páginas.
export { getDb, withWorkspace } from "@/lib/db";
