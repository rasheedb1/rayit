import type { Metadata } from "next";
import { loadOAuthApps, type OAuthProviderId } from "@mc/connectors";
import { listConnections, type ConnectionListRow, type ConnectionStatus } from "@mc/db";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { DataAsOf } from "@/components/ui/data-as-of";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill, type PillKind } from "@/components/ui/pill";
import { formatDate } from "@/lib/format";
import { desconectarConexion } from "./actions";
import { CONSENT_POLICY_VERSION, consentText, PLATFORM_LABEL } from "./_lib/consent";
import { withWorkspace } from "./_lib/db";
import { OAUTH_ERROR_MESSAGES, type OAuthErrorCode } from "./_lib/oauth-handlers";
import { ConnectDialog } from "./connect-dialog";

export const metadata: Metadata = { title: "Conexiones" };
// Lee la base y el entorno en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

const PLATFORM_NAME: Record<ConnectionListRow["platformId"], string> = { tiktok: "TikTok", instagram: "Instagram", facebook: "Facebook", youtube: "YouTube" };

/** Sin CON-4 no hay horas en rojo ni reautorizar: solo el estado, con su texto. */
const STATUS_PILL: Record<ConnectionStatus, { kind: PillKind; text: string }> = {
  active: { kind: "good", text: "Activa" },
  needs_reauth: { kind: "bad", text: "Necesita reautorizar" },
  expired: { kind: "bad", text: "Vencida" },
  revoked: { kind: "bad", text: "Revocada" },
  error: { kind: "warn", text: "Con errores" },
  disabled: { kind: "neutral", text: "Desconectada" },
};

const COLUMNS: Column<ConnectionListRow>[] = [
  {
    key: "platform",
    header: "Red",
    render: (r) => <CellMain sub={r.handle ? `@${r.handle}` : r.externalAccountId}>{r.displayName ?? PLATFORM_NAME[r.platformId]}</CellMain>,
  },
  { key: "network", header: "Plataforma", render: (r) => PLATFORM_NAME[r.platformId] },
  {
    key: "status",
    header: "Estado",
    render: (r) => {
      const p = STATUS_PILL[r.status];
      return (
        <CellMain sub={r.statusDetail ?? undefined}>
          <Pill kind={p.kind}>{p.text}</Pill>
        </CellMain>
      );
    },
  },
  { key: "connectedAt", header: "Conectada el", render: (r) => formatDate(r.connectedAt) },
  {
    key: "dataAsOf",
    header: "Datos",
    render: (r) => (r.lastSyncedAt ? <DataAsOf date={r.lastSyncedAt} source={PLATFORM_NAME[r.platformId]} /> : <span className="text-xs text-muted">Sin sincronizar todavía</span>),
  },
  {
    key: "scopes",
    header: "Permisos",
    render: (r) => (r.scopes.length ? <span className="text-xs text-ink-2 [overflow-wrap:anywhere]">{r.scopes.join(", ")}</span> : <span className="text-xs text-muted">Sin permisos registrados</span>),
  },
  {
    key: "action",
    header: "Acción",
    render: (r) => (
      <form action={desconectarConexion.bind(null, r.id)}>
        <Button type="submit" size="sm" variant="ghost" aria-label={`Desconectar ${PLATFORM_NAME[r.platformId]}${r.handle ? ` @${r.handle}` : ""}`}>
          Desconectar
        </Button>
      </form>
    ),
  },
];

type Search = { conectada?: string; error?: string; desconectada?: string; aviso?: string };

function Notice({ params, rows }: { params: Search; rows: ConnectionListRow[] }) {
  let kind: "good" | "bad" | "neutral" = "neutral";
  let text: string | null = null;
  if (params.conectada) {
    const row = rows.find((r) => r.id === params.conectada);
    kind = "good";
    text = row ? `Cuenta de ${PLATFORM_NAME[row.platformId]}${row.handle ? ` (@${row.handle})` : ""} conectada. La primera sincronización llega con el recolector.` : "Cuenta conectada.";
  } else if (params.error) {
    kind = "bad";
    text = (OAUTH_ERROR_MESSAGES as Record<string, string>)[params.error as OAuthErrorCode] ?? "No se pudo conectar la cuenta.";
  } else if (params.desconectada) {
    text = "Cuenta desconectada. Sus datos históricos se conservan; el acceso quedó revocado.";
  } else if (params.aviso) {
    kind = "bad";
    text = params.aviso.slice(0, 200);
  }
  if (!text) return null;
  const tone = kind === "good" ? "border-good bg-good-wash text-good" : kind === "bad" ? "border-bad bg-bad-wash text-bad" : "border-border bg-surface text-ink-2";
  return (
    <p role="status" className={`mb-6 rounded-md border px-4 py-3 text-sm ${tone}`}>
      {text}
    </p>
  );
}

export default async function ConexionesPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const rows = await withWorkspace((tx) => listConnections(tx));
  const { apps, missing } = loadOAuthApps(process.env);

  const disabledReason = (p: OAuthProviderId) => (apps[p] ? undefined : `${PLATFORM_LABEL[p]} no está configurado en este entorno: faltan ${(missing[p] ?? []).join(", ")}.`);
  const dialog = (p: OAuthProviderId, variant: "primary" | "secondary") => (
    <ConnectDialog key={p} label={PLATFORM_LABEL[p]} text={consentText(p)} policyVersion={CONSENT_POLICY_VERSION} action={`/conexiones/oauth/${p}/start`} disabledReason={disabledReason(p)} variant={variant} />
  );
  // «Activar analítica avanzada» (Accounts API) solo si la app existe y ya hay una cuenta de TikTok conectada.
  const showBusiness = !!apps["tiktok-business"] && rows.some((r) => r.platformId === "tiktok" && r.status === "active" && !r.secretRef.startsWith("enc:tiktok-business:"));

  return (
    <>
      <PageHeader
        eyebrow="Conexiones"
        title="Las cuentas que alimentan todo lo demás"
        description="Conecta TikTok e Instagram para que On Cue lea tus publicaciones y sus métricas. El acceso se guarda cifrado y se renueva solo; puedes revocarlo cuando quieras."
        aside={
          <div className="flex flex-wrap gap-2">
            {dialog("tiktok", "primary")}
            {dialog("instagram", "secondary")}
          </div>
        }
      />

      <Notice params={params} rows={rows} />

      <section aria-labelledby="cuentas">
        <SectionTitle meta={`${rows.length} ${rows.length === 1 ? "cuenta" : "cuentas"}`}>
          <span id="cuentas">Cuentas conectadas</span>
        </SectionTitle>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          caption="Cuentas sociales conectadas al workspace, con su estado y hasta qué fecha hay datos"
          emptyState={
            <EmptyState
              title="Todavía no hay cuentas conectadas"
              description="Conecta TikTok o Instagram con los botones de arriba. Te pediremos autorizar en la plataforma y guardaremos el acceso cifrado."
            />
          }
        />
      </section>

      {showBusiness && (
        <section className="mt-10" aria-labelledby="avanzada">
          <SectionTitle>
            <span id="avanzada">Analítica avanzada de TikTok</span>
          </SectionTitle>
          <p className="mb-3 max-w-2xl text-sm text-ink-2">
            La Accounts API de TikTok entrega alcance, retención segundo a segundo y demografía por video. Es una segunda autorización sobre la misma cuenta.
          </p>
          {dialog("tiktok-business", "secondary")}
        </section>
      )}

      {rows.length > 0 && (
        <p className="mt-6 text-xs text-muted">
          Los estados vienen de la vista connection_health. El detalle de sincronización y la reautorización llegan con la pantalla completa (CON-4).{" "}
          <Button variant="ghost" size="sm" href="/finanzas">
            Ir a Finanzas
          </Button>
        </p>
      )}
    </>
  );
}
