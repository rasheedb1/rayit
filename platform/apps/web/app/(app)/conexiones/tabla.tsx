import type { OAuthApps } from "@mc/connectors";
import type { AccountRow } from "@mc/db";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { DataAsOf } from "@/components/ui/data-as-of";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import type { Formatter } from "@/lib/format";
import { actualizarCuenta, desconectarConexion } from "./actions";
import { CONSENT_POLICY_VERSION, consentText, PLATFORM_LABEL } from "./_lib/consent";
import { accesoDe, estadoDeCuenta, frescura, proveedorDe, type Acceso } from "./_lib/estado";
import { MESSAGES } from "./_lib/messages";
import { ConnectDialog } from "./connect-dialog";

const t = MESSAGES.tabla;

/** Lo que la tabla necesita saber del entorno, resuelto una vez en la página. */
export interface EntornoDeConexion {
  /** flags.oauth_connect: sin ella no se ofrece ni conectar ni reautorizar. */
  oauthConnect: boolean;
  /** loadOAuthApps(process.env): qué app está configurada y qué le falta a la que no. */
  oauth: OAuthApps;
}

export interface TablaDeCuentasProps {
  rows: AccountRow[];
  /** El reloj con el que se decide si un token ya venció. */
  ahora: Date;
  /** formatterFor(await getCurrentWorkspace()): su locale, su zona. */
  f: Formatter;
  entorno: EntornoDeConexion;
}

/** El @ de la cuenta, o su id externo si la red no dio handle. Es el nombre que se lee en voz alta. */
function nombre(r: AccountRow): string {
  return `@${r.handle ?? r.externalAccountId}`;
}

const SIN_DATO = <span className="text-xs text-muted">{t.sinDato}</span>;

function cifra(valor: number | null | undefined, f: Formatter) {
  return valor === null || valor === undefined ? SIN_DATO : f.int(valor);
}

/**
 * La pastilla de la columna Acceso. «Por @» y «Autorizada» se
 * distinguen por el texto Y por el color —el color nunca es el único
 * indicador—, y la explicación completa va en el `title` y en la
 * segunda línea, para que quien no ve el color siga sabiendo de dónde
 * salen las cifras.
 */
function AccesoPill({ acceso }: { acceso: Acceso }) {
  const tono =
    acceso.conToken
      ? "border-accent/40 bg-accent-wash text-accent"
      : "border-border bg-surface text-ink-2";
  return (
    <span
      title={acceso.explicacion}
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border py-0.5 pl-2 pr-2.5 text-[11.5px] font-medium ${tono}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {acceso.etiqueta}
    </span>
  );
}

/**
 * El botón «Reautorizar», en rojo, para una cuenta cuyo permiso caducó
 * o fue revocado. Reusa el `POST …/start` de CON-3: el callback vuelve
 * a la MISMA fila por su clave natural, así que el historial se
 * conserva. Si la app de esa red no está configurada en el entorno, el
 * botón sale deshabilitado diciendo qué falta, nunca desaparece.
 */
function Reautorizar({ row, entorno }: { row: AccountRow; entorno: EntornoDeConexion }) {
  if (!entorno.oauthConnect) return null;
  const provider = proveedorDe(row.platformId);
  if (!provider) return null;
  const red = PLATFORM_LABEL[provider];
  const configurada = entorno.oauth.apps[provider];
  const motivo = configurada ? undefined : MESSAGES.conectar.sinConfigurar(red, (entorno.oauth.missing[provider] ?? []).join(", "));
  return (
    <ConnectDialog
      label={red}
      title={MESSAGES.conectar.reautorizarTitulo(red)}
      actionLabel={MESSAGES.conectar.reautorizar}
      ariaLabel={MESSAGES.conectar.reautorizarAria(nombre(row))}
      text={MESSAGES.conectar.reautorizarTexto(red)}
      policyVersion={CONSENT_POLICY_VERSION}
      action={`/conexiones/oauth/${provider}/start`}
      disabledReason={motivo}
      variant="danger"
      size="sm"
    />
  );
}

/**
 * «Autorizar cifras» para una cuenta de TikTok agregada por @ (CON-10
 * §7): TikTok no publica seguidores ni vistas por @, y el dueño las
 * desbloquea autorizando una vez.
 */
function AutorizarCifras({ row, entorno }: { row: AccountRow; entorno: EntornoDeConexion }) {
  if (!entorno.oauthConnect || row.platformId !== "tiktok") return null;
  const motivo = entorno.oauth.apps.tiktok ? undefined : MESSAGES.conectar.sinConfigurar(PLATFORM_LABEL.tiktok, (entorno.oauth.missing.tiktok ?? []).join(", "));
  return (
    <ConnectDialog
      label={PLATFORM_LABEL.tiktok}
      actionLabel={t.autorizarCifras}
      ariaLabel={t.autorizarCifrasAria(nombre(row))}
      text={consentText("tiktok")}
      policyVersion={CONSENT_POLICY_VERSION}
      action="/conexiones/oauth/tiktok/start"
      disabledReason={motivo}
      variant="secondary"
      size="sm"
    />
  );
}

export function columnas(ahora: Date, f: Formatter, entorno: EntornoDeConexion): Column<AccountRow>[] {
  return [
    {
      key: "account",
      header: t.columnas.cuenta,
      render: (r) => (
        <span className="block min-w-0">
          <span className="block font-medium text-ink">{nombre(r)}</span>
          <span className="mt-1 block">
            <PlatformPill platformId={r.platformId} />
          </span>
          {r.displayName && <span className="mt-1 block text-xs text-muted">{r.displayName}</span>}
        </span>
      ),
    },
    {
      key: "access",
      header: t.columnas.acceso,
      render: (r) => {
        const acceso = accesoDe(r.accessMode);
        // TikTok por @ confirma la cuenta pero no entrega cifras: se dice
        // aquí, donde se pregunta de dónde salen, y no con una celda vacía.
        const sinCifras = acceso.clase === "por_arroba" && r.platformId === "tiktok";
        return (
          <span className="block min-w-0">
            <AccesoPill acceso={acceso} />
            {sinCifras && <span className="mt-1 block text-xs text-muted">{t.sinCifrasPorArroba}</span>}
          </span>
        );
      },
    },
    {
      key: "followers",
      header: t.columnas.seguidores,
      align: "num",
      render: (r) => {
        const seguidores = r.latest?.followers ?? null;
        if (seguidores === null) return SIN_DATO;
        // La variación la calcula la base (queries/conexiones.ts); aquí solo se escribe.
        const delta = r.followersDelta7d === null ? undefined : t.delta(f.delta(r.followersDelta7d));
        return <CellMain sub={delta}>{f.int(seguidores)}</CellMain>;
      },
    },
    { key: "media", header: t.columnas.publicaciones, align: "num", render: (r) => cifra(r.latest?.mediaCount, f) },
    { key: "views", header: t.columnas.vistas, align: "num", render: (r) => cifra(r.latest?.views, f) },
    {
      key: "sync",
      header: t.columnas.lectura,
      render: (r) => (
        <span className="block min-w-0">
          <span className="block text-ink">{frescura(r.hoursSinceSync)}</span>
          {r.latest && <DataAsOf date={`${r.latest.day}T00:00:00Z`} opts={{ locale: f.locale, timeZone: f.timeZone }} className="mt-0.5" />}
        </span>
      ),
    },
    {
      key: "status",
      header: t.columnas.estado,
      render: (r) => {
        const estado = estadoDeCuenta(r, ahora);
        return (
          <CellMain sub={r.statusDetail ?? undefined}>
            <Pill kind={estado.tono}>{estado.texto}</Pill>
          </CellMain>
        );
      },
    },
    {
      key: "actions",
      header: t.columnas.acciones,
      render: (r) => {
        const estado = estadoDeCuenta(r, ahora);
        const acceso = accesoDe(r.accessMode);
        return (
          <div className="flex flex-wrap gap-1">
            {estado.accion === "reautorizar" && <Reautorizar row={r} entorno={entorno} />}
            {estado.accion === "actualizar" && (
              <form action={actualizarCuenta.bind(null, r.id)}>
                <Button type="submit" size="sm" variant="secondary" aria-label={t.actualizarAria(nombre(r))}>
                  {t.actualizar}
                </Button>
              </form>
            )}
            {acceso.clase === "por_arroba" && <AutorizarCifras row={r} entorno={entorno} />}
            <form action={desconectarConexion.bind(null, r.id)}>
              <Button type="submit" size="sm" variant="ghost" aria-label={t.quitarAria(nombre(r))}>
                {t.quitar}
              </Button>
            </form>
          </div>
        );
      },
    },
  ];
}

/**
 * Una sola tabla para las dos clases de fila (CON-4): la cuenta agregada
 * por @ y la autorizada por su dueño viven juntas, porque la pregunta
 * que se hace quien mira —«¿de dónde salen estas cifras y están
 * frescas?»— es la misma para las dos.
 */
export function TablaDeCuentas({ rows, ahora, f, entorno }: TablaDeCuentasProps) {
  return (
    <DataTable
      columns={columnas(ahora, f, entorno)}
      rows={rows}
      rowKey={(r) => r.id}
      caption={t.caption}
      emptyState={<EmptyState title={t.vacio.titulo} description={t.vacio.descripcion} />}
    />
  );
}
