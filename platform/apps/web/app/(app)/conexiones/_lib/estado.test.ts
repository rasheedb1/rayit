import { describe, expect, it } from "vitest";
import type { AccountRow } from "@mc/db";
import { accesoDe, estadoDeCuenta, filaDeCuenta, frescura, proveedorDe, type FilaDeCuenta } from "./estado";

/**
 * CON-4 · las tres decisiones de la pantalla, sin base y sin React.
 *
 * La que importa es la primera: una cuenta autorizada cuyo token YA
 * venció se ve en rojo y ofrece reautorizar aunque `status` siga en
 * 'active', porque en producción `oauth.refresh` todavía no corre
 * (CIM-7) y nadie ha anotado el vencimiento.
 */

const AHORA = new Date("2026-09-23T12:00:00Z");

function cuenta(over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    platformId: "tiktok",
    externalAccountId: "open_id_1",
    handle: "cafealma",
    displayName: "Café Alma",
    avatarUrl: null,
    profileUrl: null,
    accountType: "creator",
    status: "active",
    statusDetail: null,
    secretRef: "enc:tiktok:1",
    scopes: ["user.info.basic"],
    connectedAt: "2026-09-01T00:00:00.000Z",
    lastSyncedAt: "2026-09-23T09:00:00.000Z",
    hoursSinceSync: 3,
    accessExpiresAt: "2026-09-24T12:00:00.000Z",
    tokenExpiringSoon: false,
    consecutiveFailures: 0,
    postsTracked: 0,
    failedCalls24h: 0,
    accessMode: "direct_oauth",
    latest: null,
    followersWeekAgo: null,
    followersDelta7d: null,
    ...over,
  };
}

function fila(over: Partial<AccountRow> = {}): FilaDeCuenta {
  return filaDeCuenta(cuenta(over));
}

describe("estadoDeCuenta · una cuenta autorizada", () => {
  it("con el token ya vencido se ve en rojo y ofrece reautorizar, aunque status siga en 'active'", () => {
    const e = estadoDeCuenta(fila({ status: "active", accessExpiresAt: "2026-09-23T11:59:59.000Z" }), AHORA);
    expect(e).toEqual({ tono: "bad", texto: "Vencida", accion: "reautorizar" });
  });

  it("status 'expired', 'needs_reauth' y 'revoked' son rojos y se reautorizan", () => {
    const sinFecha = { accessExpiresAt: null } as const;
    expect(estadoDeCuenta(fila({ status: "expired", ...sinFecha }), AHORA)).toMatchObject({ tono: "bad", texto: "Vencida", accion: "reautorizar" });
    expect(estadoDeCuenta(fila({ status: "needs_reauth", ...sinFecha }), AHORA)).toMatchObject({ tono: "bad", texto: "Necesita reautorizar", accion: "reautorizar" });
    expect(estadoDeCuenta(fila({ status: "revoked", ...sinFecha }), AHORA)).toMatchObject({ tono: "bad", texto: "Revocada", accion: "reautorizar" });
  });

  it("la plataforma manda sobre la fecha: un token vencido que ADEMÁS fue revocado dice revocada", () => {
    const e = estadoDeCuenta(fila({ status: "revoked", accessExpiresAt: "2026-01-01T00:00:00.000Z" }), AHORA);
    expect(e.texto).toBe("Revocada");
  });

  it("un error de lectura es rojo pero no manda a reautorizar: no es un problema de permiso", () => {
    expect(estadoDeCuenta(fila({ status: "error" }), AHORA)).toEqual({ tono: "bad", texto: "No se pudo leer", accion: "actualizar" });
  });

  it("vence dentro de 24 h: ámbar, sin alarma", () => {
    expect(estadoDeCuenta(fila({ tokenExpiringSoon: true }), AHORA)).toEqual({ tono: "warn", texto: "Vence pronto", accion: "actualizar" });
  });

  it("viva y con el token al día: verde", () => {
    expect(estadoDeCuenta(fila(), AHORA)).toEqual({ tono: "good", texto: "Activa", accion: "actualizar" });
  });

  it("el portafolio de empresa también lleva permiso del dueño: también vence", () => {
    const e = estadoDeCuenta(fila({ accessMode: "business_portfolio", accessExpiresAt: "2026-09-20T00:00:00.000Z" }), AHORA);
    expect(e).toMatchObject({ texto: "Vencida", accion: "reautorizar" });
  });

  it("sin fecha de vencimiento no se inventa que venció", () => {
    expect(estadoDeCuenta(fila({ accessExpiresAt: null }), AHORA)).toMatchObject({ texto: "Activa" });
  });

  it("quitada es neutra y no ofrece nada", () => {
    expect(estadoDeCuenta(fila({ status: "disabled" }), AHORA)).toEqual({ tono: "neutral", texto: "Quitada", accion: "ninguna" });
  });
});

describe("estadoDeCuenta · una cuenta por @", () => {
  const porArroba = { accessMode: "public_profile", secretRef: "public:tiktok:cafealma" } as const;

  it("no tiene token: una fecha pasada no la pone en rojo ni ofrece reautorizar", () => {
    const e = estadoDeCuenta(fila({ ...porArroba, accessExpiresAt: "2020-01-01T00:00:00.000Z" }), AHORA);
    expect(e).toEqual({ tono: "good", texto: "Activa", accion: "actualizar" });
  });

  it("si la fuente pública falló, lo dice y deja reintentar", () => {
    expect(estadoDeCuenta(fila({ ...porArroba, status: "error" }), AHORA)).toEqual({ tono: "bad", texto: "No se pudo leer", accion: "actualizar" });
  });
});

describe("accesoDe", () => {
  it("distingue las cuatro procedencias y cuáles llevan token", () => {
    expect(accesoDe("public_profile")).toMatchObject({ clase: "por_arroba", etiqueta: "Por @", conToken: false });
    expect(accesoDe("direct_oauth")).toMatchObject({ clase: "autorizada", etiqueta: "Autorizada", conToken: true });
    expect(accesoDe("business_portfolio")).toMatchObject({ clase: "autorizada", conToken: true });
    expect(accesoDe("manual_csv")).toMatchObject({ clase: "csv", etiqueta: "Por CSV", conToken: false });
    expect(accesoDe("aggregator")).toMatchObject({ clase: "proveedor", etiqueta: "Por proveedor", conToken: false });
  });

  it("«Por @» y «Autorizada» no comparten ni etiqueta ni explicación: se distinguen leyendo", () => {
    const a = accesoDe("public_profile");
    const b = accesoDe("direct_oauth");
    expect(a.etiqueta).not.toBe(b.etiqueta);
    expect(a.explicacion).not.toBe(b.explicacion);
  });
});

describe("frescura", () => {
  it("pone las horas de connection_health en palabras", () => {
    expect(frescura(0.4)).toBe("hace menos de una hora");
    expect(frescura(1)).toBe("hace una hora");
    expect(frescura(3.9)).toBe("hace 3 horas");
    expect(frescura(23.99)).toBe("hace 23 horas");
    expect(frescura(24)).toBe("hace un día");
    expect(frescura(50)).toBe("hace 2 días");
  });

  it("sin lectura, una frase; nunca un guion ni un cero", () => {
    expect(frescura(null)).toBe("Sin leer todavía");
    expect(frescura(null)).not.toMatch(/^[-–—0]/);
  });

  it("un reloj adelantado no produce «hace −1 horas»", () => {
    expect(frescura(-0.5)).toBe("hace menos de una hora");
  });
});

describe("filaDeCuenta", () => {
  it("deja fuera la ref del secreto y los scopes: no son de la pantalla", () => {
    const f = filaDeCuenta(cuenta());
    expect(f).not.toHaveProperty("secretRef");
    expect(f).not.toHaveProperty("scopes");
    expect(JSON.stringify(f)).not.toContain("enc:tiktok:");
    expect(JSON.stringify(f)).not.toContain("user.info.basic");
  });
});

describe("proveedorDe", () => {
  it("solo TikTok e Instagram tienen app de CON-3; YouTube y Facebook todavía no", () => {
    expect(proveedorDe("tiktok")).toBe("tiktok");
    expect(proveedorDe("instagram")).toBe("instagram");
    expect(proveedorDe("youtube")).toBeNull();
    expect(proveedorDe("facebook")).toBeNull();
  });
});
