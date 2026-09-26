import { describe, expect, it } from "vitest";
import { GOOGLE_STATE_TTL_MS, UNIPILE_STATE_TTL_MS } from "@mc/connectors";
import { PENDING_STALE_MINUTES, type ChannelAccountRow } from "@mc/db/queries/canales";
import { MESSAGES } from "../messages";
import { channelBanner } from "./banner";
import { channelSetup, showAdminDetails } from "./config";
import { channelRows, pillFor, reasonText } from "./filas";

const ALL = {
  TOKEN_ENCRYPTION_KEY: "k", GOOGLE_OUTREACH_CLIENT_ID: "g", GOOGLE_OUTREACH_CLIENT_SECRET: "s",
  UNIPILE_DSN: "d", UNIPILE_ACCESS_TOKEN: "t", UNIPILE_WEBHOOK_SECRET: "w",
};
const SIN_UNIPILE = { TOKEN_ENCRYPTION_KEY: "k", GOOGLE_OUTREACH_CLIENT_ID: "g", GOOGLE_OUTREACH_CLIENT_SECRET: "s" };

function account(over: Partial<ChannelAccountRow>): ChannelAccountRow {
  return {
    id: "00000000-0000-4000-8000-000000000001", channel: "email", provider: "gmail_oauth", providerAccountId: "a@b.test", displayName: "a@b.test",
    status: "connected", stale: false, dailyCap: null, weeklyCap: null, scopes: [], lastOkAt: null, lastOkAgoS: null, lastErrorAt: null,
    lastError: null, lastErrorRecent: true, lastErrorFresh: true, updatedAt: new Date(0),
    limits: { effectiveDaily: 20, effectiveWeekly: 140, maxDaily: 20, maxWeekly: 140, dailyLimitedBy: "policy", weeklyLimitedBy: "policy", personalMailbox: false },
    ...over,
  };
}

describe("channelSetup", () => {
  it("sin nada dice qué falta por canal; con todo, los tres se pueden conectar", () => {
    const none = channelSetup({});
    expect(none.email.missing).toEqual(["GOOGLE_OUTREACH_CLIENT_ID", "GOOGLE_OUTREACH_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]);
    expect(none.linkedin.missing).toEqual(["UNIPILE_DSN", "UNIPILE_ACCESS_TOKEN", "UNIPILE_WEBHOOK_SECRET", "TOKEN_ENCRYPTION_KEY"]);
    const all = channelSetup(ALL);
    expect([all.email.configured, all.linkedin.configured, all.instagram_dm.configured]).toEqual([true, true, true]);
  });
});

describe("showAdminDetails", () => {
  it("los nombres de las variables que faltan: solo en desarrollo y a quien gestiona; nunca en producción, ni en una demo pública", () => {
    expect(showAdminDetails({ canManage: true, nodeEnv: "development" })).toBe(true);
    expect(showAdminDetails({ canManage: false, nodeEnv: "development" }), "un miembro sin permiso no los ve").toBe(false);
    expect(showAdminDetails({ canManage: true, nodeEnv: "production" }), "producción, también con la base embebida").toBe(false);
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

  it("un canal fuera de la política del espacio (Instagram nace así, 0045): «Apagado en este espacio» y sin «Conectar otra cuenta»", () => {
    const allowed = ["email", "linkedin"];
    const rows = channelRows([], channelSetup(ALL), { allowed });
    expect(rows.map((r) => [r.channel, r.state, r.off])).toEqual([
      ["email", "disconnected", false], ["linkedin", "disconnected", false], ["instagram_dm", "off", true],
    ]);
    expect(pillFor(rows[2]!)).toEqual({ kind: "neutral", label: MESSAGES.status.off });
    // Una cuenta que se conectó antes de apagarlo: sigue a la vista, «En pausa», y no se ofrece otra.
    const ig = account({ id: "00000000-0000-4000-8000-0000000000a1", channel: "instagram_dm", provider: "unipile", providerAccountId: "acc_ig", displayName: "laura" });
    const [, , conCuenta] = channelRows([ig], channelSetup(ALL), { allowed });
    expect([conCuenta!.state, conCuenta!.off, conCuenta!.addAnother]).toEqual(["connected", true, false]);
    expect(pillFor(conCuenta!).label).toBe(MESSAGES.status.paused);
    // Sin llaves manda «No disponible» (la plataforma), aunque el espacio también lo tenga apagado.
    expect(channelRows([], channelSetup({}), { allowed })[2]!.state).toBe("not_configured");
    // Sin la lista (una llamada sin política), los tres se ofrecen.
    expect(channelRows([], channelSetup(ALL)).some((r) => r.off)).toBe(false);
  });

  it("sin llaves, un Gmail conectado no sale en verde: «En pausa» y dice por qué", () => {
    const rows = channelRows([account({ status: "connected" })], channelSetup({}));
    expect(rows[0]).toMatchObject({ state: "connected", unavailable: true, action: null });
    expect(pillFor(rows[0]!)).toEqual({ kind: "warn", label: MESSAGES.status.paused });
    expect(rows[0]!.missing).toContain("GOOGLE_OUTREACH_CLIENT_ID");
    // Con llaves, verde.
    expect(pillFor(channelRows([account({ status: "connected" })], channelSetup(ALL))[0]!)).toEqual({ kind: "good", label: MESSAGES.status.connected });
  });

  it("sin llaves, un LinkedIn por reconectar conserva «Reconectar» (deshabilitado) y el motivo: nunca rojo sin explicación", () => {
    const li = account({ id: "1", channel: "linkedin", provider: "unipile", status: "needs_reconnect", lastError: "unipile_status:CREDENTIALS" });
    const rows = channelRows([li], channelSetup(SIN_UNIPILE));
    expect(rows[1]).toMatchObject({ state: "needs_reconnect", action: "reconnect", unavailable: true, reason: "LinkedIn cerró la sesión." });
    expect(rows[1]!.missing).toEqual(["UNIPILE_DSN", "UNIPILE_ACCESS_TOKEN", "UNIPILE_WEBHOOK_SECRET"]);
    // El correo, con sus llaves, no queda afectado.
    expect(rows[0]!.unavailable).toBe(false);
  });

  it("la viva gana a la pendiente y a la desconectada; por reconectar lleva «Reconectar»", () => {
    const rows = channelRows([
      account({ id: "1", channel: "linkedin", provider: "unipile", status: "needs_reconnect", lastError: "unipile_status:STOPPED" }),
      account({ id: "2", channel: "linkedin", provider: "unipile", status: "disconnected" }),
    ], channelSetup(ALL));
    expect(rows[1]).toMatchObject({ state: "needs_reconnect", action: "reconnect", unavailable: false, reason: MESSAGES.health.unipileStatus("STOPPED", "LinkedIn") });
    expect(rows[1]!.account?.id).toBe("1");
  });

  it("pendiente reciente: conectando; vieja: sin terminar; desconectada por otro espacio o cancelada dice por qué", () => {
    const pend = channelRows([account({ channel: "instagram_dm", provider: "unipile", status: "pending", providerAccountId: null })], channelSetup(ALL));
    expect(pend[2]).toMatchObject({ state: "pending", action: "retry" });
    const old = channelRows([account({ channel: "instagram_dm", provider: "unipile", status: "pending", stale: true })], channelSetup(ALL));
    expect(old[2]).toMatchObject({ state: "expired", action: "retry" });
    const taken = channelRows([account({ status: "disconnected", providerAccountId: null, lastError: "taken" })], channelSetup(ALL));
    expect(taken[0]).toMatchObject({ state: "disconnected", action: "connect", reason: MESSAGES.banners.errors.ocupada });
    const cancelled = channelRows([account({ status: "disconnected", providerAccountId: null, lastError: "cancelled" })], channelSetup(ALL));
    expect(cancelled[0]!.reason).toBe(MESSAGES.banners.errors.cancelada);
    // Cancelar no es un error: la fila lo dice en neutro, no en el recuadro rojo.
    expect(cancelled[0]!.reasonTone).toBe("neutral");
    expect(taken[0]!.reasonTone).toBe("error");
  });

  it("dos cuentas vivas del mismo canal: la primera encabeza y la segunda sale en su sub-fila, con su estado y su botón", () => {
    const rows = channelRows([
      account({ id: "a", displayName: "alianzas@laura.test", status: "connected" }),
      account({ id: "b", displayName: "laura@gmail.test", status: "needs_reconnect", lastError: "gmail_revoked" }),
      account({ id: "c", status: "disconnected" }),
    ], channelSetup(ALL));
    expect(rows[0]).toMatchObject({ state: "connected", action: null });
    expect(rows[0]!.account?.id).toBe("a");
    expect(rows[0]!.others.map((o) => [o.account?.id, o.state, o.action, o.reason])).toEqual([
      ["b", "needs_reconnect", "reconnect", MESSAGES.health.gmailRevoked],
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
    const [, otra] = channelRows([{ ...li, lastError: "transient" }], channelSetup(ALL));
    expect(otra!.action).toBeNull();
  });

  it("reasonText traduce los códigos (con el nombre del servicio si la frase lo lleva) y deja pasar las frases de @mc/core", () => {
    expect(reasonText("releasing", "email")).toBe(MESSAGES.detail.releasing);
    expect(reasonText("webhooks_missing", "linkedin")).toBe(MESSAGES.detail.webhooksMissing);
    expect(reasonText("missing_scopes", "email")).toBe(MESSAGES.banners.errors.permisos);
    expect(reasonText("wrong_provider", "linkedin")).toBe(MESSAGES.banners.errors.canal_equivocado);
    expect(reasonText("exchange_failed", "email")).toBe(MESSAGES.banners.errors.intercambio);
    expect(reasonText("provider_error", "instagram_dm")).toBe(MESSAGES.banners.errors.proveedor("Instagram"));
    expect(reasonText("auth_failed", "linkedin")).toBe(MESSAGES.banners.errors.unipile_fallo("LinkedIn"));
    expect(reasonText("provider_error", "instagram_dm"), "nombra el servicio, no «el proveedor»").not.toMatch(/proveedor/);
    expect(reasonText(null, "email")).toBeNull();
  });

  it("last_error guarda códigos y la pantalla los traduce: los del keepalive, el de Unipile parametrizado, y nada crudo", () => {
    expect(reasonText("unipile_status:CREDENTIALS", "linkedin")).toBe(MESSAGES.health.unipileStatus("CREDENTIALS", "LinkedIn"));
    expect(reasonText("unipile_status:ALGO_NUEVO", "instagram_dm")).toBe(MESSAGES.health.unipileStatus("ALGO_NUEVO", "Instagram"));
    expect(reasonText("unipile_gone", "linkedin")).toBe(MESSAGES.health.unipileGone("LinkedIn"));
    expect(reasonText("gmail_revoked", "email")).toBe(MESSAGES.health.gmailRevoked);
    expect(reasonText("gmail_no_secret", "email")).toBe(MESSAGES.health.gmailNoSecret);
    expect(reasonText("transient", "email")).toBe(MESSAGES.detail.reasons.transient);
    expect(reasonText("duplicate", "linkedin")).toBe(MESSAGES.detail.reasons.duplicado);
    // Un código que la pantalla no conoce (o un nombre de Object.prototype) nunca sale crudo.
    expect(reasonText("codigo_nuevo_del_worker", "email")).toBe(MESSAGES.detail.unknownReason);
    expect(reasonText("toString", "email")).toBe(MESSAGES.detail.unknownReason);
    // Una frase en last_error (nadie las escribe: 0038 a 0043 no se aplicaron nunca con frases) tampoco sale tal cual.
    expect(reasonText(MESSAGES.health.transient, "email")).toBe(MESSAGES.detail.unknownReason);
    expect(reasonText("LinkedIn cerró la sesión.", "linkedin")).toBe(MESSAGES.detail.unknownReason);
  });

  it("un fallo pasajero del servicio (no respondió, no se pudo comprobar) solo se enseña durante una hora", () => {
    const reciente = account({
      channel: "instagram_dm", provider: "unipile", status: "disconnected", providerAccountId: null, lastError: "provider_error", lastErrorRecent: true, lastErrorFresh: true,
    });
    expect(channelRows([reciente], channelSetup(ALL))[2]!.reason).toBe(MESSAGES.banners.errors.proveedor("Instagram"));
    // A la hora y cinco minutos el servicio ya volvió: la fila «Sin conectar» deja de estar en rojo, aunque sea del mismo día.
    const deHaceUnRato = { ...reciente, lastErrorFresh: false };
    expect(channelRows([deHaceUnRato], channelSetup(ALL))[2]).toMatchObject({ state: "disconnected", reason: null });
    expect(channelRows([{ ...deHaceUnRato, lastErrorRecent: false }], channelSetup(ALL))[2]!.reason).toBeNull();
    // Un motivo que no es pasajero se queda aunque sea viejo: sigue siendo verdad.
    expect(channelRows([{ ...deHaceUnRato, lastErrorRecent: false, lastError: "taken" }], channelSetup(ALL))[2]!.reason).toBe(MESSAGES.banners.errors.ocupada);
    // En una cuenta conectada, «no pudimos comprobarla» tampoco se queda más de una hora.
    const li = account({ id: "1", channel: "linkedin", provider: "unipile", status: "connected", lastError: "transient", lastErrorFresh: false });
    expect(channelRows([li], channelSetup(ALL))[1]!.reason).toBeNull();
    expect(reasonText("transient", "email", true, false)).toBeNull();
    expect(reasonText("transient", "email", true, true)).toBe(MESSAGES.detail.reasons.transient);
    // Cancelar o una contraseña mala no son pasajeros del servicio: duran sus 24 horas aunque pase la hora.
    expect(reasonText("cancelled", "email", true, false)).toBe(MESSAGES.banners.errors.cancelada);
  });

  it("una cuenta que la persona desconectó no arrastra el motivo de su última caída; un intento que no terminó, sí", () => {
    // Una cuenta viva (con su account_id) que se cayó y luego se desconectó a propósito.
    const soltada = account({ id: "1", channel: "linkedin", provider: "unipile", providerAccountId: "acc_li_0001", status: "disconnected", lastError: "unipile_status:CREDENTIALS" });
    expect(channelRows([soltada], channelSetup(ALL))[1]).toMatchObject({ state: "disconnected", action: "connect", reason: null, reasonTone: "error" });
    expect(channelRows([{ ...soltada, lastError: "gmail_revoked", channel: "email", provider: "gmail_oauth" }], channelSetup(ALL))[0]!.reason).toBeNull();
    // Un intento (la fila nunca tuvo cuenta) sigue diciendo en qué quedó.
    const intento = { ...soltada, providerAccountId: null, lastError: "wrong_provider" };
    expect(channelRows([intento], channelSetup(ALL))[1]!.reason).toBe(MESSAGES.banners.errors.canal_equivocado);
  });

  it("la frase genérica de un código desconocido no promete que se arregle sola si la cuenta ya pide reconectar", () => {
    const caida = account({ id: "1", channel: "linkedin", provider: "unipile", status: "needs_reconnect", lastError: "codigo_nuevo" });
    expect(channelRows([caida], channelSetup(ALL))[1]!.reason).toBe(MESSAGES.detail.unknownReasonReconnect);
    expect(channelRows([{ ...caida, status: "error" }], channelSetup(ALL))[1]!.reason).toBe(MESSAGES.detail.unknownReason);
    expect(MESSAGES.detail.unknownReasonReconnect).not.toMatch(/sola/);
  });

  it("cancelar en Google o una contraseña mala caducan como los pasajeros: a las 24 horas la fila «Sin conectar» ya no lo repite", () => {
    const cancelado = account({ status: "disconnected", providerAccountId: null, lastError: "cancelled", lastErrorRecent: true });
    expect(channelRows([cancelado], channelSetup(ALL))[0]!.reason).toBe(MESSAGES.banners.errors.cancelada);
    expect(channelRows([{ ...cancelado, lastErrorRecent: false }], channelSetup(ALL))[0]).toMatchObject({ state: "disconnected", reason: null });
    const fallo = account({ channel: "linkedin", provider: "unipile", status: "disconnected", providerAccountId: null, lastError: "auth_failed", lastErrorRecent: true });
    expect(channelRows([fallo], channelSetup(ALL))[1]!.reason).toBe(MESSAGES.banners.errors.unipile_fallo("LinkedIn"));
    expect(channelRows([{ ...fallo, lastErrorRecent: false }], channelSetup(ALL))[1]!.reason).toBeNull();
    expect(reasonText("cancelled", "email", false)).toBeNull();
    expect(reasonText("auth_failed", "linkedin", false)).toBeNull();
  });

  it("de vuelta de Unipile (?conectado=linkedin) con la fila pendiente: la pista no pide terminar algo que ya terminó", () => {
    const pend = account({ channel: "linkedin", provider: "unipile", status: "pending", providerAccountId: null });
    expect(channelRows([pend], channelSetup(ALL), { returnedFrom: "linkedin" })[1]!.returned).toBe(true);
    expect(channelRows([pend], channelSetup(ALL))[1]!.returned).toBe(false);
    expect(channelRows([pend], channelSetup(ALL), { returnedFrom: "instagram_dm" })[1]!.returned).toBe(false);
    expect(MESSAGES.detail.pendingHint.returned("LinkedIn")).not.toBe(MESSAGES.detail.pendingHint.unipile("LinkedIn"));
  });

  it("pendiente vieja + intento nuevo cancelado: la fila dice «cancelaste», no «Conectando» (manda el intento más reciente)", () => {
    const rows = channelRows([
      account({ id: "nuevo", status: "disconnected", providerAccountId: null, lastError: "cancelled", updatedAt: new Date(2_000) }),
      account({ id: "viejo", status: "pending", stale: false, providerAccountId: null, updatedAt: new Date(1_000) }),
    ], channelSetup(ALL));
    expect(rows[0]).toMatchObject({ state: "disconnected", action: "connect", reason: MESSAGES.banners.errors.cancelada });
    expect(rows[0]!.account?.id).toBe("nuevo");
  });

  it("un canal con una cuenta CONECTADA ofrece «Conectar otra cuenta»; con la única caída, sin llaves o en una sub-fila, no", () => {
    const [gmail] = channelRows([account({ id: "a", status: "connected" }), account({ id: "b", status: "needs_reconnect" })], channelSetup(ALL));
    expect(gmail!.addAnother).toBe(true);
    expect(gmail!.others.map((o) => o.addAnother)).toEqual([false]);
    expect(channelRows([account({ status: "needs_reconnect" })], channelSetup(ALL))[0]!.addAnother, "con la única caída manda «Reconectar»").toBe(false);
    expect(channelRows([account({ status: "connected" })], channelSetup({}))[0]!.addAnother, "sin llaves no").toBe(false);
    expect(channelRows([], channelSetup(ALL)).map((r) => r.addAnother)).toEqual([false, false, false]);
    expect(channelRows([account({ status: "pending" })], channelSetup(ALL))[0]!.addAnother).toBe(false);
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
    expect(channelBanner({ conectado: "linkedin" }, li("connected"))).toEqual({
      message: null, notice: MESSAGES.banners.connected("LinkedIn"), warning: null, info: null, refresh: false, slowNotice: null,
    });
  });

  it("todavía conectándose (el aviso de Unipile no llegó): «Estamos terminando…» y refresca", () => {
    expect(channelBanner({ conectado: "linkedin" }, li("pending"))).toEqual({
      message: null, notice: MESSAGES.banners.finishing("LinkedIn"), warning: null, info: null, refresh: true, slowNotice: MESSAGES.banners.finishingSlow("LinkedIn"),
    });
  });

  it("por reconectar, desconectada o sin fila: nada (la fila ya lo dice) — nunca verde encima de rojo", () => {
    expect(channelBanner({ conectado: "linkedin" }, li("needs_reconnect"))).toEqual({ message: null, notice: null, warning: null, info: null, refresh: false, slowNotice: null });
    expect(channelBanner({ conectado: "linkedin" }, li("disconnected")).notice).toBeNull();
    expect(channelBanner({ conectado: "linkedin" }, []).notice).toBeNull();
  });

  it("un error conocido es el error; uno inventado o un canal inventado, nada", () => {
    expect(channelBanner({ error: "ocupada" }, [])).toEqual({ message: MESSAGES.banners.errors.ocupada, notice: null, warning: null, info: null, refresh: false, slowNotice: null });
    expect(channelBanner({ error: "toString" }, []).message).toBeNull();
    expect(channelBanner({ conectado: "fax" }, []).notice).toBeNull();
  });

  it("un error del servicio lo nombra (?canal=); sin canal, «el servicio»; nunca «el proveedor»", () => {
    expect(channelBanner({ error: "proveedor", canal: "instagram_dm" }, []).message).toBe(MESSAGES.banners.errors.proveedor("Instagram"));
    expect(channelBanner({ error: "unipile_fallo", canal: "linkedin" }, []).message).toBe(MESSAGES.banners.errors.unipile_fallo("LinkedIn"));
    expect(channelBanner({ error: "proveedor" }, []).message).toBe(MESSAGES.banners.errors.proveedor(MESSAGES.banners.genericService));
    expect(channelBanner({ error: "proveedor", canal: "linkedin" }, []).message).not.toMatch(/proveedor/i);
  });

  it("si la fila de ese canal ya dice lo mismo, el aviso de arriba no lo repite; si dice otra cosa, sí sale", () => {
    const fallida = channelRows([account({ channel: "linkedin", provider: "unipile", status: "disconnected", providerAccountId: null, lastError: "auth_failed" })], channelSetup(ALL));
    expect(fallida[1]!.reason).toBe(MESSAGES.banners.errors.unipile_fallo("LinkedIn"));
    expect(channelBanner({ error: "unipile_fallo", canal: "linkedin" }, fallida)).toEqual({ message: null, notice: null, warning: null, info: null, refresh: false, slowNotice: null });
    const sinEnlace = channelRows([account({ channel: "instagram_dm", provider: "unipile", status: "disconnected", providerAccountId: null, lastError: "provider_error" })], channelSetup(ALL));
    expect(channelBanner({ error: "proveedor", canal: "instagram_dm" }, sinEnlace).message).toBeNull();
    // Una conectada con otro motivo (sus avisos) no tapa el error de un intento nuevo.
    const conAvisos = channelRows([account({ channel: "linkedin", provider: "unipile", status: "connected", lastError: "webhooks_missing" })], channelSetup(ALL));
    expect(channelBanner({ error: "proveedor", canal: "linkedin" }, conAvisos).message).toBe(MESSAGES.banners.errors.proveedor("LinkedIn"));
  });
});

describe("channelBanner: no todo ?error= es un error", () => {
  it("no configurado nombra el servicio de ?canal=, dice lo mismo que la fila y va en ámbar, no en rojo", () => {
    const b = channelBanner({ error: "no_configurado", canal: "linkedin" }, []);
    expect(b).toEqual({ message: null, notice: null, warning: "LinkedIn todavía no está disponible en On Cue.", info: null, refresh: false, slowNotice: null });
    expect(b.warning).toBe(MESSAGES.detail.unavailable("LinkedIn"));
    expect(channelBanner({ error: "no_configurado", canal: "email" }, []).warning).toBe(MESSAGES.detail.unavailable("Gmail"));
  });

  it("cancelar la autorización (o un perfil que ya estaba) es neutro: ni rojo ni verde", () => {
    expect(channelBanner({ error: "cancelada", canal: "email" }, [])).toEqual({
      message: null, notice: null, warning: null, info: MESSAGES.banners.errors.cancelada, refresh: false, slowNotice: null,
    });
    expect(channelBanner({ error: "duplicado", canal: "linkedin" }, []).info).toBe(MESSAGES.banners.errors.duplicado);
    expect(channelBanner({ error: "permisos", canal: "email" }, []).message).toBe(MESSAGES.banners.errors.permisos);
  });
});
