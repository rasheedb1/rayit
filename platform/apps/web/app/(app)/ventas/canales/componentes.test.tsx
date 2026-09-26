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

import type { ChannelAccountRow } from "@mc/db/queries/canales";
import { formatterFor } from "@/lib/format";
import { HEADING_FOCUS, POINTER_FOCUS_ATTR } from "./_lib/foco";
import type { ChannelRowView } from "./_lib/filas";
import { AccionFila, rowActionVariant } from "./accion-fila";
import { ConectarBoton } from "./conectar-boton";
import { Desconectar } from "./desconectar";
import { FilaCanal } from "./fila-canal";
import { Limites } from "./limites";
import { MESSAGES } from "./messages";
import { ReintentarAvisos } from "./reintentar-avisos";
import { UsoCuenta } from "./uso";

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

  it("el ancho de los campos lo fija la rejilla (dos columnas iguales), no el texto de su ayuda: ningún w-28 que el kit ignore", () => {
    const { container } = limites();
    const rejilla = container.querySelector("[data-limites-rejilla]")!;
    expect(rejilla.className).toMatch(/\bgrid\b/);
    expect(rejilla.className).toMatch(/\bgrid-cols-2\b/);
    for (const input of container.querySelectorAll("input[type=number]")) expect(input.className).not.toMatch(/\bw-28\b/);
  });

  it("no deja que el navegador conteste con su globo: noValidate y sin max en los campos", () => {
    limites();
    const form = screen.getByRole("form", { name: MESSAGES.caps.legend("laura@cocina.test") }) as HTMLFormElement;
    expect(form.noValidate).toBe(true);
    expect((screen.getByLabelText(MESSAGES.caps.daily) as HTMLInputElement).max).toBe("");
  });
});

describe("UsoCuenta", () => {
  const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
  const live = {
    id: ID, channel: "email", provider: "gmail_oauth", providerAccountId: "a@b.test", displayName: "a@b.test", status: "connected", stale: false,
    dailyCap: null, weeklyCap: null, scopes: [], lastOkAt: new Date("2026-09-24T11:18:00Z"), lastOkAgoS: 2 * 3600 + 5, lastErrorAt: null, lastError: null,
    lastErrorRecent: false, lastErrorFresh: false, updatedAt: new Date(0),
    limits: { effectiveDaily: 20, effectiveWeekly: 140, maxDaily: 20, maxWeekly: 140, dailyLimitedBy: "policy", weeklyLimitedBy: "policy", personalMailbox: false },
  } satisfies ChannelAccountRow;

  it("«Comprobada» va en relativo, con la fecha completa en el title, y puede partirse (a 400 px no desborda la fila)", () => {
    const { container } = render(<UsoCuenta live={live} f={f} />);
    const comprobada = container.querySelector("[data-comprobada]")!;
    expect(comprobada.textContent).toBe(MESSAGES.detail.lastOk("hace 2 horas"));
    expect(comprobada.getAttribute("title")).toBe(f.dateTime(live.lastOkAt.toISOString()));
    expect(comprobada.className).not.toMatch(/nowrap/);
    expect(comprobada.className).toMatch(/break-words/);
    // El uso de hoy y de la semana lo dice el widget «Uso de hoy» (VEN-16): la tarjeta no lo repite.
    expect(container.textContent).not.toMatch(/Hoy|Semana/);
  });

  it("sin una comprobación todavía, no pinta una línea vacía", () => {
    const { container } = render(<UsoCuenta live={{ ...live, lastOkAt: null, lastOkAgoS: null }} f={f} />);
    expect(container.innerHTML).toBe("");
  });

  it("en una cuenta caída dice cuándo funcionó por última vez, no que se comprobó", () => {
    const caida = { ...live, status: "needs_reconnect", lastOkAgoS: 3 * 86400 } satisfies ChannelAccountRow;
    const { container } = render(<UsoCuenta live={caida} f={f} />);
    expect(container.querySelector("[data-comprobada]")!.textContent).toBe(MESSAGES.detail.lastWorked("hace 3 días"));
  });
});

describe("Desconectar", () => {
  it("la región viva de la pregunta está montada desde el principio, vacía: el lector la anuncia al escribir en ella", () => {
    const { container } = render(<Desconectar accountId={ID} account="laura@cocina.test" />);
    const live = container.querySelector("[aria-live=polite]")!;
    expect(live.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.actions.disconnectAccount("laura@cocina.test") }));
    expect(container.querySelector("[aria-live=polite]"), "la misma región, no una nueva").toBe(live);
    expect(live.textContent).toBe(MESSAGES.actions.disconnectConfirm);
    const group = screen.getByRole("group", { name: MESSAGES.actions.disconnectAccount("laura@cocina.test") });
    expect(group.getAttribute("aria-describedby")).toBe(live.id);
  });

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

describe("Desconectar: el botón no se parte y se ve como lo que es", () => {
  it("en tono de peligro (no el fantasma de «Conectar otra cuenta»), y su envoltorio no se encoge ni parte el texto", () => {
    render(<Desconectar accountId={ID} account="laura@cocina.test" />);
    const button = screen.getByRole("button", { name: MESSAGES.actions.disconnectAccount("laura@cocina.test") });
    expect(button.className).toMatch(/\btext-bad\b/);
    expect(button.className).not.toMatch(/\bbg-transparent\b/);
    const wrapper = button.parentElement!;
    expect(wrapper.hasAttribute("data-desconectar")).toBe(true);
    expect(wrapper.className).toMatch(/\bwhitespace-nowrap\b/);
    expect(wrapper.className).toMatch(/\bshrink-0\b/);
  });
});

describe("Desconectar dentro de su fila", () => {
  it("al terminar, la fila anuncia qué cuenta se soltó (aria-live) y el foco va a su título, no al cuerpo", async () => {
    const notice = MESSAGES.actions.disconnected("laura@cocina.test");
    desconectar.mockResolvedValue({ notice });
    render(
      <ul>
        <FilaCanal headingId="canal-email-titulo">
          <h3 id="canal-email-titulo" tabIndex={-1}>Correo</h3>
          <Desconectar accountId={ID} account="laura@cocina.test" />
        </FilaCanal>
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.actions.disconnectAccount("laura@cocina.test") }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MESSAGES.actions.disconnect }));
    });
    expect((desconectar.mock.calls[0]![0] as FormData).get("accountId")).toBe(ID);
    const said = await screen.findByText(notice);
    expect(said.closest("[aria-live='polite']")).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Correo" }));
    expect(document.activeElement).not.toBe(document.body);
  });

  it("con el ratón, el título recibe el foco igual pero sin anillo (data-foco-raton, hasta que lo pierde); con el teclado, con anillo", async () => {
    desconectar.mockResolvedValue({ notice: MESSAGES.actions.disconnected("laura@cocina.test") });
    const fila = () => render(
      <ul>
        <FilaCanal headingId="canal-email-titulo">
          <h3 id="canal-email-titulo" tabIndex={-1}>Correo</h3>
          <Desconectar accountId={ID} account="laura@cocina.test" />
        </FilaCanal>
      </ul>,
    );
    const { unmount } = fila();
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.actions.disconnectAccount("laura@cocina.test") }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MESSAGES.actions.disconnect }), { detail: 1 });
    });
    const heading = screen.getByRole("heading", { name: "Correo" });
    expect(document.activeElement).toBe(heading);
    expect(heading.hasAttribute(POINTER_FOCUS_ATTR)).toBe(true);
    act(() => heading.blur());
    expect(heading.hasAttribute(POINTER_FOCUS_ATTR), "al perder el foco vuelve a pintar el anillo la próxima vez").toBe(false);
    unmount();

    fila();
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.actions.disconnectAccount("laura@cocina.test") }));
    await act(async () => {
      // Enter o espacio sobre un botón: el clic llega con detail 0.
      fireEvent.click(screen.getByRole("button", { name: MESSAGES.actions.disconnect }), { detail: 0 });
    });
    const conTeclado = screen.getByRole("heading", { name: "Correo" });
    expect(document.activeElement).toBe(conTeclado);
    expect(conTeclado.hasAttribute(POINTER_FOCUS_ATTR)).toBe(false);
    // El anillo va dentro del título y solo sin la marca del ratón; el contorno global de :focus-visible queda anulado (!important).
    expect(HEADING_FOCUS).toMatch(/(^|\s)outline-none!(\s|$)/);
    expect(HEADING_FOCUS).toMatch(/\[&:focus-visible:not\(\[data-foco-raton\]\)\]:ring-inset/);
  });

  it("si la cuenta ya estaba desconectada, lo dice en la fila", async () => {
    desconectar.mockResolvedValue({ message: MESSAGES.actions.alreadyDisconnected });
    render(
      <ul>
        <FilaCanal headingId="canal-linkedin-titulo">
          <h3 id="canal-linkedin-titulo" tabIndex={-1}>LinkedIn</h3>
          <Desconectar accountId={ID} account="Laura Gómez" />
        </FilaCanal>
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.actions.disconnectAccount("Laura Gómez") }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MESSAGES.actions.disconnect }));
    });
    expect((await screen.findByRole("alert")).textContent).toBe(MESSAGES.actions.alreadyDisconnected);
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

describe("AccionFila", () => {
  const fila = (over: Partial<ChannelRowView>): ChannelRowView => ({
    channel: "linkedin", state: "needs_reconnect", missing: [], unavailable: false, off: false, action: "reconnect", reason: null, reasonTone: "error",
    others: [], addAnother: false, returned: false,
    account: { id: ID } as ChannelAccountRow,
    ...over,
  });

  it("«Reconectar» va en primario solo si se puede pulsar; deshabilitado, en secundario como el «Conectar» de al lado", () => {
    expect(rowActionVariant({ action: "reconnect" }, false)).toBe("primary");
    expect(rowActionVariant({ action: "reconnect" }, true)).toBe("secondary");
    expect(rowActionVariant({ action: "connect" }, false)).toBe("secondary");

    const { unmount } = render(<AccionFila row={fila({})} canManage />);
    expect(screen.getByRole("button", { name: MESSAGES.actions.reconnect }).className).toMatch(/\bbg-accent\b/);
    unmount();
    // Una cuenta caída en un canal sin llaves: deshabilitado, sin el primario gris macizo que parecía activo.
    render(<AccionFila row={fila({ unavailable: true })} canManage />);
    const off = screen.getByRole("button", { name: MESSAGES.actions.unavailableLabel(MESSAGES.actions.reconnect, MESSAGES.detail.unavailable("LinkedIn")) });
    expect((off as HTMLButtonElement).disabled).toBe(true);
    expect(off.className).not.toMatch(/\bbg-accent\b/);
    expect(off.className).toMatch(/\bbg-surface\b/);
  });

  it("un canal apagado en el espacio: «Conectar» deshabilitado con el motivo en su nombre accesible, como «no disponible»", () => {
    render(<AccionFila row={fila({ channel: "instagram_dm", state: "off", action: "connect", account: null, off: true })} canManage />);
    const off = screen.getByRole("button", { name: MESSAGES.actions.unavailableLabel(MESSAGES.actions.connect, MESSAGES.detail.off("Instagram")) });
    expect((off as HTMLButtonElement).disabled).toBe(true);
  });

  it("sin el rol de gestionar canales también va deshabilitado y en secundario", () => {
    render(<AccionFila row={fila({})} canManage={false} />);
    const off = screen.getByRole("button", { name: MESSAGES.actions.unavailableLabel(MESSAGES.actions.reconnect, MESSAGES.detail.readOnly) });
    expect(off.className).toMatch(/\bbg-surface\b/);
  });
});
