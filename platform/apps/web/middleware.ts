import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "@/lib/auth/config";
import { COOKIE_SESION, hayCookieDeSesion } from "@/lib/auth/cookies";
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
 *      Con una excepción medida: una ruta pública a la que llega una
 *      petición SIN ninguna cookie `sb-…` no tiene nada que refrescar.
 *      Son las que más se piden y las que nunca traen sesión —los
 *      webhooks de las plataformas, la cotización que abre una marca,
 *      la baja que abre un contacto— y cada una pagaba una ida y vuelta
 *      a Supabase para no hacer nada.
 *
 *   2. Proteger la aplicación. Todo pide sesión salvo lo que
 *      lib/auth/rutas.ts declara público. Sin sesión se va a /login con
 *      `next=` para volver a donde se iba.
 *
 * Cuidado con la respuesta: hay que devolver la MISMA que recibió las
 * cookies de `setAll`, o el navegador se queda con las viejas y la
 * sesión se pierde en la siguiente petición. Por eso `supabaseResponse`
 * se construye una vez y se reutiliza — y por eso la redirección a
 * /login también se lleva esas cookies encima: cuando `getUser()` falla
 * porque el refresh token caducó, @supabase/ssr BORRA las cookies por
 * `setAll`, y ese borrado se perdía justo en el camino que lo necesita.
 *
 * `cookieOptions` va aquí igual que en lib/auth/supabase.ts: los dos
 * clientes escriben la misma cookie y tienen que escribirla con los
 * mismos permisos (httpOnly y Secure; ver lib/auth/cookies.ts).
 *
 * Sin llaves de Supabase (una copia en modo demo) el middleware no hace
 * nada: no hay sesión que refrescar ni a dónde mandar a nadie.
 *
 * Lo que este middleware NO hace, y por qué: resolver el workspace y
 * sellar la cookie `mc.workspace`. Corre en el runtime Edge, donde no
 * hay Postgres ni `node:crypto`, y pasarlo al runtime de Node pondría
 * un pool de `pg` delante de TODAS las peticiones. No hace falta: desde
 * la ronda 2, el camino sin cookie cuesta exactamente lo mismo que el
 * camino con cookie —una transacción de dos SELECT— porque quién eres
 * se resuelve siempre desde el correo verificado (lib/workspace/current.ts).
 * La cookie es una preferencia, no un atajo de rendimiento.
 */
export async function middleware(request: NextRequest) {
  const config = authConfig();
  if (!config) return NextResponse.next({ request });

  const { pathname, search } = request.nextUrl;
  if (esRutaPublica(pathname) && !hayCookieDeSesion(request.cookies.getAll())) {
    return NextResponse.next({ request });
  }

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(config.url, config.anonKey, {
    cookieOptions: COOKIE_SESION,
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
  // Un usuario con el correo sin verificar no cuenta como sesión, igual
  // que en lib/auth/session.ts (`sesionDeUsuario`): el correo verificado
  // es toda la frontera entre inquilinos.
  const conSesion = Boolean(data.user?.email && data.user.email_confirmed_at);

  if (!conSesion && !esRutaPublica(pathname)) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
    const respuesta = NextResponse.redirect(login);
    // Las cookies que `setAll` acaba de escribir (normalmente el BORRADO
    // de una sesión caducada) viajan en supabaseResponse, que este
    // camino no devuelve. Sin copiarlas, el navegador se queda con la
    // cookie muerta y cada petición siguiente paga otra ida y vuelta
    // fallida a Supabase antes de acabar aquí otra vez.
    for (const cookie of supabaseResponse.cookies.getAll()) respuesta.cookies.set(cookie);
    return respuesta;
  }

  return supabaseResponse;
}

export const config = {
  /**
   * Todo menos los archivos internos de Next y los dos iconos, y SOLO
   * por prefijo de la ruta.
   *
   * Antes se excluía cualquier ruta que TERMINARA en .txt, .xml, .png,
   * .svg… y eso abría la aplicación entera: `/campanas/x.txt` no pasaba
   * por aquí, y con la cabecera Next-Action de una server action
   * ejecutaba esa acción sin sesión (ronda 3). Una extensión la elige
   * quien escribe la URL; un prefijo como `_next/static` solo lo sirve
   * Next. Hoy getCurrentContext también falla cerrado, pero el
   * middleware no debe tener agujeros por su cuenta.
   *
   * No hay carpeta `public/`. Si algún día la hay, sus archivos pasan
   * por aquí y piden sesión salvo que se declaren en lib/auth/rutas.ts;
   * una ruta pública sin cookie `sb-…` sale por la puerta rápida, sin
   * llamar a Supabase. Lo prueba middleware.test.ts.
   */
  matcher: ["/((?!_next/static/|_next/image|favicon\\.ico$|icon\\.svg$).*)"],
};
