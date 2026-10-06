import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InvitarState } from "./actions";

// El estado de la acción se inyecta: aquí se prueba qué PINTA el
// formulario; la acción y la base, en equipo-db.test.tsx.
let estado: InvitarState = {};
vi.mock("react", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { ...react, useActionState: () => [estado, vi.fn(), false] };
});
vi.mock("./actions", () => ({
  invitar: vi.fn(),
  cambiarRol: vi.fn(),
  quitarMiembro: vi.fn(),
  renovarInvitacion: vi.fn(),
}));

import { MESSAGES } from "./_lib/messages";
import { InvitarForm, type CasillaOpcion, type RolOpcion } from "./formularios";

const ROLES: RolOpcion[] = [
  { id: "00000000-0000-4000-8000-000000000001", label: "Dueño", description: "El creador.", conCasillas: false },
  { id: "00000000-0000-4000-8000-000000000002", label: "Mánager", description: "Su agente.", conCasillas: true },
  { id: "00000000-0000-4000-8000-000000000003", label: "Editor", description: "Edita video.", conCasillas: false },
];
const TODAS: CasillaOpcion[] = [
  { casilla: "finanzas", disponible: true },
  { casilla: "conexiones", disponible: true },
];
const fechas = { locale: "es-CO", timeZone: "America/Bogota" };

function pintar(st: InvitarState = {}, casillas: CasillaOpcion[] = TODAS) {
  estado = st;
  return render(<InvitarForm roles={ROLES} casillas={casillas} fechas={fechas} />);
}

const elegir = (label: string) =>
  fireEvent.change(screen.getByLabelText(new RegExp(`^${MESSAGES.invitar.rol}`)), {
    target: { value: ROLES.find((r) => r.label === label)!.id },
  });

describe("InvitarForm", () => {
  it("las casillas solo aparecen con el rol de Mánager", () => {
    pintar();
    expect(screen.queryByLabelText(MESSAGES.casillas.finanzas.label)).toBeNull();
    elegir("Editor");
    expect(screen.queryByLabelText(MESSAGES.casillas.finanzas.label)).toBeNull();
    elegir("Mánager");
    expect(screen.getByLabelText(MESSAGES.casillas.finanzas.label)).toBeInTheDocument();
    expect(screen.getByLabelText(MESSAGES.casillas.conexiones.label)).toBeInTheDocument();
  });

  it("y nacen APAGADAS", () => {
    pintar();
    elegir("Mánager");
    expect(screen.getByLabelText(MESSAGES.casillas.finanzas.label)).not.toBeChecked();
    expect(screen.getByLabelText(MESSAGES.casillas.conexiones.label)).not.toBeChecked();
  });

  it("una casilla que quien invita no tiene se ve deshabilitada y dice por qué", () => {
    pintar({}, [
      { casilla: "finanzas", disponible: false },
      { casilla: "conexiones", disponible: true },
    ]);
    elegir("Mánager");
    expect(screen.getByLabelText(MESSAGES.casillas.finanzas.label)).toBeDisabled();
    expect(screen.getByText(new RegExp(MESSAGES.casillaNoDisponible))).toBeInTheDocument();
    expect(screen.getByLabelText(MESSAGES.casillas.conexiones.label)).toBeEnabled();
  });

  it("sin SMTP, el enlace para copiar y la frase que lo dice; sin inventar un envío", () => {
    pintar({
      ok: true,
      invitacion: {
        correo: "mariana@ejemplo.test",
        enlace: "http://localhost:3100/invitacion/abc",
        envio: "sin_configurar",
        venceIso: "2026-10-12T17:00:00.000Z",
        reemplazadas: 0,
      },
    });
    expect(screen.getByDisplayValue("http://localhost:3100/invitacion/abc")).toBeInTheDocument();
    expect(screen.getByText(MESSAGES.resultado.sinCorreo)).toBeInTheDocument();
    expect(screen.queryByText(MESSAGES.resultado.enviada)).toBeNull();
    expect(screen.getByText(/12 de octubre de 2026/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: MESSAGES.resultado.copiar })).toBeInTheDocument();
  });

  it("con el correo enviado lo dice, y el enlace sigue a mano", () => {
    pintar({
      ok: true,
      invitacion: { correo: "m@e.test", enlace: "http://x/invitacion/abc", envio: "enviado", venceIso: "2026-10-12T17:00:00.000Z", reemplazadas: 1 },
    });
    expect(screen.getByText(MESSAGES.resultado.enviada)).toBeInTheDocument();
    expect(screen.getByText(MESSAGES.resultado.reemplazada)).toBeInTheDocument();
  });

  it("los errores de la acción, en su campo y en general", () => {
    pintar({ errors: { email: MESSAGES.errores.correo }, message: MESSAGES.errores.cannot_grant });
    expect(screen.getByText(MESSAGES.errores.correo)).toBeInTheDocument();
    expect(screen.getByText(MESSAGES.errores.cannot_grant)).toBeInTheDocument();
  });
});
