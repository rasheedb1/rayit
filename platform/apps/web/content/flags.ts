// Banderas de módulo. Un módulo apagado desaparece de la navegación y
// su ruta responde 404. Cuando exista el cliente de base (CIM-2), esto
// pasa a leerse de la tabla feature_flag por workspace.
export const flags = {
  resumen: true,
  ventas: true,
  cotizar: true,
  campanas: true,
  finanzas: true,
  conexiones: true,
  // Fase 2: modelados en la base, apagados en el MVP.
  videos: false,
  nicho: false,
  ideas: false,
  laboratorio: false,
  agencia: false,
} as const;

export type FlagKey = keyof typeof flags;
