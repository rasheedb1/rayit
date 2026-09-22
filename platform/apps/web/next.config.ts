import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Los paquetes del monorepo se importan como TypeScript sin compilar.
  transpilePackages: ["@mc/core", "@mc/db"],
  // Drivers de base de datos: se cargan en tiempo de ejecución, no se
  // empaquetan (pg usa módulos nativos opcionales; PGlite carga WASM).
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
};

export default nextConfig;
