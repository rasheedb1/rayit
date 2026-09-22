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
      bodySizeLimit: "6mb",
    },
  },
};

export default nextConfig;
