import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "@/lib/auth/config";
import { COOKIE_SESION, hayCookieDeSesion } from "@/lib/auth/cookies";
import { destinoSeguro, esRutaPublica } from "@/lib/auth/rutas";
import {
  CABECERA_SESION, codificarSesion, esFalloDelProveedor, SESION_NO_VERIFICADA, sesionDeUsuario, type Sesion,
} from "@/lib/auth/sesion-base";

/**
 * Tres trabajos, en este orden:
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
 *   2. Contarle al resto de la aplicación quién es (ronda 4). El usuario
 *      que devuelve `getUser()` ya está verificado por Supabase; se deja
 *      en la cabecera interna CABECERA_SESION y lib/auth/session.ts la
 *      lee en vez de volver a preguntar. Antes eran dos llamadas a
 *      Supabase Auth por petición. La cabecera que traiga el navegador
 *      se BORRA siempre, en todos los caminos de este archivo (ver
 *      `peticionLimpia`).
 *
 *   3. Proteger la aplicación. Todo pide sesión salvo lo que
 *      lib/auth/rutas.ts declara público. Sin sesión se va a /login con
 *      `next=` para volver a donde se iba. Y al revés: quien YA tiene
 *      sesión y abre /login va directo a su destino con un 307 de
 *      verdad (antes lo hacía la página, detrás de su loading.tsx, y
 *      salía un 200 con un meta refresh y un segundo de pantalla de
 *      carga).
 *
 * Si Supabase no contesta (red, 5xx, 429), NO se trata como «sin
 * sesión» (ronda 4): antes una caída del proveedor mandaba a /login a
 * quien sí tenía sesión, y el POST de una server action —crear una
 * factura— se perdía en un 307. Ahora la petición sigue con la cabecera
 * en «fallo»; getSesion lanza y la pantalla cae en su error.tsx con
 * «Reintentar», que es lo que promete el README.
 *
 * Cuidado con la respuesta: hay que devolver una que lleve las cookies
 * que `setAll` escribió, o el navegador se queda con las viejas y la
 * sesión se pierde en la siguiente petición. Por eso todas las salidas
 * de abajo copian las cookies de `refrescadas` —también la redirección
 * a /login: cuando `getUser()` falla porque el refresh token caducó,
 * @supabase/ssr BORRA las cookies por `setAll`, y ese borrado se perdía
 * justo en el camino que lo necesita.
 *
 * `cookieOptions` va aquí igual que en lib/auth/supabase.ts: los dos
 * clientes escriben la misma cookie y tienen que escribirla con los
 * mismos permisos (httpOnly y Secure; ver lib/auth/cookies.ts).
 *
 * Sin llaves de Supabase (una copia en modo demo) el middleware no
 * pregunta nada: no hay sesión que refrescar ni a dónde mandar a nadie.
 *
 * Lo que este middleware NO hace, y por qué: resolver el workspace y
 * sellar la cookie `mc.workspace`. Corre en el runtime Edge, donde no
 * hay Postgres ni `node:crypto`, y pasarlo al runtime de Node pondría
 * un pool de `pg` delante de TODAS las peticiones. No hace falta: quién
 * eres se resuelve siempre desde el correo verificado
 * (lib/workspace/current.ts), y la cookie es una preferencia, no un
 * atajo de rendimiento.
 */
export async function middleware(request: NextRequest) {
  const config = authConfig();
  if (!config) return seguir(request, null);

  const { pathname, search } = request.nextUrl;
  if (esRutaPublica(pathname) && !hayCookieDeSesion(request.cookies.getAll())) {
    return seguir(request, null);
  }

  // Las cookies que Supabase renueve en esta petición: van a la petición
  // (para que las lea quien pinta) y a la respuesta (para el navegador).
  let refrescadas: { name: string; value: string; options: CookieOptions }[] = [];

  const supabase = createServerClient(config.url, config.anonKey, {
    cookieOptions: COOKIE_SESION,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (nuevas) => {
        for (const { name, value } of nuevas) request.cookies.set(name, value);
        refrescadas = nuevas;
      },
    },
  });

  // Entre createServerClient y getUser no va NADA: cualquier await por
  // medio puede hacer que la sesión se cierre sola de forma aleatoria.
  const { data, error } = await supabase.auth.getUser();

  const conCookies = (respuesta: NextResponse) => {
    for (const { name, value, options } of refrescadas) respuesta.cookies.set(name, value, options);
    return respuesta;
  };

  if (error && esFalloDelProveedor(error)) {
    // No sabemos quién es: ni «sin sesión» ni «con sesión». Sigue, y
    // quien necesite la sesión lanza hacia su error.tsx.
    return conCookies(seguir(request, SESION_NO_VERIFICADA));
  }

  // Un usuario con el correo sin verificar no cuenta como sesión
  // (`sesionDeUsuario`): el correo verificado es toda la frontera entre
  // inquilinos.
  const sesion = error ? null : sesionDeUsuario(data.user);

  if (!sesion && !esRutaPublica(pathname)) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
    return conCookies(NextResponse.redirect(login));
  }

  if (sesion && esEntradaSinMotivo(request)) {
    const destino = new URL(destinoSeguro(request.nextUrl.searchParams.get("next")), request.nextUrl.origin);
    return conCookies(NextResponse.redirect(destino));
  }

  return conCookies(seguir(request, sesion));
}

/**
 * ¿Es /login abierta por quien ya tiene sesión, sin nada que enseñarle?
 * Solo GET/HEAD (el POST de /login es la server action que manda el
 * enlace) y solo sin `?error=`: /auth/callback cierra la sesión antes
 * de mandar un error, pero si alguna vez no pudiera, el mensaje tiene
 * que verse igual.
 */
function esEntradaSinMotivo(request: NextRequest): boolean {
  const { pathname, searchParams } = request.nextUrl;
  const ruta = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
  return ruta === "/login" && (request.method === "GET" || request.method === "HEAD") && !searchParams.has("error");
}

/**
 * Las cabeceras de la petición SIN la de sesión que pudiera traer el
 * navegador. Es la mitad que hace segura la cabecera: la otra es que
 * `NextResponse.next({ request: { headers } })` sustituye las cabeceras
 * que ve la aplicación por estas.
 */
function peticionLimpia(request: NextRequest): Headers {
  const cabeceras = new Headers(request.headers);
  cabeceras.delete(CABECERA_SESION);
  return cabeceras;
}

/** Deja pasar la petición, con la sesión verificada (o su ausencia) en la cabecera interna. */
function seguir(request: NextRequest, sesion: Sesion | typeof SESION_NO_VERIFICADA | null): NextResponse {
  const cabeceras = peticionLimpia(request);
  if (sesion === SESION_NO_VERIFICADA) cabeceras.set(CABECERA_SESION, SESION_NO_VERIFICADA);
  else if (sesion) cabeceras.set(CABECERA_SESION, codificarSesion(sesion));
  return NextResponse.next({ request: { headers: cabeceras } });
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
