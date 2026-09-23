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
import { DateInput } from "@/components/ui/date-input";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";
import { Segmented } from "@/components/ui/segmented";
import { formatterFor, type FormatSettings, type Formatter } from "@/lib/format";
import { MESSAGES } from "../messages";
import { buscarPostsConocidos } from "./actions";
import {
  aFechaIso,
  analizar,
  analizarFechas,
  celdasDeFecha,
  decodificarCsv,
  diaEnZona,
  ErrorCsv,
  esFechaNumerica,
  faltantesDelMapeo,
  instanteDeCaptura,
  MAX_BYTES,
  ordenPorLocale,
  proponerFechaExportacion,
  revisar,
  validarFechaExportacion,
  type AnalisisFechas,
  type Codificacion,
  type FilaRevisada,
  type OrdenFecha,
  type Problema,
  type ProblemaFechaExportacion,
  type PropuestaFechaExportacion,
  type Revision,
  type Tabla,
} from "./_lib/csv";
import { enviarLote } from "./_lib/enviar";
import { CAMPOS_METRICA, DEF_CAMPOS, FORMATOS, type Campo, type FormatoId, type Mapeo } from "./_lib/formatos";

/**
 * Los cuatro pasos de la importación: subir → formato → revisar →
 * importar, como en Flatfile o OneSchema.
 *
 * El archivo NO sube a ningún sitio hasta el último paso: se lee y se
 * valida en el navegador, y solo al pulsar «Importar» viaja su texto al
 * route handler de la importación (`lote/route.ts`, con su propio techo
 * de tamaño), que vuelve a validarlo. Quien se arrepiente en el paso 3
 * no dejó nada escrito en ninguna parte.
 */

type Paso = 0 | 1 | 2 | 3;

/** El título de cada paso: al cambiar de paso, el foco va a él. */
const TITULO_DE_PASO = ["paso-subir", "paso-formato", "paso-revisar", "paso-hecho"] as const;

/**
 * La clase del título de cada paso. Recibe el foco por programa
 * (tabIndex={-1}), y el anillo global `:focus-visible` de globals.css —que
 * no vive en ninguna capa y por eso gana a las utilidades— le dibujaba un
 * recuadro como si fuera un campo. `outline-none!` es importante y sí
 * gana. El cambio de paso se sigue anunciando por el aria-live de <Pasos>.
 */
const TITULO_PASO = "text-sm font-semibold text-ink outline-none!";

interface Resultado {
  videos: number;
  nuevos: number;
  conocidos: number;
  lecturas: number;
  antiguas: number;
  /** 'YYYY-MM-DD': el día de la exportación con el que quedaron. */
  fecha: string;
}

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

/** Un nombre de usuario comparable: sin arroba, sin espacios, en minúsculas. Como lo compara la base. */
const comparable = (handle: string) => handle.trim().replace(/^@/, "").toLowerCase();

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
  /**
   * La red del archivo. null hasta que la dice el formato reconocido o la
   * persona: dar una por supuesta dejaba importar una exportación de
   * TikTok a la cuenta de Instagram sin que nadie lo notara.
   */
  const [red, setRed] = useState<PlatformId | null>(null);
  const [cuenta, setCuenta] = useState<string>(NUEVA);
  const [handleNuevo, setHandleNuevo] = useState("");
  const [formato, setFormato] = useState<FormatoId | null>(null);
  /** El orden de fechas que eligió la persona. null = el que propone el formato o el locale. */
  const [ordenElegido, setOrdenElegido] = useState<OrdenFecha | null>(null);
  /** El día de la exportación que escribió la persona. null = el propuesto. */
  const [fechaElegida, setFechaElegida] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<Resultado | null>(null);
  /**
   * Los videos que la cuenta de destino ya tiene, con el instante de su
   * última lectura. null = todavía no se ha preguntado.
   */
  const [yaConocidos, setYaConocidos] = useState<ReadonlyMap<string, string | null> | null>(null);
  /** Cómo venía escrito el archivo: si no era UTF-8, el paso 2 lo dice. */
  const [codificacion, setCodificacion] = useState<Codificacion>("utf-8");

  const deLaRed = cuentas.filter((c) => c.platformId === red);
  const faltan = useMemo(() => faltantesDelMapeo(mapeo), [mapeo]);

  // El orden día/mes se decide para el ARCHIVO entero, mirando la
  // columna de fechas antes de leer ninguna: si alguna fecha lo
  // demuestra, manda el archivo; si todas sirven en los dos órdenes, la
  // persona elige, con el orden de su workspace como propuesta.
  const fechas: AnalisisFechas | null = useMemo(
    () => (tabla ? analizarFechas(celdasDeFecha(tabla, mapeo)) : null),
    [tabla, mapeo],
  );
  // Si el archivo no lo demuestra, manda lo que elija la persona; si no
  // eligió, el orden fijo del formato reconocido (Meta escribe mes/día
  // en cualquier idioma) y, solo si no lo hay, el del workspace.
  const ordenDelFormato = FORMATOS.find((x) => x.id === formato)?.ordenFechas ?? null;
  const ordenFechas: OrdenFecha = fechas?.orden ?? ordenElegido ?? ordenDelFormato ?? ordenPorLocale(workspace.locale);

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
    [tabla, mapeo, opciones, faltan],
  );

  // Los ids que hay que preguntarle a la base, como una clave ESTABLE:
  // cambiar el select de «Guardados» rehace la revisión pero no los ids,
  // y con la revisión como dependencia cada select tocado era un viaje
  // al servidor con la misma pregunta.
  const idsConsulta = useMemo(
    () => JSON.stringify([...new Set(revisionBase?.listas.map((l) => l.externalPostId) ?? [])].sort()),
    [revisionBase],
  );

  useEffect(() => {
    setYaConocidos(null);
    const ids = JSON.parse(idsConsulta) as string[];
    // Una cuenta que todavía no existe no puede tener nada repetido.
    if (cuenta === NUEVA || ids.length === 0) return;
    let vivo = true;
    void buscarPostsConocidos({ connectionId: cuenta, ids }).then(
      (r) => {
        if (vivo && r.ok && r.conocidos.length > 0) {
          setYaConocidos(new Map(r.conocidos.map((c) => [c.id, c.ultimaLectura] as const)));
        }
      },
      // Si la consulta falla, la previsualización sigue valiendo: solo
      // se queda sin el aviso. No es motivo para no dejar importar.
      () => undefined,
    );
    return () => {
      vivo = false;
    };
  }, [cuenta, idsConsulta]);

  // El día de la exportación: el momento de la lectura. Se propone a
  // partir del archivo y se valida contra sus propias fechas.
  const listasBase = useMemo(() => revisionBase?.listas ?? [], [revisionBase]);
  const propuestaFecha: PropuestaFechaExportacion | null = useMemo(
    () =>
      tabla
        ? proponerFechaExportacion(tabla, mapeo, {
            timeZone: workspace.timezone,
            listas: listasBase,
            nombreArchivo,
            ordenFechas,
          })
        : null,
    [tabla, mapeo, workspace.timezone, listasBase, nombreArchivo, ordenFechas],
  );
  const fechaExportacion = fechaElegida ?? propuestaFecha?.fecha ?? "";
  const problemaFecha = validarFechaExportacion(fechaExportacion, { timeZone: workspace.timezone, listas: listasBase });

  // El instante con el que se guardará la lectura: el mismo cálculo que
  // hará el servidor (instanteDeCaptura). Sin fecha propia —hoy— la base
  // pone now(), que es posterior a cualquier lectura que ya exista.
  const instanteCaptura = useMemo(() => {
    if (problemaFecha !== null || !fechaExportacion) return undefined;
    const iso = instanteDeCaptura(fechaExportacion, { timeZone: workspace.timezone, listas: listasBase });
    return iso ? Date.parse(iso) : Date.now();
  }, [problemaFecha, fechaExportacion, workspace.timezone, listasBase]);

  // La segunda pasada, con lo que dijo la base: qué videos ya están y si
  // esta lectura es más nueva que la última que tienen.
  const revision: Revision | null = useMemo(
    () =>
      tabla && revisionBase && yaConocidos
        ? revisar(tabla, mapeo, { ...opciones, yaConocidos, instanteCaptura })
        : revisionBase,
    [tabla, mapeo, opciones, revisionBase, yaConocidos, instanteCaptura],
  );

  // Al cambiar de paso, el título del nuevo recibe el foco: sin esto el
  // botón pulsado desaparece y el foco cae a <body>, y quien usa teclado
  // o lector de pantalla vuelve al principio de la página.
  const contenedor = useRef<HTMLDivElement>(null);
  const primerPaso = useRef(true);
  useEffect(() => {
    if (primerPaso.current) {
      primerPaso.current = false;
      return;
    }
    contenedor.current?.querySelector<HTMLElement>(`#${TITULO_DE_PASO[paso]}`)?.focus();
  }, [paso]);

  /**
   * La cuenta de esa red que ya se llama como la que se quiere crear.
   * Crear otra partiría sus videos en dos conexiones y Resumen los
   * contaría dos veces: se propone la que existe (y la base, si llega un
   * nombre repetido, devuelve la que existe en vez de crear otra).
   */
  const cuentaExistente =
    cuenta === NUEVA && handleNuevo.trim()
      ? deLaRed.find((c) => c.handle !== null && comparable(c.handle) === comparable(handleNuevo))
      : undefined;

  function recibir(archivo: File) {
    setError(null);
    // El techo se comprueba ANTES de leer: un archivo que no cabe en el
    // envío no tiene que pasar tres pasos para enterarse al final.
    if (archivo.size > MAX_BYTES) {
      setError(t.subir.demasiadoGrande(MEGAS));
      return;
    }
    // FileReader y no `archivo.arrayBuffer()`: es la lectura que
    // entienden todos los navegadores que soportamos, y además da un
    // `onerror` que distingue «no se pudo leer» de «no es un CSV». Como
    // BYTES y no como texto: el texto lo decide decodificarCsv, que
    // reconoce un archivo guardado desde Excel para Windows
    // (Windows-1252) en vez de romperle las tildes.
    const lector = new FileReader();
    lector.onerror = () => setError(t.subir.noEsCsv);
    lector.onload = () => {
      try {
        // Sin `instanceof ArrayBuffer`: el buffer puede venir de otro
        // «realm» (un iframe, jsdom) y la comprobación fallaría.
        const bytes = lector.result === null || typeof lector.result === "string" ? new ArrayBuffer(0) : lector.result;
        const { texto: contenido, codificacion: leidaComo } = decodificarCsv(bytes);
        const { tabla: leida, deteccion, mapeo: automatico } = analizar(contenido);
        setNombreArchivo(archivo.name);
        setCodificacion(leidaComo);
        setTexto(contenido);
        setTabla(leida);
        setMapeo(automatico);
        setOrdenElegido(null);
        setFechaElegida(null);
        setFormato(deteccion.formato?.id ?? null);
        if (deteccion.formato) {
          setRed(deteccion.formato.red);
          const deEsaRed = cuentas.filter((c) => c.platformId === deteccion.formato!.red);
          setCuenta(deEsaRed.length === 1 ? deEsaRed[0]!.connectionId : NUEVA);
        } else {
          // Sin formato reconocido, la red la elige la persona: ni la del
          // archivo anterior ni ninguna por defecto.
          setRed(null);
          setCuenta(NUEVA);
        }
        setPaso(1);
      } catch (err: unknown) {
        setError(err instanceof ErrorCsv ? textoDeArchivo(err, f) : t.subir.noEsCsv);
      }
    };
    lector.readAsArrayBuffer(archivo);
  }

  function importar() {
    setError(null);
    if (!red) return;
    // El techo se mide sobre lo que de verdad viaja: el texto en UTF-8.
    // Un archivo de Windows-1252 lleno de tildes crece al pasar a UTF-8.
    if (new TextEncoder().encode(texto).byteLength > MAX_BYTES) {
      setError(t.error.demasiadoGrande(MEGAS));
      return;
    }
    empezar(async () => {
      try {
        const r = await enviarLote({
          texto,
          red,
          connectionId: cuenta === NUEVA ? undefined : cuenta,
          handleNuevo: cuenta === NUEVA ? handleNuevo.trim().replace(/^@/, "") : undefined,
          mapeo,
          ordenFechas,
          fechaExportacion,
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
          antiguas: r.resultado.staleReadings,
          fecha: fechaExportacion,
        });
        setPaso(3);
        router.refresh();
      } catch (err) {
        // Un fallo de TRANSPORTE —la red caída, una respuesta que no es
        // la de la ruta— no puede tumbar el segmento. Sin este catch la
        // promesa sube a la frontera de error y el creador pierde el
        // archivo, el mapeo y la revisión, sin camino de vuelta.
        console.error("[resumen/importar] la importación no respondió", err);
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
    setCodificacion("utf-8");
    setOrdenElegido(null);
    setFechaElegida(null);
    setRed(null);
    setError(null);
  }

  const puedeSeguir =
    paso === 1 &&
    red !== null &&
    faltan.length === 0 &&
    problemaFecha === null &&
    (cuenta !== NUEVA || handleNuevo.trim().length > 0);

  return (
    <div className="max-w-3xl" ref={contenedor}>
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
          onRed={(r: PlatformId) => {
            setRed(r);
            const unica = cuentas.filter((c) => c.platformId === r);
            setCuenta(unica.length === 1 ? unica[0]!.connectionId : NUEVA);
          }}
          cuentas={deLaRed}
          cuenta={cuenta}
          onCuenta={setCuenta}
          handleNuevo={handleNuevo}
          onHandleNuevo={setHandleNuevo}
          cuentaExistente={cuentaExistente}
          formato={formato}
          nombreArchivo={nombreArchivo}
          codificacion={codificacion}
          faltan={faltan}
          fechas={fechas}
          ordenFechas={ordenFechas}
          onOrdenFechas={setOrdenElegido}
          ordenDelFormato={ordenDelFormato}
          fechaExportacion={fechaExportacion}
          onFechaExportacion={setFechaElegida}
          propuestaFecha={propuestaFecha}
          // Sin mapeo completo aún no hay filas contra las que validarla.
          problemaFecha={faltan.length === 0 ? problemaFecha : null}
          timeZone={workspace.timezone}
          f={f}
        />
      )}

      {paso === 2 && revision && <PasoRevisar revision={revision} mapeo={mapeo} f={f} />}

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
  const t = MESSAGES.importar;
  return (
    <>
      {/* El cambio de paso se anuncia: el foco ya va al título, pero el lector tiene que saber en qué paso está. */}
      <p className="sr-only" aria-live="polite">
        {t.pasoActual(actual + 1, t.pasos.length, t.pasos[actual]!)}
      </p>
      <ol className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        {t.pasos.map((nombre, i) => (
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
    </>
  );
}

function PasoSubir({ onArchivo }: { onArchivo: (archivo: File) => void }) {
  const t = MESSAGES.importar.subir;
  const input = useRef<HTMLInputElement>(null);
  const [encima, setEncima] = useState(false);

  return (
    <section className="mt-6" aria-labelledby="paso-subir">
      <h2 id="paso-subir" tabIndex={-1} className={TITULO_PASO}>
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
        {/*
          Fuera del orden de Tab: el botón visible ya lo abre con click(),
          y como segunda parada dejaba el foco en un control invisible y
          sin anillo.
        */}
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
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
  red: PlatformId | null;
  onRed: (r: PlatformId) => void;
  cuentas: ImportableAccount[];
  cuenta: string;
  onCuenta: (c: string) => void;
  handleNuevo: string;
  onHandleNuevo: (h: string) => void;
  /** La cuenta de esa red que ya se llama como la nueva, si la hay. */
  cuentaExistente: ImportableAccount | undefined;
  formato: FormatoId | null;
  nombreArchivo: string;
  codificacion: Codificacion;
  faltan: Campo[];
  fechas: AnalisisFechas | null;
  ordenFechas: OrdenFecha;
  onOrdenFechas: (o: OrdenFecha) => void;
  ordenDelFormato: OrdenFecha | null;
  fechaExportacion: string;
  onFechaExportacion: (fecha: string) => void;
  propuestaFecha: PropuestaFechaExportacion | null;
  problemaFecha: ProblemaFechaExportacion | null;
  timeZone: string;
  f: Formatter;
}) {
  const t = MESSAGES.importar.formato;
  const tf = t.fechaExportacion;
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
        <h2 id="paso-formato" tabIndex={-1} className={TITULO_PASO}>
          {t.title}
        </h2>
        <p className="mt-1 text-sm text-ink-2">
          <span className="font-mono text-xs text-muted">{props.nombreArchivo}</span> ·{" "}
          {props.formato ? t.detectado(MESSAGES.importar.formatos[props.formato].nombre) : t.noDetectado}
        </p>
        {props.codificacion !== "utf-8" && (
          <p className="mt-2 rounded-md border border-warn/40 bg-warn-wash px-3 py-2 text-xs text-ink-2">
            {MESSAGES.importar.codificacion[props.codificacion]}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <p className="mb-1.5 text-xs text-muted">{t.red}</p>
          {/* Sin red elegida no hay ninguna opción pulsada: "" no es ninguna red. */}
          <Segmented<PlatformId | "">
            label={t.red}
            size="sm"
            value={props.red ?? ""}
            options={PLATFORMS.map((r) => ({ value: r, label: PLATFORM_LABEL[r] }))}
            onChange={(r) => {
              if (r) props.onRed(r);
            }}
          />
          {props.red === null && <p className="mt-1.5 text-xs text-bad">{t.faltaRed}</p>}
        </div>
        {/* La cuenta depende de la red: sin red, no hay de dónde elegirla. */}
        {props.red !== null && (
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
        )}
      </div>

      {props.red !== null && props.cuenta === NUEVA && (
        <div className="space-y-2">
          <Field label={t.cuentaNuevaHandle} help={t.cuentaNuevaAyuda} className="max-w-sm">
            <Input
              value={props.handleNuevo}
              onChange={(e) => props.onHandleNuevo(e.target.value)}
              placeholder={t.cuentaNuevaEjemplo}
            />
          </Field>
          {props.cuentaExistente && (
            <div
              role="status"
              className="flex max-w-xl flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-warn/40 bg-warn-wash px-3 py-2"
            >
              <p className="text-xs text-ink-2">{t.cuentaExistente(props.cuentaExistente.handle ?? props.handleNuevo)}</p>
              <Button size="sm" onClick={() => props.onCuenta(props.cuentaExistente!.connectionId)}>
                {t.usarExistente(props.cuentaExistente.handle ?? props.handleNuevo)}
              </Button>
            </div>
          )}
        </div>
      )}

      <Field
        label={tf.label}
        help={`${tf.ayuda} ${
          props.propuestaFecha && props.fechaExportacion === props.propuestaFecha.fecha
            ? props.propuestaFecha.origen === "columna"
              ? tf.origen.columna(props.propuestaFecha.columna ?? "")
              : tf.origen[props.propuestaFecha.origen]
            : ""
        }`.trim()}
        error={props.problemaFecha ? tf.problema[props.problemaFecha] : undefined}
        className="max-w-xs"
      >
        <DateInput
          value={props.fechaExportacion}
          onChange={props.onFechaExportacion}
          max={diaEnZona(Date.now(), props.timeZone)}
        />
      </Field>

      {props.fechas && props.fechas.numericas > 0 && (
        <OrdenDeFechas
          fechas={props.fechas}
          orden={props.ordenFechas}
          onOrden={props.onOrdenFechas}
          ordenDelFormato={props.ordenDelFormato}
          formato={props.formato}
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
 * no, se pregunta, con un orden ya puesto —el del formato reconocido si
 * lo tiene, si no el del workspace— y una fecha del archivo leída en ese
 * orden, para que la persona vea en claro qué va a quedar guardado.
 */
function OrdenDeFechas(props: {
  fechas: AnalisisFechas;
  orden: OrdenFecha;
  onOrden: (o: OrdenFecha) => void;
  ordenDelFormato: OrdenFecha | null;
  formato: FormatoId | null;
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
          <p className="text-xs text-ink-2">
            {props.ordenDelFormato && props.formato
              ? t.ambiguoFormato(MESSAGES.importar.formatos[props.formato].nombre, t.nombreOrden[props.ordenDelFormato])
              : t.ambiguo}
          </p>
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

/**
 * Las cifras que la vista previa enseña, en este orden: las que se
 * escribirán y tienen columna en el mapeo. Antes solo se veían las
 * visualizaciones, y el alcance, los guardados o los seguidores ganados
 * se escribían sin que nadie los hubiera visto (Flatfile y OneSchema
 * enseñan todas las columnas mapeadas).
 */
const CIFRAS_DE_LA_REVISION: readonly Campo[] = [...CAMPOS_METRICA, "durationS"];

function PasoRevisar({ revision, mapeo, f }: { revision: Revision; mapeo: Mapeo; f: Formatter }) {
  const t = MESSAGES.importar.revisar;
  const noEntran = revision.filas.filter((r) => !r.lectura).length;
  const cifras = CIFRAS_DE_LA_REVISION.filter((c) => mapeo[c]);
  // «Estado» va segunda, justo después de la fila: es lo que se mira en
  // este paso, y a 400 px la tabla se desplaza dentro de sí misma y la
  // última columna quedaba cortada en el borde.
  const columnas: Column<FilaRevisada>[] = [
    { key: "fila", header: t.columnas.fila, align: "num", width: "1%", render: (r) => f.int(r.fila) },
    {
      key: "estado",
      header: t.columnas.estado,
      width: "1%",
      render: (r) =>
        !r.lectura ? (
          <Pill kind="bad">{t.estado.error}</Pill>
        ) : r.problemas.length > 0 ? (
          <Pill kind="warn">{t.estado.aviso}</Pill>
        ) : (
          <Pill kind="good">{t.estado.lista}</Pill>
        ),
    },
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
          <span className="whitespace-nowrap">{f.date(r.lectura.publishedAt)}</span>
        ) : (
          // La fecha tal como vino: si es ella la que no se entiende, es
          // justo lo que hay que ver para arreglarla. En una línea, y
          // entera en el title.
          <span className="block max-w-[9rem] truncate whitespace-nowrap text-muted" title={r.crudo.publishedAt ?? undefined}>
            {r.crudo.publishedAt ?? t.sinDato}
          </span>
        ),
    },
    // Una columna por cifra mapeada. La tabla se desplaza dentro de sí
    // misma a 400 px (DataTable), así que la página no.
    ...cifras.map(
      (campo): Column<FilaRevisada> => ({
        key: campo,
        header: t.columnas[campo as keyof typeof t.columnas],
        align: "num",
        render: (r) => {
          const v = r.lectura?.[campo as keyof NonNullable<FilaRevisada["lectura"]>];
          return typeof v === "number" ? f.int(v) : <span className="font-sans text-muted">{t.sinDato}</span>;
        },
      }),
    ),
  ];

  return (
    <section className="mt-6" aria-labelledby="paso-revisar">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="paso-revisar" tabIndex={-1} className={TITULO_PASO}>
          {t.title}
        </h2>
        <p className="flex flex-wrap items-center gap-2 text-xs text-muted">
          <span className="text-ink-2">{t.resumen(f.int(revision.listas.length), f.int(revision.filas.length))}</span>
          {noEntran > 0 && <Pill kind="bad">{t.errores(noEntran, f.int(noEntran))}</Pill>}
          {revision.avisos > 0 && <Pill kind="warn">{t.avisos(revision.avisos, f.int(revision.avisos))}</Pill>}
          {revision.yaEstaban > 0 && <span>{t.yaEstaban(revision.yaEstaban, f.int(revision.yaEstaban))}</span>}
          {revision.sinNovedad > 0 && <Pill kind="warn">{t.sinNovedad(revision.sinNovedad, f.int(revision.sinNovedad))}</Pill>}
          {revision.duplicadasEnArchivo > 0 && (
            <span>{t.duplicadas(revision.duplicadasEnArchivo, f.int(revision.duplicadasEnArchivo))}</span>
          )}
          {revision.filasTotales > 0 && <span>{t.totales(revision.filasTotales, f.int(revision.filasTotales))}</span>}
        </p>
      </div>
      {revision.ordenAlternativo && (
        <p className="mb-3 rounded-md border border-warn/40 bg-warn-wash px-3 py-2 text-xs text-ink-2">
          {t.ordenDudoso(
            MESSAGES.importar.formato.fechas.nombreOrden[revision.ordenFechas],
            MESSAGES.importar.formato.fechas.nombreOrden[revision.ordenAlternativo],
          )}
        </p>
      )}
      <DataTable
        columns={columnas}
        rows={revision.filas}
        rowKey={(r) => String(r.fila)}
        caption={t.caption}
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
  resultado: Resultado;
  onOtro: () => void;
  f: Formatter;
}) {
  const t = MESSAGES.importar.hecho;
  // Los que ya estaban Y recibieron lectura: los que no traían nada más
  // reciente los cuenta `antiguas`. Contarlos en las dos líneas decía a
  // la vez «se les añadió una lectura» y «no se guardaron».
  const conLectura = Math.max(0, resultado.conocidos - resultado.antiguas);
  return (
    <section className="mt-6" aria-labelledby="paso-hecho">
      <div className="rounded-md border border-border bg-surface px-5 py-6">
        <h2 id="paso-hecho" tabIndex={-1} className={TITULO_PASO}>
          {t.title}
        </h2>
        <p className="mt-1 font-mono text-2xl tabular-nums text-ink">
          {t.resumen(resultado.videos, f.int(resultado.videos), resultado.lecturas, f.int(resultado.lecturas))}
        </p>
        <ul className="mt-2 space-y-0.5 text-sm text-ink-2">
          {resultado.nuevos > 0 && <li>{t.nuevos(resultado.nuevos, f.int(resultado.nuevos))}</li>}
          {conLectura > 0 && <li>{t.conocidos(conLectura, f.int(conLectura))}</li>}
          {resultado.antiguas > 0 && <li>{t.antiguas(resultado.antiguas, f.int(resultado.antiguas))}</li>}
          <li className="text-muted">{t.fecha(f.date(resultado.fecha, "long"))}</li>
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
