/**
 * El 404 de dentro de la aplicación: el mismo de la raíz, pero con el
 * marco (barra lateral y navegación) puesto, porque el layout de (app)
 * lo envuelve. Sin este archivo, un `notFound()` de un módulo subiría
 * hasta la raíz —que desde CIM-3 ya no monta el marco— y aparecería
 * suelto en la página.
 */
export { default } from "../not-found";
