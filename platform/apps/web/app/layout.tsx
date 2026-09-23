import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { ThemeSync } from "@/components/theme-sync";
import { themeScript } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "On Cue", template: "%s · On Cue" },
  description: "Plataforma para que creadores y agencias midan, creen, vendan y cobren.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

/**
 * Solo el documento: tema, tipografía y fondo.
 *
 * El marco con la navegación (Shell, CIM-4) se monta un nivel más
 * abajo, en app/(app)/layout.tsx. Lo bajaron a la vez CIM-3 (/login y
 * el callback del enlace mágico) y COT-2 (las páginas públicas —el
 * media kit y la cotización que abre la marca, sin sesión— que cuelgan
 * de app/(public)/): ninguna puede llevar la barra lateral del creador.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es" suppressHydrationWarning className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-dvh bg-bg font-sans text-fg antialiased">
        {/* Respaldo del script: el 404 de notFound() monta un <html> sin data-theme. */}
        <ThemeSync />
        {children}
      </body>
    </html>
  );
}
