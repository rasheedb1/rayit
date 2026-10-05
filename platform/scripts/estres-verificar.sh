#!/usr/bin/env bash
# =====================================================================
# estres-verificar.sh — ¿la puerta de calidad es determinista? (CIM-12)
#
#   ./scripts/estres-verificar.sh               10 corridas, de a dos
#   ./scripts/estres-verificar.sh 20            20 corridas
#   ./scripts/estres-verificar.sh 10 --dias-rotando
#                                     cada corrida con el reloj un día
#                                     más adelante (0, 1, 2, …): pasa
#                                     por todos los días de la semana
#   ./scripts/estres-verificar.sh 4 --solo-test
#                                     solo `turbo run test`, sin
#                                     typecheck ni lint (para diagnosticar)
#
# Corre `pnpm verificar` N veces, DOS A LA VEZ en este mismo clon (que
# es lo que pasa cuando dos agentes o dos personas verifican en la misma
# máquina), y cuenta en cada corrida las pruebas fallidas y canceladas
# de node:test y de vitest, y las tareas de turbo que fallaron. Al final,
# una tabla y el total. Sale con 1 si alguna corrida tuvo una sola
# prueba fallida o cancelada, o una tarea en rojo.
#
# Los registros completos quedan en $ESTRES_DIR (por omisión, una
# carpeta nueva en el directorio temporal), uno por corrida.
#
# --dias-rotando usa scripts/pruebas/reloj.mjs: mueve Date y el reloj de
# PGlite N días, sin tocar nada más. Una prueba que solo pasa ciertos
# días sale aquí en vez de un domingo en la puerta de otro.
# =====================================================================
set -uo pipefail

# En macOS, con el Mac despierto mientras dure: una corrida que pilla el
# reposo (o el estrangulamiento de antes de dormir) tarda siete veces más
# y da rojo por tiempo sin que las pruebas tengan nada (CIM-12, 5-oct).
if [ -z "${ESTRES_DESPIERTO:-}" ] && command -v caffeinate >/dev/null 2>&1; then
  ESTRES_DESPIERTO=1 exec caffeinate -dims "$0" "$@"
fi

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N=10
ROTAR=0
SOLO_TEST=0
for arg in "$@"; do
  case "$arg" in
    --dias-rotando) ROTAR=1 ;;
    --solo-test) SOLO_TEST=1 ;;
    ''|*[!0-9]*) echo "Uso: $0 [N] [--dias-rotando] [--solo-test]" >&2; exit 2 ;;
    *) N="$arg" ;;
  esac
done
if [ "$N" -lt 1 ]; then echo "N tiene que ser al menos 1." >&2; exit 2; fi

DIR="${ESTRES_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/estres-verificar.XXXXXX")}"
mkdir -p "$DIR"
RELOJ="$RAIZ/scripts/pruebas/reloj.mjs"

if [ "$SOLO_TEST" = 1 ]; then
  COMANDO=(pnpm exec turbo run test --force --concurrency=2 --continue)
else
  COMANDO=(pnpm verificar)
fi

echo "estres-verificar: $N corridas de '${COMANDO[*]}', de a dos, en $RAIZ"
echo "registros en $DIR"
[ "$ROTAR" = 1 ] && echo "con el reloj rotando: la corrida i va a +i-1 días"
echo

# Una corrida: registro en $DIR/corrida-NN.log y su código en .codigo.
correr() {
  local i="$1" dias="$2" log
  log="$(printf '%s/corrida-%02d.log' "$DIR" "$i")"
  local inicio=$SECONDS
  (
    cd "$RAIZ" || exit 1
    if [ "$dias" != 0 ]; then
      export MC_RELOJ_DIAS="$dias"
      export NODE_OPTIONS="${NODE_OPTIONS:-} --import $RELOJ"
    fi
    "${COMANDO[@]}"
  ) >"$log" 2>&1
  echo "$? $((SECONDS - inicio))" >"$log.codigo"
}

# Suma los contadores de las líneas de resumen de un registro.
#   node:test → «ℹ fail 3», «ℹ cancelled 0» (una por paquete)
#   vitest    → «Tests  3 failed | 2017 passed», «Errors  1 error»
#   turbo     → «Failed:    @mc/db#test, @mc/web#test»
sumar() {
  sed -E "s/$2/\\1/" | awk '{s+=$1} END {print s+0}'
}
contar() {
  local log="$1" fallidas canceladas vitest errores tareas
  fallidas=$(grep -aE 'ℹ fail [0-9]+' "$log" | sumar x '.*ℹ fail ([0-9]+).*')
  canceladas=$(grep -aE 'ℹ cancelled [0-9]+' "$log" | sumar x '.*ℹ cancelled ([0-9]+).*')
  vitest=$(grep -aE 'Tests +[0-9]+ failed' "$log" | sumar x '.*Tests +([0-9]+) failed.*')
  errores=$(grep -aE 'Errors +[0-9]+ errors?' "$log" | sumar x '.*Errors +([0-9]+) error.*')
  tareas=$(grep -aE '^ *Failed: ' "$log" | sed -E 's/^ *Failed: +//' | tr ',' '\n' | grep -c '#' || true)
  echo "$((fallidas + vitest)) $canceladas $errores $tareas"
}

i=0
while [ "$i" -lt "$N" ]; do
  a=$((i + 1))
  b=$((i + 2))
  dias_a=0
  dias_b=0
  if [ "$ROTAR" = 1 ]; then
    dias_a=$i
    dias_b=$((i + 1))
  fi
  if [ "$b" -le "$N" ]; then
    echo "$(date '+%H:%M') corridas $a y $b en paralelo…"
    correr "$a" "$dias_a" &
    correr "$b" "$dias_b" &
    wait
  else
    echo "$(date '+%H:%M') corrida $a…"
    correr "$a" "$dias_a"
  fi
  i=$((i + 2))
done

echo
printf '%-8s %-6s %-7s %-9s %-9s %-8s %-8s %s\n' corrida dias codigo segundos fallidas cancel. errores 'tareas en rojo'
total_f=0
total_c=0
total_e=0
total_t=0
rojas=0
for i in $(seq 1 "$N"); do
  log="$(printf '%s/corrida-%02d.log' "$DIR" "$i")"
  read -r codigo segundos <"$log.codigo"
  read -r f c e t < <(contar "$log")
  dias=0
  [ "$ROTAR" = 1 ] && dias=$((i - 1))
  printf '%-8s %-6s %-7s %-9s %-9s %-8s %-8s %s\n' "$i" "+$dias" "$codigo" "$segundos" "$f" "$c" "$e" "$t"
  total_f=$((total_f + f))
  total_c=$((total_c + c))
  total_e=$((total_e + e))
  total_t=$((total_t + t))
  if [ "$codigo" != 0 ] || [ "$f" != 0 ] || [ "$c" != 0 ] || [ "$e" != 0 ] || [ "$t" != 0 ]; then
    rojas=$((rojas + 1))
    # Qué falló, para no tener que abrir el registro.
    grep -aE '✖ .*\([0-9.]+m?s\)$| FAIL |^ *Failed: ' "$log" | sort -u | head -15 | sed 's/^/    /'
  fi
done
echo
echo "total: $N corridas, $rojas en rojo; $total_f pruebas fallidas, $total_c canceladas, $total_e errores sin capturar, $total_t tareas en rojo"
echo "registros: $DIR"
[ "$rojas" = 0 ]
