import { describe, expect, it } from "vitest";
import { appDeRed, entornoDeConexion } from "./entorno";

/**
 * CON-4 · lo que viaja por el árbol de render no lleva credenciales.
 * `loadOAuthApps` sí devuelve el clientSecret; `entornoDeConexion` lo
 * deja fuera a propósito, para que un componente que mañana sea de
 * cliente no lo mande al navegador.
 */

const ENV = {
  TIKTOK_LOGIN_CLIENT_KEY: "clave-tiktok",
  TIKTOK_LOGIN_CLIENT_SECRET: "SECRETO-TIKTOK-QUE-NO-DEBE-SALIR",
  APP_URL: "https://on-cue-web.vercel.app",
};

describe("entornoDeConexion", () => {
  it("no copia ningún valor del entorno: ni la clave, ni el secreto, ni la URL", () => {
    const entorno = entornoDeConexion(ENV, true);
    const serializado = JSON.stringify(entorno);
    for (const valor of Object.values(ENV)) expect(serializado).not.toContain(valor);
  });

  it("dice qué red está configurada y, si no lo está, qué variables faltan por su nombre", () => {
    const entorno = entornoDeConexion(ENV, true);
    expect(appDeRed(entorno, "tiktok")).toEqual({ configurada: true, faltan: [] });
    const instagram = appDeRed(entorno, "instagram");
    expect(instagram.configurada).toBe(false);
    expect(instagram.faltan).toEqual(["META_APP_ID", "META_APP_SECRET"]);
  });

  it("sin nada configurado, la bandera puede seguir encendida: la pantalla lo explica, no lo esconde", () => {
    const entorno = entornoDeConexion({}, true);
    expect(entorno.oauthConnect).toBe(true);
    expect(appDeRed(entorno, "tiktok").configurada).toBe(false);
    expect(appDeRed(entorno, "tiktok").faltan.length).toBeGreaterThan(0);
  });
});
