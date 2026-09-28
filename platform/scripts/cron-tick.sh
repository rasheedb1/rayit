#!/usr/bin/env bash
# =====================================================================
# El disparador del worker por turnos (CIM-7, opción B): pg_cron de
# Supabase llama cada minuto a /api/cron/tick con el Bearer CRON_SECRET.
#
#   ./scripts/cron-tick.sh install     crea o actualiza la tarea y el secreto en Vault
#   ./scripts/cron-tick.sh status      la tarea, el secreto (sin su valor) y las últimas corridas
#   ./scripts/cron-tick.sh uninstall   la retira y borra el secreto (para pasar a Vercel Cron)
#
# Lo corre el dueño del proyecto: usa scripts/supabase-admin.sh (el token
# de administración, solo en su Llavero), porque pg_cron y pg_net piden
# superusuario. Las plantillas están en db/ops/.
#
#   APP_URL       origen https de la web. Por defecto, https://on-cue-web.vercel.app
#   CRON_SECRET   el mismo valor que en Vercel. Si no está en el entorno,
#                 se pide sin mostrarlo. Nunca va en un argumento.
# =====================================================================
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ADMIN=./scripts/supabase-admin.sh
APP_URL_DEFAULT=https://on-cue-web.vercel.app

rojo()  { printf '\033[31m  %s\033[0m\n' "$*" >&2; }
verde() { printf '\033[32m  %s\033[0m\n' "$*"; }

# Una consulta de administración; sale con 1 si la API devolvió un error.
admin_sql() {
  local out
  out="$(printf '%s' "$1" | "$ADMIN" sql-stdin)"
  if printf '%s' "$out" | python3 -c 'import json,sys
d=json.load(sys.stdin)
sys.exit(1 if isinstance(d, dict) and ("message" in d or "error" in d) else 0)' 2>/dev/null; then
    printf '%s\n' "$out"
  else
    rojo "Supabase rechazó la consulta:"
    printf '%s\n' "$out" >&2
    return 1
  fi
}

# ¿Están pg_cron y pg_net? (status y uninstall no tienen nada que mirar sin ellas)
extensiones_listas() {
  admin_sql "select count(*) as n from pg_extension where extname in ('pg_cron','pg_net')" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if d and int(d[0]["n"]) == 2 else 1)'
}

install() {
  export APP_URL="${APP_URL:-$APP_URL_DEFAULT}"
  if [[ -z "${CRON_SECRET:-}" ]]; then
    read -r -s -p "  CRON_SECRET (el mismo que en Vercel; no se muestra): " CRON_SECRET
    printf '\n'
  fi
  export CRON_SECRET
  local sql
  # render.mjs valida los dos valores y lee el secreto del entorno.
  sql="$(node db/ops/render.mjs db/ops/cron-tick.sql)" || exit 2
  admin_sql "$sql" >/dev/null
  unset sql CRON_SECRET
  verde "Tarea on-cue-tick programada cada minuto contra $APP_URL/api/cron/tick; secreto en Vault (on_cue_cron_secret)."
  status
}

status() {
  if ! extensiones_listas; then
    rojo "pg_cron o pg_net no están instalados: el disparador no existe. make cron.install lo crea."
    return 1
  fi
  admin_sql "$(cat db/ops/cron-tick-estado.sql)"
}

uninstall() {
  if ! extensiones_listas; then
    verde "pg_cron o pg_net no están instalados: no hay disparador que quitar."
    return 0
  fi
  admin_sql "$(cat db/ops/cron-tick-quitar.sql)"
  verde "Tarea on-cue-tick retirada y secreto borrado de Vault."
}

case "${1:-}" in
  install)   install ;;
  status)    status ;;
  uninstall) uninstall ;;
  *)         sed -n '3,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
