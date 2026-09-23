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
  experimental: {
    serverActions: {
      // La importación por CSV manda el TEXTO del archivo a la server
      // action (el servidor vuelve a validarlo, no se fía del
      // navegador). El techo del producto son 5 MB por archivo —
      // MAX_BYTES en resumen/importar/_lib/csv.ts— y Next corta el
      // cuerpo en 1 MB por defecto, así que un archivo perfectamente
      // válido moría con «Body exceeded 1 MB limit».
      //
      // 6 MB y no 5: el cuerpo lleva además el mapeo de columnas y el
      // marco de RSC. Si MAX_BYTES sube, este número sube con él.
      //
      // OJO: este techo es GLOBAL. Next no deja fijarlo por acción, así
      // que sube a 6 MB el cuerpo que aceptan TODAS las server actions
      // de la app (Finanzas, Campañas, Conexiones…), no solo la de la
      // importación. Ninguna otra recibe más que un formulario, y todas
      // validan con zod antes de tocar nada, así que hoy el riesgo es
      // solo de memoria por petición. La salida está en el backlog
      // (RES-6): mover la importación a un route handler POST con su
      // propio límite y devolver este valor al de Next (1 MB).
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
