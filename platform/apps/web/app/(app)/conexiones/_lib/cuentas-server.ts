import "server-only";
import { createCuentasService, type CuentasService } from "./cuentas-service";
import { withWorkspace } from "./db";

declare global {
  var __mcCuentas: CuentasService | undefined;
}

export function getCuentasService(): CuentasService {
  if (!globalThis.__mcCuentas) globalThis.__mcCuentas = createCuentasService({ env: process.env, withWorkspace });
  return globalThis.__mcCuentas;
}
