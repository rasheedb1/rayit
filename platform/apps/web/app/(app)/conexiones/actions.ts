"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { ConnectionNotFound, disconnectConnection } from "@mc/db";
import { withWorkspace } from "./_lib/db";

const idSchema = z.string().uuid();

/**
 * «Desconectar»: deleted_at, status 'disabled', consentimientos revocados y
 * el ciphertext fuera. Sin borrar la fila. Se usa con bind:
 * <form action={desconectarConexion.bind(null, id)}>.
 */
export async function desconectarConexion(id: string): Promise<void> {
  const parsed = idSchema.safeParse(id);
  if (!parsed.success) redirect("/conexiones");
  let error: string | null = null;
  try {
    await withWorkspace((tx) => disconnectConnection(tx, parsed.data));
  } catch (err) {
    error = err instanceof ConnectionNotFound ? "Esa conexión ya no está activa." : "No se pudo desconectar la cuenta. Inténtalo de nuevo.";
  }
  revalidatePath("/conexiones");
  redirect(error ? `/conexiones?aviso=${encodeURIComponent(error)}` : "/conexiones?desconectada=1");
}
