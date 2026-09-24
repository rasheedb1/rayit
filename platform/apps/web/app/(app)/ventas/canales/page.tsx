import type { Metadata } from "next";
import type { ChannelAccountRow } from "@mc/db/queries/canales";
import { getChannelPolicyCaps, listChannelAccounts } from "@mc/db/queries/canales";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Pill } from "@/components/ui/pill";
import { getDbMode, withWorkspace } from "@/lib/db";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { Aviso } from "../../_lib/aviso";
import { ModuleTabs } from "../_componentes/pestanas";
import { channelBanner } from "./_lib/banner";
import { channelSetup } from "./_lib/config";
import { CANALES } from "./_lib/conexion";
import { channelRows, pillFor, type ChannelRowView } from "./_lib/filas";
import { AvisoConexion } from "./aviso-conexion";
import { ConectarBoton } from "./conectar-boton";
import { Desconectar } from "./desconectar";
import { Limites } from "./limites";
import { MESSAGES } from "./messages";
import { ReintentarAvisos } from "./reintentar-avisos";

export const metadata: Metadata = { title: MESSAGES.meta.title };
// Lee la base y el entorno en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

const LIVE_STATES = new Set(["connected", "needs_reconnect", "error"]);

const accountName = (a: ChannelAccountRow) => a.displayName ?? a.providerAccountId ?? "";

/**
 * El botón de la fila. Conectar, reconectar y volver a empezar son un
 * formulario (POST): el correo va a Google, LinkedIn e Instagram a
 * Unipile, con estado de carga (ConectarBoton). Reconectar manda el id de
 * NUESTRA fila; el account_id del proveedor lo lee el servidor. Los
 * avisos de una cuenta conectada se reintentan con una acción de
 * servidor, sin salir de la página. Sin llaves, el botón sigue ahí pero
 * deshabilitado, con el motivo en su nombre accesible.
 */
function RowAction({ row }: { row: ChannelRowView }) {
  if (!row.action) return null;
  const label = row.action === "connect" ? MESSAGES.actions.connect : row.action === "reconnect" ? MESSAGES.actions.reconnect : MESSAGES.actions.retry;
  const a11y = row.unavailable ? MESSAGES.actions.unavailableLabel(label, MESSAGES.detail.unavailable) : undefined;
  if (row.action === "rewebhook" && row.account) {
    return <ReintentarAvisos accountId={row.account.id} disabled={row.unavailable} ariaLabel={a11y} />;
  }
  const variant = row.action === "reconnect" ? "primary" : "secondary";
  if (row.channel === "email") {
    return <ConectarBoton action="/api/oauth/google" fields={{}} label={label} variant={variant} disabled={row.unavailable} ariaLabel={a11y} />;
  }
  const fields: Record<string, string> = { canal: row.channel };
  if (row.action === "reconnect" && row.account) fields["reconectar"] = row.account.id;
  return <ConectarBoton action={`${CANALES}/conectar`} fields={fields} label={label} variant={variant} disabled={row.unavailable} ariaLabel={a11y} />;
}

/** Las frases de debajo de la fila: por qué está así y qué hacer. Nunca nombres de variables ni códigos del proveedor. */
function Hints({ row, adminDetails }: { row: ChannelRowView; adminDetails: boolean }) {
  const provider = MESSAGES.channels[row.channel].provider;
  const lines: { key: string; text: string; tone: "fg" | "warn" }[] = [];
  if (row.state === "pending") lines.push({ key: "p", tone: "fg", text: row.channel === "email" ? MESSAGES.detail.pendingHint.email : MESSAGES.detail.pendingHint.unipile(provider) });
  if (row.state === "expired") lines.push({ key: "e", tone: "fg", text: row.channel === "email" ? MESSAGES.detail.expiredHint.email : MESSAGES.detail.expiredHint.unipile(provider) });
  if (row.unavailable) lines.push({ key: "u", tone: "warn", text: row.state === "connected" ? MESSAGES.detail.unavailableConnected : MESSAGES.detail.unavailable });
  const showAdmin = adminDetails && row.missing.length > 0;
  if (lines.length === 0 && !row.reason && !showAdmin) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {row.reason && (row.state === "connected" ? <p className="text-xs text-warn">{row.reason}</p> : <Aviso message={row.reason} size="xs" />)}
      {lines.map((l) => <p key={l.key} className={`text-xs ${l.tone === "warn" ? "text-warn" : "text-fg-2"}`}>{l.text}</p>)}
      {showAdmin && (
        <details className="text-xs text-fg-3">
          <summary className="cursor-pointer select-none hover:text-fg-2">{MESSAGES.detail.adminDetails}</summary>
          <p className="mt-1 break-words">{MESSAGES.detail.adminMissing(row.missing.join(", "))}</p>
        </details>
      )}
    </div>
  );
}

/** Límites y desconectar, plegados: la fila se queda compacta, como en las integraciones de Vercel o Linear. */
function Manage({ row, live, f }: { row: ChannelRowView; live: ChannelAccountRow; f: Formatter }) {
  const l = live.limits;
  const provider = MESSAGES.channels[row.channel].provider;
  const max = MESSAGES.caps.max;
  const dailyHelp = l.dailyLimitedBy === "policy" ? max.policy(f.int(l.maxDaily)) : l.personalMailbox ? max.personal(f.int(l.maxDaily)) : max.provider(f.int(l.maxDaily), provider);
  const name = accountName(live);
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-xs text-fg-2 hover:text-fg">
        <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
        {MESSAGES.actions.manage}
      </summary>
      <div className="mt-3 flex flex-col gap-4 border-t border-line pt-3">
        <Limites
          accountId={live.id}
          account={name}
          dailyCap={live.dailyCap}
          weeklyCap={live.weeklyCap}
          dailyHelp={dailyHelp}
          weeklyHelp={max.plain(f.int(l.maxWeekly))}
          dailyPlaceholder={f.int(l.maxDaily)}
          weeklyPlaceholder={f.int(l.maxWeekly)}
        />
        <p className="text-xs text-fg-3">{MESSAGES.caps.emptyMeansMax}</p>
        <div>
          <Desconectar accountId={live.id} account={name} />
        </div>
      </div>
    </details>
  );
}

/**
 * Una cuenta (o el canal sin cuenta): nombre, uso, estado y botón. En
 * móvil se apila (la pastilla y el botón bajan); desde `sm`, en línea,
 * con el estado a la derecha. `heading` es el nombre del canal en la fila
 * principal; las sub-filas de las demás cuentas no lo repiten.
 */
function AccountLine({ row, f, adminDetails, heading }: { row: ChannelRowView; f: Formatter; adminDetails: boolean; heading: string | null }) {
  const t = MESSAGES.channels[row.channel];
  const pill = pillFor(row);
  const live = row.account && LIVE_STATES.has(row.state) ? row.account : null;
  const name = live ? accountName(live) : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          {heading && <h3 className="text-sm font-semibold">{heading}</h3>}
          {name ? (
            <p className={`truncate ${heading ? "text-xs text-fg-3" : "text-sm font-medium"}`} title={name}>{name}</p>
          ) : (
            <p className="text-xs text-fg-3">{t.blurb}</p>
          )}
          {live && (
            <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs tabular-nums text-fg-2">
              <span className="whitespace-nowrap">{MESSAGES.detail.usageToday(f.int(live.usedToday), f.int(live.limits.effectiveDaily))}</span>
              <span className="whitespace-nowrap">{MESSAGES.detail.usageWeek(f.int(live.usedThisWeek), f.int(live.limits.effectiveWeekly))}</span>
              {live.lastOkAt && <span className="whitespace-nowrap text-fg-3">{MESSAGES.detail.lastOk(f.dateTime(live.lastOkAt.toISOString()))}</span>}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Pill kind={pill.kind}>{pill.label}</Pill>
          <RowAction row={row} />
        </div>
      </div>
      <Hints row={row} adminDetails={adminDetails} />
      {live && <Manage row={row} live={live} f={f} />}
    </div>
  );
}

function ChannelRow({ row, f, adminDetails }: { row: ChannelRowView; f: Formatter; adminDetails: boolean }) {
  return (
    <li className="flex flex-col gap-3 px-4 py-3">
      <AccountLine row={row} f={f} adminDetails={adminDetails} heading={MESSAGES.channels[row.channel].name} />
      {row.others.length > 0 && (
        <ul className="flex flex-col gap-3 border-l border-line pl-3" aria-label={MESSAGES.detail.otherAccounts(MESSAGES.channels[row.channel].name)}>
          {row.others.map((other) => (
            <li key={other.account?.id}>
              <AccountLine row={other} f={f} adminDetails={false} heading={null} />
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export default async function CanalesPage({ searchParams }: { searchParams: Promise<{ conectado?: string; error?: string }> }) {
  const params = await searchParams;
  const { accounts, policy } = await withWorkspace(async (tx) => ({
    accounts: await listChannelAccounts(tx),
    policy: await getChannelPolicyCaps(tx),
  }));
  const f = formatterFor(await getCurrentWorkspace());
  const rows = channelRows(accounts, channelSetup(process.env));
  const banner = channelBanner(params, rows);
  // Qué falta en el servidor: al registro siempre; a la pantalla, solo en desarrollo y plegado.
  for (const row of rows) {
    if (row.missing.length > 0) console.warn(MESSAGES.routes.serverMissing(MESSAGES.channels[row.channel].provider, row.missing.join(", ")));
  }
  const adminDetails = process.env.NODE_ENV !== "production" || (await getDbMode()) === "embedded";

  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={MESSAGES.header.title} description={MESSAGES.header.description} />
      <ModuleTabs active={CANALES} />
      <div className="flex flex-col gap-4">
        <AvisoConexion message={banner.message} notice={banner.notice} refresh={banner.refresh} />
        {!policy.enabled && <p className="text-sm text-fg-2">{MESSAGES.policyOff}</p>}
        <section>
          <SectionTitle>{MESSAGES.section}</SectionTitle>
          <ul className="divide-y divide-line rounded-md border border-line bg-surface">
            {rows.map((row) => (
              <ChannelRow key={row.channel} row={row} f={f} adminDetails={adminDetails} />
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
