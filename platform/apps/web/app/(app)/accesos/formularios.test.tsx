import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { InvitarState } from "./actions";

// El estado de la acción se inyecta: aquí se prueba qué PINTA el
// formulario; la acción y la base, en equipo-db.test.tsx.
let estado: InvitarState = {};
const despachar = vi.fn();
vi.mock("react", async () => {
  const react = await vi.importActual<typeof import("react")>("react");
  return { ...react, useActionState: () => [estado, despachar, false] };
});
vi.mock("./actions", () => ({
  invitar: vi.fn(),
  cambiarRol: vi.fn(),
  quitarMiembro: vi.fn(),
  renovarInvitacion: vi.fn(),
  revocarInvitacion: vi.fn(),
}));

import { MESSAGES } from "./_lib/messages";
import { CambiarRol, InvitarForm, QuitarMiembro, type CasillaOpcion, type RolOpcion } from "./formularios";

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

describe("InvitarForm: un error no borra lo escrito", () => {
  it("tras un error, el correo, el rol y la casilla siguen como estaban, y el envío lleva los tres", () => {
    const { container, rerender } = pintar();
    const correo = screen.getByLabelText(new RegExp(`^${MESSAGES.invitar.correo}`)) as HTMLInputElement;
    fireEvent.change(correo, { target: { value: "mariana@ejemplo.test" } });
    elegir("Mánager");
    fireEvent.click(screen.getByLabelText(MESSAGES.casillas.finanzas.label));
    despachar.mockClear();

    act(() => {
      fireEvent.submit(container.querySelector("form")!);
    });
    expect(despachar).toHaveBeenCalledTimes(1);
    const enviado = despachar.mock.calls[0]![0] as FormData;
    expect(enviado.get("email")).toBe("mariana@ejemplo.test");
    expect(enviado.get("roleId")).toBe(ROLES[1]!.id);
    expect(enviado.get("casilla.finanzas")).toBe("on");

    // La acción responde con un error: React 19 vaciaría un <form action>.
    estado = { message: MESSAGES.errores.cannot_grant };
    rerender(<InvitarForm roles={ROLES} casillas={TODAS} fechas={fechas} />);
    expect(screen.getByText(MESSAGES.errores.cannot_grant)).toBeInTheDocument();
    expect((screen.getByLabelText(new RegExp(`^${MESSAGES.invitar.correo}`)) as HTMLInputElement).value).toBe("mariana@ejemplo.test");
    expect((screen.getByLabelText(new RegExp(`^${MESSAGES.invitar.rol}`)) as HTMLSelectElement).value).toBe(ROLES[1]!.id);
    expect(screen.getByLabelText(MESSAGES.casillas.finanzas.label)).toBeChecked();
    expect(screen.getByLabelText(MESSAGES.casillas.conexiones.label)).not.toBeChecked();
  });
});

describe("InvitarForm: el error de un campo se apaga al corregirlo", () => {
  it("tras enviar vacío, escribir el correo apaga su error, y elegir el rol, el suyo", () => {
    const { rerender } = pintar();
    estado = { errors: { email: MESSAGES.errores.correo, roleId: MESSAGES.errores.rol } };
    rerender(<InvitarForm roles={ROLES} casillas={TODAS} fechas={fechas} />);
    expect(screen.getByText(MESSAGES.errores.correo)).toBeInTheDocument();
    expect(screen.getByText(MESSAGES.errores.rol)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(new RegExp(`^${MESSAGES.invitar.correo}`)), { target: { value: "mariana@ejemplo.test" } });
    expect(screen.queryByText(MESSAGES.errores.correo)).toBeNull();
    expect(screen.getByText(MESSAGES.errores.rol)).toBeInTheDocument();
    expect(screen.getByLabelText(new RegExp(`^${MESSAGES.invitar.correo}`))).not.toHaveAttribute("aria-invalid", "true");

    elegir("Mánager");
    expect(screen.queryByText(MESSAGES.errores.rol)).toBeNull();

    // La siguiente respuesta trae sus propios errores, y se vuelven a ver.
    estado = { errors: { email: MESSAGES.errores.correo } };
    rerender(<InvitarForm roles={ROLES} casillas={TODAS} fechas={fechas} />);
    expect(screen.getByText(MESSAGES.errores.correo)).toBeInTheDocument();
  });
});

describe("CambiarRol", () => {
  function abrir() {
    estado = {};
    render(<CambiarRol userId="u1" roleId={ROLES[2]!.id} marcadas={[]} roles={ROLES} casillas={TODAS} />);
    const boton = screen.getByRole("button", { name: MESSAGES.miembros.cambiarRol });
    fireEvent.click(boton);
  }

  it("al abrir, el foco va al selector; Escape cierra y lo devuelve al botón", () => {
    abrir();
    expect(screen.getByLabelText(new RegExp(`^${MESSAGES.invitar.rol}`))).toHaveFocus();
    fireEvent.keyDown(screen.getByLabelText(new RegExp(`^${MESSAGES.invitar.rol}`)), { key: "Escape" });
    expect(screen.getByRole("button", { name: MESSAGES.miembros.cambiarRol })).toHaveFocus();
  });

  it("Cancelar también devuelve el foco al botón", () => {
    abrir();
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.miembros.cancelar }));
    expect(screen.getByRole("button", { name: MESSAGES.miembros.cambiarRol })).toHaveFocus();
  });

  it("si la acción vuelve con un error, el panel sigue abierto y el foco va al error", () => {
    estado = {};
    const { rerender } = render(<CambiarRol userId="u1" roleId={ROLES[0]!.id} marcadas={[]} roles={ROLES} casillas={TODAS} />);
    fireEvent.click(screen.getByRole("button", { name: MESSAGES.miembros.cambiarRol }));
    estado = { message: MESSAGES.errores.last_owner };
    rerender(<CambiarRol userId="u1" roleId={ROLES[0]!.id} marcadas={[]} roles={ROLES} casillas={TODAS} />);
    expect(screen.getByRole("alert")).toHaveTextContent(MESSAGES.errores.last_owner);
    expect(screen.getByRole("alert")).toHaveFocus();
    expect(screen.getByRole("button", { name: MESSAGES.miembros.guardar })).toBeInTheDocument();
  });
});

describe("QuitarMiembro", () => {
  it("a la única dueña no se le ofrece: el botón sale deshabilitado y dice por qué", () => {
    estado = {};
    render(<QuitarMiembro userId="u1" quien="Laura" unicoDueno />);
    expect(screen.getByRole("button", { name: MESSAGES.miembros.quitar })).toBeDisabled();
    expect(screen.getByText(MESSAGES.errores.last_owner)).toBeInTheDocument();
  });

  it("a cualquier otra persona, sí", () => {
    estado = {};
    render(<QuitarMiembro userId="u2" quien="Mariana" />);
    expect(screen.getByRole("button", { name: MESSAGES.miembros.quitar })).toBeEnabled();
  });
});
