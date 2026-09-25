import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Mensajes de la cadencia» en la ficha (VEN-10 r5): adonde llevan los
 * avisos del motor. Un retenido dice por qué (en palabras, no el código) y
 * se aprueba ahí; una respuesta se lee ahí. La aprobación de verdad (RLS,
 * revalidar huecos y nota) está probada en pglite:
 * packages/db/test/outreach-aprobar.test.ts.
 */
const aprobarMensaje = vi.fn();
const resolverIntento = vi.fn();
vi.mock("../actions", () => ({
  aprobarMensaje: (...a: unknown[]) => aprobarMensaje(...a),
  resolverIntento: (...a: unknown[]) => resolverIntento(...a),
}));

import type { CadenceTouch } from "@mc/db/queries/outreach";
import { formatterFor } from "@/lib/format";
import { FICHA } from "../messages";
import { MensajesDeCadencia } from "./cadencia";

const t = FICHA.cadencia;
const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
const COMPANY = "00000002-0000-4000-8000-0000000000e7";

function toque(over: Partial<CadenceTouch>): CadenceTouch {
  return {
    id: "00000005-0000-4000-8000-000000070001", contactName: "Sofía Cárdenas", channel: "email", stepType: "email", stepIndex: 1,
    sequenceName: "Tres correos", status: "scheduled", heldReason: null, blockedReason: null,
    scheduledFor: new Date("2026-09-25T15:30:00Z"), sentAt: null, subject: "Una idea para Vitalé", body: "Hola, Sofía.",
    statusChangedAt: new Date("2026-09-24T15:00:00Z"), reply: null, ...over,
  };
}

beforeEach(() => {
  aprobarMensaje.mockReset();
  resolverIntento.mockReset();
});

describe("MensajesDeCadencia", () => {
  it("un retenido dice por qué en palabras y se revisa ahí; una respuesta se lee", () => {
    render(
      <MensajesDeCadencia
        companyId={COMPANY}
        f={f}
        touches={[
          toque({ id: "00000005-0000-4000-8000-000000070002", status: "held", heldReason: "needs_review" }),
          toque({
            id: "00000005-0000-4000-8000-000000070003", status: "sent", sentAt: new Date("2026-09-23T15:00:00Z"),
            reply: { body: "¡Hola! Nos interesa.\n\nHablemos el jueves.", occurredAt: new Date("2026-09-23T18:00:00Z") },
          }),
        ]}
      />,
    );
    expect(screen.getByRole("heading", { name: t.title })).toBeInTheDocument();
    expect(screen.getByText(t.meta("1"))).toBeInTheDocument();
    expect(screen.getByText(t.estados.held!)).toBeInTheDocument();
    expect(screen.getByText(/espera tu aprobación antes de salir/)).toBeInTheDocument();
    expect(screen.queryByText(/needs_review/)).not.toBeInTheDocument();
    expect(screen.getByText("¡Hola! Nos interesa. Hablemos el jueves.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.revisarLabel("Sofía Cárdenas") })).toBeInTheDocument();
  });

  it("«Revisar y aprobar» abre el texto editable y lo manda con su id", async () => {
    aprobarMensaje.mockResolvedValue({ ok: true, notice: t.aprobado, stamp: 1 });
    render(<MensajesDeCadencia companyId={COMPANY} f={f} touches={[toque({ status: "held", heldReason: "needs_review" })]} />);
    fireEvent.click(screen.getByRole("button", { name: t.revisarLabel("Sofía Cárdenas") }));
    const form = screen.getByRole("form", { name: t.revisarLabel("Sofía Cárdenas") });
    expect(within(form).getByLabelText(t.asunto)).toHaveValue("Una idea para Vitalé");
    fireEvent.change(within(form).getByLabelText(new RegExp(t.texto)), { target: { value: "Hola, Sofía: una idea." } });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: t.aprobar }));
    });
    expect(aprobarMensaje).toHaveBeenCalledTimes(1);
    const data = aprobarMensaje.mock.calls[0]![1] as FormData;
    expect(data.get("touchId")).toBe("00000005-0000-4000-8000-000000070001");
    expect(data.get("companyId")).toBe(COMPANY);
    expect(data.get("body")).toBe("Hola, Sofía: una idea.");
    expect(await screen.findByText(t.aprobado)).toBeInTheDocument();
  });

  it("un intento sin confirmar se resuelve con «Sí, salió» o «No salió», no con «Revisar y aprobar» (r3)", async () => {
    resolverIntento.mockResolvedValue({ ok: true, notice: t.intento.registrado, stamp: 1 });
    render(
      <MensajesDeCadencia companyId={COMPANY} f={f} touches={[toque({ status: "held", heldReason: "unconfirmed_attempt:1" })]} />,
    );
    expect(screen.getByText(/no pudimos comprobar si el intento 1 salió/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.revisarLabel("Sofía Cárdenas") })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: t.intento.noSalioLabel("Sofía Cárdenas") })).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.intento.salioLabel("Sofía Cárdenas") }));
    });
    expect(resolverIntento).toHaveBeenCalledTimes(1);
    const data = resolverIntento.mock.calls[0]![1] as FormData;
    expect(data.get("outcome")).toBe("was_sent");
    expect(data.get("touchId")).toBe("00000005-0000-4000-8000-000000070001");
    expect(data.get("companyId")).toBe(COMPANY);
    expect(await screen.findByText(t.intento.registrado)).toBeInTheDocument();
  });

  it("sin mensajes de cadencia, lo dice", () => {
    render(<MensajesDeCadencia companyId={COMPANY} f={f} touches={[]} />);
    expect(screen.getByText(t.vacio.title)).toBeInTheDocument();
  });
});
