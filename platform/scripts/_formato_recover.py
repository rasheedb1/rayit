"""Imprime las llaves de romper-el-cristal de forma legible.
Lo usa supabase-admin.sh recover; no se llama directo."""
import json, sys, textwrap

NEGRITA, GRIS, FIN = "\033[1m", "\033[90m", "\033[0m"
datos = json.load(sys.stdin)
if isinstance(datos, dict):
    print("  " + datos.get("message", str(datos)), file=sys.stderr)
    sys.exit(1)
for fila in datos:
    print("\n  " + NEGRITA + fila["nombre"] + FIN)
    print("    " + fila["valor"])
    print(textwrap.fill(fila["para_que"], 72,
                        initial_indent="    " + GRIS, subsequent_indent="    ") + FIN)
print()
