/**
 * Textos de interfaz del módulo Finanzas que no viven en una pantalla
 * concreta: el estado de error y el de carga del segmento, y la
 * pantalla de configuración completa. Un solo sitio por módulo para que
 * traducirlos o corregirlos no sea buscar por el árbol.
 */
export const MESSAGES = {
  /**
   * El nombre y el título de la frontera de error. Lo demás —las causas,
   * la pista de despliegue, Reintentar y Volver al plan— es el de la
   * aplicación ((app)/_lib/messages.ts): la ronda 3 tenía aquí «la base
   * no respondió», que era falso con un workspace que no existe.
   */
  error: {
    eyebrow: "Finanzas",
    title: "No pudimos leer tus facturas",
  },
  loading: {
    label: "Cargando facturas",
    kpis: ["Por cobrar", "Vencido", "Cobrado este año", "Apartado para impuestos"],
    section: "Facturas",
  },

  /** FIN-8 · /finanzas/configuracion */
  configuracion: {
    meta: "Configuración financiera",
    eyebrow: "Finanzas",
    titulo: "Con qué números nace cada factura",
    descripcion:
      "El IVA, la retención y el plazo con los que se prellena una factura nueva, cuánto apartas de cada cobro para impuestos, y los datos que la factura imprime. Cambiarlos afecta a lo que venga; lo ya emitido se queda como está.",
    volver: "Volver a facturas",
    enlaceDesdeLista: "Configuración",

    error: {
      eyebrow: "Finanzas",
      title: "No pudimos leer tu configuración",
    },
    cargando: "Cargando la configuración financiera",

    sinPermiso: {
      titulo: "Esta pantalla es de quien manda en el espacio",
      descripcion:
        "La configuración financiera la cambian el dueño del espacio y quien lo administre. Si necesitas ajustar el IVA, la retención o los datos de facturación, pídeselo a quien te invitó.",
      accion: "Volver a facturas",
    },

    porcentajes: {
      titulo: "Porcentajes y plazo",
      ayuda: "Son los valores con los que se prellena una factura nueva. En la factura se pueden cambiar una a una.",
      iva: "IVA %",
      ivaAyuda: "El general de tu país. Cero si no facturas IVA.",
      retencion: "Retención en la fuente %",
      retencionAyuda: "Lo que la marca te retiene al pagar. No se resta del total de la factura.",
      reserva: "Reserva de impuestos %",
      reservaAyuda: "Cuánto se aparta de cada cobro. Lo que ya se apartó conserva su porcentaje.",
      plazo: "Plazo de pago (días)",
      plazoAyuda: "Emisión + este plazo = vencimiento. Cero es pago contra entrega.",
    },

    moneda: {
      titulo: "Moneda",
      ayuda: "En la que se emite toda factura nueva y en la que se suman los KPI de Finanzas.",
      campo: "Moneda",
      campoAyuda: "Código ISO-4217 de tres letras: COP, MXN, USD.",
      /** El aviso de la decisión conservadora: se permite, pero se dice qué pasa. */
      aviso: (n: number, moneda: string) =>
        n === 1
          ? `Tienes 1 factura viva en ${moneda}. Cambiar la moneda no la convierte: se queda como está y los KPI la suman sin convertirla.`
          : `Tienes ${n} facturas vivas en ${moneda}. Cambiar la moneda no las convierte: se quedan como están y los KPI las suman sin convertirlas.`,
    },

    fiscales: {
      titulo: "Datos para la factura",
      ayuda: "Es la cabecera que imprime cada factura y lo que va en el correo de cobro.",
      razonSocial: "Razón social",
      razonSocialAyuda: "El nombre con el que facturas, tal como está registrado.",
      identificacion: "NIT o identificación",
      direccion: "Dirección",
      regimen: "Régimen",
      regimenAyuda: "Como lo escribes tú: «Responsable de IVA», «No responsable», «Régimen simple».",
      correo: "Correo de facturación",
      correoAyuda: "A dónde te escriben las marcas por temas de factura.",
      sinConfigurar: "Todavía no has escrito tus datos fiscales: la factura sale sin cabecera.",
    },

    pago: {
      titulo: "Cómo te pagan",
      ayuda: "Lo que la factura le dice a la marca para transferir. Con el banco y la cuenta, o con un enlace de pago.",
      banco: "Banco",
      cuenta: "Cuenta",
      cuentaAyuda: "Tipo y número, como se lo dictas a alguien: «Ahorros 123-456789-01».",
      enlace: "Enlace de pago",
      enlaceAyuda: "Opcional, si cobras por pasarela. Tiene que empezar por https://.",
    },

    guardar: "Guardar configuración",
    guardando: "Guardando…",
    guardado: "Configuración guardada.",
    guardadoConMoneda: (moneda: string) => `Configuración guardada. Toda factura nueva se emite en ${moneda}.`,

    errores: {
      pct: "Es un porcentaje entre 0 y 100, con hasta dos decimales.",
      plazo: "Es un número entero de días, entre 0 y 180.",
      moneda: "Escribe un código de tres letras: COP, MXN, USD.",
      texto: (max: number) => `No puede pasar de ${max} caracteres.`,
      correo: "Escribe un correo válido, o déjalo vacío.",
      enlace: "Tiene que ser una dirección https://.",
      general: "No pudimos guardar la configuración. Vuelve a intentarlo.",
    },
  },
} as const;
