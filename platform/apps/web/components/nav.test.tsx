import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { flags, type Flags } from "@/content/flags";
import { MobileNav, SideNav } from "./nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/campanas" }));

const allOff: Flags = { ...flags, video_lab: false, agency_workspace: false, content_metrics: false, niche_radar: false, ideas_scripts: false, kit: false };

function productLinks() {
  const nav = screen.getByRole("navigation", { name: "Principal" });
  const list = within(nav).getAllByRole("list")[0]!;
  return within(list).getAllByRole("link").map((a) => a.getAttribute("href"));
}

describe("SideNav", () => {
  it("con la bandera apagada el módulo no aparece; encendida, aparece", () => {
    const { unmount } = render(<SideNav flags={allOff} />);
    expect(screen.queryByRole("link", { name: /Laboratorio de video/ })).not.toBeInTheDocument();
    unmount();
    render(<SideNav flags={{ ...allOff, video_lab: true }} />);
    expect(screen.getByRole("link", { name: /Laboratorio de video/ })).toHaveAttribute("href", "/laboratorio");
  });

  it("los seis módulos del MVP, en este orden", () => {
    render(<SideNav flags={allOff} />);
    expect(productLinks()).toEqual(["/resumen", "/ventas", "/cotizar", "/campanas", "/finanzas", "/conexiones"]);
  });

  it("marca el módulo activo por ruta con aria-current", () => {
    render(<SideNav flags={allOff} />);
    expect(screen.getByRole("link", { name: /Campañas/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Ventas/ })).not.toHaveAttribute("aria-current");
  });

  it("la galería del kit solo sale con su bandera", () => {
    const { unmount } = render(<SideNav flags={allOff} />);
    expect(screen.queryByRole("link", { name: /Kit de interfaz/ })).not.toBeInTheDocument();
    unmount();
    render(<SideNav flags={{ ...allOff, kit: true }} />);
    expect(screen.getByRole("link", { name: /Kit de interfaz/ })).toHaveAttribute("href", "/kit");
  });
});

describe("MobileNav", () => {
  it("respeta las banderas igual que el lateral", () => {
    render(<MobileNav flags={{ ...allOff, agency_workspace: true }} />);
    expect(screen.getByRole("link", { name: "Vista agencia" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Mis videos" })).not.toBeInTheDocument();
  });
});
