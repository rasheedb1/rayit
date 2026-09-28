import { describe, expect, it } from "vitest";
import { isGrantMissing } from "./errores-db";

const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

describe("isGrantMissing", () => {
  it("el 42501 de una tabla sin GRANT es la falta de la 0041", () => {
    expect(isGrantMissing(pgError("42501", "permission denied for table campaign_result"))).toBe(true);
  });

  it("una violación de RLS comparte el 42501 pero no es la falta del GRANT", () => {
    expect(isGrantMissing(pgError("42501", 'new row violates row-level security policy "campaign_result_web_insert" for table "campaign_result"'))).toBe(false);
  });

  it("otro código, o algo que no es un error de Postgres, tampoco", () => {
    expect(isGrantMissing(pgError("23505", "duplicate key value violates unique constraint"))).toBe(false);
    expect(isGrantMissing("permission denied")).toBe(false);
    expect(isGrantMissing(null)).toBe(false);
  });
});
