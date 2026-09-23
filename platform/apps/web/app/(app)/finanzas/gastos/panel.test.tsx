import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La lista del mes y el formulario en la misma pantalla: que la tabla
 * diga lo que hay, que el vacío no pinte un cero, y que «Editar» abra el
 * formulario YA lleno con el gasto de la fila (que es lo que rompería si
 * alguien cambia el modelo que cruza la frontera servidor → cliente).
 *
 * La acción se sustituye: aquí no se prueba la escritura (eso es
 * actions.test.ts y las pruebas de @mc/db), sino qué se ve.
 */
const guardarGasto = vi.fn();
vi.mock("./actions", () => ({ guardarGasto: (...a: unknown[]) => guardarGasto(...a) }));

import { MESSAGES } from "../_lib/messages";
import { GastosPanel } from "./panel";
import type { GastoVista } from "./_lib/vista";

const T = MESSAGES.gastos;

function gasto(over: Partial<GastoVista> = {}): GastoVista {
  return {
    id: "00000003-0000-4000-8000-0009a5090002",
    concepto: "Suscripciones · septiembre",
    conceptoEsRelleno: false,
    proveedor: "Adobe · CapCut",
    sinProveedor: false,
    categoria: "Software y suscripciones",
    fecha: "1 sep",
    monto: "COP 380.000",
    recurrente: true,
    recurrencia: "Cada mes",
    deducible: true,
    receiptUrl: null,
    crudo: {
      category: "software",
      vendor: "Adobe · CapCut",
      description: "Suscripciones · septiembre",
      amount: "380000.00",
      incurredOn: "2026-09-01",
      isRecurring: true,
      recurrence: "monthly",
      deductible: true,
      receiptUrl: "",
    },
    ...over,
  };
}

function pintar(gastos: GastoVista[], over: Partial<Parameters<typeof GastosPanel>[0]> = {}) {
  render(<GastosPanel gastos={gastos} currency="COP" hoy="2026-09-23" otraMoneda={0} esMesActual puedeRegistrar {...over} />);
}

/**
 * La fila que contiene ese texto. `getByRole("row", { name })` calcula el
 * nombre accesible de CADA fila y en jsdom tarda segundos; esto busca el
 * texto y sube al <tr>, que es lo mismo y es inmediato. Por la misma
 * razón el formulario se busca por su rol sin `name` (solo hay uno) y el
 * título se comprueba aparte.
 */
function filaCon(texto: string | RegExp): HTMLElement {
  const tr = screen.getByText(texto).closest("tr");
  if (!tr) throw new Error(`El texto ${String(texto)} no está en una fila de la tabla.`);
  return tr;
}

function formularioAbierto(titulo: string): HTMLElement {
  const form = screen.getByRole("form");
  expect(within(form).getByRole("heading")).toHaveTextContent(titulo);
  return form;
}

beforeEach(() => {
  guardarGasto.mockReset().mockResolvedValue({});
});

describe("la tabla del mes", () => {
  it("cada fila lleva el concepto, el proveedor, la categoría, la fecha y el monto ya formateados", () => {
    pintar([gasto()]);
    const fila = filaCon("Suscripciones · septiembre");
    expect(within(fila).getByText("Adobe · CapCut")).toBeInTheDocument();
    expect(within(fila).getByText("Software y suscripciones")).toBeInTheDocument();
    expect(within(fila).getByText("1 sep")).toBeInTheDocument();
    expect(within(fila).getByText("COP 380.000")).toBeInTheDocument();
  });

  it("un recurrente dice cada cuánto; un puntual dice que es una vez", () => {
    pintar([gasto(), gasto({ id: "otro", concepto: "Trípode", recurrente: false, recurrencia: null, deducible: false })]);
    expect(screen.getByText("Cada mes")).toBeInTheDocument();
    expect(screen.getByText(T.tabla.puntual)).toBeInTheDocument();
    expect(screen.getByText(T.tabla.deducible)).toBeInTheDocument();
    expect(screen.getByText(T.tabla.noDeducible)).toBeInTheDocument();
  });

  it("sin recibo lo dice con una frase; con recibo es un enlace que no filtra el referente", () => {
    pintar([gasto(), gasto({ id: "con", concepto: "Micrófono", receiptUrl: "https://drive.example.com/r" })]);
    expect(screen.getByText(T.tabla.sinRecibo)).toBeInTheDocument();
    const enlace = screen.getByRole("link", { name: T.tabla.recibo });
    expect(enlace).toHaveAttribute("href", "https://drive.example.com/r");
    expect(enlace).toHaveAttribute("rel", "noreferrer noopener");
    expect(enlace).toHaveAttribute("target", "_blank");
  });

  it("los gastos en otra moneda se cuentan con una frase, no se esconden ni se suman", () => {
    pintar([gasto()], { otraMoneda: 2 });
    expect(screen.getByText(T.tabla.otraMoneda(2), { exact: false })).toBeInTheDocument();
    pintar([gasto()], { otraMoneda: 1 });
    expect(screen.getByText(T.tabla.otraMoneda(1), { exact: false })).toBeInTheDocument();
  });
});

describe("el mes sin gastos", () => {
  it("dice qué falta y ofrece registrar el primero, sin un cero", () => {
    pintar([]);
    expect(screen.getByText(T.vacio.titulo)).toBeInTheDocument();
    expect(screen.getByText(T.vacio.descripcion)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: T.vacio.accion })).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
    expect(screen.queryByText("COP 0")).not.toBeInTheDocument();
  });

  it("si el mes no es el de hoy, sugiere mirar otro en vez de invitar a registrar ahí", () => {
    pintar([], { esMesActual: false });
    expect(screen.getByText(T.vacio.otroMes)).toBeInTheDocument();
    expect(screen.queryByText(T.vacio.descripcion)).not.toBeInTheDocument();
  });
});

describe("el formulario en la misma pantalla", () => {
  it("«Nuevo gasto» lo abre vacío, con la fecha de hoy y la moneda del espacio", () => {
    pintar([gasto()]);
    fireEvent.click(screen.getByRole("button", { name: T.header.nuevo }));
    const form = formularioAbierto(T.form.tituloNuevo);
    expect(within(form).getByLabelText(/Fecha del gasto/)).toHaveValue("2026-09-23");
    expect(within(form).getByLabelText(T.form.moneda)).toHaveValue("COP");
    expect(within(form).getByLabelText(/Categoría/)).toHaveValue("");
    // El botón de abrir desaparece mientras el formulario está abierto: no hay dos.
    expect(screen.queryByRole("button", { name: T.header.nuevo })).not.toBeInTheDocument();
  });

  it("«Editar» lo abre con los valores del gasto de ESA fila", () => {
    pintar([gasto(), gasto({ id: "otro", concepto: "Micrófono", crudo: { ...gasto().crudo, category: "equipo", amount: "890000.00", incurredOn: "2026-07-14", isRecurring: false, recurrence: "", vendor: "DJI", description: "Micrófono DJI" } })]);
    const filaMicro = filaCon("Micrófono");
    fireEvent.click(within(filaMicro).getByRole("button", { name: T.tabla.editar }));

    const form = formularioAbierto(T.form.tituloEditar);
    expect(within(form).getByLabelText(/Categoría/)).toHaveValue("equipo");
    expect(within(form).getByLabelText(/Fecha del gasto/)).toHaveValue("2026-07-14");
    expect(within(form).getByLabelText(T.form.proveedor)).toHaveValue("DJI");
    expect(within(form).getByLabelText(T.form.descripcion)).toHaveValue("Micrófono DJI");
    // No es recurrente: el «cada cuánto» ni aparece.
    expect(within(form).getByLabelText(T.form.recurrente)).not.toBeChecked();
    expect(within(form).queryByLabelText(new RegExp(T.form.recurrencia))).not.toBeInTheDocument();
    // Y se dice que los gastos no se borran.
    expect(within(form).getByText(T.form.ayudaEditar)).toBeInTheDocument();
  });

  it("marcar «se repite» pide cada cuánto, y desmarcarlo lo quita", () => {
    pintar([]);
    fireEvent.click(screen.getByRole("button", { name: T.vacio.accion }));
    const casilla = screen.getByLabelText(T.form.recurrente);
    // La etiqueta de un campo obligatorio lleva además «*» y «(obligatorio)»: regex, no texto exacto.
    const cadaCuanto = new RegExp(T.form.recurrencia);
    expect(screen.queryByLabelText(cadaCuanto)).not.toBeInTheDocument();
    fireEvent.click(casilla);
    expect(screen.getByLabelText(cadaCuanto)).toHaveValue("monthly");
    fireEvent.click(casilla);
    expect(screen.queryByLabelText(cadaCuanto)).not.toBeInTheDocument();
  });

  it("pasar de «Editar» una fila a otra NO arrastra los valores de la primera", () => {
    const b = gasto({
      id: "bbb",
      concepto: "Micrófono",
      deducible: false,
      crudo: { ...gasto().crudo, category: "equipo", vendor: "DJI", description: "Micrófono DJI", amount: "890000.00", incurredOn: "2026-07-14", isRecurring: false, recurrence: "", deductible: false },
    });
    pintar([gasto(), b]);
    fireEvent.click(within(filaCon("Suscripciones · septiembre")).getByRole("button", { name: T.tabla.editar }));
    expect(screen.getByLabelText(/Categoría/)).toHaveValue("software");
    fireEvent.click(within(filaCon("Micrófono")).getByRole("button", { name: T.tabla.editar }));

    const form = formularioAbierto(T.form.tituloEditar);
    expect(within(form).getByRole("textbox", { name: T.form.proveedor })).toHaveValue("DJI");
    expect(within(form).getByLabelText(/Categoría/)).toHaveValue("equipo");
    expect(within(form).getByLabelText(/Fecha del gasto/)).toHaveValue("2026-07-14");
    // Y el gastoId oculto es el de la segunda, no el de la primera.
    expect(form.querySelector('input[name="gastoId"]')).toHaveValue("bbb");
  });

  it("un gasto que NO es deducible abre con la casilla apagada, no la enciende al corregirlo", () => {
    pintar([gasto({ deducible: false, crudo: { ...gasto().crudo, deductible: false } })]);
    fireEvent.click(screen.getByRole("button", { name: T.tabla.editar }));
    expect(screen.getByLabelText(T.form.deducible)).not.toBeChecked();
  });

  it("«Cancelar» lo cierra sin escribir nada", () => {
    pintar([gasto()]);
    fireEvent.click(screen.getByRole("button", { name: T.header.nuevo }));
    fireEvent.click(screen.getByRole("button", { name: T.form.cancelar }));
    expect(screen.queryByRole("form")).not.toBeInTheDocument();
    expect(guardarGasto).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: T.header.nuevo })).toBeInTheDocument();
  });
});

describe("sin finanzas.gasto.registrar", () => {
  it("no hay «Nuevo gasto» ni «Editar», y la frase dice por qué", () => {
    pintar([gasto()], { puedeRegistrar: false });
    expect(screen.queryByRole("button", { name: T.header.nuevo })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: T.tabla.editar })).not.toBeInTheDocument();
    expect(screen.getByText(T.form.sinPermiso)).toBeInTheDocument();
  });
});
