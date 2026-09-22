#!/usr/bin/env python3
"""Regenera dashboard/local/index.html y app.js a partir de creadores-mock.html (el Artifact).
La hoja de estilos local (styles.css) se mantiene a mano: es la versión minimal Vercel/Notion."""
import os, re
here = os.path.dirname(os.path.abspath(__file__))
src = open(os.path.join(here, "creadores-mock.html"), encoding="utf-8").read()

a = src.index('<div class="wrap">')
tt = '<div class="tooltip" id="tooltip" role="status"></div>'
b = src.index(tt) + len(tt)
markup = src[a:b]
old_header = re.search(r'  <header>.*?</header>\n', markup, re.S).group(0)
new_header = '''  <header>
    <span class="wordmark"><span class="dot-grid"><i></i><i></i><i></i><i></i></span>On Cue</span>
    <span class="module">Creadores</span>
    <span class="mock-badge">Datos de ejemplo</span>
    <span class="sync">Sincronizado hoy 06:10 · 16 sep 2026</span>
    <div class="seg style-seg" id="style-seg" aria-label="Estilo visual"><button data-v="geist" aria-pressed="true">Geist</button><button data-v="signal">Signal</button><button data-v="studio">Studio</button></div>
    <button class="theme-btn" id="theme-btn" type="button" aria-label="Cambiar tema">Tema</button>
  </header>
'''
markup = markup.replace(old_header, new_header, 1)

ja = src.index('<script>\n') + len('<script>\n')
jb = src.index('\n</script>')
js = src[ja:jb] + '''

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
'''
os.makedirs(os.path.join(here, "local"), exist_ok=True)
open(os.path.join(here, "local", "app.js"), "w", encoding="utf-8").write(js + "\n")
html = '''<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>On Cue Creadores</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&family=Geist+Mono:wght@400;500&family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@400;500&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;1,6..72,400&family=Figtree:wght@400;500;600&display=swap">
  <link rel="stylesheet" href="styles.css" id="theme-css">
</head>
<body>
''' + markup + '''
<script src="app.js"></script>
</body>
</html>
'''
open(os.path.join(here, "local", "index.html"), "w", encoding="utf-8").write(html)
print("local/index.html:", len(html.splitlines()), "líneas · local/app.js:", len(js.splitlines()), "líneas")
