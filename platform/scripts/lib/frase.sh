# =====================================================================
# frase.sh — dónde vive la frase de paso del vault, en cada sistema.
#
# Se sourcea desde vault.sh y github.sh. No se ejecuta solo.
#
# La frase abre los dos archivos cifrados (base de datos y token de
# GitHub). Se comparte UNA vez, a mano, por un canal aparte, y a partir
# de ahí la guarda el gestor de secretos del sistema operativo:
#
#   macOS   Llavero          (security)
#   Linux   libsecret        (secret-tool, del paquete libsecret-tools)
#   otro    no se guarda: hay que exportar MC_VAULT_PASSPHRASE
#
# El orden de búsqueda es siempre: variable de entorno primero (para CI
# y para quien no tenga gestor), y luego el gestor del sistema.
# =====================================================================

MC_LLAVERO_SERVICIO="${MC_LLAVERO_SERVICIO:-multicampaign-vault}"

# Qué gestor hay en esta máquina: macos | libsecret | ninguno
llavero_tipo() {
  if command -v security >/dev/null 2>&1 && [[ "$(uname -s)" == "Darwin" ]]; then
    printf 'macos'
  elif command -v secret-tool >/dev/null 2>&1; then
    printf 'libsecret'
  else
    printf 'ninguno'
  fi
}

llavero_leer() {
  case "$(llavero_tipo)" in
    macos)     security find-generic-password -s "$MC_LLAVERO_SERVICIO" -w 2>/dev/null || true ;;
    libsecret) secret-tool lookup service "$MC_LLAVERO_SERVICIO" 2>/dev/null || true ;;
    *)         true ;;
  esac
}

llavero_guardar() {
  case "$(llavero_tipo)" in
    macos)
      security add-generic-password -U -s "$MC_LLAVERO_SERVICIO" -a "$USER" -w "$1" 2>/dev/null \
        && printf '\033[90m   (guardada en el Llavero: no te la vuelve a pedir)\033[0m\n' ;;
    libsecret)
      printf '%s' "$1" | secret-tool store --label="MultiCampaign vault" service "$MC_LLAVERO_SERVICIO" 2>/dev/null \
        && printf '\033[90m   (guardada en libsecret: no te la vuelve a pedir)\033[0m\n' ;;
    *)
      printf '\033[90m   (sin gestor de secretos: exporta MC_VAULT_PASSPHRASE en tu shell)\033[0m\n' ;;
  esac
}

llavero_borrar() {
  case "$(llavero_tipo)" in
    macos)     security delete-generic-password -s "$MC_LLAVERO_SERVICIO" >/dev/null 2>&1 || true ;;
    libsecret) secret-tool clear service "$MC_LLAVERO_SERVICIO" >/dev/null 2>&1 || true ;;
  esac
}

# Nombre legible, para los mensajes de error
llavero_nombre() {
  case "$(llavero_tipo)" in
    macos)     printf 'el Llavero de macOS' ;;
    libsecret) printf 'libsecret' ;;
    *)         printf 'MC_VAULT_PASSPHRASE (no hay gestor de secretos en este sistema)' ;;
  esac
}
