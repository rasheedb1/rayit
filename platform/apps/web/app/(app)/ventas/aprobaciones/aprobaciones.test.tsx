import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const aprobarToque = vi.fn();
const regenerarToque = vi.fn();
const saltarToque = vi.fn();
const deshacerAprobacion = vi.fn();
vi.mock("./actions", () => ({
  aprobarToque: (...a: unknown[]) => aprobarToque(...a),
  regenerarToque: (...a: unknown[]) => regenerarToque(...a),
  saltarToque: (...a: unknown[]) => saltarToque(...a),
  deshacerAprobacion: (...a: unknown[]) => deshacerAprobacion(...a),
}));

import type { ApprovalItem } from "@mc/db/queries/bandejas";
import { formatterFor } from "@/lib/format";
import { Cola, DESHACER_MS } from "./cola";
import { MESSAGES } from "./messages";
import { motivoDe, reglasDe } from "./motivo";
import { filaVista } from "./vista";

const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });

function item(n: number, extra: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    touchId: `00000140-0000-4000-8000-00000000007${n}`,
    status: "held",
    regenerating: false,
    companyId: "00000140-0000-4000-8000-0000000000c1",
    companyName: `Marca ${n}`,
    contactName: `Persona ${n}`,
    contactSource: "public_website",
    channel: "email",
    stepType: "email",
    stepIndex: 1,
    stepCount: 3,
    sequenceName: "Marca con campaña activa",
    subject: `Asunto ${n}`,
    body: `Hola, Persona ${n}: una idea para la temporada.`,
    heldReason: "quality_warmup:3",
    threadSubject: null,
    scheduledFor: new Date("2026-09-24T15:30:00Z"),
    statusChangedAt: new Date("2026-09-23T15:30:00Z"),
    review: null,
    regenerable: true,
    ...extra,
  };
}

beforeEach(() => {
  aprobarToque.mockReset();
  regenerarToque.mockReset();
  saltarToque.mockReset();
  deshacerAprobacion.mockReset();
});

describe("por qué quedó retenido", () => {
  it("dice de dónde viene la retención y la frase del motor en el idioma del espacio", () => {
    expect(motivoDe("quality_warmup:3", "es-CO")).toMatchObject({ categoria: "calentamiento", etiqueta: "Calentamiento" });
    expect(motivoDe("quality_low:6.2", "es-CO")?.categoria).toBe("juez");
    expect(motivoDe("quality_preflight:banned_word", "es-CO")?.categoria).toBe("preflight");
    expect(motivoDe("needs_review", "en-US")?.texto).toBe("It waits for your approval before going out (human review is on).");
    expect(motivoDe("unconfirmed_attempt:1", "es-CO")?.intentoSinConfirmar).toBe(true);
    expect(motivoDe("Lo reviso yo antes.", "es-CO")).toMatchObject({ categoria: "persona", texto: "Lo reviso yo antes." });
    expect(motivoDe(null, "es-CO")).toBeNull();
  });

  it("una nota baja remite al botón de la fila, nunca a otra pantalla", () => {
    const conRegenerar = motivoDe("quality_low:6.2", "es-CO", true)!.texto;
    const sinRegenerar = motivoDe("quality_low:6.2", "es-CO", false)!.texto;
    expect(conRegenerar).toContain("«Regenerar»");
    expect(sinRegenerar).toContain("edítalo antes de aprobarlo");
    for (const texto of [conRegenerar, sinRegenerar]) expect(texto).not.toContain("Redactar pitch");
    // Una respuesta en el hilo no se regenera: la fila tampoco lo promete.
    const fila = filaVista(item(1, { heldReason: "quality_low:6.2", stepType: "email_reply", regenerable: false }), f);
    expect(fila.motivo!.texto).toBe(sinRegenerar);
    expect(motivoDe("quality_low:6.2", "en-US", true)!.texto).toContain("«Regenerate»");
  });

  it("la etiqueta no repite el principio de la frase del motor", () => {
    const baja = motivoDe("quality_low:7.4", "es-CO", true)!;
    expect(baja.etiqueta).toBeNull();
    expect(baja.texto).toMatch(/^La revisión automática le dio 7,4 de 10/);
    expect(motivoDe("quality_risk:unsourced_figure", "es-CO")!.etiqueta).toBeNull();
    // Cuando no se repite, la categoría se queda: «Calentamiento. Pasó la revisión automática…».
    expect(motivoDe("quality_warmup:3", "es-CO")!.etiqueta).toBe("Calentamiento");
    render(<Cola filas={[filaVista(item(1, { heldReason: "quality_low:7.4" }), f)]} />);
    const porque = screen.getByRole("region", { name: MESSAGES.porque.title });
    expect(porque.textContent).not.toMatch(/Revisión automática\.\s*La revisión automática/);
  });

  it("la procedencia del contacto está siempre a la vista (§8, decisión 5)", () => {
    expect(filaVista(item(1), f).procedencia).toBe(MESSAGES.fila.procedencia("Web de la empresa"));
    expect(filaVista(item(1, { contactSource: "inbound" }), f).procedencia).toBe(MESSAGES.fila.procedencia("Te escribió"));
    expect(filaVista(item(1, { contactSource: null }), f).procedencia).toBeNull();
    render(<Cola filas={[filaVista(item(1), f)]} />);
    expect(screen.getByText(MESSAGES.fila.procedencia("Web de la empresa"))).toBeInTheDocument();
  });

  it("las reglas del pre-vuelo con su dato, sin repetir", () => {
    expect(
      reglasDe([
        { code: "banned_word", detail: "sinergia" },
        { code: "banned_word", detail: "sinergia" },
        { code: "too_long", detail: "620" },
      ]),
    ).toEqual(["Usa una palabra prohibida («sinergia»).", "Es muy largo (620 caracteres)."]);
  });

  it("la nota del juez, sus dimensiones y sus riesgos llegan formateados", () => {
    const v = filaVista(
      item(1, {
        heldReason: "quality_risk:unsourced_figure",
        review: {
          totalScore: 6.4, scores: { relevance: 7, quality: 6.5 }, riskTriggers: ["unsourced_figure"], regenerateHint: "add_proof",
          judgeNote: "Cita una cifra sin fuente.", preflight: [], attempts: 3,
        },
      }),
      f,
    );
    expect(v.juez?.total).toBe("6,4 de 10");
    expect(v.juez?.dimensiones).toEqual([
      { key: "relevance", label: "Relevancia", valor: "7" },
      { key: "quality", label: "Calidad", valor: "6,5" },
    ]);
    expect(v.juez?.intentos).toBe("3 intentos");
    expect(v.juez?.riesgos).toEqual(["una cifra sin origen en tu perfil"]);
    expect(v.paso).toBe("Marca con campaña activa · paso 1 de 3");
  });
});

describe("la cola", () => {
  it("j y k mueven la fila activa; a aprueba la activa y el aviso queda arriba", async () => {
    aprobarToque.mockResolvedValue({ ok: true, notice: MESSAGES.avisos.aprobado("Persona 2") });
    render(<Cola filas={[item(1), item(2), item(3)].map((i) => filaVista(i, f))} />);
    const filas = screen.getAllByRole("article");
    expect(filas[0]).toHaveAttribute("aria-current", "true");
    fireEvent.keyDown(window, { key: "j" });
    expect(filas[1]).toHaveAttribute("aria-current", "true");
    expect(document.activeElement).toBe(filas[1]);
    fireEvent.keyDown(window, { key: "k" });
    fireEvent.keyDown(window, { key: "j" });
    await act(async () => {
      fireEvent.keyDown(window, { key: "a" });
    });
    expect(aprobarToque).toHaveBeenCalledWith({ touchId: item(2).touchId, persona: "Persona 2", edicion: null });
    expect(await screen.findByText(MESSAGES.avisos.aprobado("Persona 2"))).toBeInTheDocument();
  });

  it("e abre el editor con el foco en el mensaje; lo que la base rechaza vuelve en su campo", async () => {
    aprobarToque.mockResolvedValue({ ok: false, errors: { body: MESSAGES.errores.placeholders("{{first_name}}") } });
    render(<Cola filas={[filaVista(item(1), f)]} />);
    fireEvent.keyDown(window, { key: "e" });
    const cuerpo = screen.getByLabelText(MESSAGES.acciones.mensaje) as HTMLTextAreaElement;
    await waitFor(() => expect(document.activeElement).toBe(cuerpo));
    // Escribir una «a» en el editor escribe, no aprueba.
    fireEvent.keyDown(cuerpo, { key: "a" });
    expect(aprobarToque).not.toHaveBeenCalled();
    fireEvent.change(cuerpo, { target: { value: "Hola, {{first_name}}" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MESSAGES.acciones.aprobarCambios }));
    });
    expect(aprobarToque).toHaveBeenCalledWith({
      touchId: item(1).touchId, persona: "Persona 1", edicion: { subject: "Asunto 1", body: "Hola, {{first_name}}" },
    });
    expect(await screen.findByText(MESSAGES.errores.placeholders("{{first_name}}"))).toBeInTheDocument();
  });

  it("r pide otra versión con la pista elegida; s pregunta antes de saltar", async () => {
    regenerarToque.mockResolvedValue({ ok: true, notice: MESSAGES.avisos.pedido });
    saltarToque.mockResolvedValue({ ok: true, notice: MESSAGES.avisos.saltado("Persona 1") });
    render(<Cola filas={[filaVista(item(1), f)]} />);
    fireEvent.keyDown(window, { key: "r" });
    fireEvent.change(screen.getByLabelText(MESSAGES.acciones.pista), { target: { value: "soften" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MESSAGES.acciones.pedir }));
    });
    expect(regenerarToque).toHaveBeenCalledWith({ touchId: item(1).touchId, hint: "soften", instructions: "" });
    fireEvent.keyDown(window, { key: "s" });
    expect(screen.getByText(MESSAGES.acciones.saltarPregunta)).toBeInTheDocument();
    expect(saltarToque).not.toHaveBeenCalled();
  });

  it("con «¿Saltar este paso?» abierto, a, e, r y s no hacen nada: la persona iba a saltarlo", async () => {
    render(<Cola filas={[filaVista(item(1), f), filaVista(item(2), f)]} />);
    fireEvent.keyDown(window, { key: "s" });
    expect(screen.getByText(MESSAGES.acciones.saltarPregunta)).toBeInTheDocument();
    for (const key of ["a", "e", "r", "s"]) {
      await act(async () => {
        fireEvent.keyDown(window, { key });
      });
    }
    expect(aprobarToque).not.toHaveBeenCalled();
    expect(saltarToque).not.toHaveBeenCalled();
    expect(screen.queryByLabelText(MESSAGES.acciones.mensaje)).toBeNull();
    expect(screen.queryByLabelText(MESSAGES.acciones.pista)).toBeNull();
    expect(screen.getByText(MESSAGES.acciones.saltarPregunta)).toBeInTheDocument();
  });

  it("una cifra sin origen no se aprueba tal cual: «a» abre el editor con el motivo", async () => {
    const motivo = MESSAGES.errores.unsourced_figure("40 %");
    aprobarToque.mockResolvedValue({ ok: false, errors: { body: motivo } });
    render(<Cola filas={[filaVista(item(1, { heldReason: "quality_risk:unsourced_figure" }), f)]} />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "a" });
    });
    expect(screen.getByLabelText(MESSAGES.acciones.mensaje)).toBeInTheDocument();
    expect(screen.getByText(motivo)).toBeInTheDocument();
  });

  it("en un teléfono la fila activa no se marca: el borde y el anillo son solo desde sm", () => {
    render(<Cola filas={[filaVista(item(1), f), filaVista(item(2), f)]} />);
    const [primera] = screen.getAllByRole("article");
    const clases = primera!.className.split(" ");
    expect(clases).toContain("sm:border-ink");
    expect(clases).toContain("sm:ring-2");
    expect(clases).not.toContain("border-ink");
    expect(clases).not.toContain("ring-2");
  });

  it("un rol que solo mira lee la cola con j y k, sin botones ni atajos de acción", async () => {
    render(<Cola filas={[filaVista(item(1), f), filaVista(item(2), f)]} puedeOperar={false} />);
    for (const nombre of [MESSAGES.acciones.aprobar, MESSAGES.acciones.editar, MESSAGES.acciones.regenerar, MESSAGES.acciones.saltar]) {
      expect(screen.queryByRole("button", { name: nombre })).toBeNull();
    }
    const leyenda = screen.getByLabelText(MESSAGES.atajos.label);
    expect(leyenda.textContent).toContain("siguiente");
    expect(leyenda.textContent).not.toContain("aprobar");
    await act(async () => {
      fireEvent.keyDown(window, { key: "a" });
    });
    expect(aprobarToque).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "j" });
    expect(screen.getAllByRole("article")[1]).toHaveAttribute("aria-current", "true");
  });

  it("un intento sin confirmar no se aprueba aquí: se resuelve en la ficha", () => {
    render(<Cola filas={[filaVista(item(1, { heldReason: "unconfirmed_attempt:1", regenerable: false }), f)]} />);
    expect(screen.queryByRole("button", { name: MESSAGES.acciones.aprobar })).toBeNull();
    expect(screen.getByRole("link", { name: MESSAGES.acciones.resolverEnLaFicha })).toHaveAttribute(
      "href", "/ventas/empresas/00000140-0000-4000-8000-0000000000c1#cadencia",
    );
  });

  it("al aprobar la ÚLTIMA fila, el aviso sigue arriba del vacío con «Deshacer», y deshacer la devuelve", async () => {
    const deshacer = { touchId: item(1).touchId, persona: "Persona 1", approvedAt: "2026-09-24T15:00:00.000Z" };
    aprobarToque.mockResolvedValue({ ok: true, notice: MESSAGES.avisos.aprobado("Persona 1"), deshacer });
    deshacerAprobacion.mockResolvedValue({ ok: true, notice: MESSAGES.avisos.deshecho("Persona 1") });
    const { rerender } = render(<Cola filas={[filaVista(item(1), f)]} />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "a" });
    });
    // revalidatePath deja la cola vacía: la página vuelve a pintar la misma Cola sin filas.
    rerender(<Cola filas={[]} />);
    expect(screen.getByText(MESSAGES.avisos.aprobado("Persona 1"))).toBeInTheDocument();
    expect(screen.getByText(MESSAGES.vacio.title)).toBeInTheDocument();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: MESSAGES.avisos.deshacer }));
    });
    expect(deshacerAprobacion).toHaveBeenCalledWith(deshacer);
    expect(await screen.findByText(MESSAGES.avisos.deshecho("Persona 1"))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: MESSAGES.avisos.deshacer })).toBeNull();
  });

  it("con el envío apagado, el aviso de aprobado no promete la hora", async () => {
    aprobarToque.mockResolvedValue({
      ok: true, notice: MESSAGES.avisos.aprobadoApagado("Persona 1"),
      deshacer: { touchId: item(1).touchId, persona: "Persona 1", approvedAt: "2026-09-24T15:00:00.000Z" },
    });
    render(<Cola filas={[filaVista(item(1), f)]} />);
    await act(async () => {
      fireEvent.keyDown(window, { key: "a" });
    });
    expect(screen.getByText(MESSAGES.avisos.aprobadoApagado("Persona 1"))).toBeInTheDocument();
    expect(MESSAGES.avisos.aprobadoApagado("Persona 1")).toContain("cuando enciendas el envío");
  });

  it("«Deshacer» se ofrece unos segundos y después se va", async () => {
    vi.useFakeTimers();
    try {
      aprobarToque.mockResolvedValue({
        ok: true, notice: MESSAGES.avisos.aprobado("Persona 1"),
        deshacer: { touchId: item(1).touchId, persona: "Persona 1", approvedAt: "2026-09-24T15:00:00.000Z" },
      });
      render(<Cola filas={[filaVista(item(1), f)]} />);
      await act(async () => {
        fireEvent.keyDown(window, { key: "a" });
      });
      expect(screen.getByRole("button", { name: MESSAGES.avisos.deshacer })).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(DESHACER_MS + 10);
      });
      expect(screen.queryByRole("button", { name: MESSAGES.avisos.deshacer })).toBeNull();
      expect(screen.getByText(MESSAGES.avisos.aprobado("Persona 1"))).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("la leyenda de atajos no sale en un teléfono ni anuncia «r» si nada se puede regenerar", () => {
    render(<Cola filas={[filaVista(item(1, { regenerable: false, stepType: "email_reply" }), f)]} />);
    const leyenda = screen.getByLabelText(MESSAGES.atajos.label);
    expect(leyenda.className).toContain("hidden");
    expect(leyenda.className).toContain("sm:block");
    expect(leyenda.textContent).not.toContain("regenerar");
    expect(leyenda.textContent).toContain("aprobar");
  });

  it("los intentos de la revisión no van dentro de la lista de notas (un dl solo lleva dt y dd)", () => {
    const { container } = render(
      <Cola
        filas={[
          filaVista(
            item(1, {
              review: {
                totalScore: 6.4, scores: { relevance: 7 }, riskTriggers: [], regenerateHint: null, judgeNote: null, preflight: [], attempts: 3,
              },
            }),
            f,
          ),
        ]}
      />,
    );
    const dl = container.querySelector("dl")!;
    for (const hijo of Array.from(dl.children)) {
      expect(Array.from(hijo.children).every((x) => x.tagName === "DT" || x.tagName === "DD")).toBe(true);
    }
    expect(screen.getByText("3 intentos")).toBeInTheDocument();
  });
});
