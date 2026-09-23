import type { Metadata } from "next";
import { getMetricRequirement, type MetricRequirement } from "@mc/db";
import { PageHeader, SectionTitle } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { flags } from "@/content/flags";
import { formatterFor, type Formatter } from "@/lib/format";
import { puede } from "@/lib/permisos";
import { requireModuleAccess } from "@/lib/permisos/modulo";
import { getCurrentWorkspace } from "@/lib/workspace/settings";
import { agregarCuenta } from "./actions";
import { getCuentasService } from "./_lib/cuentas-server";
import { OWNERSHIP_DECLARATION_ES, PUBLIC_PLATFORMS } from "./_lib/cuentas-service";
import { withWorkspace } from "./_lib/db";
import { entornoDeConexion } from "./_lib/entorno";
import { accesoDe, filaDeCuenta, type FilaDeCuenta } from "./_lib/estado";
import { MESSAGES } from "./_lib/messages";
import { OAUTH_ERROR_MESSAGES, type OAuthErrorCode } from "./_lib/oauth-handlers";
import { Conectar } from "./conectar";
import { PasosManuales } from "./pasos-manuales";
import { TablaDeCuentas } from "./tabla";

export const metadata: Metadata = { title: MESSAGES.meta.title };
// Lee la base y el entorno en cada petición: nada de esto se prerenderiza.
export const dynamic = "force-dynamic";

/** El prerrequisito que el creador cumple a mano en la app de TikTok (0011). */
const REQUISITO_ANALYTICS = "tt.insights.optin";

type Search = { agregada?: string; actualizada?: string; sin_metricas?: string; ya_hoy?: string; conectada?: string; error?: string; desconectada?: string; aviso?: string };

function Notice({ params, rows, f }: { params: Search; rows: FilaDeCuenta[]; f: Formatter }) {
  const t = MESSAGES.avisos;
  let kind: "good" | "bad" | "neutral" = "neutral";
  let text: string | null = null;
  const find = (id?: string) => rows.find((r) => r.id === id);
  const arroba = (r: FilaDeCuenta | undefined) => `@${r?.handle ?? ""}`;
  if (params.agregada) {
    const row = find(params.agregada);
    kind = "good";
    text = row
      ? row.latest
        ? t.agregadaConCifras(arroba(row), row.latest.followers === null ? MESSAGES.tabla.sinDato.toLowerCase() : f.int(row.latest.followers))
        : t.agregadaSinCifras(arroba(row), row.statusDetail ?? t.agregadaSinCifrasPorOmision)
      : t.agregada;
  } else if (params.actualizada) {
    const row = find(params.actualizada);
    kind = params.sin_metricas || params.ya_hoy ? "neutral" : "good";
    text = params.sin_metricas
      ? t.actualizadaSinMetricas(arroba(row), row?.statusDetail ?? t.actualizadaSinMetricasPorOmision)
      : params.ya_hoy
        ? t.actualizadaYaHoy(arroba(row))
        : t.actualizada(arroba(row));
  } else if (params.conectada) {
    kind = "good";
    text = t.conectada;
  } else if (params.error) {
    kind = "bad";
    text = (OAUTH_ERROR_MESSAGES as Record<string, string>)[params.error as OAuthErrorCode] ?? t.sinConectar;
  } else if (params.desconectada) {
    text = t.desconectada;
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
  // ACC-5: la página también cierra, no solo el layout: en una navegación
  // parcial Next puede no volver a ejecutar el layout del módulo. Sin
  // conexiones.cuenta.ver (PERMISO_MINIMO.conexiones), 404 antes de leer.
  await requireModuleAccess("conexiones");
  const params = await searchParams;
  // Qué botones ve este rol. Quien solo ve (Mánager, Editor, Solo
  // lectura) no ve ninguno; las acciones lo vuelven a comprobar.
  const [conectar, desconectar] = await Promise.all([puede("conexiones.cuenta.conectar"), puede("conexiones.cuenta.desconectar")]);
  const service = getCuentasService();
  // De cada cuenta, solo lo que la pantalla pinta: ni la ref del
  // secreto ni los scopes bajan al navegador (_lib/estado.ts).
  const [cuentas, ws] = await Promise.all([service.listar(), getCurrentWorkspace()]);
  const rows = cuentas.map(filaDeCuenta);
  const f = formatterFor(ws);
  const availability = service.availability();
  const options = PUBLIC_PLATFORMS.map((p) => {
    const a = availability.find((x) => x.platformId === p)!;
    return { value: p, label: a.missing.length ? MESSAGES.agregar.redSinConfigurar(a.name) : a.name };
  });

  // Del entorno solo sale un booleano y nombres de variables: el
  // client_secret no entra en el árbol de render (_lib/entorno.ts).
  const entorno = entornoDeConexion(process.env, flags.oauth_connect);
  const t = MESSAGES.cabecera;

  // El paso manual solo tiene sentido con una cuenta de TikTok autorizada:
  // sin token no hay API a la que desbloquearle la retención.
  const tiktokAutorizadas = rows.filter((r) => r.platformId === "tiktok" && accesoDe(r.accessMode).conToken);
  const requisito: MetricRequirement | null =
    tiktokAutorizadas.length > 0 ? await withWorkspace((tx) => getMetricRequirement(tx, REQUISITO_ANALYTICS)) : null;

  return (
    <>
      <PageHeader
        eyebrow={t.eyebrow}
        title={t.title}
        description={entorno.oauthConnect ? t.descripcionConOauth : t.descripcion}
      />

      <Notice params={params} rows={rows} f={f} />

      {!conectar && (
        <p role="note" className="mb-6 rounded-md border border-border bg-surface px-4 py-3 text-sm text-ink-2">
          {MESSAGES.tabla.soloLectura}
        </p>
      )}

      {conectar && (
        <section aria-labelledby="agregar" className="mb-10 rounded-md border border-border bg-surface p-5">
          <SectionTitle>
            <span id="agregar">{MESSAGES.agregar.titulo}</span>
          </SectionTitle>
          <form action={agregarCuenta} className="grid gap-4 md:grid-cols-[12rem_minmax(0,1fr)_auto] md:items-end">
            <Field label={MESSAGES.agregar.red} htmlFor="red" required>
              <Select id="red" name="red" options={options} defaultValue="instagram" required />
            </Field>
            <Field label={MESSAGES.agregar.handle} htmlFor="handle" help={MESSAGES.agregar.handleAyuda} required>
              <Input id="handle" name="handle" placeholder={MESSAGES.agregar.handlePlaceholder} autoComplete="off" required maxLength={120} />
            </Field>
            <Button type="submit" variant="primary">
              {MESSAGES.agregar.enviar}
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
                {a.missing.length > 0 && <span className="block text-muted">{MESSAGES.agregar.sinConfigurar(a.missing.join(", "))}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {conectar && entorno.oauthConnect && <Conectar entorno={entorno} />}

      <section aria-labelledby="cuentas">
        <SectionTitle meta={MESSAGES.tabla.cuenta(rows.length)}>
          <span id="cuentas">{MESSAGES.tabla.titulo}</span>
        </SectionTitle>
        <TablaDeCuentas rows={rows} ahora={new Date()} f={f} entorno={entorno} permisos={{ conectar, desconectar }} />
        {rows.length > 0 && <p className="mt-3 text-xs text-muted">{MESSAGES.tabla.huecosCadaManana}</p>}
      </section>

      <PasosManuales requisito={requisito} cuentas={tiktokAutorizadas.map((r) => `@${r.handle ?? r.externalAccountId}`)} />
    </>
  );
}
