#!/usr/bin/env bash
# =====================================================================
# estres-verificar.sh — ¿la puerta de calidad es determinista? (CIM-12)
#
#   ./scripts/estres-verificar.sh               10 corridas, de a dos
#   ./scripts/estres-verificar.sh 20            20 corridas
#   ./scripts/estres-verificar.sh 8 --paralelo 4
#                                     de a cuatro (con el turno de
#                                     scripts/verificar.sh, dos corren y
#                                     dos esperan, como en la máquina real)
#   ./scripts/estres-verificar.sh 10 --dias-rotando
#                                     cada corrida con el reloj un día
#                                     más adelante (0, 1, 2, …): pasa
#                                     por todos los días de la semana
#   ./scripts/estres-verificar.sh 4 --solo-test
#                                     solo `turbo run test`, sin
#                                     typecheck ni lint (para diagnosticar)
#   make verificar.estres N=10 [P=4]  lo mismo desde make
#
# Corre `pnpm verificar` N veces, P A LA VEZ en este mismo clon (lo que
# pasa cuando varios agentes o personas verifican en la misma máquina), y
# al terminar cada tanda imprime una fila por corrida:
#
#   codigo     la salida de pnpm verificar (0 = verde)
#   segundos   lo que tardó, contando la espera de turno
#   espera     los segundos que esperó turno (scripts/verificar.sh)
#   carga      la carga de la máquina (1 min) al empezar → la máxima
#              (muestreada cada 30 s) → al terminar: para saber si un
#              rojo es de carga o de lógica
#   fallidas   pruebas fallidas: «ℹ fail N» de node:test más «Tests N
#              failed» de vitest
#   archivos   archivos de vitest en FAIL («Test Files N failed»): cuando
#              falla un beforeAll, vitest da el archivo por fallido y sus
#              pruebas por saltadas, sin contarlas en «fallidas»
#   saltadas   pruebas que vitest saltó, solo si hubo archivos en FAIL
#              (son las de esos archivos; si no, «-»)
#   cancel.    pruebas canceladas de node:test («ℹ cancelled N»)
#   errores    errores sin capturar de vitest («Errors N errors»)
#   tareas     tareas de turbo en rojo («Failed: @mc/db#test, …»)
#
# Al final, el total. Sale con 1 si alguna corrida tuvo un solo número
# distinto de cero en esas columnas o una salida distinta de 0.
#
# Los registros completos quedan en $ESTRES_DIR (por omisión, una
# carpeta nueva en el directorio temporal): corrida-NN.log, con su
# .codigo y su .carga (las lecturas de `uptime`).
#
# --dias-rotando usa scripts/pruebas/reloj.mjs: mueve Date y el reloj de
# PGlite N días, sin tocar nada más. Una prueba que solo pasa ciertos
# días sale aquí en vez de un domingo en la puerta de otro.
# =====================================================================
set -uo pipefail

ayuda() { sed -n '3,/^# =====/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'; }

# En macOS, con el Mac despierto mientras dure: una corrida que pilla el
# reposo (o el estrangulamiento de antes de dormir) tarda siete veces más
# y da rojo por tiempo sin que las pruebas tengan nada (CIM-12, 5-oct).
if [ -z "${ESTRES_DESPIERTO:-}" ] && command -v caffeinate >/dev/null 2>&1; then
  case " $* " in *" -h "*|*" --help "*) ;; *) ESTRES_DESPIERTO=1 exec caffeinate -dims "$0" "$@" ;; esac
fi

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
N=10
P=2
ROTAR=0
SOLO_TEST=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) ayuda; exit 0 ;;
    --dias-rotando) ROTAR=1 ;;
    --solo-test) SOLO_TEST=1 ;;
    --paralelo) shift; P="${1:-}" ;;
    --paralelo=*) P="${1#--paralelo=}" ;;
    ''|*[!0-9]*) echo "Uso: $0 [N] [--paralelo P] [--dias-rotando] [--solo-test]   (--help para más)" >&2; exit 2 ;;
    *) N="$1" ;;
  esac
  shift
done
case "$P" in ''|*[!0-9]*) echo "--paralelo pide un número." >&2; exit 2 ;; esac
if [ "$N" -lt 1 ] || [ "$P" -lt 1 ]; then echo "N y P tienen que ser al menos 1." >&2; exit 2; fi

DIR="${ESTRES_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/estres-verificar.XXXXXX")}"
mkdir -p "$DIR"
RELOJ="$RAIZ/scripts/pruebas/reloj.mjs"

if [ "$SOLO_TEST" = 1 ]; then
  COMANDO=(bash "$RAIZ/scripts/verificar.sh" pnpm exec turbo run test --force --concurrency=2 --continue)
else
  COMANDO=(pnpm verificar)
fi

echo "estres-verificar: $N corridas de '${COMANDO[*]}', de a $P, en $RAIZ"
echo "registros en $DIR"
echo "carga al empezar: $(uptime | sed 's/.*load averages*: *//')"
[ "$ROTAR" = 1 ] && echo "con el reloj rotando: la corrida i va a +i-1 días"
echo

registro() { printf '%s/corrida-%02d.log' "$DIR" "$1"; }

# La carga de 1 minuto de una línea de `uptime` (macOS o Linux).
carga1() { sed -E 's/.*load averages?: *([0-9]+[.,][0-9]+).*/\1/' | tr ',' '.'; }

# Una corrida: registro en corrida-NN.log, su código y segundos en
# .codigo, y la carga (inicio, cada 30 s, fin) en .carga.
correr() {
  local i="$1" dias="$2" log inicio codigo muestreo
  log="$(registro "$i")"
  inicio=$SECONDS
  echo "inicio $(uptime)" >"$log.carga"
  (while sleep 30; do echo "durante $(uptime)" >>"$log.carga"; done) &
  muestreo=$!
  (
    cd "$RAIZ" || exit 1
    if [ "$dias" != 0 ]; then
      export MC_RELOJ_DIAS="$dias"
      export NODE_OPTIONS="${NODE_OPTIONS:-} --import $RELOJ"
    fi
    "${COMANDO[@]}"
  ) >"$log" 2>&1
  codigo=$?
  kill "$muestreo" 2>/dev/null
  wait "$muestreo" 2>/dev/null
  echo "fin $(uptime)" >>"$log.carga"
  echo "$codigo $((SECONDS - inicio))" >"$log.codigo"
}

# Suma el número que captura la expresión $1 en cada línea de la entrada.
sumar() { sed -E "s/$1/\\1/" | awk '{s+=$1} END {print s+0}'; }

# Los contadores de un registro (ver la cabecera), en una línea:
#   fallidas archivos saltadas canceladas errores tareas espera
contar() {
  local log="$1" limpio node vitest archivos saltadas canceladas errores tareas espera
  limpio="$(perl -pe 's/\e\[[0-9;]*m//g' "$log")"
  node=$(grep -aE 'ℹ fail [0-9]+' <<<"$limpio" | sumar '.*ℹ fail ([0-9]+).*')
  vitest=$(grep -aE 'Tests +[0-9]+ failed' <<<"$limpio" | sumar '.*Tests +([0-9]+) failed.*')
  archivos=$(grep -aE 'Test Files +[0-9]+ failed' <<<"$limpio" | sumar '.*Test Files +([0-9]+) failed.*')
  saltadas=-
  if [ "$archivos" != 0 ]; then
    saltadas=$(grep -aE 'Tests +.*[0-9]+ skipped' <<<"$limpio" | sumar '.*[^0-9]([0-9]+) skipped.*')
  fi
  canceladas=$(grep -aE 'ℹ cancelled [0-9]+' <<<"$limpio" | sumar '.*ℹ cancelled ([0-9]+).*')
  errores=$(grep -aE 'Errors +[0-9]+ errors?' <<<"$limpio" | sumar '.*Errors +([0-9]+) error.*')
  tareas=$(grep -aE '^ *Failed: ' <<<"$limpio" | sed -E 's/^ *Failed: +//' | tr ',' '\n' | grep -c '#' || true)
  espera=$(grep -aE 'turno tomado tras [0-9]+ s' <<<"$limpio" | sumar '.*turno tomado tras ([0-9]+) s.*')
  echo "$((node + vitest)) $archivos $saltadas $canceladas $errores $tareas $espera"
}

# «inicio→máxima→fin» de la carga de 1 minuto de una corrida.
cargas() {
  local f="$1.carga" ini fin max
  ini=$(grep -a '^inicio' "$f" | carga1)
  fin=$(grep -a '^fin' "$f" | carga1)
  max=$(carga1 <"$f" | sort -n | tail -1)
  echo "${ini}→${max}→${fin}"
}

FORMATO='%-7s %-5s %-6s %-8s %-6s %-19s %-8s %-8s %-8s %-7s %-7s %s\n'
total_f=0 total_a=0 total_c=0 total_e=0 total_t=0 rojas=0

fila() {
  local i="$1" log codigo segundos f a s c e t espera dias
  log="$(registro "$i")"
  read -r codigo segundos <"$log.codigo"
  read -r f a s c e t espera < <(contar "$log")
  dias=0
  [ "$ROTAR" = 1 ] && dias=$((i - 1))
  printf "$FORMATO" "$i" "+$dias" "$codigo" "$segundos" "$espera" "$(cargas "$log")" "$f" "$a" "$s" "$c" "$e" "$t"
  total_f=$((total_f + f)); total_a=$((total_a + a)); total_c=$((total_c + c))
  total_e=$((total_e + e)); total_t=$((total_t + t))
  if [ "$codigo" != 0 ] || [ "$f" != 0 ] || [ "$a" != 0 ] || [ "$c" != 0 ] || [ "$e" != 0 ] || [ "$t" != 0 ]; then
    rojas=$((rojas + 1))
    # Qué falló, para no tener que abrir el registro.
    perl -pe 's/\e\[[0-9;]*m//g' "$log" | grep -aE '✖ .*\([0-9.]+m?s\)$| FAIL |^ *Failed: ' | sort -u | head -15 | sed 's/^/    /'
  fi
}

printf "$FORMATO" corrida dias codigo segundos espera 'carga ini→máx→fin' fallidas archivos saltadas cancel. errores tareas
i=0
while [ "$i" -lt "$N" ]; do
  desde=$((i + 1))
  hasta=$((i + P))
  [ "$hasta" -gt "$N" ] && hasta=$N
  for k in $(seq "$desde" "$hasta"); do
    dias=0
    [ "$ROTAR" = 1 ] && dias=$((k - 1))
    correr "$k" "$dias" &
  done
  wait
  for k in $(seq "$desde" "$hasta"); do fila "$k"; done
  i=$hasta
done

echo
echo "carga al terminar: $(uptime | sed 's/.*load averages*: *//')"
echo "total: $N corridas de a $P, $rojas en rojo; $total_f pruebas fallidas, $total_a archivos en FAIL, $total_c canceladas, $total_e errores sin capturar, $total_t tareas en rojo"
echo "registros: $DIR"
[ "$rojas" = 0 ]
