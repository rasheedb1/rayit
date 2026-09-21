// Quién es quién. El id es el que usan las historias del backlog.
export const OWNERS = {
  rasheed: {
    id: "rasheed",
    name: "Rasheed",
    initials: "R",
    chain: "Lo que el creador ve y vende",
    focus: "Resumen, Ventas y Cotizar. De cimientos: base de datos, autenticación, despliegue y los trámites.",
  },
  nicolas: {
    id: "nicolas",
    name: "Nicolás",
    initials: "N",
    chain: "Lo que entra por las APIs y lo que sale a la marca y al banco",
    focus: "Conexiones, Campañas y Finanzas. De cimientos: el marco de la app y el kit de interfaz.",
  },
} as const;

export type OwnerId = keyof typeof OWNERS;
export const OWNER_IDS = Object.keys(OWNERS) as OwnerId[];
