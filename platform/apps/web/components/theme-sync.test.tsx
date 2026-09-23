import { render, screen } from "@testing-library/react";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { THEME_KEY } from "@/lib/theme";
import PublicoNotFound from "@/app/(public)/not-found";
import RootLayout from "@/app/layout";
import { ThemeSync } from "./theme-sync";

vi.mock("geist/font/sans", () => ({ GeistSans: { variable: "font-sans-var" } }));
vi.mock("geist/font/mono", () => ({ GeistMono: { variable: "font-mono-var" } }));

/**
 * El 404 de un enlace público (/kit/<slug>, /cotizacion/<slug>) o de una
 * ficha que no existe, con el tema oscuro (pulido r8). Next monta un
 * <html> nuevo en el cliente, sin el data-theme que puso el script del
 * <head>: el 404 salía en claro. Aquí se simula ese <html> desnudo.
 */
function sistema(prefersDark: boolean, stored: string | null) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: prefersDark })));
  vi.stubGlobal("localStorage", { getItem: vi.fn((k: string) => (k === THEME_KEY ? stored : null)) });
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
});

describe("ThemeSync (pulido r8)", () => {
  it("el 404 público con el tema oscuro elegido queda oscuro aunque el sistema sea claro", () => {
    sistema(false, "dark");
    delete document.documentElement.dataset.theme;
    render(
      <>
        <ThemeSync />
        <PublicoNotFound />
      </>,
    );
    expect(screen.getByText("Este enlace no existe")).toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("sin elección guardada sigue al sistema", () => {
    sistema(true, null);
    render(<ThemeSync />);
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("si el script ya puso el tema, no lo toca", () => {
    sistema(true, "dark");
    document.documentElement.dataset.theme = "light";
    render(<ThemeSync />);
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("el layout raíz lo monta, así que llega también al 404", () => {
    const html = RootLayout({ children: <p>404</p> }) as ReactElement<{ children: ReactNode }>;
    const tipos: unknown[] = [];
    const recorrer = (n: ReactNode) => {
      if (Array.isArray(n)) return n.forEach(recorrer);
      if (!isValidElement<{ children?: ReactNode }>(n)) return;
      tipos.push(n.type);
      recorrer(n.props.children);
    };
    recorrer(html);
    expect(tipos).toContain(ThemeSync);
  });
});
