/**
 * Lo que la pantalla necesita saber del entorno para ofrecer o no el
 * flujo de OAuth, SIN los valores de las credenciales.
 *
 * `loadOAuthApps(process.env)` devuelve la configuración completa de
 * cada app, `clientSecret` incluido. Ese objeto no puede viajar por el
 * árbol de render: hoy todos los componentes de esta pantalla son de
 * servidor y no se serializa nada, pero basta con que uno se vuelva de
 * cliente —un botón con estado, un diálogo con animación— para que el
 * secreto acabe en la carga que se manda al navegador. Aquí se reduce a
 * dos datos, y lo que sale del entorno es un booleano y NOMBRES de
 * variables, nunca valores (es la misma regla de `missing` en
 * packages/connectors/src/oauth/config.ts).
 */
import { loadOAuthApps, type OAuthProviderId } from "@mc/connectors";

export interface AppDeRed {
  /** true si esta máquina tiene las tres variables de esa app. */
  configurada: boolean;
  /** Los NOMBRES de las variables que faltan. Nunca sus valores. */
  faltan: readonly string[];
}

export interface EntornoDeConexion {
  /** flags.oauth_connect: sin ella no se ofrece ni conectar ni reautorizar. */
  oauthConnect: boolean;
  apps: Partial<Record<OAuthProviderId, AppDeRed>>;
}

export function entornoDeConexion(env: Readonly<Record<string, string | undefined>>, oauthConnect: boolean): EntornoDeConexion {
  const { apps, missing } = loadOAuthApps(env);
  const out: EntornoDeConexion["apps"] = {};
  for (const provider of Object.keys(missing) as OAuthProviderId[]) {
    out[provider] = { configurada: false, faltan: missing[provider] ?? [] };
  }
  for (const provider of Object.keys(apps) as OAuthProviderId[]) {
    out[provider] = { configurada: true, faltan: [] };
  }
  return { oauthConnect, apps: out };
}

/** La app de esa red, o «no configurada y no sabemos qué le falta» si la red no existe. */
export function appDeRed(entorno: EntornoDeConexion, provider: OAuthProviderId): AppDeRed {
  return entorno.apps[provider] ?? { configurada: false, faltan: [] };
}
