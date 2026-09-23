import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Field } from "@/components/ui/field";
import { FechaInput } from "./fecha";

describe("FechaInput", () => {
  it("pinta el anillo con :focus, porque en Chromium el date no casa :focus-visible desde su segmento", () => {
    render(
      <Field label="Vence el" htmlFor="f-vence">
        <FechaInput value="" onChange={() => {}} className="max-w-xs" />
      </Field>,
    );
    const campo = screen.getByLabelText("Vence el");
    expect(campo).toHaveAttribute("type", "date");
    expect(campo).toHaveClass("focus:border-ink", "focus:ring-2", "focus:ring-ink/15");
    // Conserva lo del kit y lo que pasa quien lo usa.
    expect(campo).toHaveClass("focus-visible:ring-2", "tabular-nums", "max-w-xs");
  });
});
