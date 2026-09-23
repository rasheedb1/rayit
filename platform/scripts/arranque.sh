#!/usr/bin/env bash
# =====================================================================
# arranque.sh — dejar una máquina nueva lista para trabajar.
#
# Se corre UNA vez por clon, después de clonar el repositorio:
#
#   cd platform && make arranque
#
# Comprueba las herramientas, descifra las credenciales, configura el
# remoto de git y verifica que la base de datos y GitHub responden.
# Es idempotente: si algo ya está hecho, lo dice y sigue.
#
# Lo único que NO puede hacer solo es conseguir la frase de paso del
# vault. Esa se comparte a mano, por un canal aparte, y no está —ni
# debe estar— en el repositorio.
# =====================================================================
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$RAIZ/.." && pwd)"
source "$RAIZ/scripts/lib/frase.sh"

rojo()   { printf '\033[31m%s\033[0m\n' "$*" >&2; }
verde()  { printf '\033[32m  ✓ %s\033[0m\n' "$*"; }
amber()  { printf '\033[33m  ! %s\033[0m\n' "$*"; }
gris()   { printf '\033[90m    %s\033[0m\n' "$*"; }
titulo() { printf '\n\033[1m%s\033[0m\n' "$*"; }

FALLOS=0
fallo() { rojo "  ✗ $1"; [[ -n "${2:-}" ]] && gris "$2"; FALLOS=$((FALLOS+1)); }

# ---------------------------------------------------------------------
titulo "1 · Herramientas"
# ---------------------------------------------------------------------
for h in git openssl curl make; do
  if command -v "$h" >/dev/null 2>&1; then verde "$h"
  else fallo "falta $h" "instálalo antes de seguir"; fi
done

if command -v node >/dev/null 2>&1; then
  v="$(node -v | tr -d 'v' | cut -d. -f1)"
  if [[ "$v" -ge 20 ]]; then verde "node $(node -v)"
  else amber "node $(node -v) — el proyecto espera 20 o más"; fi
else
  fallo "falta node" "https://nodejs.org  (o: brew install node)"
fi

command -v pnpm >/dev/null 2>&1 && verde "pnpm $(pnpm -v)" \
  || amber "sin pnpm — hace falta para 'make dev' (npm i -g pnpm)"

gestor="$(llavero_tipo)"
if [[ "$gestor" == "ninguno" ]]; then
  amber "sin gestor de secretos en este sistema"
  gris  "la frase de paso no se podrá guardar: exporta MC_VAULT_PASSPHRASE"
else
  verde "gestor de secretos: $(llavero_nombre)"
fi

# ---------------------------------------------------------------------
titulo "2 · Frase de paso del vault"
# ---------------------------------------------------------------------
if [[ -n "${MC_VAULT_PASSPHRASE:-}" ]]; then
  verde "tomada de MC_VAULT_PASSPHRASE"
elif [[ -n "$(llavero_leer)" ]]; then
  verde "ya guardada en $(llavero_nombre)"
else
  amber "no la tienes todavía"
  gris  "la abre la base de datos Y el token de GitHub: es una sola frase"
  gris  "pídesela a Rasheed (rasheed@y.uno) por un canal aparte —no por chat de IA—"
  gris  "el siguiente paso te la va a pedir y la guarda para siempre"
fi

# ---------------------------------------------------------------------
titulo "3 · Credenciales de la base de datos"
# ---------------------------------------------------------------------
if "$RAIZ/scripts/vault.sh" unlock; then
  verde ".env.local escrito"
else
  fallo "no se pudo descifrar el vault" "frase incorrecta, o todavía no la tienes"
fi

# ---------------------------------------------------------------------
titulo "4 · GitHub"
# ---------------------------------------------------------------------
# Dos modos, y el arranque elige el que corresponda sin pisar nada:
#   - Si ya te autenticas como tú (gh auth login), se usan TUS credenciales.
#     Tus push quedan a tu nombre y revocarte no afecta al otro.
#   - Si no, se usa el token compartido del vault.
if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
  yo="$(gh api user --jq .login 2>/dev/null || echo '?')"
  verde "te autenticas en GitHub como $yo"
  if "$RAIZ/scripts/github.sh" mine >/dev/null 2>&1; then
    verde "este clon empuja con tus credenciales (no con el token compartido)"
  else
    fallo "no se pudieron configurar tus credenciales"
  fi
elif [[ -f "$RAIZ/secrets/github.env.enc" ]]; then
  amber "no tienes cuenta de GitHub configurada en esta máquina"
  gris  "se usará el token compartido del vault: tus push aparecerán a nombre"
  gris  "de su dueño. Para que queden al tuyo:  gh auth login && make github.mine"
  if "$RAIZ/scripts/github.sh" install; then :; else fallo "no se pudo configurar el remoto"; fi
else
  amber "no hay token de GitHub en el vault ni cuenta propia configurada"
  gris  "corre: gh auth login"
fi

if [[ -z "$(git -C "$REPO" config user.email 2>/dev/null)" ]]; then
  amber "git no sabe quién eres en esta máquina"
  gris  'git config --global user.name "Tu Nombre"'
  gris  'git config --global user.email "tu@correo.com"'
  gris  "sin esto, tus commits salen sin autor reconocible"
else
  verde "commits firmados como $(git -C "$REPO" config user.email)"
fi

# ---------------------------------------------------------------------
titulo "5 · Vercel"
# ---------------------------------------------------------------------
# El token es uno solo para todo el equipo y vive cifrado en el vault,
# con la misma frase. Lo único que es por-clon es el enlace local al
# proyecto, y eso solo tiene sentido cuando apps/web ya tiene código.
if [[ -f "$RAIZ/secrets/vercel.env.enc" ]]; then
  if "$RAIZ/scripts/vercel.sh" check >/dev/null 2>&1; then
    verde "el token de Vercel responde"
    if [[ -f "$RAIZ/apps/web/package.json" ]]; then
      if "$RAIZ/scripts/vercel.sh" link >/dev/null 2>&1; then
        verde "apps/web enlazado al proyecto compartido"
      else
        amber "no se pudo enlazar apps/web"
        gris  "mira: cd platform && make vercel.link"
      fi
    else
      gris "apps/web todavía no tiene código; cuando lo tenga: make vercel.link"
    fi
  else
    fallo "el token de Vercel no responde" "mira: cd platform && make vercel.check"
  fi
else
  amber "no hay token de Vercel en el vault"
  gris  "make vercel.set — una sola vez, y le sirve a todo el equipo"
fi

# ---------------------------------------------------------------------
titulo "6 · ¿Responde todo?"
# ---------------------------------------------------------------------
if [[ -f "$RAIZ/.env.local" ]]; then
  if (cd "$RAIZ" && node db/sql.mjs "select 1 as ok" >/dev/null 2>&1); then
    verde "la base de datos de Supabase responde"

    # El worker necesita dos permisos de administración que ninguna
    # migración puede dar (docs/propuestas/CON-2.md §3.1): membresía en
    # mc_worker y el esquema pgboss. Se pregunta como mc_migrator, que es
    # el rol con el que arranca el worker (DATABASE_URL_DIRECT).
    estado="$(cd "$RAIZ" && node db/sql.mjs --admin \
      "select case when pg_has_role(current_user, 'mc_worker', 'MEMBER') then 'miembro-ok' else 'miembro-falta' end
              || ' ' || case when exists (select 1 from pg_namespace where nspname = 'pgboss') then 'pgboss-ok' else 'pgboss-falta' end
              || ' ' || current_user::text as estado" 2>/dev/null)"
    if [[ "$estado" == *"miembro-ok"* && "$estado" == *"pgboss-ok"* ]]; then
      verde "el worker puede arrancar contra Supabase (miembro de mc_worker, esquema pgboss)"
    else
      amber "el worker todavía no puede arrancar contra Supabase; 'make dev' lo deja en modo humo"
      [[ "$estado" == *"miembro-falta"* ]] && \
        gris "falta:  ./scripts/supabase-admin.sh sql \"GRANT mc_worker TO mc_migrator\""
      [[ "$estado" == *"pgboss-falta"* ]] && {
        gris "falta:  ./scripts/supabase-admin.sh sql \"CREATE SCHEMA IF NOT EXISTS pgboss AUTHORIZATION mc_migrator\""
        gris "        pnpm --filter @mc/worker install-schema"; }
      gris "los corre Rasheed con el token de administración (docs/propuestas/CON-2.md §3.1)"
    fi
  else
    fallo "la base de datos no responde" "mira: cd platform && make db.info"
  fi
fi

if [[ -f "$RAIZ/secrets/github.env.enc" ]]; then
  if GIT_TERMINAL_PROMPT=0 git -C "$REPO" ls-remote origin >/dev/null 2>&1; then
    verde "GitHub responde y el remoto se alcanza"
  else
    fallo "no se alcanza el remoto" "mira: cd platform && make github.check"
  fi
fi

# ---------------------------------------------------------------------
if [[ $FALLOS -eq 0 ]]; then
  printf '\n\033[32m  Listo. Ya puedes trabajar.\033[0m\n'
  gris "make db.info     qué hay en la base"
  gris "make dev         levanta web + worker + media"
  gris "claude           Claude Code lee CLAUDE.md solo"
  printf '\n'
else
  printf '\n\033[31m  %s cosa(s) por resolver antes de empezar.\033[0m\n\n' "$FALLOS"
  exit 1
fi
