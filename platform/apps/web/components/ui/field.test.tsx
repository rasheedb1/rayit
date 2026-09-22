import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DateInput } from "./date-input";
import { Field, Input, Select, Textarea } from "./field";
import { displayMoney, MoneyInput, parseMoneyText } from "./money-input";

describe("Field", () => {
  it("enlaza etiqueta, ayuda y control", () => {
    render(
      <Field label="Marca" help="Como aparece en la factura">
        <Input placeholder="Café Alma" />
      </Field>,
    );
    const input = screen.getByLabelText("Marca");
    expect(input).toHaveAccessibleDescription("Como aparece en la factura");
    expect(input).not.toHaveAttribute("aria-invalid");
  });
  it("con error: aria-invalid, mensaje en rol alert y descrito por él", () => {
    render(
      <Field label="Monto" error="Escribe un monto mayor a cero" required>
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText(/Monto/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toBeRequired();
    expect(screen.getByRole("alert")).toHaveTextContent("Escribe un monto mayor a cero");
    expect(input).toHaveAccessibleDescription("Escribe un monto mayor a cero");
  });
  it("con ayuda y error a la vez, solo referencia el error (la ayuda no se pinta)", () => {
    render(
      <Field label="Monto" help="Sin IVA" error="Escribe un monto">
        <Input />
      </Field>,
    );
    const input = screen.getByLabelText("Monto");
    const ids = (input.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    expect(ids).toHaveLength(1);
    expect(document.getElementById(ids[0]!)).toHaveTextContent("Escribe un monto");
    expect(screen.queryByText("Sin IVA")).not.toBeInTheDocument();
  });
  it("Select y Textarea toman el id del Field", () => {
    render(
      <>
        <Field label="Etapa">
          <Select options={[{ value: "nuevo", label: "Nuevo" }]} placeholder="Elige" />
        </Field>
        <Field label="Notas">
          <Textarea />
        </Field>
      </>,
    );
    expect(screen.getByLabelText("Etapa")).toBeInstanceOf(HTMLSelectElement);
    expect(screen.getByLabelText("Notas")).toBeInstanceOf(HTMLTextAreaElement);
  });
});

describe("parseMoneyText", () => {
  it("normaliza formatos de entrada", () => {
    expect(parseMoneyText("5200000")).toBe("5200000.00");
    expect(parseMoneyText("5.200.000,50")).toBe("5200000.50");
    expect(parseMoneyText("5,200,000.50")).toBe("5200000.50");
    expect(parseMoneyText("5200000.5")).toBe("5200000.50");
    expect(parseMoneyText("5.200.000")).toBe("5200000.00");
    expect(parseMoneyText("1,5")).toBe("1.50");
    expect(parseMoneyText("COP 850.000")).toBe("850000.00");
    expect(parseMoneyText("-1.100.000,25")).toBe("-1100000.25");
    expect(parseMoneyText("")).toBeNull();
    expect(parseMoneyText("abc")).toBeNull();
  });
  it("displayMoney", () => {
    expect(displayMoney("5200000.00")).toBe("5.200.000");
    expect(displayMoney("5200000.50")).toBe("5.200.000,50");
    expect(displayMoney("")).toBe("");
  });
});

describe("MoneyInput", () => {
  it("escribir 5200000 emite 5200000.00", () => {
    const onChange = vi.fn();
    render(<MoneyInput value="" currency="COP" onChange={onChange} aria-label="Monto" />);
    const input = screen.getByRole("textbox");
    expect(input).toHaveAttribute("type", "text");
    expect(input).toHaveAttribute("inputmode", "decimal");
    fireEvent.change(input, { target: { value: "5200000" } });
    expect(onChange).toHaveBeenLastCalledWith("5200000.00", "COP");
  });
  it("pegar 5.200.000,50 emite 5200000.50", () => {
    const onChange = vi.fn();
    render(<MoneyInput value="" currency="COP" onChange={onChange} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "5.200.000,50" } });
    expect(onChange).toHaveBeenLastCalledWith("5200000.50", "COP");
  });
  it("muestra el valor con separador de miles y reformatea al salir", () => {
    render(<MoneyInput value="5200000.50" currency="COP" onChange={() => {}} />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("5.200.000,50");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "12" } });
    expect(input.value).toBe("12");
    fireEvent.blur(input);
    expect(input.value).toBe("5.200.000,50");
  });
});

describe("DateInput", () => {
  it("emite la fecha ISO", () => {
    const onChange = vi.fn();
    render(
      <Field label="Vence">
        <DateInput value="2026-09-20" onChange={onChange} />
      </Field>,
    );
    const input = screen.getByLabelText("Vence");
    expect(input).toHaveAttribute("type", "date");
    fireEvent.change(input, { target: { value: "2026-10-01" } });
    expect(onChange).toHaveBeenCalledWith("2026-10-01");
  });
});
