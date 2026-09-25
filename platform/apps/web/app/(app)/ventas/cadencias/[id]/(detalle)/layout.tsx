import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cache } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { sequenceNameOf } from "@mc/db/queries/cadencias";
import { withWorkspace } from "../../../_lib/db";
import { MESSAGES } from "../../messages";

export const dynamic = "force-dynamic";

/** El nombre de la cadencia si es de este espacio, o null. `cache` lo comparte con generateMetadata. */
const cadenciaDelEspacio = cache((id: string) => withWorkspace((tx) => sequenceNameOf(tx, id)));

/** La pestaña dice qué cadencia es; si no existe, el título genérico (el 404 lo decide el layout). */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const nombre = await cadenciaDelEspacio(id);
  return { title: nombre ? MESSAGES.detalle.metaTitle(nombre) : MESSAGES.metaTitle };
}

/**
 * ¿Es esta cadencia de este espacio? Una sola fila y, si no, notFound()
 * antes de que salga nada (lo recoge ../not-found.tsx). En el layout y no
 * en la página por lo mismo que la ficha de empresa: el loading.tsx de
 * este grupo envuelve a la página pero no al layout, así que el 404 es de
 * verdad y al navegar se ve el esqueleto (app/(app)/no-existe.test.tsx).
 */
export default async function CadenciaDelEspacio({ children, params }: { children: ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if ((await cadenciaDelEspacio(id)) === null) notFound();
  return (
    <>
      <nav aria-label={MESSAGES.header.title} className="mb-2 text-xs text-muted">
        <Link href="/ventas/cadencias" className="hover:text-ink hover:underline">
          ← {MESSAGES.detalle.volver}
        </Link>
      </nav>
      {children}
    </>
  );
}
