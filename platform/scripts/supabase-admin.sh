#!/usr/bin/env bash
# =====================================================================
# Operaciones que NADIE debería poder hacer con las credenciales del
# vault: crear roles, rotar llaves, tocar la configuración del proyecto.
#
# Usa el token de administración de Supabase, que vive SOLO en el
# Llavero de esta máquina. No está en el repositorio ni siquiera
# cifrado, porque puede borrar el proyecto entero.
#
#   ./scripts/supabase-admin.sh sql "CREATE ROLE ..."
#   ./scripts/supabase-admin.sh info
#   ./scripts/supabase-admin.sh keys
#   ./scripts/supabase-admin.sh recover    <- romper el cristal
# =====================================================================
set -euo pipefail
REF=autlbeccerunvetptywe
API=https://api.supabase.com/v1

token() {
  local t; t="$(security find-generic-password -s multicampaign-supabase-pat -w 2>/dev/null || true)"
  if [[ -z "$t" ]]; then
    printf '\033[31m  No hay token de administracion en el Llavero de esta maquina.\033[0m\n' >&2
    printf '  Esto es lo esperado si no eres el dueno del proyecto.\n' >&2
    printf '  Para el trabajo normal (migraciones, consultas) NO hace falta:\n' >&2
    printf '  usa  make db.migrate  y  make db.sql.\n' >&2
    exit 1
  fi
  printf '%s' "$t"
}

case "${1:-}" in
  sql)
    [[ -n "${2:-}" ]] || { echo 'Uso: supabase-admin.sh sql "SELECT ..."' >&2; exit 1; }
    curl -s -X POST -H "Authorization: Bearer $(token)" -H 'Content-Type: application/json' \
      -d "$(python3 -c 'import json,sys;print(json.dumps({"query":sys.argv[1]}))' "$2")" \
      "$API/projects/$REF/database/query" | python3 -m json.tool 2>/dev/null || true
    ;;
  recover)
    # Romper el cristal: las llaves que NO se pueden regenerar, guardadas
    # dentro de la propia base. Solo el rol postgres llega a ese esquema.
    # Usa esto si perdiste el Llavero de esta maquina.
    printf '\033[33m  Esto imprime secretos en la terminal. Ctrl-C si no estas solo.\033[0m\n' >&2
    printf '  Enter para continuar... ' >&2; read -r _
    curl -s -X POST -H "Authorization: Bearer $(token)" -H 'Content-Type: application/json' \
      -d '{"query":"select nombre, valor, para_que from recuperacion.llaves order by nombre"}' \
      "$API/projects/$REF/database/query" \
      | python3 "$(dirname "${BASH_SOURCE[0]}")/_formato_recover.py"
    ;;

  info) curl -s -H "Authorization: Bearer $(token)" "$API/projects/$REF" | python3 -m json.tool ;;
  keys) curl -s -H "Authorization: Bearer $(token)" "$API/projects/$REF/api-keys" | python3 -m json.tool ;;
  *)    sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
esac
