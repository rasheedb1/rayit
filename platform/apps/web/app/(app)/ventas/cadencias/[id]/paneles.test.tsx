import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Los paneles de la cadencia, con acciones falsas: activar (qué se lee
 * mientras corre y adónde lleva después), enrolar (cuándo no hay a quién)
 * y «Por qué esta propuesta» (cuándo lleva a Canales).
 */
const { activarCadencia } = vi.hoisted(() => ({ activarCadencia: vi.fn() }));
vi.mock("../actions", () => ({
  activarCadencia,
  cambiarEstado: vi.fn(async () => ({})),
  duplicarCadencia: vi.fn(async () => ({})),
  renombrarCadencia: vi.fn(async () => ({})),
  enrolarDesdeNegocio: vi.fn(async () => ({})),
}));

import type { SequenceDetail } from "@mc/db/queries/cadencias";
import { formatterFor } from "@/lib/format";
import { MESSAGES } from "../messages";
import { Controles } from "./controles";
import { Enrolar, type NegocioVista } from "./enrolar";
import { Notas } from "./notas";

const SEQ = "00000013-0000-4000-8000-000000000a01";
const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });

beforeEach(() => {
  activarCadencia.mockReset();
});

describe("activar", () => {
  it("mientras activa, lo dice en texto (y a un lector de pantalla); después, lleva a la ficha a aprobar", async () => {
    let contestar: (v: unknown) => void = () => {};
    activarCadencia.mockImplementation(() => new Promise((r) => (contestar = r)));
    render(<Controles sequenceId={SEQ} status="draft" nombre="Fresko" activarLabel="Activar y escribir a Camila Rojas" puedeActivar />);
    fireEvent.click(screen.getByRole("button", { name: "Activar y escribir a Camila Rojas" }));
    await waitFor(() => expect(screen.getByText(MESSAGES.estado.trabajando.activar)).toBeInTheDocument());
    expect(screen.getByText(MESSAGES.estado.trabajando.activar)).toHaveAttribute("aria-live", "polite");
    await act(async () => contestar({ ok: "Cadencia activa y Camila Rojas dentro.", href: "/ventas/empresas/e2#cadencia" }));
    expect(await screen.findByRole("link", { name: MESSAGES.estado.revisarEnFicha })).toHaveAttribute("href", "/ventas/empresas/e2#cadencia");
    expect(screen.queryByText(MESSAGES.estado.trabajando.activar)).not.toBeInTheDocument();
  });

  it("«Duplicar» gira y apaga la fila mientras corre: un segundo clic no hace otra copia", async () => {
    const { duplicarCadencia } = await import("../actions");
    let contestar: () => void = () => {};
    vi.mocked(duplicarCadencia).mockImplementationOnce(() => new Promise((r) => (contestar = () => r({}))));
    render(<Controles sequenceId={SEQ} status="active" nombre="Fresko" activarLabel="Activar" puedeActivar />);
    const duplicar = screen.getByRole("button", { name: MESSAGES.estado.duplicar });
    fireEvent.click(duplicar);
    await waitFor(() => expect(screen.getByText(MESSAGES.estado.trabajando.duplicar)).toBeInTheDocument());
    expect(duplicar).toBeDisabled();
    expect(duplicar).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: MESSAGES.estado.pausar })).toBeDisabled();
    expect(screen.getByRole("button", { name: MESSAGES.detalle.renombrar })).toBeDisabled();
    fireEvent.click(duplicar);
    expect(duplicarCadencia).toHaveBeenCalledTimes(1);
    await act(async () => contestar());
    expect(screen.getByRole("button", { name: MESSAGES.estado.duplicar })).not.toBeDisabled();
  });

  it("en pausa, el botón es el que la página decide (Reanudar y escribir a X), no un «Reanudar» fijo", () => {
    render(<Controles sequenceId={SEQ} status="paused" nombre="Fresko" activarLabel={MESSAGES.estado.reanudarPara("Camila Rojas")} puedeActivar />);
    expect(screen.getByRole("button", { name: "Reanudar y escribir a Camila Rojas" })).toBeInTheDocument();
  });
});

describe("enrolar", () => {
  const negocio = (personas: NegocioVista["personas"]): NegocioVista[] => [{ id: "d1", label: "Granos · Café", personas }];

  it("con el negocio elegido y nadie que pueda entrar, «Enrolar» se apaga y dice por qué", () => {
    render(
      <Enrolar
        sequenceId={SEQ}
        activa
        inicial="d1"
        negocios={negocio([
          { id: "c1", nombre: "Laura", detalle: "Ya está dentro", disponible: false, dentro: true },
          { id: "c2", nombre: "Mateo", detalle: "Pidió no recibir mensajes", disponible: false, dentro: false },
        ])}
      />,
    );
    expect(screen.getByRole("button", { name: MESSAGES.enrolar.boton })).toBeDisabled();
    expect(screen.getByText(MESSAGES.enrolar.nadieDisponible)).toBeInTheDocument();
  });

  it("con alguien disponible, se puede enrolar", () => {
    render(
      <Enrolar
        sequenceId={SEQ}
        activa
        inicial="d1"
        negocios={negocio([{ id: "c1", nombre: "Laura", detalle: "Correo", disponible: true, dentro: false }])}
      />,
    );
    expect(screen.getByRole("button", { name: MESSAGES.enrolar.boton })).toBeEnabled();
    expect(screen.queryByText(MESSAGES.enrolar.nadieDisponible)).not.toBeInTheDocument();
  });
});

describe("por qué esta propuesta", () => {
  const detalle = (notes: NonNullable<SequenceDetail["proposal"]>["notes"]): SequenceDetail =>
    ({
      proposal: {
        version: 1, templateSlug: "x", signalKind: "active_campaign", notes, guidance: "rules", guidanceWhyRules: "no_key",
        model: null, contactId: null, dealId: null, proposedAt: "",
      },
      policy: { maxTouchesPerCompany: 4, minDaysBetweenTouches: 3, overCap: [], closerThanGap: [] },
    }) as unknown as SequenceDetail;
  const pintar = (d: SequenceDetail) => render(<Notas d={d} f={f} plantillas={new Map()} angulos={new Map()} />);

  it("sin llave de IA no manda a Canales: la llave no se arregla ahí", () => {
    pintar(detalle([{ code: "template", slug: "x", match: "signal" }]));
    expect(screen.getByText(MESSAGES.notas.guiaReglas.no_key!)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: MESSAGES.notas.reconectar })).not.toBeInTheDocument();
  });

  it("una cuenta por reconectar o un canal sin conectar sí llevan a Canales", () => {
    const { unmount } = pintar(detalle([{ code: "channel_down", channel: "linkedin" }]));
    expect(screen.getByRole("link", { name: MESSAGES.notas.reconectar })).toBeInTheDocument();
    unmount();
    pintar(detalle([{ code: "rerouted", step: 2, from: "linkedin", to: "email", manual: false, reason: "channel_not_connected" }]));
    expect(screen.getByRole("link", { name: MESSAGES.notas.reconectar })).toBeInTheDocument();
  });
});
