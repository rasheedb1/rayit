"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
// Solo tipos de @mc/db/queries/resumen: sus valores arrastrarían el
// cliente de Postgres al navegador. Las redes salen del módulo sin
// dependencias.
import type { ImportableAccount } from "@mc/db/queries/resumen";
import { PLATFORMS, type PlatformId } from "@mc/db/queries/resumen-constantes";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";
import { Segmented } from "@/components/ui/segmented";
import { formatterFor, type FormatSettings, type Formatter } from "@/lib/format";
import { MESSAGES } from "../messages";
import { buscarPostsConocidos, importarCsv } from "./actions";
import {
  aFechaIso,
  analizar,
  analizarFechas,
  celdasDeFecha,
  ErrorCsv,
  esFechaNumerica,
  faltantesDelMapeo,
  MAX_BYTES,
  ordenPorLocale,
  revisar,
  type AnalisisFechas,
  type FilaRevisada,
  type OrdenFecha,
  type Problema,
  type Revision,
  type Tabla,
} from "./_lib/csv";
import { DEF_CAMPOS, FORMATOS, type Campo, type FormatoId, type Mapeo } from "./_lib/formatos";

/**
 * Los cuatro pasos de la importación: subir → formato → revisar →
 * importar, como en Flatfile o OneSchema.
 *
 * El archivo NO sube a ningún sitio hasta el último paso: se lee y se
 * valida en el navegador, y solo al pulsar «Importar» viaja su texto a
 * la server action, que vuelve a validarlo. Quien se arrepiente en el
 * paso 3 no dejó nada escrito en ninguna parte.
 */

type Paso = 0 | 1 | 2 | 3;

const NUEVA = "__nueva__";
const MEGAS = (MAX_BYTES / 1024 / 1024).toString();

export interface AsistenteProps {
  cuentas: ImportableAccount[];
  workspace: FormatSettings;
}

/** El texto de un problema de fila, con el nombre del campo en el idioma de la pantalla. */
function textoDe(p: Problema): string {
  const campo = p.campo ? MESSAGES.importar.campos[p.campo].label : undefined;
  return MESSAGES.importar.validacion[p.codigo]({ valor: p.valor, campo });
}

/** El texto de un archivo que no se puede ni empezar a revisar. */
function textoDeArchivo(err: ErrorCsv, f: Formatter): string {
  const d = err.datos;
  return MESSAGES.importar.errorArchivo[err.codigo](f.int(d.filas ?? 0), f.int(d.max ?? 0));
}

export function Asistente({ cuentas, workspace }: AsistenteProps) {
  const t = MESSAGES.importar;
  const f = useMemo(() => formatterFor(workspace), [workspace]);
  const router = useRouter();
  const [enviando, empezar] = useTransition();

  const [paso, setPaso] = useState<Paso>(0);
  const [nombreArchivo, setNombreArchivo] = useState("");
  const [texto, setTexto] = useState("");
  const [tabla, setTabla] = useState<Tabla | null>(null);
  const [mapeo, setMapeo] = useState<Mapeo>({});
  const [red, setRed] = useState<PlatformId>("instagram");
  const [cuenta, setCuenta] = useState<string>(NUEVA);
  const [handleNuevo, setHandleNuevo] = useState("");
  const [formato, setFormato] = useState<FormatoId | null>(null);
  /** El orden de fechas que eligió la persona. null = el que propone el locale. */
  const [ordenElegido, setOrdenElegido] = useState<OrdenFecha | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<{ videos: number; nuevos: number; conocidos: number; lecturas: number } | null>(null);
  /** Ids que la cuenta de destino ya tiene. null = todavía no se ha preguntado. */
  const [yaConocidos, setYaConocidos] = useState<readonly string[] | null>(null);

  const deLaRed = cuentas.filter((c) => c.platformId === red);
  const faltan = faltantesDelMapeo(mapeo);

  // El orden día/mes se decide para el ARCHIVO entero, mirando la
  // columna de fechas antes de leer ninguna: si alguna fecha lo
  // demuestra, manda el archivo; si todas sirven en los dos órdenes, la
  // persona elige, con el orden de su workspace como propuesta.
  const fechas: AnalisisFechas | null = useMemo(
    () => (tabla ? analizarFechas(celdasDeFecha(tabla, mapeo)) : null),
    [tabla, mapeo],
  );
  const ordenFechas: OrdenFecha = fechas?.orden ?? ordenElegido ?? ordenPorLocale(workspace.locale);

  const opciones = useMemo(
    () => ({ timeZone: workspace.timezone, locale: workspace.locale, ordenFechas }),
    [workspace.timezone, workspace.locale, ordenFechas],
  );

  // Dos pasadas a propósito: la primera saca los ids del archivo, que es
  // lo que hay que preguntarle a la base; la segunda vuelve a revisar
  // con la respuesta. `revisar` es pura y barata, y así el paso 3 puede
  // avisar «este video ya está» ANTES de escribir nada.
  const revisionBase: Revision | null = useMemo(
    () => (tabla && faltan.length === 0 ? revisar(tabla, mapeo, opciones) : null),
    // `faltan` se recalcula con `mapeo`, así que no hace falta en las dependencias.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabla, mapeo, opciones],
  );

  useEffect(() => {
    setYaConocidos(null);
    const ids = revisionBase?.listas.map((l) => l.externalPostId) ?? [];
    // Una cuenta que todavía no existe no puede tener nada repetido.
    if (cuenta === NUEVA || ids.length === 0) return;
    let vivo = true;
    void buscarPostsConocidos({ connectionId: cuenta, ids }).then(
      (r) => {
        if (vivo && r.ok && r.ids.length > 0) setYaConocidos(r.ids);
      },
      // Si la consulta falla, la previsualización sigue valiendo: solo
      // se queda sin el aviso. No es motivo para no dejar importar.
      () => undefined,
    );
    return () => {
      vivo = false;
    };
  }, [cuenta, revisionBase]);

  const conocidos = useMemo(() => (yaConocidos ? new Set(yaConocidos) : null), [yaConocidos]);

  const revision: Revision | null = useMemo(
    () => (tabla && revisionBase && conocidos ? revisar(tabla, mapeo, { ...opciones, yaConocidos: conocidos }) : revisionBase),
    [tabla, mapeo, opciones, revisionBase, conocidos],
  );

  /** De las filas que se van a escribir, cuántas ya estaban en la cuenta. */
  const yaEstaban = useMemo(
    () => (conocidos && revision ? revision.listas.filter((l) => conocidos.has(l.externalPostId)).length : 0),
    [conocidos, revision],
  );

  function recibir(archivo: File) {
    setError(null);
    // El techo se comprueba ANTES de leer: un archivo que no cabe en el
    // envío no tiene que pasar tres pasos para enterarse al final.
    if (archivo.size > MAX_BYTES) {
      setError(t.subir.demasiadoGrande(MEGAS));
      return;
    }
    // FileReader y no `archivo.text()`: es la lectura que entienden
    // todos los navegadores que soportamos, y además da un `onerror`
    // que distingue «no se pudo leer» de «no es un CSV».
    const lector = new FileReader();
    lector.onerror = () => setError(t.subir.noEsCsv);
    lector.onload = () => {
      try {
        const contenido = String(lector.result ?? "");
        const { tabla: leida, deteccion, mapeo: automatico } = analizar(contenido);
        setNombreArchivo(archivo.name);
        setTexto(contenido);
        setTabla(leida);
        setMapeo(automatico);
        setOrdenElegido(null);
        setFormato(deteccion.formato?.id ?? null);
        if (deteccion.formato) {
          setRed(deteccion.formato.red);
          const deEsaRed = cuentas.filter((c) => c.platformId === deteccion.formato!.red);
          setCuenta(deEsaRed.length === 1 ? deEsaRed[0]!.connectionId : NUEVA);
        }
        setPaso(1);
      } catch (err: unknown) {
        setError(err instanceof ErrorCsv ? textoDeArchivo(err, f) : t.subir.noEsCsv);
      }
    };
    lector.readAsText(archivo, "utf-8");
  }

  function importar() {
    setError(null);
    empezar(async () => {
      try {
        const r = await importarCsv({
          texto,
          red,
          connectionId: cuenta === NUEVA ? undefined : cuenta,
          handleNuevo: cuenta === NUEVA ? handleNuevo.trim().replace(/^@/, "") : undefined,
          mapeo,
          ordenFechas,
        });
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setResultado({
          videos: r.resultado.newPosts + r.resultado.knownPosts,
          nuevos: r.resultado.newPosts,
          conocidos: r.resultado.knownPosts,
          lecturas: r.resultado.readings,
        });
        setPaso(3);
        router.refresh();
      } catch (err) {
        // Un fallo de TRANSPORTE —el cuerpo rechazado por pesar
        // demasiado, la red caída— no puede tumbar el segmento. Sin este
        // catch la promesa sube a la frontera de error y el creador
        // pierde el archivo, el mapeo y la revisión, sin camino de vuelta.
        console.error("[resumen/importar] la acción no respondió", err);
        setError(t.error.generico);
      }
    });
  }

  function reiniciar() {
    setPaso(0);
    setTexto("");
    setTabla(null);
    setMapeo({});
    setResultado(null);
    setNombreArchivo("");
    setYaConocidos(null);
    setOrdenElegido(null);
    setError(null);
  }

  const puedeSeguir =
    paso === 1 && faltan.length === 0 && (cuenta !== NUEVA || handleNuevo.trim().length > 0);

  return (
    <div className="max-w-3xl">
      <Pasos actual={paso} />

      {error && (
        <p role="alert" className="mt-4 rounded-md border border-bad/40 bg-bad-wash px-3 py-2 text-sm text-bad">
          {error}
        </p>
      )}

      {paso === 0 && <PasoSubir onArchivo={recibir} />}

      {paso === 1 && tabla && (
        <PasoFormato
          tabla={tabla}
          mapeo={mapeo}
          onMapeo={setMapeo}
          red={red}
          onRed={(r) => {
            setRed(r);
            const unica = cuentas.filter((c) => c.platformId === r);
            setCuenta(unica.length === 1 ? unica[0]!.connectionId : NUEVA);
          }}
          cuentas={deLaRed}
          cuenta={cuenta}
          onCuenta={setCuenta}
          handleNuevo={handleNuevo}
          onHandleNuevo={setHandleNuevo}
          formato={formato}
          nombreArchivo={nombreArchivo}
          faltan={faltan}
          fechas={fechas}
          ordenFechas={ordenFechas}
          onOrdenFechas={setOrdenElegido}
          timeZone={workspace.timezone}
          f={f}
        />
      )}

      {paso === 2 && revision && <PasoRevisar revision={revision} yaEstaban={yaEstaban} f={f} />}

      {paso === 3 && resultado && <PasoHecho resultado={resultado} onOtro={reiniciar} f={f} />}

      {paso < 3 && (
        <div className="mt-6 flex flex-wrap items-center gap-2">
          {paso > 0 && (
            <Button onClick={() => setPaso((p) => (p - 1) as Paso)} disabled={enviando}>
              {t.acciones.atras}
            </Button>
          )}
          {paso === 1 && (
            <Button variant="primary" onClick={() => setPaso(2)} disabled={!puedeSeguir}>
              {t.acciones.siguiente}
            </Button>
          )}
          {paso === 2 && (
            <Button variant="primary" onClick={importar} loading={enviando} disabled={!revision || revision.listas.length === 0}>
              {enviando ? t.acciones.importando : t.acciones.importar}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

function Pasos({ actual }: { actual: Paso }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      {MESSAGES.importar.pasos.map((nombre, i) => (
        <li key={nombre} className="flex items-center gap-2">
          {i > 0 && <span aria-hidden="true">·</span>}
          <span
            aria-current={i === actual ? "step" : undefined}
            className={i === actual ? "font-medium text-ink" : i < actual ? "text-ink-2" : undefined}
          >
            {i + 1}. {nombre}
          </span>
        </li>
      ))}
    </ol>
  );
}

function PasoSubir({ onArchivo }: { onArchivo: (archivo: File) => void }) {
  const t = MESSAGES.importar.subir;
  const input = useRef<HTMLInputElement>(null);
  const [encima, setEncima] = useState(false);

  return (
    <section className="mt-6" aria-labelledby="paso-subir">
      <h2 id="paso-subir" className="text-sm font-semibold text-ink">
        {t.title}
      </h2>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setEncima(true);
        }}
        onDragLeave={() => setEncima(false)}
        onDrop={(e) => {
          e.preventDefault();
          setEncima(false);
          const archivo = e.dataTransfer.files?.[0];
          if (archivo) onArchivo(archivo);
        }}
        className={`mt-3 rounded-md border border-dashed px-6 py-10 text-center transition-colors ${
          encima ? "border-ink bg-hover" : "border-border"
        }`}
      >
        <p className="text-sm text-ink-2">
          {t.suelta}{" "}
          <button
            type="button"
            onClick={() => input.current?.click()}
            className="font-medium text-ink underline underline-offset-2"
          >
            {t.elegir}
          </button>
        </p>
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="sr-only"
          onChange={(e) => {
            const archivo = e.target.files?.[0];
            if (archivo) onArchivo(archivo);
            e.target.value = "";
          }}
        />
      </div>

      <div className="mt-4 text-xs text-muted">
        <p>{t.formatos}</p>
        <ul className="mt-1.5 space-y-1">
          {FORMATOS.map((formato) => (
            <li key={formato.id}>
              <span className="text-ink-2">{MESSAGES.importar.formatos[formato.id].nombre}</span> ·{" "}
              {MESSAGES.importar.formatos[formato.id].donde}
            </li>
          ))}
        </ul>
        <p className="mt-3 max-w-prose">{t.cualquiera}</p>
      </div>
    </section>
  );
}

function PasoFormato(props: {
  tabla: Tabla;
  mapeo: Mapeo;
  onMapeo: (m: Mapeo) => void;
  red: PlatformId;
  onRed: (r: PlatformId) => void;
  cuentas: ImportableAccount[];
  cuenta: string;
  onCuenta: (c: string) => void;
  handleNuevo: string;
  onHandleNuevo: (h: string) => void;
  formato: FormatoId | null;
  nombreArchivo: string;
  faltan: Campo[];
  fechas: AnalisisFechas | null;
  ordenFechas: OrdenFecha;
  onOrdenFechas: (o: OrdenFecha) => void;
  timeZone: string;
  f: Formatter;
}) {
  const t = MESSAGES.importar.formato;
  const campos = MESSAGES.importar.campos;
  const { tabla, mapeo, onMapeo, faltan, f } = props;
  const primera = tabla.filas[0];

  const cambiar = (campo: Campo, encabezado: string) => {
    const siguiente = { ...mapeo };
    if (encabezado) siguiente[campo] = encabezado;
    else delete siguiente[campo];
    onMapeo(siguiente);
  };

  return (
    <section className="mt-6 space-y-5" aria-labelledby="paso-formato">
      <div>
        <h2 id="paso-formato" className="text-sm font-semibold text-ink">
          {t.title}
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          <span className="font-mono text-xs text-muted">{props.nombreArchivo}</span> ·{" "}
          {props.formato ? t.detectado(MESSAGES.importar.formatos[props.formato].nombre) : t.noDetectado}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <p className="mb-1.5 text-xs text-muted">{t.red}</p>
          <Segmented<PlatformId>
            label={t.red}
            size="sm"
            value={props.red}
            options={PLATFORMS.map((r) => ({ value: r, label: PLATFORM_LABEL[r] }))}
            onChange={props.onRed}
          />
        </div>
        <Field label={t.cuenta} className="min-w-56 flex-1">
          <Select
            value={props.cuenta}
            onChange={(e) => props.onCuenta(e.target.value)}
            options={[
              ...props.cuentas.map((c) => ({
                value: c.connectionId,
                label: t.cuentaOpcion(c.handle ?? c.displayName ?? c.connectionId.slice(0, 8), c.posts, f.int(c.posts)),
              })),
              { value: NUEVA, label: t.cuentaNueva },
            ]}
          />
        </Field>
      </div>

      {props.cuenta === NUEVA && (
        <Field label={t.cuentaNuevaHandle} help={t.cuentaNuevaAyuda} className="max-w-sm">
          <Input
            value={props.handleNuevo}
            onChange={(e) => props.onHandleNuevo(e.target.value)}
            placeholder={t.cuentaNuevaEjemplo}
          />
        </Field>
      )}

      {props.fechas && props.fechas.numericas > 0 && (
        <OrdenDeFechas
          fechas={props.fechas}
          orden={props.ordenFechas}
          onOrden={props.onOrdenFechas}
          ejemplo={celdasDeFecha(tabla, mapeo).find(esFechaNumerica)}
          timeZone={props.timeZone}
          f={f}
        />
      )}

      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">
            {t.columnas}
            {/* Debajo de cada campo se enseña su celda: hay que decir de qué fila. */}
            <span className="ml-2 text-xs font-normal text-muted">{t.muestra}</span>
          </h3>
          {faltan.length > 0 && (
            <p className="text-xs text-bad">{t.faltan(faltan.map((c) => campos[c].label.toLowerCase()).join(", "))}</p>
          )}
        </div>
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {DEF_CAMPOS.map((def) => {
            const elegido = mapeo[def.campo] ?? "";
            const idDelEnlace = def.campo === "externalPostId" && !elegido && Boolean(mapeo.url);
            const nombre = campos[def.campo].label;
            return (
              <li key={def.campo} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
                <div className="min-w-0">
                  <p className="text-sm text-ink">
                    {nombre}
                    {def.obligatorio && <span className="ml-1.5 text-[11px] text-muted">({t.obligatorio})</span>}
                  </p>
                  {idDelEnlace ? (
                    <p className="text-xs text-muted">{t.idDelEnlace}</p>
                  ) : elegido && primera ? (
                    <p className="truncate text-xs text-muted" title={primera[elegido]}>
                      {primera[elegido] || t.celdaVacia}
                    </p>
                  ) : null}
                </div>
                <Select
                  aria-label={nombre}
                  value={elegido}
                  onChange={(e) => cambiar(def.campo, e.target.value)}
                  invalid={faltan.includes(def.campo)}
                  options={[
                    { value: "", label: t.sinAsignar },
                    ...tabla.encabezados.map((h) => ({ value: h, label: h })),
                  ]}
                />
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}

/**
 * El orden día/mes de las fechas numéricas. Si el archivo lo demuestra
 * —una fecha con un número mayor que 12—, se dice y no se pregunta. Si
 * no, se pregunta, con el orden del workspace ya puesto y una fecha del
 * archivo leída en ese orden, para que la persona vea en claro qué va a
 * quedar guardado.
 */
function OrdenDeFechas(props: {
  fechas: AnalisisFechas;
  orden: OrdenFecha;
  onOrden: (o: OrdenFecha) => void;
  ejemplo: string | undefined;
  timeZone: string;
  f: Formatter;
}) {
  const t = MESSAGES.importar.formato.fechas;
  const leida = props.ejemplo ? aFechaIso(props.ejemplo, props.timeZone, props.orden) : null;
  return (
    <div className="rounded-md border border-border px-3 py-2.5">
      {props.fechas.orden ? (
        <p className="text-xs text-ink-2">{t.deducido[props.fechas.orden]}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="text-xs text-ink-2">{t.ambiguo}</p>
          <Segmented<OrdenFecha>
            label={t.label}
            size="sm"
            value={props.orden}
            options={[
              { value: "dm", label: t.dm },
              { value: "md", label: t.md },
            ]}
            onChange={props.onOrden}
          />
        </div>
      )}
      {props.ejemplo && leida && (
        <p className="mt-1.5 text-xs text-muted">{t.ejemplo(props.ejemplo, props.f.date(leida, "long"))}</p>
      )}
    </div>
  );
}

function PasoRevisar({ revision, yaEstaban, f }: { revision: Revision; yaEstaban: number; f: Formatter }) {
  const t = MESSAGES.importar.revisar;
  const noEntran = revision.filas.filter((r) => !r.lectura).length;
  const columnas: Column<FilaRevisada>[] = [
    { key: "fila", header: t.columnas.fila, align: "num", width: "1%", render: (r) => f.int(r.fila) },
    {
      key: "video",
      header: t.columnas.video,
      render: (r) => (
        <CellMain sub={r.problemas.map(textoDe).join(" · ") || undefined}>
          {/*
            Cuando la fila no entra, lo que se enseña es la celda CRUDA:
            quien tiene que arreglar el CSV en Excel necesita saber qué
            buscar, y el número de fila solo no basta.
          */}
          {r.lectura?.title ?? r.lectura?.externalPostId ?? (
            <span className="font-normal text-muted">
              {r.crudo.title ?? r.crudo.externalPostId ?? r.crudo.url ?? t.sinDato}
            </span>
          )}
        </CellMain>
      ),
    },
    {
      key: "publicado",
      header: t.columnas.publicado,
      render: (r) =>
        r.lectura ? (
          f.date(r.lectura.publishedAt)
        ) : (
          // La fecha tal como vino: si es ella la que no se entiende, es
          // justo lo que hay que ver para arreglarla.
          <span className="text-muted">{r.crudo.publishedAt ?? t.sinDato}</span>
        ),
    },
    {
      key: "views",
      header: t.columnas.views,
      align: "num",
      render: (r) => (r.lectura?.views != null ? f.int(r.lectura.views) : <span className="font-sans text-muted">{t.sinDato}</span>),
    },
    {
      key: "estado",
      header: t.columnas.estado,
      render: (r) =>
        !r.lectura ? (
          <Pill kind="bad">{t.estado.error}</Pill>
        ) : r.problemas.length > 0 ? (
          <Pill kind="warn">{t.estado.aviso}</Pill>
        ) : (
          <Pill kind="good">{t.estado.lista}</Pill>
        ),
    },
  ];

  return (
    <section className="mt-6" aria-labelledby="paso-revisar">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="paso-revisar" className="text-sm font-semibold text-ink">
          {t.title}
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="text-ink-2">{t.resumen(f.int(revision.listas.length), f.int(revision.filas.length))}</span>
          {noEntran > 0 && <Pill kind="bad">{t.errores(noEntran, f.int(noEntran))}</Pill>}
          {revision.avisos > 0 && <Pill kind="warn">{t.avisos(revision.avisos, f.int(revision.avisos))}</Pill>}
          {yaEstaban > 0 && <span>{t.yaEstaban(yaEstaban, f.int(yaEstaban))}</span>}
          {revision.duplicadasEnArchivo > 0 && (
            <span>{t.duplicadas(revision.duplicadasEnArchivo, f.int(revision.duplicadasEnArchivo))}</span>
          )}
        </p>
      </div>
      <DataTable
        columns={columnas}
        rows={revision.filas}
        rowKey={(r) => String(r.fila)}
        caption={t.title}
        density="compact"
        maxHeight="420px"
        emptyState={<EmptyState title={t.ninguna} />}
      />
    </section>
  );
}

function PasoHecho({
  resultado,
  onOtro,
  f,
}: {
  resultado: { videos: number; nuevos: number; conocidos: number; lecturas: number };
  onOtro: () => void;
  f: Formatter;
}) {
  const t = MESSAGES.importar.hecho;
  return (
    <section className="mt-6" aria-labelledby="paso-hecho">
      <div className="rounded-md border border-border bg-surface px-5 py-6">
        <h2 id="paso-hecho" className="text-sm font-semibold text-ink">
          {t.title}
        </h2>
        <p className="mt-1 font-mono text-2xl tabular-nums text-ink">
          {t.resumen(resultado.videos, f.int(resultado.videos), resultado.lecturas, f.int(resultado.lecturas))}
        </p>
        <ul className="mt-2 space-y-0.5 text-sm text-ink-2">
          {resultado.nuevos > 0 && <li>{t.nuevos(resultado.nuevos, f.int(resultado.nuevos))}</li>}
          {resultado.conocidos > 0 && <li>{t.conocidos(resultado.conocidos, f.int(resultado.conocidos))}</li>}
        </ul>
        <div className="mt-5 flex flex-wrap gap-2">
          <Button variant="primary" href="/resumen">
            {t.ver}
          </Button>
          <Button onClick={onOtro}>{MESSAGES.importar.acciones.otro}</Button>
        </div>
      </div>
      <p className="mt-3 text-xs text-muted">
        <Link href="/conexiones" className="underline underline-offset-2 hover:text-ink">
          {MESSAGES.frescura.revisar}
        </Link>
      </p>
    </section>
  );
}
