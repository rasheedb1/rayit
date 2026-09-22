// @vitest-environment node
/**
 * La cookie del espacio elegido tiene un solo trabajo: no dejarse
 * falsificar. Si se pudiera editar a mano, cambiar un uuid en el
 * navegador sería pedirle a la base los datos de otro cliente.
 */
import { describe, expect, test } from "vitest";
import { abrirEspacio, COOKIE_WORKSPACE_MAX_AGE_S, puedeFirmar, sellarEspacio } from "./cookie";

/** 32 bytes en base64, como la del vault. No abre nada: solo firma esta cookie. */
const CLAVE = { TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") };
const OTRA_CLAVE = { TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64") };

const ELEGIDO = { w: "0000000a-0000-4000-8000-000000000001", u: "0000000b-0000-4000-8000-000000000001", e: "ana@ejemplo.test" };

describe("mc.workspace", () => {
  test("lo que se firma se abre", () => {
    const valor = sellarEspacio(ELEGIDO, CLAVE)!;
    expect(valor).toBeTruthy();
    expect(abrirEspacio(valor, ELEGIDO.e, CLAVE)).toEqual(ELEGIDO);
  });

  test("el correo no distingue mayúsculas, pero sí persona", () => {
    const valor = sellarEspacio(ELEGIDO, CLAVE)!;
    expect(abrirEspacio(valor, "ANA@Ejemplo.test", CLAVE)).toEqual(ELEGIDO);
    // Otra cuenta en el mismo navegador no hereda el espacio de la anterior.
    expect(abrirEspacio(valor, "bruno@ejemplo.test", CLAVE)).toBeNull();
  });

  test("una cookie manipulada no vale", () => {
    const valor = sellarEspacio(ELEGIDO, CLAVE)!;
    const [cuerpo, firma] = valor.split(".");
    const otro = Buffer.from(JSON.stringify({ p: { ...ELEGIDO, w: "0000000c-0000-4000-8000-000000000001" }, at: Date.now() }))
      .toString("base64url");
    expect(abrirEspacio(`${otro}.${firma}`, ELEGIDO.e, CLAVE)).toBeNull();
    expect(abrirEspacio(`${cuerpo}.zzzz`, ELEGIDO.e, CLAVE)).toBeNull();
    expect(abrirEspacio("cualquier-cosa", ELEGIDO.e, CLAVE)).toBeNull();
    expect(abrirEspacio(undefined, ELEGIDO.e, CLAVE)).toBeNull();
  });

  test("firmada con otra clave maestra, tampoco", () => {
    const valor = sellarEspacio(ELEGIDO, OTRA_CLAVE)!;
    expect(abrirEspacio(valor, ELEGIDO.e, CLAVE)).toBeNull();
  });

  test("caduca", () => {
    const ayer = new Date(Date.now() - (COOKIE_WORKSPACE_MAX_AGE_S + 60) * 1000);
    const valor = sellarEspacio(ELEGIDO, CLAVE, ayer)!;
    expect(abrirEspacio(valor, ELEGIDO.e, CLAVE)).toBeNull();
  });

  test("sin clave maestra no se firma ni se abre, y se dice", () => {
    expect(puedeFirmar({})).toBe(false);
    expect(sellarEspacio(ELEGIDO, {})).toBeNull();
    const valor = sellarEspacio(ELEGIDO, CLAVE)!;
    expect(abrirEspacio(valor, ELEGIDO.e, {})).toBeNull();
  });
});
