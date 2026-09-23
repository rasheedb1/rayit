/**
 * PROVISIONAL (ACC-5): qué puede abrir cada rol, hasta que ACC-1 y ACC-3
 * estén en main. Este archivo se BORRA entonces, entero.
 *
 * Es la matriz de la fase 5 de docs/propuestas/ACC-accesos-y-roles.md
 * reducida a lo único que ACC-5 decide: qué módulo se abre. «Todo» en
 * la matriz se escribe como el comodín `<módulo>.*`, para que cualquier
 * permiso de ese módulo que ACC-1 nombre —`finanzas.factura.crear`,
 * `campanas.reporte.enviar`— pase mientras esta matriz siga viva; lo
 * que no es «Todo» se escribe con el `.ver` mínimo del módulo. Con
 * ACC-1, `permisosDeRol(kind, key)` de @mc/core devuelve el conjunto
 * exacto y el comodín desaparece con este archivo.
 *
 * Los roles de fábrica (owner, admin, manager, editor, finance, viewer)
 * no existen en la base hasta ACC-3: `membership.role` (0001) solo sabe
 * owner, admin, member, viewer y client. El mapa de abajo es el mismo
 * backfill que ACC-3 hará en SQL, y por eso vive aquí y no en @mc/db.
 *
 * Lectura del Contador (DECISIÓN PENDIENTE DE NICOLÁS, ACC-5.md §0.5):
 * el «terminado cuando» de ACC-5 dice que con Contador /campanas
 * responde 404, así que aquí no lleva campanas.campana.ver; el borrador
 * de ACC-1 se lo da («ve nombre y monto»). Cuando ACC-1 reemplace esta
 * matriz, la prueba del marco obliga a decidirlo.
 */
import type { MembershipRole, WorkspaceKind } from "@mc/db/queries/accesos";
import { MODULE_PERMISSIONS } from "@/content/modules";

/** Los roles de fábrica de ACC-1/ACC-3 (`RoleKey` de @mc/core cuando llegue). */
export type RolDeFabrica = "owner" | "admin" | "manager" | "editor" | "finance" | "viewer";

/** Todos los módulos, abiertos del todo: el Dueño. */
const TODO: readonly string[] = ["resumen.*", "ventas.*", "cotizar.*", "campanas.*", "finanzas.*", "conexiones.*", "equipo.*"];

/** Los `.ver` mínimos de los módulos que «solo mira» alguien de solo lectura: sin Finanzas ni Equipo. */
const SOLO_LECTURA: readonly string[] = MODULE_PERMISSIONS.filter((p) => !p.startsWith("finanzas.") && !p.startsWith("equipo."));

/** Por tipo de workspace, los roles que la fase 5 le da: la agencia no tiene Editor. */
const MATRIZ: Readonly<Record<WorkspaceKind, Readonly<Partial<Record<RolDeFabrica, readonly string[]>>>>> = {
  creator: {
    owner: TODO,
    // El Dueño y el Administrador son el mismo en un workspace de creador (backfill de ACC-3).
    admin: TODO,
    // Su agente: Ventas, Cotizar y Campañas completas; ve Resumen, Conexiones y Equipo; de
    // Finanzas solo el cobro (decisión E), que no abre el módulo (mínimo: finanzas.factura.ver).
    manager: ["resumen.panel.ver", "ventas.*", "cotizar.*", "campanas.*", "conexiones.cuenta.ver", "equipo.miembro.ver"],
    // Community manager o editor de video.
    editor: ["resumen.panel.ver", "campanas.campana.ver", "conexiones.cuenta.ver"],
    // Contador externo: todo Finanzas y nada más (ver la cabecera).
    finance: ["finanzas.*"],
    viewer: SOLO_LECTURA,
  },
  agency: {
    owner: TODO,
    admin: TODO,
    // Ejecutivo de cuenta: exactamente Ventas, Cotizar y Campañas, como dice la fase 5.
    manager: ["ventas.*", "cotizar.*", "campanas.*"],
    finance: ["finanzas.*"],
    viewer: SOLO_LECTURA,
  },
};

/**
 * De `membership.role` (0001) al rol de fábrica: el backfill de ACC-3.
 * `client` no es nadie (decisión D: la marca no tiene cuenta, tiene un
 * enlace) y devuelve null.
 */
export function rolDeFabrica(kind: WorkspaceKind, role: MembershipRole): RolDeFabrica | null {
  switch (role) {
    case "owner":
      return "owner";
    case "admin":
      return kind === "agency" ? "admin" : "owner";
    case "member":
      return kind === "agency" ? "manager" : "editor";
    case "viewer":
      return "viewer";
    case "client":
      return null;
  }
}

/** Nadie: el conjunto vacío, compartido y congelado. */
export const SIN_PERMISOS: ReadonlySet<string> = Object.freeze(new Set<string>());

const CONJUNTOS = new Map<string, ReadonlySet<string>>();

/** El conjunto (congelado) de un rol de fábrica. Un rol que ese tipo de workspace no tiene (Editor en agencia): vacío. */
export function permisosDeRolProvisional(kind: WorkspaceKind, rol: RolDeFabrica): ReadonlySet<string> {
  const id = `${kind}:${rol}`;
  let set = CONJUNTOS.get(id);
  if (!set) {
    const permisos = MATRIZ[kind][rol];
    set = permisos ? Object.freeze(new Set(permisos)) : SIN_PERMISOS;
    CONJUNTOS.set(id, set);
  }
  return set;
}

/** El conjunto de una membresía de hoy: rol de fábrica y su matriz. Sin rol (client), vacío. */
export function permisosDeMembresia(kind: WorkspaceKind, role: MembershipRole): ReadonlySet<string> {
  const rol = rolDeFabrica(kind, role);
  return rol ? permisosDeRolProvisional(kind, rol) : SIN_PERMISOS;
}

/** El Dueño de un workspace de creador: lo que recibe el modo demo sin DEMO_USER_ID. */
export const PERMISOS_DE_DUENO: ReadonlySet<string> = permisosDeRolProvisional("creator", "owner");
