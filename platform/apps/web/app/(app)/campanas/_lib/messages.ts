import type { BrandCsvRejectReason, MissingInput } from "@mc/core";

/**
 * Textos de interfaz del módulo Campañas que no viven en una pantalla
 * concreta: «Lo que aportó la marca» (CAM-4), «Resultado» (CAM-5) y
 * «Seguidores de la marca» (CAM-3). Las pantallas
 * de CAM-1 conservan sus frases en el JSX hasta que las toque una
 * historia.
 */
export const MESSAGES = {
  aporte: {
    title: "Lo que aportó la marca",
    /** Cabeceras de la tabla por kind. */
    table: {
      caption: "Lo que la marca reportó de la campaña, por concepto",
      kind: "Concepto",
      value: "Cifra",
      asOf: "A qué fecha",
      /** «total» es el último reportado; «daily» es la suma de los días. */
      lastTotal: "último total",
      sum: "suma",
      /** Cuántas filas hay detrás de la cifra, cuando son más de una. */
      rows: (n: string) => `${n} filas`,
    },
    empty: {
      title: "La marca todavía no reportó nada",
      editable: "Registra canjes, pedidos, ingresos o registros con el formulario, o importa el CSV de ventas diarias. Es la entrada del resultado de la campaña.",
      locked: "Esta campaña ya no admite aportes de la marca.",
    },
    chart: {
      title: "Ventas diarias reportadas",
      series: "Ventas",
      labelsHeader: "Día",
      ariaLabel: "Ventas diarias que la marca reportó por CSV",
      source: "CSV de ventas de la marca",
    },
    /** Formulario «Registrar aporte». */
    form: {
      title: "Registrar aporte",
      open: "Registrar aporte",
      help: "Un total acumulado a la fecha, tal como lo reporta la marca. Si después manda otra cifra, la última manda.",
      kind: "Qué reporta",
      kindPlaceholder: "Elige el concepto",
      day: "A qué fecha",
      value: "Cifra",
      valueHelpCount: "Un número entero, sin decimales.",
      valueHelpMoney: "Con hasta dos decimales.",
      currency: "Moneda",
      notes: "Nota",
      notesHelp: "Opcional. Por ejemplo, «correo de la marca del lunes». No se comparte con nadie.",
      submit: "Guardar",
      cancel: "Cancelar",
      saved: "Aporte registrado.",
      savedAgain: "Ese aporte ya estaba registrado igual: no se duplicó.",
      currencyWarning: (currency: string, campaignCurrency: string) => `Se guardó en ${currency}; la campaña está en ${campaignCurrency}.`,
      error: "No se pudo registrar el aporte.",
    },
    /** Formulario «Importar CSV de ventas». */
    csv: {
      title: "Importar CSV de ventas",
      open: "Importar CSV de ventas",
      help: "Una fila por día con las columnas día y ventas; pedidos y canjes son opcionales. Fechas como 2026-09-02 o 02/09/2026, separador coma o punto y coma.",
      file: "Archivo CSV",
      submit: "Importar",
      importing: "Importando…",
      cancel: "Cancelar",
      window: (from: string, to: string) => `Solo entran días entre el ${from} y el ${to} (una semana antes del inicio y sesenta días después del fin).`,
      noDates: "La campaña no tiene fechas de inicio y fin: ponlas en «Editar datos» antes de importar.",
      error: "No se pudo importar el CSV.",
      tooBig: (kib: number) => `El archivo pasa de ${kib} KiB. Un CSV de ventas diarias es mucho más pequeño: revisa que sea el archivo correcto.`,
      tooManyRows: (max: number) => `El archivo trae más de ${max} filas. Es una fila por día: revisa que sea el archivo correcto.`,
      empty: "El archivo está vacío.",
      noHeader: "El archivo no tiene cabecera.",
      noRows: "El archivo no tiene filas debajo de la cabecera.",
      missingColumns: (which: string) => `Falta la columna ${which}. Las cabeceras válidas son día (o fecha) y ventas; pedidos y canjes son opcionales.`,
      missing: "Elige un archivo.",
      notCsv: "El archivo tiene que ser un CSV.",
      /** El resumen de una importación. */
      summary: {
        title: "Importación terminada",
        days: (n: number) => (n === 1 ? "1 día aceptado" : `${n} días aceptados`),
        inserted: (n: number) => (n === 1 ? "1 dato nuevo" : `${n} datos nuevos`),
        unchanged: (n: number) => (n === 1 ? "1 ya estaba igual" : `${n} ya estaban igual`),
        replaced: (n: number) => (n === 1 ? "1 corregido con la cifra del archivo" : `${n} corregidos con la cifra del archivo`),
        rejected: (n: number) => (n === 1 ? "1 fila rechazada" : `${n} filas rechazadas`),
        nothing: "Ninguna fila se pudo importar.",
        row: (line: number) => `Fila ${line}`,
        encoding: "El archivo venía en Windows-1252 (Excel) y se leyó igual.",
        another: "Importar otro archivo",
      },
      reason: {
        fecha_ilegible: "la fecha no se entiende",
        fuera_de_rango: "queda fuera del rango de la campaña",
        dia_repetido: "el día ya venía antes en el archivo",
        ventas_vacia: "no trae ventas",
        ventas_ilegible: "las ventas no son un número",
        ventas_negativa: "las ventas son negativas",
        pedidos_ilegible: "los pedidos no son un entero",
        canjes_ilegible: "los canjes no son un entero",
      } satisfies Record<BrandCsvRejectReason, string>,
    },
  },
  /** «Resultado» (CAM-5): los seis KPIs de campaign_result. */
  resultado: {
    title: "Resultado",
    kpi: {
      views: "Views",
      reach: "Alcance",
      clicks: "Clics al enlace",
      redemptions: "Canjes del código",
      followers: "Seguidores ganados por la marca",
      cpm: "CPM",
    },
    /** Lo que dice una cifra que no está. Nunca un cero ni un guion. */
    absent: {
      brand: "Sin datos de la marca",
      posts: "Sin posts medidos",
      clicks: "Sin datos de clics",
      amount: "Sin monto acordado",
      /** Una cifra vacía sin causa registrada (una fila antigua): no se inventa el porqué. */
      notComputed: "Sin calcular",
    },
    note: {
      vsMedian: (x: string) => `${x} tu mediana`,
      nonFollowers: (pct: string) => `${pct} no te seguía`,
      revenue: (money: string) => `${money} en ventas atribuidas`,
      rate: (x: string) => `${x} su ritmo previo`,
      /** CAM-3: con menos de dos semanas de línea base, el ritmo no se compara. */
      rateShort: "línea base corta: sin ritmo comparable",
      cpa: (money: string) => `CPA ${money}`,
      cpaAbsent: "CPA sin datos de la marca",
      cpaNoAmount: "CPA sin monto acordado",
      cpaNoRedemptions: "CPA sin canjes reportados",
      costPerFollower: (money: string) => `${money} por seguidor`,
    },
    cut: (label: string) => `a ${label}`,
    partialCut: (label: string) => `parcial, a ${label}; se recalcula solo hasta llegar a 30 días`,
    asOfSource: (cut: string) => `resultado calculado ${cut}`,
    noCut: "sin posts medidos",
    /** Qué conceptos salen del CSV aunque haya también un total por formulario. */
    fromCsv: (concepts: string) => `${concepts} salen del CSV de ventas; el total por formulario queda como respaldo.`,
    concepts: { redemptions: "Los canjes", revenue: "Los ingresos", both: "Los canjes y los ingresos" },
    otherCurrency: (currency: string, campaign: string) => `Los ingresos que reportó la marca están en ${currency}: no se atribuyen a un resultado en ${campaign}.`,
    missingTitle: "Falta",
    missing: {
      posts: "posts con lecturas: asocia los posts de la campaña o espera su primera lectura",
      amount: "el monto acordado: sin él no hay CPM ni CPA",
      baseline: "la línea base del creador en alguna red: conecta más videos",
      brand_followers: "los seguidores de la marca",
      brand_followers_baseline_short: "dos semanas de seguidores de la marca antes de publicar",
      brand_inputs: "lo que aportó la marca: canjes, ingresos o el CSV de ventas",
      brand_csv_sales: "el CSV de ventas diarias de la marca",
    } satisfies Record<MissingInput, string>,
    complete: "Resultado completo a 30 días: ya puedes marcar el reporte listo.",
    empty: {
      title: "Todavía no hay resultado",
      description: "Se calcula cada mañana para las campañas en curso, en medición o con reporte listo, desde los posts asociados y lo que aporta la marca.",
      planned: "Una campaña planeada todavía no tiene posts que medir. El resultado empieza cuando la campaña esté en curso.",
    },
    daily: "Se recalcula cada mañana.",
    frozen: "Una campaña cerrada conserva su resultado: ya no se recalcula.",
    recompute: "Recalcular",
    recomputeError: "No se pudo recalcular el resultado.",
    recomputeDenied: "Desde la ficha todavía no se puede recalcular: el resultado se actualiza cada mañana.",
  },
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
