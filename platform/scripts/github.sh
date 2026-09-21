#!/usr/bin/env bash
# =====================================================================
# github.sh — el token de GitHub de MultiCampaign.
#
# El problema: somos dos trabajando sobre el mismo repositorio y los
# dos necesitamos empujar. Las dos salidas habituales fallan igual que
# con la base de datos:
#
#   - El token pegado en la URL del remoto (https://TOKEN@github.com/…)
#     queda en claro dentro de .git/config, se filtra en cualquier
#     `git remote -v`, en un screenshot, en un pantallazo compartido.
#   - El token solo en la máquina de cada uno acaba pasándose por
#     WhatsApp y viviendo en cinco chats distintos.
#
# La solución es la del vault: el token viaja DENTRO del repositorio,
# cifrado con AES-256 y la MISMA frase de paso que secrets/supabase.env.enc.
# Quien ya pueda abrir la base de datos puede empujar, sin secreto nuevo.
#
# Y git nunca lo ve escrito: este script se instala como "credential
# helper", así que git lo pide cuando lo necesita, el script descifra
# en memoria, se lo entrega por una tubería y termina. No toca el disco
# en claro, no entra en .git/config, no sale en `git remote -v`.
#
#   ./scripts/github.sh set        guarda (o rota) el token
#   ./scripts/github.sh install    configura el remoto y el helper
#   ./scripts/github.sh status     qué hay guardado, sin revelarlo
#   ./scripts/github.sh check      pregunta a GitHub: quién, qué permisos
#   ./scripts/github.sh mine       usa TUS credenciales, no el token compartido
#   ./scripts/github.sh uninstall  quita el helper de este clon
#   ./scripts/github.sh credential <get|store|erase>   ← lo llama git
#
# La frase de paso se busca en MC_VAULT_PASSPHRASE y en el Llavero de
# macOS, en ese orden. NUNCA por teclado: cuando git invoca este script
# la entrada estándar es la petición de credenciales, no una persona.
# =====================================================================
set -euo pipefail

ESTE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$RAIZ/scripts/lib/frase.sh"
REPO="$(cd "$RAIZ/.." && pwd)"
CIFRADO="$RAIZ/secrets/github.env.enc"
ITER=600000

rojo()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
gris()  { printf '\033[90m%s\033[0m\n' "$*"; }
amarillo() { printf '\033[33m%s\033[0m\n' "$*" >&2; }

# ---------------------------------------------------------------------
# Frase de paso y descifrado
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

# valor CLAVE — imprime una sola variable del vault
valor() { descifrar | sed -n "s/^$1=//p" | head -1; }

enmascarar() { sed -E 's/^(.{7}).*(.{4})$/\1••••••••\2/'; }

# Explica por qué falló el descifrado, en lugar de fallar en silencio.
diagnosticar() {
  case "${1:-}" in
    2) rojo "No existe $CIFRADO — corre primero: make github.set" ;;
    3) rojo "No hay frase de paso. Corre 'make db.unlock' una vez (la guarda en $(llavero_nombre))"
       rojo "o pásala en MC_VAULT_PASSPHRASE. Si no la tienes, pídesela a Rasheed." ;;
    *) rojo "La frase de paso no abre secrets/github.env.enc." ;;
  esac
}

# ---------------------------------------------------------------------
# credential — el protocolo de git.  git escribe la petición por stdin
# como líneas clave=valor y espera lo mismo de vuelta.
# ---------------------------------------------------------------------
cmd_credential() {
  local op="${1:-}"
  # Solo 'get' entrega algo. 'store' y 'erase' no hacen nada a propósito:
  # la única fuente de verdad es el vault cifrado, y git no debe intentar
  # guardar copias del token en ningún otro sitio.
  [[ "$op" == "get" ]] || exit 0

  local protocol='' host='' path='' linea
  while IFS= read -r linea; do
    [[ -z "$linea" ]] && break
    case "$linea" in
      protocol=*) protocol="${linea#protocol=}" ;;
      host=*)     host="${linea#host=}" ;;
      path=*)     path="${linea#path=}" ;;
    esac
  done

  local contenido; contenido="$(descifrar)" || exit 0
  local usuario token repo_url esperado
  usuario="$(printf '%s' "$contenido" | sed -n 's/^GITHUB_USER=//p'  | head -1)"
  token="$(  printf '%s' "$contenido" | sed -n 's/^GITHUB_TOKEN=//p' | head -1)"
  repo_url="$(printf '%s' "$contenido" | sed -n 's/^GITHUB_REPO=//p' | head -1)"

  # El token vale para toda la cuenta, así que el helper lo entrega SOLO
  # para el repositorio que tiene guardado. Si git pregunta por otro
  # host u otra ruta, este script calla y git pedirá credenciales aparte.
  esperado="${repo_url#https://github.com/}"; esperado="${esperado%.git}"
  [[ "$protocol" == "https" && "$host" == "github.com" ]] || exit 0
  [[ -z "$path" || "${path%.git}" == "$esperado" ]] || exit 0
  [[ -n "$token" ]] || exit 0

  printf 'username=%s\n' "${usuario:-x-access-token}"
  printf 'password=%s\n' "$token"
}

# ---------------------------------------------------------------------
# set — guarda o rota el token
# ---------------------------------------------------------------------
cmd_set() {
  local url="${1:-}" token=''
  [[ -n "$url" ]] || url="$(valor GITHUB_REPO 2>/dev/null || true)"
  [[ -n "$url" ]] || { rojo "Uso: github.sh set https://github.com/USUARIO/REPO.git"; exit 1; }
  [[ "$url" == *.git ]] || url="${url%/}.git"

  # El token nunca se pasa como argumento: los argumentos se ven en `ps`
  # y quedan en el historial del shell.
  if   [[ -n "${GITHUB_TOKEN:-}" ]]; then token="$GITHUB_TOKEN"
  elif [[ ! -t 0 ]]; then read -r token
  else printf 'Token de GitHub (no se muestra): ' >&2; read -rs token </dev/tty; printf '\n' >&2
  fi
  [[ -n "$token" ]] || { rojo "Token vacío."; exit 1; }

  gris "   comprobando el token contra GitHub..."
  local cab; cab="$(mktemp)"; trap 'rm -f "$cab"' RETURN
  local cuerpo
  cuerpo="$(curl -sS -D "$cab" -H "Authorization: Bearer $token" \
                 -H 'Accept: application/vnd.github+json' https://api.github.com/user)"
  grep -q '^HTTP/[0-9.]* 200' "$cab" || { rojo "GitHub rechaza ese token."; exit 1; }
  local login; login="$(printf '%s' "$cuerpo" | sed -n 's/.*"login"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"

  local frase; frase="$(obtener_frase)" || { diagnosticar 3; exit 1; }
  printf 'GITHUB_REPO=%s\nGITHUB_USER=%s\nGITHUB_TOKEN=%s\n' "$url" "$login" "$token" \
    | VAULT_PASS="$frase" openssl enc -aes-256-cbc -pbkdf2 -iter "$ITER" -salt -base64 \
        -out "$CIFRADO" -pass env:VAULT_PASS
  chmod 644 "$CIFRADO"

  verde "✓ token de $login guardado y cifrado en secrets/github.env.enc"
  gris  "   Commitéalo: sin la frase de paso no dice nada."
  gris  "   Ahora: make github.install"
}

# ---------------------------------------------------------------------
# install — remoto + credential helper, en ESTE clon
# ---------------------------------------------------------------------
cmd_install() {
  if tiene_credenciales_propias && [[ "${1:-}" != "--forzar" ]]; then
    local yo; yo="$(usuario_propio)"
    amarillo "Ya te autenticas en GitHub como $yo."
    gris "   Instalar el token compartido haría que TUS push aparezcan como"
    gris "   el dueño del token, no como tú. Mejor:"
    gris ""
    gris "     make github.mine        usa tus credenciales (recomendado)"
    gris "     make github.install-forzado   usa el token compartido igual"
    exit 0
  fi
  local url; url="$(valor GITHUB_REPO)" || { diagnosticar $?; exit 1; }
  [[ -n "$url" ]] || { rojo "El vault no tiene GITHUB_REPO. Corre: make github.set"; exit 1; }

  if git -C "$REPO" remote get-url origin >/dev/null 2>&1; then
    git -C "$REPO" remote set-url origin "$url"
  else
    git -C "$REPO" remote add origin "$url"
  fi

  # useHttpPath hace que git le pase la ruta del repo al helper, que es
  # lo que le permite negarse a entregar el token para otros repos.
  git -C "$REPO" config --local credential.useHttpPath true

  # La cadena vacía BORRA los helpers heredados (macOS trae osxkeychain
  # en la configuración del sistema) solo para github.com y solo en este
  # clon. Sin esto, osxkeychain podría contestar antes con otro token.
  git -C "$REPO" config --local --unset-all 'credential.https://github.com.helper' 2>/dev/null || true
  git -C "$REPO" config --local --add 'credential.https://github.com.helper' ''
  # El '!' delante le dice a git "esto es una línea de shell". Sin él, git
  # solo reconoce la ruta si empieza literalmente por '/', y unas comillas
  # bastan para que crea que es el nombre de un helper suyo y falle.
  git -C "$REPO" config --local --add 'credential.https://github.com.helper' "!'$ESTE' credential"

  verde "✓ remoto origin -> $url"
  verde "✓ credential helper instalado (solo en este clon, solo para ese repo)"
  gris  "   El token NO está en .git/config. Compruébalo: git remote -v"
}

# ---------------------------------------------------------------------
# ¿Esta persona ya se autentica en GitHub como ella misma?
# Si es así, el token compartido sobra: usarlo haría que todos sus push
# aparezcan como el dueño del token, y se pierde saber quién hizo qué.
# ---------------------------------------------------------------------
tiene_credenciales_propias() {
  command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1
}

usuario_propio() {
  gh api user --jq .login 2>/dev/null || true
}

cmd_mine() {
  if ! tiene_credenciales_propias; then
    rojo "No tienes credenciales propias de GitHub en esta máquina."
    gris "   Corre primero:  gh auth login"
    gris "   (elige GitHub.com · HTTPS · autenticar con el navegador)"
    exit 1
  fi

  local yo; yo="$(usuario_propio)"

  # Quitar el helper del token compartido SOLO de este clon.
  git -C "$REPO" config --local --unset-all 'credential.https://github.com.helper' 2>/dev/null || true
  git -C "$REPO" config --local --unset credential.useHttpPath 2>/dev/null || true

  # Y dejar que git use las credenciales de gh.
  gh auth setup-git >/dev/null 2>&1 || true

  local url; url="$(valor GITHUB_REPO 2>/dev/null || true)"
  if [[ -n "$url" ]]; then
    if git -C "$REPO" remote get-url origin >/dev/null 2>&1; then
      git -C "$REPO" remote set-url origin "$url"
    else
      git -C "$REPO" remote add origin "$url"
    fi
  fi

  verde "✓ este clon empuja como $yo, con tus propias credenciales"
  gris  "   el token compartido sigue en el vault, pero este clon ya no lo usa"
  gris  "   tus push quedan a tu nombre y revocarte no afecta a nadie más"
}

cmd_uninstall() {
  git -C "$REPO" config --local --unset-all 'credential.https://github.com.helper' 2>/dev/null || true
  git -C "$REPO" config --local --unset credential.useHttpPath 2>/dev/null || true
  verde "✓ helper retirado de este clon (el vault cifrado sigue intacto)"
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
    printf '  Cifrado:     \033[31mNO EXISTE — corre make github.set\033[0m\n\n'; return
  fi

  local contenido rc=0; contenido="$(descifrar)" || rc=$?
  if [[ $rc -ne 0 || -z "$contenido" ]]; then printf '\n'; diagnosticar "$rc"; return; fi

  printf '\n  Contiene (valores ocultos):\n'
  printf '%s\n' "$contenido" | grep -E '^[A-Z][A-Z0-9_]*=' | while IFS='=' read -r k v; do
    case "$k" in
      GITHUB_TOKEN) printf '    %-16s %s\n' "$k" "$(printf '%s' "$v" | enmascarar)" ;;
      *)            printf '    %-16s %s\n' "$k" "$v" ;;
    esac
  done

  printf '\n  En este clon:\n'
  printf '    %-16s %s\n' remoto "$(git -C "$REPO" remote get-url origin 2>/dev/null || echo 'sin configurar — make github.install')"
  local h; h="$(git -C "$REPO" config --local --get-all 'credential.https://github.com.helper' 2>/dev/null | tail -1 || true)"
  printf '    %-16s %s\n' helper "$([[ -n "$h" ]] && echo "$h" || echo 'sin configurar — make github.install')"

  # Que el token no esté en claro en .git/config no es un detalle: es
  # justamente lo que este script existe para garantizar.
  if git -C "$REPO" config --local --list 2>/dev/null | grep -qE '://[^/@]*:[^/@]*@'; then
    printf '    %-16s \033[31mHAY UNA CREDENCIAL EN CLARO EN .git/config\033[0m\n' fuga
  else
    printf '    %-16s ninguna credencial en claro en .git/config ✓\n' fuga
  fi
  printf '\n'
}

cmd_check() {
  local token; token="$(valor GITHUB_TOKEN)" || { diagnosticar $?; exit 1; }
  [[ -n "$token" ]] || { rojo "El vault no tiene GITHUB_TOKEN."; exit 1; }
  local url; url="$(valor GITHUB_REPO)"; local slug="${url#https://github.com/}"; slug="${slug%.git}"

  local cab; cab="$(mktemp)"; trap 'rm -f "$cab"' RETURN
  local cuerpo
  cuerpo="$(curl -sS -D "$cab" -H "Authorization: Bearer $token" \
                 -H 'Accept: application/vnd.github+json' https://api.github.com/user)"
  if ! grep -q '^HTTP/[0-9.]* 200' "$cab"; then
    rojo "GitHub rechaza el token guardado. Rótalo: make github.set"; exit 1
  fi

  printf '\n  Token de GitHub\n'
  printf '    %-14s %s\n' usuario "$(printf '%s' "$cuerpo" | sed -n 's/.*"login"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  printf '    %-14s %s\n' expira  "$(grep -i '^github-authentication-token-expiration:' "$cab" | cut -d' ' -f2- | tr -d '\r' || echo 'no expira')"
  printf '    %-14s %s\n' alcance "$(grep -i '^x-oauth-scopes:' "$cab" | cut -d' ' -f2- | tr -d '\r' || echo '(fine-grained: limitado por repositorio)')"

  local perms; perms="$(curl -sS -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$slug")"
  printf '    %-14s %s · %s\n' repo "$slug" \
    "$(printf '%s' "$perms" | grep -q '"private"[[:space:]]*:[[:space:]]*true' && echo privado || echo 'PÚBLICO')"
  printf '    %-14s %s\n\n' empujar \
    "$(printf '%s' "$perms" | grep -q '"push"[[:space:]]*:[[:space:]]*true' && echo 'sí ✓' || echo 'NO')"
}

case "${1:-}" in
  set)        shift; cmd_set "${1:-}" ;;
  install)    shift; cmd_install "${1:-}" ;;
  mine)       cmd_mine ;;
  uninstall)  cmd_uninstall ;;
  status)     cmd_status ;;
  check)      cmd_check ;;
  credential) shift; cmd_credential "${1:-}" ;;
  *) sed -n '2,32p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
esac
