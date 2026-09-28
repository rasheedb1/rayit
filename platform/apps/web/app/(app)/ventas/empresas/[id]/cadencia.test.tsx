import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * «Mensajes de la cadencia» en la ficha (VEN-10): adonde llevan los
 * avisos del motor. Un retenido dice por qué (en palabras, no el código) y
 * se aprueba ahí; una respuesta se lee ahí. La aprobación de verdad (RLS,
 * revalidar huecos y nota) está probada en pglite:
 * packages/db/test/outreach-aprobar.test.ts.
 */
const aprobarMensaje = vi.fn();
const resolverIntento = vi.fn();
const saltarMensaje = vi.fn();
const reanudarCadencia = vi.fn();
const marcarGestoHecho = vi.fn();
vi.mock("../actions", () => ({
  marcarGestoHecho: (...a: unknown[]) => marcarGestoHecho(...a),
  aprobarMensaje: (...a: unknown[]) => aprobarMensaje(...a),
  resolverIntento: (...a: unknown[]) => resolverIntento(...a),
  saltarMensaje: (...a: unknown[]) => saltarMensaje(...a),
  reanudarCadencia: (...a: unknown[]) => reanudarCadencia(...a),
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
    statusChangedAt: new Date("2026-09-24T15:00:00Z"), reply: null, accountName: "laura@cocina-facil.test", unconfirmedDay: null,
    threadSubject: null, enrollmentId: "00000005-0000-4000-8000-0000000e0001", enrollmentStatus: "active", ...over,
  };
}

beforeEach(() => {
  aprobarMensaje.mockReset();
  resolverIntento.mockReset();
  saltarMensaje.mockReset().mockResolvedValue({ ok: true, notice: FICHA.cadencia.saltar.hecho, stamp: 1 });
  reanudarCadencia.mockReset().mockResolvedValue({ ok: true, notice: FICHA.cadencia.pausa.hecho, stamp: 1 });
  marcarGestoHecho.mockReset().mockResolvedValue({ ok: true, notice: FICHA.cadencia.aMano.aviso, stamp: 1 });
});

describe("un gesto a mano (pulido r6)", () => {
  const comentario = (over: Partial<CadenceTouch> = {}) => toque({
    id: "00000005-0000-4000-8000-000000070031", channel: "linkedin", stepType: "linkedin_comment", stepIndex: 2, status: "draft",
    subject: null, body: "", scheduledFor: new Date("2026-09-28T15:06:00Z"), accountName: null, ...over,
  });

  it("dice «A mano · el 28 sep», no «Borrador · sale el…», y «Hecho» lo anota", async () => {
    render(<MensajesDeCadencia companyId={COMPANY} f={f} touches={[comentario()]} />);
    const fila = screen.getAllByRole("row")[1]!;
    expect(within(fila).getByText(t.aMano.estado)).toBeInTheDocument();
    expect(within(fila).queryByText(t.estados.draft!)).toBeNull();
    expect(within(fila).getByText(t.linea("LinkedIn", t.aMano.cuando(f.date("2026-09-28T15:06:00Z"))))).toBeInTheDocument();
    expect(within(fila).queryByText(/sale el/)).toBeNull();
    expect(within(fila).getByText(t.aMano.nota)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(within(fila).getByRole("button", { name: t.aMano.botonLabel("Sofía Cárdenas") }));
    });
    const datos = marcarGestoHecho.mock.calls[0]![1] as FormData;
    expect(Object.fromEntries(datos)).toEqual({ companyId: COMPANY, touchId: "00000005-0000-4000-8000-000000070031" });
    expect(await screen.findByText(t.aMano.aviso)).toBeInTheDocument();
  });

  it("hecho, dice «Hecho a mano» con su fecha y sin motivo ni botón", () => {
    render(
      <MensajesDeCadencia
        companyId={COMPANY}
        f={f}
        touches={[comentario({ status: "skipped", blockedReason: "done_by_hand", statusChangedAt: new Date("2026-09-28T16:00:00Z") })]}
      />,
    );
    const fila = screen.getAllByRole("row")[1]!;
    expect(within(fila).getByText(t.aMano.hecho)).toBeInTheDocument();
    expect(within(fila).getByText(t.linea("LinkedIn", t.aMano.hechoEl(f.date("2026-09-28T16:00:00Z"))))).toBeInTheDocument();
    expect(within(fila).queryByRole("button")).toBeNull();
    expect(within(fila).queryByText(/Lo hiciste/)).toBeNull();
  });
});

describe("lo que ya no va a salir (pulido r5)", () => {
  it("un cancelado o un fallido dice a qué hora iba a salir, en pasado, y por qué no salió", () => {
    render(
      <MensajesDeCadencia
        companyId={COMPANY}
        f={f}
        touches={[
          toque({ id: "00000005-0000-4000-8000-000000070021", status: "canceled", blockedReason: "opted_out" }),
          toque({ id: "00000005-0000-4000-8000-000000070022", status: "failed", blockedReason: "rejected", stepIndex: 2 }),
          toque({ id: "00000005-0000-4000-8000-000000070023", status: "canceled", blockedReason: "deal_won", stepIndex: 3 }),
          toque({ id: "00000005-0000-4000-8000-000000070024", stepIndex: 4 }),
        ]}
      />,
    );
    const fecha = f.dateTimeShort("2026-09-25T15:30:00Z");
    const filas = screen.getAllByRole("row").slice(1);
    expect(within(filas[0]!).getByText(t.linea("Correo", t.iba(fecha)))).toBeInTheDocument();
    expect(within(filas[0]!).queryByText(t.linea("Correo", t.sale(fecha)))).toBeNull();
    expect(within(filas[0]!).getByText("Pidió no recibir más mensajes.")).toBeInTheDocument();
    expect(within(filas[1]!).getByText(t.linea("Correo", t.iba(fecha)))).toBeInTheDocument();
    expect(within(filas[1]!).getByText("El proveedor lo rechazó.")).toBeInTheDocument();
    expect(within(filas[2]!).getByText("La marca ya firmó: el negocio se ganó.")).toBeInTheDocument();
    // Lo programado sigue en futuro y sin motivo.
    expect(within(filas[3]!).getByText(t.linea("Correo", t.sale(fecha)))).toBeInTheDocument();
  });
});

describe("las salidas de una cadencia parada (VEN-10)", () => {
  it("un retenido se puede saltar, con confirmación", async () => {
    render(
      <MensajesDeCadencia
        companyId={COMPANY}
        f={f}
        touches={[toque({ status: "held", heldReason: "reply_without_thread", stepType: "email_reply", subject: null })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t.saltar.label }));
    expect(screen.getByRole("group", { name: t.saltar.pregunta })).toHaveAccessibleDescription(t.saltar.consecuencia);
    expect(saltarMensaje).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.saltar.si }));
    });
    expect(saltarMensaje).toHaveBeenCalledTimes(1);
    const datos = saltarMensaje.mock.calls[0]![1] as FormData;
    expect(Object.fromEntries(datos)).toEqual({ companyId: COMPANY, touchId: "00000005-0000-4000-8000-000000070001" });
  });

  it("una cadencia en pausa ofrece «Reanudar» una sola vez, en su primera fila", async () => {
    const ENR = "00000005-0000-4000-8000-0000000e0009";
    render(
      <MensajesDeCadencia
        companyId={COMPANY}
        f={f}
        touches={[
          toque({ id: "00000005-0000-4000-8000-000000070011", enrollmentId: ENR, enrollmentStatus: "paused" }),
          toque({ id: "00000005-0000-4000-8000-000000070012", enrollmentId: ENR, enrollmentStatus: "paused", stepIndex: 2 }),
          toque({ id: "00000005-0000-4000-8000-000000070013" }),
        ]}
      />,
    );
    const botones = screen.getAllByRole("button", { name: t.pausa.reanudarDe("Sofía Cárdenas") });
    expect(botones).toHaveLength(1);
    expect(screen.getByText(t.pausa.aviso("Sofía Cárdenas"))).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(botones[0]!);
    });
    const datos = reanudarCadencia.mock.calls[0]![1] as FormData;
    expect(Object.fromEntries(datos)).toEqual({ companyId: COMPANY, enrollmentId: ENR });
  });
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

  it("un intento sin confirmar enseña qué buscar (asunto, texto, cuenta y día), sin jerga, y reenviar pide confirmación", async () => {
    resolverIntento.mockResolvedValue({ ok: true, notice: t.intento.registrado, stamp: 1 });
    render(
      <MensajesDeCadencia
        companyId={COMPANY}
        f={f}
        touches={[toque({ status: "held", heldReason: "unconfirmed_attempt:1", unconfirmedDay: "2026-09-24", body: "Hola, Sofía.\nTe escribo por Vitalé." })]}
      />,
    );
    expect(
      screen.getByText(
        "No sabemos si el correo «Una idea para Vitalé» que enviamos el 24 de septiembre de 2026 desde laura@cocina-facil.test llegó: " +
          "el proveedor no lo confirmó. Búscalo en tu carpeta de enviados (o en el chat) y dinos qué pasó.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/intento 1/)).not.toBeInTheDocument();
    expect(screen.getByText(/Te escribo por Vitalé/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: t.revisarLabel("Sofía Cárdenas") })).not.toBeInTheDocument();

    // «No salió: enviarlo» no envía con un clic: pregunta primero.
    fireEvent.click(screen.getByRole("button", { name: t.intento.noSalio }));
    expect(resolverIntento).not.toHaveBeenCalled();
    expect(screen.getByText(t.intento.confirmarReenvio)).toBeInTheDocument();
    expect(screen.getByText(t.intento.consecuenciaReenvio("Sofía Cárdenas"))).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t.intento.cancelar }));
    expect(resolverIntento).not.toHaveBeenCalled();

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

  it("«Sí, enviarlo» tras la confirmación lo devuelve a la cola", async () => {
    resolverIntento.mockResolvedValue({ ok: true, notice: t.intento.reenviado, stamp: 1 });
    render(<MensajesDeCadencia companyId={COMPANY} f={f} touches={[toque({ status: "held", heldReason: "unconfirmed_attempt:1" })]} />);
    fireEvent.click(screen.getByRole("button", { name: t.intento.noSalio }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.intento.siReenviar }));
    });
    expect(resolverIntento).toHaveBeenCalledTimes(1);
    expect((resolverIntento.mock.calls[0]![1] as FormData).get("outcome")).toBe("resend");
  });

  it("a 400 px se lee sin mover la tabla: canal y hora bajo el nombre, en dos columnas", () => {
    render(<MensajesDeCadencia companyId={COMPANY} f={f} touches={[toque({})]} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([t.columnas.persona, t.columnas.estado]);
    expect(screen.getByText(t.linea("Correo", t.sale(f.dateTimeShort("2026-09-25T15:30:00.000Z"))))).toBeInTheDocument();
  });

  it("«Revisar y aprobar» lleva el foco al asunto y, al cerrar, lo devuelve al botón", () => {
    render(<MensajesDeCadencia companyId={COMPANY} f={f} touches={[toque({ status: "held", heldReason: "needs_review" })]} />);
    fireEvent.click(screen.getByRole("button", { name: t.revisarLabel("Sofía Cárdenas") }));
    const form = screen.getByRole("form", { name: t.revisarLabel("Sofía Cárdenas") });
    expect(document.activeElement).toBe(within(form).getByLabelText(t.asunto));
    fireEvent.click(within(form).getByRole("button", { name: t.cerrar }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: t.revisarLabel("Sofía Cárdenas") }));
  });

  it("en LinkedIn, sin asunto, el foco va al texto", () => {
    render(
      <MensajesDeCadencia companyId={COMPANY} f={f} touches={[toque({ status: "held", heldReason: "needs_review", channel: "linkedin", subject: null })]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t.revisarLabel("Sofía Cárdenas") }));
    const form = screen.getByRole("form", { name: t.revisarLabel("Sofía Cárdenas") });
    expect(document.activeElement).toBe(within(form).getByRole("textbox"));
  });

  it("una respuesta en el hilo no pide asunto: dice en qué hilo responde y lo manda vacío", async () => {
    aprobarMensaje.mockResolvedValue({ ok: true, notice: t.aprobado, stamp: 1 });
    render(
      <MensajesDeCadencia
        companyId={COMPANY}
        f={f}
        touches={[toque({ status: "held", heldReason: "needs_review", stepType: "email_reply", subject: null, threadSubject: "Una idea para Vitalé" })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: t.revisarLabel("Sofía Cárdenas") }));
    const form = screen.getByRole("form", { name: t.revisarLabel("Sofía Cárdenas") });
    expect(within(form).queryByLabelText(t.asunto)).not.toBeInTheDocument();
    expect(within(form).getByText(t.enHilo("Una idea para Vitalé"))).toBeInTheDocument();
    expect(document.activeElement).toBe(within(form).getByRole("textbox"));
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: t.aprobar }));
    });
    expect((aprobarMensaje.mock.calls[0]![1] as FormData).get("subject")).toBe("");
  });

  it("sin hilo conocido todavía, lo dice sin inventar un asunto", () => {
    render(
      <MensajesDeCadencia companyId={COMPANY} f={f} touches={[toque({ status: "held", heldReason: "needs_review", stepType: "email_reply", subject: null })]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: t.revisarLabel("Sofía Cárdenas") }));
    expect(screen.getByText(t.enHiloSinAsunto)).toBeInTheDocument();
  });

  it("sin dirección postal, el aviso lleva a la política de envío con el foco en el enlace", async () => {
    aprobarMensaje.mockResolvedValue({
      message: t.errores.no_postal_address,
      link: { href: "/ventas/politica#postalAddress", label: t.irAPolitica },
    });
    render(<MensajesDeCadencia companyId={COMPANY} f={f} touches={[toque({ status: "held", heldReason: "needs_review" })]} />);
    fireEvent.click(screen.getByRole("button", { name: t.revisarLabel("Sofía Cárdenas") }));
    const form = screen.getByRole("form", { name: t.revisarLabel("Sofía Cárdenas") });
    await act(async () => {
      fireEvent.click(within(form).getByRole("button", { name: t.aprobar }));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent(t.errores.no_postal_address);
    const enlace = screen.getByRole("link", { name: t.irAPolitica });
    expect(enlace).toHaveAttribute("href", "/ventas/politica#postalAddress");
    expect(document.activeElement).toBe(enlace);
  });

  it("un motivo escrito a mano que ya termina en punto no se pinta con dos", () => {
    render(
      <MensajesDeCadencia
        companyId={COMPANY}
        f={f}
        touches={[toque({ status: "held", heldReason: "La marca pidió esperar a octubre. Revísalo antes de programarlo." })]}
      />,
    );
    expect(screen.getByText("Retenido: La marca pidió esperar a octubre. Revísalo antes de programarlo.")).toBeInTheDocument();
  });

  it("sin mensajes de cadencia, lo dice", () => {
    render(<MensajesDeCadencia companyId={COMPANY} f={f} touches={[]} />);
    expect(screen.getByText(t.vacio.title)).toBeInTheDocument();
  });
});
