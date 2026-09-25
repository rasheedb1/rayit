// @vitest-environment node
/**
 * La prueba de un aviso de proveedor no se fabrica fuera de
 * lib/db/aviso-de-proveedor.ts (VEN-9, ronda 2):
 *
 *   · en tipos: un literal { workspaceId, verifiedBy } no compila (las
 *     líneas con @ts-expect-error fallan en `tsc` si algún día compilan);
 *   · en ejecución: un objeto forzado con `as` lanza en proofWorkspace, que
 *     es lo que usa withProviderCallback antes de abrir la transacción;
 *   · solo las dos verificaciones la emiten, y solo con una firma buena,
 *     con cualquier versión del llavero de TOKEN_ENCRYPTION_KEY.
 */
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { channelSigningKeys, keyringFromEnv, signChannelRoute, signChannelState, UNIPILE_STATE_TTL_MS } from "@mc/connectors";
import {
  proofWorkspace, verifyChannelRouteProof, verifyChannelStateProof, type ProviderCallbackProof,
} from "./aviso-de-proveedor";

const NOW = new Date("2026-09-24T10:00:00Z");
const WS = "00000002-0000-4000-8000-000000000001";
const CA = "00000005-0000-4000-8000-0000000ac002";
const V1 = randomBytes(32).toString("base64");
const V2 = randomBytes(32).toString("base64");
const ENV = { TOKEN_ENCRYPTION_KEY: V1 };

function takesProof(proof: ProviderCallbackProof): string {
  return proofWorkspace(proof);
}

describe("ProviderCallbackProof", () => {
  it("un literal no compila y un objeto forzado lanza: la web no abre el espacio que quiera", () => {
    // @ts-expect-error — le falta la marca que solo pone aviso-de-proveedor.ts
    expect(() => takesProof({ workspaceId: WS, verifiedBy: "channel_route" })).toThrow(/verificación de firma/);
    const forced = { workspaceId: WS, verifiedBy: "channel_state" } as unknown as ProviderCallbackProof;
    expect(() => proofWorkspace(forced)).toThrow(TypeError);
  });

  it("la ruta firmada emite la prueba de SU espacio; una inventada, nada", () => {
    const keys = channelSigningKeys(keyringFromEnv(ENV));
    const header = signChannelRoute({ workspaceId: WS, channelAccountId: CA }, keys.current.route, NOW);
    const v = verifyChannelRouteProof(header, NOW, ENV);
    expect(v?.route).toEqual({ workspaceId: WS, channelAccountId: CA });
    expect(proofWorkspace(v!.proof)).toBe(WS);
    expect(verifyChannelRouteProof("ruta-inventada", NOW, ENV)).toBeNull();
    expect(verifyChannelRouteProof(header, NOW, {})).toBeNull();
  });

  it("rotar la llave maestra no deja fuera lo firmado con la anterior", () => {
    const v1 = channelSigningKeys(keyringFromEnv(ENV));
    const header = signChannelRoute({ workspaceId: WS, channelAccountId: CA }, v1.current.route, NOW);
    const state = signChannelState({ workspaceId: WS, creatorId: WS, channel: "linkedin", nonce: "n".repeat(43) }, v1.current.state, NOW);
    const rotado = { TOKEN_ENCRYPTION_KEY: V1, TOKEN_ENCRYPTION_KEY_V2: V2, TOKEN_ENCRYPTION_KEY_CURRENT: "v2" };
    expect(verifyChannelRouteProof(header, NOW, rotado)?.route.workspaceId).toBe(WS);
    expect(verifyChannelStateProof(state, NOW, UNIPILE_STATE_TTL_MS, rotado)?.state.channel).toBe("linkedin");
    // Solo con la nueva, lo viejo ya no abre.
    expect(verifyChannelRouteProof(header, NOW, { TOKEN_ENCRYPTION_KEY_V2: V2 })).toBeNull();
  });
});
