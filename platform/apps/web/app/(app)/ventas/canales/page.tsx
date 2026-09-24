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
import { channelSetup, type Channel } from "./_lib/config";
import { CANALES } from "./_lib/conexion";
import { channelRows, pillFor, type ChannelRowView } from "./_lib/filas";
import { AvisoConexion } from "./aviso-conexion";
import { ConectarBoton } from "./conectar-boton";
import { Desconectar } from "./desconectar";
import { FilaCanal } from "./fila-canal";
import { ChannelIcon } from "./iconos";
import { Limites } from "./limites";
import { MESSAGES } from "./messages";
import { ReintentarAvisos } from "./reintentar-avisos";

export const metadata: Metadata = { title: MESSAGES.meta.title };
// Lee la base y el entorno en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

const LIVE_STATES = new Set(["connected", "needs_reconnect", "error"]);

const accountName = (a: ChannelAccountRow) => a.displayName ?? a.providerAccountId ?? "";

/** El id del título de la fila de un canal: FilaCanal le lleva el foco después de desconectar. */
const headingId = (channel: Channel) => `canal-${channel}-titulo`;

/**
 * Qué canales ya se registraron como no disponibles en ESTE proceso. La
 * falta de llaves se escribe en el registro una vez por canal y proceso,
 * no en cada visita: sin Unipile en producción, una línea por visita
 * tapaba lo que importa. Al intentar conectar, notConfigured()
 * (conexion.ts) lo vuelve a registrar, que es cuando hace falta.
 */
const warnedMissing = new Set<Channel>();

function warnMissingOnce(rows: readonly ChannelRowView[]): void {
  for (const row of rows) {
    if (row.missing.length === 0 || warnedMissing.has(row.channel)) continue;
    warnedMissing.add(row.channel);
    console.warn(MESSAGES.routes.serverMissing(MESSAGES.channels[row.channel].provider, row.missing.join(", ")));
  }
}

/** El botón que abre la conexión de un canal: el correo va a Google, LinkedIn e Instagram a Unipile. */
function connectTarget(channel: Channel, reconnectId?: string): { action: string; fields: Record<string, string> } {
  if (channel === "email") return { action: "/api/oauth/google", fields: {} };
  return { action: `${CANALES}/conectar`, fields: reconnectId ? { canal: channel, reconectar: reconnectId } : { canal: channel } };
}

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
  const { action, fields } = connectTarget(row.channel, row.action === "reconnect" ? row.account?.id : undefined);
  return <ConectarBoton action={action} fields={fields} label={label} variant={variant} disabled={row.unavailable} ariaLabel={a11y} />;
}

/**
 * La frase de «no disponible» de una fila, o null. Una cuenta caída en un
 * canal sin llaves no repite «Vuelve a conectar la cuenta» (su botón va
 * deshabilitado): dice que necesita reconectarse y que el canal no está.
 * Si los tres canales están sin llaves, lo dice UN aviso arriba de la
 * lista (`quiet`) y la fila vacía se queda con su pastilla.
 */
function unavailableText(row: ChannelRowView, quiet: boolean): string | null {
  if (!row.unavailable) return null;
  if (row.state === "connected") return MESSAGES.detail.unavailableConnected;
  if (row.state === "needs_reconnect" || row.state === "error") return MESSAGES.detail.unavailableDown;
  return quiet ? null : MESSAGES.detail.unavailable;
}

/** Las frases de debajo de la fila: por qué está así y qué hacer. Nunca nombres de variables ni códigos del proveedor. */
function Hints({ row, adminDetails, quiet }: { row: ChannelRowView; adminDetails: boolean; quiet: boolean }) {
  const provider = MESSAGES.channels[row.channel].provider;
  const lines: { key: string; text: string; tone: "fg" | "warn" }[] = [];
  if (row.state === "pending") lines.push({ key: "p", tone: "fg", text: row.channel === "email" ? MESSAGES.detail.pendingHint.email : MESSAGES.detail.pendingHint.unipile(provider) });
  if (row.state === "expired") lines.push({ key: "e", tone: "fg", text: row.channel === "email" ? MESSAGES.detail.expiredHint.email : MESSAGES.detail.expiredHint.unipile(provider) });
  const unavailable = unavailableText(row, quiet);
  if (unavailable) lines.push({ key: "u", tone: "warn", text: unavailable });
  // Caída y sin llaves: la frase de la caída pide reconectar con un botón deshabilitado; manda la de «no disponible».
  const reason = row.unavailable && (row.state === "needs_reconnect" || row.state === "error") ? null : row.reason;
  const showAdmin = adminDetails && row.missing.length > 0;
  if (lines.length === 0 && !reason && !showAdmin) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {reason && (row.state === "connected" ? <p className="text-xs text-warn">{reason}</p> : <Aviso message={reason} size="xs" />)}
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
 * principal (con su id: FilaCanal le lleva el foco); las sub-filas de las
 * demás cuentas no lo repiten.
 */
function AccountLine({
  row, f, adminDetails, heading, quiet,
}: { row: ChannelRowView; f: Formatter; adminDetails: boolean; heading: { id: string; text: string } | null; quiet: boolean }) {
  const t = MESSAGES.channels[row.channel];
  const pill = pillFor(row);
  const live = row.account && LIVE_STATES.has(row.state) ? row.account : null;
  const name = live ? accountName(live) : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          {heading && (
            <h3 id={heading.id} tabIndex={-1} className="text-sm font-semibold">
              {heading.text}
            </h3>
          )}
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
      <Hints row={row} adminDetails={adminDetails} quiet={quiet} />
      {live && <Manage row={row} live={live} f={f} />}
    </div>
  );
}

/**
 * La fila de un canal: el icono del servicio a la izquierda (como las
 * integraciones de Vercel y de Linear), la cuenta principal, las demás
 * cuentas vivas en sub-filas y, si ya hay una viva, «Conectar otra
 * cuenta». FilaCanal (cliente) anuncia lo que pasa con sus cuentas.
 */
function ChannelRow({ row, f, adminDetails, quiet }: { row: ChannelRowView; f: Formatter; adminDetails: boolean; quiet: boolean }) {
  const channelName = MESSAGES.channels[row.channel].name;
  const another = connectTarget(row.channel);
  return (
    <FilaCanal headingId={headingId(row.channel)}>
      <div className="flex items-start gap-3">
        <ChannelIcon channel={row.channel} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <AccountLine row={row} f={f} adminDetails={adminDetails} heading={{ id: headingId(row.channel), text: channelName }} quiet={quiet} />
          {row.others.length > 0 && (
            <ul className="flex flex-col gap-3 border-l border-line pl-3" aria-label={MESSAGES.detail.otherAccounts(channelName)}>
              {row.others.map((other) => (
                <li key={other.account?.id}>
                  <AccountLine row={other} f={f} adminDetails={false} heading={null} quiet={quiet} />
                </li>
              ))}
            </ul>
          )}
          {row.addAnother && (
            <div>
              <ConectarBoton action={another.action} fields={another.fields} label={MESSAGES.actions.connectAnother} variant="ghost" disabled={false} />
            </div>
          )}
        </div>
      </div>
    </FilaCanal>
  );
}

export default async function CanalesPage({ searchParams }: { searchParams: Promise<{ conectado?: string; error?: string; canal?: string }> }) {
  const params = await searchParams;
  const { accounts, policy } = await withWorkspace(async (tx) => ({
    accounts: await listChannelAccounts(tx),
    policy: await getChannelPolicyCaps(tx),
  }));
  const f = formatterFor(await getCurrentWorkspace());
  const rows = channelRows(accounts, channelSetup(process.env));
  const banner = channelBanner(params, rows);
  // Qué falta en el servidor: al registro una vez por proceso; a la pantalla, solo en desarrollo y plegado.
  warnMissingOnce(rows);
  // Ningún canal disponible: un solo aviso arriba, no la misma frase tres veces.
  const quiet = rows.every((r) => r.unavailable);
  const adminDetails = process.env.NODE_ENV !== "production" || (await getDbMode()) === "embedded";

  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={MESSAGES.header.title} description={MESSAGES.header.description} />
      <ModuleTabs active={CANALES} />
      <div className="flex flex-col gap-4">
        <AvisoConexion message={banner.message} notice={banner.notice} refresh={banner.refresh} />
        {quiet && <p className="text-sm text-warn">{MESSAGES.detail.allUnavailable}</p>}
        {!policy.enabled && <p className="text-sm text-fg-2">{MESSAGES.policyOff}</p>}
        <section>
          <SectionTitle>{MESSAGES.section}</SectionTitle>
          <ul className="divide-y divide-line rounded-md border border-line bg-surface">
            {rows.map((row) => (
              <ChannelRow key={row.channel} row={row} f={f} adminDetails={adminDetails} quiet={quiet} />
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
