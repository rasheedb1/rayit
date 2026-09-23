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
import { describe, expect, test, vi } from "vitest";
import { claveDeCaptcha, esErrorDeCaptcha } from "./captcha";
import { authConfig, faltantesAuth, isAuthConfigured, requireAuthConfig } from "./config";
import { OrigenNoConfiguradoError, origenDesde } from "./origen";

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

/**
 * A dónde vuelve el enlace del correo (lib/auth/origen.ts). En
 * producción NUNCA se deduce de `host` ni de `x-forwarded-host`, que las
 * manda el cliente: la seguridad del enlace no puede depender de que la
 * lista de Redirect URLs de Supabase esté bien podada.
 */
describe("origenDesde", () => {
  const falsas = (valores: Record<string, string>) => ({ get: (n: string) => valores[n] ?? null });
  const ATACANTE = falsas({ host: "evil.test", "x-forwarded-host": "evil.test", "x-forwarded-proto": "https" });

  test("APP_URL manda siempre, sin barra final", () => {
    expect(origenDesde({ APP_URL: "https://on-cue-web.vercel.app/", NODE_ENV: "production" }, ATACANTE)).toBe("https://on-cue-web.vercel.app");
    expect(origenDesde({ APP_URL: "http://localhost:3100", NODE_ENV: "development" }, ATACANTE)).toBe("http://localhost:3100");
  });

  test("en producción sin APP_URL usa la URL de producción que pone Vercel, no las cabeceras", () => {
    const env = { NODE_ENV: "production", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "on-cue-web.vercel.app" };
    expect(origenDesde(env, ATACANTE)).toBe("https://on-cue-web.vercel.app");
  });

  test("en producción sin ninguna de las dos se niega, en vez de creerse la cabecera", () => {
    expect(() => origenDesde({ NODE_ENV: "production" }, ATACANTE)).toThrow(OrigenNoConfiguradoError);
    expect(() => origenDesde({ NODE_ENV: "production", VERCEL_ENV: "production" }, ATACANTE)).toThrow(/APP_URL/);
  });

  test("en una vista previa de Vercel (compila con production) y en desarrollo, sí se deduce de las cabeceras", () => {
    const preview = falsas({ "x-forwarded-host": "on-cue-web-git-rama-influ3.vercel.app" });
    expect(origenDesde({ NODE_ENV: "production", VERCEL_ENV: "preview" }, preview)).toBe("https://on-cue-web-git-rama-influ3.vercel.app");
    expect(origenDesde({ NODE_ENV: "development" }, falsas({ host: "localhost:3142" }))).toBe("http://localhost:3142");
  });

  test("sin cabecera ninguna, en desarrollo cae a un puerto de los agentes, no al 3000", () => {
    expect(origenDesde({ NODE_ENV: "development" }, falsas({}))).toBe("http://localhost:3100");
  });
});

describe("claveDeCaptcha (CIM-10)", () => {
  test("con la clave de Turnstile la devuelve; sin ella, null", () => {
    expect(claveDeCaptcha({ TURNSTILE_SITE_KEY: " 0x4AAAAAAAabcdEFGH_ij-k " }).siteKey).toBe("0x4AAAAAAAabcdEFGH_ij-k");
    expect(claveDeCaptcha({}).siteKey).toBeNull();
    expect(claveDeCaptcha({ TURNSTILE_SITE_KEY: "<script>" }).siteKey).toBeNull();
  });

  test("en producción sin clave avisa en el log, una sola vez", () => {
    const avisar = vi.fn();
    claveDeCaptcha({ NODE_ENV: "production" }, avisar);
    claveDeCaptcha({ NODE_ENV: "production" }, avisar);
    expect(avisar).toHaveBeenCalledTimes(1);
    expect(avisar.mock.calls[0]![0]).toMatch(/TURNSTILE_SITE_KEY/);
  });

  test("reconoce el rechazo del CAPTCHA por código o por mensaje", () => {
    expect(esErrorDeCaptcha({ code: "captcha_failed" })).toBe(true);
    expect(esErrorDeCaptcha({ message: "captcha verification process failed" })).toBe(true);
    expect(esErrorDeCaptcha({ message: "email rate limit exceeded" })).toBe(false);
    expect(esErrorDeCaptcha(null)).toBe(false);
  });
});
