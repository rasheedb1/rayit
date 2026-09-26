import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La bandeja unificada (VEN-14) sin base ni Next: la vista pura
 * (conversacionVista, hiloVista), la lista, la respuesta con su id
 * idempotente, cancelar y editar lo que está en cola, corregir la
 * intención, el referido y el teclado. Las consultas se prueban contra
 * Postgres embebido (packages/db/test/bandejas.test.ts y el worker).
 */
const responder = vi.fn();
const marcarLeido = vi.fn();
const crearReferido = vi.fn();
const cancelarRespuesta = vi.fn();
const descartarRespuesta = vi.fn();
const corregirIntencion = vi.fn();
const marcarHecho = vi.fn();
vi.mock("./actions", () => ({
  responder: (...a: unknown[]) => responder(...a),
  marcarLeido: (...a: unknown[]) => marcarLeido(...a),
  crearReferido: (...a: unknown[]) => crearReferido(...a),
  cancelarRespuesta: (...a: unknown[]) => cancelarRespuesta(...a),
  descartarRespuesta: (...a: unknown[]) => descartarRespuesta(...a),
  corregirIntencion: (...a: unknown[]) => corregirIntencion(...a),
  marcarHecho: (...a: unknown[]) => marcarHecho(...a),
}));
const router = { push: vi.fn(), refresh: vi.fn() };
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import type { InboxConversation, InboxMessage, InboxThread } from "@mc/db/queries/bandejas";
import { formatterFor } from "@/lib/format";
import { AtajosBandeja } from "./acciones";
import { Conversacion } from "./conversacion";
import { ListaHilos } from "./lista";
import { MESSAGE_INTENTS } from "@mc/core/outreach/intent";
import { INTENCIONES, MESSAGES } from "./messages";
import { CrearReferido, Respuestas } from "./responder";
import { columnaListaClase, conversacionVista, hiloHref, hiloVista, intencionClave } from "./vista";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
const t = MESSAGES;
const CONTACT = "00000140-0000-4000-8000-0000000000d1";
const COMPANY = "00000140-0000-4000-8000-0000000000c1";
const SEQ = "00000140-0000-4000-8000-0000000000e1";
const DEAL = "00000140-0000-4000-8000-0000000000f1";

function mensaje(n: number, extra: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: `00000140-0000-4000-8000-00000000a00${n}`,
    direction: "inbound",
    subject: null,
    body: `Mensaje ${n}`,
    occurredAt: new Date("2026-09-23T20:00:00Z"),
    readAt: null,
    fromAddress: null,
    intent: null,
    intentConfidence: null,
    intentSource: null,
    intentReason: null,
    resumeAt: null,
    cooldownUntil: null,
    referral: null,
    referralContactId: null,
    ...extra,
  };
}

function conv(extra: Partial<InboxConversation> = {}): InboxConversation {
  return {
    contactId: CONTACT,
    channel: "email",
    contactName: "Sofía Cárdenas",
    companyId: COMPANY,
    companyName: "Vitalé",
    deal: { id: DEAL, stageId: "contactado", stageLabel: "Contactado", nextAction: null },
    messages: [mensaje(1, { direction: "outbound", body: "Hola, Sofía" }), mensaje(2)],
    pending: [],
    notSent: [],
    replyToMessageId: mensaje(2).id,
    accountName: "laura@gmail.test",
    replyBlock: null,
    sendingOff: false,
    done: false,
    unread: 0,
    sequenceId: SEQ,
    ...extra,
  };
}

const vista = (c: InboxConversation, clasificador: "model" | "fake" | "off" | "unknown" = "model") =>
  conversacionVista(c, f, { clasificador });

beforeEach(() => {
  for (const m of [responder, marcarLeido, crearReferido, cancelarRespuesta, descartarRespuesta, corregirIntencion, marcarHecho]) m.mockReset();
  marcarLeido.mockResolvedValue(undefined);
  router.push.mockReset();
  router.refresh.mockReset();
});

describe("la vista", () => {
  it("las intenciones de la pantalla son las de @mc/core, ni una más ni una menos", () => {
    expect([...INTENCIONES].sort()).toEqual([...MESSAGE_INTENTS].sort());
  });

  it("una intención desconocida o sin clasificar es «pendiente»", () => {
    expect(intencionClave(null)).toBe("pendiente");
    expect(intencionClave("otra")).toBe("pendiente");
    expect(intencionClave("interested")).toBe("interested");
  });

  it("dice quién clasificó, con su porcentaje y su porqué; sin clasificar promete la IA solo si está encendida", () => {
    const c = conv({
      messages: [
        mensaje(1, { intent: "interested", intentConfidence: 0.94, intentSource: "model", intentReason: "Pide tarifas." }),
        mensaje(2),
        mensaje(3, { intent: "ambiguous", intentConfidence: 1, intentSource: "person" }),
      ],
    });
    const [a, b, p] = vista(c).mensajes;
    expect(a!.clasificacion).toBe(`Clasificada por la IA · ${f.pct(0.94)}`);
    expect(a!.porque).toBe("Por qué: Pide tarifas.");
    expect(b!.intencion).toBe("pendiente");
    expect(b!.clasificacion).toBe(t.conversacion.sinClasificar);
    expect(p!.clasificacion).toBe(t.conversacion.corregida);
    const apagado = vista(c, "off");
    expect(apagado.clasificadorApagado).toBe(true);
    expect(apagado.mensajes[1]!.clasificacion).toBe(t.conversacion.sinClasificarApagado);
  });

  it("la fecha de vuelta de un «fuera de la oficina» y hasta cuándo se enfría un «ahora no»", () => {
    const c = conv({
      messages: [
        mensaje(1, { intent: "ooo", intentSource: "fake", resumeAt: new Date("2026-10-06T05:00:00Z") }),
        mensaje(2, { intent: "not_now", intentSource: "model", cooldownUntil: new Date("2026-12-22T20:00:00Z") }),
      ],
    });
    const [ooo, ahoraNo] = vista(c).mensajes;
    expect(ooo!.vuelve).toBe(t.conversacion.vuelve(f.date("2026-10-06T05:00:00.000Z", "long")));
    expect(ahoraNo!.enfria).toBe(t.conversacion.enfria(f.date("2026-12-22T20:00:00.000Z", "long")));
  });

  it("un referido con correo, sin datos y ya creado; una baja no se corrige", () => {
    const c = conv({
      messages: [
        mensaje(1, { intent: "referral", referral: { name: "Ana", email: "ana@vitale.test", role: null } }),
        mensaje(2, { intent: "referral", referral: null }),
        mensaje(3, { intent: "referral", referral: { name: "Ana", email: null, role: null }, referralContactId: CONTACT }),
        mensaje(4, { intent: "unsubscribe", intentSource: "detector" }),
      ],
    });
    const [conCorreo, sinDatos, creado, baja] = vista(c).mensajes;
    expect(conCorreo!.referido).toMatchObject({ propuesta: t.referido.propone("Ana · ana@vitale.test"), creado: false });
    expect(sinDatos!.referido?.propuesta).toBe(t.referido.proponeSinDatos);
    expect(creado!.referido?.creado).toBe(true);
    expect(baja!.corregible).toBe(false);
    expect(conCorreo!.corregible).toBe(true);
  });

  it("separa lo que está por salir de lo que no salió, con su motivo; el enlace para enrolar lleva la cadencia y el negocio", () => {
    const r = (id: string, status: "scheduled" | "canceled" | "failed", blockedReason: string | null) => ({
      touchId: id, status, body: "Hola", scheduledFor: null, heldReason: null, blockedReason, cancelable: status === "scheduled",
    });
    const v = vista(conv({ pending: [r("t1", "scheduled", null)], notSent: [r("t2", "canceled", "canceled_by_person"), r("t3", "failed", "raro")] }));
    expect(v.porSalir.map((p) => [p.estado, p.cancelable, p.motivo])).toEqual([["En cola", true, null]]);
    expect(v.noSalieron.map((p) => p.motivo)).toEqual([t.responder.motivos["canceled_by_person"], t.responder.motivoGenerico]);
    expect(v.enrolarHref).toBe(`/ventas/cadencias/${SEQ}?negocio=${DEAL}#enrolar`);
    expect(vista(conv({ sequenceId: null })).enrolarHref).toBe(`/ventas/empresas/${COMPANY}#negocios`);
  });
});

describe("la lista", () => {
  const hilo = (n: number, extra: Partial<InboxThread> = {}): InboxThread => ({
    contactId: `00000140-0000-4000-8000-0000000000d${n}`, channel: "linkedin", contactName: `Persona ${n}`, companyId: COMPANY,
    companyName: "Vitalé", lastAt: new Date("2026-09-23T20:00:00Z"), lastDirection: "inbound", lastSnippet: "Hola", unread: 0,
    lastIntent: null, done: false, ...extra,
  });

  it("los no leídos en negrita, la abierta con aria-current y la vista en el enlace", () => {
    const hilos = [hiloVista(hilo(1, { unread: 2 }), f, true, "todas"), hiloVista(hilo(2, { done: true }), f, false, "todas")];
    render(<ListaHilos hilos={hilos} />);
    const enlaces = screen.getAllByRole("link");
    expect(enlaces[0]).toHaveAttribute("aria-current", "page");
    expect(enlaces[0]).toHaveAttribute("href", hiloHref(hilo(1).contactId, "linkedin", "todas"));
    expect(enlaces[0]!.getAttribute("href")).toContain("vista=todas");
    expect(screen.getByText("Persona 1").parentElement?.className).toContain("font-semibold");
    expect(screen.getByText("2 sin leer")).toBeInTheDocument();
    expect(screen.getByText(t.lista.hecha)).toBeInTheDocument();
  });
});

describe("la lista no se estira ni se esconde debajo de la conversación", () => {
  const hilo = (n: number, extra: Partial<InboxThread> = {}): InboxThread => ({
    contactId: `00000140-0000-4000-8000-0000000000d${n}`, channel: "email", contactName: `Persona ${n}`, companyId: COMPANY,
    companyName: "Vitalé", lastAt: new Date("2026-09-23T20:00:00Z"), lastDirection: "inbound",
    lastSnippet: "Un extracto larguísimo ".repeat(40), unread: 1, lastIntent: null, done: false, ...extra,
  });

  it("la columna es una rejilla con una columna que puede encogerse, en el teléfono y en escritorio", () => {
    // jsdom no mide cajas: el ancho real lo mide scripts/ancho-movil.mjs (TOPE). Aquí se fija la regla.
    expect(columnaListaClase(false).split(" ")).toContain("grid-cols-[minmax(0,1fr)]");
    expect(columnaListaClase(true).split(" ")).toContain("lg:grid-cols-[minmax(0,1fr)]");
    for (const visible of [false, true]) expect(columnaListaClase(visible).split(" ")).toContain("min-w-0");
  });

  it("la lista, cada fila y cada enlace pueden encogerse, así que el extracto se corta", () => {
    const { container } = render(<ListaHilos hilos={[hiloVista(hilo(1), f, false)]} />);
    const nav = screen.getByRole("navigation", { name: t.lista.label });
    expect(nav.className).toContain("min-w-0");
    for (const el of [container.querySelector("ul")!, container.querySelector("li")!, screen.getByRole("link")]) {
      expect(el.className.split(" ")).toContain("min-w-0");
    }
    expect(screen.getByText(/Un extracto larguísimo/).className).toContain("truncate");
  });

  it("la que la página abrió sola solo se marca en escritorio; la elegida, siempre", () => {
    render(
      <ListaHilos hilos={[hiloVista(hilo(1), f, true, "pendientes", true), hiloVista(hilo(2), f, false, "pendientes", true)]} />,
    );
    const [sola, otra] = screen.getAllByRole("link");
    expect(sola).not.toHaveAttribute("aria-current");
    expect(sola!.className).toContain("lg:bg-hover");
    expect(sola!.className.split(" ")).not.toContain("bg-hover");
    expect(otra).not.toHaveAttribute("aria-current");
  });
});

describe("el teclado", () => {
  it("en un teléfono, con el hilo abierto solo, j abre el primero de la lista y e no marca a ciegas", async () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
    try {
      render(
        <>
          <AtajosBandeja hrefs={["/a", "/b"]} activo={0} activoSoloEscritorio listaHref="/ventas/bandeja" />
          <Conversacion c={vista(conv())} volverHref="/ventas/bandeja" />
        </>,
      );
      fireEvent.keyDown(window, { key: "j" });
      expect(router.push).toHaveBeenLastCalledWith("/a");
      await act(async () => {
        fireEvent.keyDown(window, { key: "e" });
      });
      expect(marcarHecho).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
  });

  it("j y k abren el hilo siguiente y el anterior; r lleva a la respuesta; e marca hecha; Esc vuelve a la lista", async () => {
    marcarHecho.mockResolvedValue({ ok: true, notice: t.conversacion.hechaAviso });
    render(
      <>
        <AtajosBandeja hrefs={["/a", "/b", "/c"]} activo={1} listaHref="/ventas/bandeja" />
        <Conversacion c={vista(conv())} volverHref="/ventas/bandeja" />
      </>,
    );
    fireEvent.keyDown(window, { key: "j" });
    expect(router.push).toHaveBeenLastCalledWith("/c");
    fireEvent.keyDown(window, { key: "k" });
    expect(router.push).toHaveBeenLastCalledWith("/a");
    fireEvent.keyDown(window, { key: "r" });
    const area = screen.getByLabelText(t.responder.label);
    expect(document.activeElement).toBe(area);
    // En la respuesta, las letras escriben y Esc suelta el campo.
    fireEvent.keyDown(area, { key: "j" });
    expect(router.push).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(area, { key: "Escape" });
    expect(document.activeElement).not.toBe(area);
    await act(async () => {
      fireEvent.keyDown(window, { key: "e" });
    });
    expect(marcarHecho).toHaveBeenCalledWith({ contactId: CONTACT, channel: "email", done: true });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(router.push).toHaveBeenLastCalledWith("/ventas/bandeja");
  });
});

describe("responder", () => {
  const props = { contactId: CONTACT, channel: "email" as const, ayuda: "Sale desde laura", porSalir: [], noSalieron: [], puedeResponder: true };

  async function enviar(texto: string) {
    fireEvent.change(screen.getByLabelText(t.responder.label), { target: { value: texto } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.responder.enviar }));
    });
  }

  it("un envío que falla conserva el id (reintentar no crea otro mensaje); uno que sale lo renueva y vacía el campo", async () => {
    responder.mockResolvedValueOnce({ ok: false, error: t.errores.generico });
    render(<Respuestas {...props} />);
    await enviar("Hola, Sofía");
    const primero = responder.mock.calls[0]![0] as { touchId: string };
    expect(await screen.findByText(t.errores.generico)).toBeInTheDocument();
    expect(screen.getByLabelText(t.responder.label)).toHaveValue("Hola, Sofía");

    responder.mockResolvedValueOnce({ ok: true, notice: t.responder.enviada });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.responder.enviar }));
    });
    const segundo = responder.mock.calls[1]![0] as { touchId: string; body: string };
    expect(segundo.touchId).toBe(primero.touchId);
    expect(segundo.body).toBe("Hola, Sofía");
    expect(screen.getByLabelText(t.responder.label)).toHaveValue("");
    expect(screen.getByText(t.responder.enviada)).toBeInTheDocument();

    responder.mockResolvedValueOnce({ ok: true, notice: t.responder.enviadaApagado });
    await enviar("Otra");
    const tercero = responder.mock.calls[2]![0] as { touchId: string };
    expect(tercero.touchId).not.toBe(primero.touchId);
    expect(screen.getByText(t.responder.enviadaApagado)).toBeInTheDocument();
  });

  it("un error del campo va a su campo y le devuelve el foco", async () => {
    responder.mockResolvedValue({ ok: false, error: t.errores.placeholders("{{first_name}}"), field: "body" });
    render(<Respuestas {...props} />);
    await enviar("Hola, {{first_name}}");
    const area = screen.getByLabelText(t.responder.label);
    await waitFor(() => expect(document.activeElement).toBe(area));
    expect(area).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(t.errores.placeholders("{{first_name}}"))).toBeInTheDocument();
  });

  it("una respuesta en cola se cancela, o se edita: su texto vuelve a «Tu respuesta»", async () => {
    const enCola = { touchId: "t1", estado: "En cola", cuerpo: "Con errata", cancelable: true, motivo: null };
    cancelarRespuesta.mockResolvedValue({ ok: true, notice: t.responder.aEditar, body: "Con errata" });
    render(<Respuestas {...props} porSalir={[enCola]} />);
    expect(screen.getByText(t.responder.porSalir(1))).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.responder.editar }));
    });
    expect(cancelarRespuesta).toHaveBeenCalledWith({ touchId: "t1", editar: true });
    expect(screen.getByLabelText(t.responder.label)).toHaveValue("Con errata");
    expect(screen.getByText(t.responder.aEditar)).toBeInTheDocument();
  });

  it("las que no salieron dicen por qué y se descartan; una que ya está saliendo no se cancela", () => {
    const saliendo = { touchId: "t1", estado: "Enviándose", cuerpo: "Ya va", cancelable: false, motivo: null };
    const cancelada = { touchId: "t2", estado: "Cancelada", cuerpo: "No", cancelable: false, motivo: t.responder.motivos["canceled_by_person"]! };
    render(<Respuestas {...props} porSalir={[saliendo]} noSalieron={[cancelada]} />);
    expect(screen.queryByRole("button", { name: t.responder.cancelar })).toBeNull();
    expect(screen.getByText(t.responder.motivos["canceled_by_person"]!)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: t.responder.descartar }));
    expect(descartarRespuesta).toHaveBeenCalledWith({ touchId: "t2" });
  });
});

describe("corregir la intención", () => {
  it("una ambigua se corrige a interesada; una baja pide confirmación antes", async () => {
    corregirIntencion.mockResolvedValue({ ok: true, notice: t.corregir.listoMovido("interesada") });
    const c = conv({ messages: [mensaje(1, { intent: "ambiguous", intentSource: "model", intentConfidence: 0.4 })] });
    render(<Conversacion c={vista(c)} volverHref="/ventas/bandeja" />);
    fireEvent.click(screen.getByRole("button", { name: t.corregir.abrir }));
    const select = screen.getByLabelText(t.corregir.label, { selector: "select" });
    await waitFor(() => expect(document.activeElement).toBe(select));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.corregir.guardar }));
    });
    expect(corregirIntencion).toHaveBeenCalledWith({ messageId: mensaje(1).id, intent: "interested" });
    expect(await screen.findByText(t.corregir.listoMovido("interesada"))).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: t.corregir.abrir }));
    fireEvent.change(screen.getByLabelText(t.corregir.label, { selector: "select" }), { target: { value: "unsubscribe" } });
    fireEvent.click(screen.getByRole("button", { name: t.corregir.guardar }));
    expect(screen.getByText(t.corregir.bajaPregunta)).toBeInTheDocument();
    expect(corregirIntencion).toHaveBeenCalledTimes(1);
  });
});

describe("el referido", () => {
  it("el error de correo va a su campo; creado, propone enrolarlo en una cadencia", async () => {
    crearReferido.mockResolvedValueOnce({ ok: false, error: t.errores.DuplicateEmail, field: "email" });
    render(<CrearReferido messageId={mensaje(1).id} nombre="Ana" correo="ana@vitale.test" cargo={null} enrolarHref="/ventas/cadencias/x#enrolar" />);
    fireEvent.click(screen.getByRole("button", { name: t.referido.crear }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.referido.guardar }));
    });
    expect(crearReferido).toHaveBeenCalledWith({ messageId: mensaje(1).id, fullName: "Ana", email: "ana@vitale.test", roleTitle: "" });
    expect(screen.getByLabelText(t.referido.correo)).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText(t.errores.DuplicateEmail)).toBeInTheDocument();

    crearReferido.mockResolvedValueOnce({ ok: true, notice: t.referido.listo("Ana") });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.referido.guardar }));
    });
    expect(screen.getByText(t.referido.listo("Ana"))).toBeInTheDocument();
    expect(screen.getByRole("link", { name: t.referido.enrolar })).toHaveAttribute("href", "/ventas/cadencias/x#enrolar");
  });
});

describe("cada hilo tiene su propio estado", () => {
  it("pasar a otro hilo no arrastra el borrador, el id del envío ni los avisos", async () => {
    marcarHecho.mockResolvedValue({ ok: true, notice: t.conversacion.hechaAviso });
    const { rerender } = render(<Conversacion c={vista(conv())} volverHref="/ventas/bandeja" />);
    fireEvent.change(screen.getByLabelText(t.responder.label), { target: { value: "Borrador para Sofía" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.conversacion.marcarHecha }));
    });
    expect(screen.getByText(t.conversacion.hechaAviso)).toBeInTheDocument();

    const OTRO = "00000140-0000-4000-8000-0000000000d9";
    rerender(<Conversacion c={vista(conv({ contactId: OTRO, contactName: "Julián Mesa" }))} volverHref="/ventas/bandeja" />);
    expect(screen.getByLabelText(t.responder.label)).toHaveValue("");
    expect(screen.queryByText(t.conversacion.hechaAviso)).toBeNull();

    responder.mockResolvedValue({ ok: true, notice: t.responder.enviada });
    fireEvent.change(screen.getByLabelText(t.responder.label), { target: { value: "Hola, Julián" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: t.responder.enviar }));
    });
    expect(responder).toHaveBeenCalledWith(expect.objectContaining({ contactId: OTRO, body: "Hola, Julián" }));
  });

  it("los no leídos salen de la propia conversación, no de la fila de la lista", () => {
    expect(vista(conv({ unread: 3 })).sinLeer).toBe(3);
  });

  it("«Crear contacto» guarda su ancho: no se estira como un campo", () => {
    const c = conv({
      messages: [mensaje(1, { intent: "referral", intentSource: "model", referral: { name: "Ana", email: "ana@vitale.test", role: null } })],
    });
    render(<Conversacion c={vista(c)} volverHref="/ventas/bandeja" />);
    const boton = screen.getByRole("button", { name: t.referido.crear });
    expect(boton.parentElement!.tagName).toBe("DIV");
    expect(boton.parentElement!.className).not.toContain("grid");
  });
});

describe("marcar leído", () => {
  it("una conversación abierta sola (la primera sin leer) no se marca leída si no se ve", () => {
    const original = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: false, media: q })) as unknown as typeof window.matchMedia;
    try {
      render(<Conversacion c={conversacionVista(conv({ unread: 2 }), f, { clasificador: "model", implicita: true })} volverHref="/ventas/bandeja" />);
      expect(marcarLeido).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
    render(<Conversacion c={conversacionVista(conv({ unread: 2 }), f, { clasificador: "model" })} volverHref="/ventas/bandeja" />);
    expect(marcarLeido).toHaveBeenCalledWith({ contactId: CONTACT, channel: "email" });
  });
});
