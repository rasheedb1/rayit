import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CuentaImportable } from "@mc/db/queries/resumen";

// La Server Action se sustituye: aquí importa el recorrido de la
// pantalla, no lo que escribe Postgres (eso lo prueba @mc/db).
const importarCsv = vi.fn();
vi.mock("./actions", () => ({ importarCsv: (...args: unknown[]) => importarCsv(...args) }));

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh, push: vi.fn() }) }));

import { Asistente } from "./asistente";

const WORKSPACE = { locale: "es-CO", currency: "COP", timezone: "America/Bogota" };
const CUENTA_IG: CuentaImportable = {
  connectionId: "00000002-0000-4000-8000-0000000000c1",
  platformId: "instagram",
  handle: "laura.cocinafacil",
  displayName: "Laura · Cocina fácil",
  accessMode: "direct_oauth",
  posts: 17,
};

const fixture = (nombre: string) => readFileSync(join(__dirname, "../../../../test/fixtures/csv", nombre), "utf8");

/** Sube un archivo por el input oculto y espera al paso 2. */
async function subir(nombre: string) {
  const archivo = new File([fixture(nombre)], nombre, { type: "text/csv" });
  const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
  fireEvent.change(input, { target: { files: [archivo] } });
  await screen.findByText(/Qué es cada columna/);
}

beforeEach(() => {
  importarCsv.mockReset();
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
      resultado: { postsNuevos: 3, postsConocidos: 0, lecturas: 3, capturadoEn: "2026-09-22T16:00:00Z" },
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
    // Nada se ha escrito todavía: la acción no se ha llamado.
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
});
