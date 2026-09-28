/**
 * Las reglas de la cuenta y de los espacios que comparten la interfaz y
 * el servidor. Van aquí, en un módulo sin "use server" y sin
 * dependencias, porque lib/auth/acciones.ts no puede exportar nada que
 * no sea una función async (Next lo exige en tiempo de ejecución) y la
 * página y el formulario las necesitan igual: antes el 80 estaba
 * escrito a mano en tres sitios y PUEDEN_RENOMBRAR dos veces.
 *
 * El servidor las vuelve a aplicar siempre; que la interfaz las conozca
 * es solo para no ofrecer lo que luego se va a rechazar.
 */
import type { MembershipRole } from "@mc/db/queries/identidad";

/**
 * Quien trabaja Ventas, Cotizar y el Resumen, con los roles de
 * 0034_access_control (ACC-3): 'owner', 'admin' (agencia), 'manager' y
 * 'editor'. Son los que el relleno de 0034 dio a los antiguos 'owner',
 * 'admin' y 'member', así que nadie gana ni pierde nada al mezclar; y es
 * el mismo grupo que la base acepta como operador (0072,
 * outbound_touch_guard_operator). 'finance' y 'viewer' leen.
 */
export const OPERAN: readonly MembershipRole[] = ["owner", "admin", "manager", "editor"];

/** Tope de un nombre de persona o de espacio, en caracteres. */
export const MAX_NOMBRE = 80;

/** Los roles que pueden cambiarle el nombre a un espacio. */
export const PUEDEN_RENOMBRAR: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["owner", "admin"]);

/**
 * Los roles que pueden conectar, reconectar o desconectar un canal de
 * outreach y cambiar sus topes (VEN-9). Es lo más sensible de Ventas: el
 * buzón o el LinkedIn que se conecta escribe a las marcas en nombre de la
 * creadora. Un 'member', un 'viewer' o un 'client' ven la pantalla, no la
 * tocan.
 */
export const PUEDEN_GESTIONAR_CANALES: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["owner", "admin"]);

/**
 * Los roles que pueden recalcular el perfil comercial y editar su
 * narrativa (VEN-11). Recalcular gasta en el modelo contra el tope
 * diario del espacio y la narrativa es la voz de la creadora ante las
 * marcas: un 'viewer' o un 'client' (en una agencia, la marca misma) la
 * leen, no la reescriben.
 */
export const PUEDEN_EDITAR_PERFIL: ReadonlySet<MembershipRole> = new Set<MembershipRole>(OPERAN);

/**
 * Los roles que operan Ventas en nombre de la creadora (VEN-14): aprobar,
 * editar, regenerar o saltar un mensaje retenido, responder a una marca
 * desde la bandeja, cancelar esa respuesta, corregir la intención de una
 * respuesta (una baja no se deshace), crear un contacto referido y marcar
 * un hilo como hecho o leído. Cada una escribe a una marca, gasta contra
 * el tope diario de IA o cambia lo que ve el resto del equipo. Un
 * 'viewer' lee las bandejas y no las toca; un 'client' ni las lee (ver
 * PUEDEN_VER_BANDEJAS). Mismo grupo que PUEDEN_EDITAR_PERFIL.
 */
export const PUEDEN_OPERAR_VENTAS: ReadonlySet<MembershipRole> = new Set<MembershipRole>(OPERAN);

/**
 * Los roles que operan Cotizar (COT-1..4): guardar el tarifario, generar,
 * publicar o desbloquear un media kit, crear, editar, enviar, aceptar,
 * rechazar o borrar una cotización, y crear su campaña. Cada una fija un
 * precio, un documento que ve una marca o un ingreso del espacio. Un
 * 'viewer' lo lee; un 'client' (en una agencia, la marca misma) nunca
 * reescribe tarifas ni acepta cotizaciones. Mismo grupo que
 * PUEDEN_OPERAR_VENTAS.
 */
export const PUEDEN_OPERAR_COTIZAR: ReadonlySet<MembershipRole> = new Set<MembershipRole>(OPERAN);

/**
 * Los roles que pueden importar métricas desde un CSV (RES-6): escribe
 * posts y métricas del espacio, que luego ven Resumen y Campañas. Un
 * 'viewer' o un 'client' las leen, no las cargan.
 */
export const PUEDEN_IMPORTAR_METRICAS: ReadonlySet<MembershipRole> = new Set<MembershipRole>(OPERAN);

/**
 * Los roles que pueden LEER las bandejas de Ventas (VEN-14): las
 * conversaciones con las marcas (/ventas/bandeja) y los mensajes
 * retenidos (/ventas/aprobaciones). Todos los roles de 0034_access_control:
 * desde ACC-3 la marca no tiene cuenta, tiene un enlace (backlog §7,
 * decisión 8), y el antiguo 'client' pasó a 'viewer', que en la matriz ve
 * el pipeline (ventas.negocio.ver). Quien no esté aquí ve un aviso de que
 * no tiene acceso, y las páginas ni siquiera cargan los hilos ni la cola.
 */
export const PUEDEN_VER_BANDEJAS: ReadonlySet<MembershipRole> = new Set<MembershipRole>([...OPERAN, "finance", "viewer"]);

/**
 * Los roles que pueden cambiar el brief de outbound (VEN-7). Es el brief
 * de un creador (uno activo por creador, 0073 §1), pero lo que excluye se
 * oculta del radar de todo el equipo cuando lo excluyen todos los briefs
 * activos, y frena las cadencias de sus negocios. Por eso lo cambian los
 * mismos que la política de envío y los canales; un 'member' lo lee y lo
 * aplica, no lo reescribe. Lo mismo vale para «No aceptar esta marca»
 * desde el radar, que escribe en el brief. La base dice lo mismo
 * con outreach_can_manage (0073 §5), así que esto solo evita ofrecer lo
 * que se va a rechazar.
 */
export const PUEDEN_EDITAR_BRIEF: ReadonlySet<MembershipRole> = new Set<MembershipRole>(["owner", "admin"]);

/**
 * Cuántos espacios puede tener una persona como propietaria. Sin tope,
 * un script con sesión crea miles de workspaces con su creator_profile.
 * Veinte cubre de sobra a una creadora que separa marcas; una agencia
 * con más clientes no crea espacios de creadora, crea el suyo (AGE-1).
 */
export const MAX_ESPACIOS_PROPIOS = 20;
