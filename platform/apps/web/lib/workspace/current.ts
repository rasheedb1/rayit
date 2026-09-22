/**
 * El workspace actual: la costura para que las pantallas avancen sin
 * autenticación.
 *
 * Sale de DEMO_WORKSPACE_ID (ver platform/.env.example). CIM-3 reemplaza
 * este cuerpo por el workspace de la sesión sin tocar a quien lo llama.
 *
 * En producción la variable es OBLIGATORIA. Antes se caía al workspace
 * del seed con un aviso en el log, y eso contradecía el principio que
 * from-env.ts aplica dos archivos más allá ("en producción no hay modo
 * demo", y ahí sí lanza): un despliegue sin la variable servía un
 * workspace fijo y codificado leyendo la Supabase real, y ese es
 * justamente el valor por defecto que sobrevive al lanzamiento. Si hace
 * falta el del seed en producción a propósito (una demo pública), se
 * dice en voz alta con ALLOW_SEED_WORKSPACE=1.
 *
 * Es el ÚNICO lugar de la web que conoce el workspace. Las consultas lo
 * reciben dentro de la transacción (withWorkspace), nunca como
 * parámetro suelto ni desde un componente.
 */

import { isUuid } from "@mc/db";

/** Workspace de la creadora ficticia del seed (db/seed/0003, docs/propuestas/CIM-8.md). */
export const SEED_WORKSPACE_ID = "00000002-0000-4000-8000-000000000001";

export type Env = Readonly<Record<string, string | undefined>>;

/** Se avisa una vez por proceso, no en cada petición. */
let warned = false;

export function getCurrentWorkspaceId(env: Env = process.env, warn: (message: string) => void = console.warn): string {
  const id = env.DEMO_WORKSPACE_ID?.trim();
  if (id) {
    if (!isUuid(id)) {
      throw new Error(`DEMO_WORKSPACE_ID no es un UUID: "${id}". Debe ser el id de una fila de workspace.`);
    }
    return id;
  }
  if (env.NODE_ENV === "production") {
    if (env.ALLOW_SEED_WORKSPACE !== "1") {
      throw new Error(
        "Falta DEMO_WORKSPACE_ID. En producción el workspace no se adivina: hasta CIM-3 hay que decir cuál se " +
          'sirve. Fíjalo con: make vercel.run ARGS="env add DEMO_WORKSPACE_ID production" (y otra vez con ' +
          "preview). Para servir a propósito el workspace del seed, ALLOW_SEED_WORKSPACE=1.",
      );
    }
    if (!warned) {
      warned = true;
      warn("[workspace] ALLOW_SEED_WORKSPACE=1: producción sirve el workspace del seed hasta CIM-3");
    }
  }
  return SEED_WORKSPACE_ID;
}
