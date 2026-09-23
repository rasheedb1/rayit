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
import type { AccountRow, ConnectionPlatformId, ConnectionStatus } from "@mc/db";
import type { OAuthProviderId } from "@mc/connectors";
import type { PillKind } from "@/components/ui/pill";
import { MESSAGES } from "./messages";

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
   * empresa, el CSV y el proveedor de datos llegan por otro camino, así
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
  aggregator: { clase: "proveedor", etiqueta: t.acceso.proveedor, explicacion: t.acceso.proveedorExplicacion, conToken: false, relectura: false },
};

export function accesoDe(accessMode: FilaDeCuenta["accessMode"]): Acceso {
  return ACCESO[accessMode];
}

/** Qué ofrece la fila como acción principal. «reautorizar» solo existe con token. */
export type AccionDeCuenta = "actualizar" | "reautorizar" | "ninguna";

export interface EstadoDeCuenta {
  tono: PillKind;
  texto: string;
  accion: AccionDeCuenta;
}

/**
 * El estado que se pinta, derivado de la fila y del reloj.
 *
 * El orden importa: `needs_reauth` y `revoked` son respuestas de la
 * plataforma y mandan sobre la fecha del token; «vencida» es lo que
 * queda cuando nadie ha preguntado todavía.
 */
export function estadoDeCuenta(row: FilaDeCuenta, ahora: Date): EstadoDeCuenta {
  if (row.status === "disabled") return { tono: "neutral", texto: t.estado.quitada, accion: "ninguna" };
  const { conToken, relectura } = accesoDe(row.accessMode);
  // Lo que se puede hacer con una cuenta que está bien: releerla, si
  // esta pantalla sabe hacerlo. Si no, nada; nunca un botón que falla.
  const alDia: AccionDeCuenta = relectura ? "actualizar" : "ninguna";
  if (conToken) {
    if (row.status === "needs_reauth") return { tono: "bad", texto: t.estado.necesitaReautorizar, accion: "reautorizar" };
    if (row.status === "revoked") return { tono: "bad", texto: t.estado.revocada, accion: "reautorizar" };
    if (row.status === "expired" || vencido(row.accessExpiresAt, ahora)) {
      return { tono: "bad", texto: t.estado.vencida, accion: "reautorizar" };
    }
    if (row.status === "error") return { tono: "bad", texto: t.estado.noSePudoLeer, accion: alDia };
    if (row.tokenExpiringSoon) return { tono: "warn", texto: t.estado.vencePronto, accion: alDia };
    return { tono: "good", texto: t.estado.activa, accion: alDia };
  }
  // Sin token no hay permiso que caduque: una cuenta por @ solo puede
  // estar bien o no haberse podido leer. Los estados de token que
  // pudiera arrastrar de una autorización anterior se leen como eso.
  if (row.status === "active") return { tono: "good", texto: t.estado.activa, accion: alDia };
  return { tono: "bad", texto: t.estado.noSePudoLeer, accion: alDia };
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
};

export function proveedorDe(platformId: ConnectionPlatformId): OAuthProviderId | null {
  return PROVEEDOR[platformId] ?? null;
}
