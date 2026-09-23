/**
 * Textos del segmento (app): lo que se ve cuando una pantalla falla o
 * está cargando y el módulo no tiene los suyos.
 *
 * Son la red de abajo. Finanzas tiene su error.tsx y su loading.tsx con
 * el vocabulario de las facturas, y cualquier módulo puede poner los
 * suyos; lo que no puede pasar es que un módulo SIN ellos caiga en el
 * documento genérico de Next, que además está en inglés. Con un
 * DEMO_WORKSPACE_ID que no corresponde a ninguna fila —el caso más
 * probable en un despliegue nuevo— la portada respondía justo eso.
 */
export const MESSAGES = {
  error: {
    eyebrow: "On Cue",
    title: "Esta pantalla no se pudo cargar",
    description:
      "No pudimos leer los datos de tu workspace. Puede ser la base de datos, o una configuración que todavía no apunta a ningún workspace. Tus datos no cambiaron.",
    retry: "Reintentar",
    home: "Volver al plan",
    /** Solo se muestra cuando Next entrega un identificador del error (producción). */
    reference: "Referencia",
    /**
     * Lo que ve quien entra. A una creadora los nombres de dos
     * variables de entorno del servidor no le dicen nada y no le sirven
     * de nada: la pista de despliegue es la de abajo, y solo sale fuera
     * de producción.
     */
    hint: "Vuelve a intentarlo en un momento; si sigue así, escríbenos.",
    /**
     * La misma pantalla, en desarrollo y en las vistas previas de Vercel:
     * ahí quien mira es quien despliega. En producción no se renderiza
     * (ver mostrarPistaDeDespliegue en reintentar.ts, que es quien
     * decide); las variables siguen en el log del servidor.
     */
    hintDespliegue: "Si acabas de desplegar, revisa DEMO_WORKSPACE_ID y DATABASE_URL.",
  },
  loading: {
    label: "Cargando la pantalla",
  },
} as const;
