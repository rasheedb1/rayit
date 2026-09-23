/**
 * Textos de interfaz del módulo Finanzas que no viven en una pantalla
 * concreta: el estado de error y el de carga del segmento. Un solo
 * sitio por módulo para que traducirlos o corregirlos no sea buscar por
 * el árbol.
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
  /** Gastos (FIN-5). Sus propios estados de carga y de error: «no pudimos leer tus facturas» aquí sería falso. */
  gastos: {
    header: {
      eyebrow: "Finanzas · Gastos",
      title: "Qué te cuesta cada mes, y qué se va a repetir",
      description:
        "Cada gasto queda con su categoría, su proveedor y su recibo. Los totales del mes salen de la base; la proyección de lo recurrente, de la misma función pura que usará el flujo de caja.",
      volver: "Ver las facturas",
      nuevo: "Nuevo gasto",
      desdeFinanzas: "Gastos",
    },
    mes: {
      anterior: "Mes anterior",
      siguiente: "Mes siguiente",
      esteMes: "Este mes",
      /** Se dice cuando el mes que se mira no es el de hoy. */
      volverAlActual: "Volver a este mes",
    },
    kpis: {
      total: "Gastado en el mes",
      recurrente: "De eso, recurrente",
      deducible: "Deducible",
      /** En vez de los tres KPIs en cero cuando el mes no tiene nada que sumar. */
      sinGastos: "Este mes no tiene ningún gasto registrado todavía, así que no hay nada que sumar.",
      /** Hay filas, pero ninguna en la moneda del espacio: los totales estarían en cero sobre una tabla llena. */
      soloOtraMoneda: "Los gastos de este mes están en otra moneda, así que no hay totales que sumar en la del espacio.",
      recurrenteNota: (n: number) => `${n} ${n === 1 ? "gasto que se repite" : "gastos que se repiten"}`,
      sinRecurrentes: "Ninguno de los gastos del mes se repite",
      deducibleNota: "Lo que la contadora puede descontar",
      sinDeducibles: "Ningún gasto del mes es deducible",
    },
    tabla: {
      caption: "Gastos del mes, con su categoría, su monto y si se repite",
      columnas: {
        concepto: "Gasto",
        categoria: "Categoría",
        fecha: "Fecha",
        monto: "Monto",
        marcas: "Señas",
        accion: "Acción",
      },
      recurrente: "Se repite",
      puntual: "Una vez",
      deducible: "Deducible",
      noDeducible: "No deducible",
      recibo: "Ver el recibo",
      sinRecibo: "Sin recibo adjunto",
      sinProveedor: "Sin proveedor",
      sinDescripcion: "Sin descripción",
      editar: "Editar",
      /** Ausencia con frase, nunca un guion mudo. */
      otraMoneda: (n: number) =>
        n === 1
          ? "Un gasto del mes está en otra moneda y no entra en los totales."
          : `${n} gastos del mes están en otra moneda y no entran en los totales.`,
    },
    vacio: {
      titulo: "Todavía no hay gastos en este mes",
      descripcion:
        "El primero puede ser la suscripción que pagas cada mes o el trípode que compraste ayer. Si se repite, la proyección lo tendrá en cuenta.",
      accion: "Registrar el primero",
      otroMes: "Puede que el gasto esté en otro mes: prueba con el anterior.",
    },
    categorias: {
      titulo: "Por categoría",
      /** Se dice en vez de pintar una tabla vacía. */
      vacio: "El desglose por categoría aparece cuando haya el primer gasto del mes.",
    },
    proyeccion: {
      titulo: "Proyección de gastos recurrentes",
      subtitulo: "Próximas ocho semanas",
      ariaLabel: "Gastos recurrentes proyectados por semana, próximas ocho semanas",
      serie: "Gastos recurrentes",
      semana: "Semana",
      nota: (desde: string, hasta: string, total: string) =>
        `Del ${desde} al ${hasta} se repiten ${total}. Sale de las filas marcadas como recurrentes: no se guarda ninguna fila futura.`,
      vacioTitulo: "Ningún gasto se repite todavía",
      vacioDescripcion:
        "Marca un gasto como recurrente al registrarlo y aparecerá aquí, proyectado en las ocho semanas siguientes.",
      otraMoneda: (n: number) =>
        n === 1
          ? "Un gasto recurrente está en otra moneda y no entra en la proyección."
          : `${n} gastos recurrentes están en otra moneda y no entran en la proyección.`,
    },
    form: {
      tituloNuevo: "Nuevo gasto",
      tituloEditar: "Corregir el gasto",
      ayudaEditar: "Se guarda el cambio y queda anotado en la bitácora. Los gastos no se borran: si fue un error, dilo en la descripción.",
      categoria: "Categoría",
      categoriaPlaceholder: "Elige la categoría",
      proveedor: "Proveedor",
      proveedorHelp: "Quién cobró. Opcional.",
      descripcion: "Descripción",
      descripcionHelp: "Para qué fue. Opcional, pero es lo que se lee en la lista.",
      monto: "Monto",
      moneda: "Moneda",
      monedaHelp: "La del espacio. Se cambia en sus ajustes.",
      fecha: "Fecha del gasto",
      recurrente: "Se repite cada mes",
      recurrenteHelp: "La fila no se duplica: la proyección la repite el mismo día de cada mes.",
      recurrencia: "Cada cuánto",
      deducible: "Es deducible",
      recibo: "Enlace del recibo",
      reciboHelp: "Un enlace a la factura o al correo (Drive, Dropbox). Subir el archivo llegará en otra historia.",
      guardar: "Guardar el gasto",
      guardarCambio: "Guardar el cambio",
      cancelar: "Cancelar",
      guardado: "Gasto guardado.",
      editado: "Gasto corregido.",
    },
    error: {
      eyebrow: "Finanzas · Gastos",
      title: "No pudimos leer tus gastos",
    },
    cargando: {
      label: "Cargando gastos",
      kpis: ["Gastado en el mes", "De eso, recurrente", "Deducible"],
      section: "Gastos del mes",
    },
  },
} as const;
