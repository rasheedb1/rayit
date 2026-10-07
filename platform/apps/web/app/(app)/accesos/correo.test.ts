// @vitest-environment node
/**
 * El correo de una invitación: se envía si hay SMTP, y si no —o si el
 * servidor falla— la acción lo dice y la pantalla da el enlace. Nunca se
 * inventa un envío. Sin red: el transporte es falso.
 */
import { describe, expect, test, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { enviarInvitacion, NOMBRE_EN_CORREO_MAX, nombreParaCorreo, remitente, type TransporteDeCorreo } from "./_lib/correo";
import { MESSAGES } from "./_lib/messages";

const correo = {
  para: "mariana@ejemplo.test",
  asunto: "Te invitan",
  texto: "Enlace: http://localhost:3100/invitacion/x",
  invitadoPor: "00000002-0000-4000-8000-000000000002",
};

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
  test("sin quien invite (modo demo, invited_by NULL) no se envía aunque haya SMTP: demo, y el transporte ni se crea", async () => {
    const crear = vi.fn(() => transporte().t);
    const env = { SMTP_URL: "smtp://x:25", MAIL_FROM: "On Cue <hola@oncue.app>" };
    expect(await enviarInvitacion({ ...correo, invitadoPor: null }, env, crear)).toBe("demo");
    expect(crear).not.toHaveBeenCalled();
  });

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

describe("nombreParaCorreo: lo que pone quien invita, en una línea y corto", () => {
  test("un nombre normal pasa tal cual", () => {
    expect(nombreParaCorreo("Espacio de Laura")).toBe("Espacio de Laura");
  });

  test("saltos de línea, tabuladores y caracteres de control pasan a un espacio: no parten el asunto", () => {
    expect(nombreParaCorreo("Laura\r\nBcc: todos@ejemplo.test\t\u0000fin")).toBe("Laura Bcc: todos@ejemplo.test fin");
  });

  test(`un nombre largo se recorta a ${NOMBRE_EN_CORREO_MAX} con «…», sin partir un emoji`, () => {
    const largo = `${"Tu cuenta fue suspendida, verifica tus datos aquí ".repeat(4)}😀`;
    const corto = nombreParaCorreo(largo);
    expect([...corto].length).toBeLessThanOrEqual(NOMBRE_EN_CORREO_MAX);
    expect(corto.endsWith("…")).toBe(true);
    expect(nombreParaCorreo("ñ".repeat(NOMBRE_EN_CORREO_MAX))).toBe("ñ".repeat(NOMBRE_EN_CORREO_MAX));
    expect([...nombreParaCorreo("😀".repeat(NOMBRE_EN_CORREO_MAX + 5))].length).toBe(NOMBRE_EN_CORREO_MAX);
  });
});

describe("el cuerpo del correo", () => {
  const base = { espacio: "Laura Méndez", rol: "Mánager", quien: "Laura", enlace: "http://x/invitacion/abc", vence: "14 de octubre de 2026" };

  test("con casillas, las cuenta al invitado y con el nombre del espacio", () => {
    const cuerpo = MESSAGES.correo.cuerpo({ ...base, casillas: ["finanzas", "conexiones"] });
    expect(cuerpo).toContain("Además de tu rol podrás:");
    expect(cuerpo).toContain("Ver las finanzas de Laura Méndez: facturas, gastos y flujo de caja.");
    expect(cuerpo).toContain("Conectar y quitar las cuentas de redes de Laura Méndez.");
    expect(cuerpo).not.toContain("mis finanzas");
  });

  test("sin casillas, ni la línea", () => {
    expect(MESSAGES.correo.cuerpo({ ...base, casillas: [] })).not.toContain("Además de tu rol");
  });
});
