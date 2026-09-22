"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CuentaImportable, RedId } from "@mc/db/queries/resumen";
import { Button } from "@/components/ui/button";
import { CellMain, DataTable, type Column } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { Field, Input, Select } from "@/components/ui/field";
import { Pill } from "@/components/ui/pill";
import { PLATFORM_LABEL } from "@/components/ui/platform-pill";
import { Segmented } from "@/components/ui/segmented";
import { formatterFor, type FormatSettings } from "@/lib/format";
import { MESSAGES } from "../messages";
import { importarCsv } from "./actions";
import {
  analizar,
  ErrorCsv,
  faltantesDelMapeo,
  MAX_BYTES,
  revisar,
  type FilaRevisada,
  type Revision,
  type Tabla,
} from "./_lib/csv";
import { DEF_CAMPOS, FORMATOS, type Campo, type Mapeo } from "./_lib/formatos";

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

const REDES_UI: RedId[] = ["tiktok", "instagram", "facebook", "youtube"];
const NUEVA = "__nueva__";

export interface AsistenteProps {
  cuentas: CuentaImportable[];
  workspace: FormatSettings;
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
  const [red, setRed] = useState<RedId>("instagram");
  const [cuenta, setCuenta] = useState<string>(NUEVA);
  const [handleNuevo, setHandleNuevo] = useState("");
  const [formato, setFormato] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultado, setResultado] = useState<{ videos: number; nuevos: number; conocidos: number; lecturas: number } | null>(null);

  const deLaRed = cuentas.filter((c) => c.platformId === red);
  const faltan = faltantesDelMapeo(mapeo);

  const revision: Revision | null = useMemo(
    () => (tabla && faltan.length === 0 ? revisar(tabla, mapeo, { timeZone: workspace.timezone }) : null),
    // `faltan` se recalcula con `mapeo`, así que no hace falta en las dependencias.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tabla, mapeo, workspace.timezone],
  );

  function recibir(archivo: File) {
    setError(null);
    if (archivo.size > MAX_BYTES) {
      setError(t.subir.demasiadoGrande(Math.round(MAX_BYTES / 1024 / 1024)));
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
        setFormato(deteccion.formato?.nombre ?? null);
        if (deteccion.formato) {
          setRed(deteccion.formato.red);
          const deEsaRed = cuentas.filter((c) => c.platformId === deteccion.formato!.red);
          setCuenta(deEsaRed.length === 1 ? deEsaRed[0]!.connectionId : NUEVA);
        }
        setPaso(1);
      } catch (err: unknown) {
        setError(err instanceof ErrorCsv ? err.message : t.subir.noEsCsv);
      }
    };
    lector.readAsText(archivo, "utf-8");
  }

  function importar() {
    setError(null);
    empezar(async () => {
      const r = await importarCsv({
        texto,
        red,
        connectionId: cuenta === NUEVA ? undefined : cuenta,
        handleNuevo: cuenta === NUEVA ? handleNuevo.trim().replace(/^@/, "") : undefined,
        mapeo,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setResultado({
        videos: r.resultado.postsNuevos + r.resultado.postsConocidos,
        nuevos: r.resultado.postsNuevos,
        conocidos: r.resultado.postsConocidos,
        lecturas: r.resultado.lecturas,
      });
      setPaso(3);
      router.refresh();
    });
  }

  function reiniciar() {
    setPaso(0);
    setTexto("");
    setTabla(null);
    setMapeo({});
    setResultado(null);
    setNombreArchivo("");
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
        />
      )}

      {paso === 2 && revision && <PasoRevisar revision={revision} fecha={(iso) => f.date(iso)} entero={(n) => f.int(n)} />}

      {paso === 3 && resultado && <PasoHecho resultado={resultado} onOtro={reiniciar} />}

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
              <span className="text-ink-2">{formato.nombre}</span> · {formato.donde}
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
  red: RedId;
  onRed: (r: RedId) => void;
  cuentas: CuentaImportable[];
  cuenta: string;
  onCuenta: (c: string) => void;
  handleNuevo: string;
  onHandleNuevo: (h: string) => void;
  formato: string | null;
  nombreArchivo: string;
  faltan: Campo[];
}) {
  const t = MESSAGES.importar.formato;
  const { tabla, mapeo, onMapeo, faltan } = props;
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
          {props.formato ? t.detectado(props.formato) : t.noDetectado}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div>
          <p className="mb-1.5 text-xs text-muted">{t.red}</p>
          <Segmented<RedId>
            label={t.red}
            size="sm"
            value={props.red}
            options={REDES_UI.map((r) => ({ value: r, label: PLATFORM_LABEL[r] }))}
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
                label: `@${c.handle ?? c.displayName ?? c.connectionId.slice(0, 8)}${c.posts > 0 ? ` · ${c.posts} videos` : ""}`,
              })),
              { value: NUEVA, label: t.cuentaNueva },
            ]}
          />
        </Field>
      </div>

      {props.cuenta === NUEVA && (
        <Field label={t.cuentaNuevaHandle} help={t.cuentaNuevaAyuda} className="max-w-sm">
          <Input value={props.handleNuevo} onChange={(e) => props.onHandleNuevo(e.target.value)} placeholder="laura.cocinafacil" />
        </Field>
      )}

      <div>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="text-sm font-semibold text-ink">{t.columnas}</h3>
          {faltan.length > 0 && (
            <p className="text-xs text-bad">
              {t.faltan(faltan.map((c) => DEF_CAMPOS.find((d) => d.campo === c)!.label.toLowerCase()).join(", "))}
            </p>
          )}
        </div>
        <ul className="divide-y divide-border overflow-hidden rounded-md border border-border">
          {DEF_CAMPOS.map((def) => {
            const elegido = mapeo[def.campo] ?? "";
            const idDelEnlace = def.campo === "externalPostId" && !elegido && Boolean(mapeo.url);
            return (
              <li key={def.campo} className="grid gap-2 px-3 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
                <div className="min-w-0">
                  <p className="text-sm text-ink">
                    {def.label}
                    {def.obligatorio && <span className="ml-1.5 text-[11px] text-muted">({t.obligatorio})</span>}
                  </p>
                  {idDelEnlace ? (
                    <p className="text-xs text-muted">{t.idDelEnlace}</p>
                  ) : elegido && primera ? (
                    <p className="truncate text-xs text-muted" title={primera[elegido]}>
                      {primera[elegido] || "—"}
                    </p>
                  ) : null}
                </div>
                <Select
                  aria-label={def.label}
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

function PasoRevisar({
  revision,
  fecha,
  entero,
}: {
  revision: Revision;
  fecha: (iso: string) => string;
  entero: (n: number) => string;
}) {
  const t = MESSAGES.importar.revisar;
  const columnas: Column<FilaRevisada>[] = [
    { key: "fila", header: t.columnas.fila, align: "num", width: "1%", render: (r) => r.fila },
    {
      key: "video",
      header: t.columnas.video,
      render: (r) => (
        <CellMain sub={r.problemas.map((p) => p.mensaje).join(" · ") || undefined}>
          {r.lectura?.title ?? r.lectura?.externalPostId ?? "—"}
        </CellMain>
      ),
    },
    {
      key: "publicado",
      header: t.columnas.publicado,
      render: (r) => (r.lectura ? fecha(r.lectura.publishedAt) : <span className="text-muted">—</span>),
    },
    {
      key: "views",
      header: t.columnas.views,
      align: "num",
      render: (r) => (r.lectura?.views != null ? entero(r.lectura.views) : <span className="font-sans text-muted">—</span>),
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
          <span className="text-ink-2">{t.resumen(revision.listas.length, revision.filas.length)}</span>
          {revision.errores > 0 && <Pill kind="bad">{t.errores(revision.filas.filter((f) => !f.lectura).length)}</Pill>}
          {revision.avisos > 0 && <Pill kind="warn">{t.avisos(revision.avisos)}</Pill>}
          {revision.duplicadasEnArchivo > 0 && <span>{t.duplicadas(revision.duplicadasEnArchivo)}</span>}
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
}: {
  resultado: { videos: number; nuevos: number; conocidos: number; lecturas: number };
  onOtro: () => void;
}) {
  const t = MESSAGES.importar.hecho;
  return (
    <section className="mt-6" aria-labelledby="paso-hecho">
      <div className="rounded-md border border-border bg-surface px-5 py-6">
        <h2 id="paso-hecho" className="text-sm font-semibold text-ink">
          {t.title}
        </h2>
        <p className="mt-1 font-mono text-2xl tabular-nums text-ink">{t.resumen(resultado.videos, resultado.lecturas)}</p>
        <ul className="mt-2 space-y-0.5 text-sm text-ink-2">
          {resultado.nuevos > 0 && <li>{t.nuevos(resultado.nuevos)}</li>}
          {resultado.conocidos > 0 && <li>{t.conocidos(resultado.conocidos)}</li>}
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
