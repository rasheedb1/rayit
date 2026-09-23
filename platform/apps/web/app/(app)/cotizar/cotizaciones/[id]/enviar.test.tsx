import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enviarCotizacion = vi.fn();
vi.mock("../../actions", () => ({
  enviarCotizacion: (...args: unknown[]) => enviarCotizacion(...args),
}));
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

import { EnviarCotizacion } from "./enviar";
import { MESSAGES } from "../../messages";

const t = MESSAGES.detalle;
const ID = "00000009-0000-4000-8000-0000000c0010";

beforeEach(() => {
  enviarCotizacion.mockReset();
  replace.mockReset();
  enviarCotizacion.mockResolvedValue({ status: "ok", path: "/cotizacion/abc" });
});

describe("EnviarCotizacion", () => {
  it("sin otra versión viva, un clic envía", async () => {
    render(<EnviarCotizacion id={ID} />);
    fireEvent.click(screen.getByRole("button", { name: t.enviar }));
    await waitFor(() => expect(enviarCotizacion).toHaveBeenCalledWith(ID));
    await waitFor(() => expect(replace).toHaveBeenCalledWith(expect.stringMatching(/\?enviada=(copiado|manual)$/)));
  });

  it("si el negocio tiene otra versión viva, enviar pide el segundo paso y dice cuál queda sin efecto (pulido r7)", async () => {
    render(
      <EnviarCotizacion
        id={ID}
        confirmacion={{
          pregunta: t.confirmar.enviar.pregunta("COT-2026-010"),
          consecuencia: t.confirmar.enviar.consecuencia(["COT-2026-005"]),
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t.enviar }));
    // El primer clic no envía: pregunta, con la consecuencia.
    const grupo = await screen.findByRole("group", { name: "¿Enviar COT-2026-010?" });
    expect(grupo).toHaveAccessibleDescription(
      "COT-2026-005 dejará de poder aceptarse, también si la marca la tiene abierta ahora. No se puede deshacer.",
    );
    expect(enviarCotizacion).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: t.confirmar.enviar.boton }));
    await waitFor(() => expect(enviarCotizacion).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(replace).toHaveBeenCalled());
  });

  it("si el envío falla, lo dice", async () => {
    enviarCotizacion.mockResolvedValue({ status: "error", message: MESSAGES.errores.OtraVersionEnCurso });
    render(<EnviarCotizacion id={ID} />);
    fireEvent.click(screen.getByRole("button", { name: t.enviar }));
    expect(await screen.findByRole("alert")).toHaveTextContent(MESSAGES.errores.OtraVersionEnCurso!);
    expect(replace).not.toHaveBeenCalled();
  });
});
