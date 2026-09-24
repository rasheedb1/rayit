import type { Metadata } from "next";
import type { ChannelAccountRow } from "@mc/db/queries/canales";
import { getChannelPolicyCaps, listChannelAccounts } from "@mc/db/queries/canales";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
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
import { Desconectar } from "./desconectar";
import { Limites } from "./limites";
import { MESSAGES } from "./messages";

export const metadata: Metadata = { title: MESSAGES.meta.title };
// Lee la base y el entorno en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

const LIVE_STATES = new Set(["connected", "needs_reconnect", "error"]);

/**
 * El botón de la fila es un formulario (POST): el correo va a Google,
 * LinkedIn e Instagram a Unipile. Reconectar manda el id de NUESTRA fila;
 * el account_id del proveedor lo lee el servidor. Sin llaves, el botón
 * sigue ahí pero deshabilitado, con el motivo en su nombre accesible.
 */
function ConnectButton({ row }: { row: ChannelRowView }) {
  if (!row.action) return null;
  const label = row.action === "connect" ? MESSAGES.actions.connect : row.action === "reconnect" ? MESSAGES.actions.reconnect : MESSAGES.actions.retry;
  const variant = row.action === "reconnect" ? "primary" : "secondary";
  const a11y = row.unavailable ? MESSAGES.actions.unavailableLabel(label, MESSAGES.detail.unavailable) : undefined;
  const button = <Button type="submit" size="sm" variant={variant} disabled={row.unavailable} aria-label={a11y}>{label}</Button>;
  if (row.channel === "email") {
    return <form method="post" action="/api/oauth/google">{button}</form>;
  }
  return (
    <form method="post" action={`${CANALES}/conectar`}>
      <input type="hidden" name="canal" value={row.channel} />
      {row.action === "reconnect" && row.account && <input type="hidden" name="reconectar" value={row.account.id} />}
      {button}
    </form>
  );
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
  return (
    <details className="group">
      <summary className="inline-flex cursor-pointer select-none items-center gap-1 text-xs text-fg-2 hover:text-fg">
        <span aria-hidden className="transition-transform group-open:rotate-90">›</span>
        {MESSAGES.actions.manage}
      </summary>
      <div className="mt-3 flex flex-col gap-4 border-t border-line pt-3">
        <Limites
          accountId={live.id}
          dailyCap={live.dailyCap}
          weeklyCap={live.weeklyCap}
          maxDaily={l.maxDaily}
          maxWeekly={l.maxWeekly}
          dailyHelp={dailyHelp}
          weeklyHelp={max.plain(f.int(l.maxWeekly))}
          dailyPlaceholder={f.int(l.maxDaily)}
          weeklyPlaceholder={f.int(l.maxWeekly)}
        />
        <p className="text-xs text-fg-3">{MESSAGES.caps.emptyMeansMax}</p>
        <div>
          <Desconectar accountId={live.id} />
        </div>
      </div>
    </details>
  );
}

function ChannelRow({ row, f, adminDetails }: { row: ChannelRowView; f: Formatter; adminDetails: boolean }) {
  const t = MESSAGES.channels[row.channel];
  const pill = pillFor(row);
  const live = row.account && LIVE_STATES.has(row.state) ? row.account : null;
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{t.name}</h3>
          <p className="truncate text-xs text-fg-3">{live ? (live.displayName ?? live.providerAccountId) : t.blurb}</p>
          {live && (
            <p className="mt-0.5 text-xs tabular-nums text-fg-2">
              {MESSAGES.detail.usage(f.int(live.usedToday), f.int(live.limits.effectiveDaily), f.int(live.usedThisWeek), f.int(live.limits.effectiveWeekly))}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Pill kind={pill.kind}>{pill.label}</Pill>
          <ConnectButton row={row} />
        </div>
      </div>
      <Hints row={row} adminDetails={adminDetails} />
      {live && <Manage row={row} live={live} f={f} />}
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
