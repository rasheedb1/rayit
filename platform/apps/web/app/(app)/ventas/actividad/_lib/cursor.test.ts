// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listOutboundQueue, type QueueBucket } from "@mc/db/queries/actividad";
import { openTestDb, type TestDb } from "@mc/db/test/pglite";
import { filtrosDe, hrefDe } from "./vista";

/**
 * El cursor de la URL, de punta a punta y sin red: el token que genera
 * listOutboundQueue (@mc/db) entra por filtrosDe (la URL de la pantalla)
 * y vuelve a la base como la página siguiente. Si @mc/db cambia el
 * formato del token (otra precisión, otro separador), esta prueba falla
 * en vez de que la paginación vuelva en silencio a la primera página.
 */
const id = (n: string) => `00000016-0000-4000-8000-${n.padStart(12, "0")}`;
const WS = id("a");
const CO = id("c0");

let t: TestDb;
beforeAll(async () => {
  t = await openTestDb({ seeds: false });
  // Tres enviados (el historial), dos fallidos, un programado y un borrador sin hora («infinity» en el cursor de la cola).
  await t.admin(`
    INSERT INTO workspace (id, slug, name, timezone) VALUES ('${WS}', 'cursor-web', 'Cursor web', 'America/Bogota');
    INSERT INTO company (id, name, owner_workspace_id) VALUES ('${CO}', 'Marca', '${WS}');
    INSERT INTO company_link (workspace_id, company_id) VALUES ('${WS}', '${CO}');
    INSERT INTO outbound_touch (id, workspace_id, company_id, channel, subject, body, status, sent_at, recipient_address,
                                provider_message_id, blocked_reason, scheduled_for, status_changed_at)
    VALUES ('${id("71")}', '${WS}', '${CO}', 'email', 'Uno', 'Hola.', 'sent', now() - interval '3 hours', 'a@marca.test', 'p-1', NULL,
            NULL, now() - interval '3 hours'),
           ('${id("72")}', '${WS}', '${CO}', 'email', 'Dos', 'Hola.', 'sent', now() - interval '2 hours', 'b@marca.test', 'p-2', NULL,
            NULL, now() - interval '2 hours'),
           ('${id("73")}', '${WS}', '${CO}', 'email', 'Tres', 'Hola.', 'sent', now() - interval '1 hour', 'c@marca.test', 'p-3', NULL,
            NULL, now() - interval '1 hour'),
           ('${id("74")}', '${WS}', '${CO}', 'email', 'Cuatro', 'Hola.', 'failed', NULL, NULL, NULL, 'rejected',
            now() - interval '1 day', now() - interval '1 hour'),
           ('${id("75")}', '${WS}', '${CO}', 'email', 'Cinco', 'Hola.', 'failed', NULL, NULL, NULL, 'rejected',
            now() - interval '1 day', now() - interval '2 hours'),
           ('${id("76")}', '${WS}', '${CO}', 'email', 'Seis', 'Hola.', 'scheduled', NULL, NULL, NULL, NULL,
            now() + interval '1 day', now()),
           ('${id("77")}', '${WS}', '${CO}', 'email', 'Siete', 'Hola.', 'draft', NULL, NULL, NULL, NULL, NULL, now());
  `);
}, 180_000);
afterAll(async () => {
  await t?.close();
});

describe("el cursor de @mc/db pasa por la URL de la pantalla", () => {
  it.each([["queue"], ["history"]] as [QueueBucket][])("%s: cada página siguiente se pide con el token que dejó la anterior", async (bucket) => {
    const vista = bucket === "history" ? "historial" : undefined;
    const todo = (await t.db.withWorkspace(WS, (tx) => listOutboundQueue(tx, { bucket }))).rows.map((r) => r.touchId);
    const vistos: string[] = [];
    let url: Record<string, string | undefined> = { vista };
    for (let i = 0; i < 10; i++) {
      const filtros = filtrosDe(url);
      const pagina = await t.db.withWorkspace(WS, (tx) => listOutboundQueue(tx, { bucket, limit: 2, cursor: filtros.pagina }));
      vistos.push(...pagina.rows.map((r) => r.touchId));
      if (!pagina.next) break;
      // La URL que pinta el enlace «Siguientes»: el token entra por filtrosDe tal cual lo generó la base.
      const href = hrefDe({ ...filtros, pagina: { direction: "next", token: pagina.next } });
      url = Object.fromEntries(new URL(href, "http://x").searchParams);
      expect(filtrosDe(url).pagina, pagina.next).toEqual({ direction: "next", token: pagina.next });
    }
    expect(vistos).toEqual(todo);
    expect(vistos.length).toBeGreaterThan(2);
  });

  it("el cursor de un borrador sin hora («infinity») también se acepta", async () => {
    const p = await t.db.withWorkspace(WS, (tx) => listOutboundQueue(tx, { bucket: "queue", limit: 3 }));
    expect(p.next).toMatch(/infinity|\d{6}Z/);
    const ultima = await t.db.withWorkspace(WS, (tx) =>
      listOutboundQueue(tx, { bucket: "queue", limit: 3, cursor: { direction: "next", token: p.next! } }));
    expect(ultima.rows.map((r) => r.status)).toEqual(["draft"]);
    expect(ultima.prev).toMatch(/_infinity_/);
    expect(filtrosDe({ anterior: ultima.prev! }).pagina).toEqual({ direction: "prev", token: ultima.prev });
  });
});
