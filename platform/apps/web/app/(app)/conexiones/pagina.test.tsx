// @vitest-environment node
/**
 * CON-4 · el «terminado cuando», sobre la página de verdad y Postgres
 * embebido con el seed, más el escenario del `--demo` del worker
 * (apps/worker/src/demo.ts: tres conexiones de TikTok del mismo creador
 * en distinto estado de token).
 *
 *  1. Una conexión con el token VENCIDO se ve en rojo y con el botón de
 *     reautorizar, aunque `status` siga en 'active' porque
 *     `oauth.refresh` todavía no ha corrido.
 *  2. Una cuenta por @ y una autorizada de la MISMA red se distinguen
 *     leyendo la fila, no por el color.
 *  3. Ni una ref de secreto ni un token asoman en el HTML.
 *  4. Con la bandera apagada no hay ni «Conectar» ni «Reautorizar», y el
 *     estado sigue siendo honesto.
 *
 * Node y `renderToString` (no jsdom): es un Server Component asíncrono
 * que abre transacciones, como el precedente de la cotización pública.
 */
import { renderToString } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

/** Valores de mentira: aquí solo importa que `loadOAuthApps` vea la app configurada. */
const ENV_OAUTH = {
  OAUTH_CONNECT: "1",
  APP_URL: "http://localhost:3123",
  TIKTOK_LOGIN_CLIENT_KEY: "clave-de-prueba-tiktok",
  TIKTOK_LOGIN_CLIENT_SECRET: "secreto-de-prueba-tiktok",
  META_APP_ID: "id-de-prueba-meta",
  META_APP_SECRET: "secreto-de-prueba-meta",
} as const;

/** El creador del seed 0002 (Laura · Cocina fácil), dueño de las conexiones sembradas. */
const CREADOR = "00000002-0000-4000-8000-000000000003";

const REF_SECRETA = "enc:tiktok:00000000-dead-4000-8000-000000000001";

const entorno = { ...process.env };

/**
 * Pinta la página con el entorno que hay ahora. `content/flags.ts` lee
 * `OAUTH_CONNECT` al importarse, así que cada variante del entorno pide
 * volver a montar el árbol de módulos; el Postgres embebido vive en
 * `globalThis` (lib/db/cliente.ts) y sobrevive al reset.
 */
async function pintar(): Promise<string> {
  const { default: CuentasPage } = await import("./page");
  return renderToString(await CuentasPage({ searchParams: Promise.resolve({}) }));
}

/**
 * El escenario del `--demo` del worker, con los añadidos que CON-4 tiene
 * que enseñar: un token que YA venció sin que nadie lo haya anotado y
 * cuya renovación también venció (cafealma.tienda: hay que reautorizar),
 * y otro vencido con la renovación viva (cafealma.pausa: se renueva sola
 * cuando corra el worker, costura CON-3 → CON-4).
 * Se escribe como `mc_app`, con RLS puesta: el workspace lo fija la
 * transacción, nunca la consulta.
 */
async function sembrarEscenario(withWorkspace: <T>(fn: (tx: { query: (q: string, p?: unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>) => Promise<T>) {
  await withWorkspace(async (tx) => {
    await tx.query(
      `INSERT INTO social_connection
         (workspace_id, creator_id, platform_id, external_account_id, handle, display_name,
          account_type, secret_ref, scopes, access_expires_at, refresh_expires_at, access_mode, status, last_synced_at, connected_at)
       VALUES
         (current_workspace_id(), $1, 'tiktok', 'tt-demo-1', 'cafealma', 'Café Alma',
          'creator', $2, '{user.info.basic,video.list}', now() + interval '10 minutes', now() + interval '300 days',
          'direct_oauth', 'active', now() - interval '3 hours', now() - interval '40 days'),
         (current_workspace_id(), $1, 'tiktok', 'tt-demo-3', 'cafealma.tienda', 'Café Alma · Tienda',
          'creator', $3, '{user.info.basic,video.list}', now() - interval '2 hours', now() - interval '1 day',
          'direct_oauth', 'active', now() - interval '30 hours', now() - interval '400 days'),
         (current_workspace_id(), $1, 'tiktok', 'tt-demo-5', 'cafealma.pausa', 'Café Alma · Pausa',
          'creator', 'enc:tiktok:renovable', '{user.info.basic,video.list}', now() - interval '2 hours', now() + interval '300 days',
          'direct_oauth', 'active', now() - interval '26 hours', now() - interval '40 days'),
         (current_workspace_id(), $1, 'tiktok', 'tt-demo-4', 'cafealma.reposteria', 'Café Alma · Repostería',
          'creator', 'enc:tiktok:revocada', '{user.info.basic}', now() + interval '20 hours', now() + interval '300 days',
          'direct_oauth', 'needs_reauth', NULL, now() - interval '40 days'),
         (current_workspace_id(), $1, 'tiktok', 'cafealma.recetas', 'cafealma.recetas', 'Café Alma · Recetas',
          'creator', 'public:tiktok:cafealma.recetas', '{}', NULL, NULL,
          'public_profile', 'active', now() - interval '1 hour', now() - interval '3 days')
       ON CONFLICT (platform_id, external_account_id, workspace_id) DO NOTHING`,
      [CREADOR, REF_SECRETA, "enc:tiktok:vencida"],
    );
  });
}

let html = "";
let htmlSinBandera = "";

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  Object.assign(process.env, ENV_OAUTH);
  const { withWorkspace, closeDb, getDbMode } = await import("@/lib/db");
  expect(await getDbMode()).toBe("embedded");
  await sembrarEscenario(withWorkspace as never);

  html = await pintar();

  // La misma pantalla con la bandera apagada: es lo que hay hoy en
  // producción, y tiene que seguir diciendo la verdad sobre el token.
  vi.resetModules();
  process.env.OAUTH_CONNECT = "0";
  htmlSinBandera = await pintar();
  void closeDb;
}, 600_000);

afterAll(async () => {
  const { closeDb } = await import("@/lib/db");
  await closeDb().catch(() => undefined);
  for (const k of Object.keys(ENV_OAUTH)) delete process.env[k];
  Object.assign(process.env, entorno);
}, 60_000);

describe("CON-4 · la pantalla Cuentas con la bandera oauth_connect encendida", () => {
  test("una conexión con el token vencido se ve «Vencida» y con «Reautorizar», aunque status siga en 'active'", () => {
    expect(html).toContain("Vencida");
    expect(html).toContain("Reautorizar @cafealma.tienda");
  });

  test("un acceso vencido con la renovación viva «se renueva sola», dice de quién depende y no pide reautorizar", () => {
    expect(html).toContain("Se renueva sola");
    expect(html).toContain("cuando corra el worker");
    expect(html).not.toContain("Reautorizar @cafealma.pausa");
    expect(html).not.toContain("Actualizar @cafealma.pausa");
  });

  test("una cuenta revocada por la plataforma pide reautorizar con su propio texto", () => {
    expect(html).toContain("Necesita reautorizar");
    expect(html).toContain("Reautorizar @cafealma.reposteria");
  });

  test("una cuenta por @ y una autorizada de la misma red se distinguen leyendo", () => {
    expect(html).toContain("Por @");
    expect(html).toContain("Autorizada");
    expect(html).toContain("Cifras públicas, leídas por su @.");
    expect(html).toContain("Cifras leídas con el permiso de su dueño.");
  });

  test("la cuenta por @ no ofrece reautorizar: no tiene permiso que caduque", () => {
    expect(html).not.toContain("Reautorizar @cafealma.recetas");
  });

  test("las horas desde la última lectura se leen en palabras, y la ausencia con una frase", () => {
    expect(html).toContain("hace 3 horas");
    expect(html).toContain("hace un día");
    expect(html).toContain("Sin leer todavía");
  });

  test("«Conectar» aparece con el diálogo de consentimiento, y solo para TikTok", () => {
    expect(html).toContain("Conectar una cuenta autorizada");
    expect(html).toContain("Conectar TikTok");
    expect(html).toContain("/conexiones/oauth/tiktok/start");
    // Instagram está configurada en este entorno y aun así no se ofrece
    // como cuenta nueva: por @ ya entrega seguidores y publicaciones
    // (decisión 6 de CON-4.md). Reparar una autorización de Instagram
    // que ya existe sí sigue siendo posible; eso es otra cosa.
    expect(html).not.toContain("Conectar Instagram");
  });

  test("el paso manual sale del catálogo de la base, no de una constante de la pantalla", () => {
    expect(html).toContain("Activa Analytics en la app de TikTok");
    expect(html).toContain("Un paso que solo puedes dar tú");
  });

  test("ni una ref de secreto ni una credencial del entorno asoman en el HTML", () => {
    expect(html).not.toContain(REF_SECRETA);
    expect(html).not.toContain("enc:tiktok:");
    expect(html).not.toContain("public:tiktok:");
    for (const valor of Object.values(ENV_OAUTH)) {
      if (valor === "1") continue;
      expect(html).not.toContain(valor);
    }
  });

  test("ni un guion mudo ni un cero donde falta el dato", () => {
    expect(html).toContain("Sin dato");
  });
});

describe("CON-4 · con la bandera apagada", () => {
  test("no hay ni «Conectar» ni «Reautorizar», pero el estado sigue siendo honesto", () => {
    expect(htmlSinBandera).toContain("Vencida");
    expect(htmlSinBandera).not.toContain("Conectar una cuenta autorizada");
    expect(htmlSinBandera).not.toContain("Reautorizar @cafealma.tienda");
  });
});
