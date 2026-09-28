import { createTickHandler, TICK_BUDGET_MS, TICK_CLOSE_MS } from "./_lib/turno";

/**
 * El turno del worker (CIM-7): corre lo vencido de job_definition y sale.
 * Lo llama cada minuto el cron de Supabase (POST, opción B) o Vercel
 * Cron (GET, opción A); solo con `Authorization: Bearer <CRON_SECRET>`.
 * Se conecta como el worker: WORKER_DATABASE_URL (o DATABASE_URL_DIRECT),
 * modo sesión, SET ROLE mc_worker. Todo en apps/worker/README.md, «Por turnos».
 *
 * El worker (@mc/worker/tick: los handlers, los conectores, el SDK de
 * Anthropic; ~0,6 MB) se carga DESPUÉS de comprobar el Bearer, con un
 * import dinámico: la URL es pública y un 401 no paga su arranque en
 * frío (Hobby cobra la CPU activa). Este archivo no importa del worker
 * nada que no sea un tipo; apps/web/scripts/revisar-bundle-turno.mjs
 * falla el build si el worker vuelve a los chunks que se cargan siempre.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// El turno usa 45 s (TICK_BUDGET_MS) y 3 s para cerrar el pool; si a los
// 48 s no respondió, la ruta contesta 504 y lo deja en el log: con 60 s
// de maxDuration todavía hay margen para que esa línea llegue.
export const maxDuration = 60;

const handler = createTickHandler({
  secret: () => process.env.CRON_SECRET,
  run: async (budgetMs) => (await import("@mc/worker/tick")).runTickFromEnv({ budgetMs }),
  waitMs: TICK_BUDGET_MS + TICK_CLOSE_MS,
});

export const GET = handler;
export const POST = handler;
