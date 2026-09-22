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
};

export default nextConfig;
