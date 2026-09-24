#!/usr/bin/env bash
# =====================================================================
# Renumeración de las migraciones de integración al mezclar con main
# (VEN-10 r5). Lo corre el integrador, UNA vez, en la rama donde ya se
# mezcló main, ANTES de `make db.check` y `make db.migrate`.
#
# Por qué: main aplicó en Supabase su serie 0034–0042 (schema_migrations,
# 24-sep-2026). Las de integración y de VEN-9-canales que llevan esos
# mismos números todavía no están en ninguna base persistente, así que
# pasan, en su mismo orden, a 0043–0049. Entregabilidad (0050) y el motor
# (0051, 0052) ya llevan su número final.
#
#   0034_seguimientos.sql              → 0043_seguimientos.sql
#   0035_zona_del_espacio_valida.sql   → 0044_zona_del_espacio_valida.sql
#   0036_siguiente_accion_fijada.sql   → 0045_siguiente_accion_fijada.sql
#   0037_outreach.sql                  → 0046_outreach.sql
#   0038_canales_outreach.sql          → 0047_canales_outreach.sql
#   0039_callback_de_canales.sql       → 0048_callback_de_canales.sql
#   0040_canales_liberar_y_limites.sql → 0049_canales_liberar_y_limites.sql
#
# Solo mueve archivos (git mv) y la única referencia por nombre que hay
# en las pruebas; no toca su contenido (los comentarios «0037 §4» siguen
# hablando del documento, no del número). Idempotente: lo ya movido se
# salta. Se niega si un número de destino ya está ocupado por otro
# archivo, o si la base de main no llega a 0042.
#
# Uso:   cd platform && ./scripts/renumerar-outreach.sh
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

# La única referencia por nombre de archivo en las pruebas.
PRUEBA=packages/db/test/ventas-ficha.test.ts
if grep -q "hasta: '0034_seguimientos.sql'" "$PRUEBA"; then
  sed -i.bak "s/hasta: '0034_seguimientos.sql'/hasta: '0043_seguimientos.sql'/" "$PRUEBA" && rm -f "$PRUEBA.bak"
  echo "  $PRUEBA: hasta 0043_seguimientos.sql"
fi

echo
echo "  $movidos archivo(s) renumerado(s). Ahora: make db.check, y después make db.migrate."
