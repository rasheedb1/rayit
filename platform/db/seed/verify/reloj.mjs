/**
 * El reloj de la verificación: correr los seeds "como si fuera dentro
 * de N días" sin tocar los datos.
 *
 * Para probar que la demo no caduca hay que sembrar con el reloj
 * adelantado. Postgres no deja mover CURRENT_DATE desde fuera, así que
 * el harness lo hace en el texto del SQL. Hacerlo con dos `replace`
 * globales es una trampa silenciosa: `now()` y la cadena `'now()'` son
 * el mismo texto, y el día que un `notes`, un `headline_es` o un jsonb
 * del seed lleve esas palabras entre comillas, el harness cambiaría el
 * DATO en vez del reloj y la comprobación pasaría midiendo otra cosa.
 *
 * Aquí el SQL se parte antes en código, literales, comentarios e
 * identificadores entrecomillados:
 *   · código          → se desplaza;
 *   · comentario      → se deja igual (hay decenas que NOMBRAN
 *                       CURRENT_DATE al explicarse);
 *   · literal '…'     → se deja igual, y si contiene el reloj la
 *                       corrida FALLA diciendo cuál, en vez de mentir;
 *   · identificador   → se deja igual;
 *   · $$…$$           → es cuerpo de PL/pgSQL (el bloque DO de
 *                       verify/0002.sql), no un dato: se recorre por
 *                       dentro con estas mismas reglas.
 *
 * No depende de nada y no toca la base: se puede probar sola
 * (packages/core/test/seed-0002.test.ts).
 */

/** CURRENT_DATE o now() como palabra suelta. */
const RELOJ = /\bCURRENT_DATE\b|\bnow\s*\(\s*\)/i;

const MARCA_DOLAR = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Parte un SQL en trozos etiquetados. Devuelve [{ tipo, texto }] en
 * orden: concatenar los `texto` reconstruye el original exacto.
 */
export function trozos(sql) {
  const out = [];
  let i = 0;
  let ini = 0;
  const cerrar = (fin, tipo) => {
    if (fin > ini) out.push({ tipo, texto: sql.slice(ini, fin) });
    ini = fin;
  };
  while (i < sql.length) {
    const dos = sql.slice(i, i + 2);
    if (dos === '--') {
      cerrar(i, 'codigo');
      const fin = sql.indexOf('\n', i);
      i = fin === -1 ? sql.length : fin;
      cerrar(i, 'comentario');
      continue;
    }
    if (dos === '/*') {
      cerrar(i, 'codigo');
      let prof = 1;
      i += 2;
      while (i < sql.length && prof > 0) {
        if (sql.slice(i, i + 2) === '/*') { prof += 1; i += 2; }
        else if (sql.slice(i, i + 2) === '*/') { prof -= 1; i += 2; }
        else i += 1;
      }
      cerrar(i, 'comentario');
      continue;
    }
    if (sql[i] === "'" || sql[i] === '"') {
      const comilla = sql[i];
      cerrar(i, 'codigo');
      i += 1;
      while (i < sql.length) {
        if (sql[i] !== comilla) { i += 1; continue; }
        // Una comilla doblada ('' o "") es la comilla escapada.
        if (sql[i + 1] === comilla) { i += 2; continue; }
        i += 1;
        break;
      }
      cerrar(i, comilla === "'" ? 'literal' : 'identificador');
      continue;
    }
    const dolar = MARCA_DOLAR.exec(sql.slice(i));
    if (dolar) {
      cerrar(i, 'codigo');
      const marca = dolar[0];
      const fin = sql.indexOf(marca, i + marca.length);
      i = fin === -1 ? sql.length : fin + marca.length;
      cerrar(i, 'dolar');
      continue;
    }
    i += 1;
  }
  cerrar(sql.length, 'codigo');
  return out;
}

function desplazarCodigo(texto, dias) {
  return texto
    .replace(/\bCURRENT_DATE\b/g, `(CURRENT_DATE + ${dias})`)
    .replace(/\bnow\s*\(\s*\)/gi, `(now() + interval '${dias} days')`);
}

function recorrer(sql, dias, enLiterales) {
  return trozos(sql)
    .map(({ tipo, texto }) => {
      if (tipo === 'codigo') return desplazarCodigo(texto, dias);
      if (tipo === 'dolar') {
        const marca = MARCA_DOLAR.exec(texto)[0];
        const cierre = texto.endsWith(marca) && texto.length > marca.length ? marca : '';
        const cuerpo = texto.slice(marca.length, texto.length - cierre.length);
        return marca + recorrer(cuerpo, dias, enLiterales) + cierre;
      }
      if (tipo === 'literal') {
        const m = RELOJ.exec(texto);
        if (m) enLiterales.push(`${m[0]} dentro de ${texto.slice(0, 70)}`);
      }
      return texto;
    })
    .join('');
}

/**
 * Devuelve el SQL con CURRENT_DATE y now() valiendo lo que valdrán
 * dentro de `dias` días. Con `dias === 0` devuelve el original.
 *
 * Lanza si el reloj aparece dentro de un literal: ahí no se puede
 * desplazar sin cambiar el dato, y cambiar el dato en silencio es
 * peor que no poder probar nada.
 */
export function desplazarReloj(sql, dias, donde = 'sql') {
  if (dias === 0) return sql;
  const enLiterales = [];
  const texto = recorrer(sql, dias, enLiterales);
  if (enLiterales.length > 0) {
    throw new Error(
      `${donde}: el reloj aparece DENTRO de un literal y desplazarlo cambiaría el dato:\n` +
        enLiterales.map((l) => `    · ${l}`).join('\n') +
        '\n    Sácalo de las comillas (derívalo de CURRENT_DATE fuera del literal).'
    );
  }
  return texto;
}
