import Link from "next/link";
import { OUTREACH_URLS } from "@mc/core/outreach/messages";
import { Suspense, type CSSProperties, type ReactNode } from "react";
import { listChannelUsage, type ChannelUsage, type UsageLevel } from "@mc/db/queries/actividad";
import { SectionTitle } from "@/components/page-header";
import { Pill, type PillKind } from "@/components/ui/pill";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../../_lib/db";
import { canalHref } from "../../canales/_lib/foco";
import { MESSAGES } from "../messages";
import { FronteraWidget } from "./frontera-widget";

const T = MESSAGES.uso;

/**
 * El semáforo: verde con margen, ámbar cerca del límite, rojo en él, y
 * gris «Sin envío» cuando no sale nada aunque haya cupo (la cuenta caída o
 * el envío apagado): el verde nunca dice que se envía cuando no. El texto
 * va siempre al lado del color.
 */
const NIVEL_PILL: Record<UsageLevel, PillKind> = { ok: "good", near: "warn", full: "bad", off: "neutral" };
const NIVEL_BARRA: Record<UsageLevel, string> = { ok: "bg-good", near: "bg-warn", full: "bg-bad", off: "bg-fg-3" };
/** Los días pasados, en gris salvo los que llegaron cerca o al límite. */
const NIVEL_DIA: Record<Exclude<UsageLevel, "off">, string> = { ok: "bg-fg-3", near: "bg-warn", full: "bg-bad" };

/** Lo que pinta una cuenta, ya formateado. Las fracciones van a CSS como variables: aquí no se multiplica nada. */
export interface UsoVista {
  id: string;
  canal: string;
  cuenta: string;
  nivel: UsageLevel;
  nivelTexto: string;
  cifra: string;
  blando: string;
  duro: string;
  /** Lo que lleva la semana contra su tope; null cuando ya lo dice «manda» (la semana es la que manda hoy). */
  semana: string | null;
  calentando: string | null;
  /** Qué tope manda hoy, si no es el diario de la cuenta. */
  manda: string | null;
  proveedor: string;
  /** Por qué no sale nada, con adónde ir a arreglarlo; null si sale. */
  sinEnvio: { texto: string; enlace: string; href: string } | null;
  usedShare: number;
  softShare: number;
  medidor: string;
  /** Los 14 días, del más viejo a hoy. `conUso`: salió algo ese día (su barra no baja de 2 px, para no confundirse con un cero). */
  dias: { key: string; label: string; share: number; nivel: Exclude<UsageLevel, "off">; conUso: boolean }[];
  /** Las dos puntas del eje, debajo de la franja: el primer día y «Hoy». */
  eje: { desde: string; hasta: string } | null;
}

/**
 * Quién pone el techo del proveedor: el servicio de la cuenta (Gmail) o,
 * si la cuenta entra por un puente (Unipile), la red a la que llega.
 */
function proveedorDe(u: ChannelUsage): string {
  return T.proveedores[u.provider] ?? T.plataformas[u.channel];
}

export function usoVista(u: ChannelUsage, f: Formatter): UsoVista {
  const canal = T.canales[u.channel];
  const cuenta = u.accountName ?? canal;
  const nivelTexto = T.niveles[u.level];
  const manda =
    u.limitedBy === "week"
      ? T.manda.week()
      : u.limitedBy === "workspace" && u.workspaceUsed !== null && u.workspaceLimit !== null
        ? T.manda.workspace(f.int(u.workspaceUsed), f.int(u.workspaceLimit))
        : null;
  const sinEnvio = u.offReason === "account"
    ? { ...T.sinEnvio.account, href: canalHref(u.channel) }
    : u.offReason === "disabled"
      ? { ...T.sinEnvio.disabled, href: OUTREACH_URLS.policySwitch }
      : null;
  return {
    id: u.accountId,
    canal,
    cuenta,
    nivel: u.level,
    nivelTexto,
    cifra: T.cifra(f.int(u.used), f.int(u.hardLimit)),
    blando: T.blando(f.int(u.softLimit)),
    duro: T.duro(f.int(u.hardLimit)),
    semana: u.limitedBy === "week" ? null : T.semana(f.int(u.weekUsed), f.int(u.weeklyLimit)),
    calentando: u.warmingUp ? T.calentando(f.int(u.dayLimit), f.int(u.dailyLimit)) : null,
    manda,
    proveedor: T.proveedor(f.int(u.providerLimit), proveedorDe(u)),
    sinEnvio,
    usedShare: u.usedShare,
    softShare: u.softShare,
    medidor: T.medidor(cuenta, f.int(u.used), f.int(u.hardLimit), nivelTexto),
    dias: u.history.map((d) => ({
      key: d.day,
      label: `${f.dayMonth(d.day)}: ${T.cifra(f.int(d.used), f.int(d.limit))}`,
      share: d.share,
      nivel: d.level,
      conUso: d.used > 0,
    })),
    eje: u.history.length > 1 ? { desde: f.dayMonth(u.history[0]!.day), hasta: T.hoy } : null,
  };
}

/** Una variable CSS con una fracción: el ancho o el alto lo calcula el navegador (calc(var(--x) * 100%)). */
const fraccion = (name: string, value: number): CSSProperties => ({ [name]: String(value) }) as CSSProperties;

/**
 * El medidor de una cuenta: la barra de hoy contra el límite duro, con la
 * marca del límite blando; debajo, los 14 días como barras finas (el alto
 * es lo usado sobre el límite de ese día), con el primer día y «Hoy» en
 * las puntas: con el dedo, a 400 px, no hay title que leer. Un día con
 * algo de uso nunca baja de 2 px, para no confundirse con uno en cero.
 * Para un lector de pantalla, el medidor es un `meter` con su frase, y
 * los días, una lista.
 */
function Cuenta({ u }: { u: UsoVista }) {
  return (
    <li className="flex flex-col gap-2 px-3 py-3 sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className="text-sm font-medium">{u.canal}</p>
          <p className="truncate text-xs text-fg-3" title={u.cuenta}>{u.cuenta}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-sm tabular-nums">{u.cifra}</span>
          <Pill kind={NIVEL_PILL[u.nivel]}>{u.nivelTexto}</Pill>
        </div>
      </div>
      <div
        role="meter"
        aria-label={u.medidor}
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={u.usedShare}
        aria-valuetext={u.medidor}
        className="relative h-2 w-full overflow-hidden rounded-full bg-hover"
        style={{ ...fraccion("--usado", u.usedShare), ...fraccion("--blando", u.softShare) }}
      >
        <span className={`absolute inset-y-0 left-0 w-[calc(var(--usado)*100%)] rounded-full ${NIVEL_BARRA[u.nivel]}`} />
        <span aria-hidden="true" className="absolute inset-y-0 left-[calc(var(--blando)*100%)] w-px bg-fg-3" />
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums text-fg-2">
        <span>{u.blando}</span>
        <span>{u.duro}</span>
        {u.semana && <span>{u.semana}</span>}
        <span className="text-fg-3">{u.proveedor}</span>
      </p>
      {u.manda && <p className="text-xs text-fg-2">{u.manda}</p>}
      {u.calentando && <p className="text-xs text-fg-2">{u.calentando}</p>}
      {u.sinEnvio && (
        <p className="text-xs text-warn">
          {u.sinEnvio.texto}{" "}
          <Link href={u.sinEnvio.href} className="font-medium underline underline-offset-2">{u.sinEnvio.enlace}</Link>
        </p>
      )}
      <div>
        <p className="sr-only">{T.historia}</p>
        <ul className="sr-only">
          {u.dias.map((d) => <li key={d.key}>{d.label}</li>)}
        </ul>
        {/*
          Cada día es un carril con su borde de abajo: un día en cero se lee
          como una barra vacía, no como un hueco. El carril va en bg-hover
          (y no en bg-surface-2): en oscuro, surface-2 sobre surface casi no
          se distinguía del fondo.
        */}
        <div aria-hidden="true" className="flex h-6 items-end gap-0.5" title={T.historia}>
          {u.dias.map((d) => (
            <span key={d.key} className="flex h-full flex-1 items-end rounded-sm border-b border-line-2 bg-hover" title={d.label}>
              <span
                className={`block w-full rounded-sm ${NIVEL_DIA[d.nivel]} h-[calc(var(--dia)*100%)] ${d.conUso ? "min-h-0.5" : ""}`}
                style={fraccion("--dia", d.share)}
              />
            </span>
          ))}
        </div>
        {u.eje && (
          <p aria-hidden="true" className="mt-1 flex justify-between text-[11px] leading-4 tabular-nums text-fg-3">
            <span>{u.eje.desde}</span>
            <span>{u.eje.hasta}</span>
          </p>
        )}
      </div>
    </li>
  );
}

function Seccion({ children }: { children: ReactNode }) {
  return (
    <section aria-labelledby="uso-por-canal">
      <SectionTitle>
        <span id="uso-por-canal">{T.titulo}</span>
      </SectionTitle>
      <p className="-mt-1 mb-3 max-w-2xl text-xs text-fg-2">{T.descripcion}</p>
      {children}
    </section>
  );
}

/** El widget sin datos propios: recibe las cuentas ya formateadas (para la galería y las pruebas). */
export function UsoPorCanalVista({ cuentas }: { cuentas: UsoVista[] }) {
  return (
    <Seccion>
      {cuentas.length === 0 ? (
        <p className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-fg-2">{T.vacio}</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line bg-surface">
          {cuentas.map((u) => <Cuenta key={u.id} u={u} />)}
        </ul>
      )}
    </Seccion>
  );
}

/** Mientras la consulta responde: la sección con dos cuentas en gris. */
export function UsoPorCanalEsqueleto() {
  return (
    <Seccion>
      <ul aria-busy="true" aria-label={T.cargando} className="divide-y divide-line rounded-md border border-line bg-surface">
        {[0, 1].map((i) => (
          <li key={i} className="flex flex-col gap-2 px-4 py-3">
            <span className="block h-4 w-1/3 animate-pulse rounded-sm bg-hover" />
            <span className="block h-2 w-full animate-pulse rounded-full bg-hover" />
            <span className="block h-6 w-full animate-pulse rounded-sm bg-hover" />
          </li>
        ))}
      </ul>
    </Seccion>
  );
}

async function UsoPorCanalDatos() {
  const usage = await withWorkspace((tx) => listChannelUsage(tx));
  const f = formatterFor(await getCurrentWorkspace());
  return <UsoPorCanalVista cuentas={usage.map((u) => usoVista(u, f))} />;
}

/**
 * El uso por canal con su límite blando, su límite duro, el tope que
 * manda y su semáforo, montable con una línea (`<UsoPorCanal />`): lee el
 * uso del espacio de la sesión (listChannelUsage, la vista
 * outbound_usage_daily con la curva de calentamiento y los tres topes del
 * despachador) y lo formatea en su idioma y su zona.
 *
 * Trae su Suspense y su frontera de error: mientras carga, un esqueleto;
 * si su consulta falla, un aviso en su sitio. La pantalla anfitriona no
 * espera por él ni cae con él.
 */
export function UsoPorCanal() {
  return (
    <FronteraWidget aviso={T.error}>
      <Suspense fallback={<UsoPorCanalEsqueleto />}>
        <UsoPorCanalDatos />
      </Suspense>
    </FronteraWidget>
  );
}
