# shellcheck shell=bash
# =====================================================================
# estres-contar.sh — cómo lee estres-verificar.sh el registro de una
# corrida de `pnpm verificar` (CIM-12). Se carga con `source`; lo prueba
# scripts/pruebas/estres-contar.test.mjs con registros de ejemplo.
#
# Lo que se lee aquí tiene que dar lo mismo aunque turbo mezcle la
# salida de dos tareas: con dos tareas escribiendo a la vez aparecen
# prefijos como «@mc/db:test:@mc/worker:test:» o «@mc/web:t@mc/web:test:».
# Por eso nada de esto depende del prefijo de turbo:
#   - los totales («ℹ fail N», «Tests N failed»…) se buscan en cualquier
#     parte de la línea;
#   - cada proceso con el reloj movido dice QUIÉN es dentro de su propia
#     línea, «reloj[@mc/db#test]: …» (scripts/pruebas/fecha.mjs), y la
#     lista de tareas que tienen que decirlo sale de turbo
#     (tareas_de_prueba), no de los prefijos del registro.
# =====================================================================

# Suma el número que captura la expresión $1 en cada línea de la entrada.
sumar() { sed -E "s/$1/\\1/" | awk '{s+=$1} END {print s+0}'; }

# El registro $1 sin los colores de la terminal.
sin_color() { perl -pe 's/\e\[[0-9;]*m//g' "$1"; }

# Los contadores de un registro, en una línea:
#   fallidas archivos saltadas canceladas errores tareas espera
contar() {
  local log="$1" limpio node vitest archivos saltadas canceladas errores tareas espera
  limpio="$(sin_color "$log")"
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

# Las tareas `test` de turbo que corren algo, como las nombra el reloj
# («@mc/db#test»; la de la raíz, con el nombre de platform/package.json),
# separadas por espacios. Sale de `turbo run test --dry=json` en $1 (la
# raíz de platform), no de los prefijos de un registro.
# Lo que siga a la raíz son banderas de turbo («--filter=@mc/db»).
tareas_de_prueba() {
  local raiz="$1"
  shift
  (cd "$raiz" && pnpm exec turbo run test --dry=json "$@" 2>/dev/null) | node -e '
    const fs = require("node:fs");
    const raiz = JSON.parse(fs.readFileSync(process.argv[1] + "/package.json", "utf8")).name;
    let s = "";
    process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const tareas = JSON.parse(s).tasks
        .filter((t) => t.task === "test" && t.command !== "<NONEXISTENT>")
        .map((t) => `${t.package === "//" ? raiz : t.package}#test`);
      if (tareas.length === 0) process.exit(1);
      console.log(tareas.sort().join(" "));
    });' "$raiz"
}

# Las tareas que cargan scripts/pruebas/reloj.mjs (package.json de @mc/db
# y del worker, vitest.config.ts de la web): con solo el ancla movida,
# son las que lo dicen.
TAREAS_CON_ANCLA="@mc/db#test @mc/worker#test @mc/web#test"

# Cuántas tareas de pruebas no dijeron su reloj en el registro $1, con la
# máquina a +$2 días, el ancla a +$3, $4 = 1 si se corrió sin ancla y $5 la
# lista de tareas_de_prueba. «-» si no se movió nada (nadie lo dice).
sin_reloj() {
  local log="$1" dm="$2" da="$3" sin_ancla="$4" todas="$5" limpio esperadas t falta=0
  if [ "$dm" = 0 ] && { [ "$da" = 0 ] || [ "$sin_ancla" = 1 ]; }; then echo -; return; fi
  if [ "$dm" != 0 ]; then
    # maquina.mjs va en NODE_OPTIONS: lo dice cada proceso de cada tarea.
    esperadas="$todas"
  else
    # Las que cargan reloj.mjs, de entre las que corren (con --filtro, menos).
    esperadas=""
    for t in $TAREAS_CON_ANCLA; do
      case " $todas " in *" $t "*) esperadas="$esperadas $t" ;; esac
    done
  fi
  limpio="$(sin_color "$log")"
  for t in $esperadas; do
    grep -aqF "reloj[$t]:" <<<"$limpio" || falta=$((falta + 1))
  done
  echo "$falta"
}
