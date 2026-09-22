import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "@/lib/auth/config";
import { esRutaPublica } from "@/lib/auth/rutas";

/**
 * Dos trabajos, en este orden:
 *
 *   1. Refrescar la sesión. Las cookies de Supabase caducan y solo se
 *      renuevan si alguien las pide; un Server Component NO puede
 *      escribir cookies, así que si no se hace aquí, la sesión se cae
 *      sola a la hora y la persona vuelve a /login sin motivo. Por eso
 *      el middleware llama a `getUser()` aunque la ruta sea pública: la
 *      llamada es la que renueva.
 *
 *   2. Proteger la aplicación. Todo pide sesión salvo lo que
 *      lib/auth/rutas.ts declara público. Sin sesión se va a /login con
 *      `next=` para volver a donde se iba.
 *
 * Cuidado con la respuesta: hay que devolver la MISMA que recibió las
 * cookies de `setAll`, o el navegador se queda con las viejas y la
 * sesión se pierde en la siguiente petición. Por eso `supabaseResponse`
 * se construye una vez y se reutiliza.
 *
 * Sin llaves de Supabase (una copia en modo demo) el middleware no hace
 * nada: no hay sesión que refrescar ni a dónde mandar a nadie.
 */
export async function middleware(request: NextRequest) {
  const config = authConfig();
  if (!config) return NextResponse.next({ request });

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (nuevas) => {
        for (const { name, value } of nuevas) request.cookies.set(name, value);
        supabaseResponse = NextResponse.next({ request });
        for (const { name, value, options } of nuevas) supabaseResponse.cookies.set(name, value, options);
      },
    },
  });

  // Entre createServerClient y getUser no va NADA: cualquier await por
  // medio puede hacer que la sesión se cierre sola de forma aleatoria.
  const { data } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;
  if (!data.user && !esRutaPublica(pathname)) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(login);
  }

  return supabaseResponse;
}

export const config = {
  /**
   * Todo menos los archivos estáticos y las imágenes: pasar por aquí
   * un .png no refresca ninguna sesión y sí cuesta una llamada.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|txt|xml|woff2?)$).*)"],
};
