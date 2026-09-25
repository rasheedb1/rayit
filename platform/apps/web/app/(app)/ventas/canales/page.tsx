import type { Metadata } from "next";
import type { ChannelAccountRow } from "@mc/db/queries/canales";
import { getChannelPolicyCaps, isLiveChannelStatus, listChannelAccounts } from "@mc/db/queries/canales";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Pill } from "@/components/ui/pill";
import { withWorkspace } from "@/lib/db";
import { formatterFor, type Formatter } from "@/lib/format";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { Aviso } from "../../_lib/aviso";
import { ModuleTabs } from "../_componentes/pestanas";
import { channelBanner } from "./_lib/banner";
import { channelSetup, isChannel, showAdminDetails, type Channel } from "./_lib/config";
import { CANALES } from "./_lib/conexion";
import { AccionFila, connectTarget } from "./accion-fila";
import { channelRows, pillFor, type ChannelRowView } from "./_lib/filas";
import { HEADING_FOCUS } from "./_lib/foco";
import { puedeGestionarCanales } from "./_lib/server";
import { AvisoConexion } from "./aviso-conexion";
import { ConectarBoton } from "./conectar-boton";
import { Desconectar } from "./desconectar";
import { FilaCanal } from "./fila-canal";
import { ChannelIcon } from "./iconos";
import { Limites } from "./limites";
import { MESSAGES } from "./messages";
import { UsoCuenta } from "./uso";

export const metadata: Metadata = { title: MESSAGES.meta.title };
// Lee la base y el entorno en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

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
  return quiet ? null : MESSAGES.detail.unavailable(MESSAGES.channels[row.channel].provider);
}

/** Las frases de debajo de la fila: por qué está así y qué hacer. Nunca nombres de variables ni códigos del proveedor. */
function Hints({ row, adminDetails, quiet }: { row: ChannelRowView; adminDetails: boolean; quiet: boolean }) {
  const provider = MESSAGES.channels[row.channel].provider;
  const lines: { key: string; text: string; tone: "fg" | "warn" }[] = [];
  if (row.state === "pending") {
    // Si ya volvió de la página del proveedor, no se le pide terminar algo que terminó: se espera la confirmación.
    const hint = row.channel === "email" ? MESSAGES.detail.pendingHint.email
      : row.returned ? MESSAGES.detail.pendingHint.returned(provider) : MESSAGES.detail.pendingHint.unipile(provider);
    lines.push({ key: "p", tone: "fg", text: hint });
  }
  if (row.state === "expired") lines.push({ key: "e", tone: "fg", text: row.channel === "email" ? MESSAGES.detail.expiredHint.email : MESSAGES.detail.expiredHint.unipile(provider) });
  const unavailable = unavailableText(row, quiet);
  if (unavailable) lines.push({ key: "u", tone: "warn", text: unavailable });
  // Caída y sin llaves: la frase de la caída pide reconectar con un botón deshabilitado; manda la de «no disponible».
  const reason = row.unavailable && (row.state === "needs_reconnect" || row.state === "error") ? null : row.reason;
  const showAdmin = adminDetails && row.missing.length > 0;
  if (lines.length === 0 && !reason && !showAdmin) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {reason && (
        row.state === "connected" ? <p className="text-xs text-warn">{reason}</p>
          // Cancelar no es un error: texto neutro, sin el recuadro rojo.
          : row.reasonTone === "neutral" ? <p className="text-xs text-fg-2">{reason}</p>
          : <Aviso message={reason} size="xs" />
      )}
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
  row, f, adminDetails, heading, quiet, canManage,
}: { row: ChannelRowView; f: Formatter; adminDetails: boolean; heading: { id: string; text: string } | null; quiet: boolean; canManage: boolean }) {
  const t = MESSAGES.channels[row.channel];
  const pill = pillFor(row);
  const live = row.account && isLiveChannelStatus(row.state) ? row.account : null;
  const name = live ? accountName(live) : null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          {heading && (
            // Recibe el foco al desconectar (FilaCanal): con teclado, un anillo dentro del título; tras un clic de ratón, ninguno.
            <h3 id={heading.id} tabIndex={-1} className={`text-sm font-semibold ${HEADING_FOCUS}`}>
              {heading.text}
            </h3>
          )}
          {name ? (
            <p className={`truncate ${heading ? "text-xs text-fg-3" : "text-sm font-medium"}`} title={name}>{name}</p>
          ) : (
            <p className="text-xs text-fg-3">{t.blurb}</p>
          )}
          {live && <UsoCuenta live={live} f={f} />}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Pill kind={pill.kind}>{pill.label}</Pill>
          <AccionFila row={row} canManage={canManage} />
        </div>
      </div>
      <Hints row={row} adminDetails={adminDetails} quiet={quiet} />
      {/* Límites y desconectar son de quien administra el espacio; los demás ven el uso y el tope en la línea de arriba. */}
      {live && canManage && <Manage row={row} live={live} f={f} />}
    </div>
  );
}

/**
 * La fila de un canal: el icono del servicio a la izquierda (como las
 * integraciones de Vercel y de Linear), la cuenta principal, las demás
 * cuentas vivas en sub-filas y, si ya hay una viva, «Conectar otra
 * cuenta». FilaCanal (cliente) anuncia lo que pasa con sus cuentas.
 */
function ChannelRow({
  row, f, adminDetails, quiet, canManage,
}: { row: ChannelRowView; f: Formatter; adminDetails: boolean; quiet: boolean; canManage: boolean }) {
  const channelName = MESSAGES.channels[row.channel].name;
  const another = connectTarget(row.channel, { another: true });
  return (
    <FilaCanal headingId={headingId(row.channel)}>
      <div className="flex items-start gap-3">
        <ChannelIcon channel={row.channel} />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          <AccountLine
            row={row} f={f} adminDetails={adminDetails} heading={{ id: headingId(row.channel), text: channelName }} quiet={quiet} canManage={canManage}
          />
          {row.others.length > 0 && (
            <ul className="flex flex-col gap-3 border-l border-line pl-3" aria-label={MESSAGES.detail.otherAccounts(channelName)}>
              {row.others.map((other) => (
                <li key={other.account?.id}>
                  <AccountLine row={other} f={f} adminDetails={false} heading={null} quiet={quiet} canManage={canManage} />
                </li>
              ))}
            </ul>
          )}
          {row.addAnother && canManage && (
            <div>
              {/* -ml-2.5: el texto del botón fantasma se alinea con el de la fila (su padding es px-2.5). */}
              <ConectarBoton
                action={another.action} fields={another.fields} label={MESSAGES.actions.connectAnother} variant="ghost" disabled={false} className="-ml-2.5"
              />
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
  const canManage = await puedeGestionarCanales();
  const rows = channelRows(accounts, channelSetup(process.env), { returnedFrom: isChannel(params.conectado) ? params.conectado : null });
  const banner = channelBanner(params, rows);
  // Qué falta en el servidor: al registro una vez por proceso; a la pantalla, solo en desarrollo y plegado.
  warnMissingOnce(rows);
  // Ningún canal disponible: un solo aviso arriba, no la misma frase tres veces.
  const quiet = rows.every((r) => r.unavailable);
  // Los nombres de las variables que faltan: solo en desarrollo y solo a quien gestiona los canales (nunca en una demo pública).
  const adminDetails = showAdminDetails({ canManage, nodeEnv: process.env.NODE_ENV });

  return (
    <>
      <PageHeader eyebrow={MESSAGES.header.eyebrow} title={MESSAGES.header.title} description={MESSAGES.header.description} />
      <ModuleTabs active={CANALES} />
      <div className="flex flex-col gap-4">
        <AvisoConexion {...banner} />
        {quiet && <p className="text-sm text-warn">{MESSAGES.detail.allUnavailable}</p>}
        {!canManage && <p className="text-sm text-fg-2">{MESSAGES.detail.readOnly}</p>}
        {!policy.enabled && <p className="text-sm text-fg-2">{MESSAGES.policyOff}</p>}
        <section>
          <SectionTitle>{MESSAGES.section}</SectionTitle>
          <ul className="divide-y divide-line rounded-md border border-line bg-surface">
            {rows.map((row) => (
              <ChannelRow key={row.channel} row={row} f={f} adminDetails={adminDetails} quiet={quiet} canManage={canManage} />
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
