#!/usr/bin/env bash
# =====================================================================
# verificar.sh — `pnpm verificar` con turno para toda la máquina (CIM-12)
#
#   pnpm verificar                     typecheck, lint y test (turbo)
#   scripts/verificar.sh CMD ARGS…     cualquier otro comando, con turno
#
# Varias piezas (agentes, personas, worktrees) verifican a la vez en la
# misma máquina. Cada verificar ya corre dos tareas de turbo y sus
# procesos de pruebas; con cuatro a la vez la CPU no da y las pruebas
# dan rojo por tiempo sin que nada esté mal. Este script deja correr
# MC_VERIFICAR_TURNOS a la vez (por omisión 2) en TODA la máquina, entre
# todos los clones: el resto espera su turno, y lo dice.
#
# Un turno es una carpeta en /tmp/mc-verificar-turnos-UID (mkdir es
# atómico) con el `pid@host` de quien lo tiene. Se suelta al salir, y
# también con Ctrl-C o kill. Si quien lo tenía murió sin soltarlo
# (kill -9, el Mac que se reinicia), el siguiente lo ve por el pid y lo
# toma: nunca se queda nadie esperando a un muerto.
#
#   MC_VERIFICAR_TURNOS=0   sin turnos (corre ya, como antes)
#   MC_VERIFICAR_TURNOS=4   cuatro a la vez
# =====================================================================
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TURNOS="${MC_VERIFICAR_TURNOS:-2}"
# /tmp y no $TMPDIR: dos sesiones del mismo usuario pueden tener $TMPDIR distintos.
DIR_TURNOS="${MC_VERIFICAR_TURNOS_DIR:-/tmp/mc-verificar-turnos-$(id -u)}"
YO="$$@$(hostname)"

if [ "$#" -eq 0 ]; then
  set -- pnpm exec turbo run typecheck lint test --force --concurrency=2 --continue
fi

# ¿Sigue vivo quien tiene el turno $1? Un turno sin duenio escrito (murió
# entre el mkdir y escribirlo) cuenta como vivo solo sus primeros 10 s.
turno_vivo() {
  local t="$1" duenio pid host edad
  duenio="$(cat "$t/duenio" 2>/dev/null || true)"
  if [ -z "$duenio" ]; then
    edad=$(( $(date +%s) - $(stat -f %m "$t" 2>/dev/null || stat -c %Y "$t" 2>/dev/null || date +%s) ))
    [ "$edad" -lt 10 ]
    return
  fi
  pid="${duenio%%@*}"
  host="${duenio#*@}"
  # De otra máquina (un $TMPDIR compartido): no se puede saber; se respeta.
  [ "$host" != "$(hostname)" ] && return 0
  kill -0 "$pid" 2>/dev/null
}

MIO=""
soltar() {
  [ -n "$MIO" ] && [ "$(cat "$MIO/duenio" 2>/dev/null)" = "$YO" ] && rm -rf "$MIO"
  MIO=""
}
trap soltar EXIT
trap 'soltar; exit 130' INT
trap 'soltar; exit 143' TERM

if [ "$TURNOS" != 0 ]; then
  mkdir -p "$DIR_TURNOS"
  avisado=0
  inicio=$SECONDS
  while [ -z "$MIO" ]; do
    for k in $(seq 1 "$TURNOS"); do
      t="$DIR_TURNOS/turno-$k"
      if [ -d "$t" ] && ! turno_vivo "$t"; then
        echo "verificar: el turno $k era de $(cat "$t/duenio" 2>/dev/null || echo 'nadie'), que ya no está; lo libero." >&2
        rm -rf "$t"
      fi
      if mkdir "$t" 2>/dev/null; then
        echo "$YO" >"$t/duenio"
        echo "$RAIZ" >"$t/clon"
        MIO="$t"
        break
      fi
    done
    [ -n "$MIO" ] && break
    if [ "$avisado" = 0 ]; then
      avisado=1
      echo "verificar: ya hay $TURNOS verificar en esta máquina; espero turno. Quiénes:" >&2
      for t in "$DIR_TURNOS"/turno-*; do
        [ -d "$t" ] && echo "    $(cat "$t/duenio" 2>/dev/null) en $(cat "$t/clon" 2>/dev/null)" >&2
      done
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
