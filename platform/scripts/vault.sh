#!/usr/bin/env bash
# =====================================================================
# vault.sh — las credenciales de MultiCampaign.
#
# El problema que resuelve: el equipo necesita que cualquiera que tenga
# el repositorio pueda tocar la base de datos, pero un archivo con
# contraseñas en claro dentro de un repositorio es una fuga esperando
# a ocurrir.
#
# La solución: las credenciales viajan DENTRO del repositorio, cifradas
# con AES-256. El archivo cifrado (secrets/supabase.env.enc) se versiona
# y no dice nada a quien no tenga la frase de paso. La frase de paso
# NUNCA está en el repositorio: se comparte una vez por un canal aparte
# y queda guardada en el Llavero de macOS.
#
#   ./scripts/vault.sh unlock     descifra  -> .env.local
#   ./scripts/vault.sh lock       cifra     .env.local -> secrets/*.enc
#   ./scripts/vault.sh get CLAVE  imprime un solo valor
#   ./scripts/vault.sh status     qué hay dentro, sin revelar nada
#   ./scripts/vault.sh passphrase cambia la frase de paso
#
# La frase de paso se busca en este orden:
#   1. la variable de entorno MC_VAULT_PASSPHRASE   (para CI)
#   2. el Llavero de macOS                          (para el día a día)
#   3. se pregunta por teclado                      (la primera vez)
# =====================================================================
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$RAIZ/scripts/lib/frase.sh"
# Por defecto, el vault de la base de datos. Otros scripts (github.sh)
# reutilizan este mismo cifrado apuntando a otro archivo con MC_VAULT_FILE.
CIFRADO="${MC_VAULT_FILE:-$RAIZ/secrets/supabase.env.enc}"
CLARO="${MC_VAULT_PLAIN:-$RAIZ/.env.local}"
# 600 000 iteraciones de PBKDF2: hace que probar frases de paso por
# fuerza bruta cueste caro aunque el archivo cifrado se filtre.
ITER=600000

rojo()  { printf '\033[31m%s\033[0m\n' "$*" >&2; }
verde() { printf '\033[32m%s\033[0m\n' "$*"; }
gris()  { printf '\033[90m%s\033[0m\n' "$*"; }

# ---------------------------------------------------------------------
# Frase de paso
# ---------------------------------------------------------------------
# El dónde-se-guarda lo resuelve scripts/lib/frase.sh, por sistema.
obtener_frase() {
  if [[ -n "${MC_VAULT_PASSPHRASE:-}" ]]; then
    printf '%s' "$MC_VAULT_PASSPHRASE"; return
  fi
  local k; k="$(llavero_leer)"
  if [[ -n "$k" ]]; then printf '%s' "$k"; return; fi

  local f
  printf 'Frase de paso del vault: ' >&2
  read -rs f; printf '\n' >&2
  if [[ -z "$f" ]]; then rojo "Frase vacía."; exit 1; fi
  printf '%s' "$f"
}

# ---------------------------------------------------------------------
# Cifrar y descifrar
# ---------------------------------------------------------------------
descifrar_a_stdout() {
  local frase="$1"
  openssl enc -d -aes-256-cbc -pbkdf2 -iter "$ITER" -base64 \
    -in "$CIFRADO" -pass env:VAULT_PASS 2>/dev/null
}

cmd_unlock() {
  [[ -f "$CIFRADO" ]] || { rojo "No existe $CIFRADO"; exit 1; }
  local frase; frase="$(obtener_frase)"
  export VAULT_PASS="$frase"

  local salida
  if ! salida="$(descifrar_a_stdout "$frase")" || [[ -z "$salida" ]]; then
    rojo "No se pudo descifrar: la frase de paso es incorrecta."
    rojo "Pídesela a Rasheed (rasheed@y.uno). No está en el repositorio."
    exit 1
  fi

  printf '%s\n' "$salida" > "$CLARO"
  chmod 600 "$CLARO"
  unset VAULT_PASS
  verde "✓ $CLARO escrito ($(grep -cE '^[A-Z]' "$CLARO") variables, permisos 600)"
  [[ -z "${MC_VAULT_PASSPHRASE:-}" && -z "$(llavero_leer)" ]] && llavero_guardar "$frase"
  gris "   .env.local está en .gitignore: no se puede commitear por accidente."
}

cmd_lock() {
  [[ -f "$CLARO" ]] || { rojo "No existe $CLARO — nada que cifrar."; exit 1; }
  local frase; frase="$(obtener_frase)"
  export VAULT_PASS="$frase"
  openssl enc -aes-256-cbc -pbkdf2 -iter "$ITER" -salt -base64 \
    -in "$CLARO" -out "$CIFRADO" -pass env:VAULT_PASS
  unset VAULT_PASS
  verde "✓ $CIFRADO actualizado"
  gris "   Commitéalo: es ilegible sin la frase de paso."
}

cmd_get() {
  local clave="${1:-}"
  [[ -n "$clave" ]] || { rojo "Uso: vault.sh get NOMBRE_DE_LA_VARIABLE"; exit 1; }
  local frase; frase="$(obtener_frase)"
  export VAULT_PASS="$frase"
  descifrar_a_stdout "$frase" | grep -E "^${clave}=" | head -1 | cut -d= -f2- || {
    rojo "No hay ninguna variable llamada $clave en el vault."; exit 1; }
  unset VAULT_PASS
}

cmd_status() {
  printf '\n  Vault:       %s\n' "$CIFRADO"
  if [[ -f "$CIFRADO" ]]; then
    printf '  Cifrado:     AES-256-CBC · PBKDF2 %s iteraciones · %s bytes\n' "$ITER" "$(wc -c <"$CIFRADO" | tr -d ' ')"
  else
    printf '  Cifrado:     \033[31mNO EXISTE\033[0m\n'
  fi
  printf '  Descifrado:  %s\n' "$([[ -f "$CLARO" ]] && echo "$CLARO ✓" || echo 'no (corre: make db.unlock)')"
  printf '  Frase:       %s\n' "$([[ -n "$(llavero_leer)" ]] && echo "en $(llavero_nombre) ✓" || echo 'no guardada — te la pedirá')"

  if [[ -f "$CIFRADO" ]]; then
    local frase; frase="$(obtener_frase)"; export VAULT_PASS="$frase"
    local contenido; contenido="$(descifrar_a_stdout "$frase" || true)"
    unset VAULT_PASS
    if [[ -n "$contenido" ]]; then
      printf '\n  Contiene (valores ocultos):\n'
      printf '%s\n' "$contenido" | grep -E '^[A-Z][A-Z0-9_]*=' | while IFS='=' read -r k v; do
        printf '    %-30s %s\n' "$k" "$(printf '%s' "$v" | sed -E 's/^(.{6}).*(.{4})$/\1••••••\2/')"
      done
    fi
  fi
  printf '\n'
}

cmd_passphrase() {
  local vieja; vieja="$(obtener_frase)"
  export VAULT_PASS="$vieja"
  local contenido; contenido="$(descifrar_a_stdout "$vieja")"
  [[ -n "$contenido" ]] || { rojo "La frase actual no abre el vault."; exit 1; }

  local n1 n2
  printf 'Frase NUEVA: ' >&2; read -rs n1; printf '\n' >&2
  printf 'Otra vez:    ' >&2; read -rs n2; printf '\n' >&2
  [[ "$n1" == "$n2" ]] || { rojo "No coinciden."; exit 1; }
  [[ ${#n1} -ge 16 ]] || { rojo "Mínimo 16 caracteres."; exit 1; }

  export VAULT_PASS="$n1"
  printf '%s\n' "$contenido" | openssl enc -aes-256-cbc -pbkdf2 -iter "$ITER" -salt -base64 \
    -out "$CIFRADO" -pass env:VAULT_PASS
  unset VAULT_PASS
  llavero_borrar
  llavero_guardar "$n1"
  verde "✓ Frase cambiada. Commitea $CIFRADO y avísale al equipo."
}

case "${1:-}" in
  unlock)     cmd_unlock ;;
  lock)       cmd_lock ;;
  get)        cmd_get "${2:-}" ;;
  status)     cmd_status ;;
  passphrase) cmd_passphrase ;;
  *) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' ;;
esac
