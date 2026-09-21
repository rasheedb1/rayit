/* ---------- utilidades ---------- */
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, parent) { const n = document.createElementNS(SVG_NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); if (parent) parent.appendChild(n); return n; }
function h(tag, cls, text) { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const fmtInt = new Intl.NumberFormat('es-CO');
const fmtCompact = new Intl.NumberFormat('es', { notation: 'compact', maximumFractionDigits: 1 });
const nf = (v) => fmtCompact.format(Math.round(v));
const pct = (v, d = 0) => (v * 100).toFixed(d).replace('.', ',') + ' %';
const dec = (v, d = 1) => v.toFixed(d).replace('.', ',');
const cop = (v) => v >= 1e6 ? 'COP ' + dec(v / 1e6, 1) + ' M' : 'COP ' + fmtInt.format(Math.round(v));
const fmtDate = (d) => new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' }).format(d);
const TODAY = new Date(2026, 8, 16); const DAY = 86400000;
const daysAgo = (n) => new Date(TODAY.getTime() - n * DAY);

const NETWORKS = [
  { id: 'tiktok', name: 'TikTok', color: 'var(--s-tiktok)' },
  { id: 'instagram', name: 'Instagram', color: 'var(--s-instagram)' },
  { id: 'youtube', name: 'YouTube', color: 'var(--s-youtube)' },
  { id: 'facebook', name: 'Facebook', color: 'var(--s-facebook)' },
];
const NET = Object.fromEntries(NETWORKS.map((n) => [n.id, n]));
const FOLLOWERS_NOW = { tiktok: 214000, instagram: 128000, youtube: 49000, facebook: 21000 };

/* ---------- tooltip ---------- */
const tooltip = document.getElementById('tooltip');
function showTooltip(x, y, title, rows) {
  tooltip.textContent = '';
  tooltip.appendChild(h('div', 'tt-title', title));
  for (const r of rows) {
    const row = h('div', 'tt-row');
    if (r.color) { const k = h('span', 'tt-key'); k.style.background = r.color; row.appendChild(k); }
    row.appendChild(h('span', 'tt-val', r.value)); row.appendChild(h('span', 'tt-lbl', r.label));
    tooltip.appendChild(row);
  }
  tooltip.style.display = 'block';
  const rect = tooltip.getBoundingClientRect();
  tooltip.style.left = Math.min(x + 14, window.innerWidth - rect.width - 10) + 'px';
  tooltip.style.top = Math.max(8, y - rect.height - 12) + 'px';
}
function hideTooltip() { tooltip.style.display = 'none'; }

/* ---------- piezas reutilizables ---------- */
function niceTicks(max, n = 4) {
  if (max <= 0) return [0, 1];
  const raw = max / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const t = []; for (let v = 0; v <= max + step * 0.001; v += step) t.push(v);
  if (t[t.length - 1] < max) t.push(t[t.length - 1] + step);
  return t;
}
function legend(el, series, kind) {
  el.textContent = '';
  for (const s of series) {
    const k = h('span', 'key'); const sw = h('span', kind === 'rect' ? 'swatch-rect' : 'swatch-line'); sw.style.background = s.color;
    k.appendChild(sw); k.appendChild(document.createTextNode(s.name)); el.appendChild(k);
  }
}
function tableFrom(el, head, rows) {
  el.textContent = '';
  const table = h('table'); const thead = h('thead'); const trh = h('tr');
  head.forEach((c, i) => trh.appendChild(h('th', i ? 'num' : null, c)));
  thead.appendChild(trh); table.appendChild(thead);
  const tb = h('tbody');
  for (const r of rows) { const tr = h('tr'); r.forEach((c, i) => tr.appendChild(h('td', i ? 'num' : null, c))); tb.appendChild(tr); }
  table.appendChild(tb); el.appendChild(table);
}
function roundedTop(x, y, w, hh, r) {
  r = Math.min(r, w / 2, hh);
  return `M${x} ${y + hh} V${y + r} Q${x} ${y} ${x + r} ${y} H${x + w - r} Q${x + w} ${y} ${x + w} ${y + r} V${y + hh} Z`;
}
function sparkline(values, W = 150, H = 30) {
  const max = Math.max(...values, 1), min = Math.min(...values);
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' });
  const pts = values.map((v, i) => [4 + (i * (W - 8)) / (values.length - 1), H - 4 - ((v - min) / Math.max(1, max - min)) * (H - 9)]);
  const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  svgEl('path', { d, fill: 'none', stroke: 'var(--deemph)', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
  const seg = pts.slice(-2).map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  svgEl('path', { d: seg, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2, 'stroke-linecap': 'round' }, svg);
  const l = pts[pts.length - 1]; svgEl('circle', { cx: l[0], cy: l[1], r: 3.5, fill: 'var(--accent)', stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
  return svg;
}
function kpis(el, defs) {
  el.textContent = '';
  for (const d of defs) {
    const t = h('div', 'kpi');
    t.appendChild(h('div', 'label', d.label));
    t.appendChild(h('div', 'value', d.value));
    if (d.delta !== undefined) {
      const up = d.delta > 0.0005, down = d.delta < -0.0005;
      const e = h('div', 'delta ' + (up ? 'up' : down ? 'down' : 'flat'));
      e.appendChild(document.createTextNode((up ? '▲ ' : down ? '▼ ' : '— ') + pct(Math.abs(d.delta), 1) + ' '));
      e.appendChild(h('span', 'vs', d.vs || 'vs. 30 días antes'));
      t.appendChild(e);
    } else if (d.note) { const e = h('div', 'delta flat'); e.appendChild(h('span', 'vs', d.note)); t.appendChild(e); }
    if (d.spark) t.appendChild(sparkline(d.spark));
    el.appendChild(t);
  }
}

/* gráfico de líneas genérico */
function lineChart(box, opt) {
  const { series, labels, tableEl, tableHead, yFmt = nf, shade, aria } = opt;
  box.textContent = '';
  const W = Math.max(520, box.clientWidth || 600), H = opt.height || 260;
  const M = { t: 16, r: opt.rightPad || 92, b: 28, l: 48 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': aria || '' });
  const n = labels.length;
  const allV = series.flatMap((s) => s.data);
  const maxV = Math.max(1, ...allV); const minV = opt.fromZero === false ? Math.min(...allV) : 0;
  const ticks = niceTicks(maxV - minV).map((t) => t + minV);
  const yMax = ticks[ticks.length - 1], yMin = ticks[0];
  const x = (i) => M.l + (i * iw) / (n - 1);
  const y = (v) => M.t + ih - ((v - yMin) / (yMax - yMin)) * ih;
  if (shade) {
    svgEl('rect', { x: x(shade.from), y: M.t, width: x(shade.to) - x(shade.from), height: ih, fill: 'var(--accent-wash)' }, svg);
    svgEl('text', { x: x(shade.from) + 6, y: M.t + 12, 'font-size': 11, 'font-weight': 600, fill: 'var(--accent)' }, svg).textContent = shade.label;
  }
  for (const tv of ticks) {
    svgEl('line', { x1: M.l, x2: M.l + iw, y1: y(tv), y2: y(tv), stroke: tv === yMin ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }, svg);
    svgEl('text', { x: M.l - 8, y: y(tv) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, svg).textContent = yFmt(tv);
  }
  const nL = Math.min(6, n);
  for (let i = 0; i < nL; i++) { const idx = Math.round((i * (n - 1)) / (nL - 1)); svgEl('text', { x: x(idx), y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' }, svg).textContent = labels[idx]; }
  for (const s of series) {
    const d = s.data.map((v, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1)).join(' ');
    if (s.dashed) svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-dasharray': '4 4', 'stroke-linecap': 'round' }, svg);
    else svgEl('path', { d, fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
    svgEl('circle', { cx: x(n - 1), cy: y(s.data[n - 1]), r: 4, fill: s.color, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
  }
  const placed = [];
  for (const e of series.map((s) => ({ s, yv: y(s.data[n - 1]) })).sort((a, b) => a.yv - b.yv)) {
    if (placed.some((p) => Math.abs(p - e.yv) < 14)) continue; placed.push(e.yv);
    svgEl('text', { x: M.l + iw + 10, y: e.yv + 4, 'font-size': 11.5, 'font-weight': 600, fill: 'var(--ink-2)' }, svg).textContent = e.s.name;
  }
  const cross = svgEl('line', { y1: M.t, y2: M.t + ih, stroke: 'var(--axis)', 'stroke-width': 1, visibility: 'hidden' }, svg);
  const hot = svgEl('rect', { x: M.l, y: M.t, width: iw, height: ih, fill: 'transparent' }, svg);
  hot.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect(); const sx = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((sx - M.l) / iw) * (n - 1))));
    cross.setAttribute('x1', x(i)); cross.setAttribute('x2', x(i)); cross.setAttribute('visibility', 'visible');
    showTooltip(ev.clientX, ev.clientY, labels[i], series.map((s) => ({ color: s.color, value: (opt.ttFmt || yFmt)(s.data[i]), label: s.name })));
  });
  hot.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTooltip(); });
  box.appendChild(svg);
  if (tableEl) {
    const stride = Math.max(1, Math.floor(n / 14)); const rows = [];
    for (let i = n - 1; i >= 0; i -= stride) rows.push([labels[i], ...series.map((s) => (opt.ttFmt || yFmt)(s.data[i]))]);
    tableFrom(tableEl, [tableHead || 'Fecha', ...series.map((s) => s.name)], rows);
  }
}

/* barras apiladas o agrupadas */
function barChart(box, opt) {
  const { cats, series, mode = 'stack', tableEl, tableHead, yFmt = nf, aria } = opt;
  box.textContent = '';
  const W = Math.max(520, box.clientWidth || 600), H = opt.height || 260;
  const M = { t: 16, r: 16, b: 28, l: 48 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': aria || '' });
  const n = cats.length;
  const totals = cats.map((_, i) => mode === 'stack' ? series.reduce((a, s) => a + s.data[i], 0) : Math.max(...series.map((s) => s.data[i])));
  const ticks = niceTicks(Math.max(1, ...totals)); const yMax = ticks[ticks.length - 1];
  const y = (v) => M.t + ih - (v / yMax) * ih;
  for (const tv of ticks) {
    svgEl('line', { x1: M.l, x2: M.l + iw, y1: y(tv), y2: y(tv), stroke: tv === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': 1 }, svg);
    svgEl('text', { x: M.l - 8, y: y(tv) + 4, 'text-anchor': 'end', 'font-size': 11, fill: 'var(--muted)' }, svg).textContent = yFmt(tv);
  }
  const slot = iw / n; const bw = Math.min(34, slot * 0.6);
  for (let i = 0; i < n; i++) {
    const cx = M.l + slot * i + slot / 2;
    const g = svgEl('g', {}, svg);
    if (mode === 'stack') {
      let acc = 0;
      series.forEach((s, si) => {
        const v = s.data[i]; if (v <= 0) return;
        const top = y(acc + v), bottom = y(acc); const gap = si === 0 ? 0 : 2;
        const hh = Math.max(0, bottom - top - gap);
        const isTop = si === series.length - 1 || series.slice(si + 1).every((t) => t.data[i] <= 0);
        if (isTop) svgEl('path', { d: roundedTop(cx - bw / 2, top, bw, hh, 4), fill: s.color }, g);
        else svgEl('rect', { x: cx - bw / 2, y: top, width: bw, height: hh, fill: s.color }, g);
        acc += v;
      });
    } else {
      const k = series.length; const sw = (bw + 6) / k;
      series.forEach((s, si) => {
        const v = s.data[i]; const x0 = cx - (bw + 6) / 2 + si * sw;
        if (v > 0) svgEl('path', { d: roundedTop(x0, y(v), sw - 2, y(0) - y(v), 4), fill: s.color }, g);
      });
    }
    const nL = n > 8 ? 2 : 1;
    if (i % nL === 0 || i === n - 1) svgEl('text', { x: cx, y: H - 8, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--muted)' }, svg).textContent = cats[i];
    const hot = svgEl('rect', { x: M.l + slot * i, y: M.t, width: slot, height: ih, fill: 'transparent' }, svg);
    hot.addEventListener('pointermove', (ev) => showTooltip(ev.clientX, ev.clientY, cats[i], [...series.map((s) => ({ color: s.color, value: (opt.ttFmt || yFmt)(s.data[i]), label: s.name })), ...(mode === 'stack' ? [{ value: (opt.ttFmt || yFmt)(totals[i]), label: 'Total' }] : [])]));
    hot.addEventListener('pointerleave', hideTooltip);
  }
  box.appendChild(svg);
  if (tableEl) tableFrom(tableEl, [tableHead || 'Período', ...series.map((s) => s.name), ...(mode === 'stack' ? ['Total'] : [])], cats.map((c, i) => [c, ...series.map((s) => (opt.ttFmt || yFmt)(s.data[i])), ...(mode === 'stack' ? [(opt.ttFmt || yFmt)(totals[i])] : [])]));
}

/* barras horizontales pareadas (A frente a B) */
function pairedBars(box, opt) {
  const { rows, names, colors, aria } = opt;
  box.textContent = '';
  const W = Math.max(480, box.clientWidth || 560), rowH = 40, H = rows.length * rowH + 10;
  const M = { l: 200, r: 48 }; const iw = W - M.l - M.r;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': aria || '' });
  const x = (v) => M.l + v * iw;
  rows.forEach((r, i) => {
    const y0 = 6 + i * rowH;
    svgEl('text', { x: M.l - 10, y: y0 + 16, 'text-anchor': 'end', 'font-size': 12, fill: 'var(--ink-2)' }, svg).textContent = r.label;
    [r.a, r.b].forEach((v, k) => {
      const yy = y0 + 4 + k * 13;
      svgEl('rect', { x: M.l, y: yy, width: Math.max(2, x(v) - M.l), height: 9, rx: 2, fill: colors[k] }, svg);
      svgEl('text', { x: x(v) + 6, y: yy + 8, 'font-size': 11, 'font-weight': k === 0 ? 600 : 400, fill: k === 0 ? 'var(--ink)' : 'var(--muted)' }, svg).textContent = pct(v);
    });
    if (i < rows.length - 1) svgEl('line', { x1: 0, x2: W, y1: y0 + rowH - 4, y2: y0 + rowH - 4, stroke: 'var(--grid)' }, svg);
    const hot = svgEl('rect', { x: 0, y: y0 - 2, width: W, height: rowH, fill: 'transparent' }, svg);
    hot.addEventListener('pointermove', (ev) => showTooltip(ev.clientX, ev.clientY, r.label, [{ color: colors[0], value: pct(r.a), label: names[0] }, { color: colors[1], value: pct(r.b), label: names[1] }]));
    hot.addEventListener('pointerleave', hideTooltip);
  });
  box.appendChild(svg);
}

/* ---------- datos simulados ---------- */
function followersSeries() {
  const r = rng(11); const out = {}; const labels = [];
  for (let d = 89; d >= 0; d--) labels.push(fmtDate(daysAgo(d)));
  const start = { tiktok: 196000, instagram: 119500, youtube: 45200, facebook: 20100 };
  for (const n of NETWORKS) {
    const arr = []; const total = FOLLOWERS_NOW[n.id] - start[n.id]; let acc = start[n.id];
    const weights = []; let ws = 0;
    for (let i = 0; i < 90; i++) { const w = 0.6 + r() * 0.8 + (i > 62 && i < 70 && n.id === 'tiktok' ? 3.2 : 0) + (i > 76 && n.id === 'instagram' ? 0.9 : 0); weights.push(w); ws += w; }
    for (let i = 0; i < 90; i++) { acc += (total * weights[i]) / ws; arr.push(Math.round(acc)); }
    out[n.id] = arr;
  }
  return { labels, out };
}
function weeklyViews() {
  const r = rng(23); const cats = []; const data = { tiktok: [], instagram: [], youtube: [], facebook: [] };
  const base = { tiktok: 360000, instagram: 165000, youtube: 68000, facebook: 21000 };
  for (let w = 11; w >= 0; w--) {
    cats.push('S' + (38 - w));
    for (const n of NETWORKS) { const spike = (w === 3 && n.id === 'tiktok') ? 1.9 : 1; data[n.id].push(Math.round(base[n.id] * (0.75 + r() * 0.5) * spike * (1 + (11 - w) * 0.015))); }
  }
  return { cats, data };
}

const VIDEOS = [
  { t: 'La arepa que se hace sin plancha', net: 'tiktok', d: 4, views: 412000, score: 4.6, skip: 0.19, saves: 21.4, nofol: 0.74, hook: 'Reto', dur: 34 },
  { t: 'Tres desayunos con dos ingredientes', net: 'instagram', d: 9, views: 168000, score: 3.1, skip: 0.22, saves: 18.0, nofol: 0.66, hook: 'Lista', dur: 41 },
  { t: 'El error que arruina tu arroz', net: 'tiktok', d: 12, views: 240000, score: 2.7, skip: 0.24, saves: 15.2, nofol: 0.69, hook: 'Error común', dur: 38 },
  { t: 'Pasta cremosa en cuatro minutos', net: 'youtube', d: 6, views: 96000, score: 2.2, skip: null, saves: 9.1, nofol: 0.58, hook: 'Reto', dur: 55 },
  { t: 'Salsa que mejora cualquier cosa', net: 'instagram', d: 15, views: 101000, score: 1.9, skip: 0.27, saves: 13.4, nofol: 0.55, hook: 'Promesa', dur: 36 },
  { t: 'Huevo perfecto: el truco del vaso', net: 'tiktok', d: 2, views: 74000, score: 1.6, skip: 0.28, saves: 11.0, nofol: 0.61, hook: 'Truco', dur: 29 },
  { t: 'Qué cocino un lunes sin ganas', net: 'facebook', d: 8, views: 31000, score: 1.3, skip: null, saves: 4.2, nofol: 0.31, hook: 'Pregunta', dur: 62 },
  { t: 'Compras de la semana por 80 mil', net: 'instagram', d: 20, views: 61000, score: 1.1, skip: 0.36, saves: 9.8, nofol: 0.42, hook: 'Vlog', dur: 71 },
  { t: 'Mi cocina en 60 segundos', net: 'youtube', d: 17, views: 39000, score: 0.9, skip: null, saves: 3.1, nofol: 0.39, hook: 'Saludo', dur: 60 },
  { t: 'Sopa de la abuela paso a paso', net: 'tiktok', d: 23, views: 58000, score: 0.7, skip: 0.41, saves: 6.4, nofol: 0.35, hook: 'Saludo', dur: 88 },
  { t: 'Postre sin horno para visitas', net: 'instagram', d: 26, views: 44000, score: 0.8, skip: 0.39, saves: 8.9, nofol: 0.40, hook: 'Promesa', dur: 67 },
  { t: 'Respondo sus preguntas de cocina', net: 'facebook', d: 28, views: 12000, score: 0.5, skip: null, saves: 1.2, nofol: 0.18, hook: 'Saludo', dur: 140 },
];
const TRAITS = [
  { label: 'Texto en pantalla en 0–3 s', a: 0.90, b: 0.52 },
  { label: 'Hook de reto o pregunta', a: 0.80, b: 0.31 },
  { label: 'Menos de 40 s', a: 0.70, b: 0.45 },
  { label: 'Plano cenital de apertura', a: 0.60, b: 0.22 },
  { label: 'CTA "guárdalo" al final', a: 0.50, b: 0.18 },
  { label: 'Sonido en tendencia', a: 0.40, b: 0.35 },
];
const WATCH = [
  { n: '@chefpaula', net: 'tiktok', f: 1200000 }, { n: '@cocinaconjuan', net: 'instagram', f: 480000 }, { n: '@recetas.exp', net: 'tiktok', f: 96500 },
  { n: 'CocinaExprés', net: 'youtube', f: 52700 }, { n: '@la.olla.facil', net: 'instagram', f: 233000 }, { n: '@desayunos.ya', net: 'tiktok', f: 310000 },
  { n: '#recetafacil', net: 'instagram', f: null }, { n: '#cenaen10minutos', net: 'tiktok', f: null }, { n: '@mamacocina.co', net: 'facebook', f: 145000 },
  { n: 'Sabor en 60', net: 'youtube', f: 88000 }, { n: '@fitcocina', net: 'instagram', f: 67000 }, { n: '#desayunorapido', net: 'tiktok', f: null },
];
const NICHE = [
  { acc: '@desayunos.ya', net: 'tiktok', t: 'El pan que se hace en sartén sin horno', views: 2900000, score: 6.8, hook: 'Método que no conocías', dur: 31, sound: 'cocina lo-fi 02', age: 3 },
  { acc: '@chefpaula', net: 'tiktok', t: 'Probé la arepa de microondas y no me lo creo', views: 5100000, score: 4.2, hook: 'Comparación a ciegas', dur: 44, sound: 'original', age: 5 },
  { acc: '@la.olla.facil', net: 'instagram', t: 'Un solo ingrediente y tres cenas', views: 890000, score: 3.9, hook: 'Ingrediente único', dur: 37, sound: 'cocina lo-fi 02', age: 2 },
  { acc: 'CocinaExprés', net: 'youtube', t: 'Por qué tu arroz queda pegado', views: 410000, score: 3.5, hook: 'Error común', dur: 58, sound: 'original', age: 6 },
  { acc: '@recetas.exp', net: 'tiktok', t: 'Huevos revueltos que parecen de restaurante', views: 380000, score: 3.3, hook: 'Método que no conocías', dur: 28, sound: 'no me lo creo', age: 4 },
  { acc: '@cocinaconjuan', net: 'instagram', t: 'Lo que hace un chef con la sobra de arroz', views: 1200000, score: 2.9, hook: 'Ingrediente único', dur: 35, sound: 'cocina lo-fi 02', age: 1 },
  { acc: '@fitcocina', net: 'instagram', t: 'Avena que no sabe a avena', views: 210000, score: 2.6, hook: 'Promesa', dur: 33, sound: 'original', age: 6 },
  { acc: 'Sabor en 60', net: 'youtube', t: 'Salsa de ajo en un minuto', views: 190000, score: 2.4, hook: 'Método que no conocías', dur: 60, sound: 'original', age: 7 },
  { acc: '@mamacocina.co', net: 'facebook', t: 'La sopa que cura todo, versión rápida', views: 320000, score: 2.2, hook: 'Promesa', dur: 75, sound: 'original', age: 5 },
  { acc: '@desayunos.ya', net: 'tiktok', t: 'Tres desayunos con un huevo', views: 1100000, score: 2.1, hook: 'Ingrediente único', dur: 30, sound: 'no me lo creo', age: 2 },
];
const LIFTS = [
  { label: 'Hook "el método que no conocías"', v: 2.6 }, { label: 'Un solo ingrediente básico', v: 2.1 }, { label: 'Menos de 40 s', v: 1.8 },
  { label: 'Comparación a ciegas o prueba', v: 1.7 }, { label: 'Texto en pantalla desde el segundo 0', v: 1.5 }, { label: 'Receta de más de 60 s', v: 0.6 }, { label: 'Abre con saludo', v: 0.4 },
];
const SOUNDS = [
  { label: 'Sonido "cocina lo-fi 02"', v: 1.40 }, { label: 'Sonido original "no me lo creo" (@chefpaula)', v: 0.95 }, { label: '#desayunorapido', v: 0.61 },
  { label: '#recetafacil', v: 0.38 }, { label: '#cenaen10minutos', v: 0.22 }, { label: '#mealprep', v: -0.12 },
];
const IDEAS = [
  { id: 0, title: 'La arepa que se hace sin plancha en tres minutos', fmt: 'Método que no conocías · 90 s · 9 bloques', score: 84, nets: ['tiktok', 'instagram', 'youtube'],
    why: [['in', 'Tus 3 videos con mejor puntaje abren con una frase de reto y duran menos de 40 s.'], ['ex', '7 de los 10 outliers del nicho esta semana son "el método que no conocías" con un ingrediente básico.'], ['ex', 'El sonido "cocina lo-fi 02" creció 140 % en 7 días y va con el ritmo del guion.'], ['in', 'Tu salto a 3 s baja de 38 % a 21 % cuando el primer plano es cenital.']] },
  { id: 1, title: 'Tres cenas con lo que queda en la nevera un lunes', fmt: 'Ingrediente único · 45 s · lista', score: 71, nets: ['instagram', 'tiktok'],
    why: [['in', 'Tu lista "tres desayunos" hizo 3,1 veces tu mediana y es tu video con más guardados.'], ['ex', '"Un solo ingrediente" es el segundo rasgo con más lift en el nicho.'], ['in', 'Los lunes tu alcance en no seguidores sube 9 puntos.']] },
  { id: 2, title: 'Por qué tu arroz siempre queda pegado', fmt: 'Error común · 60 s · comparación', score: 78, nets: ['youtube', 'tiktok'],
    why: [['ex', 'CocinaExprés hizo 3,5 veces su mediana con el mismo error esta semana; hay demanda sin cubrir en español.'], ['in', 'Tu "error que arruina tu arroz" fue outlier hace 12 días: la audiencia ya te asocia con el tema.'], ['ex', 'La comparación a ciegas tiene lift 1,7 en el nicho.']] },
];
const SCRIPT = [
  { role: 'hook', line: 'Tu abuela no aprobaría esta arepa. Dos minutos, cero plancha, y queda dorada por fuera y suave por dentro. Te muestro cómo.', planos: 'Cenital de la arepa terminada partida · manos rompiéndola, sale vapor · texto: SIN PLANCHA' },
  { role: 'build', line: 'Una taza de harina precocida, una de agua tibia, media cucharadita de sal. Amasa con la mano hasta que no se pegue.', planos: 'Cenital del bowl · detalle de la mano amasando · la masa se despega del bowl' },
  { role: 'build', line: 'Forma una bola y aplástala con la palma hasta un dedo de grosor. Si el borde se agrieta, moja las manos y ciérralo.', planos: 'Bola en la palma · aplastar contra la tabla · dedo midiendo el grosor' },
  { role: 'build', line: 'Aquí está el truco: pásale una gota de aceite por cada cara. Sin eso, el microondas la deja pálida y seca por dentro.', planos: 'Gota de aceite cayendo · dedos untando · comparación rápida pálida vs. dorada' },
  { role: 'build', line: 'Un plato, un minuto a máxima potencia. La volteas. Otro minuto. Escucha el vapor: cuando silba por el borde, ya está cocida adentro.', planos: 'Plato entrando al microondas · temporizador · macro del borde con vapor' },
  { role: 'build', line: 'Y para el dorado, la tostadora. Un minuto en el nivel más alto. Sale con costra de parrilla sin prender la estufa.', planos: 'Arepa bajando a la tostadora · resorte saltando · detalle de las marcas doradas' },
  { role: 'build', line: 'Ábrela por la mitad con un cuchillo mientras está caliente. Mantequilla, queso, o lo que tengas. El vapor de adentro derrite todo solo.', planos: 'Cuchillo abriéndola · mantequilla derritiéndose · queso estirando' },
  { role: 'giro', line: 'Lo que nadie cuenta: la de plancha tarda quince minutos y sabe igual. Las probé a ciegas y no distinguí ninguna.', planos: 'Dos arepas idénticas lado a lado · ojos vendados · encogerse de hombros' },
  { role: 'cierre', line: 'Así que sí, tu abuela tenía razón en el sabor. Pero ella tenía tiempo. Tú tienes tres minutos y una arepa caliente.', planos: 'Mordisco a cámara · reloj marcando tres minutos · texto: GUÁRDALO PARA MAÑANA' },
];
const RATES = [
  { e: 'Historia de Instagram (3 pantallas)', base: '45 K views · CPM 45–70 K', lo: 1.6e6, hi: 2.4e6 },
  { e: 'Reel de Instagram', base: '92 K views promedio', lo: 4.8e6, hi: 7.2e6 },
  { e: 'Video de TikTok', base: '138 K views promedio', lo: 7.1e6, hi: 10.6e6 },
  { e: 'YouTube Short', base: '41 K views promedio', lo: 2.1e6, hi: 3.2e6 },
  { e: 'Video dedicado 60–90 s (cualquier red)', base: 'Producción completa', lo: 9.5e6, hi: 14e6 },
  { e: 'Integración de 15 s dentro de un video', base: '60 % del dedicado', lo: 5.7e6, hi: 8.4e6 },
  { e: 'Paquete: 1 TikTok + 1 Reel + 3 historias', base: '12 % de descuento', lo: 11.9e6, hi: 17.8e6 },
  { e: 'Derechos de uso 90 días', base: '+35 % sobre el entregable', lo: null, hi: null },
  { e: 'Exclusividad de categoría 30 días', base: '+25 % sobre el entregable', lo: null, hi: null },
];
const CAMPS = [
  { b: 'Café Alma', d: '1 reel + 1 TikTok + 3 historias', f: '24–31 ago', st: ['Reporte listo', 'good'], views: 712000, sales: 'COP 8,4 M (318 canjes)' },
  { b: 'Fresko Market', d: '2 TikTok', f: '2–9 sep', st: ['En curso', 'accent'], views: 265000, sales: 'Enlace: 1 940 clics' },
  { b: 'Nutrivé', d: '1 video dedicado YouTube', f: '15–22 jul', st: ['Cobrada', 'muted'], views: 58000, sales: 'Sin datos de la marca' },
  { b: 'Hogar Lindo', d: '3 historias', f: '5–6 jun', st: ['Pendiente de pago', 'warn'], views: 94000, sales: 'COP 1,1 M (42 canjes)' },
];
const CHECKS = [
  [true, 'Código LAURA15 creado desde la plataforma', 'La marca reporta canjes por semana'],
  [true, 'Enlace rastreado con UTM', '6 240 clics · 71 % desde Colombia · 84 % móvil'],
  [true, 'Etiqueta de colaboración pagada en Instagram', 'La marca ve los insights del post en su Business Suite'],
  [true, 'Snapshot de seguidores de @cafealma desde el 10 ago', 'Línea base de 2 semanas'],
  [false, 'CSV de ventas diarias de la marca', 'Pedido el 2 sep; sin respuesta. Sin esto no hay lift de ventas, solo canjes'],
  [true, 'Cortes de métricas a 7 y 30 días', 'Acordados en la cotización'],
];
const STAGES = [
  { id: 'nuevo', name: 'Nuevo', p: 0.05 }, { id: 'contactado', name: 'Contactado', p: 0.15 }, { id: 'conversacion', name: 'En conversación', p: 0.35 },
  { id: 'propuesta', name: 'Propuesta enviada', p: 0.55 }, { id: 'negociacion', name: 'Negociación', p: 0.8 }, { id: 'ganado', name: 'Ganado en Q3', p: 1 },
];
const STG = Object.fromEntries(STAGES.map((s) => [s.id, s]));
const DEALS = [
  { co: 'Olla Fácil', deal: 'Por definir', stage: 'nuevo', v: 6e6, next: 'Enviar pitch', due: 0, touch: 'Radar · hace 3 d', src: 'Colaboración pagada con @la.olla.facil', fit: 0.79 },
  { co: 'Dulce Hogar', deal: 'Por definir', stage: 'nuevo', v: 4.5e6, next: 'Enviar pitch', due: 1, touch: 'Radar · hace 4 d', src: 'Menciona "desayuno fácil" en 4 anuncios activos', fit: 0.68 },
  { co: 'Sazón Andina', deal: 'Por definir', stage: 'nuevo', v: 5e6, next: 'Calificar', due: 0, touch: 'Radar · hace 5 d', src: 'Top Ads en TikTok Creative Center', fit: 0.64 },
  { co: 'Tienda Verde', deal: 'Por definir', stage: 'nuevo', v: 3.5e6, next: 'Enviar pitch', due: 3, touch: 'Radar · hace 4 d', src: 'Buscó creadores de cocina en TikTok Creator Marketplace', fit: 0.68 },
  { co: 'Panadería Trigo', deal: 'Por definir', stage: 'nuevo', v: 2.8e6, next: 'Calificar', due: 5, touch: 'Radar · hace 6 d', src: 'Colaboración pagada con @fitcocina', fit: 0.62 },
  { co: 'Granos del Valle', deal: 'Historias + 1 Reel', stage: 'contactado', v: 8e6, next: 'Seguimiento 2', due: -2, touch: 'Correo · 7 sep', src: 'Top Ads en TikTok Creative Center', fit: 0.71 },
  { co: 'Cocinas Aura', deal: 'Video dedicado', stage: 'contactado', v: 7e6, next: 'Seguimiento 1', due: 2, touch: 'DM · 12 sep', src: 'Colaboraciones pagadas con 3 cuentas vigiladas', fit: 0.64 },
  { co: 'Lácteos del Norte', deal: 'Paquete', stage: 'contactado', v: 9e6, next: 'Seguimiento 1', due: 3, touch: 'Correo · 13 sep', src: 'Biblioteca de anuncios de Meta', fit: 0.7 },
  { co: 'Mercado Central', deal: '2 TikTok', stage: 'contactado', v: 4e6, next: 'Seguimiento 3', due: -5, touch: 'Correo · 1 sep', src: 'Vacante de influencer marketing', fit: 0.6 },
  { co: 'Café Alma', deal: 'Renovación Q4 · 3 meses', stage: 'conversacion', v: 12e6, next: 'Llamada', due: 1, touch: 'Llamada · 11 sep', src: 'Cliente actual', fit: 0.85 },
  { co: 'Nutrivé', deal: 'Serie de 3 videos Q4', stage: 'conversacion', v: 11e6, next: 'Enviar propuesta', due: 2, touch: 'Correo · 10 sep', src: 'Cliente actual', fit: 0.74 },
  { co: 'Hogar Lindo', deal: 'Historias navidad', stage: 'conversacion', v: 3e6, next: 'Esperar pago de la mora', due: null, touch: 'Correo · 4 sep', src: 'Cliente anterior', fit: 0.58 },
  { co: 'Fresko Market', deal: 'Lanzamiento desayunos · 1 TikTok + 1 Reel + 3 historias', stage: 'propuesta', v: 14.2e6, next: 'Seguimiento a la cotización', due: 2, touch: 'Correo · 9 sep', src: 'Biblioteca de anuncios de Meta', fit: 0.82 },
  { co: 'Vitalé', deal: '2 Reels + derechos 90 d', stage: 'propuesta', v: 9.8e6, next: 'Ajustar entregables', due: 0, touch: 'Llamada · 15 sep', src: 'Biblioteca de anuncios de Meta', fit: 0.73 },
  { co: 'Aceites del Sur', deal: 'Video dedicado', stage: 'propuesta', v: 7e6, next: 'Seguimiento', due: -1, touch: 'Correo · 8 sep', src: 'Prensa del sector', fit: 0.66 },
  { co: 'Sabores Caseros', deal: 'Paquete + exclusividad 30 d', stage: 'negociacion', v: 16e6, next: 'Enviar contrato', due: 0, touch: 'Llamada · 15 sep', src: 'Marketplaces', fit: 0.8 },
  { co: 'Arroz Premium', deal: '1 TikTok + 1 Short', stage: 'negociacion', v: 6.5e6, next: 'Confirmar fechas', due: 3, touch: 'DM · 14 sep', src: 'Colaboración pagada con @desayunos.ya', fit: 0.69 },
  { co: 'Fresko Market', deal: '2 TikTok · septiembre', stage: 'ganado', v: 5.2e6, next: 'Cobrar el 9 oct', due: 23, touch: 'Reporte · 9 sep', src: 'Biblioteca de anuncios de Meta', fit: 0.82 },
  { co: 'Nutrivé', deal: 'Video dedicado · julio', stage: 'ganado', v: 4.5e6, next: 'Cobrada', due: null, touch: 'Pago · 20 ago', src: 'Marketplaces', fit: 0.74 },
  { co: 'Café Alma', deal: 'Lanzamiento cold brew', stage: 'ganado', v: 3.1e6, next: 'Cobrar el 30 sep', due: 14, touch: 'Reporte · 15 sep', src: 'Cuentas vigiladas', fit: 0.85 },
];
const SIGNALS = [
  { co: 'Delicias del Campo', sig: '4 anuncios activos en Meta desde el 14 sep · alimentos', src: 'Biblioteca de anuncios de Meta', when: 'hoy', fit: 0.72, budget: 5e6, st: 'pending' },
  { co: 'Horno Casero', sig: 'Colaboración pagada con @desayunos.ya', src: 'Cuentas vigiladas', when: 'hoy', fit: 0.75, budget: 3.5e6, st: 'pending' },
  { co: 'Fruta Fresca', sig: 'Lanza línea de jugos en octubre', src: 'Prensa del sector', when: 'ayer', fit: 0.70, budget: 6e6, st: 'pending' },
  { co: 'Cocina & Co', sig: 'Vacante "influencer marketing manager"', src: 'LinkedIn', when: 'ayer', fit: 0.61, budget: 8e6, st: 'pending' },
  { co: 'Mi Despensa', sig: 'Top Ads en TikTok · Colombia · 7 días', src: 'TikTok Creative Center', when: 'hace 2 d', fit: 0.66, budget: 4e6, st: 'pending' },
  { co: 'Olla Fácil', sig: 'Colaboración pagada con @la.olla.facil', src: 'Cuentas vigiladas', when: 'hace 3 d', fit: 0.79, budget: 6e6, st: 'inpipe' },
  { co: 'Tienda Verde', sig: 'Buscó creadores de cocina en TikTok Creator Marketplace', src: 'Marketplaces', when: 'hace 4 d', fit: 0.68, budget: 3.5e6, st: 'inpipe' },
  { co: 'Suplementos Max', sig: '9 anuncios activos en Meta · suplementos', src: 'Biblioteca de anuncios de Meta', when: 'hace 5 d', fit: 0.31, budget: 12e6, st: 'discarded', why: 'fuera de nicho' },
];
const SOURCES = [
  ['Biblioteca de anuncios de Meta', 'Colombia · alimentos, hogar, bienestar', 14, 'Activa'],
  ['Colaboraciones pagadas en cuentas vigiladas', '12 cuentas del nicho', 9, 'Activa'],
  ['TikTok Creative Center · Top Ads', 'Colombia · 7 días', 6, 'Activa'],
  ['Marketplaces', 'TikTok Creator Marketplace, Instagram', 3, 'Activa'],
  ['Vacantes de influencer marketing', 'LinkedIn · Colombia', 3, 'Activa'],
  ['Prensa y lanzamientos del sector', 'Alimentos y hogar', 2, 'Activa'],
  ['Calendario de temporada', 'Amor y Amistad 19 sep · Halloween · Navidad', 0, 'Programada'],
];
const COMPANIES = {
  'Fresko Market': {
    sub: 'Supermercado en línea · Bogotá · alimentos', close: '30 sep',
    contacts: [['Camila R.', 'Jefa de marketing', 'Correo', '9 sep'], ['Andrés P.', 'Community manager', 'DM de Instagram', '27 ago'], ['Agencia Lumen', 'Central de medios', 'Correo', 'sin respuesta']],
    timeline: [
      ['12 ago', 'El radar detectó 6 anuncios activos en Meta, categoría alimentos, Colombia.', false],
      ['20 ago', 'Pitch enviado por correo con media kit y el reporte de Café Alma.', false],
      ['23 ago', 'Camila respondió: piden propuesta para el lanzamiento de desayunos de octubre.', false],
      ['27 ago', 'Llamada de 25 min. Presupuesto entre COP 12 y 15 M. Quieren código y enlace propios.', false],
      ['2 sep', 'Cotización enviada: 1 TikTok + 1 Reel + 3 historias, derechos 90 días, COP 14,2 M.', false],
      ['9 sep', 'Cerró la campaña anterior (2 TikTok): 265 K views y 1 940 clics. Reporte adjunto como argumento.', false],
      ['18 sep', 'Seguimiento a la cotización (programado).', true],
    ],
    nextDetail: 'a Camila, por correo', nextTip: 'Usa el reporte de septiembre como argumento: 1 940 clics con 0,7 % de CTR y 58 % del alcance en no seguidores.',
    seq: [[true, 'Pitch', '20 ago'], [true, 'Seguimiento 1 · +3 d', '23 ago · respondió'], [true, 'Propuesta', '2 sep'], [true, 'Seguimiento con reporte · +7 d', '9 sep'], [false, 'Seguimiento 2 · +16 d', '18 sep · programado'], [false, 'Cierre o pausa · +30 d', '2 oct']],
    facts: [['Pauta', '6 anuncios activos en Meta desde el 12 ago, categoría alimentos.'], ['Historial', 'Trabajó con @la.olla.facil en 2025 y contigo en septiembre (2 TikTok, COP 5,2 M).'], ['Lanzamiento', 'Línea de desayunos en octubre. Encaja con tu formato "tres desayunos".'], ['Temporada', 'Amor y Amistad el 19 sep: proponer que la campaña arranque antes del 10 oct.']],
    chain: [['Deal', true], ['Cotización', true], ['Campaña', false], ['Factura', false], ['Cobro', false]],
  },
};
const DEFAULT_SEQ = [[false, 'Pitch', 'día 0'], [false, 'Seguimiento 1', '+3 d'], [false, 'Seguimiento 2', '+7 d'], [false, 'Último toque', '+14 d'], [false, 'Cierre o pausa', '+30 d']];
const CXC = [
  { b: 'Fresko Market', c: 'Campaña 2 TikTok · sep', m: 5.2e6, v: '9 oct', days: 23, st: ['Al día', 'good'] },
  { b: 'Café Alma', c: 'Lanzamiento cold brew', m: 3.1e6, v: '30 sep', days: 14, st: ['Vence pronto', 'warn'] },
  { b: 'Hogar Lindo', c: '3 historias · jun', m: 1.1e6, v: '6 ago', days: -41, st: ['Vencida 41 días', 'bad'] },
];
const AGENCY = [
  { b: 'Nutrivé', cm: 'Andrea', accs: 'IG · TikTok · FB', posts: 22, reach: 1840000, rep: 'Enviado 1 sep', st: ['Al día', 'good'] },
  { b: 'Café Alma', cm: 'Andrea', accs: 'IG · TikTok', posts: 18, reach: 960000, rep: 'Programado 1 oct', st: ['Al día', 'good'] },
  { b: 'Granos del Valle', cm: 'Mateo', accs: 'IG · FB · YT', posts: 9, reach: 310000, rep: 'Programado 1 oct', st: ['3 posts sin aprobar', 'warn'] },
  { b: 'Cocinas Aura', cm: 'Mateo', accs: 'IG', posts: 12, reach: 420000, rep: 'Enviado 1 sep', st: ['Al día', 'good'] },
  { b: 'Dulce Hogar', cm: 'Sofía', accs: 'TikTok · IG', posts: 4, reach: 88000, rep: 'Sin programar', st: ['Cuenta TikTok sin conectar', 'bad'] },
];
const APROB = [
  { b: 'Granos del Valle', it: 'Reel "arroz integral en 20 minutos"', due: 'Hoy', st: ['Esperando al cliente', 'warn'] },
  { b: 'Granos del Valle', it: 'Carrusel "5 formas de usar lentejas"', due: 'Mañana', st: ['Esperando al cliente', 'warn'] },
  { b: 'Café Alma', it: 'Historia "cold brew de temporada"', due: 'Jue 18', st: ['Aprobado', 'good'] },
];

/* ---------- render: resumen ---------- */
function pillEl(text, kind) { return h('span', 'pill pill-' + kind, text); }
function chipNet(id, extra) { const c = h('span', 'chip'); const i = h('i'); i.style.background = NET[id].color; c.appendChild(i); c.appendChild(document.createTextNode(extra || NET[id].name)); return c; }

function renderNets() {
  const el = document.getElementById('nets');
  for (const n of NETWORKS) { const c = h('span', 'net'); const i = h('i'); i.style.background = n.color; c.appendChild(i); c.appendChild(document.createTextNode(n.name + ' ')); c.appendChild(h('span', 'n', nf(FOLLOWERS_NOW[n.id]))); el.appendChild(c); }
}
function renderResumen() {
  const fs = followersSeries(); const wv = weeklyViews();
  const total = NETWORKS.reduce((a, n) => a + FOLLOWERS_NOW[n.id], 0);
  const total30 = NETWORKS.reduce((a, n) => a + fs.out[n.id][59], 0);
  const sumW = (from, to) => { let s = 0; for (let i = from; i < to; i++) for (const n of NETWORKS) s += wv.data[n.id][i]; return s; };
  const v30 = sumW(8, 12), vPrev = sumW(4, 8);
  const sparkF = []; for (let i = 0; i < 12; i++) sparkF.push(NETWORKS.reduce((a, n) => a + fs.out[n.id][Math.round((i * 89) / 11)], 0));
  const sparkV = wv.cats.map((_, i) => NETWORKS.reduce((a, n) => a + wv.data[n.id][i], 0));
  kpis(document.getElementById('kpis-resumen'), [
    { label: 'Seguidores en total', value: nf(total), delta: (total - total30) / total30, spark: sparkF },
    { label: 'Views en 30 días', value: nf(v30), delta: (v30 - vPrev) / vPrev, spark: sparkV },
    { label: 'Alcance en no seguidores', value: '61 %', delta: 0.07, spark: [48, 50, 49, 53, 52, 55, 54, 58, 57, 60, 59, 61] },
    { label: 'Guardados por 1 000 views', value: '14,2', delta: 0.12, spark: [9.1, 9.8, 10.2, 9.9, 11.0, 11.4, 12.1, 11.8, 12.9, 13.4, 13.8, 14.2] },
    { label: 'Mediana de views por video', value: '38 K', delta: 0.041, spark: [31, 32, 34, 33, 35, 34, 36, 36, 37, 36, 38, 38] },
  ]);
  const sF = NETWORKS.map((n) => ({ name: n.name, color: n.color, data: fs.out[n.id] }));
  legend(document.getElementById('lg-followers'), sF, 'line');
  lineChart(document.getElementById('c-followers'), { series: sF, labels: fs.labels, tableEl: document.getElementById('t-followers'), aria: 'Seguidores por red en 90 días', ttFmt: (v) => fmtInt.format(v), fromZero: false });
  const sV = NETWORKS.map((n) => ({ name: n.name, color: n.color, data: wv.data[n.id] }));
  legend(document.getElementById('lg-views'), sV, 'rect');
  barChart(document.getElementById('c-views'), { cats: wv.cats, series: sV, tableEl: document.getElementById('t-views'), tableHead: 'Semana', aria: 'Views por semana y red', ttFmt: (v) => fmtInt.format(v) });

  const ins = document.getElementById('insights');
  const rows = [
    ['Interno', 'accent', ['"La arepa que se hace sin plancha" hizo ', '4,6 veces tu mediana', ' en 4 días. Es tu mejor video del año y sube todavía. Vale una segunda parte.'], 'videos', 'Ver video'],
    ['Nicho', 'warn', ['"El método que no conocías" aparece ', '2,6 veces más', ' en los outliers de cocina fácil esta semana. Tienes 3 ideas listas con ese formato.'], 'ideas', 'Ver ideas'],
    ['Campaña', 'good', ['Café Alma ganó ', '1 240 seguidores', ' en la semana de tu campaña, 12 veces su ritmo normal. El reporte a 30 días está listo para enviar.'], 'campanas', 'Ver reporte'],
    ['Ventas', 'muted', ['Hay ', '5 señales por revisar', ' en el radar y 3 seguimientos vencidos en el pipeline. La cotización de Fresko Market toca seguimiento el jueves.'], 'ventas', 'Ver pipeline'],
    ['Finanzas', 'bad', ['Hogar Lindo lleva ', '41 días de mora', ' con COP 1,1 M. Ya se enviaron 2 recordatorios. Puedes adelantar la factura de Fresko Market mientras tanto.'], 'finanzas', 'Ver cuentas'],
    ['Interno', 'accent', ['Tus últimos 5 videos salieron a las 14:00. Tus seguidores están conectados ', 'martes y jueves de 19:00 a 21:00', '.'], 'resumen', 'Ver horas'],
  ];
  for (const r of rows) {
    const li = h('li'); li.appendChild(pillEl(r[0], r[1]));
    const p = h('p'); p.appendChild(document.createTextNode(r[2][0])); p.appendChild(h('b', null, r[2][1])); p.appendChild(document.createTextNode(r[2][2])); li.appendChild(p);
    const b = h('button', 'go', r[4] + ' →'); b.type = 'button'; b.addEventListener('click', () => showPanel(r[3])); li.appendChild(b);
    ins.appendChild(li);
  }
  const heat = document.getElementById('heat'); const days = ['L', 'M', 'X', 'J', 'V', 'S', 'D']; const hours = ['07', '10', '13', '16', '19', '21', '23'];
  heat.appendChild(h('div')); for (const d of days) heat.appendChild(h('div', 'dl', d));
  const r = rng(7); let best = null, bestV = 0; const cells = [];
  hours.forEach((hr, hi) => {
    heat.appendChild(h('div', 'hl', hr + ':00'));
    days.forEach((d, di) => {
      let v = 0.15 + r() * 0.25; if (hi === 4 || hi === 5) v += 0.45; if (hi === 3) v += 0.15; if (hi === 0) v -= 0.05; if (di === 1 || di === 3) v += 0.15; if (di === 5) v -= 0.1;
      v = Math.max(0.05, Math.min(1, v));
      const c = h('div', 'cell'); const i = h('i'); i.style.opacity = (0.08 + v * 0.92).toFixed(2); c.appendChild(i); c.title = d + ' ' + hr + ':00 · ' + pct(v) + ' de tus seguidores conectados';
      c.addEventListener('pointermove', (ev) => showTooltip(ev.clientX, ev.clientY, ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'][di] + ' ' + hr + ':00', [{ value: pct(v), label: 'seguidores conectados' }]));
      c.addEventListener('pointerleave', hideTooltip);
      heat.appendChild(c); cells.push(c); if (v > bestV) { bestV = v; best = c; }
    });
  });
  best.classList.add('best');
}

/* ---------- render: mis videos ---------- */
const vstate = { red: 'all', ord: 'score' };
function renderVideos() {
  const el = document.getElementById('tbl-videos'); el.textContent = '';
  let rows = VIDEOS.filter((v) => vstate.red === 'all' || v.net === vstate.red);
  rows = rows.slice().sort((a, b) => vstate.ord === 'score' ? b.score - a.score : vstate.ord === 'views' ? b.views - a.views : a.d - b.d);
  const table = h('table'); const thead = h('thead'); const trh = h('tr');
  [['Video'], ['Views', 'num'], ['× mediana', 'num'], ['Salto 3 s', 'num'], ['Guardados / 1 000', 'num'], ['No seguidores', 'num'], ['Hook'], ['Duración', 'num']].forEach((c) => trh.appendChild(h('th', c[1], c[0])));
  thead.appendChild(trh); table.appendChild(thead); const tb = h('tbody');
  for (const v of rows) {
    const tr = h('tr');
    const td = h('td'); td.appendChild(h('div', 'cell-main', v.t)); const sub = h('div', 'cell-sub'); sub.appendChild(chipNet(v.net)); sub.appendChild(document.createTextNode(' · hace ' + v.d + ' d')); td.appendChild(sub); tr.appendChild(td);
    tr.appendChild(h('td', 'num', nf(v.views)));
    const ts = h('td', 'num'); const w = h('div', 'minibar-wrap'); const mb = h('div', 'minibar'); const fi = h('i'); fi.style.width = Math.min(100, (v.score / 5) * 100) + '%'; if (v.score < 2) fi.className = 'dim'; mb.appendChild(fi); w.appendChild(mb);
    if (v.score >= 2) w.appendChild(pillEl(dec(v.score) + '×', 'accent')); else w.appendChild(h('span', null, dec(v.score) + '×')); ts.appendChild(w); tr.appendChild(ts);
    tr.appendChild(h('td', 'num', v.skip === null ? '—' : pct(v.skip)));
    tr.appendChild(h('td', 'num', dec(v.saves)));
    tr.appendChild(h('td', 'num', pct(v.nofol)));
    tr.appendChild(h('td', null, v.hook));
    tr.appendChild(h('td', 'num', v.dur + ' s'));
    tb.appendChild(tr);
  }
  table.appendChild(tb); el.appendChild(table);
}
function renderTraits() {
  const names = ['Outliers (≥ 2×)', 'Resto'];
  legend(document.getElementById('lg-traits'), [{ name: names[0], color: 'var(--accent)' }, { name: names[1], color: 'var(--deemph)' }], 'rect');
  pairedBars(document.getElementById('c-traits'), { rows: TRAITS, names, colors: ['var(--accent)', 'var(--deemph)'], aria: 'Rasgos de outliers frente al resto' });
  const labels = []; for (let i = 0; i <= 14; i++) labels.push('Día ' + i);
  const med = [0, 9, 17, 22, 26, 29, 31, 33, 34, 35, 36, 37, 37, 38, 38].map((v) => v * 1000);
  const out = [0, 61, 148, 231, 298, 341, 372, 389, 398, 404, 408, 410, 411, 412, 412].map((v) => v * 1000);
  const s = [{ name: 'La arepa sin plancha', color: 'var(--accent)', data: out }, { name: 'Tu mediana', color: 'var(--deemph)', data: med, dashed: true }];
  legend(document.getElementById('lg-growth'), s, 'line');
  lineChart(document.getElementById('c-growth'), { series: s, labels, tableEl: document.getElementById('t-growth'), tableHead: 'Día', rightPad: 140, aria: 'Views acumuladas por día', ttFmt: (v) => fmtInt.format(v) });
}

/* ---------- render: nicho ---------- */
function renderNicho() {
  const w = document.getElementById('watch');
  for (const a of WATCH) { const s = h('span', 'w'); const i = h('i'); i.style.background = NET[a.net].color; s.appendChild(i); s.appendChild(document.createTextNode(a.n)); if (a.f) s.appendChild(h('span', 'n', nf(a.f))); const b = h('button', null, '×'); b.type = 'button'; b.setAttribute('aria-label', 'Quitar ' + a.n); s.appendChild(b); w.appendChild(s); }
  const el = document.getElementById('tbl-nicho'); const table = h('table'); const thead = h('thead'); const trh = h('tr');
  [['Video'], ['Views', 'num'], ['× mediana de su cuenta', 'num'], ['Hook'], ['Duración', 'num'], ['Sonido'], ['Edad', 'num']].forEach((c) => trh.appendChild(h('th', c[1], c[0])));
  thead.appendChild(trh); table.appendChild(thead); const tb = h('tbody');
  for (const v of NICHE) {
    const tr = h('tr'); const td = h('td'); td.appendChild(h('div', 'cell-main', v.t)); const sub = h('div', 'cell-sub'); sub.appendChild(chipNet(v.net, v.acc)); td.appendChild(sub); tr.appendChild(td);
    tr.appendChild(h('td', 'num', nf(v.views)));
    const ts = h('td', 'num'); const wr = h('div', 'minibar-wrap'); const mb = h('div', 'minibar'); const fi = h('i'); fi.style.width = Math.min(100, (v.score / 7) * 100) + '%'; mb.appendChild(fi); wr.appendChild(mb); wr.appendChild(pillEl(dec(v.score) + '×', 'accent')); ts.appendChild(wr); tr.appendChild(ts);
    tr.appendChild(h('td', null, v.hook)); tr.appendChild(h('td', 'num', v.dur + ' s')); tr.appendChild(h('td', null, v.sound)); tr.appendChild(h('td', 'num', v.age + ' d'));
    tb.appendChild(tr);
  }
  table.appendChild(tb); el.appendChild(table);
  const lf = document.getElementById('lifts'); const maxL = Math.max(...LIFTS.map((l) => l.v));
  for (const l of LIFTS) { const li = h('li'); li.appendChild(h('span', null, l.label)); const bar = h('div', 'bar'); const i = h('i'); i.style.width = (l.v / maxL) * 100 + '%'; if (l.v < 1) i.className = 'neg'; bar.appendChild(i); li.appendChild(bar); li.appendChild(h('span', 'v' + (l.v < 1 ? ' neg' : ''), dec(l.v) + '×')); lf.appendChild(li); }
  const sn = document.getElementById('sounds'); const maxS = Math.max(...SOUNDS.map((s) => Math.abs(s.v)));
  for (const s of SOUNDS) { const li = h('li'); li.appendChild(h('span', null, s.label)); const bar = h('div', 'bar'); const i = h('i'); i.style.width = (Math.abs(s.v) / maxS) * 100 + '%'; if (s.v < 0) i.className = 'neg'; bar.appendChild(i); li.appendChild(bar); li.appendChild(h('span', 'v' + (s.v < 0 ? ' neg' : ''), (s.v >= 0 ? '+' : '−') + pct(Math.abs(s.v)))); sn.appendChild(li); }
}

/* ---------- render: ideas ---------- */
let ideaSel = 0;
function renderIdeas() {
  const el = document.getElementById('ideas'); el.textContent = '';
  for (const idea of IDEAS) {
    const c = h('div', 'idea'); c.setAttribute('role', 'button'); c.tabIndex = 0; c.setAttribute('aria-pressed', String(idea.id === ideaSel));
    c.appendChild(h('h3', null, idea.title));
    const meta = h('div', 'meta'); meta.appendChild(h('span', 'tag', idea.fmt)); for (const n of idea.nets) meta.appendChild(chipNet(n)); c.appendChild(meta);
    const m = h('div', 'meter'); const tr = h('div', 'track'); const i = h('i'); i.style.width = idea.score + '%'; tr.appendChild(i); m.appendChild(tr); m.appendChild(h('b', null, String(idea.score))); m.appendChild(h('small', null, 'prob. de superar 2× tu mediana')); c.appendChild(m);
    const why = h('ul', 'why'); for (const w of idea.why) { const li = h('li'); li.appendChild(h('span', 'src src-' + w[0], w[0] === 'in' ? 'Tuyo' : 'Nicho')); li.appendChild(h('span', null, w[1])); why.appendChild(li); } c.appendChild(why);
    const sel = () => { ideaSel = idea.id; renderIdeas(); };
    c.addEventListener('click', sel); c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); sel(); } });
    el.appendChild(c);
  }
  const cur = IDEAS[ideaSel];
  document.getElementById('script-title').textContent = cur.title;
  const bl = document.getElementById('blocks'); bl.textContent = '';
  if (ideaSel === 0) {
    SCRIPT.forEach((b, i) => {
      const d = h('div', 'block ' + b.role); const bh = h('div', 'bh'); bh.appendChild(h('b', null, 'Bloque ' + (i + 1))); bh.appendChild(document.createTextNode((i * 10) + '–' + ((i + 1) * 10) + ' s')); bh.appendChild(h('span', 'role', b.role)); d.appendChild(bh);
      d.appendChild(h('div', 'line', b.line)); d.appendChild(h('div', 'planos', b.planos));
      const wc = b.line.split(/\s+/).length; d.appendChild(h('div', 'wc' + (wc >= 20 && wc <= 23 ? ' ok' : ''), wc + ' palabras'));
      bl.appendChild(d);
    });
  } else {
    const d = h('div', 'block build'); d.style.gridColumn = '1 / -1'; d.appendChild(h('div', 'line', 'El guion de esta idea se genera al seleccionarla. En el producto real tarda unos segundos y sale con la misma rejilla de 9 bloques, ajustada a ' + cur.fmt.split(' · ')[1] + '.')); bl.appendChild(d);
  }
  const kv = document.getElementById('publish-kv'); kv.textContent = '';
  const pairs = ideaSel === 0 ? [
    ['TikTok', 'Completo, 90 s, con "cocina lo-fi 02". Subtítulo karaoke en el tercio medio.'],
    ['Instagram Reel', '60 s: bloques 1 a 6 y 9. Texto fijo arriba: SIN PLANCHA.'],
    ['YouTube Short', 'Completo, 90 s. Título: "Arepa sin plancha en tres minutos".'],
    ['Cuándo', 'Jueves 17 sep, 19:30. Pico de seguidores conectados; TikTok primero, Reel una hora después.'],
    ['Objeto que atraviesa', 'La arepa: harina, bola, disco, cocida, dorada, rellena, comparada, servida.'],
    ['Antes de grabar', 'Grabar la voz primero y medirla. Nunca acelerar el audio para que quepa.'],
  ] : [['Red principal', NET[cur.nets[0]].name], ['Formato', cur.fmt], ['Cuándo', 'Martes o jueves, 19:00 a 21:00']];
  for (const p of pairs) { kv.appendChild(h('dt', null, p[0])); kv.appendChild(h('dd', null, p[1])); }
}

/* ---------- render: cotizar ---------- */
function renderCotizar() {
  const el = document.getElementById('tbl-rates'); const table = h('table'); const thead = h('thead'); const trh = h('tr');
  [['Entregable'], ['Base de cálculo'], ['Rango sugerido', 'num'], ['Estado']].forEach((c) => trh.appendChild(h('th', c[1], c[0])));
  thead.appendChild(trh); table.appendChild(thead); const tb = h('tbody');
  RATES.forEach((r, i) => {
    const tr = h('tr'); tr.appendChild(h('td', 'cell-main', r.e)); tr.appendChild(h('td', 'cell-sub', r.base));
    tr.appendChild(h('td', 'num', r.lo ? cop(r.lo) + ' – ' + cop(r.hi) : r.base.split(' ')[0]));
    const ts = h('td'); ts.appendChild(i === 2 ? pillEl('Editado por ti', 'accent') : pillEl('Sugerido', 'muted')); tr.appendChild(ts);
    tb.appendChild(tr);
  });
  table.appendChild(tb); el.appendChild(table);
  const kv = document.getElementById('mediakit-kv');
  for (const p of [['Seguidores', '412 K en 4 redes'], ['Views promedio', 'TikTok 138 K · Reel 92 K · Short 41 K'], ['Engagement', '6,8 % (media del nicho: 4,1 %)'], ['Países', 'Colombia 71 % · México 11 % · EE. UU. 6 %'], ['Mujeres / hombres', '64 % / 36 %'], ['Última campaña', 'Café Alma: 712 K views, +1 240 seguidores para la marca']]) { kv.appendChild(h('dt', null, p[0])); kv.appendChild(h('dd', null, p[1])); }
  const da = document.getElementById('demo-age');
  for (const a of [['18–24', 0.24], ['25–34', 0.41], ['35–44', 0.22], ['45–54', 0.09], ['55+', 0.04]]) { const r = h('div', 'r'); r.appendChild(h('span', null, a[0])); const b = h('div', 'b'); const i = h('i'); i.style.width = (a[1] / 0.41) * 100 + '%'; b.appendChild(i); r.appendChild(b); r.appendChild(h('span', 'v', pct(a[1]))); da.appendChild(r); }
}

/* ---------- render: campañas ---------- */
function renderCampanas() {
  const el = document.getElementById('tbl-camps'); const table = h('table'); const thead = h('thead'); const trh = h('tr');
  [['Marca'], ['Entregables'], ['Fechas'], ['Estado'], ['Views', 'num'], ['Ventas atribuidas']].forEach((c) => trh.appendChild(h('th', c[1], c[0])));
  thead.appendChild(trh); table.appendChild(thead); const tb = h('tbody');
  for (const c of CAMPS) { const tr = h('tr'); tr.appendChild(h('td', 'cell-main', c.b)); tr.appendChild(h('td', null, c.d)); tr.appendChild(h('td', null, c.f)); const ts = h('td'); ts.appendChild(pillEl(c.st[0], c.st[1])); tr.appendChild(ts); tr.appendChild(h('td', 'num', nf(c.views))); tr.appendChild(h('td', null, c.sales)); tb.appendChild(tr); }
  table.appendChild(tb); el.appendChild(table);
  kpis(document.getElementById('kpis-camp'), [
    { label: 'Alcance', value: '486 K', note: '1,8× tu alcance habitual' },
    { label: 'Views', value: '712 K', note: '58 % en no seguidores' },
    { label: 'Clics al enlace', value: '6 240', note: '0,9 % de las views' },
    { label: 'Canjes LAURA15', value: '318', note: 'COP 8,4 M en ventas' },
    { label: 'Seguidores para la marca', value: '+1 240', note: '12× su ritmo normal' },
    { label: 'CPM real', value: 'COP 11 800', note: 'CPA COP 26 400' },
  ]);
  const labels = []; const data = []; const r = rng(5); let v = 18200;
  for (let d = 0; d < 60; d++) { labels.push(fmtDate(daysAgo(59 - d))); const inWin = d >= 37 && d <= 44; v += inWin ? 150 + r() * 60 : d > 44 ? 22 + r() * 8 : 12 + r() * 6; data.push(Math.round(v)); }
  const base = data.map((_, d) => Math.round(18200 + d * 15));
  lineChart(document.getElementById('c-brand'), { series: [{ name: '@cafealma', color: 'var(--accent)', data }, { name: 'Ritmo previo', color: 'var(--deemph)', data: base, dashed: true }], labels, tableEl: document.getElementById('t-brand'), fromZero: false, rightPad: 110, shade: { from: 37, to: 44, label: 'Campaña 24–31 ago' }, aria: 'Seguidores de la marca durante la campaña', ttFmt: (v) => fmtInt.format(v) });
  const ck = document.getElementById('camp-checks');
  for (const c of CHECKS) { const li = h('li'); li.appendChild(h('span', 'ck ' + (c[0] ? 'on' : 'off'), c[0] ? '✓' : '!')); const d = h('div'); d.appendChild(document.createTextNode(c[1])); d.appendChild(h('small', null, c[2])); li.appendChild(d); ck.appendChild(li); }
}

/* ---------- render: ventas ---------- */
const vsState = { tab: 'radar', co: 'Fresko Market' };
function el(id) { return document.getElementById(id); }
function dueLabel(d) { if (d === null || d === undefined) return ['sin fecha', '']; if (d === 0) return ['hoy', 'today']; if (d === 1) return ['mañana', '']; if (d < 0) return ['vencido hace ' + (-d) + ' d', 'late']; return [fmtDate(daysAgo(-d)), '']; }
function showVsTab(t) { vsState.tab = t; for (const x of ['radar', 'pipeline', 'empresa']) el('vs-' + x).hidden = x !== t; for (const b of el('vs-tabs').children) b.setAttribute('aria-pressed', String(b.dataset.v === t)); }
function renderVentas() {
  const open = DEALS.filter((d) => d.stage !== 'ganado');
  const openV = open.reduce((a, d) => a + d.v, 0);
  const weighted = open.reduce((a, d) => a + d.v * STG[d.stage].p, 0);
  const won = DEALS.filter((d) => d.stage === 'ganado'); const wonV = won.reduce((a, d) => a + d.v, 0);
  const pending = SIGNALS.filter((x) => x.st === 'pending').length;
  const late = open.filter((d) => d.due !== null && d.due < 0).length;
  kpis(el('kpis-ventas'), [
    { label: 'Señales esta semana', value: '37', note: pending + ' por revisar' },
    { label: 'Deals abiertos', value: String(open.length), note: cop(openV) + ' en pipeline' },
    { label: 'Cierre ponderado', value: cop(weighted), note: 'valor × probabilidad de la etapa' },
    { label: 'Ganado en Q3', value: cop(wonV), note: won.length + ' deals · ciclo medio 19 días' },
    { label: 'Tasa de respuesta', value: '34 %', delta: 0.06, vs: 'vs. Q2' },
    { label: 'Seguimientos vencidos', value: String(late), note: late ? 'atender hoy' : 'al día' },
  ]);
  el('pipe-sub').textContent = open.length + ' deals abiertos · ' + cop(openV) + ' · ponderado ' + cop(weighted);
  renderRadar(); renderPipeline(); renderEmpresa(); showVsTab(vsState.tab);
}
function renderRadar() {
  const t = el('tbl-signals'); t.textContent = '';
  const table = h('table'); const thead = h('thead'); const trh = h('tr');
  [['Empresa'], ['Señal'], ['Fuente'], ['Encaje', 'num'], ['Presupuesto est.', 'num'], ['Acción']].forEach((c) => trh.appendChild(h('th', c[1], c[0])));
  thead.appendChild(trh); table.appendChild(thead); const tb = h('tbody');
  const order = { pending: 0, inpipe: 1, discarded: 2 };
  for (const sg of SIGNALS.slice().sort((a, b) => order[a.st] - order[b.st] || b.fit - a.fit)) {
    const tr = h('tr'); const td = h('td'); td.appendChild(h('div', 'cell-main', sg.co)); td.appendChild(h('div', 'cell-sub', sg.when)); tr.appendChild(td);
    tr.appendChild(h('td', null, sg.sig)); tr.appendChild(h('td', 'cell-sub', sg.src));
    const tf = h('td', 'num'); const w = h('div', 'minibar-wrap'); const mb = h('div', 'minibar'); const i = h('i'); i.style.width = sg.fit * 100 + '%'; if (sg.fit < 0.6) i.className = 'dim'; mb.appendChild(i); w.appendChild(mb); w.appendChild(h('span', null, pct(sg.fit))); tf.appendChild(w); tr.appendChild(tf);
    tr.appendChild(h('td', 'num', cop(sg.budget)));
    const ta = h('td');
    if (sg.st === 'pending') {
      const ac = h('div', 'actions'); ac.style.marginTop = '0';
      const b1 = h('button', 'btn', 'Al pipeline'); b1.type = 'button'; b1.addEventListener('click', () => { sg.st = 'inpipe'; DEALS.unshift({ co: sg.co, deal: 'Por definir', stage: 'nuevo', v: sg.budget, next: 'Enviar pitch', due: 0, touch: 'Radar · ' + sg.when, src: sg.sig, fit: sg.fit }); renderVentas(); });
      const b2 = h('button', 'btn', 'Descartar'); b2.type = 'button'; b2.addEventListener('click', () => { sg.st = 'discarded'; sg.why = 'descartada por ti'; renderVentas(); });
      ac.appendChild(b1); ac.appendChild(b2); ta.appendChild(ac);
    } else if (sg.st === 'inpipe') ta.appendChild(pillEl('En pipeline', 'accent'));
    else ta.appendChild(pillEl('Descartada · ' + sg.why, 'muted'));
    tr.appendChild(ta); tb.appendChild(tr);
  }
  table.appendChild(tb); t.appendChild(table);
  const so = el('tbl-sources'); so.textContent = '';
  const t2 = h('table'); const th2 = h('thead'); const tr2 = h('tr');
  [['Fuente'], ['Alcance'], ['Señales', 'num'], ['Estado']].forEach((c) => tr2.appendChild(h('th', c[1], c[0]))); th2.appendChild(tr2); t2.appendChild(th2); const tb2 = h('tbody');
  for (const f of SOURCES) { const tr = h('tr'); tr.appendChild(h('td', 'cell-main', f[0])); tr.appendChild(h('td', 'cell-sub', f[1])); tr.appendChild(h('td', 'num', String(f[2]))); const st = h('td'); st.appendChild(pillEl(f[3], f[3] === 'Activa' ? 'good' : 'muted')); tr.appendChild(st); tb2.appendChild(tr); }
  t2.appendChild(tb2); so.appendChild(t2);
  el('pitch').textContent = 'Hola, equipo de Delicias del Campo.\n\nSoy Laura, hago cocina fácil para 412 mil personas en Colombia, el 71 % entre 18 y 34 años. Vi que desde el 14 de septiembre están pautando alimentos en Meta y que su audiencia se parece a la mía en un 72 %.\n\nEn mi última campaña con Café Alma, un reel y un TikTok generaron 712 mil views, 318 compras con código y 1 240 seguidores nuevos para la marca en una semana.\n\nLes propongo un paquete de 1 TikTok, 1 Reel y 3 historias con código propio y enlace rastreado, para que midan cada venta. Adjunto media kit y cotización.';
}
function renderPipeline() {
  const k = el('c-pipe'); k.textContent = '';
  for (const st of STAGES) {
    const col = h('div', 'col'); const head = h('div', 'col-h'); head.appendChild(document.createTextNode(st.name));
    const deals = DEALS.filter((d) => d.stage === st.id); head.appendChild(h('span', 'cnt', String(deals.length)));
    head.appendChild(h('span', 'sum', cop(deals.reduce((a, d) => a + d.v, 0)))); col.appendChild(head);
    for (const d of deals) {
      const c = h('div', 'deal'); c.setAttribute('role', 'button'); c.tabIndex = 0;
      c.appendChild(h('b', null, d.co)); c.appendChild(h('span', 'src', d.deal));
      c.appendChild(h('span', 'val', cop(d.v) + (st.id !== 'ganado' ? ' · ' + pct(st.p) : '')));
      const [lbl, cls] = dueLabel(d.due); c.appendChild(h('span', 'next ' + cls, d.next + ' · ' + lbl));
      const go = () => { vsState.co = d.co; renderEmpresa(); showVsTab('empresa'); };
      c.addEventListener('click', go); c.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      col.appendChild(c);
    }
    k.appendChild(col);
  }
  const t = el('t-pipe'); t.textContent = '';
  const table = h('table'); const thead = h('thead'); const trh = h('tr');
  [['Empresa'], ['Deal'], ['Etapa'], ['Valor', 'num'], ['Prob.', 'num'], ['Siguiente acción'], ['Vence'], ['Fuente']].forEach((c) => trh.appendChild(h('th', c[1], c[0])));
  thead.appendChild(trh); table.appendChild(thead); const tb = h('tbody');
  for (const d of DEALS) { const tr = h('tr'); tr.appendChild(h('td', 'cell-main', d.co)); tr.appendChild(h('td', null, d.deal)); tr.appendChild(h('td', null, STG[d.stage].name)); tr.appendChild(h('td', 'num', cop(d.v))); tr.appendChild(h('td', 'num', pct(STG[d.stage].p))); tr.appendChild(h('td', null, d.next)); const [lbl, cls] = dueLabel(d.due); tr.appendChild(h('td', cls === 'late' ? 'delta-cell down' : null, lbl)); tr.appendChild(h('td', 'cell-sub', d.src)); tb.appendChild(tr); }
  table.appendChild(tb); t.appendChild(table);
}
function renderEmpresa() {
  const d = DEALS.find((x) => x.co === vsState.co) || DEALS[0];
  const co = COMPANIES[d.co];
  el('co-name').textContent = d.co;
  el('co-sub').textContent = co ? co.sub : 'Detectada por el radar · ' + d.src;
  const stg = el('co-stage'); stg.textContent = ''; stg.appendChild(pillEl(STG[d.stage].name, d.stage === 'ganado' ? 'good' : d.stage === 'nuevo' ? 'muted' : 'accent'));
  const kv = el('co-kv'); kv.textContent = ''; const [lbl] = dueLabel(d.due);
  for (const p of [['Deal', d.deal], ['Valor', cop(d.v)], ['Probabilidad', pct(STG[d.stage].p)], ['Cierre esperado', co ? co.close : 'por definir'], ['Encaje', pct(d.fit)], ['Fuente', d.src], ['Último contacto', d.touch]]) { kv.appendChild(h('dt', null, p[0])); kv.appendChild(h('dd', null, p[1])); }
  const ch = el('co-chain'); ch.textContent = '';
  const steps = co ? co.chain : [['Deal', d.stage !== 'nuevo'], ['Cotización', ['propuesta', 'negociacion', 'ganado'].includes(d.stage)], ['Campaña', d.stage === 'ganado'], ['Factura', d.stage === 'ganado'], ['Cobro', d.next === 'Cobrada']];
  steps.forEach((s, i) => { if (i) ch.appendChild(h('span', 'arr', '→')); ch.appendChild(h('span', 'step' + (s[1] ? ' done' : ''), s[0])); });
  const tl = el('co-timeline'); tl.textContent = '';
  const items = co ? co.timeline : [['Radar', 'Detectada: ' + d.src + '.', false], ['Ahora', 'Etapa ' + STG[d.stage].name + ' · ' + d.next + ' · ' + lbl + '.', true]];
  for (const it of items) { const li = h('li', it[2] ? 'now' : null); li.appendChild(h('span', 'when', it[0])); li.appendChild(document.createTextNode(it[1])); tl.appendChild(li); }
  const tc = el('tbl-contacts'); tc.textContent = '';
  if (co && co.contacts.length) {
    const table = h('table'); const thead = h('thead'); const trh = h('tr'); ['Nombre', 'Rol', 'Canal', 'Último contacto'].forEach((c) => trh.appendChild(h('th', null, c))); thead.appendChild(trh); table.appendChild(thead); const tb = h('tbody');
    for (const c of co.contacts) { const tr = h('tr'); tr.appendChild(h('td', 'cell-main', c[0])); tr.appendChild(h('td', null, c[1])); tr.appendChild(h('td', null, c[2])); tr.appendChild(h('td', 'cell-sub', c[3])); tb.appendChild(tr); }
    table.appendChild(tb); tc.appendChild(table);
  } else tc.appendChild(h('div', 'chart-note', 'Sin contactos todavía. El pitch va al correo público o al DM de la marca; el primero que responda queda registrado aquí.'));
  el('co-next-when').textContent = lbl.charAt(0).toUpperCase() + lbl.slice(1);
  el('co-next').textContent = d.next + (co ? ' · ' + co.nextDetail : '');
  el('co-next-tip').textContent = co ? co.nextTip : 'El pitch se arma con la señal del radar, tu media kit y tu última campaña.';
  const seq = el('co-seq'); seq.textContent = '';
  for (const s of (co ? co.seq : DEFAULT_SEQ)) { const li = h('li'); li.appendChild(h('span', 'ck ' + (s[0] ? 'on' : 'off'), s[0] ? '✓' : '·')); const dv = h('div'); dv.appendChild(document.createTextNode(s[1])); dv.appendChild(h('small', null, s[2])); li.appendChild(dv); seq.appendChild(li); }
  const facts = el('co-facts'); facts.textContent = '';
  for (const f of (co ? co.facts : [['Señal', d.src], ['Encaje', pct(d.fit) + ' de coincidencia de audiencia con la marca.']])) { const li = h('li'); li.appendChild(h('span', 'src src-in', f[0])); li.appendChild(h('span', null, f[1])); facts.appendChild(li); }
}

/* ---------- render: finanzas ---------- */
function renderFinanzas() {
  kpis(document.getElementById('kpis-fin'), [
    { label: 'Por cobrar', value: 'COP 9,4 M', note: '3 facturas' }, { label: 'Vencido', value: 'COP 1,1 M', note: '1 factura · 41 días' },
    { label: 'Cobrado en 2026', value: 'COP 38,6 M', delta: 0.31, vs: 'vs. mismo período 2025' }, { label: 'Apartado para impuestos', value: 'COP 4,2 M', note: '11 % de cada cobro' },
  ]);
  const el = document.getElementById('tbl-cxc'); const table = h('table'); const thead = h('thead'); const trh = h('tr');
  [['Marca'], ['Campaña'], ['Monto', 'num'], ['Vence'], ['Estado'], ['Acción']].forEach((c) => trh.appendChild(h('th', c[1], c[0])));
  thead.appendChild(trh); table.appendChild(thead); const tb = h('tbody');
  for (const c of CXC) {
    const tr = h('tr'); tr.appendChild(h('td', 'cell-main', c.b)); tr.appendChild(h('td', 'cell-sub', c.c)); tr.appendChild(h('td', 'num', cop(c.m))); tr.appendChild(h('td', null, c.v));
    const st = h('td'); st.appendChild(pillEl(c.st[0], c.st[1])); tr.appendChild(st);
    const ac = h('td'); const b = h('button', 'btn', c.days < 0 ? 'Enviar recordatorio' : 'Adelantar'); b.type = 'button'; ac.appendChild(b); tr.appendChild(ac); tb.appendChild(tr);
  }
  table.appendChild(tb); el.appendChild(table);
  const kv = document.getElementById('adv-kv');
  for (const p of [['Disponible hoy', 'COP 6,8 M'], ['Sobre', 'Fresko Market (COP 5,2 M) y Café Alma (COP 3,1 M)'], ['Fee', '2,5 % por 30 días'], ['Recibes', 'COP 6,63 M mañana'], ['Se salda', 'Cuando la marca pague']]) { kv.appendChild(h('dt', null, p[0])); kv.appendChild(h('dd', null, p[1])); }
  const cats = ['S38', 'S39', 'S40', 'S41', 'S42', 'S43', 'S44', 'S45'];
  const s = [
    { name: 'Cobros esperados', color: 'var(--accent)', data: [3.1e6, 0, 5.2e6, 0, 2.6e6, 1.8e6, 0, 5.0e6] },
    { name: 'Gastos e impuestos', color: 'var(--deemph)', data: [1.4e6, 1.1e6, 1.7e6, 1.1e6, 1.4e6, 1.3e6, 1.1e6, 1.6e6] },
  ];
  legend(document.getElementById('lg-cash'), s, 'rect');
  barChart(document.getElementById('c-cash'), { cats, series: s, mode: 'group', tableEl: document.getElementById('t-cash'), tableHead: 'Semana', yFmt: (v) => v >= 1e6 ? dec(v / 1e6, 0) + ' M' : '0', ttFmt: cop, aria: 'Flujo de caja proyectado' });
}

/* ---------- render: agencia ---------- */
function renderAgencia() {
  const el = document.getElementById('tbl-agencia'); const table = h('table'); const thead = h('thead'); const trh = h('tr');
  [['Marca cliente'], ['CM'], ['Cuentas'], ['Posts del mes', 'num'], ['Alcance del mes', 'num'], ['Reporte'], ['Estado']].forEach((c) => trh.appendChild(h('th', c[1], c[0])));
  thead.appendChild(trh); table.appendChild(thead); const tb = h('tbody');
  for (const a of AGENCY) { const tr = h('tr'); tr.appendChild(h('td', 'cell-main', a.b)); tr.appendChild(h('td', null, a.cm)); tr.appendChild(h('td', 'cell-sub', a.accs)); tr.appendChild(h('td', 'num', String(a.posts))); tr.appendChild(h('td', 'num', nf(a.reach))); tr.appendChild(h('td', null, a.rep)); const st = h('td'); st.appendChild(pillEl(a.st[0], a.st[1])); tr.appendChild(st); tb.appendChild(tr); }
  table.appendChild(tb); el.appendChild(table);
  const ap = document.getElementById('tbl-aprob'); const t2 = h('table'); const th2 = h('thead'); const tr2 = h('tr');
  ['Marca', 'Pieza', 'Publica', 'Estado'].forEach((c) => tr2.appendChild(h('th', null, c))); th2.appendChild(tr2); t2.appendChild(th2); const tb2 = h('tbody');
  for (const a of APROB) { const tr = h('tr'); tr.appendChild(h('td', 'cell-main', a.b)); tr.appendChild(h('td', null, a.it)); tr.appendChild(h('td', null, a.due)); const st = h('td'); st.appendChild(pillEl(a.st[0], a.st[1])); tr.appendChild(st); tb2.appendChild(tr); }
  t2.appendChild(tb2); ap.appendChild(t2);
  const kv = document.getElementById('rep-kv');
  for (const p of [['Frecuencia', 'Mensual el día 1 · semanal para Nutrivé'], ['Canal', 'Correo con enlace y PDF · WhatsApp para Dulce Hogar'], ['Marca blanca', 'Logo y colores de Norte Creativo'], ['Contenido', 'Alcance, views, crecimiento, top 5 posts, campañas del mes, próximos pasos'], ['Portal del cliente', 'Activo para 4 de 5 marcas']]) { kv.appendChild(h('dt', null, p[0])); kv.appendChild(h('dd', null, p[1])); }
}

/* ---------- navegación ---------- */
const PANELS = ['resumen', 'videos', 'nicho', 'ideas', 'cotizar', 'campanas', 'ventas', 'finanzas', 'agencia'];
const rendered = {};
function showPanel(id) {
  for (const p of PANELS) document.getElementById('p-' + p).hidden = p !== id;
  for (const b of document.querySelectorAll('.nav-btn')) { if (b.dataset.p === id) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current'); }
  if (!rendered[id]) { rendered[id] = true; ({ resumen: renderResumen, videos: () => { renderVideos(); renderTraits(); }, nicho: renderNicho, ideas: renderIdeas, cotizar: renderCotizar, campanas: renderCampanas, ventas: renderVentas, finanzas: renderFinanzas, agencia: renderAgencia })[id](); }
  try { history.replaceState(null, '', '#' + id); } catch (e) {}
  window.scrollTo({ top: 0, behavior: 'auto' });
}
document.getElementById('nav').addEventListener('click', (e) => { const b = e.target.closest('.nav-btn'); if (b) showPanel(b.dataset.p); });
document.addEventListener('click', (e) => {
  const t = e.target.closest('.toggle-view'); if (!t) return;
  const id = t.dataset.toggle; const chart = document.getElementById(id); const table = document.getElementById('t-' + id.slice(2));
  const showTable = !chart.hidden; chart.hidden = showTable; table.hidden = !showTable; const lb = (t.dataset.labels || 'Ver tabla|Ver gráfico').split('|'); t.textContent = showTable ? lb[1] : lb[0];
});
document.getElementById('vs-tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) showVsTab(b.dataset.v); });
for (const seg of [['f-red', 'red'], ['f-ord', 'ord']]) {
  document.getElementById(seg[0]).addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; for (const x of b.parentNode.children) x.setAttribute('aria-pressed', String(x === b)); vstate[seg[1]] = b.dataset.v; renderVideos(); });
}
renderNets();
const initial = (location.hash || '').slice(1);
showPanel(PANELS.includes(initial) ? initial : 'resumen');
let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { for (const p of Object.keys(rendered)) delete rendered[p]; const cur = PANELS.find((p) => !document.getElementById('p-' + p).hidden); for (const p of PANELS) { const el = document.getElementById('p-' + p); for (const box of el.querySelectorAll('.chart-box, .kpis, .insights, .heat, .watch, .table-scroll, .lifts, .grid-3, .blocks, .kv, .demo-bars, .checks, .kanban, .timeline, .chain, .why')) box.textContent = ''; } showPanel(cur); }, 180); });

/* ---------- tema (claro / oscuro) ---------- */
const themeBtn = document.getElementById('theme-btn');
const root = document.documentElement;
function isDark() { const t = root.getAttribute('data-theme'); return t === 'dark' || (!t && window.matchMedia('(prefers-color-scheme: dark)').matches); }
function applyTheme(t) { if (t) root.setAttribute('data-theme', t); else root.removeAttribute('data-theme'); themeBtn.textContent = isDark() ? 'Claro' : 'Oscuro'; }
let theme = null; try { theme = localStorage.getItem('mc-theme'); } catch (e) {}
applyTheme(theme);
themeBtn.addEventListener('click', () => { theme = isDark() ? 'light' : 'dark'; try { localStorage.setItem('mc-theme', theme); } catch (e) {} applyTheme(theme); });

/* ---------- estilo visual (Geist / Signal / Studio) ---------- */
const STYLES = { geist: 'styles.css', signal: 'theme-signal.css', studio: 'theme-studio.css' };
const styleSeg = document.getElementById('style-seg');
function applyStyle(k) { if (!STYLES[k]) k = 'geist'; document.getElementById('theme-css').setAttribute('href', STYLES[k]); for (const b of styleSeg.children) b.setAttribute('aria-pressed', String(b.dataset.v === k)); }
let styleKey = 'geist'; try { styleKey = localStorage.getItem('mc-style') || 'geist'; } catch (e) {}
applyStyle(styleKey);
styleSeg.addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; styleKey = b.dataset.v; try { localStorage.setItem('mc-style', styleKey); } catch (e2) {} applyStyle(styleKey); });

