import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * /legal (CIM-9): el borrador publica la fecha de versión y el aviso de
 * revisión legal a la vista; el contacto depende de SUPPORT_EMAIL y sin
 * él no inventa una dirección.
 */
const env = vi.hoisted(() => ({ SUPPORT_EMAIL: "" as string | undefined }));
vi.mock("@/lib/soporte", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/soporte")>();
  return { ...real, correoDeSoporte: () => real.correoDeSoporte({ SUPPORT_EMAIL: env.SUPPORT_EMAIL, NODE_ENV: "test" } as never, () => {}) };
});

import { MESSAGES } from "@/lib/auth/messages";
import LegalPage from "./page";

const t = MESSAGES.legal;

describe("/legal", () => {
  it("publica la versión, el aviso de borrador y las dos secciones con su ancla", () => {
    env.SUPPORT_EMAIL = "";
    render(<LegalPage />);
    expect(screen.getByText(t.version)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("Borrador pendiente de revisión legal");
    expect(document.getElementById("terminos")).not.toBeNull();
    expect(document.getElementById("privacidad")).not.toBeNull();
    // Lo que la ley pide nombrar está en el texto: responsable, base legal, plazos y contacto.
    const texto = document.body.textContent ?? "";
    for (const frase of ["Responsable del tratamiento", "Ley 1581 de 2012", "Cuánto tiempo", "Quién los ve"]) {
      expect(texto).toContain(frase);
    }
    expect(screen.getByText(t.contacto.sinCorreo)).toBeInTheDocument();
  });

  it("con SUPPORT_EMAIL enseña el correo como enlace mailto", () => {
    env.SUPPORT_EMAIL = "datos@oncue.test";
    render(<LegalPage />);
    expect(screen.getByRole("link", { name: "datos@oncue.test" })).toHaveAttribute("href", "mailto:datos@oncue.test");
  });
});
