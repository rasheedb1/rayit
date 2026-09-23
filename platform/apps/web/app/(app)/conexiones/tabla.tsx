import type { OAuthProviderId } from "@mc/connectors";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { DataAsOf } from "@/components/ui/data-as-of";
import { EmptyState } from "@/components/ui/empty-state";
import { Pill } from "@/components/ui/pill";
import { PlatformPill } from "@/components/ui/platform-pill";
import type { Formatter } from "@/lib/format";
import { actualizarCuenta, desconectarConexion } from "./actions";
import { CONSENT_POLICY_VERSION, consentText, PLATFORM_LABEL } from "./_lib/consent";
import { appDeRed, type EntornoDeConexion } from "./_lib/entorno";
import { accesoDe, estadoDeCuenta, frescura, huecosDeCuenta, proveedorDe, type Acceso, type FilaDeCuenta } from "./_lib/estado";
import { MESSAGES } from "./_lib/messages";
import { ConnectDialog } from "./connect-dialog";

const t = MESSAGES.tabla;

export interface TablaDeCuentasProps {
  rows: FilaDeCuenta[];
  /** El reloj con el que se decide si un token ya venció. */
  ahora: Date;
  /** formatterFor(await getCurrentWorkspace()): su locale, su zona. */
  f: Formatter;
  entorno: EntornoDeConexion;
  /**
   * Lo que el rol de la sesión puede hacer con una fila (ACC-1/ACC-5).
   * Quien solo ve (conexiones.cuenta.ver) no ve ningún botón: ni
   * «Actualizar» ni «Reautorizar» ni «Quitar». La Server Action y la
   * transacción lo comprueban otra vez; esto es no enseñar una puerta
   * que no abre.
   */
  permisos: PermisosDeFila;
}

export interface PermisosDeFila {
  /** conexiones.cuenta.conectar: Actualizar, Reautorizar y Autorizar cifras. */
  conectar: boolean;
  /** conexiones.cuenta.desconectar: Quitar. */
  desconectar: boolean;
}

/** El @ de la cuenta, o su id externo si la red no dio handle. Es el nombre que se lee en voz alta. */
function nombre(r: FilaDeCuenta): string {
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
function Reautorizar({ row, provider, urgente = true }: { row: FilaDeCuenta; provider: OAuthProviderId; urgente?: boolean }) {
  const red = PLATFORM_LABEL[provider];
  return (
    <ConnectDialog
      label={red}
      title={MESSAGES.conectar.reautorizarTitulo(red)}
      actionLabel={MESSAGES.conectar.reautorizar}
      ariaLabel={MESSAGES.conectar.reautorizarAria(nombre(row))}
      text={MESSAGES.conectar.reautorizarTexto(red)}
      policyVersion={CONSENT_POLICY_VERSION}
      action={`/conexiones/oauth/${provider}/start`}
      variant={urgente ? "danger" : "secondary"}
      size="sm"
    />
  );
}

/**
 * «Autorizar cifras» para una cuenta de TikTok agregada por @ (CON-10
 * §7): TikTok no publica seguidores ni vistas por @, y el dueño las
 * desbloquea autorizando una vez.
 */
function AutorizarCifras({ row, entorno }: { row: FilaDeCuenta; entorno: EntornoDeConexion }) {
  // Sin la app configurada no hay nada que autorizar. La fila ya dice
  // «Sin cifras por @»; qué variable falta se ve en la sección de
  // conectar, que es donde mira quien despliega.
  if (!entorno.oauthConnect || row.platformId !== "tiktok" || !appDeRed(entorno, "tiktok").configurada) return null;
  return (
    <ConnectDialog
      label={PLATFORM_LABEL.tiktok}
      actionLabel={t.autorizarCifras}
      ariaLabel={t.autorizarCifrasAria(nombre(row))}
      text={consentText("tiktok")}
      policyVersion={CONSENT_POLICY_VERSION}
      action="/conexiones/oauth/tiktok/start"
      variant="secondary"
      size="sm"
    />
  );
}

/**
 * Debajo del estado: la nota del estado (se renueva sola), el detalle
 * que dejó la última lectura y, por cada grupo de cifras que falta, qué
 * es, por qué (el message_es de la base) y desde cuándo (CON-7).
 */
function DetalleDeEstado({ r, nota, f }: { r: FilaDeCuenta; nota: string | null; f: Formatter }) {
  const huecos = huecosDeCuenta(r);
  if (!nota && !r.statusDetail && huecos.length === 0) return null;
  return (
    <span className="mt-1 block max-w-[20rem] space-y-1 text-xs text-ink-2">
      {nota && <span className="block">{nota}</span>}
      {r.statusDetail && <span className="block">{r.statusDetail}</span>}
      {huecos.map((h) => (
        <span key={h.grupo} className="block">
          <span className="font-medium text-ink">{h.que}</span> <span className="text-muted">{t.faltaDesde(f.date(h.desde))}.</span> {h.porQue}
          {h.arreglo && (
            <>
              {" "}
              <a href={h.arreglo} target="_blank" rel="noreferrer noopener" className="text-accent underline underline-offset-2">
                {t.comoArreglarlo}
              </a>
            </>
          )}
        </span>
      ))}
    </span>
  );
}

export function columnas(ahora: Date, f: Formatter, entorno: EntornoDeConexion, permisos: PermisosDeFila): Column<FilaDeCuenta>[] {
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
          {/* ACC-8: solo si la conectó un tercero. Cuando la conectó el
              titular no se dice nada: la ausencia es la información. */}
          {r.conectadaPor && (
            <span className="mt-1 block text-xs text-muted">{t.conectadaPor({ who: r.conectadaPor.quien, when: f.date(r.conectadaPor.en) })}</span>
          )}
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
    {
      key: "media",
      header: t.columnas.publicaciones,
      align: "num",
      // Dos cifras distintas y a propósito: lo que la red dice que tiene
      // la cuenta, y de cuántas publicaciones tenemos lecturas (CON-5).
      render: (r) => {
        const seguidas = r.postsCount > 0 ? t.enSeguimiento(f.int(r.postsCount)) : undefined;
        return <CellMain sub={seguidas}>{cifra(r.latest?.mediaCount, f)}</CellMain>;
      },
    },
    { key: "views", header: t.columnas.vistas, align: "num", render: (r) => cifra(r.latest?.views, f) },
    {
      key: "sync",
      header: t.columnas.lectura,
      render: (r) => (
        <span className="block min-w-0">
          <span className="block text-ink">{frescura(r.hoursSinceSync)}</span>
          {/* `latest.day` es una columna `date` ('YYYY-MM-DD'). Se pasa TAL
              CUAL: formatDate presenta en UTC las fechas sin hora, y
              convertirla a un instante la correría un día hacia atrás en
              cualquier workspace al oeste de Greenwich (con Bogotá, un
              snapshot del 21 se leía «20 sep»). */}
          {r.latest ? (
            <DataAsOf date={r.latest.day} opts={{ locale: f.locale, timeZone: f.timeZone }} className="mt-0.5" />
          ) : (
            r.lastPostSnapshotAt && <span className="mt-0.5 block text-xs text-muted">{t.sinCifrasDeCuenta}</span>
          )}
          {/* La fecha de las publicaciones va aparte y con su nombre: las
              cifras de la fila son de la serie de CUENTA, y enseñar aquí
              la del contenido haría parecer al día unos seguidores de
              hace una semana (CON-5). */}
          {r.lastPostSnapshotAt && (
            <span className="block text-xs text-muted">
              {t.publicacionesHasta} <time dateTime={r.lastPostSnapshotAt}>{f.date(r.lastPostSnapshotAt)}</time>
            </span>
          )}
        </span>
      ),
    },
    {
      key: "status",
      header: t.columnas.estado,
      render: (r) => {
        const estado = estadoDeCuenta(r, ahora);
        return (
          <span className="block min-w-0">
            <Pill kind={estado.tono}>{estado.texto}</Pill>
            <DetalleDeEstado r={r} nota={estado.nota} f={f} />
          </span>
        );
      },
    },
    {
      key: "actions",
      header: t.columnas.acciones,
      render: (r) => {
        const estado = estadoDeCuenta(r, ahora);
        const acceso = accesoDe(r.accessMode);
        // Reautorizar solo se ofrece si de verdad se puede: con la
        // bandera encendida, en una red que tiene app de OAuth (YouTube
        // y Facebook todavía no, CON-8) y con esa app configurada en
        // este entorno. Si no, la fila no se queda sin salida: dice qué
        // hacer. Un botón deshabilitado con el nombre de una variable
        // de servidor le sirve a quien despliega, no a quien mira.
        const posible = entorno.oauthConnect ? proveedorDe(r.platformId, r.accessMode) : null;
        const provider = posible && appDeRed(entorno, posible).configurada ? posible : null;
        if (!permisos.conectar && !permisos.desconectar) return <span className="text-xs text-muted">{t.sinAcciones}</span>;
        return (
          <div className="flex flex-wrap items-center gap-1">
            {permisos.conectar && estado.accion === "reautorizar" &&
              (provider ? (
                <Reautorizar row={r} provider={provider} />
              ) : (
                <span className="max-w-[16rem] text-xs text-ink-2">{t.sinReautorizar}</span>
              ))}
            {permisos.conectar && estado.accion === "reautorizar_opcional" && provider && <Reautorizar row={r} provider={provider} urgente={false} />}
            {permisos.conectar && estado.accion === "actualizar" && (
              <form action={actualizarCuenta.bind(null, r.id)}>
                <Button type="submit" size="sm" variant="secondary" aria-label={t.actualizarAria(nombre(r))}>
                  {t.actualizar}
                </Button>
              </form>
            )}
            {permisos.conectar && acceso.clase === "por_arroba" && <AutorizarCifras row={r} entorno={entorno} />}
            {permisos.desconectar && (
              <form action={desconectarConexion.bind(null, r.id)}>
                <Button type="submit" size="sm" variant="ghost" aria-label={t.quitarAria(nombre(r))}>
                  {t.quitar}
                </Button>
              </form>
            )}
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
export function TablaDeCuentas({ rows, ahora, f, entorno, permisos }: TablaDeCuentasProps) {
  return (
    <DataTable
      columns={columnas(ahora, f, entorno, permisos)}
      rows={rows}
      rowKey={(r) => r.id}
      caption={t.caption}
      emptyState={<EmptyState title={t.vacio.titulo} description={t.vacio.descripcion} />}
    />
  );
}
