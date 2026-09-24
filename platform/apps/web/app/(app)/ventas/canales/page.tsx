import type { Metadata } from "next";
import { channelCapLimits, getChannelPolicyCaps, listChannelAccounts } from "@mc/db/queries/canales";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Pill } from "@/components/ui/pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { Aviso } from "../../_lib/aviso";
import { ModuleTabs } from "../_componentes/pestanas";
import { channelSetup, isChannel } from "./_lib/config";
import { CANALES, type ChannelErrorCode } from "./_lib/conexion";
import { channelRows, STATE_PILL, type ChannelRowView } from "./_lib/filas";
import { Desconectar } from "./desconectar";
import { Limites } from "./limites";
import { MESSAGES } from "./messages";

export const metadata: Metadata = { title: MESSAGES.meta.title };
// Lee la base y el entorno en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/** El botón de conectar es un formulario (POST): el correo va a Google, LinkedIn e Instagram a Unipile. */
function ConnectButton({ row }: { row: ChannelRowView }) {
  if (!row.action) return null;
  const label = row.action === "connect" ? MESSAGES.actions.connect : row.action === "reconnect" ? MESSAGES.actions.reconnect : MESSAGES.actions.retry;
  const variant = row.action === "reconnect" ? "primary" : "secondary";
  if (row.channel === "email") {
    return (
      <form method="post" action="/api/oauth/google">
        <Button type="submit" size="sm" variant={variant}>{label}</Button>
      </form>
    );
  }
  const reconnectId = row.action === "reconnect" ? row.account?.providerAccountId : null;
  return (
    <form method="post" action={`${CANALES}/conectar`}>
      <input type="hidden" name="canal" value={row.channel} />
      {reconnectId && <input type="hidden" name="reconectar" value={reconnectId} />}
      <Button type="submit" size="sm" variant={variant}>{label}</Button>
    </form>
  );
}

function ChannelCard({ row, f, emailPerDay }: { row: ChannelRowView; f: Formatter; emailPerDay: number }) {
  const t = MESSAGES.channels[row.channel];
  const pill = STATE_PILL[row.state];
  // La cuenta viva, la que tiene uso, límites y «Desconectar». Una pendiente o desconectada no.
  const live = row.state === "connected" || row.state === "needs_reconnect" || row.state === "error" ? row.account : null;
  const limits = channelCapLimits(row.channel);
  const dayCap = live?.dailyCap ?? (row.channel === "email" ? emailPerDay : null);
  return (
    <li className="flex flex-col gap-4 rounded-md border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold">{t.name}</h3>
          <p className="mt-0.5 text-xs text-fg-3">{t.blurb}</p>
          {live && (
            <p className="mt-2 break-words text-sm">
              <span className="text-fg-3">{MESSAGES.detail.account} · </span>
              {live.displayName ?? live.providerAccountId}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill kind={pill.kind}>{pill.label}</Pill>
          <ConnectButton row={row} />
        </div>
      </div>

      {row.state === "not_configured" && (
        <p className="text-xs text-fg-2">
          {MESSAGES.detail.notConfiguredHint(row.missing.join(", "))} {MESSAGES.detail.howTo}
        </p>
      )}
      {row.state === "pending" && <p className="text-xs text-fg-2">{MESSAGES.detail.pendingHint}</p>}
      {row.state === "expired" && <p className="text-xs text-fg-2">{MESSAGES.detail.expiredHint}</p>}
      {row.reason && (row.state === "connected" ? <p className="text-xs text-warn">{row.reason}</p> : <Aviso message={row.reason} size="xs" />)}

      {live && (
        <div className="flex flex-col gap-4 border-t border-line pt-4">
          <p className="flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums text-fg-2">
            <span>{MESSAGES.detail.today(f.int(live.usedToday), dayCap === null ? null : f.int(dayCap))}</span>
            <span>{MESSAGES.detail.week(f.int(live.usedThisWeek), live.weeklyCap === null ? null : f.int(live.weeklyCap))}</span>
            {live.lastOkAt && <span className="text-fg-3">{MESSAGES.detail.lastOk(f.dateTime(live.lastOkAt.toISOString()))}</span>}
          </p>
          <Limites
            accountId={live.id}
            dailyCap={live.dailyCap}
            weeklyCap={live.weeklyCap}
            maxDaily={limits.daily}
            maxWeekly={limits.weekly}
            maxDailyText={f.int(limits.daily)}
            maxWeeklyText={f.int(limits.weekly)}
            dailyPlaceholder={row.channel === "email" ? MESSAGES.caps.placeholderPolicy(f.int(emailPerDay)) : MESSAGES.caps.placeholderNone}
          />
          <div>
            <Desconectar accountId={live.id} />
          </div>
        </div>
      )}
    </li>
  );
}

function banner(params: { conectado?: string; error?: string }): { message: string | null; notice: string | null } {
  const errors: Record<string, string> = MESSAGES.banners.errors;
  if (params.error && params.error in errors) return { message: errors[params.error as ChannelErrorCode]!, notice: null };
  if (isChannel(params.conectado)) return { message: null, notice: MESSAGES.banners.connected(MESSAGES.channels[params.conectado].provider) };
  return { message: null, notice: null };
}

export default async function CanalesPage({ searchParams }: { searchParams: Promise<{ conectado?: string; error?: string }> }) {
  const params = await searchParams;
  const { accounts, policy } = await withWorkspace(async (tx) => ({
    accounts: await listChannelAccounts(tx),
    policy: await getChannelPolicyCaps(tx),
  }));
  const f = formatterFor(await getCurrentWorkspace());
  const rows = channelRows(accounts, channelSetup(process.env));
  const b = banner(params);

  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={MESSAGES.header.title} description={MESSAGES.header.description} />
      <ModuleTabs active={CANALES} />
      <div className="flex flex-col gap-4">
        <Aviso message={b.message} notice={b.notice} />
        {!policy.enabled && <p className="text-sm text-fg-2">{MESSAGES.policyOff}</p>}
        <section>
          <SectionTitle>{MESSAGES.section}</SectionTitle>
          <ul className="flex flex-col gap-3">
            {rows.map((row) => (
              <ChannelCard key={row.channel} row={row} f={f} emailPerDay={policy.emailPerDay} />
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
