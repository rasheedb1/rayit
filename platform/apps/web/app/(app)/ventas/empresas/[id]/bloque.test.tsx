import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Bloque, abrirBloqueDe } from "./bloque";

function renderBloques() {
  return render(
    <>
      <Bloque id="negocios" title="Negocios" meta="COP 12 M abiertos">
        <p>Renovación Q4</p>
      </Bloque>
      <Bloque id="actividad" title="Actividad">
        <p>Llamada con Valentina</p>
      </Bloque>
    </>,
  );
}

describe("Bloque", () => {
  it("el título es un encabezado de verdad: quien recorre la ficha con la tecla H lo encuentra", () => {
    renderBloques();
    expect(screen.getByRole("heading", { level: 2, name: "Actividad" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Negocios" })).toBeInTheDocument();
    // Y cada bloque es una región con su nombre.
    expect(screen.getByRole("region", { name: "Actividad" })).toBeInTheDocument();
  });

  it("el botón del título pliega y despliega, y dice si está abierto", () => {
    renderBloques();
    const boton = screen.getByRole("button", { name: "Actividad" });
    expect(boton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Llamada con Valentina")).toBeVisible();

    fireEvent.click(boton);
    expect(boton).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Llamada con Valentina")).not.toBeVisible();
    // El panel que controla es el que se oculta.
    const panel = document.getElementById(boton.getAttribute("aria-controls")!);
    expect(panel).toHaveAttribute("hidden");

    fireEvent.click(boton);
    expect(boton).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Llamada con Valentina")).toBeVisible();
  });

  it("el dato de al lado del título no es parte del botón ni del encabezado", () => {
    renderBloques();
    expect(screen.getByRole("button", { name: "Negocios" })).toBeInTheDocument();
    expect(screen.getByText("COP 12 M abiertos").closest("button, h2")).toBeNull();
  });

  it("algo de dentro puede pedir que se abra (el registro rápido con una tecla)", () => {
    renderBloques();
    const boton = screen.getByRole("button", { name: "Actividad" });
    fireEvent.click(boton);
    const dentro = screen.getByText("Llamada con Valentina");
    expect(abrirBloqueDe(dentro)).toBe(true);
    expect(boton).toHaveAttribute("aria-expanded", "true");
    expect(dentro).toBeVisible();
    // Abierto, no hace falta.
    expect(abrirBloqueDe(dentro)).toBe(false);
  });
});
