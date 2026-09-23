import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * La compuerta de la configuración financiera.
 *
 * Es el criterio de terminado de FIN-8 que no se puede probar con un
 * comentario: «el Mánager no puede abrir la pantalla». Hoy los roles de
 * membership (0001) son owner · admin · member · viewer · client, y el
 * Mánager es `member` hasta que ACC-3 traiga `manager` y `finance`.
 */
const getCurrentContext = vi.fn();
vi.mock("@/lib/workspace/current", () => ({ getCurrentContext: () => getCurrentContext() }));

import {
  PERMISO_CONFIGURAR,
  PUEDEN_CONFIGURAR_FINANZAS,
  SinPermisoError,
  exigirConfigurarFinanzas,
  miRolEnElEspacio,
  puedeConfigurarFinanzas,
} from "./permiso";

const WS = "00000002-0000-4000-8000-000000000001";
const OTRO = "00000009-0000-4000-8000-000000000001";

/** El contexto de una petición con sesión, en el espacio WS con el rol dado. */
function contexto(role: string, workspaceId = WS) {
  return {
    workspaceId,
    sesion: { email: "laura@oncue.test" },
    identity: { userId: "u1", email: "laura@oncue.test" },
    workspaces: [
      { id: WS, name: "Laura", slug: "laura", kind: "creator", role },
      { id: OTRO, name: "Otro", slug: "otro", kind: "creator", role: "owner" },
    ],
  };
}

beforeEach(() => getCurrentContext.mockReset());

describe("quién configura Finanzas", () => {
  it("el dueño y quien administra el espacio sí", async () => {
    for (const role of ["owner", "admin"]) {
      getCurrentContext.mockResolvedValue(contexto(role));
      expect(await puedeConfigurarFinanzas(), role).toBe(true);
      await expect(exigirConfigurarFinanzas()).resolves.toBeUndefined();
    }
  });

  it("el Mánager (hoy `member`), quien solo mira y la marca de una agencia NO", async () => {
    for (const role of ["member", "viewer", "client"]) {
      getCurrentContext.mockResolvedValue(contexto(role));
      expect(await puedeConfigurarFinanzas(), role).toBe(false);
      await expect(exigirConfigurarFinanzas()).rejects.toThrow(SinPermisoError);
    }
  });

  it("el error nombra el permiso de ACC-1, para que buscarlo lo encuentre", async () => {
    getCurrentContext.mockResolvedValue(contexto("member"));
    await expect(exigirConfigurarFinanzas()).rejects.toThrow(/finanzas\.ajustes\.configurar/);
    expect(PERMISO_CONFIGURAR).toBe("finanzas.ajustes.configurar");
  });

  it("el rol sale del espacio ACTUAL, no del primero de la lista", async () => {
    // Soy `member` en el espacio en el que estoy y `owner` en otro: no
    // se hereda el rol del otro.
    getCurrentContext.mockResolvedValue(contexto("member", WS));
    expect(await miRolEnElEspacio()).toBe("member");
    expect(await puedeConfigurarFinanzas()).toBe(false);
  });

  it("si el espacio actual no está en mi lista no hay rol, y no se configura", async () => {
    // No debería pasar (current.ts solo sirve un espacio que la base
    // devolvió como mío), pero si pasara, la respuesta no es «sí».
    getCurrentContext.mockResolvedValue({ ...contexto("owner"), workspaceId: "00000000-0000-4000-8000-000000000000" });
    expect(await miRolEnElEspacio()).toBeNull();
    expect(await puedeConfigurarFinanzas()).toBe(false);
  });

  it("sin sesión (una copia sin llaves, el modo demo) se sirve la pantalla", async () => {
    getCurrentContext.mockResolvedValue({ workspaceId: WS, sesion: null, workspaces: [] });
    expect(await miRolEnElEspacio()).toBeNull();
    expect(await puedeConfigurarFinanzas()).toBe(true);
  });

  it("la lista de roles que pueden es la que se documenta, sin sorpresas", () => {
    expect([...PUEDEN_CONFIGURAR_FINANZAS].sort()).toEqual(["admin", "owner"]);
  });
});
