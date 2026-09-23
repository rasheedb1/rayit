import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/ventas/empresas",
  useSearchParams: () => new URLSearchParams(search),
}));

import { Buscador } from "./buscador";

beforeEach(() => {
  replace.mockReset();
  search = "";
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("Buscador de empresas", () => {
  it("la búsqueda y el filtro de relación se alinean por arriba, con ayuda o sin ella", () => {
    // Alineada por el fondo, la ayuda de la búsqueda bajaba el select.
    render(<Buscador minSearch={3} />);
    const fila = screen.getByRole("search");
    expect(fila).toHaveClass("items-start");
    expect(fila).not.toHaveClass("items-end");
  });

  it("con dos letras no busca y dice cuántas faltan", () => {
    render(<Buscador minSearch={3} />);
    fireEvent.change(screen.getByLabelText("Buscar por nombre o dominio"), { target: { value: "ca" } });
    act(() => vi.advanceTimersByTime(1000));
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("Escribe al menos 3 letras para buscar.")).toBeInTheDocument();
  });

  it("borrar de «nan» a «na» quita la búsqueda de la URL: la lista no queda filtrada por lo que ya no está (pulido r6)", () => {
    search = "q=nan&rel=client";
    render(<Buscador minSearch={3} />);
    fireEvent.change(screen.getByLabelText("Buscar por nombre o dominio"), { target: { value: "na" } });
    act(() => vi.advanceTimersByTime(300));
    expect(replace).toHaveBeenCalledWith("/ventas/empresas?rel=client", { scroll: false });
    expect(screen.getByLabelText("Buscar por nombre o dominio")).toHaveValue("na");
    expect(screen.getByText("Escribe al menos 3 letras para buscar.")).toBeInTheDocument();
  });

  it("al tercer carácter pone la búsqueda en la URL", () => {
    render(<Buscador minSearch={3} />);
    fireEvent.change(screen.getByLabelText("Buscar por nombre o dominio"), { target: { value: "caf" } });
    act(() => vi.advanceTimersByTime(300));
    expect(replace).toHaveBeenCalledWith("/ventas/empresas?q=caf", { scroll: false });
  });

  it("borrar la búsqueda vuelve a la lista entera y conserva el filtro", () => {
    search = "q=caf&rel=client";
    render(<Buscador minSearch={3} />);
    fireEvent.change(screen.getByLabelText("Buscar por nombre o dominio"), { target: { value: "" } });
    act(() => vi.advanceTimersByTime(300));
    expect(replace).toHaveBeenCalledWith("/ventas/empresas?rel=client", { scroll: false });
  });
});
