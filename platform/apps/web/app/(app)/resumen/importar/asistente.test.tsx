import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportableAccount } from "@mc/db/queries/resumen";

// La Server Action se sustituye: aquí importa el recorrido de la
// pantalla, no lo que escribe Postgres (eso lo prueba @mc/db).
const importarCsv = vi.fn();
const buscarPostsConocidos = vi.fn();
vi.mock("./actions", () => ({
  importarCsv: (...args: unknown[]) => importarCsv(...args),
  buscarPostsConocidos: (...args: unknown[]) => buscarPostsConocidos(...args),
}));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

import { Asistente } from "./asistente";

const WORKSPACE = { locale: "es-CO", currency: "COP", timezone: "America/Bogota" };
const CUENTA_IG: ImportableAccount = {
  connectionId: "00000002-0000-4000-8000-0000000000c1",
  platformId: "instagram",
  handle: "laura.cocinafacil",
  displayName: "Laura · Cocina fácil",
  accessMode: "direct_oauth",
  posts: 1234,
};

const fixture = (nombre: string) => readFileSync(join(__dirname, "../../../../test/fixtures/csv", nombre), "utf8");

/** Sube un texto como archivo por el input oculto y espera al paso 2. */
async function subirTexto(nombre: string, texto: string) {
  const archivo = new File([texto], nombre, { type: "text/csv" });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [archivo] } });
  await screen.findByText(/Qué es cada columna/);
}

/** Sube un fixture y espera al paso 2. */
const subir = (nombre: string) => subirTexto(nombre, fixture(nombre));

beforeEach(() => {
  importarCsv.mockReset();
  buscarPostsConocidos.mockReset();
  // Por defecto, la base no dice nada: la previsualización vale igual.
  buscarPostsConocidos.mockResolvedValue({ ok: false });
  refresh.mockReset();
});

describe("el asistente de importación", () => {
  it("reconoce el archivo, lo premapea y elige la cuenta de esa red", async () => {
    render(<Asistente cuentas={[CUENTA_IG]} workspace={WORKSPACE} />);
    expect(screen.getByText("Elige el archivo")).toBeInTheDocument();

    await subir("instagram-insights.csv");

    expect(screen.getByText(/Parece una exportación de Instagram Insights/)).toBeInTheDocument();
    // El mapeo automático quedó puesto en los selectores.
    expect(screen.getByLabelText("Fecha de publicación")).toHaveValue("Publish time");
    expect(screen.getByLabelText("Alcance (cuentas alcanzadas)")).toHaveValue("Accounts reached");
    // Con una sola cuenta de Instagram, se elige sola.
    expect(screen.getByLabelText("¿A qué cuenta pertenece?")).toHaveValue(CUENTA_IG.connectionId);
    // Y su número de videos sale formateado con el locale, no «1234».
    expect(screen.getByRole("option", { name: "@laura.cocinafacil · 1.234 videos" })).toBeInTheDocument();
    // Las fechas del archivo son ISO: no hay orden día/mes que preguntar.
    expect(screen.queryByRole("group", { name: "Orden de las fechas" })).not.toBeInTheDocument();
  });

  it("no deja pasar al paso 3 mientras falte una columna obligatoria", async () => {
    render(<Asistente cuentas={[CUENTA_IG]} workspace={WORKSPACE} />);
    await subir("instagram-insights.csv");

    fireEvent.change(screen.getByLabelText("Fecha de publicación"), { target: { value: "" } });
    expect(screen.getByText(/Falta decir qué columna es: fecha de publicación/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Siguiente" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Fecha de publicación"), { target: { value: "Publish time" } });
    expect(screen.getByRole("button", { name: "Siguiente" })).toBeEnabled();
  });

  it("un archivo desconocido pide la red y el mapeo, y después importa", async () => {
    render(<Asistente cuentas={[]} workspace={WORKSPACE} />);
    await subir("desconocido.csv");

    expect(screen.getByText(/No reconocimos el formato/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Siguiente" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Identificador del video"), { target: { value: "Referencia interna" } });
    fireEvent.change(screen.getByLabelText("Fecha de publicación"), { target: { value: "Publicado el" } });
    // Sin cuentas en la base hay que nombrar la que se crea.
    fireEvent.change(screen.getByLabelText("Nombre de usuario de la cuenta"), { target: { value: "@laura.cocinafacil" } });

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(await screen.findByText("3 de 3 filas listas")).toBeInTheDocument();

    importarCsv.mockResolvedValue({
      ok: true,
      resultado: { newPosts: 3, knownPosts: 0, readings: 3, staleReadings: 0, capturedAt: "2026-09-22T16:00:00.000000Z" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    await waitFor(() => expect(importarCsv).toHaveBeenCalledTimes(1));
    const enviado = importarCsv.mock.calls[0]?.[0] as Record<string, unknown>;
    // Viaja el TEXTO del archivo y el mapeo: el servidor vuelve a validar.
    expect(enviado.texto).toContain("Referencia interna");
    expect(enviado.handleNuevo).toBe("laura.cocinafacil"); // sin la arroba
    expect(enviado.connectionId).toBeUndefined();
    expect(enviado.mapeo).toMatchObject({ externalPostId: "Referencia interna", publishedAt: "Publicado el" });

    expect(await screen.findByText("3 videos, 3 lecturas.")).toBeInTheDocument();
    expect(refresh).toHaveBeenCalled();
  });

  it("enseña las filas que no entran antes de escribir nada", async () => {
    render(<Asistente cuentas={[CUENTA_IG]} workspace={WORKSPACE} />);
    await subir("sucio.csv");
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    expect(await screen.findByText("3 de 7 filas listas")).toBeInTheDocument();
    expect(screen.getByText("4 filas no se pueden importar")).toBeInTheDocument();
    expect(screen.getByText("1 fila repetida en el archivo")).toBeInTheDocument();
    const tabla = screen.getByRole("table");
    expect(within(tabla).getAllByText("No entra")).toHaveLength(4);
    // La fila que no entra enseña lo que traía, para poder buscarla en
    // el archivo: su fecha cruda y el motivo, no un «—».
    expect(within(tabla).getByText("el martes pasado")).toBeInTheDocument();
    expect(within(tabla).getByText(/No se entiende la fecha «el martes pasado»/)).toBeInTheDocument();
    expect(within(tabla).getByText("Sin id y sin enlace")).toBeInTheDocument();
    // Nada se ha escrito todavía: la acción no se ha llamado.
    expect(importarCsv).not.toHaveBeenCalled();
  });

  it("un archivo que pasa del techo se rechaza al subirlo, no al final", async () => {
    render(<Asistente cuentas={[CUENTA_IG]} workspace={WORKSPACE} />);
    // 5 MB y un byte: más de lo que la server action acepta.
    const grande = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "enorme.csv", { type: "text/csv" });
    fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [grande] } });
    expect(await screen.findByRole("alert")).toHaveTextContent("El archivo pesa más de 5 MB");
    expect(screen.getByText("Elige el archivo")).toBeInTheDocument();
  });

  it("con fechas que sirven en los dos órdenes y un formato desconocido, propone el del workspace y envía el elegido", async () => {
    render(<Asistente cuentas={[]} workspace={WORKSPACE} />);
    await subirTexto(
      "propio.csv",
      "Referencia,Publicado el,Reproducciones\npub-1,09/05/2025 15:04,10\npub-2,10/09/2025 12:30,20\n",
    );

    fireEvent.change(screen.getByLabelText("Identificador del video"), { target: { value: "Referencia" } });
    fireEvent.change(screen.getByLabelText("Fecha de publicación"), { target: { value: "Publicado el" } });
    fireEvent.change(screen.getByLabelText("Nombre de usuario de la cuenta"), { target: { value: "propia" } });

    const orden = screen.getByRole("group", { name: "Orden de las fechas" });
    // es-CO: día/mes, y se enseña cómo queda una fecha real del archivo.
    expect(within(orden).getByRole("button", { name: "Día/Mes" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Di cuál usa tu exportación/)).toBeInTheDocument();
    expect(screen.getByText("«09/05/2025 15:04» se lee como 9 de mayo de 2025.")).toBeInTheDocument();

    fireEvent.click(within(orden).getByRole("button", { name: "Mes/Día" }));
    expect(screen.getByText("«09/05/2025 15:04» se lee como 5 de septiembre de 2025.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("2 de 2 filas listas");
    importarCsv.mockResolvedValue({
      ok: true,
      resultado: { newPosts: 2, knownPosts: 0, readings: 2, staleReadings: 0, capturedAt: "2026-09-22T16:00:00.000000Z" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(importarCsv).toHaveBeenCalledTimes(1));
    expect((importarCsv.mock.calls[0]?.[0] as { ordenFechas: string }).ordenFechas).toBe("md");
  });

  it("un archivo de Instagram ambiguo se propone en mes/día, que es como escribe Meta, no en el orden del workspace", async () => {
    render(<Asistente cuentas={[CUENTA_IG]} workspace={WORKSPACE} />);
    await subir("instagram-insights-meta.csv");

    const orden = screen.getByRole("group", { name: "Orden de las fechas" });
    expect(within(orden).getByRole("button", { name: "Mes/Día" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/Instagram Insights las escribe en orden mes\/día/)).toBeInTheDocument();
    expect(screen.getByText("«09/03/2026 15:04» se lee como 3 de septiembre de 2026.")).toBeInTheDocument();
    // La fecha de exportación sale de la columna «Date», leída en el mismo orden.
    expect(screen.getByLabelText("Fecha de la exportación")).toHaveValue("2026-09-12");

    // Si alguien la cambia a día/mes, el paso 3 le avisa de que las fechas se dispersan.
    fireEvent.click(within(orden).getByRole("button", { name: "Día/Mes" }));
    fireEvent.change(screen.getByLabelText("Fecha de la exportación"), { target: { value: "2026-09-12" } });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    expect(await screen.findByText(/Leídas en orden día\/mes, las fechas de este archivo quedan a meses/)).toBeInTheDocument();
  });

  it("si el archivo demuestra su orden, lo dice y no pregunta", async () => {
    render(<Asistente cuentas={[]} workspace={WORKSPACE} />);
    await subir("tiktok-studio-en-us.csv");
    expect(screen.queryByRole("group", { name: "Orden de las fechas" })).not.toBeInTheDocument();
    expect(screen.getByText(/orden mes\/día: lo demuestra el propio archivo/)).toBeInTheDocument();
    expect(screen.getByText("«09/05/2026 19:30» se lee como 5 de septiembre de 2026.")).toBeInTheDocument();
  });

  it("avisa de los videos que YA están en la cuenta antes de escribir nada", async () => {
    buscarPostsConocidos.mockResolvedValue({
      ok: true,
      ids: ["ig_18001122334455001", "ig_18001122334455002"],
    });
    render(<Asistente cuentas={[CUENTA_IG]} workspace={WORKSPACE} />);
    await subir("instagram-insights.csv");

    await waitFor(() => expect(buscarPostsConocidos).toHaveBeenCalled());
    const preguntado = buscarPostsConocidos.mock.calls[0]?.[0] as { connectionId: string; ids: string[] };
    expect(preguntado.connectionId).toBe(CUENTA_IG.connectionId);
    expect(preguntado.ids).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    // El paso 3 lo dice antes de confirmar, no el resumen del paso 4.
    expect(await screen.findByText("2 ya estaban: se les añade una lectura")).toBeInTheDocument();
    const tabla = screen.getByRole("table");
    expect(within(tabla).getAllByText("Con aviso")).toHaveLength(2);
    expect(within(tabla).getAllByText(/Este video ya está/)).toHaveLength(2);
    expect(importarCsv).not.toHaveBeenCalled();
  });

  it("si la escritura falla, lo dice y no finge que terminó", async () => {
    render(<Asistente cuentas={[CUENTA_IG]} workspace={WORKSPACE} />);
    await subir("instagram-insights.csv");
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("3 de 3 filas listas");

    importarCsv.mockResolvedValue({ ok: false, error: "No se pudo importar." });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo importar.");
    expect(screen.queryByText(/videos,/)).not.toBeInTheDocument();
  });

  it("si la acción ni siquiera responde, la pantalla lo dice y conserva el trabajo", async () => {
    // Lo que pasa cuando Next rechaza el cuerpo por tamaño: la promesa
    // se rompe. Sin try/catch subía a la frontera de error y se llevaba
    // por delante el archivo, el mapeo y la revisión.
    render(<Asistente cuentas={[CUENTA_IG]} workspace={WORKSPACE} />);
    await subir("instagram-insights.csv");
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("3 de 3 filas listas");

    importarCsv.mockRejectedValue(new Error("Body exceeded 1 MB limit"));
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("No se pudo importar.");
    // Sigue en el paso 3, con la revisión entera delante.
    expect(screen.getByText("3 de 3 filas listas")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.queryByText(/videos,/)).not.toBeInTheDocument();
  });
});

describe("la fecha de la exportación", () => {
  it("se propone desde la columna del informe, se valida y viaja a la acción", async () => {
    render(<Asistente cuentas={[CUENTA_IG]} workspace={WORKSPACE} />);
    await subir("instagram-insights.csv");

    const fecha = screen.getByLabelText("Fecha de la exportación");
    expect(fecha).toHaveValue("2026-09-22");
    expect(screen.getByText(/Propuesta a partir de la columna «Date» del archivo/)).toBeInTheDocument();

    // Antes que el video más reciente del archivo (15 de septiembre): no vale.
    fireEvent.change(fecha, { target: { value: "2026-09-14" } });
    expect(screen.getByRole("alert")).toHaveTextContent("No puede ser anterior al video más reciente del archivo.");
    expect(screen.getByRole("button", { name: "Siguiente" })).toBeDisabled();

    fireEvent.change(fecha, { target: { value: "2026-09-16" } });
    expect(screen.getByRole("button", { name: "Siguiente" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("3 de 3 filas listas");

    importarCsv.mockResolvedValue({
      ok: true,
      resultado: { newPosts: 1, knownPosts: 2, readings: 1, staleReadings: 2, capturedAt: "2026-09-16T17:00:00.000Z" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(importarCsv).toHaveBeenCalledTimes(1));
    expect((importarCsv.mock.calls[0]?.[0] as { fechaExportacion: string }).fechaExportacion).toBe("2026-09-16");

    // El paso 4 dice cuántas lecturas eran más viejas que las que ya había, y con qué fecha quedó.
    expect(await screen.findByText(/2 lecturas eran más antiguas que las que ya había/)).toBeInTheDocument();
    expect(screen.getByText("Con fecha de exportación 16 de septiembre de 2026.")).toBeInTheDocument();
  });

  it("una fecha del futuro no deja seguir", async () => {
    render(<Asistente cuentas={[CUENTA_IG]} workspace={WORKSPACE} />);
    await subir("instagram-insights.csv");
    fireEvent.change(screen.getByLabelText("Fecha de la exportación"), { target: { value: "2099-01-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("No puede ser posterior a hoy.");
    expect(screen.getByRole("button", { name: "Siguiente" })).toBeDisabled();
  });
});

describe("YouTube Studio tal como exporta", () => {
  it("lee «Sep 5, 2026» y deja fuera la fila «Total» sin llamarla error", async () => {
    render(<Asistente cuentas={[]} workspace={WORKSPACE} />);
    await subir("youtube-studio.csv");
    expect(screen.getByText(/Parece una exportación de YouTube Studio/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Nombre de usuario de la cuenta"), { target: { value: "laura.yt" } });
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));

    expect(await screen.findByText("3 de 3 filas listas")).toBeInTheDocument();
    expect(screen.getByText("1 fila de totales ignorada")).toBeInTheDocument();
    expect(screen.queryByText(/no se pueden importar|no se puede importar/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("table")).getAllByText("Lista")).toHaveLength(3);
  });
});

describe("teclado y lector de pantalla", () => {
  it("al cambiar de paso, el foco va al título del paso nuevo y el cambio se anuncia", async () => {
    render(<Asistente cuentas={[CUENTA_IG]} workspace={WORKSPACE} />);
    await subir("instagram-insights.csv");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Qué es cada columna" })));
    expect(screen.getByText("Paso 2 de 4: Formato")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("3 de 3 filas listas");
    // Ni en <body> ni arriba del todo: en la tabla que hay que revisar.
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Esto es lo que se va a guardar" }));
    expect(screen.getByText("Paso 3 de 4: Revisar")).toBeInTheDocument();

    importarCsv.mockResolvedValue({
      ok: true,
      resultado: { newPosts: 3, knownPosts: 0, readings: 3, staleReadings: 0, capturedAt: "2026-09-22T16:00:00.000Z" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await screen.findByText("3 videos, 3 lecturas.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Listo" })));
  });

  it("en la revisión, el estado es la segunda columna: a 400 px no queda cortado en el borde", async () => {
    render(<Asistente cuentas={[CUENTA_IG]} workspace={WORKSPACE} />);
    await subir("sucio.csv");
    fireEvent.click(screen.getByRole("button", { name: "Siguiente" }));
    await screen.findByText("3 de 7 filas listas");
    const cabeceras = within(screen.getByRole("table")).getAllByRole("columnheader").map((c) => c.textContent);
    expect(cabeceras.slice(0, 2)).toEqual(["Fila", "Estado"]);
    // La fecha que no se entiende va en una línea, entera en el title.
    const cruda = within(screen.getByRole("table")).getByText("el martes pasado");
    expect(cruda).toHaveAttribute("title", "el martes pasado");
    expect(cruda.className).toMatch(/truncate/);
  });
});
