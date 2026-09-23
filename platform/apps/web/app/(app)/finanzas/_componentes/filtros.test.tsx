import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * El Segmented y el buscador de /finanzas no consultan nada: escriben
 * en la URL, y la página —que sigue siendo un Server Component— la lee
 * de `searchParams` y consulta en el servidor. Lo que se prueba aquí es
 * justo eso: qué URL escriben.
 */
const replace = vi.fn();
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/finanzas",
  useSearchParams: () => new URLSearchParams(search),
}));

import { Filtros } from "./filtros";

beforeEach(() => {
  replace.mockReset();
  search = "";
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("el filtro por estado de cobro", () => {
  it("elegir «Vencidas» pone ?bucket=vencida: una URL que se puede compartir", () => {
    render(<Filtros active="por_cobrar" minSearch={3} />);
    fireEvent.click(screen.getByRole("button", { name: "Vencidas" }));
    expect(replace).toHaveBeenCalledWith("/finanzas?bucket=vencida", { scroll: false });
  });

  it("volver a «Por cobrar» limpia el parámetro en vez de escribir el defecto", () => {
    search = "bucket=vencida";
    render(<Filtros active="vencida" minSearch={3} />);
    fireEvent.click(screen.getByRole("button", { name: "Por cobrar" }));
    expect(replace).toHaveBeenCalledWith("/finanzas", { scroll: false });
  });

  it("cambiar de estado no borra la búsqueda escrita, ni al revés", () => {
    search = "q=Hogar";
    render(<Filtros active="por_cobrar" minSearch={3} />);
    fireEvent.click(screen.getByRole("button", { name: "Vencidas" }));
    expect(replace).toHaveBeenCalledWith("/finanzas?q=Hogar&bucket=vencida", { scroll: false });
  });

  it("la opción activa se anuncia, no solo se colorea", () => {
    render(<Filtros active="vencida" minSearch={3} />);
    expect(screen.getByRole("button", { name: "Vencidas" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Por cobrar" })).toHaveAttribute("aria-pressed", "false");
  });

  it("los cinco estados de la vista están, y ninguno más", () => {
    render(<Filtros active="por_cobrar" minSearch={3} />);
    const grupo = screen.getByRole("group", { name: "Filtrar por estado de cobro" });
    expect([...grupo.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Por cobrar",
      "Vencidas",
      "Vence pronto",
      "Al día",
      "Cobradas",
    ]);
  });
});

describe("los tres hallazgos de /code-review", () => {
  const caja = () => screen.getByLabelText("Buscar");

  it("escribir y pulsar un estado antes de los 250 ms no borra el estado (ni lo escrito)", () => {
    render(<Filtros active="por_cobrar" minSearch={3} />);
    fireEvent.change(caja(), { target: { value: "Hogar" } });
    act(() => vi.advanceTimersByTime(100)); // el temporizador sigue pendiente
    fireEvent.click(screen.getByRole("button", { name: "Vencidas" }));
    expect(replace).toHaveBeenCalledWith("/finanzas?bucket=vencida&q=Hogar", { scroll: false });
    // Y el temporizador cancelado no vuelve luego a escribir una URL sin bucket.
    act(() => vi.advanceTimersByTime(1000));
    expect(replace).toHaveBeenCalledTimes(1);
  });

  it("si la URL pierde la búsqueda por fuera (atrás, «Quitar la búsqueda»), la caja se vacía", () => {
    search = "q=Hogar";
    const { rerender } = render(<Filtros active="por_cobrar" minSearch={3} />);
    expect(caja()).toHaveValue("Hogar");
    // Una navegación blanda dentro del mismo segmento: el componente no
    // se desmonta, solo cambian los searchParams.
    search = "bucket=vencida";
    rerender(<Filtros active="vencida" minSearch={3} />);
    expect(caja()).toHaveValue("");
    expect(replace).not.toHaveBeenCalled();
  });

  it("escribir no se deshace solo cuando la URL confirma lo que este componente mandó", () => {
    render(<Filtros active="por_cobrar" minSearch={3} />);
    fireEvent.change(caja(), { target: { value: "Hogar" } });
    act(() => vi.advanceTimersByTime(300));
    expect(replace).toHaveBeenCalledWith("/finanzas?q=Hogar", { scroll: false });
    expect(caja()).toHaveValue("Hogar");
  });
});

describe("el buscador", () => {
  const caja = () => screen.getByLabelText("Buscar");

  it("con una o dos letras no busca y dice desde cuándo lo hará", () => {
    render(<Filtros active="por_cobrar" minSearch={3} />);
    fireEvent.change(caja(), { target: { value: "ho" } });
    act(() => vi.advanceTimersByTime(1000));
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText("Desde el 3.º carácter. Con menos, la lista no se filtra.")).toBeInTheDocument();
  });

  it("desde el tercer carácter escribe ?q= sin tocar el bucket", () => {
    search = "bucket=vencida";
    render(<Filtros active="vencida" minSearch={3} />);
    fireEvent.change(caja(), { target: { value: "Hogar" } });
    act(() => vi.advanceTimersByTime(300));
    expect(replace).toHaveBeenCalledWith("/finanzas?bucket=vencida&q=Hogar", { scroll: false });
  });

  it("borrar de «Hoga» a «ho» devuelve la lista entera: nunca queda filtrada por lo que ya no está", () => {
    search = "q=Hoga&bucket=vencida";
    render(<Filtros active="vencida" minSearch={3} />);
    fireEvent.change(caja(), { target: { value: "ho" } });
    act(() => vi.advanceTimersByTime(300));
    expect(replace).toHaveBeenCalledWith("/finanzas?bucket=vencida", { scroll: false });
    expect(caja()).toHaveValue("ho");
  });
});
