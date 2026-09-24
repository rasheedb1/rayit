import { describe, expect, it } from "vitest";
import { GOOGLE_STATE_TTL_MS, UNIPILE_STATE_TTL_MS } from "@mc/connectors";
import { PENDING_STALE_MINUTES, type ChannelAccountRow } from "@mc/db/queries/canales";
import { MESSAGES } from "../messages";
import { channelBanner } from "./banner";
import { channelSetup } from "./config";
import { channelRows, pillFor, reasonText } from "./filas";

const ALL = {
  TOKEN_ENCRYPTION_KEY: "k", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s",
  UNIPILE_DSN: "d", UNIPILE_ACCESS_TOKEN: "t", UNIPILE_WEBHOOK_SECRET: "w",
};
const SIN_UNIPILE = { TOKEN_ENCRYPTION_KEY: "k", GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s" };

function account(over: Partial<ChannelAccountRow>): ChannelAccountRow {
  return {
    id: "00000000-0000-4000-8000-000000000001", channel: "email", provider: "gmail_oauth", providerAccountId: "a@b.test", displayName: "a@b.test",
    status: "connected", stale: false, dailyCap: null, weeklyCap: null, scopes: [], lastOkAt: null, lastErrorAt: null, lastError: null,
    updatedAt: new Date(0), usedToday: 0, usedThisWeek: 0,
    limits: { effectiveDaily: 20, effectiveWeekly: 140, maxDaily: 20, maxWeekly: 140, dailyLimitedBy: "policy", personalMailbox: false },
    ...over,
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
    expect(channelRows([], channelSetup(ALL)).map((r) => [r.channel, r.state, r.action, r.unavailable])).toEqual([
      ["email", "disconnected", "connect", false], ["linkedin", "disconnected", "connect", false], ["instagram_dm", "disconnected", "connect", false],
    ]);
  });

  it("sin llaves y sin cuenta: «No disponible», con el botón deshabilitado", () => {
    const rows = channelRows([], channelSetup({}));
    expect(rows.map((r) => [r.state, r.action, r.unavailable])).toEqual([
      ["not_configured", "connect", true], ["not_configured", "connect", true], ["not_configured", "connect", true],
    ]);
    expect(pillFor(rows[1]!).label).toBe(MESSAGES.status.notConfigured);
  });

  it("sin llaves, un Gmail conectado no sale en verde: «En pausa» y dice por qué", () => {
    const rows = channelRows([account({ status: "connected" })], channelSetup({}));
    expect(rows[0]).toMatchObject({ state: "connected", unavailable: true, action: null });
    expect(pillFor(rows[0]!)).toEqual({ kind: "warn", label: MESSAGES.status.paused });
    expect(rows[0]!.missing).toContain("GOOGLE_CLIENT_ID");
    // Con llaves, verde.
    expect(pillFor(channelRows([account({ status: "connected" })], channelSetup(ALL))[0]!)).toEqual({ kind: "good", label: MESSAGES.status.connected });
  });

  it("sin llaves, un LinkedIn por reconectar conserva «Reconectar» (deshabilitado) y el motivo: nunca rojo sin explicación", () => {
    const li = account({ id: "1", channel: "linkedin", provider: "unipile", status: "needs_reconnect", lastError: "LinkedIn cerró la sesión." });
    const rows = channelRows([li], channelSetup(SIN_UNIPILE));
    expect(rows[1]).toMatchObject({ state: "needs_reconnect", action: "reconnect", unavailable: true, reason: "LinkedIn cerró la sesión." });
    expect(rows[1]!.missing).toEqual(["UNIPILE_DSN", "UNIPILE_ACCESS_TOKEN", "UNIPILE_WEBHOOK_SECRET"]);
    // El correo, con sus llaves, no queda afectado.
    expect(rows[0]!.unavailable).toBe(false);
  });

  it("la viva gana a la pendiente y a la desconectada; por reconectar lleva «Reconectar»", () => {
    const rows = channelRows([
      account({ id: "1", channel: "linkedin", provider: "unipile", status: "needs_reconnect", lastError: "La sesión expiró." }),
      account({ id: "2", channel: "linkedin", provider: "unipile", status: "disconnected" }),
    ], channelSetup(ALL));
    expect(rows[1]).toMatchObject({ state: "needs_reconnect", action: "reconnect", unavailable: false, reason: "La sesión expiró." });
    expect(rows[1]!.account?.id).toBe("1");
  });

  it("pendiente reciente: conectando; vieja: sin terminar; desconectada por otro espacio o cancelada dice por qué", () => {
    const pend = channelRows([account({ channel: "instagram_dm", provider: "unipile", status: "pending", providerAccountId: null })], channelSetup(ALL));
    expect(pend[2]).toMatchObject({ state: "pending", action: "retry" });
    const old = channelRows([account({ channel: "instagram_dm", provider: "unipile", status: "pending", stale: true })], channelSetup(ALL));
    expect(old[2]).toMatchObject({ state: "expired", action: "retry" });
    const taken = channelRows([account({ status: "disconnected", lastError: "taken" })], channelSetup(ALL));
    expect(taken[0]).toMatchObject({ state: "disconnected", action: "connect", reason: MESSAGES.banners.errors.ocupada });
    const cancelled = channelRows([account({ status: "disconnected", lastError: "cancelled" })], channelSetup(ALL));
    expect(cancelled[0]!.reason).toBe(MESSAGES.banners.errors.cancelada);
  });

  it("dos cuentas vivas del mismo canal: la primera encabeza y la segunda sale en su sub-fila, con su estado y su botón", () => {
    const rows = channelRows([
      account({ id: "a", displayName: "alianzas@laura.test", status: "connected" }),
      account({ id: "b", displayName: "laura@gmail.test", status: "needs_reconnect", lastError: "Google ya no acepta el permiso." }),
      account({ id: "c", status: "disconnected" }),
    ], channelSetup(ALL));
    expect(rows[0]).toMatchObject({ state: "connected", action: null });
    expect(rows[0]!.account?.id).toBe("a");
    expect(rows[0]!.others.map((o) => [o.account?.id, o.state, o.action, o.reason])).toEqual([
      ["b", "needs_reconnect", "reconnect", "Google ya no acepta el permiso."],
    ]);
    expect(rows[0]!.others[0]!.others, "una sub-fila no anida más").toEqual([]);
    // Los demás canales no heredan nada.
    expect(rows[1]!.others).toEqual([]);
  });

  it("una cuenta conectada sin avisos de Unipile ofrece «Volver a intentar» (rewebhook) con su motivo", () => {
    const li = account({ id: "1", channel: "linkedin", provider: "unipile", status: "connected", lastError: "webhooks_missing" });
    const [, row] = channelRows([li], channelSetup(ALL));
    expect(row).toMatchObject({ state: "connected", action: "rewebhook", reason: MESSAGES.detail.webhooksMissing });
    // Un motivo cualquiera en una conectada (un fallo pasajero del keepalive) no pide botón.
    const [, otra] = channelRows([{ ...li, lastError: "No pudimos comprobar la cuenta hoy." }], channelSetup(ALL));
    expect(otra!.action).toBeNull();
  });

  it("reasonText traduce los códigos y deja pasar las frases", () => {
    expect(reasonText("releasing")).toBe(MESSAGES.detail.releasing);
    expect(reasonText("webhooks_missing")).toBe(MESSAGES.detail.webhooksMissing);
    expect(reasonText("missing_scopes")).toBe(MESSAGES.banners.errors.permisos);
    expect(reasonText("wrong_provider")).toBe(MESSAGES.banners.errors.canal_equivocado);
    expect(reasonText("Unipile dijo algo.")).toBe("Unipile dijo algo.");
    expect(reasonText(null)).toBeNull();
  });

  it("una pendiente vence cuando vence su estado firmado: diez minutos en Google, un día en Unipile", () => {
    expect(PENDING_STALE_MINUTES.email * 60_000).toBe(GOOGLE_STATE_TTL_MS);
    expect(PENDING_STALE_MINUTES.linkedin * 60_000).toBe(UNIPILE_STATE_TTL_MS);
    expect(PENDING_STALE_MINUTES.instagram_dm * 60_000).toBe(UNIPILE_STATE_TTL_MS);
  });
});

describe("channelBanner: el aviso sale del estado real de la fila, no solo de la URL", () => {
  const li = (status: ChannelAccountRow["status"]) => channelRows([account({ channel: "linkedin", provider: "unipile", status })], channelSetup(ALL));

  it("conectada: «quedó conectado», sin refrescar", () => {
    expect(channelBanner({ conectado: "linkedin" }, li("connected"))).toEqual({ message: null, notice: MESSAGES.banners.connected("LinkedIn"), refresh: false });
  });

  it("todavía conectándose (el aviso de Unipile no llegó): «Estamos terminando…» y refresca", () => {
    expect(channelBanner({ conectado: "linkedin" }, li("pending"))).toEqual({ message: null, notice: MESSAGES.banners.finishing("LinkedIn"), refresh: true });
  });

  it("por reconectar, desconectada o sin fila: nada (la fila ya lo dice) — nunca verde encima de rojo", () => {
    expect(channelBanner({ conectado: "linkedin" }, li("needs_reconnect"))).toEqual({ message: null, notice: null, refresh: false });
    expect(channelBanner({ conectado: "linkedin" }, li("disconnected")).notice).toBeNull();
    expect(channelBanner({ conectado: "linkedin" }, []).notice).toBeNull();
  });

  it("un error conocido es el error; uno inventado o un canal inventado, nada", () => {
    expect(channelBanner({ error: "cancelada" }, [])).toEqual({ message: MESSAGES.banners.errors.cancelada, notice: null, refresh: false });
    expect(channelBanner({ error: "toString" }, []).message).toBeNull();
    expect(channelBanner({ conectado: "fax" }, []).notice).toBeNull();
  });
});
