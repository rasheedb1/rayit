import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PlatformPill } from "./platform-pill";

describe("PlatformPill", () => {
  it("muestra el nombre de la red y el punto con el token de su color", () => {
    const { container } = render(<PlatformPill platformId="tiktok" />);
    expect(screen.getByText("TikTok")).toBeInTheDocument();
    const dot = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(dot.style.color).toBe("var(--s-tiktok)");
  });
  it("una red desconocida se muestra tal cual, sin color", () => {
    const { container } = render(<PlatformPill platformId="threads" />);
    expect(screen.getByText("threads")).toBeInTheDocument();
    const dot = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(dot.style.color).toBe("");
  });
  it("un nombre heredado de Object no cuenta como red conocida", () => {
    render(<PlatformPill platformId="constructor" />);
    expect(screen.getByText("constructor")).toBeInTheDocument();
  });
});
