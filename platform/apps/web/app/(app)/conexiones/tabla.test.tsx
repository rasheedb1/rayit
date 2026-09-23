import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AccountRow } from "@mc/db";
import { formatterFor } from "@/lib/format";
import { filaDeCuenta, type FilaDeCuenta } from "./_lib/estado";
import type { EntornoDeConexion } from "./_lib/entorno";
import { MESSAGES } from "./_lib/messages";
import { TablaDeCuentas } from "./tabla";

/**
 * CON-4 · lo que se ve en la tabla, sin base y sin red. La prueba de
 * página (pagina.test.tsx) recorre el camino real contra Postgres
 * embebido; esta fija las ramas del JSX una por una, incluida la que
 * hay HOY en producción: la bandera `oauth_connect` apagada.
 */

const AHORA = new Date("2026-09-23T12:00:00Z");
const f = formatterFor({ locale: "es-CO", currency: "COP", timezone: "UTC" });

const CONFIGURADO: EntornoDeConexion = {
  oauthConnect: true,
  apps: { tiktok: { configurada: true, faltan: [] }, instagram: { configurada: true, faltan: [] } },
};
const APAGADO: EntornoDeConexion = { oauthConnect: false, apps: {} };
const SIN_CREDENCIALES: EntornoDeConexion = {
  oauthConnect: true,
  apps: { tiktok: { configurada: false, faltan: ["TIKTOK_LOGIN_CLIENT_KEY"] }, instagram: { configurada: false, faltan: ["META_APP_ID"] } },
};

function fila(over: Partial<AccountRow> & { id: string }): FilaDeCuenta {
  return filaDeCuenta({
    platformId: "tiktok",
    externalAccountId: "open_id_1",
    handle: "cafealma",
    displayName: "Café Alma",
    avatarUrl: null,
    profileUrl: null,
    accountType: "creator",
    status: "active",
    statusDetail: null,
    secretRef: "enc:tiktok:00000000-0000-4000-8000-00000000abcd",
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
  });
}

const VENCIDA = fila({ id: "1", handle: "cafealma.tienda", accessExpiresAt: "2026-09-23T10:00:00.000Z" });
const POR_ARROBA = fila({
  id: "2",
  handle: "cafealma.recetas",
  accessMode: "public_profile",
  secretRef: "public:tiktok:cafealma.recetas",
  accessExpiresAt: null,
  hoursSinceSync: null,
  lastSyncedAt: null,
});

function pintar(rows: FilaDeCuenta[], entorno: EntornoDeConexion) {
  render(<TablaDeCuentas rows={rows} ahora={AHORA} f={f} entorno={entorno} />);
}

/** La celda de una fila por el nombre de la cuenta. */
function celdas(nombreDeCuenta: string) {
  const celda = screen.getByText(nombreDeCuenta);
  const tr = celda.closest("tr");
  if (!tr) throw new Error(`La fila de ${nombreDeCuenta} no está en la tabla`);
  return within(tr);
}

describe("la tabla con oauth_connect encendida", () => {
  it("el token vencido se ve «Vencida» y ofrece reautorizar, aunque status siga en 'active'", () => {
    pintar([VENCIDA], CONFIGURADO);
    const r = celdas("@cafealma.tienda");
    expect(r.getByText(MESSAGES.tabla.estado.vencida)).toBeInTheDocument();
    expect(r.getByRole("button", { name: MESSAGES.conectar.reautorizarAria("@cafealma.tienda") })).toBeEnabled();
    // Reautorizar sustituye a «Actualizar»: volver a leer con un token muerto no lleva a nada.
    expect(r.queryByRole("button", { name: MESSAGES.tabla.actualizarAria("@cafealma.tienda") })).not.toBeInTheDocument();
  });

  it("«Reautorizar» va al mismo POST …/start de CON-3, con su diálogo de consentimiento", () => {
    pintar([VENCIDA], CONFIGURADO);
    const dialogo = document.querySelector("dialog form");
    expect(dialogo).toHaveAttribute("action", "/conexiones/oauth/tiktok/start");
    expect(dialogo).toHaveAttribute("method", "post");
    expect(screen.getByText(MESSAGES.conectar.reautorizarTitulo("TikTok"))).toBeInTheDocument();
  });

  it("sin la app configurada no se ofrece un botón muerto: la fila dice qué hacer, y no nombra variables de servidor", () => {
    pintar([VENCIDA], SIN_CREDENCIALES);
    const r = celdas("@cafealma.tienda");
    expect(r.queryByRole("button", { name: MESSAGES.conectar.reautorizarAria("@cafealma.tienda") })).not.toBeInTheDocument();
    expect(r.getByText(MESSAGES.tabla.sinReautorizar)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("TIKTOK_LOGIN_CLIENT_KEY");
  });

  it("una cuenta de TikTok por @ tampoco ofrece «Autorizar cifras» si la app no está configurada", () => {
    pintar([POR_ARROBA], SIN_CREDENCIALES);
    expect(screen.queryByRole("button", { name: MESSAGES.tabla.autorizarCifrasAria("@cafealma.recetas") })).not.toBeInTheDocument();
    expect(celdas("@cafealma.recetas").getByText(MESSAGES.tabla.sinCifrasPorArroba)).toBeInTheDocument();
  });

  it("una cuenta por @ y una autorizada de la misma red se distinguen leyendo, no por el color", () => {
    pintar([VENCIDA, POR_ARROBA], CONFIGURADO);
    expect(celdas("@cafealma.tienda").getByText(MESSAGES.tabla.acceso.autorizada)).toBeInTheDocument();
    expect(celdas("@cafealma.recetas").getByText(MESSAGES.tabla.acceso.porArroba)).toBeInTheDocument();
    expect(celdas("@cafealma.recetas").getByTitle(MESSAGES.tabla.acceso.porArrobaExplicacion)).toBeInTheDocument();
  });

  it("la cuenta por @ no ofrece reautorizar —no tiene permiso que caduque— y sí «Autorizar cifras» en TikTok", () => {
    pintar([POR_ARROBA], CONFIGURADO);
    const r = celdas("@cafealma.recetas");
    expect(r.queryByRole("button", { name: MESSAGES.conectar.reautorizarAria("@cafealma.recetas") })).not.toBeInTheDocument();
    expect(r.getByRole("button", { name: MESSAGES.tabla.autorizarCifrasAria("@cafealma.recetas") })).toBeInTheDocument();
  });

  it("sin lectura, una frase; nunca un guion ni un cero", () => {
    pintar([POR_ARROBA], CONFIGURADO);
    expect(celdas("@cafealma.recetas").getByText(MESSAGES.tabla.frescura.sinLectura)).toBeInTheDocument();
    expect(celdas("@cafealma.recetas").queryByText("0")).not.toBeInTheDocument();
    expect(celdas("@cafealma.recetas").getAllByText(MESSAGES.tabla.sinDato).length).toBeGreaterThan(0);
  });

  it("ni la ref del secreto ni los scopes se escriben en la fila", () => {
    pintar([VENCIDA, POR_ARROBA], CONFIGURADO);
    expect(document.body.innerHTML).not.toContain("enc:tiktok:");
    expect(document.body.innerHTML).not.toContain("public:tiktok:");
    expect(document.body.innerHTML).not.toContain("user.info.basic");
  });

  it("la variación de siete días se escribe, no se calcula: viene ya hecha de la base", () => {
    pintar([fila({ id: "3", latest: { day: "2026-09-23", followers: 1200, following: null, mediaCount: 30, views: null }, followersDelta7d: 0.05 })], CONFIGURADO);
    expect(screen.getByText(MESSAGES.tabla.delta(f.delta(0.05)))).toBeInTheDocument();
  });

  it("la fecha del snapshot es una columna `date`: no se corre un día en un workspace al oeste de Greenwich", () => {
    const bogota = formatterFor({ locale: "es-CO", currency: "COP", timezone: "America/Bogota" });
    const latest = { day: "2026-09-21", followers: 4210, following: null, mediaCount: 41, views: null };
    render(<TablaDeCuentas rows={[fila({ id: "6", latest })]} ahora={AHORA} f={bogota} entorno={CONFIGURADO} />);
    expect(screen.getByText("21 sep")).toBeInTheDocument();
    expect(screen.queryByText("20 sep")).not.toBeInTheDocument();
    expect(document.querySelector("time")).toHaveAttribute("dateTime", "2026-09-21");
  });

  it("una cuenta que esta pantalla no sabe releer no enseña «Actualizar»", () => {
    const portafolio = fila({ id: "7", platformId: "facebook", handle: "lauracocinafacil", accessMode: "business_portfolio" });
    pintar([portafolio], CONFIGURADO);
    const r = celdas("@lauracocinafacil");
    expect(r.queryByRole("button", { name: MESSAGES.tabla.actualizarAria("@lauracocinafacil") })).not.toBeInTheDocument();
    expect(r.getByRole("button", { name: MESSAGES.tabla.quitarAria("@lauracocinafacil") })).toBeInTheDocument();
  });

  it("«no cambió» es un dato: una variación de cero se escribe, no se esconde como si faltara", () => {
    const latest = { day: "2026-09-23", followers: 21000, following: null, mediaCount: 559, views: null };
    pintar([fila({ id: "4", latest, followersDelta7d: 0 })], CONFIGURADO);
    expect(screen.getByText(MESSAGES.tabla.delta(f.delta(0)))).toBeInTheDocument();
  });

  it("sin historia de hace siete días no se inventa un 0 %: no hay línea de variación", () => {
    const latest = { day: "2026-09-23", followers: 21000, following: null, mediaCount: 559, views: null };
    pintar([fila({ id: "5", latest, followersDelta7d: null })], CONFIGURADO);
    expect(screen.queryByText(MESSAGES.tabla.delta(f.delta(0)))).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("en 7 días");
  });
});

describe("la tabla con oauth_connect apagada (lo que hay hoy en producción)", () => {
  it("no hay ningún botón de OAuth, pero el estado sigue diciendo la verdad", () => {
    pintar([VENCIDA, POR_ARROBA], APAGADO);
    expect(screen.getByText(MESSAGES.tabla.estado.vencida)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: MESSAGES.conectar.reautorizarAria("@cafealma.tienda") })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: MESSAGES.tabla.autorizarCifrasAria("@cafealma.recetas") })).not.toBeInTheDocument();
    // Y «Quitar» sigue ahí: una cuenta rota se puede retirar sin la bandera.
    expect(screen.getByRole("button", { name: MESSAGES.tabla.quitarAria("@cafealma.tienda") })).toBeInTheDocument();
  });

  it("la fila vencida no se queda sin salida: dice qué hacer en su lugar", () => {
    pintar([VENCIDA], APAGADO);
    expect(celdas("@cafealma.tienda").getByText(MESSAGES.tabla.sinReautorizar)).toBeInTheDocument();
  });
});

describe("una red que todavía no tiene app de OAuth (YouTube, CON-8)", () => {
  it("con el token vencido dice qué hacer en vez de ofrecer un botón que no existe", () => {
    const youtube = fila({ id: "9", platformId: "youtube", handle: "LauraPostres", accessExpiresAt: "2026-09-22T00:00:00.000Z" });
    pintar([youtube], CONFIGURADO);
    const r = celdas("@LauraPostres");
    expect(r.getByText(MESSAGES.tabla.estado.vencida)).toBeInTheDocument();
    expect(r.getByText(MESSAGES.tabla.sinReautorizar)).toBeInTheDocument();
    expect(r.queryByRole("button", { name: MESSAGES.conectar.reautorizarAria("@LauraPostres") })).not.toBeInTheDocument();
  });
});
