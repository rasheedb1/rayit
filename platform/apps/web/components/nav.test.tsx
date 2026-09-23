import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { permisosDeRol } from "@mc/core";
import { flags, type Flags } from "@/content/flags";
import { MobileNav, SideNav } from "./nav";

vi.mock("next/navigation", () => ({ usePathname: () => "/campanas" }));

const allOff: Flags = { ...flags, video_lab: false, agency_workspace: false, content_metrics: false, niche_radar: false, ideas_scripts: false, kit: false };
/** El Dueño de creador: todo. */
const todo = [...permisosDeRol("creator", "owner")];
/** El Contador: solo Finanzas (ACC-5, «terminado cuando»). */
const contador = [...permisosDeRol("creator", "finance")];

function productLinks() {
  const nav = screen.getByRole("navigation", { name: "Principal" });
  const list = within(nav).getAllByRole("list")[0]!;
  return within(list).getAllByRole("link").map((a) => a.getAttribute("href"));
}

describe("SideNav", () => {
  it("con la bandera apagada el módulo no aparece; encendida, aparece", () => {
    const { unmount } = render(<SideNav flags={allOff} permisos={todo} />);
    expect(screen.queryByRole("link", { name: /Laboratorio de video/ })).not.toBeInTheDocument();
    unmount();
    render(<SideNav flags={{ ...allOff, video_lab: true }} permisos={todo} />);
    expect(screen.getByRole("link", { name: /Laboratorio de video/ })).toHaveAttribute("href", "/laboratorio");
  });

  it("los seis módulos del MVP, en este orden", () => {
    render(<SideNav flags={allOff} permisos={todo} />);
    expect(productLinks()).toEqual(["/resumen", "/ventas", "/cotizar", "/campanas", "/finanzas", "/conexiones"]);
  });

  it("marca el módulo activo por ruta con aria-current", () => {
    render(<SideNav flags={allOff} permisos={todo} />);
    expect(screen.getByRole("link", { name: /Campañas/ })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /Ventas/ })).not.toHaveAttribute("aria-current");
  });

  it("la galería del kit solo sale con su bandera", () => {
    const { unmount } = render(<SideNav flags={allOff} permisos={todo} />);
    expect(screen.queryByRole("link", { name: /Kit de interfaz/ })).not.toBeInTheDocument();
    unmount();
    render(<SideNav flags={{ ...allOff, kit: true }} permisos={todo} />);
    expect(screen.getByRole("link", { name: /Kit de interfaz/ })).toHaveAttribute("href", "/kit");
  });
});

describe("SideNav con permisos (ACC-5)", () => {
  it("con sesión de Contador no aparece Campañas y sí Finanzas; sin permisos, ningún módulo", () => {
    const { unmount } = render(<SideNav flags={allOff} permisos={contador} />);
    expect(productLinks()).toEqual(["/finanzas"]);
    expect(screen.queryByRole("link", { name: /Campañas/ })).not.toBeInTheDocument();
    unmount();
    render(<SideNav flags={allOff} permisos={[]} />);
    expect(screen.queryByRole("link", { name: /Finanzas/ })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Plan" })).toHaveAttribute("href", "/");
  });

  it("Accesos solo con equipo.miembro.ver (el Mánager lo tiene, el Contador no); Plan, Cimientos y Reglas siempre", () => {
    const { unmount } = render(<SideNav flags={allOff} permisos={contador} />);
    expect(screen.queryByRole("link", { name: "Accesos" })).not.toBeInTheDocument();
    for (const name of ["Plan", "Cimientos", "Reglas"]) expect(screen.getByRole("link", { name })).toBeInTheDocument();
    unmount();
    render(<SideNav flags={allOff} permisos={[...permisosDeRol("creator", "manager")]} />);
    expect(screen.getByRole("link", { name: "Accesos" })).toHaveAttribute("href", "/accesos");
  });

  it("una bandera apagada gana aunque el permiso esté", () => {
    render(<SideNav flags={allOff} permisos={todo} />);
    expect(screen.queryByRole("link", { name: /Tendencias del nicho/ })).not.toBeInTheDocument();
  });
});

describe("MobileNav", () => {
  it("con Contador: Plan, Finanzas y las herramientas sin Accesos", () => {
    render(<MobileNav flags={allOff} permisos={contador} />);
    const hrefs = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/", "/finanzas", "/cimientos", "/reglas"]);
  });

  it("respeta las banderas igual que el lateral", () => {
    render(<MobileNav flags={{ ...allOff, agency_workspace: true }} permisos={todo} />);
    expect(screen.getByRole("link", { name: "Vista agencia" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Mis videos" })).not.toBeInTheDocument();
  });
});
