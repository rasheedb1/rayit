import type { CSSProperties } from "react";
import { listChannelUsage, type ChannelUsage, type UsageLevel } from "@mc/db/queries/actividad";
import { SectionTitle } from "@/components/page-header";
import { Pill, type PillKind } from "@/components/ui/pill";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { withWorkspace } from "../../_lib/db";
import { MESSAGES } from "../messages";

const T = MESSAGES.uso;

/** El semáforo: verde con margen, ámbar cerca del límite, rojo en él. El texto va siempre al lado del color. */
const NIVEL_PILL: Record<UsageLevel, PillKind> = { ok: "good", near: "warn", full: "bad" };
const NIVEL_BARRA: Record<UsageLevel, string> = { ok: "bg-good", near: "bg-warn", full: "bg-bad" };
/** Los días pasados, en gris salvo los que llegaron cerca o al límite. */
const NIVEL_DIA: Record<UsageLevel, string> = { ok: "bg-fg-3", near: "bg-warn", full: "bg-bad" };

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
  calentando: string | null;
  proveedor: string;
  caida: boolean;
  usedShare: number;
  softShare: number;
  medidor: string;
  dias: { key: string; label: string; share: number; nivel: UsageLevel }[];
}

export function usoVista(u: ChannelUsage, f: Formatter): UsoVista {
  const canal = T.canales[u.channel] ?? u.channel;
  const cuenta = u.accountName ?? canal;
  const nivelTexto = T.niveles[u.level];
  return {
    id: u.accountId,
    canal,
    cuenta,
    nivel: u.level,
    nivelTexto,
    cifra: T.cifra(f.int(u.used), f.int(u.hardLimit)),
    blando: T.blando(f.int(u.softLimit)),
    duro: T.duro(f.int(u.hardLimit)),
    calentando: u.warmingUp ? T.calentando(f.int(u.hardLimit), f.int(u.dailyLimit)) : null,
    proveedor: T.proveedor(f.int(u.providerLimit), canal),
    caida: u.accountStatus !== "connected",
    usedShare: u.usedShare,
    softShare: u.softShare,
    medidor: T.medidor(cuenta, f.int(u.used), f.int(u.hardLimit), nivelTexto),
    dias: u.history.map((d) => ({
      key: d.day,
      label: `${f.dayMonth(d.day)}: ${T.cifra(f.int(d.used), f.int(d.limit))}`,
      share: d.share,
      nivel: d.level,
    })),
  };
}

/** Una variable CSS con una fracción: el ancho o el alto lo calcula el navegador (calc(var(--x) * 100%)). */
const fraccion = (name: string, value: number): CSSProperties => ({ [name]: String(value) }) as CSSProperties;

/**
 * El medidor de una cuenta: la barra de hoy contra el límite duro, con la
 * marca del límite blando; debajo, los 14 días como barras finas (el alto
 * es lo usado sobre el límite de ese día). Para un lector de pantalla,
 * el medidor es un `meter` con su frase, y los días, una lista.
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
        className="relative h-2 w-full overflow-hidden rounded-full bg-surface-2"
        style={{ ...fraccion("--usado", u.usedShare), ...fraccion("--blando", u.softShare) }}
      >
        <span className={`absolute inset-y-0 left-0 w-[calc(var(--usado)*100%)] rounded-full ${NIVEL_BARRA[u.nivel]}`} />
        <span aria-hidden="true" className="absolute inset-y-0 left-[calc(var(--blando)*100%)] w-px bg-fg-3" />
      </div>
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs tabular-nums text-fg-2">
        <span>{u.blando}</span>
        <span>{u.duro}</span>
        <span className="text-fg-3">{u.proveedor}</span>
      </p>
      {u.calentando && <p className="text-xs text-fg-2">{u.calentando}</p>}
      {u.caida && <p className="text-xs text-warn">{T.caida}</p>}
      <div>
        <p className="sr-only">{T.historia}</p>
        <ul className="sr-only">
          {u.dias.map((d) => <li key={d.key}>{d.label}</li>)}
        </ul>
        <div aria-hidden="true" className="flex h-6 items-end gap-0.5" title={T.historia}>
          {u.dias.map((d) => (
            <span key={d.key} className="flex h-full flex-1 items-end rounded-sm bg-surface-2" title={d.label}>
              <span
                className={`block w-full rounded-sm ${NIVEL_DIA[d.nivel]} h-[calc(var(--dia)*100%)]`}
                style={fraccion("--dia", d.share)}
              />
            </span>
          ))}
        </div>
      </div>
    </li>
  );
}

/** El widget sin datos propios: recibe las cuentas ya formateadas (para la galería y las pruebas). */
export function UsoPorCanalVista({ cuentas }: { cuentas: UsoVista[] }) {
  return (
    <section aria-labelledby="uso-por-canal">
      <SectionTitle>
        <span id="uso-por-canal">{T.titulo}</span>
      </SectionTitle>
      <p className="-mt-1 mb-3 max-w-2xl text-xs text-fg-2">{T.descripcion}</p>
      {cuentas.length === 0 ? (
        <p className="rounded-md border border-line bg-surface px-4 py-3 text-sm text-fg-2">{T.vacio}</p>
      ) : (
        <ul className="divide-y divide-line rounded-md border border-line bg-surface">
          {cuentas.map((u) => <Cuenta key={u.id} u={u} />)}
        </ul>
      )}
    </section>
  );
}

/**
 * El uso por canal con su límite blando, su límite duro y su semáforo,
 * montable con una línea (`<UsoPorCanal />`): lee el uso del espacio de la
 * sesión (listChannelUsage, la vista outbound_usage_daily con la curva de
 * calentamiento del despachador) y lo formatea en su idioma y su zona.
 */
export async function UsoPorCanal() {
  const usage = await withWorkspace((tx) => listChannelUsage(tx));
  const f = formatterFor(await getCurrentWorkspace());
  return <UsoPorCanalVista cuentas={usage.map((u) => usoVista(u, f))} />;
}
