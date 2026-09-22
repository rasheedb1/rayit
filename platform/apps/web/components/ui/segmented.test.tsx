import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Segmented } from "./segmented";

const options = [
  { value: "all", label: "Todas" },
  { value: "tiktok", label: "TikTok" },
  { value: "instagram", label: "Instagram" },
  { value: "youtube", label: "YouTube", disabled: true },
];

describe("Segmented", () => {
  it("grupo con aria-label y la opción activa con aria-pressed", () => {
    render(<Segmented label="Red" options={options} value="tiktok" onChange={() => {}} />);
    expect(screen.getByRole("group", { name: "Red" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "TikTok" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Todas" })).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "YouTube" })).toBeDisabled();
  });
  it("clic y flechas cambian el valor, saltando las deshabilitadas", () => {
    const onChange = vi.fn();
    render(<Segmented label="Red" options={options} value="instagram" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Todas" }));
    expect(onChange).toHaveBeenLastCalledWith("all");
    fireEvent.keyDown(screen.getByRole("button", { name: "Instagram" }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("all");
    fireEvent.keyDown(screen.getByRole("button", { name: "Instagram" }), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("tiktok");
  });
  it("si el valor activo está deshabilitado o no existe, la primera opción habilitada es alcanzable con Tab", () => {
    render(<Segmented label="Red" options={options} value="youtube" onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Todas" })).toHaveAttribute("tabindex", "0");
  });
});
