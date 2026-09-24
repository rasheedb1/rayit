import { describe, expect, it } from "vitest";
import type { ChannelAccountRow } from "@mc/db/queries/canales";
import { MESSAGES } from "../messages";
import { channelSetup } from "./config";
import { channelRows, reasonText } from "./filas";

const ALL = {
  TOKEN_ENCRYPTION_KEY: "k", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s",
  UNIPILE_DSN: "d", UNIPILE_ACCESS_TOKEN: "t", UNIPILE_WEBHOOK_SECRET: "w",
};

function account(over: Partial<ChannelAccountRow>): ChannelAccountRow {
  return {
    id: "00000000-0000-4000-8000-000000000001", channel: "email", provider: "gmail_oauth", providerAccountId: "a@b.test", displayName: "a@b.test",
    status: "connected", stale: false, dailyCap: null, weeklyCap: null, scopes: [], lastOkAt: null, lastErrorAt: null, lastError: null,
    updatedAt: new Date(0), usedToday: 0, usedThisWeek: 0, ...over,
  };
}

describe("channelSetup", () => {
  it("sin nada dice qué falta por canal; con todo, los tres se pueden conectar", () => {
    const none = channelSetup({});
    expect(none.email.missing).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]);
    expect(none.linkedin.missing).toEqual(["UNIPILE_DSN", "UNIPILE_ACCESS_TOKEN", "UNIPILE_WEBHOOK_SECRET", "TOKEN_ENCRYPTION_KEY"]);
    const all = channelSetup(ALL);
    expect([all.email.configured, all.linkedin.configured, all.instagram_dm.configured]).toEqual([true, true, true]);
  });
});

describe("channelRows", () => {
  it("una fila por canal, siempre en el mismo orden", () => {
    expect(channelRows([], channelSetup(ALL)).map((r) => [r.channel, r.state, r.action])).toEqual([
      ["email", "disconnected", "connect"], ["linkedin", "disconnected", "connect"], ["instagram_dm", "disconnected", "connect"],
    ]);
  });

  it("sin llaves: no configurado y sin botón; una cuenta viva se sigue enseñando", () => {
    const rows = channelRows([account({ status: "connected" })], channelSetup({}));
    expect(rows.map((r) => [r.state, r.action])).toEqual([["connected", null], ["not_configured", null], ["not_configured", null]]);
    expect(rows[1]!.missing).toContain("UNIPILE_DSN");
  });

  it("la viva gana a la pendiente y a la desconectada; por reconectar lleva «Reconectar»", () => {
    const rows = channelRows([
      account({ id: "1", channel: "linkedin", provider: "unipile", status: "needs_reconnect", lastError: "La sesión expiró." }),
      account({ id: "2", channel: "linkedin", provider: "unipile", status: "disconnected" }),
    ], channelSetup(ALL));
    expect(rows[1]).toMatchObject({ state: "needs_reconnect", action: "reconnect", reason: "La sesión expiró." });
    expect(rows[1]!.account?.id).toBe("1");
  });

  it("pendiente reciente: conectando; vieja: vencido; desconectada por otro espacio dice por qué", () => {
    const pend = channelRows([account({ channel: "instagram_dm", provider: "unipile", status: "pending", providerAccountId: null })], channelSetup(ALL));
    expect(pend[2]).toMatchObject({ state: "pending", action: "retry" });
    const old = channelRows([account({ channel: "instagram_dm", provider: "unipile", status: "pending", stale: true })], channelSetup(ALL));
    expect(old[2]).toMatchObject({ state: "expired", action: "retry" });
    const taken = channelRows([account({ status: "disconnected", lastError: "taken" })], channelSetup(ALL));
    expect(taken[0]).toMatchObject({ state: "disconnected", action: "connect", reason: MESSAGES.banners.errors.ocupada });
  });

  it("reasonText traduce los códigos y deja pasar las frases", () => {
    expect(reasonText("missing_scopes")).toBe(MESSAGES.banners.errors.permisos);
    expect(reasonText("wrong_provider")).toBe(MESSAGES.banners.errors.canal_equivocado);
    expect(reasonText("Unipile dijo algo.")).toBe("Unipile dijo algo.");
    expect(reasonText(null)).toBeNull();
  });
});
