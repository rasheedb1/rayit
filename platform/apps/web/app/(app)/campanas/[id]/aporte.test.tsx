import { configure, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Estas pruebas montan dos formularios con Server Actions simuladas y
 * esperan a que React aplique el resultado. En una máquina cargada (varias
 * sesiones corriendo pruebas a la vez) la primera pasa de 5 s y las
 * esperas de 1 s de testing-library se quedan cortas: se alargan aquí,
 * solo para este archivo.
 */
const LARGO = { timeout: 30_000 };
configure({ asyncUtilTimeout: 10_000 });

const registrarAporte = vi.fn();
const importarCsvVentas = vi.fn();
vi.mock("./actions", () => ({
  registrarAporte: (...args: unknown[]) => registrarAporte(...args),
  importarCsvVentas: (...args: unknown[]) => importarCsvVentas(...args),
}));

import { ImportarCsvForm, RegistrarAporteForm } from "./aporte";

const CAMPANA = "00000003-0000-4000-8000-000000ca0002";
/** La ventana de Fresko, ya formateada como la pasa la página. */
const FRESKO = { from: "26 ago", to: "8 nov" };

beforeEach(() => {
  registrarAporte.mockReset();
  importarCsvVentas.mockReset();
});

describe("RegistrarAporteForm", () => {
  it("cerrado muestra solo el botón; abierto manda kind, fecha (hoy por defecto) y cifra entera, y al guardar cierra y avisa", LARGO, async () => {
    registrarAporte.mockResolvedValue({ ok: true, notice: "Aporte registrado." });
    render(<RegistrarAporteForm campaignId={CAMPANA} currency="COP" today="2026-09-23" />);
    expect(screen.queryByLabelText(/Qué reporta/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Registrar aporte" }));
    fireEvent.change(screen.getByLabelText(/Qué reporta/), { target: { value: "code_redemptions" } });
    expect(screen.getByLabelText(/A qué fecha/)).toHaveValue("2026-09-23");
    fireEvent.change(screen.getByLabelText(/Cifra/), { target: { value: "40" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(registrarAporte).toHaveBeenCalledTimes(1));
    const formData = registrarAporte.mock.calls[0]?.[1] as FormData;
    expect(formData.get("campaignId")).toBe(CAMPANA);
    expect(formData.get("kind")).toBe("code_redemptions");
    expect(formData.get("day")).toBe("2026-09-23");
    expect(formData.get("value")).toBe("40");
    expect(formData.get("currency")).toBe("");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Aporte registrado."));
    expect(screen.queryByLabelText(/Qué reporta/)).not.toBeInTheDocument();
  });

  it("con «Ingresos» la cifra es dinero con la moneda de la campaña propuesta, y viaja como decimal", LARGO, async () => {
    registrarAporte.mockResolvedValue({ ok: true, notice: "Se guardó en USD; la campaña está en COP." });
    render(<RegistrarAporteForm campaignId={CAMPANA} currency="COP" today="2026-09-23" />);
    fireEvent.click(screen.getByRole("button", { name: "Registrar aporte" }));
    fireEvent.change(screen.getByLabelText(/Qué reporta/), { target: { value: "revenue" } });
    const moneda = screen.getByLabelText(/Moneda/);
    expect(moneda).toHaveValue("COP");
    fireEvent.change(moneda, { target: { value: "usd" } });
    fireEvent.change(screen.getByLabelText(/Cifra/), { target: { value: "1.500.000,50" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(registrarAporte).toHaveBeenCalledTimes(1));
    const formData = registrarAporte.mock.calls[0]?.[1] as FormData;
    expect(formData.get("kind")).toBe("revenue");
    expect(formData.get("value")).toBe("1500000.50");
    expect(formData.get("currency")).toBe("USD");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Se guardó en USD; la campaña está en COP."));
  });

  it("los errores del servidor se pintan por campo, en español, y el foco va al primero; un mensaje general deja el formulario abierto", LARGO, async () => {
    registrarAporte.mockResolvedValueOnce({ errors: { kind: "Elige qué reporta la marca.", value: "Escribe la cifra." } });
    render(<RegistrarAporteForm campaignId={CAMPANA} currency="COP" today="2026-09-23" />);
    fireEvent.click(screen.getByRole("button", { name: "Registrar aporte" }));
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    const kind = screen.getByLabelText(/Qué reporta/);
    expect(kind).toHaveAttribute("aria-invalid", "true");
    expect(kind).toHaveAccessibleDescription("Elige qué reporta la marca.");
    await waitFor(() => expect(kind).toHaveFocus());

    // Lo escrito sobrevive a una respuesta con errores (React 19 vacía los campos no controlados).
    fireEvent.change(screen.getByLabelText(/Cifra/), { target: { value: "41" } });
    fireEvent.change(screen.getByLabelText(/Nota/), { target: { value: "correo del lunes" } });
    registrarAporte.mockResolvedValueOnce({ errors: { day: "La fecha no puede ser futura." } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.getByLabelText(/A qué fecha/)).toHaveAttribute("aria-invalid", "true"));
    expect(screen.getByLabelText(/Cifra/)).toHaveValue("41");
    expect(screen.getByLabelText(/Nota/)).toHaveValue("correo del lunes");

    registrarAporte.mockResolvedValueOnce({ message: "Una campaña cerrada no admite cambios." });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Una campaña cerrada no admite cambios."));
    expect(screen.getByLabelText(/Qué reporta/)).toBeInTheDocument();
  });
});

describe("ImportarCsvForm", () => {
  it("manda el archivo con el id de la campaña, muestra el resumen con las filas rechazadas y su motivo, y «Importar otro archivo» vuelve al formulario", LARGO, async () => {
    importarCsvVentas.mockResolvedValue({
      ok: true,
      resumen: {
        inserted: 5, unchanged: 2, replaced: 1, days: 3, from: "2026-09-02", to: "2026-09-04", codificacion: "windows-1252",
        rejected: [{ line: 6, reason: "fuera_de_rango", value: "2026-08-01" }, { line: 7, reason: "fecha_ilegible", value: "el martes" }],
      },
    });
    render(<ImportarCsvForm campaignId={CAMPANA} window={FRESKO} />);
    fireEvent.click(screen.getByRole("button", { name: "Importar CSV de ventas" }));
    expect(screen.getByText(/Solo entran días entre el/)).toHaveTextContent("26 ago");
    const archivo = new File(["día,ventas\n2026-09-02,10\n"], "ventas.csv", { type: "text/csv" });
    fireEvent.change(screen.getByLabelText(/Archivo CSV/), { target: { files: [archivo] } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(importarCsvVentas).toHaveBeenCalledTimes(1));
    const formData = importarCsvVentas.mock.calls[0]?.[1] as FormData;
    expect(formData.get("campaignId")).toBe(CAMPANA);
    // jsdom construye el FormData desde su propio estado interno del input, no desde `files`
    // asignado por la prueba: llega un File vacío. Que el archivo real viaje se comprueba en dev.
    expect(formData.get("archivo")).toBeInstanceOf(File);

    const resumen = await screen.findByRole("status", { name: "Importación terminada" });
    expect(resumen).toHaveTextContent("3 días aceptados");
    expect(resumen).toHaveTextContent("5 datos nuevos");
    expect(resumen).toHaveTextContent("2 ya estaban igual");
    expect(resumen).toHaveTextContent("1 corregido con la cifra del archivo");
    expect(resumen).toHaveTextContent("2 filas rechazadas");
    expect(resumen).toHaveTextContent("Fila 6: queda fuera del rango de la campaña (2026-08-01)");
    expect(resumen).toHaveTextContent("Fila 7: la fecha no se entiende (el martes)");
    expect(resumen).toHaveTextContent("Windows-1252");
    expect(screen.queryByLabelText(/Archivo CSV/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Importar otro archivo" }));
    expect(screen.getByLabelText(/Archivo CSV/)).toBeInTheDocument();
  });

  it("si ninguna fila entró lo dice, y un error de archivo se pinta en el campo", LARGO, async () => {
    importarCsvVentas.mockResolvedValueOnce({ errors: { archivo: "Falta la columna ventas. Las cabeceras válidas son día (o fecha) y ventas; pedidos y canjes son opcionales." } });
    render(<ImportarCsvForm campaignId={CAMPANA} window={FRESKO} />);
    fireEvent.click(screen.getByRole("button", { name: "Importar CSV de ventas" }));
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Falta la columna ventas."));
    expect(screen.getByLabelText(/Archivo CSV/)).toHaveAttribute("aria-invalid", "true");

    importarCsvVentas.mockResolvedValueOnce({ ok: true, resumen: { inserted: 0, unchanged: 0, replaced: 0, days: 0, from: null, to: null, codificacion: "utf-8", rejected: [{ line: 2, reason: "ventas_vacia", value: "" }] } });
    fireEvent.click(screen.getByRole("button", { name: "Importar" }));
    const resumen = await screen.findByRole("status", { name: "Importación terminada" });
    expect(resumen).toHaveTextContent("Ninguna fila se pudo importar.");
    expect(resumen).toHaveTextContent("Fila 2: no trae ventas");
  });

  it("sin fechas en la campaña el formulario lo dice y no deja importar", () => {
    render(<ImportarCsvForm campaignId={CAMPANA} window={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Importar CSV de ventas" }));
    expect(screen.getByText(/La campaña no tiene fechas de inicio y fin/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Archivo CSV/)).toBeDisabled();
    expect(screen.getByRole("button", { name: "Importar" })).toBeDisabled();
  });
});
