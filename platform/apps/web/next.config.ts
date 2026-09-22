import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Los paquetes del monorepo se importan como TypeScript sin compilar.
  transpilePackages: ["@mc/core", "@mc/db"],
  // Drivers de base de datos: se cargan en tiempo de ejecución, no se
  // empaquetan (pg usa módulos nativos opcionales; PGlite carga WASM).
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  // El rastreo de archivos de Next no ve rutas construidas con
  // import.meta.url: el certificado raíz de Supabase (db/certs) se
  // incluye a mano para que @mc/db lo encuentre en Vercel. PGlite solo
  // se usa sin DATABASE_URL (nunca en producción): fuera del bundle.
  outputFileTracingIncludes: { "/finanzas/**": ["../../db/certs/*.crt"] },
  outputFileTracingExcludes: { "*": ["**/@electric-sql/pglite/**"] },
};

export default nextConfig;
