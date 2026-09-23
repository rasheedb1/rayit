/**
 * Textos de Campañas que llegaron con CAM-3 (seguidores de la marca).
 * La ficha de CAM-1 aún escribe los suyos en línea; cuando se muden,
 * vienen aquí. Traducir Campañas es traducir este archivo.
 */
export const MESSAGES = {
  seguidores: {
    title: "Seguidores de la marca",
    /** «Instagram · @cafealma». */
    cardTitle: (red: string, handle: string) => `${red} · @${handle}`,
    ariaChart: (red: string, handle: string) => `Seguidores públicos de @${handle} en ${red} por día, con la línea base y la ventana de la campaña sombreadas`,
    labelsHeader: "Día",
    serie: "Seguidores",
    shadeBaseline: "Línea base",
    shadeCampaign: "Campaña",
    fuente: (red: string) => `perfil público en ${red}`,
    /** «12,9 al día antes · 155 al día en campaña · 1.240 ganados». */
    resumen: (antes: string | null, durante: string | null, ganados: string | null) =>
      [antes && `${antes} al día antes`, durante && `${durante} al día en campaña`, ganados && `${ganados} ganados`].filter(Boolean).join(" · "),
    ritmo: (veces: string) => `×${veces} el ritmo`,
    ritmoCorto: (veces: string) => `×${veces} el ritmo · línea base corta`,
    lineaBaseCorta: (desde: string, dias: number, requeridos: number) =>
      `Línea base desde el ${desde}: ${dias} ${dias === 1 ? "día" : "días"} de ${requeridos}. El ritmo es orientativo: la campaña se empezó a medir tarde.`,
    sinLineaBase: "Sin línea base: no hay lecturas antes del inicio de la campaña. Para compararla con su ritmo previo, la marca se empieza a medir 14 días antes de publicar.",
    sinCampana: "Todavía no hay lecturas dentro de la campaña: el ritmo aparece cuando empiece.",
    pillSinRitmo: "Ritmo sin calcular",
    pillSinLecturas: "Sin lecturas todavía",
    sinLecturas: (desde: string | null) =>
      desde
        ? `Todavía no hay lecturas. La marca se lee cada día a las 7:00 (UTC) desde el ${desde}; «Actualizar ahora» toma la de hoy.`
        : "Todavía no hay lecturas. La marca se empieza a medir cuando la campaña tenga fecha de inicio; «Actualizar ahora» toma la de hoy.",
    razonPill: {
      not_found: "No encontrada",
      not_discoverable: "No se puede leer",
      no_public_source: "Sin fuente pública",
    },
    razon: {
      not_found: (handle: string, red: string) => `No encontramos @${handle} en ${red}. Revisa que el usuario de la marca esté bien escrito en la campaña y que la cuenta sea pública.`,
      not_discoverable: (handle: string, red: string) => `${red} no deja leer @${handle} por este camino: solo se leen cuentas profesionales (creador o empresa) y públicas.`,
      no_public_source: (handle: string, red: string) => `${red} no publica los seguidores de @${handle} sin autorización del dueño. La campaña se mide por sus posts; los seguidores de la marca llegan cuando haya una fuente.`,
    },
    vacio: {
      title: "Esta campaña no tiene cuentas de la marca",
      description: "Los seguidores de la marca se leen de las redes que tenía la empresa al crear la campaña. Esta campaña no trajo ninguna.",
    },
    actualizar: "Actualizar ahora",
    actualizando: "Actualizando…",
    medicionTerminada: "La medición de la marca terminó con la campaña: la curva queda como estaba.",
    resultado: {
      guardada: "Listo: la lectura de hoy quedó guardada.",
      ya_hoy: "Ya había una lectura de hoy: se conserva la primera del día.",
    },
    errores: {
      no_existe: "Esa campaña ya no existe.",
      sin_cuentas: "Esta campaña no tiene cuentas de la marca que leer.",
      cerrada: "La medición de la marca terminó con la campaña.",
      sin_permiso_base: "Todavía no se puede actualizar desde aquí; la lectura diaria sigue llegando sola.",
      lectura: "No se pudo leer a la marca.",
      generico: "No se pudo leer a la marca. Inténtalo de nuevo en unos minutos.",
    },
    /** Lo que no dejó fila, por red (códigos de marca-service.ts). */
    avisos: {
      sin_credencial: (red: string) => `La lectura de ${red} no está configurada todavía; el equipo de On Cue lo tiene anotado.`,
      transitorio: (red: string) => `${red} no respondió; inténtalo de nuevo en unos minutos.`,
      sin_fuente: (red: string) => `${red} no tiene una fuente pública de seguidores en esta versión.`,
    },
  },
} as const;
