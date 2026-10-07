// @vitest-environment node
/**
 * La pantalla se llama «Equipo» y vive en /accesos (ACC-5 reservó la
 * ruta). /equipo redirige ahí, de forma permanente (next.config.ts), para
 * quien escribe la URL a mano o llega por un enlace de soporte.
 */
import { describe, expect, it } from "vitest";
import nextConfig from "../../../next.config";
import { moduleBySlug } from "@/content/modules";

describe("/equipo", () => {
  it("redirige, permanente, a /accesos", async () => {
    const redirecciones = (await nextConfig.redirects?.()) ?? [];
    expect(redirecciones).toContainEqual({ source: "/equipo", destination: "/accesos", permanent: true });
  });

  it("y /accesos es el módulo que el menú llama «Equipo»", () => {
    expect(moduleBySlug("accesos")?.name).toBe("Equipo");
  });
});
