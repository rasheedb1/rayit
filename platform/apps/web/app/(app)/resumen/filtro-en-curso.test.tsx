import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }));

import { Cifras, FiltroEnCurso, useFiltroEnCurso } from "./filtro-en-curso";
import { Filtros } from "./filtros";

/**
 * Al cambiar de periodo o de red, la opción nueva se marca en el acto,
 * pero las cifras siguen siendo las del filtro anterior hasta que
 * responde el servidor. Mientras tanto se tienen que ver COMO de antes:
 * atenuadas y aria-busy, no «90 días» encima de cifras de 30.
 */

/** Una navegación que no termina hasta que la prueba lo decide. */
function Navegacion({ hasta }: { hasta: Promise<void> }) {
  const enCurso = useFiltroEnCurso()!;
  return (
    <button type="button" onClick={() => enCurso.empezar(() => hasta)}>
      navegar
    </button>
  );
}

describe("las cifras mientras llega el filtro nuevo", () => {
  it("se atenúan y se marcan aria-busy durante la transición, y vuelven al terminar", async () => {
    let terminar!: () => void;
    const hasta = new Promise<void>((r) => (terminar = r));
    render(
      <FiltroEnCurso>
        <Navegacion hasta={hasta} />
        <Cifras>
          <p>412 mil</p>
        </Cifras>
      </FiltroEnCurso>,
    );
    const cifras = screen.getByText("412 mil").parentElement!;
    expect(cifras).not.toHaveAttribute("aria-busy");
    expect(cifras.className).not.toMatch(/opacity-60/);

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "navegar" })));
    expect(cifras).toHaveAttribute("aria-busy", "true");
    expect(cifras.className).toMatch(/opacity-60/);
    // Y se dice: el lector de pantalla no ve la opacidad.
    expect(screen.getByText("Actualizando las cifras")).toBeInTheDocument();

    await act(async () => {
      terminar();
      await hasta;
    });
    expect(cifras).not.toHaveAttribute("aria-busy");
    expect(cifras.className).not.toMatch(/opacity-60/);
  });

  it("los filtros usan la transición de la página: pulsar un periodo navega con ella", async () => {
    push.mockReset();
    render(
      <FiltroEnCurso>
        <Filtros filtro={{ days: 30, platform: null }} />
        <Cifras>
          <p>cifras</p>
        </Cifras>
      </FiltroEnCurso>,
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "90 días" })));
    expect(push).toHaveBeenCalledWith("/resumen?periodo=90", { scroll: false });
  });

  it("sueltos, sin la página alrededor, los filtros siguen funcionando con su propia transición", async () => {
    push.mockReset();
    render(<Filtros filtro={{ days: 30, platform: null }} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "TikTok" })));
    expect(push).toHaveBeenCalledWith("/resumen?red=tiktok", { scroll: false });
  });
});
