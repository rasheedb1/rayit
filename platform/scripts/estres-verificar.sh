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
#   ./scripts/estres-verificar.sh 8 --dias 2,7,30,90
#                                     la corrida i con la MÁQUINA a +2,
#                                     +7, +30, +90, +2… días: ¿da verde la
#                                     puerta si se corre ese día?
#   ./scripts/estres-verificar.sh 10 --dias-rotando
#                                     la máquina a +0, +1, +2… días
#   ./scripts/estres-verificar.sh 7 --ancla-rotando
#                                     el reloj ANCLADO de las pruebas a
#                                     +0…+6 días: los siete días de la
#                                     semana, sin ninguna prueba que
#                                     dependa de uno (también --ancla LISTA)
#   ./scripts/estres-verificar.sh 2 --dias 2,90 --sin-ancla
#                                     sin el ancla: reproduce los rojos que
#                                     el ancla evita (para comprobar que
#                                     el reloj de verdad se mueve)
#   ./scripts/estres-verificar.sh 4 --solo-test
#                                     solo `turbo run test`, sin
#                                     typecheck ni lint (para diagnosticar)
#   make verificar.estres N=10 [P=4] [DIAS=2,7,30,90] [ANCLA=1]
#                                     lo mismo desde make (DIAS=1 es
#                                     --dias-rotando; ANCLA=1, --ancla-rotando)
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
#   cancel.    pruebas canceladas de node:test («ℹ cancelled N»). Con
#              Node 24+ eso es que alguien mató el proceso (un SIGTERM:
#              turbo sin --continue cuando otra tarea falla, el techo de
#              un Bash de agente), no una promesa sin resolver
#              (docs/propuestas/CIM-12.md §Mecanismo)
#   errores    errores sin capturar de vitest («Errors N errors»)
#   tareas     tareas de turbo en rojo («Failed: @mc/db#test, …»)
#   reloj      con --dias o --ancla: tareas de pruebas que no dijeron su
#              reloj (ver abajo); «-» sin ellas
#
# Al final, el total. Sale con 1 si alguna corrida tuvo un solo número
# distinto de cero en esas columnas o una salida distinta de 0.
#
# Los registros completos quedan en $ESTRES_DIR (por omisión, una
# carpeta nueva en el directorio temporal): corrida-NN.log, con su
# .codigo y su .carga (las lecturas de `uptime`).
#
# El reloj (scripts/pruebas/reloj.mjs y maquina.mjs): las suites que
# miran la demo (@mc/db, @mc/worker, @mc/web) corren siempre con el reloj
# anclado al 5-oct-2026, sea el día que sea. --dias mueve la MÁQUINA
# (todos los procesos, con NODE_OPTIONS) y --ancla mueve el ANCLA. Con
# cualquiera de los dos, cada proceso dice su reloj por stderr («reloj:
# …») y la columna «reloj» cuenta las tareas de pruebas que NO lo dijeron:
# si turbo no les pasó la variable (modo estricto, turbo.json), la corrida
# no probó nada y sale en rojo.
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
DIAS=""        # lista de días de la máquina, o «rotando»
ANCLA=""       # lista de días del ancla, o «rotando»
SIN_ANCLA=0
SOLO_TEST=0
USO="Uso: $0 [N] [--paralelo P] [--dias LISTA|--dias-rotando] [--ancla LISTA|--ancla-rotando] [--sin-ancla] [--solo-test]   (--help para más)"
lista_ok() { case "$1" in rotando) return 0 ;; ''|*[!0-9,-]*) return 1 ;; *) return 0 ;; esac; }
while [ "$#" -gt 0 ]; do
  case "$1" in
    -h|--help) ayuda; exit 0 ;;
    --dias-rotando) DIAS=rotando ;;
    --dias) shift; DIAS="${1:-}" ;;
    --dias=*) DIAS="${1#--dias=}" ;;
    --ancla-rotando) ANCLA=rotando ;;
    --ancla) shift; ANCLA="${1:-}" ;;
    --ancla=*) ANCLA="${1#--ancla=}" ;;
    --sin-ancla) SIN_ANCLA=1 ;;
    --solo-test) SOLO_TEST=1 ;;
    --paralelo) shift; P="${1:-}" ;;
    --paralelo=*) P="${1#--paralelo=}" ;;
    ''|*[!0-9]*) echo "$USO" >&2; exit 2 ;;
    *) N="$1" ;;
  esac
  shift
done
for l in "$DIAS" "$ANCLA"; do
  if [ -n "$l" ] && ! lista_ok "$l"; then echo "--dias y --ancla piden una lista de enteros separados por comas (2,7,30,90)." >&2; exit 2; fi
done
case "$P" in ''|*[!0-9]*) echo "--paralelo pide un número." >&2; exit 2 ;; esac
if [ "$N" -lt 1 ] || [ "$P" -lt 1 ]; then echo "N y P tienen que ser al menos 1." >&2; exit 2; fi

# Aquí la espera de turno es parte de lo que se mide: sin techo, salvo que se pida.
export MC_VERIFICAR_ESPERA_MAX="${MC_VERIFICAR_ESPERA_MAX:-0}"

DIR="${ESTRES_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/estres-verificar.XXXXXX")}"
mkdir -p "$DIR"
MAQUINA="$RAIZ/scripts/pruebas/maquina.mjs"

if [ "$SOLO_TEST" = 1 ]; then
  COMANDO=(bash "$RAIZ/scripts/verificar.sh" pnpm exec turbo run test --force --concurrency=2 --continue)
else
  COMANDO=(pnpm verificar)
fi

echo "estres-verificar: $N corridas de '${COMANDO[*]}', de a $P, en $RAIZ"
echo "registros en $DIR"
echo "carga al empezar: $(uptime | sed 's/.*load averages*: *//')"
[ -n "$DIAS" ] && echo "la máquina, días: $DIAS"
[ -n "$ANCLA" ] && echo "el ancla de las pruebas, días: $ANCLA"
[ "$SIN_ANCLA" = 1 ] && echo "SIN ancla: las pruebas ven el reloj de la máquina"
echo

registro() { printf '%s/corrida-%02d.log' "$DIR" "$1"; }

# La carga de 1 minuto de una línea de `uptime` (macOS o Linux).
carga1() { sed -E 's/.*load averages?: *([0-9]+[.,][0-9]+).*/\1/' | tr ',' '.'; }

# El elemento i (desde 1) de una lista separada por comas, dando la vuelta;
# con «rotando», i-1; vacía, 0.
dia_de() {
  local lista="$1" i="$2" n
  [ -z "$lista" ] && { echo 0; return; }
  [ "$lista" = rotando ] && { echo $((i - 1)); return; }
  IFS=, read -r -a v <<<"$lista"
  n=${#v[@]}
  echo "${v[$(((i - 1) % n))]}"
}

# Una corrida: registro en corrida-NN.log, su código y segundos en
# .codigo, y la carga (inicio, cada 30 s, fin) en .carga.
correr() {
  local i="$1" dm="$2" da="$3" log inicio codigo muestreo
  log="$(registro "$i")"
  inicio=$SECONDS
  echo "inicio $(uptime)" >"$log.carga"
  (while sleep 30; do echo "durante $(uptime)" >>"$log.carga"; done) &
  muestreo=$!
  (
    cd "$RAIZ" || exit 1
    if [ "$dm" != 0 ]; then
      export MC_RELOJ_DIAS="$dm"
      export NODE_OPTIONS="${NODE_OPTIONS:-} --import $MAQUINA"
    fi
    [ "$da" != 0 ] && export MC_RELOJ_ANCLA_DIAS="$da"
    [ "$SIN_ANCLA" = 1 ] && export MC_RELOJ_ANCLA=real
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

# Cuántas tareas de pruebas no dijeron su reloj, con la máquina a +dm días
# y el ancla a +da (ver la cabecera); «-» si no se movió nada.
sin_reloj() {
  local log="$1" dm="$2" da="$3" limpio tareas t falta=0
  if [ "$dm" = 0 ] && { [ "$da" = 0 ] || [ "$SIN_ANCLA" = 1 ]; }; then echo -; return; fi
  limpio="$(perl -pe 's/\e\[[0-9;]*m//g' "$log")"
  if [ "$dm" != 0 ]; then
    # maquina.mjs va en NODE_OPTIONS: lo dice cada proceso de cada tarea.
    tareas=$(grep -aoE '^[^ ]+:test:' <<<"$limpio" | sort -u)
  else
    # Solo el ancla: lo dicen las suites que cargan reloj.mjs.
    tareas='@mc/db:test: @mc/worker:test: @mc/web:test:'
  fi
  for t in $tareas; do
    grep -aqF "$t reloj:" <<<"$limpio" || falta=$((falta + 1))
  done
  echo "$falta"
}

# «inicio→máxima→fin» de la carga de 1 minuto de una corrida.
cargas() {
  local f="$1.carga" ini fin max
  ini=$(grep -a '^inicio' "$f" | carga1)
  fin=$(grep -a '^fin' "$f" | carga1)
  max=$(carga1 <"$f" | sort -n | tail -1)
  echo "${ini}→${max}→${fin}"
}

FORMATO='%-7s %-11s %-6s %-8s %-6s %-19s %-8s %-8s %-8s %-7s %-7s %-6s %s\n'
total_f=0 total_a=0 total_c=0 total_e=0 total_t=0 total_r=0 rojas=0

fila() {
  local i="$1" log codigo segundos f a s c e t espera dm da r reloj
  log="$(registro "$i")"
  read -r codigo segundos <"$log.codigo"
  read -r f a s c e t espera < <(contar "$log")
  dm=$(dia_de "$DIAS" "$i")
  da=$(dia_de "$ANCLA" "$i")
  reloj="m+$dm"
  if [ "$SIN_ANCLA" = 1 ]; then reloj="$reloj,real"; else reloj="$reloj,a+$da"; fi
  r=$(sin_reloj "$log" "$dm" "$da")
  printf "$FORMATO" "$i" "$reloj" "$codigo" "$segundos" "$espera" "$(cargas "$log")" "$f" "$a" "$s" "$c" "$e" "$t" "$r"
  total_f=$((total_f + f)); total_a=$((total_a + a)); total_c=$((total_c + c))
  total_e=$((total_e + e)); total_t=$((total_t + t))
  [ "$r" != - ] && total_r=$((total_r + r))
  if [ "$codigo" != 0 ] || [ "$f" != 0 ] || [ "$a" != 0 ] || [ "$c" != 0 ] || [ "$e" != 0 ] || [ "$t" != 0 ] || { [ "$r" != - ] && [ "$r" != 0 ]; }; then
    rojas=$((rojas + 1))
    # Qué falló, para no tener que abrir el registro.
    perl -pe 's/\e\[[0-9;]*m//g' "$log" | grep -aE '✖ .*\([0-9.]+m?s\)$| FAIL |^ *Failed: ' | sort -u | head -15 | sed 's/^/    /'
  fi
}

printf "$FORMATO" corrida 'reloj' codigo segundos espera 'carga ini→máx→fin' fallidas archivos saltadas cancel. errores tareas reloj
i=0
while [ "$i" -lt "$N" ]; do
  desde=$((i + 1))
  hasta=$((i + P))
  [ "$hasta" -gt "$N" ] && hasta=$N
  for k in $(seq "$desde" "$hasta"); do
    correr "$k" "$(dia_de "$DIAS" "$k")" "$(dia_de "$ANCLA" "$k")" &
  done
  wait
  for k in $(seq "$desde" "$hasta"); do fila "$k"; done
  i=$hasta
done

echo
echo "carga al terminar: $(uptime | sed 's/.*load averages*: *//')"
echo "total: $N corridas de a $P, $rojas en rojo; $total_f pruebas fallidas, $total_a archivos en FAIL, $total_c canceladas, $total_e errores sin capturar, $total_t tareas en rojo, $total_r tareas sin su reloj"
echo "registros: $DIR"
[ "$rojas" = 0 ]
