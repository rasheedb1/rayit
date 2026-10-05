#!/usr/bin/env bash
# =====================================================================
# verificar.sh — `pnpm verificar` con turno para toda la máquina (CIM-12)
#
#   pnpm verificar                     typecheck, lint y test (turbo)
#   pnpm verificar --filter=@mc/db     lo mismo, con banderas de turbo
#   scripts/verificar.sh CMD ARGS…     cualquier otro comando, con turno
#
# Sin argumentos, o si el primero empieza por «-», corre turbo con las
# banderas que se le pasen al final. Si el primero no es una bandera, es
# el comando que se corre con turno.
#
# AGENTES: lanzadlo en segundo plano (run_in_background) y leed el final
# del registro. Con espera de turno una corrida pasa de los 600 s que
# dura como mucho un Bash en primer plano, y cortada a la mitad no se
# sabe si fue rojo o espera.
#
# Varias piezas (agentes, personas, worktrees) verifican a la vez en la
# misma máquina. Cada verificar ya corre dos tareas de turbo y sus
# procesos de pruebas; con cuatro a la vez la CPU no da y las pruebas
# dan rojo por tiempo sin que nada esté mal. Este script deja correr
# MC_VERIFICAR_TURNOS a la vez (por omisión 2) en TODA la máquina, entre
# todos los clones: el resto espera su turno, y lo dice.
#
# Un turno es una carpeta en /tmp/mc-verificar-turnos-UID (mkdir es
# atómico) con un archivo `duenio`: `pid@host` en la primera línea y la
# hora de arranque de ese proceso (`ps -o lstart=`) en la segunda. Se
# suelta al salir, y también con Ctrl-C o kill. Un turno se da por
# libre, y lo toma el siguiente, si:
#   - su pid ya no existe (kill -9, el Mac que se reinicia);
#   - su pid existe pero arrancó a otra hora: el sistema recicló el pid
#     de un verificar muerto para otro proceso (un next dev, un editor);
#   - la carpeta tiene más de MC_VERIFICAR_TURNO_MAX segundos (2 h): la
#     salvaguarda por si todo lo anterior falla. Ningún verificar dura eso.
#
#   MC_VERIFICAR_TURNOS=0         sin turnos (corre ya, como antes)
#   MC_VERIFICAR_TURNOS=4         cuatro a la vez
#   MC_VERIFICAR_ESPERA_MAX=600   segundos de espera como mucho (por
#                                 omisión 600; 0 = sin techo). Pasado
#                                 eso sale con el código 75 diciendo
#                                 quién tiene los turnos.
#   MC_VERIFICAR_SECO=1           imprime el comando y sale, sin turno
#                                 (para las pruebas de este script)
# =====================================================================
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TURNOS="${MC_VERIFICAR_TURNOS:-2}"
ESPERA_MAX="${MC_VERIFICAR_ESPERA_MAX:-600}"
TURNO_MAX="${MC_VERIFICAR_TURNO_MAX:-7200}"
# /tmp y no $TMPDIR: dos sesiones del mismo usuario pueden tener $TMPDIR distintos.
DIR_TURNOS="${MC_VERIFICAR_TURNOS_DIR:-/tmp/mc-verificar-turnos-$(id -u)}"
HOST="$(hostname)"
YO="$$@$HOST"
# Código de salida cuando no hubo turno a tiempo (EX_TEMPFAIL de sysexits.h).
SIN_TURNO=75

if [ "$#" -eq 0 ] || [ "${1#-}" != "$1" ]; then
  set -- pnpm exec turbo run typecheck lint test --force --concurrency=2 --continue "$@"
fi

if [ "${MC_VERIFICAR_SECO:-0}" = 1 ]; then
  printf '%s\n' "$*"
  exit 0
fi

# La hora de arranque del proceso $1, con los espacios normalizados
# (macOS rellena el día con un espacio). Vacía si el proceso no existe.
arranque_de() { ps -o lstart= -p "$1" 2>/dev/null | tr -s ' ' | sed 's/^ //; s/ $//'; }

# Segundos desde la última modificación de $1. `date -r ARCHIVO` vale en
# macOS y en GNU; `stat -f %m` no (en GNU es el modo de sistema de
# archivos e imprime «?» con código 0).
edad_de() {
  local m
  m="$(date -r "$1" +%s 2>/dev/null)" || m="$(date +%s)"
  echo $(( $(date +%s) - m ))
}

# ¿Sigue vivo quien tiene el turno $1? Un turno sin duenio escrito (murió
# entre el mkdir y escribirlo) cuenta como vivo solo sus primeros 10 s.
turno_vivo() {
  local t="$1" linea hora pid host edad
  edad="$(edad_de "$t")"
  [ "$edad" -ge "$TURNO_MAX" ] && return 1
  { IFS= read -r linea; IFS= read -r hora; } <"$t/duenio" 2>/dev/null || true
  if [ -z "${linea:-}" ]; then
    [ "$edad" -lt 10 ]
    return
  fi
  pid="${linea%%@*}"
  host="${linea#*@}"
  # De otra máquina (un /tmp compartido): no se puede saber; se respeta.
  [ "$host" != "$HOST" ] && return 0
  kill -0 "$pid" 2>/dev/null || return 1
  # El pid vive, pero ¿es el mismo proceso? Sin hora escrita (un turno de
  # una versión anterior de este script) se le cree al pid.
  [ -z "${hora:-}" ] || [ "$(arranque_de "$pid")" = "$hora" ]
}

# Quién tiene cada turno, para los avisos.
quienes() {
  local t
  for t in "$DIR_TURNOS"/turno-*; do
    [ -d "$t" ] && echo "    $(head -1 "$t/duenio" 2>/dev/null) en $(cat "$t/clon" 2>/dev/null), desde hace $(edad_de "$t") s" >&2
  done
}

MIO=""
soltar() {
  [ -n "$MIO" ] && [ "$(head -1 "$MIO/duenio" 2>/dev/null)" = "$YO" ] && rm -rf "$MIO"
  MIO=""
}
trap soltar EXIT
trap 'soltar; exit 130' INT
trap 'soltar; exit 143' TERM

if [ "$TURNOS" != 0 ]; then
  mkdir -p "$DIR_TURNOS"
  ARRANQUE="$(arranque_de $$)"
  avisado=0
  inicio=$SECONDS
  while [ -z "$MIO" ]; do
    for k in $(seq 1 "$TURNOS"); do
      t="$DIR_TURNOS/turno-$k"
      if [ -d "$t" ] && ! turno_vivo "$t"; then
        echo "verificar: el turno $k era de $(head -1 "$t/duenio" 2>/dev/null || echo 'nadie'), que ya no está; lo libero." >&2
        rm -rf "$t"
      fi
      if mkdir "$t" 2>/dev/null; then
        printf '%s\n%s\n' "$YO" "$ARRANQUE" >"$t/duenio"
        echo "$RAIZ" >"$t/clon"
        MIO="$t"
        break
      fi
    done
    [ -n "$MIO" ] && break
    if [ "$avisado" = 0 ]; then
      avisado=1
      echo "verificar: ya hay $TURNOS verificar en esta máquina; espero turno (como mucho ${ESPERA_MAX} s). Quiénes:" >&2
      quienes
    fi
    if [ "$ESPERA_MAX" != 0 ] && [ $((SECONDS - inicio)) -ge "$ESPERA_MAX" ]; then
      echo "verificar: no hubo turno en $ESPERA_MAX s; estos lo tienen:" >&2
      quienes
      echo "verificar: sale con $SIN_TURNO sin haber corrido nada. Vuelve a lanzarlo, o sube MC_VERIFICAR_ESPERA_MAX." >&2
      exit "$SIN_TURNO"
    fi
    sleep 3
  done
  [ "$avisado" = 1 ] && echo "verificar: turno tomado tras $((SECONDS - inicio)) s de espera." >&2
fi

cd "$RAIZ" || exit 1
# Sin exec: hay que soltar el turno al terminar.
"$@"
codigo=$?
soltar
exit "$codigo"
