import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InboxConversation, InboxThread } from "@mc/db/queries/bandejas";

/**
 * Lo que decide la PÁGINA de la bandeja (VEN-14): quién la lee y qué
 * conversación abre. La vista, la lista y las acciones tienen su prueba en
 * bandeja.test.tsx; las consultas, contra Postgres embebido.
 */
const estado = vi.hoisted(() => ({
  ver: true,
  operar: true,
  hilos: [] as InboxThread[],
  abiertas: [] as string[],
  listadas: 0,
}));

vi.mock("@mc/db/queries/bandejas", async (original) => ({
  ...(await original<typeof import("@mc/db/queries/bandejas")>()),
  listInboxThreads: async () => {
    estado.listadas++;
    return estado.hilos;
  },
  loadInboxConversation: async (_tx: unknown, contactId: string, channel: InboxConversation["channel"]) => {
    estado.abiertas.push(contactId);
    return conversacion(contactId, channel);
  },
  outreachClassifierStatus: async () => "model",
}));
vi.mock("@/lib/db", () => ({ withWorkspace: (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@/lib/workspace/settings", () => ({
  getCurrentWorkspace: async () => ({ currency: "COP", locale: "es-CO", timezone: "America/Bogota" }),
}));
vi.mock("../_lib/permiso", () => ({
  puedeVerBandejas: async () => estado.ver,
  puedeOperarVentas: async () => estado.operar,
}));
vi.mock("./actions", () => ({
  responder: vi.fn(),
  marcarLeido: vi.fn(async () => undefined),
  crearReferido: vi.fn(),
  cancelarRespuesta: vi.fn(),
  descartarRespuesta: vi.fn(),
  corregirIntencion: vi.fn(),
  marcarHecho: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

import { MESSAGES } from "./messages";
import BandejaPage from "./page";

const t = MESSAGES;
const A = "00000141-0000-4000-8000-0000000000a1";
const B = "00000141-0000-4000-8000-0000000000b1";

function hilo(contactId: string, nombre: string, unread: number): InboxThread {
  return {
    contactId, channel: "email", contactName: nombre, companyId: "00000141-0000-4000-8000-0000000000c1", companyName: "Vitalé",
    lastAt: new Date("2026-09-23T20:00:00Z"), lastDirection: "inbound", lastSnippet: "Hola", unread, lastIntent: null, done: false,
  };
}

function conversacion(contactId: string, channel: InboxConversation["channel"]): InboxConversation {
  const h = estado.hilos.find((x) => x.contactId === contactId)!;
  return {
    contactId, channel, contactName: h.contactName, companyId: h.companyId, companyName: h.companyName, deal: null,
    messages: [], pending: [], notSent: [], replyToMessageId: null, accountName: null, replyBlock: null, contactOptedOut: false,
    postalAddressMissing: false, sendingOff: false, done: false, unread: h.unread, sequenceId: null,
  };
}

async function pagina(sp: Record<string, string> = {}) {
  return BandejaPage({ searchParams: Promise.resolve(sp) });
}

beforeEach(() => {
  estado.ver = true;
  estado.operar = true;
  estado.hilos = [hilo(A, "Tomás Rey", 0), hilo(B, "Felipe Mora", 1)];
  estado.abiertas = [];
  estado.listadas = 0;
});

describe("la página de la bandeja", () => {
  it("un 'client' (la marca misma, en una agencia) no lee los hilos: ni se cargan", async () => {
    estado.ver = false;
    estado.operar = false;
    render(await pagina());
    expect(screen.getByText(t.sinPermisoVer.title)).toBeInTheDocument();
    expect(estado.listadas).toBe(0);
    expect(estado.abiertas).toEqual([]);
    expect(screen.queryByText("Felipe Mora")).toBeNull();
  });

  it("un 'viewer' los lee, sin operarlos", async () => {
    estado.operar = false;
    render(await pagina());
    expect(estado.listadas).toBe(1);
    expect(screen.queryByText(t.sinPermisoVer.title)).toBeNull();
  });

  it("sin hilo en la URL abre el primero sin leer; fijado en la URL tras marcarlo leído, no salta al siguiente", async () => {
    render(await pagina());
    expect(estado.abiertas).toEqual([B]);
    // Al marcarse leída, MarcarLeido fija la URL del hilo (router.replace): el refresco la trae con B ya leído
    // y la conversación sigue siendo B, aunque otro hilo siga sin leer (A no se abre ni se marca).
    estado.hilos = [hilo(A, "Tomás Rey", 1), hilo(B, "Felipe Mora", 0)];
    estado.abiertas = [];
    render(await pagina({ contacto: B, canal: "email" }));
    expect(estado.abiertas).toEqual([B]);
  });
});
