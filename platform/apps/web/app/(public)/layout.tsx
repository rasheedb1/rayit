import type { Metadata } from "next";
import type { ReactNode } from "react";

/**
 * El marco de las páginas que abre la marca: media kit y cotización.
 *
 * Sin barra lateral y sin navegación — quien llega aquí no tiene sesión
 * ni es nadie dentro del producto: recibió un enlace. Una columna
 * estrecha, como un documento, que es lo que es (referencias: los media
 * kits de Beacons y Passionfroot, y la factura alojada de Stripe).
 */
export const metadata: Metadata = {
  // Un enlace privado no se indexa aunque alguien lo pegue en una web.
  robots: { index: false, follow: false },
};

export default function PublicLayout({ children }: { children: ReactNode }) {
  return <main className="mx-auto w-full max-w-2xl px-4 py-10 md:py-16">{children}</main>;
}
