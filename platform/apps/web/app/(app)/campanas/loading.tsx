/**
 * El esqueleto genérico de (app), que antes llegaba desde la raíz del
 * grupo y ahora cada segmento pide por su cuenta (ver
 * app/(app)/_lib/esqueleto.tsx). Montado por el pulido r4 de Ventas
 * para que este módulo conserve la señal de carga que ya tenía; el
 * dueño del módulo puede sustituirlo por uno propio.
 */
export { EsqueletoGenerico as default } from "../_lib/esqueleto";
