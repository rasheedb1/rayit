import { describe, expect, it } from "vitest";
import type { AccountRow } from "@mc/db";
import { accesoDe, estadoDeCuenta, filaDeCuenta, frescura, huecosDeCuenta, proveedorDe, type FilaDeCuenta } from "./estado";
import { MESSAGES } from "./messages";

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
    connectedBy: null,
    postsCount: 0,
    lastPostSnapshotAt: null,
    refreshExpiresAt: null,
    gaps: [],
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
    expect(e).toEqual({ tono: "bad", texto: "Vencida", accion: "reautorizar", nota: null });
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
    expect(estadoDeCuenta(fila({ status: "error" }), AHORA)).toEqual({ tono: "bad", texto: "No se pudo leer", accion: "actualizar", nota: null });
  });

  it("vence dentro de 24 h: ámbar, sin alarma", () => {
    expect(estadoDeCuenta(fila({ tokenExpiringSoon: true }), AHORA)).toEqual({ tono: "warn", texto: "Vence pronto", accion: "actualizar", nota: null });
  });

  it("viva y con el token al día: verde", () => {
    expect(estadoDeCuenta(fila(), AHORA)).toEqual({ tono: "good", texto: "Activa", accion: "actualizar", nota: null });
  });

  it("una cuenta que esta pantalla no sabe releer no ofrece «Actualizar»: sería un botón que solo puede fallar", () => {
    for (const modo of ["business_portfolio", "manual_csv"] as const) {
      expect(estadoDeCuenta(fila({ accessMode: modo }), AHORA).accion).toBe("ninguna");
    }
    // El proveedor de datos (CON-12) se relee igual que una cuenta por @ (cierre CON-C).
    for (const modo of ["direct_oauth", "public_profile", "aggregator"] as const) {
      expect(estadoDeCuenta(fila({ accessMode: modo }), AHORA).accion).toBe("actualizar");
    }
  });

  it("y tampoco la ofrece cuando falló la lectura: un CSV no se arregla buscando el @ por ahí, y lo dice", () => {
    expect(estadoDeCuenta(fila({ accessMode: "manual_csv", status: "error" }), AHORA)).toEqual({
      tono: "bad",
      texto: "No se pudo leer",
      accion: "ninguna",
      nota: MESSAGES.tabla.sinRelectura,
    });
    expect(estadoDeCuenta(fila({ accessMode: "business_portfolio", status: "error" }), AHORA).nota).toBe(MESSAGES.tabla.sinRelectura);
  });

  it("el portafolio de empresa también lleva permiso del dueño: también vence", () => {
    const e = estadoDeCuenta(fila({ accessMode: "business_portfolio", accessExpiresAt: "2026-09-20T00:00:00.000Z" }), AHORA);
    expect(e).toMatchObject({ texto: "Vencida", accion: "reautorizar" });
  });

  it("sin fecha de vencimiento no se inventa que venció", () => {
    expect(estadoDeCuenta(fila({ accessExpiresAt: null }), AHORA)).toMatchObject({ texto: "Activa" });
  });

  it("quitada es neutra y no ofrece nada", () => {
    expect(estadoDeCuenta(fila({ status: "disabled" }), AHORA)).toEqual({ tono: "neutral", texto: "Quitada", accion: "ninguna", nota: null });
  });
});

describe("estadoDeCuenta · una cuenta por @", () => {
  const porArroba = { accessMode: "public_profile", secretRef: "public:tiktok:cafealma" } as const;

  it("no tiene token: una fecha pasada no la pone en rojo ni ofrece reautorizar", () => {
    const e = estadoDeCuenta(fila({ ...porArroba, accessExpiresAt: "2020-01-01T00:00:00.000Z" }), AHORA);
    expect(e).toEqual({ tono: "good", texto: "Activa", accion: "actualizar", nota: null });
  });

  it("si la fuente pública falló, lo dice y deja reintentar", () => {
    expect(estadoDeCuenta(fila({ ...porArroba, status: "error" }), AHORA)).toEqual({ tono: "bad", texto: "No se pudo leer", accion: "actualizar", nota: null });
  });
});

describe("accesoDe", () => {
  it("distingue las cuatro procedencias y cuáles llevan token", () => {
    expect(accesoDe("public_profile")).toMatchObject({ clase: "por_arroba", etiqueta: "Por @", conToken: false, relectura: true });
    expect(accesoDe("direct_oauth")).toMatchObject({ clase: "autorizada", etiqueta: "Autorizada", conToken: true, relectura: true });
    expect(accesoDe("business_portfolio")).toMatchObject({ clase: "autorizada", conToken: true, relectura: false });
    expect(accesoDe("manual_csv")).toMatchObject({ clase: "csv", etiqueta: "Por CSV", conToken: false, relectura: false });
    expect(accesoDe("aggregator")).toMatchObject({ clase: "proveedor", etiqueta: "Por proveedor", conToken: false, relectura: true });
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
  it("TikTok e Instagram tienen app de CON-3 y YouTube la de CON-8; Facebook todavía no", () => {
    expect(proveedorDe("tiktok")).toBe("tiktok");
    expect(proveedorDe("instagram")).toBe("instagram");
    expect(proveedorDe("youtube")).toBe("youtube");
    expect(proveedorDe("facebook")).toBeNull();
    // Revisión: el portafolio de empresa de Meta no se repara con Instagram Login.
    expect(proveedorDe("instagram", "business_portfolio")).toBeNull();
    expect(proveedorDe("tiktok", "public_profile")).toBeNull();
  });
});

/**
 * CON-B · las costuras de la fila con lo que entró a /conexiones después
 * de CON-4. Cada una falla si el contrato con el otro módulo se rompe.
 */
describe("costura CON-3 → CON-4: un acceso vencido con renovación viva", () => {
  const VENCIO = "2026-09-23T11:00:00.000Z";

  it("se renueva sola: ámbar, sin «Actualizar» ni reautorizar urgente, con salida secundaria, y la frase dice que depende del worker", () => {
    const e = estadoDeCuenta(fila({ accessExpiresAt: VENCIO, refreshExpiresAt: "2027-09-23T00:00:00.000Z" }), AHORA);
    expect(e).toEqual({ tono: "warn", texto: MESSAGES.tabla.estado.seRenuevaSola, accion: "reautorizar_opcional", nota: MESSAGES.tabla.seRenuevaSola });
    expect(e.nota).toContain("worker de renovación");
    expect(e.nota).toContain("cuando corra");
  });

  it("sin permiso de renovación (null) hay que volver a autorizar: rojo y «Reautorizar»", () => {
    expect(estadoDeCuenta(fila({ accessExpiresAt: VENCIO, refreshExpiresAt: null }), AHORA)).toMatchObject({ tono: "bad", texto: "Vencida", accion: "reautorizar" });
  });

  it("con la renovación TAMBIÉN vencida, igual: rojo y «Reautorizar»", () => {
    expect(estadoDeCuenta(fila({ accessExpiresAt: VENCIO, refreshExpiresAt: "2026-09-23T11:30:00.000Z" }), AHORA)).toMatchObject({ texto: "Vencida", accion: "reautorizar" });
  });

  it("lo que dice la plataforma manda sobre la renovación: needs_reauth no se renueva solo", () => {
    expect(estadoDeCuenta(fila({ status: "needs_reauth", accessExpiresAt: VENCIO, refreshExpiresAt: "2027-01-01T00:00:00.000Z" }), AHORA).accion).toBe("reautorizar");
  });

  it("una cuenta por @ no tiene renovación que valga: nunca «se renueva sola»", () => {
    const e = estadoDeCuenta(fila({ accessMode: "public_profile", accessExpiresAt: VENCIO, refreshExpiresAt: "2027-01-01T00:00:00.000Z" }), AHORA);
    expect(e.texto).toBe("Activa");
  });
});

describe("costura ACC-8: quién la conectó", () => {
  const at = "2026-09-20T15:00:00.000Z";

  it("un tercero con nombre: su nombre; sin nombre, su correo; sin ninguno, «alguien del equipo»", () => {
    expect(fila({ connectedBy: { userId: "u2", name: "Andrés Pardo", email: "a@x.co", at } }).conectadaPor).toEqual({ quien: "Andrés Pardo", en: at });
    expect(fila({ connectedBy: { userId: "u2", name: "  ", email: "a@x.co", at } }).conectadaPor).toEqual({ quien: "a@x.co", en: at });
    expect(fila({ connectedBy: { userId: "u3", name: null, email: null, at } }).conectadaPor).toEqual({ quien: MESSAGES.tabla.alguienDelEquipo, en: at });
  });

  it("la conectó el titular: nada (la ausencia es la información) y el userId no baja a la pantalla", () => {
    expect(fila().conectadaPor).toBeNull();
    expect(JSON.stringify(fila({ connectedBy: { userId: "u-secreto", name: "Ana", email: null, at } }))).not.toContain("u-secreto");
  });
});

describe("costura CON-7: qué dato falta y por qué", () => {
  it("cada hueco dice el grupo en palabras y el porqué TAL CUAL viene de metric_requirement", () => {
    const porQue = "TikTok solo entrega la audiencia a la cuenta autorizada y con permiso de analítica.";
    const [h] = huecosDeCuenta(fila({ gaps: [{ metricGroup: "demografia_de_cuenta", requirementId: "tt.audience.auth", messageEs: porQue, fixUrl: null, since: "2026-09-20" }] }));
    expect(h).toEqual({ grupo: "demografia_de_cuenta", que: "Falta la audiencia de la cuenta", porQue, desde: "2026-09-20", arreglo: null });
  });

  it("un grupo que la pantalla no conoce no se calla: se nombra genérico", () => {
    const [h] = huecosDeCuenta(fila({ gaps: [{ metricGroup: "otro_grupo", requirementId: "x", messageEs: "m", fixUrl: null, since: "2026-09-20" }] }));
    expect(h!.que).toBe(`Falta ${MESSAGES.tabla.grupoDesconocido}`);
  });

  it("solo un enlace https se pinta como «Cómo arreglarlo»", () => {
    const g = (fixUrl: string) => huecosDeCuenta(fila({ gaps: [{ metricGroup: "demografia_de_cuenta", requirementId: "x", messageEs: "m", fixUrl, since: "2026-09-20" }] }))[0]!.arreglo;
    expect(g("https://support.tiktok.com/x")).toBe("https://support.tiktok.com/x");
    expect(g("javascript:alert(1)")).toBeNull();
    expect(g("http://inseguro.example")).toBeNull();
  });

  it("los grupos del catálogo tienen nombre, y el grupo es la clave de cada hueco", () => {
    const grupos = ["alcance_y_retencion", "clics_de_contacto", "visitas_al_perfil", "demografia_de_cuenta", "retencion_y_audiencia"];
    const hs = huecosDeCuenta(fila({ gaps: grupos.map((metricGroup) => ({ metricGroup, requirementId: "x", messageEs: "m", fixUrl: null, since: "2026-09-20" })) }));
    expect(hs.every((h) => !h.que.includes(MESSAGES.tabla.grupoDesconocido))).toBe(true);
    expect(new Set(hs.map((h) => h.grupo)).size).toBe(grupos.length);
  });

  it("sin huecos, nada", () => {
    expect(huecosDeCuenta(fila())).toEqual([]);
  });
});

describe("costura CON-5: las publicaciones que seguimos pasan a la fila", () => {
  it("postsCount y la última lectura de contenido llegan tal cual", () => {
    const r = fila({ postsCount: 12, lastPostSnapshotAt: "2026-09-23T05:00:00.000Z" });
    expect(r.postsCount).toBe(12);
    expect(r.lastPostSnapshotAt).toBe("2026-09-23T05:00:00.000Z");
  });
});
