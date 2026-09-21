#!/usr/bin/env bash
# =====================================================================
# vercel.sh — el token de Vercel de MultiCampaign.
#
# El problema es el mismo que con GitHub: el dashboard se despliega en
# Vercel y cualquiera del equipo tiene que poder desplegar. Las dos
# salidas habituales fallan igual:
#
#   - `vercel login` en la máquina de cada uno: cada quien despliega a
#     un proyecto distinto, y el que no tenga cuenta no despliega nada.
#   - El token pasado por WhatsApp: acaba viviendo en cinco chats.
#
# La solución es la del vault: el token viaja DENTRO del repositorio,
# cifrado con AES-256 y la MISMA frase de paso que la base de datos y
# GitHub. Quien ya corrió `make db.unlock` puede desplegar, sin secreto
# nuevo que pedir.
#
# Y la CLI de Vercel nunca lo ve escrito en el disco de forma estable:
# este script lo descifra en memoria, lo deja en un directorio temporal
# de permisos 700 que borra al terminar, y nunca lo pasa como argumento
# —los argumentos se ven en `ps` y quedan en el historial del shell.
#
#   ./scripts/vercel.sh set          guarda (o rota) el token
#   ./scripts/vercel.sh link         crea o adopta el proyecto y lo enlaza
#   ./scripts/vercel.sh status       qué hay guardado, sin revelarlo
#   ./scripts/vercel.sh check        pregunta a Vercel: quién, qué equipo, cuándo expira
#   ./scripts/vercel.sh deploy       despliega una vista previa (--prod para producción)
#   ./scripts/vercel.sh run ...      cualquier comando de la CLI con el token compartido
#   ./scripts/vercel.sh unlink       quita el enlace local (no toca el vault)
#
# La frase de paso se busca en MC_VAULT_PASSPHRASE y en el gestor de
# secretos del sistema, en ese orden. Igual que en vault.sh.
# =====================================================================
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$RAIZ/scripts/lib/frase.sh"
CIFRADO="$RAIZ/secrets/vercel.env.enc"
ITER=600000
API="https://api.vercel.com"

# Todo lo efímero (cabeceras HTTP, credenciales de la CLI) vive aquí y se
# borra al salir, pase lo que pase. 700: solo lo lee quien lo creó.
TEMPO="$(mktemp -d "${TMPDIR:-/tmp}/mc-vercel.XXXXXX")"
chmod 700 "$TEMPO"
trap 'rm -rf "$TEMPO"' EXIT INT TERM
CABECERA="$TEMPO/cabeceras"

rojo()     { printf '\033[31m%s\033[0m\n' "$*" >&2; }
verde()    { printf '\033[32m%s\033[0m\n' "$*"; }
gris()     { printf '\033[90m%s\033[0m\n' "$*"; }
amarillo() { printf '\033[33m%s\033[0m\n' "$*" >&2; }

# ---------------------------------------------------------------------
# Frase de paso, cifrado y descifrado — idénticos a github.sh
# ---------------------------------------------------------------------
obtener_frase() {
  if [[ -n "${MC_VAULT_PASSPHRASE:-}" ]]; then printf '%s' "$MC_VAULT_PASSPHRASE"; return 0; fi
  local k; k="$(llavero_leer)"
  [[ -n "$k" ]] || return 1
  printf '%s' "$k"
}

descifrar() {
  [[ -f "$CIFRADO" ]] || return 2
  local frase; frase="$(obtener_frase)" || return 3
  VAULT_PASS="$frase" openssl enc -d -aes-256-cbc -pbkdf2 -iter "$ITER" -base64 \
    -in "$CIFRADO" -pass env:VAULT_PASS 2>/dev/null
}

diagnosticar() {
  case "${1:-}" in
    2) rojo "No existe $CIFRADO — corre primero: make vercel.set" ;;
    3) rojo "No hay frase de paso. Corre 'make db.unlock' una vez (la guarda en $(llavero_nombre))"
       rojo "o pásala en MC_VAULT_PASSPHRASE. Si no la tienes, pídesela a Rasheed." ;;
    *) rojo "La frase de paso no abre secrets/vercel.env.enc." ;;
  esac
}

enmascarar() { sed -E 's/^(.{8}).*(.{6})$/\1••••••••\2/'; }

# ---------------------------------------------------------------------
# El vault, como variables V_*
# ---------------------------------------------------------------------
# El archivo tiene siempre las mismas siete claves y en el mismo orden,
# para que un `git diff` del .enc no dependa de en qué orden se escribió.
# VERCEL_APP_DIR es relativo a platform/, que es donde vive el código.
V_USER='' V_SCOPE='' V_ORG_ID='' V_PROJECT='' V_PROJECT_ID='' V_APP_DIR='' V_TOKEN=''

cargar_vault() {
  local c rc=0; c="$(descifrar)" || rc=$?
  if [[ $rc -ne 0 ]]; then return $rc; fi
  V_USER="$(      sed -n 's/^VERCEL_USER=//p'       <<<"$c" | head -1)"
  V_SCOPE="$(     sed -n 's/^VERCEL_SCOPE=//p'      <<<"$c" | head -1)"
  V_ORG_ID="$(    sed -n 's/^VERCEL_ORG_ID=//p'     <<<"$c" | head -1)"
  V_PROJECT="$(   sed -n 's/^VERCEL_PROJECT=//p'    <<<"$c" | head -1)"
  V_PROJECT_ID="$(sed -n 's/^VERCEL_PROJECT_ID=//p' <<<"$c" | head -1)"
  V_APP_DIR="$(   sed -n 's/^VERCEL_APP_DIR=//p'    <<<"$c" | head -1)"
  V_TOKEN="$(     sed -n 's/^VERCEL_TOKEN=//p'      <<<"$c" | head -1)"
}

guardar_vault() {
  local frase; frase="$(obtener_frase)" || { diagnosticar 3; exit 1; }
  printf 'VERCEL_USER=%s\nVERCEL_SCOPE=%s\nVERCEL_ORG_ID=%s\nVERCEL_PROJECT=%s\nVERCEL_PROJECT_ID=%s\nVERCEL_APP_DIR=%s\nVERCEL_TOKEN=%s\n' \
    "$V_USER" "$V_SCOPE" "$V_ORG_ID" "$V_PROJECT" "$V_PROJECT_ID" "$V_APP_DIR" "$V_TOKEN" \
    | VAULT_PASS="$frase" openssl enc -aes-256-cbc -pbkdf2 -iter "$ITER" -salt -base64 \
        -out "$CIFRADO" -pass env:VAULT_PASS
  chmod 644 "$CIFRADO"
}

# Abre el vault o se muere explicando por qué no pudo.
exigir_vault() {
  local rc=0; cargar_vault || rc=$?
  [[ $rc -eq 0 ]] || { diagnosticar "$rc"; exit 1; }
  [[ -n "$V_TOKEN" ]] || { rojo "El vault no tiene VERCEL_TOKEN. Corre: make vercel.set"; exit 1; }
}

# ---------------------------------------------------------------------
# API de Vercel
# ---------------------------------------------------------------------
# El token va por la configuración que curl lee de la entrada estándar,
# no por -H: un argumento se ve en `ps` mientras la petición está viva.
#
#   api METODO RUTA [archivo_con_el_cuerpo]
#
# Imprime el cuerpo por la salida estándar. El código HTTP NO puede
# volver por una variable: api() casi siempre se llama dentro de $( ),
# que es una subshell, y lo que se asigne ahí muere ahí. Va por archivo,
# y se lee con codigo_http.
api() {
  local metodo="$1" ruta="$2" cuerpo="${3:-}"
  {
    printf 'silent\nshow-error\n'
    printf 'request = "%s"\n' "$metodo"
    printf 'header = "Authorization: Bearer %s"\n' "$V_TOKEN"
    printf 'header = "Content-Type: application/json"\n'
    [[ -n "$cuerpo" ]] && printf 'data = "@%s"\n' "$cuerpo"
    printf 'dump-header = "%s"\n' "$CABECERA"
    printf 'url = "%s%s"\n' "$API" "$ruta"
  } | curl -K -
}

# El código de la última respuesta. Con redirecciones hay varias líneas
# de estado en el volcado; la que vale es la última.
codigo_http() { grep -a '^HTTP/' "$CABECERA" 2>/dev/null | tail -1 | awk '{print $2}'; }

# json CLAVE [CLAVE...] — saca un campo del JSON que llega por stdin.
# node ya es obligatorio en este repo, y la propia CLI de Vercel es node:
# no estamos agregando una dependencia, estamos usando la que hay.
json() {
  node -e '
    let e = ""
    process.stdin.on("data", d => e += d).on("end", () => {
      let o; try { o = JSON.parse(e) } catch { process.exit(1) }
      for (const k of process.argv.slice(1)) { if (o == null) break; o = o[k] }
      if (o !== undefined && o !== null) process.stdout.write(String(o))
    })' "$@"
}

# ---------------------------------------------------------------------
# La CLI de Vercel, con el token del vault
# ---------------------------------------------------------------------
binario_cli() {
  if   command -v vercel >/dev/null 2>&1; then CLI=(vercel)
  elif command -v npx    >/dev/null 2>&1; then CLI=(npx --yes vercel@latest)
  else
    rojo "No hay CLI de Vercel ni npx en esta máquina."
    gris "   npm install -g vercel     (o instala node, que trae npx)"
    return 1
  fi
}

# correr_cli ARGS... — el token entra por un directorio de configuración
# temporal (700, borrado al salir), nunca por --token: los argumentos se
# ven en `ps`. De paso aísla del `vercel login` que cada quien tenga.
correr_cli() {
  local CLI; binario_cli || exit 1
  local dir="$TEMPO/cli"
  mkdir -p "$dir"
  printf '{"token":"%s"}' "$V_TOKEN" > "$dir/auth.json"
  chmod 600 "$dir/auth.json"

  local -a alcance=()
  # Si quien llama ya puso --scope, se respeta el suyo.
  [[ -n "$V_SCOPE" && " $* " != *" --scope "* ]] && alcance=(--scope "$V_SCOPE")

  # ORG_ID y PROJECT_ID son la forma documentada de enlazar sin .vercel/,
  # que es lo que permite desplegar desde un clon recién bajado.
  VERCEL_TELEMETRY_DISABLED=1 \
  VERCEL_ORG_ID="$V_ORG_ID" \
  VERCEL_PROJECT_ID="$V_PROJECT_ID" \
    "${CLI[@]}" --global-config "$dir" "${alcance[@]}" "$@"
}

# ---------------------------------------------------------------------
# set — guarda o rota el token
# ---------------------------------------------------------------------
cmd_set() {
  local alcance_pedido=''
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --scope) alcance_pedido="${2:-}"; shift 2 ;;
      *) rojo "Uso: vercel.sh set [--scope EQUIPO]"; exit 1 ;;
    esac
  done

  cargar_vault 2>/dev/null || true   # conserva proyecto y directorio si ya había
  local anterior_scope="$V_SCOPE"

  # El token nunca se pasa como argumento, por lo mismo de siempre.
  local token=''
  if   [[ -n "${VERCEL_TOKEN:-}" ]]; then token="$VERCEL_TOKEN"
  elif [[ ! -t 0 ]]; then read -r token
  else printf 'Token de Vercel (no se muestra): ' >&2; read -rs token </dev/tty; printf '\n' >&2
  fi
  [[ -n "$token" ]] || { rojo "Token vacío."; exit 1; }
  V_TOKEN="$token"

  gris "   comprobando el token contra Vercel..."
  local usuario codigo
  usuario="$(api GET /v2/user)"; codigo="$(codigo_http)"
  [[ "$codigo" == "200" ]] || { rojo "Vercel rechaza ese token (HTTP ${codigo:-sin respuesta})."; exit 1; }
  V_USER="$(json user username <<<"$usuario")"
  local equipo_por_defecto; equipo_por_defecto="$(json user defaultTeamId <<<"$usuario")"

  # Qué equipo: el pedido, si lo hay; si no, el de por defecto de la
  # cuenta; si no hay ninguno, la cuenta personal.
  local equipos; equipos="$(api GET /v2/teams)"
  local elegido; elegido="$(EQ="${alcance_pedido}" DEF="$equipo_por_defecto" node -e '
    let e = ""
    process.stdin.on("data", d => e += d).on("end", () => {
      const t = (JSON.parse(e).teams || [])
      const q = process.env.EQ, def = process.env.DEF
      const m = q ? t.find(x => x.slug === q || x.id === q)
                  : (t.find(x => x.id === def) || t[0])
      if (m) process.stdout.write(m.slug + "\t" + m.id)
    })' <<<"$equipos")"

  if [[ -n "$alcance_pedido" && -z "$elegido" ]]; then
    rojo "El token no ve ningún equipo llamado '$alcance_pedido'."; exit 1
  fi
  if [[ -n "$elegido" ]]; then
    V_SCOPE="${elegido%%$'\t'*}"
    V_ORG_ID="${elegido##*$'\t'}"
  else
    # Cuenta sin equipos: se despliega a nombre de la persona.
    V_SCOPE="$V_USER"; V_ORG_ID=''
  fi

  # Cambiar de equipo invalida los ids del proyecto: pertenecen al viejo.
  if [[ -n "$anterior_scope" && "$anterior_scope" != "$V_SCOPE" ]]; then
    amarillo "El alcance cambió de $anterior_scope a $V_SCOPE: se olvida el proyecto enlazado."
    V_PROJECT='' V_PROJECT_ID=''
  fi
  V_APP_DIR="${V_APP_DIR:-apps/web}"

  guardar_vault
  verde "✓ token de $V_USER (equipo $V_SCOPE) guardado y cifrado en secrets/vercel.env.enc"
  gris  "   Commitéalo: sin la frase de paso no dice nada."
  gris  "   Ahora: make vercel.link"
}

# ---------------------------------------------------------------------
# link — crea o adopta el proyecto, y lo enlaza en ESTE clon
# ---------------------------------------------------------------------
cmd_link() {
  exigir_vault
  local nombre="${1:-${V_PROJECT:-multicampaign-web}}"
  local q=''; [[ -n "$V_ORG_ID" ]] && q="?teamId=$V_ORG_ID"

  local proyecto codigo
  proyecto="$(api GET "/v9/projects/$nombre$q")"; codigo="$(codigo_http)"
  if [[ "$codigo" == "404" ]]; then
    gris "   no existe el proyecto '$nombre' en $V_SCOPE — creándolo..."
    local cuerpo; cuerpo="$(mktemp)"; trap 'rm -f "$cuerpo"' RETURN
    printf '{"name":"%s","framework":"nextjs"}' "$nombre" > "$cuerpo"
    proyecto="$(api POST "/v10/projects$q" "$cuerpo")"; codigo="$(codigo_http)"
    [[ "$codigo" =~ ^20 ]] || {
      rojo "Vercel no dejó crear el proyecto (HTTP ${codigo:-sin respuesta}):"
      rojo "$(json error message <<<"$proyecto")"; exit 1; }
    verde "✓ proyecto $nombre creado en $V_SCOPE"
  elif [[ "$codigo" != "200" ]]; then
    rojo "Vercel respondió HTTP ${codigo:-sin respuesta} al buscar el proyecto."; exit 1
  fi

  V_PROJECT="$(json name <<<"$proyecto")"
  V_PROJECT_ID="$(json id <<<"$proyecto")"
  V_APP_DIR="${V_APP_DIR:-apps/web}"
  guardar_vault

  # El enlace local: es lo que hace que `vercel` a secas, sin este
  # script, sepa a qué proyecto va. Es por clon y no se versiona.
  local destino="$RAIZ/$V_APP_DIR/.vercel"
  mkdir -p "$destino"
  printf '{"orgId":"%s","projectId":"%s","projectName":"%s"}\n' \
    "$V_ORG_ID" "$V_PROJECT_ID" "$V_PROJECT" > "$destino/project.json"

  verde "✓ $V_APP_DIR enlazado a $V_SCOPE/$V_PROJECT"
  gris  "   El token NO está en $V_APP_DIR/.vercel: ahí solo hay ids públicos."
  if [[ ! -f "$RAIZ/$V_APP_DIR/package.json" ]]; then
    amarillo "Ojo: $V_APP_DIR todavía no tiene package.json — no hay nada que desplegar."
  fi
  gris  "   Commitea secrets/vercel.env.enc: ahora lleva el id del proyecto."
}

cmd_unlink() {
  local rc=0; cargar_vault || rc=$?
  local dir="${V_APP_DIR:-apps/web}"
  rm -rf "$RAIZ/$dir/.vercel"
  verde "✓ enlace local retirado de $dir (el vault cifrado sigue intacto)"
}

# ---------------------------------------------------------------------
# deploy / run
# ---------------------------------------------------------------------
cmd_deploy() {
  exigir_vault
  [[ -n "$V_PROJECT_ID" ]] || { rojo "No hay proyecto enlazado. Corre: make vercel.link"; exit 1; }
  local dir="$RAIZ/${V_APP_DIR:-apps/web}"
  [[ -f "$dir/package.json" ]] || {
    rojo "No hay nada que desplegar en ${V_APP_DIR:-apps/web} (falta package.json)."; exit 1; }
  correr_cli deploy --cwd "$dir" --yes "$@"
}

cmd_run() {
  exigir_vault
  [[ $# -gt 0 ]] || { rojo 'Uso: vercel.sh run <comando de la CLI>   p.ej.  run project ls'; exit 1; }
  correr_cli "$@"
}

# ---------------------------------------------------------------------
# status / check
# ---------------------------------------------------------------------
cmd_status() {
  printf '\n  Vault:       %s\n' "$CIFRADO"
  if [[ -f "$CIFRADO" ]]; then
    printf '  Cifrado:     AES-256-CBC · PBKDF2 %s iteraciones · %s bytes\n' \
      "$ITER" "$(wc -c <"$CIFRADO" | tr -d ' ')"
  else
    printf '  Cifrado:     \033[31mNO EXISTE — corre make vercel.set\033[0m\n\n'; return
  fi

  local rc=0; cargar_vault || rc=$?
  if [[ $rc -ne 0 ]]; then printf '\n'; diagnosticar "$rc"; return; fi

  printf '\n  Contiene (valores ocultos):\n'
  printf '    %-18s %s\n' VERCEL_USER       "$V_USER"
  printf '    %-18s %s\n' VERCEL_SCOPE      "$V_SCOPE"
  printf '    %-18s %s\n' VERCEL_ORG_ID     "$V_ORG_ID"
  printf '    %-18s %s\n' VERCEL_PROJECT    "${V_PROJECT:-— sin enlazar (make vercel.link)}"
  printf '    %-18s %s\n' VERCEL_PROJECT_ID "${V_PROJECT_ID:-—}"
  printf '    %-18s %s\n' VERCEL_APP_DIR    "$V_APP_DIR"
  printf '    %-18s %s\n' VERCEL_TOKEN      "$(printf '%s' "$V_TOKEN" | enmascarar)"

  printf '\n  En este clon:\n'
  local enlace="$RAIZ/${V_APP_DIR:-apps/web}/.vercel/project.json"
  printf '    %-18s %s\n' enlace \
    "$([[ -f "$enlace" ]] && echo "${V_APP_DIR}/.vercel ✓" || echo 'sin enlazar — make vercel.link')"
  printf '    %-18s %s\n' cli \
    "$(command -v vercel >/dev/null 2>&1 && vercel --version 2>/dev/null | grep -m1 . || echo 'no instalada — se usará npx')"

  # Que el token no ande suelto en el disco no es un detalle: es lo que
  # este script existe para garantizar.
  if [[ -f "$enlace" ]] && grep -q 'token' "$enlace" 2>/dev/null; then
    printf '    %-18s \033[31mHAY ALGO PARECIDO A UN TOKEN EN .vercel/project.json\033[0m\n' fuga
  else
    printf '    %-18s ningún token fuera del vault ✓\n' fuga
  fi
  printf '\n'
}

cmd_check() {
  exigir_vault

  local usuario codigo
  usuario="$(api GET /v2/user)"; codigo="$(codigo_http)"
  [[ "$codigo" == "200" ]] || {
    rojo "Vercel rechaza el token guardado (HTTP ${codigo:-sin respuesta}). Rótalo: make vercel.set"; exit 1; }

  local meta; meta="$(api GET /v5/user/tokens/current)"
  local expira; expira="$(json token expiresAt <<<"$meta")"
  local caduca='no expira'
  if [[ -n "$expira" ]]; then
    caduca="$(node -e 'const d=new Date(Number(process.argv[1]));
      const q=Math.round((d-Date.now())/86400000);
      process.stdout.write(d.toISOString().slice(0,10)+" ("+q+" días)")' "$expira")"
  fi

  printf '\n  Token de Vercel\n'
  printf '    %-14s %s\n' usuario "$(json user username <<<"$usuario")"
  printf '    %-14s %s\n' correo  "$(json user email    <<<"$usuario")"
  printf '    %-14s %s\n' nombre  "$(json token name    <<<"$meta")"
  printf '    %-14s %s\n' expira  "$caduca"
  printf '    %-14s %s\n' alcance "$(json token scopes 0 type <<<"$meta") · equipo $V_SCOPE"

  local q=''; [[ -n "$V_ORG_ID" ]] && q="?teamId=$V_ORG_ID"
  local proyectos; proyectos="$(api GET "/v9/projects${q:-?}${q:+&}limit=100")"
  if [[ "$(codigo_http)" == "200" ]]; then
    printf '    %-14s %s\n' proyectos \
      "$(json_lista <<<"$proyectos")"
  else
    printf '    %-14s no se pudieron listar (HTTP %s)\n' proyectos "$(codigo_http)"
  fi

  if [[ -n "$V_PROJECT_ID" ]]; then
    local p; p="$(api GET "/v9/projects/$V_PROJECT_ID$q")"
    if [[ "$(codigo_http)" == "200" ]]; then
      printf '    %-14s %s ✓\n' enlazado "$(json name <<<"$p")"
    else
      printf '    %-14s \033[31mel proyecto guardado ya no existe — make vercel.link\033[0m\n' enlazado
    fi
  else
    printf '    %-14s ninguno — make vercel.link\n' enlazado
  fi
  printf '\n'
}

json_lista() {
  node -e '
    let e = ""
    process.stdin.on("data", d => e += d).on("end", () => {
      const p = (JSON.parse(e).projects || []).map(x => x.name)
      process.stdout.write(p.length ? p.join(", ") : "ninguno todavía")
    })'
}

case "${1:-}" in
  set)      shift; cmd_set "$@" ;;
  link)     shift; cmd_link "${1:-}" ;;
  unlink)   cmd_unlink ;;
  deploy)   shift; cmd_deploy "$@" ;;
  run)      shift; cmd_run "$@" ;;
  status)   cmd_status ;;
  check)    cmd_check ;;
  *) sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
esac
