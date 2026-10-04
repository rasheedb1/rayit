#!/usr/bin/env bash
# =====================================================================
# El disparador del worker por turnos (CIM-7, opción B): pg_cron de
# Supabase llama cada minuto a /api/cron/tick con una firma de CRON_SECRET
# que caduca (HMAC-SHA256 del timestamp, ±90 s; ver db/ops/cron-tick.sql).
#
#   ./scripts/cron-tick.sh install     crea o actualiza la tarea y el secreto en Vault
#   ./scripts/cron-tick.sh status      la tarea, el secreto (sin su valor), las últimas corridas y un
#                                      veredicto: sale con 1 si el turno no está sano
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
#
#   admin_sql [--redactar] "<sql>"
#
# Con --redactar (la llamada del secreto), si la API la rechaza no se copia
# su respuesta: los errores de Postgres que devuelve pueden traer la
# sentencia (`LINE 1: SELECT vault.update_secret(id, '<secreto>')…`), y el
# CRON_SECRET acabaría en la terminal, en su historial o en un log de CI.
# Se imprime solo la primera línea del mensaje, con el valor de
# CRON_SECRET (y cualquier cadena larga de hexadecimales o base64)
# cambiado por ***. El secreto llega a python por el entorno, no por argumentos.
admin_sql() {
  local redactar=0 out
  if [[ "${1:-}" == --redactar ]]; then redactar=1; shift; fi
  out="$(printf '%s' "$1" | "$ADMIN" sql-stdin)" || true
  if printf '%s' "$out" | python3 -c 'import json,sys
d=json.load(sys.stdin)
sys.exit(1 if isinstance(d, dict) and ("message" in d or "error" in d) else 0)' 2>/dev/null; then
    printf '%s\n' "$out"
  elif [[ "$redactar" == 1 ]]; then
    rojo "Supabase rechazó la consulta del secreto (el detalle se omite: podría llevar el valor):"
    printf '%s' "$out" | python3 -c 'import json,os,re,sys
raw=sys.stdin.read()
try:
    d=json.loads(raw)
    msg=str(d.get("message") or d.get("error") or raw) if isinstance(d, dict) else raw
except Exception:
    msg=raw
lines=msg.strip().splitlines()
msg=lines[0] if lines else "(sin mensaje)"
s=os.environ.get("CRON_SECRET") or ""
if s:
    msg=msg.replace(s, "***")
msg=re.sub(r"[A-Za-z0-9_-]{32,}", "***", msg)
print("  " + msg[:300])' >&2
    return 1
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

# ¿Quedó algún literal del secreto en pg_stat_statements? (db/ops/cron-tick-huellas.sql)
huellas() {
  local hay n
  hay="$(admin_sql "select to_regclass('extensions.pg_stat_statements') is not null as hay" \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print("si" if d and d[0]["hay"] else "no")')" || return 0
  if [[ "$hay" != si ]]; then
    printf '  pg_stat_statements no está en extensions: no se puede comprobar si quedó el secreto en claro.\n'
    return 0
  fi
  n="$(admin_sql "$(cat db/ops/cron-tick-huellas.sql)" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)[0]["literales"]))')" || return 0
  if [[ "$n" == 0 ]]; then
    verde "pg_stat_statements: ninguna llamada a Vault con el secreto en claro."
  else
    rojo "pg_stat_statements tiene $n llamada(s) a Vault SIN normalizar: el secreto pudo quedar en claro."
    rojo "Límpialo y rota el secreto (instrucciones en db/ops/cron-tick-huellas.sql)."
    return 1
  fi
}

install() {
  export APP_URL="${APP_URL:-$APP_URL_DEFAULT}"
  if [[ -z "${CRON_SECRET:-}" ]]; then
    read -r -s -p "  CRON_SECRET (el mismo que en Vercel; no se muestra): " CRON_SECRET
    printf '\n'
  fi
  export CRON_SECRET
  local sql tarea
  # render.mjs valida cada valor y lo lee del entorno; los dos se validan
  # antes de tocar nada. Tres llamadas, en este orden, para que la tarea
  # nunca dispare sin secreto (no llamaría, y cron.status daría rojo):
  #   1. ¿están Vault y extensions.hmac? (cron-tick-vault.sql, sin secretos)
  #   2. el secreto en Vault (dos SELECT sin nada más; cron-tick-secreto.sql)
  #   3. la tarea y su purga (con la URL, sin el secreto; cron-tick.sql)
  node db/ops/render.mjs db/ops/cron-tick-secreto.sql >/dev/null || exit 2
  tarea="$(CRON_SECRET= node db/ops/render.mjs db/ops/cron-tick.sql)" || exit 2
  admin_sql "$(cat db/ops/cron-tick-vault.sql)" >/dev/null
  sql="$(APP_URL= node db/ops/render.mjs db/ops/cron-tick-secreto.sql)" || exit 2
  admin_sql --redactar "$sql" >/dev/null
  unset sql CRON_SECRET
  admin_sql "$tarea" >/dev/null
  unset tarea
  verde "Secreto en Vault (on_cue_cron_secret); tarea on-cue-tick programada cada minuto contra $APP_URL/api/cron/tick, y on-cue-tick-purga a diario."
  status
}

status() {
  if ! extensiones_listas; then
    rojo "pg_cron o pg_net no están instalados: el disparador no existe. make cron.install lo crea."
    return 1
  fi
  local estado sano=0
  estado="$(admin_sql "$(cat db/ops/cron-tick-estado.sql)")" || return 1
  printf '%s\n' "$estado"
  printf '\n'
  # El veredicto: verde si el turno responde 200; si no, en rojo y qué hacer (db/ops/cron-tick-veredicto.mjs).
  printf '%s' "$estado" | node db/ops/cron-tick-veredicto.mjs || sano=1
  huellas || sano=1
  return "$sano"
}

uninstall() {
  if ! extensiones_listas; then
    verde "pg_cron o pg_net no están instalados: no hay disparador que quitar."
    return 0
  fi
  admin_sql "$(cat db/ops/cron-tick-quitar.sql)"
  verde "Tareas on-cue-tick y on-cue-tick-purga retiradas y secreto borrado de Vault."
}

# Solo al ejecutarlo: las pruebas (apps/worker/test/cron-tick-sql.test.ts) lo cargan con `source` para probar admin_sql.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    install)   install ;;
    status)    status ;;
    uninstall) uninstall ;;
    *)         sed -n '3,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
  esac
fi
