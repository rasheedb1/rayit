/**
 * Lo que la pantalla de Conexiones decide sobre una fila, como funciones
 * puras: de qué clase es el acceso, en qué estado está la cuenta y hace
 * cuánto se leyó. Ninguna celda del JSX elige un color ni un texto por
 * su cuenta, y las tres se prueban en milisegundos (estado.test.ts).
 *
 * La regla de CON-4 que justifica todo el archivo: el estado NO es
 * `social_connection.status`. Esa columna es lo que el worker dejó la
 * última vez, y `oauth.refresh` todavía no corre en producción (CIM-7),
 * así que una cuenta con el token ya vencido sigue en 'active'. Aquí se
 * compara con el reloj: vencida es vencida aunque nadie lo haya anotado.
 */
import type { AccountGap, AccountRow, ConnectionPlatformId, ConnectionStatus } from "@mc/db";
import type { OAuthProviderId } from "@mc/connectors";
import type { PillKind } from "@/components/ui/pill";
import { displayNameOf, MESSAGES } from "./messages";

const t = MESSAGES.tabla;

/**
 * Lo que la PANTALLA necesita de una cuenta, y nada más.
 *
 * `AccountRow` trae además `secretRef` y `scopes`, que no se pintan.
 * Pasarlos igual no era gratis: en desarrollo, React serializa las
 * props de cada componente en la carga que manda al navegador (el
 * «owner stack» de las herramientas), así que la ref del secreto y los
 * permisos concedidos de todas las cuentas del workspace viajaban al
 * cliente en cada visita. Se vio con un `grep enc:tiktok:` sobre el
 * HTML de dev. Aquí se quedan fuera, y el `grep` sale vacío.
 */
export interface FilaDeCuenta {
  id: string;
  platformId: ConnectionPlatformId;
  externalAccountId: string;
  handle: string | null;
  displayName: string | null;
  status: ConnectionStatus;
  statusDetail: string | null;
  hoursSinceSync: number | null;
  accessExpiresAt: string | null;
  tokenExpiringSoon: boolean;
  accessMode: AccountRow["accessMode"];
  latest: AccountRow["latest"];
  followersDelta7d: number | null;
  /** Ver AccountRow.refreshExpiresAt: decide si un acceso vencido se renueva solo. */
  refreshExpiresAt: string | null;
  /**
   * ACC-8: quién la conectó en nombre del titular —ya como frase: nombre,
   * correo o «alguien del equipo»— y cuándo (ISO). null si la conectó
   * el propio titular: la ausencia de la línea es la información. El
   * userId no baja: la pantalla no lo pinta.
   */
  conectadaPor: { quien: string; en: string } | null;
  /** CON-5: publicaciones vivas que seguimos y la última lectura de su contenido (ISO). */
  postsCount: number;
  lastPostSnapshotAt: string | null;
  /** CON-7: qué grupo de cifras falta y por qué (metric_gap). */
  huecos: AccountGap[];
}

/** La proyección, en un solo sitio: lo que se añada a AccountRow no entra aquí solo. */
export function filaDeCuenta(r: AccountRow): FilaDeCuenta {
  return {
    id: r.id,
    platformId: r.platformId,
    externalAccountId: r.externalAccountId,
    handle: r.handle,
    displayName: r.displayName,
    status: r.status,
    statusDetail: r.statusDetail,
    hoursSinceSync: r.hoursSinceSync,
    accessExpiresAt: r.accessExpiresAt,
    tokenExpiringSoon: r.tokenExpiringSoon,
    accessMode: r.accessMode,
    latest: r.latest,
    followersDelta7d: r.followersDelta7d,
    refreshExpiresAt: r.refreshExpiresAt,
    conectadaPor: r.connectedBy
      ? { quien: displayNameOf(r.connectedBy) ?? t.alguienDelEquipo, en: r.connectedBy.at }
      : null,
    postsCount: r.postsCount,
    lastPostSnapshotAt: r.lastPostSnapshotAt,
    huecos: r.gaps,
  };
}

/** De dónde salen las cifras de una cuenta. */
export type ClaseDeAcceso = "por_arroba" | "autorizada" | "csv" | "proveedor";

export interface Acceso {
  clase: ClaseDeAcceso;
  /** «Por @», «Autorizada»… La pastilla de la columna Acceso. */
  etiqueta: string;
  /** Una frase que explica de dónde salen las cifras (title y lectura en voz alta). */
  explicacion: string;
  /** true si la cuenta se lee con un token del dueño: solo esas vencen y solo esas se reautorizan. */
  conToken: boolean;
  /**
   * true si ESTA pantalla sabe volver a leer la cuenta ahora mismo
   * (`cuentas-service.actualizar`): por @ con su fuente pública, o con
   * el token del dueño si la autorizó por OAuth. El portafolio de
   * empresa y el CSV llegan por otro camino, así
   * que no se les ofrece un botón «Actualizar» que solo puede fallar
   * —y que, en una cuenta importada por CSV, dispararía una búsqueda
   * pública por su @ capaz de dejarla en 'error'—.
   */
  relectura: boolean;
}

/**
 * `social_connection.access_mode` (0002 + 0022) traducido a lo que la
 * pantalla necesita saber. `business_portfolio` es el portafolio de
 * empresa de Meta: también es un permiso del dueño y también caduca.
 */
const ACCESO: Record<FilaDeCuenta["accessMode"], Acceso> = {
  public_profile: { clase: "por_arroba", etiqueta: t.acceso.porArroba, explicacion: t.acceso.porArrobaExplicacion, conToken: false, relectura: true },
  direct_oauth: { clase: "autorizada", etiqueta: t.acceso.autorizada, explicacion: t.acceso.autorizadaExplicacion, conToken: true, relectura: true },
  business_portfolio: { clase: "autorizada", etiqueta: t.acceso.autorizada, explicacion: t.acceso.portafolioExplicacion, conToken: true, relectura: false },
  manual_csv: { clase: "csv", etiqueta: t.acceso.csv, explicacion: t.acceso.csvExplicacion, conToken: false, relectura: false },
  // El proveedor de datos (CON-12) se relee con «Actualizar» igual que una cuenta por @: misma fuente, otra credencial.
  aggregator: { clase: "proveedor", etiqueta: t.acceso.proveedor, explicacion: t.acceso.proveedorExplicacion, conToken: false, relectura: true },
};

export function accesoDe(accessMode: FilaDeCuenta["accessMode"]): Acceso {
  return ACCESO[accessMode];
}

/**
 * Qué ofrece la fila como acción principal. «reautorizar» solo existe con
 * token; «reautorizar_opcional» es la salida de una cuenta que se renovaría
 * sola si el worker corriera (botón secundario, no rojo).
 */
export type AccionDeCuenta = "actualizar" | "reautorizar" | "reautorizar_opcional" | "ninguna";

export interface EstadoDeCuenta {
  tono: PillKind;
  texto: string;
  accion: AccionDeCuenta;
  /**
   * Una frase que acompaña a la pastilla cuando el estado solo no basta
   * para saber qué pasa ni qué hacer («se renueva sola cuando corra el
   * worker»). null si la pastilla lo dice todo.
   */
  nota: string | null;
}

/**
 * El estado que se pinta, derivado de la fila y del reloj.
 *
 * El orden importa: `needs_reauth` y `revoked` son respuestas de la
 * plataforma y mandan sobre la fecha del token; «vencida» es lo que
 * queda cuando nadie ha preguntado todavía.
 */
export function estadoDeCuenta(row: FilaDeCuenta, ahora: Date): EstadoDeCuenta {
  const e = (tono: PillKind, texto: string, accion: AccionDeCuenta, nota: string | null = null): EstadoDeCuenta => ({ tono, texto, accion, nota });
  if (row.status === "disabled") return e("neutral", t.estado.quitada, "ninguna");
  const { conToken, relectura } = accesoDe(row.accessMode);
  // Lo que se puede hacer con una cuenta que está bien: releerla, si
  // esta pantalla sabe hacerlo. Si no, nada; nunca un botón que falla.
  const alDia: AccionDeCuenta = relectura ? "actualizar" : "ninguna";
  if (conToken) {
    if (row.status === "needs_reauth") return e("bad", t.estado.necesitaReautorizar, "reautorizar");
    if (row.status === "revoked") return e("bad", t.estado.revocada, "reautorizar");
    if (row.status === "expired") return e("bad", t.estado.vencida, "reautorizar");
    if (vencido(row.accessExpiresAt, ahora)) {
      // CON-3 → CON-4. El acceso venció pero la renovación sigue viva:
      // oauth.refresh lo resuelve sin pedirle nada al dueño, así que ni
      // rojo ni «Reautorizar» urgente. Tampoco «Actualizar»: leer con un
      // token vencido haría que la plataforma lo rechace y la cuenta
      // quedaría en 'error' por algo que no es un error. Pero el worker
      // la renueva 30 minutos ANTES de que venza, así que si la fila se
      // ve así es que no corre (hoy, en producción): se ofrece
      // reautorizar como salida secundaria para no dejarla atascada.
      if (row.refreshExpiresAt !== null && !vencido(row.refreshExpiresAt, ahora)) {
        return e("warn", t.estado.seRenuevaSola, "reautorizar_opcional", t.seRenuevaSola);
      }
      return e("bad", t.estado.vencida, "reautorizar");
    }
    if (row.status === "error") return e("bad", t.estado.noSePudoLeer, alDia, relectura ? null : t.sinRelectura);
    if (row.tokenExpiringSoon) return e("warn", t.estado.vencePronto, alDia);
    return e("good", t.estado.activa, alDia);
  }
  // Sin token no hay permiso que caduque: una cuenta por @ solo puede
  // estar bien o no haberse podido leer. Los estados de token que
  // pudiera arrastrar de una autorización anterior se leen como eso.
  if (row.status === "active") return e("good", t.estado.activa, alDia);
  return e("bad", t.estado.noSePudoLeer, alDia, relectura ? null : t.sinRelectura);
}

/**
 * CON-7 · los huecos de una cuenta en palabras: qué grupo falta (el
 * nombre que una persona entiende) y por qué (el message_es de la base,
 * tal cual). La fecha se devuelve sin formatear: la formatea quien pinta,
 * con el formatter del workspace.
 */
export interface HuecoDeCuenta {
  /** metric_group: único por cuenta (UNIQUE de 0039), sirve de clave. */
  grupo: string;
  que: string;
  porQue: string;
  desde: string;
  arreglo: string | null;
}

export function huecosDeCuenta(row: Pick<FilaDeCuenta, "huecos">): HuecoDeCuenta[] {
  return row.huecos.map((g) => ({
    grupo: g.metricGroup,
    que: t.falta(t.grupos[g.metricGroup] ?? t.grupoDesconocido),
    porQue: g.messageEs,
    desde: g.since,
    // Solo un enlace https: el catálogo lo escribe una migración, pero
    // un href es un href y no se pinta lo que no se ha comprobado.
    arreglo: g.fixUrl !== null && g.fixUrl.startsWith("https://") ? g.fixUrl : null,
  }));
}

/** Un instante ISO ya pasado. Sin fecha, no se sabe que haya vencido: no se inventa. */
function vencido(accessExpiresAt: string | null, ahora: Date): boolean {
  if (accessExpiresAt === null) return false;
  const ms = Date.parse(accessExpiresAt);
  return Number.isFinite(ms) && ms <= ahora.getTime();
}

/**
 * `connection_health.hours_since_sync` (0010) en palabras. Una ausencia
 * se explica con una frase; nunca «—» ni «0 h».
 */
export function frescura(horas: number | null): string {
  if (horas === null) return t.frescura.sinLectura;
  if (horas < 1) return t.frescura.haceUnMomento;
  if (horas < 24) {
    const h = Math.floor(horas);
    return h === 1 ? t.frescura.haceUnaHora : `hace ${h} horas`;
  }
  const dias = Math.floor(horas / 24);
  return dias === 1 ? t.frescura.haceUnDia : `hace ${dias} días`;
}

/**
 * Qué app de CON-3 reautoriza esta red. YouTube y Facebook no tienen
 * proveedor todavía (CON-8, pospuesta): su cuenta se ve, pero no se
 * ofrece un botón que no lleva a ninguna parte.
 */
const PROVEEDOR: Partial<Record<ConnectionPlatformId, OAuthProviderId>> = {
  tiktok: "tiktok",
  instagram: "instagram",
  youtube: "youtube",
};

export function proveedorDe(platformId: ConnectionPlatformId, accessMode: FilaDeCuenta["accessMode"] = "direct_oauth"): OAuthProviderId | null {
  // Solo una autorización directa se repara con la app de OAuth de la red.
  // El portafolio de empresa de Meta es otro permiso y otra app: mandarlo
  // por Instagram Login crearía otra fila o le cambiaría el modo.
  if (accessMode !== "direct_oauth") return null;
  return PROVEEDOR[platformId] ?? null;
}
