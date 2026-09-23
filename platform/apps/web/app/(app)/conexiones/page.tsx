import type { Metadata } from "next";
import { loadOAuthApps } from "@mc/connectors";
import type { AccountRow, ConnectionStatus } from "@mc/db";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { DataAsOf } from "@/components/ui/data-as-of";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { Pill, type PillKind } from "@/components/ui/pill";
import { flags } from "@/content/flags";
import { formatDelta, formatInt } from "@/lib/format";
import { actualizarCuenta, agregarCuenta, desconectarConexion } from "./actions";
import { CONSENT_POLICY_VERSION, consentText } from "./_lib/consent";
import { getCuentasService } from "./_lib/cuentas-server";
import { OWNERSHIP_DECLARATION_ES, PLATFORM_NAME, PUBLIC_PLATFORMS } from "./_lib/cuentas-service";
import { OAUTH_ERROR_MESSAGES, type OAuthErrorCode } from "./_lib/oauth-handlers";
import { ConnectDialog } from "./connect-dialog";

export const metadata: Metadata = { title: "Cuentas" };
// Lee la base y el entorno en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

const STATUS_PILL: Record<ConnectionStatus, { kind: PillKind; text: string }> = {
  active: { kind: "good", text: "Activa" },
  needs_reauth: { kind: "bad", text: "Necesita reautorizar" },
  expired: { kind: "bad", text: "Vencida" },
  revoked: { kind: "bad", text: "Revocada" },
  error: { kind: "bad", text: "No se pudo leer" },
  disabled: { kind: "neutral", text: "Quitada" },
};

const SIN_DATO = <span className="text-xs text-muted">Sin dato</span>;

const COLUMNS: Column<AccountRow>[] = [
  {
    key: "account",
    header: "Cuenta",
    render: (r) => <CellMain sub={r.displayName ?? undefined}>{`@${r.handle ?? r.externalAccountId}`}</CellMain>,
  },
  { key: "network", header: "Red", render: (r) => PLATFORM_NAME[r.platformId] },
  {
    key: "followers",
    header: "Seguidores",
    align: "num",
    render: (r) => {
      const f = r.latest?.followers ?? null;
      if (f === null) return SIN_DATO;
      const prev = r.followersWeekAgo;
      const delta = prev !== null && prev > 0 ? formatDelta((f - prev) / prev) + " en 7 días" : undefined;
      return <CellMain sub={delta}>{formatInt(f)}</CellMain>;
    },
  },
  {
    key: "media",
    header: "Publicaciones",
    align: "num",
    render: (r) => (r.latest?.mediaCount === null || r.latest?.mediaCount === undefined ? SIN_DATO : formatInt(r.latest.mediaCount)),
  },
  {
    key: "views",
    header: "Vistas",
    align: "num",
    render: (r) => (r.latest?.views === null || r.latest?.views === undefined ? SIN_DATO : formatInt(r.latest.views)),
  },
  {
    key: "source",
    header: "Cifras",
    render: (r) => {
      if (r.accessMode === "direct_oauth") return <span className="text-xs text-ink-2">Autorizada por el dueño</span>;
      // TikTok primero: autorizar es gratis y da más que el proveedor de
      // pago, así que la oferta sigue en pie aunque las cifras ya lleguen.
      if (r.platformId === "tiktok") return <TikTokAuthorize row={r} />;
      if (r.accessMode === "aggregator") return <span className="text-xs text-ink-2">Por proveedor de datos</span>;
      return <span className="text-xs text-ink-2">Públicas por @</span>;
    },
  },
  {
    key: "dataAsOf",
    header: "Datos",
    render: (r) => (r.latest ? <DataAsOf date={`${r.latest.day}T00:00:00Z`} source={PLATFORM_NAME[r.platformId]} /> : <span className="text-xs text-muted">Sin lectura todavía</span>),
  },
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
  {
    key: "actions",
    header: "Acciones",
    render: (r) => (
      <div className="flex flex-wrap gap-1">
        {(r.accessMode === "public_profile" || r.accessMode === "aggregator" || r.accessMode === "direct_oauth") && (
          <form action={actualizarCuenta.bind(null, r.id)}>
            <Button type="submit" size="sm" variant="secondary" aria-label={`Actualizar @${r.handle ?? r.externalAccountId}`}>
              Actualizar
            </Button>
          </form>
        )}
        <form action={desconectarConexion.bind(null, r.id)}>
          <Button type="submit" size="sm" variant="ghost" aria-label={`Quitar @${r.handle ?? r.externalAccountId}`}>
            Quitar
          </Button>
        </form>
      </div>
    ),
  },
];

type Search = { agregada?: string; actualizada?: string; sin_metricas?: string; ya_hoy?: string; conectada?: string; error?: string; desconectada?: string; aviso?: string };

function Notice({ params, rows }: { params: Search; rows: AccountRow[] }) {
  let kind: "good" | "bad" | "neutral" = "neutral";
  let text: string | null = null;
  const find = (id?: string) => rows.find((r) => r.id === id);
  if (params.agregada) {
    const row = find(params.agregada);
    kind = "good";
    text = row
      ? row.latest
        ? `@${row.handle} agregada. Seguidores hoy: ${row.latest.followers === null ? "sin dato" : formatInt(row.latest.followers)}. Desde mañana se lee cada día.`
        : `@${row.handle} agregada. ${row.statusDetail ?? "Todavía no hay métricas públicas para esta red."}`
      : "Cuenta agregada.";
  } else if (params.actualizada) {
    const row = find(params.actualizada);
    kind = params.sin_metricas || params.ya_hoy ? "neutral" : "good";
    text = params.sin_metricas
      ? `@${row?.handle ?? ""}: ${row?.statusDetail ?? "esta red no publica métricas por @."}`
      : params.ya_hoy
        ? `@${row?.handle ?? ""}: la lectura de hoy ya está guardada; mañana se vuelve a leer.`
        : `@${row?.handle ?? ""} actualizada con los datos de hoy.`;
  } else if (params.conectada) {
    kind = "good";
    text = "Cuenta conectada.";
  } else if (params.error) {
    kind = "bad";
    text = (OAUTH_ERROR_MESSAGES as Record<string, string>)[params.error as OAuthErrorCode] ?? "No se pudo conectar la cuenta.";
  } else if (params.desconectada) {
    text = "Cuenta quitada. Su historial se conserva; ya no se leerá.";
  } else if (params.aviso) {
    kind = "bad";
    text = params.aviso.slice(0, 240);
  }
  if (!text) return null;
  const tone = kind === "good" ? "border-good bg-good-wash text-good" : kind === "bad" ? "border-bad bg-bad-wash text-bad" : "border-border bg-surface text-ink-2";
  return (
    <p role="status" className={`mb-6 rounded-md border px-4 py-3 text-sm ${tone}`}>
      {text}
    </p>
  );
}

export default async function CuentasPage({ searchParams }: { searchParams: Promise<Search> }) {
  const params = await searchParams;
  const service = getCuentasService();
  const rows = await service.listar();
  const availability = service.availability();
  const options = PUBLIC_PLATFORMS.map((p) => {
    const a = availability.find((x) => x.platformId === p)!;
    return { value: p, label: a.missing.length ? `${a.name} (sin configurar)` : a.name };
  });

  return (
    <>
      <PageHeader
        eyebrow="Cuentas"
        title="Las cuentas que alimentan todo lo demás"
        description="Agrega una cuenta con su @ y On Cue leerá cada día lo que la plataforma publica de ella: seguidores, publicaciones y vistas. Sin contraseñas ni autorizaciones."
      />

      <Notice params={params} rows={rows} />

      <section aria-labelledby="agregar" className="mb-10 rounded-md border border-border bg-surface p-5">
        <SectionTitle>
          <span id="agregar">Agregar cuenta</span>
        </SectionTitle>
        <form action={agregarCuenta} className="grid gap-4 md:grid-cols-[12rem_minmax(0,1fr)_auto] md:items-end">
          <Field label="Red" htmlFor="red" required>
            <Select id="red" name="red" options={options} defaultValue="instagram" required />
          </Field>
          <Field label="Usuario o enlace del perfil" htmlFor="handle" help="Por ejemplo @nicolasduartea o https://www.tiktok.com/@selvathegolden" required>
            <Input id="handle" name="handle" placeholder="@usuario" autoComplete="off" required maxLength={120} />
          </Field>
          <Button type="submit" variant="primary">
            Agregar cuenta
          </Button>
          <label className="flex items-start gap-2 text-sm md:col-span-3">
            <input type="checkbox" name="declaro" required className="mt-1 h-4 w-4 accent-[var(--accent)]" />
            <span>{OWNERSHIP_DECLARATION_ES}</span>
          </label>
        </form>
        <ul className="mt-4 grid gap-2 text-xs text-ink-2 md:grid-cols-3">
          {availability.map((a) => (
            <li key={a.platformId} className="rounded-md border border-border px-3 py-2">
              <span className="font-medium text-ink">{a.name}</span>
              <span className="block">{a.offersEs}</span>
              {a.missing.length > 0 && <span className="block text-muted">Sin configurar en este entorno: falta {a.missing.join(", ")}.</span>}
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="cuentas">
        <SectionTitle meta={`${rows.length} ${rows.length === 1 ? "cuenta" : "cuentas"}`}>
          <span id="cuentas">Cuentas</span>
        </SectionTitle>
        <DataTable
          columns={COLUMNS}
          rows={rows}
          rowKey={(r) => r.id}
          caption="Cuentas del workspace con su última lectura pública y su estado"
          emptyState={<EmptyState title="Todavía no hay cuentas" description="Agrega la primera con su @ en el formulario de arriba. Desde ese momento guardamos su historial diario." />}
        />
      </section>

    </>
  );
}

/**
 * TikTok no publica cifras por @: el dueño las desbloquea autorizando una
 * vez (CON-3, detrás de la bandera oauth_connect). El botón abre el
 * diálogo de consentimiento; el callback convierte esta misma fila.
 *
 * Con el proveedor de pago contratado (CON-12) las cifras ya llegan, pero
 * la oferta se mantiene: autorizar es gratis, trae más datos y deja de
 * gastar unidades.
 */
function TikTokAuthorize({ row }: { row: AccountRow }) {
  const origen =
    row.accessMode === "aggregator" ? <span className="text-xs text-ink-2">Por proveedor de datos</span> : <span className="text-xs text-muted">Sin cifras por @</span>;
  if (!flags.oauth_connect) return origen;
  const { apps, missing } = loadOAuthApps(process.env);
  const reason = apps.tiktok ? undefined : `TikTok no está configurado en este entorno: faltan ${(missing.tiktok ?? []).join(", ")}.`;
  return (
    <div className="flex flex-col gap-1">
      {origen}
      <ConnectDialog label="TikTok" actionLabel="Autorizar cifras" text={consentText("tiktok")} policyVersion={CONSENT_POLICY_VERSION} action="/conexiones/oauth/tiktok/start" disabledReason={reason} variant="secondary" size="sm" ariaLabel={`Autorizar cifras de @${row.handle ?? row.externalAccountId}`} />
    </div>
  );
}
