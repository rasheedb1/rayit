import { describe, expect, it } from "vitest";
import { safeHref } from "./url";

describe("safeHref", () => {
  it("deja pasar http y https", () => {
    expect(safeHref("https://www.linkedin.com/in/laura")).toBe("https://www.linkedin.com/in/laura");
    expect(safeHref(" http://marca.co/pauta ")).toBe("http://marca.co/pauta");
  });

  it("no enlaza javascript:, data: ni nada que no sea una URL web", () => {
    for (const mala of [
      "javascript:alert(1)",
      "JavaScript:alert(document.cookie)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "file:///etc/passwd",
      "//evil.example/x",
      "no es una url",
      "",
      null,
      undefined,
    ]) {
      expect(safeHref(mala), String(mala)).toBeNull();
    }
  });
});
