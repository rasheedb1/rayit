// @vitest-environment node
/**
 * El correo de una invitación: se envía si hay SMTP, y si no —o si el
 * servidor falla— la acción lo dice y la pantalla da el enlace. Nunca se
 * inventa un envío. Sin red: el transporte es falso.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { enviarInvitacion, remitente, type TransporteDeCorreo } from "./_lib/correo";

const correo = { para: "mariana@ejemplo.test", asunto: "Te invitan", texto: "Enlace: http://localhost:3100/invitacion/x" };

function transporte(falla = false) {
  const enviados: unknown[] = [];
  const t: TransporteDeCorreo = {
    async sendMail(m) {
      if (falla) throw new Error("ECONNREFUSED");
      enviados.push(m);
    },
  };
  return { t, enviados };
}

describe("enviarInvitacion", () => {
  test("sin SMTP_URL no intenta nada: sin_configurar", async () => {
    const { t, enviados } = transporte();
    expect(await enviarInvitacion(correo, {}, () => t)).toBe("sin_configurar");
    expect(enviados).toEqual([]);
  });

  test("en producción sin MAIL_FROM tampoco: un remitente inventado rebota", async () => {
    const { t, enviados } = transporte();
    expect(await enviarInvitacion(correo, { SMTP_URL: "smtp://x:25", NODE_ENV: "production" }, () => t)).toBe("sin_configurar");
    expect(enviados).toEqual([]);
  });

  test("con SMTP: un correo, al invitado y con MAIL_FROM", async () => {
    const { t, enviados } = transporte();
    expect(await enviarInvitacion(correo, { SMTP_URL: "smtp://x:25", MAIL_FROM: "On Cue <hola@oncue.app>" }, () => t)).toBe("enviado");
    expect(enviados).toEqual([{ from: "On Cue <hola@oncue.app>", to: correo.para, subject: correo.asunto, text: correo.texto }]);
  });

  test("si el servidor falla no lanza: fallo, y la invitación sigue en pie", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { t } = transporte(true);
    expect(await enviarInvitacion(correo, { SMTP_URL: "smtp://x:25" }, () => t)).toBe("fallo");
    // El registro dice qué falló, nunca el enlace ni el correo.
    expect(String(error.mock.calls[0])).not.toContain("invitacion/");
    expect(String(error.mock.calls[0])).not.toContain(correo.para);
    error.mockRestore();
  });

  test("fuera de producción, sin MAIL_FROM firma un remitente de desarrollo", () => {
    expect(remitente({ SMTP_URL: "smtp://localhost:1025" })).toMatch(/oncue\.invalid/);
    expect(remitente({ SMTP_URL: " " })).toBeNull();
  });
});
