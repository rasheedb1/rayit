import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const guardarLimites = vi.fn();
const desconectar = vi.fn();
const reactivarAvisos = vi.fn();
vi.mock("./actions", () => ({
  guardarLimites: (...a: unknown[]) => guardarLimites(...a),
  desconectar: (...a: unknown[]) => desconectar(...a),
  reactivarAvisos: (...a: unknown[]) => reactivarAvisos(...a),
}));

import { ConectarBoton } from "./conectar-boton";
import { Desconectar } from "./desconectar";
import { Limites } from "./limites";
import { MESSAGES } from "./messages";
import { ReintentarAvisos } from "./reintentar-avisos";

const ID = "00000005-0000-4000-8000-0000000ac001";

beforeEach(() => {
  guardarLimites.mockReset();
  desconectar.mockReset();
  reactivarAvisos.mockReset();
});

function limites() {
  return render(
    <Limites
      accountId={ID} account="laura@cocina.test" dailyCap={null} weeklyCap={null}
      dailyHelp="Máximo 20" weeklyHelp="Máximo 140" dailyPlaceholder="20" weeklyPlaceholder="140"
    />,
  );
}

describe("Limites", () => {
  it("un error del servidor conserva lo escrito y lleva el foco al campo con el error", async () => {
    const texto = MESSAGES.caps.dailyAboveWeekly("10");
    guardarLimites.mockResolvedValue({ errors: { dailyCap: texto } });
    limites();
    const daily = screen.getByLabelText(MESSAGES.caps.daily) as HTMLInputElement;
    const weekly = screen.getByLabelText(MESSAGES.caps.weekly) as HTMLInputElement;
    fireEvent.change(daily, { target: { value: "15" } });
    fireEvent.change(weekly, { target: { value: "10" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("form", { name: MESSAGES.caps.legend("laura@cocina.test") }));
    });
    expect(guardarLimites).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(texto)).toBeTruthy();
    expect(daily.value, "React no vacía el formulario").toBe("15");
    expect(weekly.value).toBe("10");
    expect(daily.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(daily);
  });

  it("no deja que el navegador conteste con su globo: noValidate y sin max en los campos", () => {
    limites();
    const form = screen.getByRole("form", { name: MESSAGES.caps.legend("laura@cocina.test") }) as HTMLFormElement;
    expect(form.noValidate).toBe(true);
    expect((screen.getByLabelText(MESSAGES.caps.daily) as HTMLInputElement).max).toBe("");
  });
});

describe("Desconectar", () => {
  it("al preguntar, el foco va a confirmar y la pregunta se anuncia; al cancelar, vuelve a «Desconectar»", () => {
    render(<Desconectar accountId={ID} account="laura@cocina.test" />);
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.actions.disconnectAccount("laura@cocina.test") }));
    const group = screen.getByRole("group", { name: MESSAGES.actions.disconnectAccount("laura@cocina.test") });
    expect(document.activeElement?.textContent).toBe(MESSAGES.actions.disconnect);
    expect(group.contains(document.activeElement)).toBe(true);
    expect(screen.getByText(MESSAGES.actions.disconnectConfirm).getAttribute("aria-live")).toBe("polite");
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.actions.cancel }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: MESSAGES.actions.disconnectAccount("laura@cocina.test") }));
  });
});

describe("ConectarBoton", () => {
  it("desde el primer envío queda ocupado y un segundo clic no manda otro formulario", () => {
    render(<ConectarBoton action="/ventas/canales/conectar" fields={{ canal: "linkedin" }} label="Conectar" variant="secondary" disabled={false} />);
    const button = screen.getByRole("button", { name: "Conectar" });
    const form = button.closest("form")!;
    // En el documento: después del manejador de React, que es quien decide si el envío sigue.
    const submits = vi.fn();
    const spy = (e: Event) => submits(e.defaultPrevented);
    document.addEventListener("submit", spy);
    fireEvent.submit(form);
    const busy = screen.getByRole("button");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect((busy as HTMLButtonElement).disabled).toBe(true);
    expect(busy.textContent).toBe(MESSAGES.actions.connecting);
    fireEvent.submit(form);
    document.removeEventListener("submit", spy);
    expect(submits.mock.calls.map((c) => c[0]), "el segundo envío se cancela").toEqual([false, true]);
  });
});

describe("ReintentarAvisos", () => {
  it("llama a la acción con la cuenta y enseña el resultado", async () => {
    reactivarAvisos.mockResolvedValue({ notice: MESSAGES.banners.webhooksRestored });
    render(<ReintentarAvisos accountId={ID} disabled={false} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MESSAGES.actions.retry }));
    });
    expect((reactivarAvisos.mock.calls[0]![0] as FormData).get("accountId")).toBe(ID);
    expect(await screen.findByText(MESSAGES.banners.webhooksRestored)).toBeTruthy();
  });
});
