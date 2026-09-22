// @vitest-environment node
/**
 * De dónde salen las llaves de Supabase y qué pasa cuando faltan.
 *
 * Lo que NO se puede probar aquí es la sustitución estática que hace
 * Next (`process.env.NEXT_PUBLIC_…` literal → valor en el bundle),
 * porque ocurre al compilar: eso se comprobó contra `next build`
 * buscando el valor dentro de `.next/server/middleware.js`. Lo que sí
 * se fija aquí es el orden —el nombre público manda sobre el del
 * vault— y que pasar un entorno propio describa ese entorno completo,
 * sin heredar lo que tenga la máquina.
 */
import { describe, expect, test } from "vitest";
import { authConfig, faltantesAuth, isAuthConfigured, requireAuthConfig } from "./config";

const PUBLICAS = { NEXT_PUBLIC_SUPABASE_URL: "https://publica.supabase.co", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-publica" };
const VAULT = { SUPABASE_URL: "https://vault.supabase.co", SUPABASE_ANON_KEY: "anon-vault" };

describe("authConfig", () => {
  test("el nombre público manda sobre el del vault", () => {
    expect(authConfig({ ...VAULT, ...PUBLICAS })).toEqual({ url: PUBLICAS.NEXT_PUBLIC_SUPABASE_URL, anonKey: PUBLICAS.NEXT_PUBLIC_SUPABASE_ANON_KEY });
  });

  test("con solo las del vault también arranca: no hay que duplicar variables a mano", () => {
    expect(authConfig(VAULT)).toEqual({ url: VAULT.SUPABASE_URL, anonKey: VAULT.SUPABASE_ANON_KEY });
  });

  test("una pública vacía no tapa a la del vault", () => {
    expect(authConfig({ ...VAULT, NEXT_PUBLIC_SUPABASE_URL: "   " })?.url).toBe(VAULT.SUPABASE_URL);
  });

  test("falta una, no hay configuración: la web va en modo demo", () => {
    expect(authConfig({ SUPABASE_URL: VAULT.SUPABASE_URL })).toBeNull();
    expect(isAuthConfigured({})).toBe(false);
    expect(faltantesAuth({})).toEqual(["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]);
    expect(faltantesAuth(VAULT)).toEqual([]);
  });

  test("un entorno propio no hereda lo que tenga la máquina", () => {
    // Si `{}` mirara las constantes estáticas, una máquina con
    // .env.local cargado haría pasar pruebas que en el CI fallan.
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://de-la-maquina.supabase.co";
    try {
      expect(authConfig({})).toBeNull();
    } finally {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    }
  });

  test("el error dice el comando exacto que consigue las llaves", () => {
    expect(() => requireAuthConfig({})).toThrow(/make db\.unlock/);
  });
});
