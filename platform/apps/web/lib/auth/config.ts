/**
 * De dónde salen las llaves de Supabase Auth, y qué pasa si no están.
 *
 * El vault del repositorio (make db.unlock) escribe SUPABASE_URL y
 * SUPABASE_ANON_KEY en platform/.env.local. El navegador necesita esas
 * dos con el prefijo NEXT_PUBLIC_, así que next.config.ts las copia con
 * ese nombre en tiempo de compilación: NO hay que tocar el vault ni
 * pedirle a nadie una variable nueva. Aquí se leen los dos nombres —el
 * público primero— porque en el servidor el original sigue existiendo
 * aunque la compilación no haya inlineado nada.
 *
 * La clave anónima NO es un secreto: viaja al navegador por diseño y lo
 * que puede hacer lo decide la RLS de Supabase. La de servicio
 * (SUPABASE_SERVICE_ROLE_KEY) no se usa en la web, ni aquí ni en
 * ningún otro archivo.
 *
 * Sin las dos, la aplicación NO se cae: entra en modo demo (el mismo de
 * `DATABASE_URL` vacía), /login lo dice con todas sus letras y el resto
 * sigue sirviendo el workspace de DEMO_WORKSPACE_ID. Es lo que permite
 * que `pnpm verificar` y las pruebas corran sin red y sin llaves.
 */
export interface AuthConfig {
  url: string;
  anonKey: string;
}

export type Env = Readonly<Record<string, string | undefined>>;

/** Las variables que hacen falta, con el nombre que se le pide a la persona. */
export const VARIABLES_AUTH = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"] as const;

/**
 * Las dos públicas, leídas con acceso ESTÁTICO.
 *
 * Next sustituye en el bundle las apariciones literales de
 * `process.env.NEXT_PUBLIC_X`; un acceso por índice (`env[nombre]`) no
 * se sustituye nunca, así que `env` podría venir vacío —o `process.env`
 * ni existir— en el navegador y en el runtime Edge. Lo comprobamos tras
 * `next build` con las llaves puestas: NEXT_PUBLIC_SUPABASE_URL no
 * aparecía en `.next/static/chunks/*.js`. Hoy no rompe nada porque todo
 * el flujo de sesión corre en el servidor, pero la primera persona que
 * añada un cliente de navegador leería cadenas vacías y el fallo sería
 * mudo.
 *
 * El nombre sin prefijo (el que escribe `make db.unlock`) se sigue
 * leyendo por índice a propósito: esa solo existe en el servidor, donde
 * `process.env` es el de verdad y no hace falta sustituir nada.
 */
const PUBLICAS = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "",
} as const;

type NombrePublico = keyof typeof PUBLICAS;

function leer(env: Env, publico: NombrePublico, propio: string): string {
  const de = (nombre: string) => env[nombre]?.trim() ?? "";
  // La constante estática solo cuenta cuando el entorno es el del
  // proceso: una prueba que pasa su propio objeto describe un entorno
  // completo y no debe heredar lo que tenga la máquina.
  const estatico = env === process.env ? PUBLICAS[publico].trim() : "";
  return de(publico) || estatico || de(propio);
}

/** La configuración, o null si falta alguna de las dos. Nunca lanza. */
export function authConfig(env: Env = process.env): AuthConfig | null {
  const url = leer(env, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL");
  const anonKey = leer(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY");
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/** ¿Hay con qué autenticar? Si no, la web va en modo demo. */
export function isAuthConfigured(env: Env = process.env): boolean {
  return authConfig(env) !== null;
}

/** Cuáles faltan, para decirlo en la pantalla en vez de fallar en blanco. */
export function faltantesAuth(env: Env = process.env): string[] {
  const faltan: string[] = [];
  if (!leer(env, "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL")) faltan.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!leer(env, "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY")) faltan.push("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  return faltan;
}

/** La configuración o un error con el comando exacto que la consigue. */
export function requireAuthConfig(env: Env = process.env): AuthConfig {
  const config = authConfig(env);
  if (!config) {
    throw new Error(
      `Falta ${faltantesAuth(env).join(" y ")}. Las llaves vienen del vault: corre \`make db.unlock\` en platform/ ` +
        "(escribe .env.local) y vuelve a arrancar. En Vercel se fijan con " +
        '`make vercel.run ARGS="env add SUPABASE_URL production"` y su anon key.',
    );
  }
  return config;
}
