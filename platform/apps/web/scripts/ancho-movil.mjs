#!/usr/bin/env node
/**
 * ¿Alguna pantalla desborda a 400 px? La regla del producto es «móvil a
 * 400 px sin scroll horizontal», y jsdom no mide cajas: esto abre un
 * Chrome sin ventana, carga cada ruta al ancho pedido y compara
 * `scrollWidth` con `clientWidth` del documento. Si alguna desborda,
 * dice cuál y con qué elementos, y sale con 1.
 *
 * No hay dependencias: habla con Chrome por el protocolo de DevTools
 * con el WebSocket de Node. Necesita la web corriendo:
 *
 *   pnpm --filter @mc/web dev --port 3457
 *   node apps/web/scripts/ancho-movil.mjs http://localhost:3457 /cotizar /cotizar/cotizaciones
 *
 * ANCHO=360 cambia el ancho. CHROME=/ruta/al/binario si no está en el
 * sitio de macOS.
 *
 * DENTRO='<selector CSS>' añade una segunda comprobación: cada elemento
 * que case tiene que quedar dentro de la pantalla SIN desplazar nada
 * (ni la página ni la caja con scroll de una tabla). Nació en COT-1
 * (ronda 4): «Cómo se calcula» estaba en la última columna del
 * tarifario, en x≈614 de 400, y solo aparecía si alguien descubría el
 * scroll de la tabla.
 *
 *   DENTRO='[data-acciones-fila] button' node apps/web/scripts/ancho-movil.mjs http://localhost:3457 /cotizar
 *
 * Nació en COT-1 (ronda 2): un `sr-only` es `position: absolute`, y sin
 * un ancestro posicionado dentro de la tabla escapa del scroll de
 * DataTable y ensancha la página entera.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [base, ...rutas] = process.argv.slice(2);
if (!base || rutas.length === 0) {
  console.error('Uso: node apps/web/scripts/ancho-movil.mjs <URL base> <ruta> [<ruta>…]');
  process.exit(2);
}
const ANCHO = Number(process.env.ANCHO ?? 400);
const DENTRO = process.env.DENTRO ?? '';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PUERTO = 9300 + Math.floor(Math.random() * 500);
const perfil = mkdtempSync(join(tmpdir(), 'ancho-movil-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PUERTO}`, `--user-data-dir=${perfil}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
], { stdio: 'ignore' });

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
let malas = 0;
try {
  for (let i = 0; i < 50; i++) {
    try { await (await fetch(`http://127.0.0.1:${PUERTO}/json/version`)).json(); break; } catch { await esperar(200); }
  }
  const pestaña = await (await fetch(`http://127.0.0.1:${PUERTO}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(pestaña.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let n = 0;
  const pendientes = new Map();
  const oyentes = new Set();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pendientes.has(m.id)) { pendientes.get(m.id)(m); pendientes.delete(m.id); }
    for (const o of oyentes) o(m);
  });
  const enviar = (method, params = {}) => new Promise((r) => { const id = ++n; pendientes.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  await enviar('Page.enable');
  await enviar('Emulation.setDeviceMetricsOverride', { width: ANCHO, height: 900, deviceScaleFactor: 1, mobile: true });

  for (const ruta of rutas) {
    const cargada = new Promise((r) => { const o = (m) => { if (m.method === 'Page.loadEventFired') { oyentes.delete(o); r(); } }; oyentes.add(o); });
    await enviar('Page.navigate', { url: new URL(ruta, base).toString() });
    await Promise.race([cargada, esperar(60_000)]);
    await esperar(1500); // hidratación
    const { result } = await enviar('Runtime.evaluate', {
      returnByValue: true,
      expression: `(() => {
        const cw = document.documentElement.clientWidth, sw = document.documentElement.scrollWidth;
        const sel = ${JSON.stringify(DENTRO)};
        const casan = sel ? [...document.querySelectorAll(sel)] : [];
        const afuera = casan
          .filter((e) => { const r = e.getBoundingClientRect(); return r.left < 0 || r.right > cw + 1; })
          .slice(0, 5)
          .map((e) => (e.textContent || e.tagName).trim().slice(0, 40) + ' @' + Math.round(e.getBoundingClientRect().right));
        const fuera = [...document.querySelectorAll('body *')]
          .filter((e) => e.getBoundingClientRect().right > cw + 1)
          .filter((e) => !e.parentElement || e.parentElement.getBoundingClientRect().right <= cw + 1)
          .slice(0, 5)
          .map((e) => e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).trim().split(/\\s+/).slice(0, 4).join('.') : ''));
        return { cw, sw, fuera, dentro: casan.length, afuera };
      })()`,
    });
    const { cw, sw, fuera, dentro, afuera } = result.result.value;
    const ok = sw <= cw;
    if (!ok) malas++;
    console.log(`${ok ? '✓' : '✗'} ${ruta}  ${sw} px de ${cw}${ok ? '' : `  · empieza en: ${fuera.join(', ')}`}`);
    if (DENTRO) {
      // Que el selector no case con nada también es un fallo: la prueba no probaría nada.
      const bien = dentro > 0 && afuera.length === 0;
      if (!bien) malas++;
      console.log(
        `${bien ? '✓' : '✗'} ${ruta}  ${dentro} × «${DENTRO}» ${bien ? 'dentro de la pantalla' : dentro === 0 ? 'no aparece' : `fuera: ${afuera.join(', ')}`}`,
      );
    }
  }
  ws.close();
} finally {
  const cerrado = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await Promise.race([cerrado, esperar(5000)]);
  try {
    rmSync(perfil, { recursive: true, force: true });
  } catch {
    // Chrome a veces suelta el perfil tarde; es un directorio temporal.
  }
}
process.exit(malas > 0 ? 1 : 0);
