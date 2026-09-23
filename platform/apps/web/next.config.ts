import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Los paquetes del monorepo se importan como TypeScript sin compilar.
  transpilePackages: ["@mc/connectors", "@mc/core", "@mc/db"],
  // Drivers de base de datos: se cargan en tiempo de ejecución, no se
  // empaquetan (pg usa módulos nativos opcionales; PGlite carga WASM).
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  // PGlite solo se usa sin DATABASE_URL (nunca en producción): fuera
  // del bundle. La CA de Supabase va embebida en @mc/db, no como archivo.
  outputFileTracingExcludes: { "*": ["**/@electric-sql/pglite/**"] },
  /**
   * Las llaves de Supabase Auth con el nombre que Next exige.
   *
   * El vault del repositorio las guarda como SUPABASE_URL y
   * SUPABASE_ANON_KEY (make db.unlock las escribe en
   * platform/.env.local, y en Vercel están con esos mismos nombres). En
   * vez de pedir que alguien duplique las variables —a mano, en cada
   * entorno, y con el riesgo de que una se quede vieja— se copian aquí
   * con el prefijo. La clave anónima no es un secreto: viaja al
   * navegador por diseño y lo que puede hacer lo limita la RLS de
   * Supabase. La de servicio no se copia ni se usa en la web.
   *
   * OJO con lo que este bloque SÍ y NO hace. `env:` define el valor;
   * para que llegue al navegador hace falta además que el código lo lea
   * con acceso ESTÁTICO (`process.env.NEXT_PUBLIC_…` literal), porque
   * eso es lo que Next sustituye en el bundle. Un acceso por índice no
   * se sustituye nunca. Por eso lib/auth/config.ts lee las dos públicas
   * por su nombre literal y deja el índice solo para el nombre del
   * vault, que es de servidor. (Antes este comentario prometía
   * «pueden llegar al navegador» y no era cierto: tras `next build` con
   * las llaves puestas, NEXT_PUBLIC_SUPABASE_URL no aparecía en
   * .next/static/chunks/*.js.)
   *
   * Hoy todo el flujo de sesión corre en el servidor (server actions y
   * el route handler de /auth/callback), que lee cualquiera de los dos
   * nombres; esto es lo que permitirá añadir un cliente de navegador
   * sin tocar el vault. Si falta, la web va en modo demo y /login lo
   * dice (lib/auth/config.ts).
   */
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? "",
  },
  // Sin `experimental.serverActions.bodySizeLimit` A PROPÓSITO: las
  // server actions se quedan en el 1 MB de Next. Ese techo es GLOBAL (no
  // se puede fijar por acción), y subirlo a 6 MB para que cupiera el CSV
  // de Resumen lo subía para TODAS las acciones de la app. La importación
  // va ahora por un route handler con su propio techo
  // (resumen/importar/_lib/lote.ts, RES-6), y resumen/importar/lote.test.ts
  // falla si este bloque vuelve.
};

export default nextConfig;
