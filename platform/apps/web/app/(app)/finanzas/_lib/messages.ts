/**
 * Textos de interfaz del módulo Finanzas que no viven en una pantalla
 * concreta: el estado de error y el de carga del segmento. Un solo
 * sitio por módulo para que traducirlos o corregirlos no sea buscar por
 * el árbol.
 */
export const MESSAGES = {
  error: {
    eyebrow: "Finanzas",
    title: "No pudimos leer tus facturas",
    description:
      "La base de datos no respondió a tiempo o rechazó la conexión. Tus datos no cambiaron; vuelve a intentarlo y, si sigue igual, avísanos.",
    retry: "Reintentar",
    /** Solo se muestra cuando Next entrega un identificador del error (producción). */
    reference: "Referencia",
  },
  loading: {
    label: "Cargando facturas",
    kpis: ["Por cobrar", "Vencido", "Cobrado este año", "Apartado para impuestos"],
    section: "Facturas",
  },
} as const;
