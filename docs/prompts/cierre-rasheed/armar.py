"""Arma un archivo de texto por prompt con el bloque común incluido.

Fuente: docs/cierre-rasheed-prompts.md (§2 bloque común y el bloque de
código de cada prompt en §3). Correr desde la raíz del repo:

    python3 docs/prompts/cierre-rasheed/armar.py
"""
import pathlib, re

RAIZ = pathlib.Path(__file__).resolve().parents[3]
FUENTE = RAIZ / 'docs' / 'cierre-rasheed-prompts.md'
SALIDA = pathlib.Path(__file__).resolve().parent

NOMBRES = {
    'R0': 'R0-REVISION-NICOLAS',
    'R1': 'R1-INTEGRACION',
    'R2': 'R2-ACC',
    'R3': 'R3-VEN',
    'R4': 'R4-RES',
    'R5': 'R5-COT',
    'R6': 'R6-CIM-7-TURNOS',
    'R7': 'R7-ANTES-DEL-PRIMER-CLIENTE',
    'CONTINUAR-DESPLIEGUE': 'CONTINUAR-DESPLIEGUE',
}

s = FUENTE.read_text(encoding='utf-8')
comun = re.search(r'```\n(CONTEXTO COMÚN.*?)\n```', s[s.index('## 2. Bloque común'):], re.S).group(1)
tercera = s[s.index('## 3. Los prompts'):s.index('## 4. Generar')]

n = 0
for titulo, cuerpo in re.findall(r'^### (\S+).*?\n+```\n(.*?)\n```', tercera, re.S | re.M):
    texto = cuerpo.replace('<BLOQUE COMÚN>', comun)
    (SALIDA / f'{NOMBRES[titulo]}.txt').write_text(texto.strip() + '\n', encoding='utf-8')
    n += 1
print(f'{n} prompts en {SALIDA.relative_to(RAIZ)}')
