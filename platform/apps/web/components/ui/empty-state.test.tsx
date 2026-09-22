import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataAsOf } from "./data-as-of";
import { EmptyState } from "./empty-state";

describe("EmptyState", () => {
  it("título, descripción y acción como enlace", () => {
    render(<EmptyState title="Sin conexiones" description="Conecta una red para ver datos." action={{ label: "Conectar", href: "/conexiones" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("Sin conexiones");
    expect(screen.getByRole("link", { name: "Conectar" })).toHaveAttribute("href", "/conexiones");
  });
  it("solo título", () => {
    render(<EmptyState title="Nada por cobrar" />);
    expect(screen.getByText("Nada por cobrar")).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});

describe("DataAsOf", () => {
  it("«datos hasta el 20 sep · Instagram» con <time>", () => {
    render(<DataAsOf date="2026-09-20T00:00:00Z" source="Instagram" />);
    expect(screen.getByText(/datos hasta el/).textContent).toBe("datos hasta el 20 sep · Instagram");
    expect(document.querySelector("time")).toHaveAttribute("dateTime", "2026-09-20T00:00:00Z");
  });
  it("sin fuente", () => {
    render(<DataAsOf date="2026-01-05" />);
    expect(screen.getByText(/datos hasta el/).textContent).toBe("datos hasta el 5 ene");
  });
});
