/**
 * Permisos y roles de fábrica (ACC-1): la lista cerrada de permisos de
 * la plataforma, los cinco roles del workspace de creador y los cinco
 * del de agencia con su matriz, y las reglas puras que la web, el worker
 * y la pantalla de Equipo comparten. Sin base, sin React.
 *
 * Regla de la casa (backlog §7, decisión 7): el código pregunta por
 * permisos —`can(permisos, 'finanzas.factura.crear')`—, nunca por roles.
 * Un rol es un nombre para un conjunto de permisos y nada más.
 *
 * Esta constante es la fuente de verdad. La tabla `permission` y la
 * semilla de `role` y `role_permission` de ACC-3 se generan desde aquí
 * con `scripts/permisos-sql.ts`: agregar un permiso es editar este
 * archivo, no pasar un string (propuesta ACC, fase 8, riesgo 1).
 */

// ---------------------------------------------------------------------
// Vocabulario cerrado
// ---------------------------------------------------------------------

/** Los siete módulos del producto que tienen permisos. En español porque los identificadores del producto ya lo son. */
export const MODULOS = ['resumen', 'ventas', 'cotizar', 'campanas', 'finanzas', 'conexiones', 'equipo'] as const;
export type Modulo = (typeof MODULOS)[number];

/**
 * Las acciones que puede llevar un permiso. Cerrado a propósito: una
 * acción nueva se agrega aquí, con su significado, antes de usarla.
 *
 * - ver: leer la pantalla o la lista.
 * - crear / editar: dar de alta o cambiar algo propio del producto.
 * - registrar: anotar un hecho que pasó fuera (un pago, un gasto, una señal, lo que aportó la marca).
 * - asociar: ligar dos cosas que ya existen (un post a una campaña).
 * - calcular: pedir un cálculo a demanda. Sin uso todavía.
 * - generar: producir un documento (un media kit).
 * - enviar: mandar algo fuera del producto (una cotización, el reporte a la marca).
 * - conectar / desconectar: una cuenta de una plataforma.
 * - importar: cargar un archivo (métricas por CSV, una lista de marcas).
 * - invitar / revocar: a una persona del equipo.
 * - configurar: los parámetros de un módulo o del espacio.
 */
export const ACCIONES = [
  'ver', 'crear', 'editar', 'registrar', 'asociar', 'calcular', 'generar', 'enviar',
  'conectar', 'desconectar', 'importar', 'invitar', 'revocar', 'configurar',
] as const;
export type Accion = (typeof ACCIONES)[number];

/** `normal`, o `sensible` cuando toca dinero, cuentas conectadas o el equipo (decisión E de la propuesta ACC). */
export type Sensibilidad = 'normal' | 'sensible';

/** Una entrada del catálogo. La clave es `<módulo>.<recurso>.<acción>` y el compilador la comprueba. */
export interface PermisoDef {
  readonly key: `${Modulo}.${string}.${Accion}`;
  readonly module: Modulo;
  /** En infinitivo, para que «No tienes permiso para …» se lea bien. */
  readonly labelEs: string;
  readonly sensitivity: Sensibilidad;
}

// ---------------------------------------------------------------------
// El catálogo
// ---------------------------------------------------------------------

/**
 * Un permiso existe si hoy hay una Server Action que lo necesita (en
 * cualquier módulo de los dos dueños) o si la matriz de fábrica no se
 * puede escribir sin él. Lo demás lo agrega la historia que lo
 * necesite. El orden es el de la navegación y es el orden de la semilla.
 */
export const PERMISOS = [
  // Resumen (Rasheed): RES-1, RES-2, RES-5, RES-6.
  { key: 'resumen.panel.ver', module: 'resumen', labelEs: 'Ver el resumen', sensitivity: 'normal' },
  { key: 'resumen.metricas.importar', module: 'resumen', labelEs: 'Importar métricas por CSV', sensitivity: 'normal' },

  // Ventas (Rasheed): VEN-1, VEN-2, VEN-3.
  { key: 'ventas.senal.ver', module: 'ventas', labelEs: 'Ver el radar de señales', sensitivity: 'normal' },
  { key: 'ventas.senal.registrar', module: 'ventas', labelEs: 'Anotar, aceptar y descartar señales', sensitivity: 'normal' },
  { key: 'ventas.senal.importar', module: 'ventas', labelEs: 'Cargar una lista de marcas por CSV', sensitivity: 'normal' },
  { key: 'ventas.empresa.ver', module: 'ventas', labelEs: 'Ver empresas y contactos', sensitivity: 'normal' },
  { key: 'ventas.empresa.crear', module: 'ventas', labelEs: 'Crear empresas', sensitivity: 'normal' },
  { key: 'ventas.empresa.editar', module: 'ventas', labelEs: 'Editar empresas y sus contactos', sensitivity: 'normal' },
  { key: 'ventas.negocio.ver', module: 'ventas', labelEs: 'Ver el pipeline de negocios', sensitivity: 'normal' },
  { key: 'ventas.negocio.crear', module: 'ventas', labelEs: 'Crear negocios', sensitivity: 'normal' },
  { key: 'ventas.negocio.editar', module: 'ventas', labelEs: 'Mover negocios de etapa', sensitivity: 'normal' },

  // Cotizar (Rasheed): COT-1, COT-2, COT-3, COT-4.
  { key: 'cotizar.tarifario.ver', module: 'cotizar', labelEs: 'Ver el tarifario', sensitivity: 'normal' },
  { key: 'cotizar.tarifario.editar', module: 'cotizar', labelEs: 'Guardar el tarifario', sensitivity: 'normal' },
  { key: 'cotizar.mediakit.ver', module: 'cotizar', labelEs: 'Ver los media kits', sensitivity: 'normal' },
  { key: 'cotizar.mediakit.generar', module: 'cotizar', labelEs: 'Generar un media kit', sensitivity: 'normal' },
  { key: 'cotizar.mediakit.editar', module: 'cotizar', labelEs: 'Publicar, despublicar y desbloquear media kits', sensitivity: 'normal' },
  { key: 'cotizar.cotizacion.ver', module: 'cotizar', labelEs: 'Ver las cotizaciones', sensitivity: 'normal' },
  { key: 'cotizar.cotizacion.crear', module: 'cotizar', labelEs: 'Crear cotizaciones', sensitivity: 'normal' },
  { key: 'cotizar.cotizacion.editar', module: 'cotizar', labelEs: 'Editar y borrar borradores de cotización', sensitivity: 'normal' },
  { key: 'cotizar.cotizacion.enviar', module: 'cotizar', labelEs: 'Enviar cotizaciones y registrar la respuesta de la marca', sensitivity: 'normal' },

  // Campañas (Nicolás): CAM-1, CAM-2; CAM-4 y CAM-6 por la matriz.
  { key: 'campanas.campana.ver', module: 'campanas', labelEs: 'Ver las campañas', sensitivity: 'normal' },
  { key: 'campanas.campana.crear', module: 'campanas', labelEs: 'Crear campañas', sensitivity: 'normal' },
  { key: 'campanas.campana.editar', module: 'campanas', labelEs: 'Editar campañas y cambiar su estado', sensitivity: 'normal' },
  { key: 'campanas.post.asociar', module: 'campanas', labelEs: 'Asociar posts y marcar entregables', sensitivity: 'normal' },
  { key: 'campanas.aporte.registrar', module: 'campanas', labelEs: 'Registrar lo que aporta la marca', sensitivity: 'normal' },
  { key: 'campanas.reporte.enviar', module: 'campanas', labelEs: 'Enviar el reporte a la marca', sensitivity: 'normal' },

  // Finanzas (Nicolás): FIN-1; FIN-2, FIN-3, FIN-5, FIN-6 y FIN-8 por la matriz. Todo es dinero: sensible.
  { key: 'finanzas.factura.ver', module: 'finanzas', labelEs: 'Ver las facturas', sensitivity: 'sensible' },
  { key: 'finanzas.factura.crear', module: 'finanzas', labelEs: 'Crear facturas', sensitivity: 'sensible' },
  { key: 'finanzas.factura.editar', module: 'finanzas', labelEs: 'Marcar facturas como enviadas o anularlas', sensitivity: 'sensible' },
  { key: 'finanzas.pago.registrar', module: 'finanzas', labelEs: 'Registrar pagos', sensitivity: 'sensible' },
  { key: 'finanzas.cobro.ver', module: 'finanzas', labelEs: 'Ver el estado de cobro de las campañas', sensitivity: 'sensible' },
  { key: 'finanzas.gasto.ver', module: 'finanzas', labelEs: 'Ver los gastos', sensitivity: 'sensible' },
  { key: 'finanzas.gasto.registrar', module: 'finanzas', labelEs: 'Registrar gastos', sensitivity: 'sensible' },
  { key: 'finanzas.flujo.ver', module: 'finanzas', labelEs: 'Ver el flujo de caja y la reserva de impuestos', sensitivity: 'sensible' },
  { key: 'finanzas.ajustes.configurar', module: 'finanzas', labelEs: 'Configurar los parámetros financieros', sensitivity: 'sensible' },

  // Conexiones (Nicolás): CON-10. El token no se lee nunca: no existe un permiso para verlo (decisión E).
  { key: 'conexiones.cuenta.ver', module: 'conexiones', labelEs: 'Ver el estado de las cuentas conectadas', sensitivity: 'normal' },
  { key: 'conexiones.cuenta.conectar', module: 'conexiones', labelEs: 'Conectar cuentas y pedir una lectura nueva', sensitivity: 'sensible' },
  { key: 'conexiones.cuenta.desconectar', module: 'conexiones', labelEs: 'Quitar cuentas conectadas', sensitivity: 'sensible' },

  // Equipo (ACC-4, Rasheed). Todo es sensible.
  { key: 'equipo.miembro.ver', module: 'equipo', labelEs: 'Ver quién está en el espacio', sensitivity: 'sensible' },
  { key: 'equipo.miembro.invitar', module: 'equipo', labelEs: 'Invitar personas al espacio', sensitivity: 'sensible' },
  { key: 'equipo.miembro.revocar', module: 'equipo', labelEs: 'Quitar personas del espacio', sensitivity: 'sensible' },
  { key: 'equipo.rol.editar', module: 'equipo', labelEs: 'Cambiar el rol de una persona', sensitivity: 'sensible' },
  { key: 'equipo.workspace.configurar', module: 'equipo', labelEs: 'Configurar el espacio y cerrar la cuenta', sensitivity: 'sensible' },
] as const satisfies readonly PermisoDef[];

/** Uno de los permisos del catálogo, como literal. */
export type Permiso = (typeof PERMISOS)[number]['key'];

/** Todas las claves, en el orden del catálogo. */
export const TODOS_LOS_PERMISOS: readonly Permiso[] = PERMISOS.map((p) => p.key);

const POR_CLAVE: ReadonlyMap<string, PermisoDef> = new Map(PERMISOS.map((p) => [p.key, p]));

export function isPermiso(value: string): value is Permiso {
  return POR_CLAVE.has(value);
}

/** La entrada del catálogo. Lanza si la clave no existe: un permiso que no está en el catálogo es un bug, no un dato. */
export function permisoDef(permiso: Permiso): PermisoDef {
  const def = POR_CLAVE.get(permiso);
  if (!def) throw new PermisoDesconocidoError(permiso);
  return def;
}

/** El módulo de un permiso, leído de la clave. */
export function moduloDe(permiso: Permiso): Modulo {
  return permisoDef(permiso).module;
}

/** Los permisos de un módulo, en el orden del catálogo. */
export function permisosDelModulo(modulo: Modulo): readonly Permiso[] {
  return PERMISOS.filter((p) => p.module === modulo).map((p) => p.key);
}

/**
 * El permiso que abre cada módulo: lo que ACC-5 le pasará a
 * requireModule() junto a la bandera. Sin él, la ruta responde 404
 * (no 403: un 403 confirma que el módulo existe) y el menú no lo pinta.
 */
export const PERMISO_MINIMO: Readonly<Record<Modulo, Permiso>> = {
  resumen: 'resumen.panel.ver',
  ventas: 'ventas.negocio.ver',
  cotizar: 'cotizar.cotizacion.ver',
  campanas: 'campanas.campana.ver',
  finanzas: 'finanzas.factura.ver',
  conexiones: 'conexiones.cuenta.ver',
  equipo: 'equipo.miembro.ver',
};

// ---------------------------------------------------------------------
// Roles de fábrica (fase 5 de la propuesta ACC)
// ---------------------------------------------------------------------

/** Los de workspace.kind (0001). */
export const WORKSPACE_KINDS = ['creator', 'agency'] as const;
export type WorkspaceKind = (typeof WORKSPACE_KINDS)[number];

/** Las claves de los roles de sistema. Coinciden con role.key de ACC-3. */
export type RoleKey = 'owner' | 'admin' | 'manager' | 'editor' | 'finance' | 'viewer';

export interface RolSistema {
  readonly key: RoleKey;
  readonly workspaceKind: WorkspaceKind;
  readonly labelEs: string;
  readonly descriptionEs: string;
  readonly permisos: readonly Permiso[];
}

/** Los `.ver` de un módulo: lo que tiene quien «solo mira». */
const ver = (modulo: Modulo): readonly Permiso[] => permisosDelModulo(modulo).filter((p) => p.endsWith('.ver'));

/**
 * La matriz, literal. Las dos reglas que NO están aquí van en código:
 * nadie otorga lo que no tiene (permisosOtorgables, puedeAsignarRol) y
 * el último dueño no se quita ni se degrada (esUltimoDueno).
 *
 * Decisión E (backlog §7, decisión 9): el dinero no entra en ningún rol
 * por defecto. El Mánager sale sin flujo de caja, gastos, impuestos ni
 * configuración; lleva solo el estado de cobro de las campañas.
 * Activarlo es una casilla consciente al invitar (ACC-4).
 */
export const ROLES_SISTEMA: readonly RolSistema[] = [
  // ---- Workspace de creador ----
  {
    key: 'owner',
    workspaceKind: 'creator',
    labelEs: 'Dueño',
    descriptionEs: 'El creador. Todo, incluido el equipo y la cuenta.',
    permisos: TODOS_LOS_PERMISOS,
  },
  {
    key: 'manager',
    workspaceKind: 'creator',
    labelEs: 'Mánager',
    descriptionEs:
      'Su agente, quien habla con las marcas. Ventas, Cotizar y Campañas completas, el estado de cobro de las campañas, y ve el resto. No conecta cuentas ni ve el flujo de caja.',
    permisos: [
      'resumen.panel.ver',
      ...permisosDelModulo('ventas'),
      ...permisosDelModulo('cotizar'),
      ...permisosDelModulo('campanas'),
      'finanzas.cobro.ver',
      'conexiones.cuenta.ver',
      'equipo.miembro.ver',
    ],
  },
  {
    key: 'editor',
    workspaceKind: 'creator',
    labelEs: 'Editor',
    descriptionEs: 'Community manager o editor de video. Ve las campañas y marca sus entregables.',
    permisos: ['resumen.panel.ver', 'campanas.campana.ver', 'campanas.post.asociar', 'conexiones.cuenta.ver'],
  },
  {
    key: 'finance',
    workspaceKind: 'creator',
    labelEs: 'Contador',
    // Sin campanas.campana.ver aunque la fase 5 diga «ver nombre y monto»:
    // ACC-5 exige que con sesión de Contador /campanas responda 404, y el
    // nombre y el monto de la campaña ya van en la factura (invoice.campaign_id).
    descriptionEs: 'Contador externo. Todo Finanzas; las campañas las ve por sus facturas.',
    permisos: [...permisosDelModulo('finanzas')],
  },
  {
    key: 'viewer',
    workspaceKind: 'creator',
    labelEs: 'Solo lectura',
    descriptionEs: 'Quien mira y no toca. Sin Finanzas ni Equipo.',
    permisos: [...ver('resumen'), ...ver('ventas'), ...ver('cotizar'), ...ver('campanas'), ...ver('conexiones')],
  },

  // ---- Workspace de agencia ----
  {
    key: 'owner',
    workspaceKind: 'agency',
    labelEs: 'Dueño',
    descriptionEs: 'Toda la agencia, incluidas la facturación de la cuenta y su cierre.',
    permisos: TODOS_LOS_PERMISOS,
  },
  {
    key: 'admin',
    workspaceKind: 'agency',
    labelEs: 'Administrador',
    descriptionEs: 'Personas, roles y marcas de toda la agencia. No configura ni cierra la cuenta.',
    permisos: TODOS_LOS_PERMISOS.filter((p) => p !== 'equipo.workspace.configurar'),
  },
  {
    key: 'manager',
    workspaceKind: 'agency',
    labelEs: 'Ejecutivo de cuenta',
    descriptionEs: 'Ventas, Cotizar y Campañas de las marcas o creadores que tiene asignados.',
    permisos: [...permisosDelModulo('ventas'), ...permisosDelModulo('cotizar'), ...permisosDelModulo('campanas')],
  },
  {
    key: 'finance',
    workspaceKind: 'agency',
    labelEs: 'Contador',
    descriptionEs: 'Finanzas de la agencia.',
    permisos: [...permisosDelModulo('finanzas')],
  },
  {
    key: 'viewer',
    workspaceKind: 'agency',
    labelEs: 'Solo lectura',
    descriptionEs: 'Ver lo que se le asigne. Sin Finanzas ni Equipo.',
    permisos: [...ver('resumen'), ...ver('ventas'), ...ver('cotizar'), ...ver('campanas'), ...ver('conexiones')],
  },
];

/** El rol de sistema, o `undefined` si esa clave no existe para ese tipo de workspace. */
export function rolSistema(kind: WorkspaceKind, key: RoleKey): RolSistema | undefined {
  return ROLES_SISTEMA.find((r) => r.workspaceKind === kind && r.key === key);
}

const CONJUNTOS = new Map<string, ReadonlySet<Permiso>>();

/** Los permisos de un rol de fábrica, como conjunto de solo lectura. Lanza RolDesconocidoError si no existe. */
export function permisosDeRol(kind: WorkspaceKind, key: RoleKey): ReadonlySet<Permiso> {
  const id = `${kind}:${key}`;
  const cached = CONJUNTOS.get(id);
  if (cached) return cached;
  const rol = rolSistema(kind, key);
  if (!rol) throw new RolDesconocidoError(kind, key);
  // Un solo conjunto por rol, compartido: el tipo ReadonlySet es lo que impide mutarlo.
  const set: ReadonlySet<Permiso> = new Set(rol.permisos);
  CONJUNTOS.set(id, set);
  return set;
}

// ---------------------------------------------------------------------
// Evaluación
// ---------------------------------------------------------------------

/** ¿Este conjunto de permisos incluye el permiso? Es la única pregunta que hace el código. */
export function can(permisos: ReadonlySet<Permiso>, permiso: Permiso): boolean {
  return permisos.has(permiso);
}

/**
 * Nadie otorga lo que no tiene: de lo que se pide, lo que quien invita
 * o edita puede dar de verdad. Es la intersección con los propios. Sin
 * esto un administrador se hace dueño en dos clics.
 */
export function permisosOtorgables(propios: ReadonlySet<Permiso>, pedidos: Iterable<Permiso>): ReadonlySet<Permiso> {
  const out = new Set<Permiso>();
  for (const p of pedidos) if (propios.has(p)) out.add(p);
  return out;
}

/** ¿Puede quien tiene `propios` asignar este rol entero? Solo si tiene todos sus permisos. */
export function puedeAsignarRol(propios: ReadonlySet<Permiso>, kind: WorkspaceKind, key: RoleKey): boolean {
  for (const p of permisosDeRol(kind, key)) if (!propios.has(p)) return false;
  return true;
}

/**
 * El último dueño no se puede quitar ni degradar: un workspace sin
 * `owner` es un workspace que nadie puede recuperar. `duenos` son los
 * user_id que hoy tienen el rol owner en el espacio.
 */
export function esUltimoDueno(duenos: readonly string[], userId: string): boolean {
  // Por ids distintos: una consulta que devuelva al mismo dueño dos veces
  // (un JOIN con alcance, por ejemplo) no puede hacer que parezca que hay dos.
  const distintos = new Set(duenos);
  return distintos.size === 1 && distintos.has(userId);
}

/** Lanza UltimoDuenoError si quitar o degradar a `userId` dejaría el espacio sin dueño. */
export function assertNoEsUltimoDueno(duenos: readonly string[], userId: string): void {
  if (esUltimoDueno(duenos, userId)) throw new UltimoDuenoError();
}

// ---------------------------------------------------------------------
// Errores (el patrón de CampaignError: código + mensaje en español)
// ---------------------------------------------------------------------

/** Base de los errores de permisos: el mensaje ya está en español. */
export class PermisoError extends Error {
  readonly code: string;
  constructor(code: string, messageEs: string) {
    super(messageEs);
    this.name = code;
    this.code = code;
  }
  /** El mismo texto que `message`, con nombre explícito para las pantallas. */
  get messageEs(): string {
    return this.message;
  }
}

/** La sesión no tiene el permiso. Lo lanza requirePermission(); las fronteras lo convierten (404 en páginas). */
export class SinPermisoError extends PermisoError {
  readonly permiso: Permiso;
  constructor(permiso: Permiso) {
    const label = permisoDef(permiso).labelEs;
    super('SinPermisoError', `No tienes permiso para ${label.charAt(0).toLowerCase()}${label.slice(1)}.`);
    this.permiso = permiso;
  }
}

/** Una clave que no está en el catálogo. Es un bug de programación, no un dato de la persona. */
export class PermisoDesconocidoError extends PermisoError {
  constructor(key: string) {
    super('PermisoDesconocidoError', `El permiso «${key}» no está en el catálogo.`);
  }
}

export class RolDesconocidoError extends PermisoError {
  constructor(kind: WorkspaceKind, key: string) {
    super('RolDesconocidoError', `No existe el rol «${key}» para un espacio de tipo «${kind}».`);
  }
}

export class UltimoDuenoError extends PermisoError {
  constructor() {
    super('UltimoDuenoError', 'No se puede quitar ni degradar al último dueño del espacio.');
  }
}
