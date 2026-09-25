#!/usr/bin/env bash
# =====================================================================
# Renumeración de las migraciones de integración al mezclar con main
# (VEN-10). Lo corre el integrador, UNA vez, en la rama donde ya se
# mezcló main, ANTES de `make db.check` y `make db.migrate`.
#
# Por qué: main aplicó en Supabase su serie 0034–0042 (schema_migrations,
# 24-sep-2026). Las de integración y de VEN-9-canales que llevan esos
# mismos números todavía no están en ninguna base persistente, así que
# pasan, en su mismo orden, a 0043–0049. Entregabilidad (0050) y el motor
# (0051 a 0054) ya llevan su número final.
#
#   0034_seguimientos.sql              → 0043_seguimientos.sql
#   0035_zona_del_espacio_valida.sql   → 0044_zona_del_espacio_valida.sql
#   0036_siguiente_accion_fijada.sql   → 0045_siguiente_accion_fijada.sql
#   0037_outreach.sql                  → 0046_outreach.sql
#   0038_canales_outreach.sql          → 0047_canales_outreach.sql
#   0039_callback_de_canales.sql       → 0048_callback_de_canales.sql
#   0040_canales_liberar_y_limites.sql → 0049_canales_liberar_y_limites.sql
#
# Solo mueve archivos (git mv) y las referencias por nombre que hay en
# las pruebas; no toca su contenido (los comentarios «0037 §4» siguen
# hablando del documento, no del número). Idempotente: lo ya movido se
# salta. Se niega si un número de destino ya está ocupado por otro
# archivo, o si la base de main no llega a 0042.
#
# Uso:   cd platform && ./scripts/renumerar-outreach.sh
#        y después pnpm verificar ANTES de make db.check: db.check en
#        verde no dice que las consultas del motor funcionen sobre la
#        serie de main (ver el final del script).
# =====================================================================
set -euo pipefail

cd "$(dirname "$0")/.."
DIR=db/migrations

MAPA=(
  "0034_seguimientos.sql:0043_seguimientos.sql"
  "0035_zona_del_espacio_valida.sql:0044_zona_del_espacio_valida.sql"
  "0036_siguiente_accion_fijada.sql:0045_siguiente_accion_fijada.sql"
  "0037_outreach.sql:0046_outreach.sql"
  "0038_canales_outreach.sql:0047_canales_outreach.sql"
  "0039_callback_de_canales.sql:0048_callback_de_canales.sql"
  "0040_canales_liberar_y_limites.sql:0049_canales_liberar_y_limites.sql"
)

if [[ ! -f "$DIR/0042_metricas_al_corte_desempate.sql" ]]; then
  echo "  Falta $DIR/0042_metricas_al_corte_desempate.sql: mezcla primero main (su serie 0034–0042)." >&2
  exit 1
fi

movidos=0
for par in "${MAPA[@]}"; do
  origen="${par%%:*}"
  destino="${par##*:}"
  if [[ -f "$DIR/$destino" && ! -f "$DIR/$origen" ]]; then
    echo "  ya está: $destino"
    continue
  fi
  if [[ ! -f "$DIR/$origen" ]]; then
    echo "  No encuentro $DIR/$origen." >&2
    exit 1
  fi
  numero="${destino%%_*}"
  ocupado=$(find "$DIR" -maxdepth 1 -name "${numero}_*.sql" ! -name "$destino" | head -n 1)
  if [[ -n "$ocupado" ]]; then
    echo "  El número $numero ya lo tiene $ocupado: revisa la serie antes de seguir." >&2
    exit 1
  fi
  git mv "$DIR/$origen" "$DIR/$destino"
  echo "  $origen → $destino"
  movidos=$((movidos + 1))
done

# Las referencias por nombre de archivo en las pruebas (hoy dos, en
# ventas-ficha.test.ts: `hasta: '0034_seguimientos.sql'` y
# `migrar('0035_zona_del_espacio_valida.sql')`). Se busca cada nombre
# viejo entre comillas en todas las pruebas, para que una nueva no se
# quede atrás.
for par in "${MAPA[@]}"; do
  origen="${par%%:*}"
  destino="${par##*:}"
  while IFS= read -r prueba; do
    [[ -n "$prueba" ]] || continue
    sed -i.bak "s/'${origen}'/'${destino}'/g" "$prueba" && rm -f "$prueba.bak"
    echo "  $prueba: $origen → $destino"
  done < <(grep -rl --include='*.ts' --include='*.mjs' "'${origen}'" packages apps db 2>/dev/null | grep -v node_modules || true)
done

echo
echo "  $movidos archivo(s) renumerado(s)."
echo
echo "  Ahora, en este orden (db.check NO basta: compila las migraciones, no"
echo "  el SQL de las consultas; una columna que main borró solo aparece al"
echo "  correr las pruebas, como membership.role con 0034_access_control):"
echo "    1. pnpm verificar            las pruebas del motor sobre la serie integrada"
echo "    2. make db.check"
echo "    3. make db.migrate"
