# Dar acceso a alguien nuevo

Escrito para: quien administra el repositorio (Rasheed) y quien entra
(Nicolas, y quien venga después).

Somos dos: **rasheed** y **nicolas**. Cada uno empuja con sus propias
credenciales de GitHub, y los dos comparten una sola frase de paso para
las credenciales de la base de datos.

Esa distinción es lo importante de esta página:

| | Quién lo da | Por dónde viaja |
|---|---|---|
| **Acceso a GitHub** | Invitación de GitHub, por persona | La cuenta de cada uno |
| **Frase de paso del vault** | Rasheed, a mano | Un canal aparte, nunca el repo ni un chat |

Dos secretos, dos caminos, a propósito: si mañana alguien se va, se le
quita el acceso a GitHub en un clic sin tocar nada más, y solo entonces
se rota la frase del vault.

---

## Parte 1 · Lo que hace Rasheed (5 minutos)

### 1.1 Poner el repositorio en privado

Hoy `rasheedb1/rayit` es **público**: cualquiera lo ve. Si no era la
intención, arréglalo antes de subir nada:

```bash
gh api -X PATCH repos/rasheedb1/rayit -f private=true
```

### 1.2 Invitar a Nicolas como colaborador

```bash
gh api -X PUT repos/rasheedb1/rayit/collaborators/NICOLAS_USUARIO \
  -f permission=push
```

`push` le deja leer, escribir y abrir pull requests. No le deja borrar
el repositorio ni cambiar su visibilidad: eso es `admin`, y no hace
falta para trabajar.

Nicolas recibe un correo. Hasta que lo acepte, la invitación sale en:

```bash
gh api repos/rasheedb1/rayit/invitations
```

### 1.3 Pasarle la frase de paso del vault

Es **una sola frase** y abre las dos cosas: las credenciales de Supabase
y el token de GitHub del vault.

Por Signal, 1Password, o dictándosela. **Nunca por un chat de IA, un
correo, un ticket de Jira ni un mensaje de Slack**: esos no se borran
de verdad, y quien tenga la frase tiene la base de datos.

### 1.4 Arreglar tu propia identidad de git

En la máquina de Rasheed, git no sabe quién eres — tus commits saldrían
sin autor reconocible:

```bash
git config --global user.name  "Rasheed Bayter"
git config --global user.email "rasheed@y.uno"
```

---

## Parte 2 · Lo que hace Nicolas, en su computador

### 2.1 Aceptar la invitación

Llega por correo, o en https://github.com/notifications. Sin esto, el
clon de un repositorio privado falla.

### 2.2 Instalar lo que hace falta

```bash
# macOS
brew install git node gh
npm install -g pnpm

# Linux (Debian/Ubuntu)
sudo apt install git nodejs gh libsecret-tools
npm install -g pnpm
```

`libsecret-tools` en Linux es lo que guarda la frase de paso, igual que
el Llavero en macOS. Sin él hay que exportar `MC_VAULT_PASSPHRASE` cada
vez.

### 2.3 Autenticarse en GitHub como él mismo

```bash
gh auth login
```

GitHub.com → **HTTPS** → autenticar con el navegador.

Este paso es el que hace que sus push queden **a su nombre**. Si lo
salta, el arranque cae al token compartido y todo aparecería como
`rasheedb1`.

### 2.4 Decirle a git quién es

```bash
git config --global user.name  "Nicolas ..."
git config --global user.email "nicolas@..."
```

### 2.5 Clonar y arrancar

```bash
git clone https://github.com/rasheedb1/rayit.git
cd rayit/platform
make arranque
```

`make arranque` pide la frase de paso una vez, la guarda en el gestor de
secretos del sistema, descifra las credenciales, configura el remoto y
comprueba que la base de datos y GitHub responden.

Detecta solo que Nicolas ya tiene cuenta propia y **no** le instala el
token compartido. Lo dice en pantalla:

```
te autenticas en GitHub como nicolas
este clon empuja con tus credenciales (no con el token compartido)
```

### 2.6 Comprobar que todo responde

```bash
make db.info        # migraciones, tablas, vistas
make github.status  # remoto, helper, y que no haya credenciales en claro
git push            # debería funcionar
```

---

## Verificación: ¿quedó bien?

En la máquina de Nicolas, las tres respuestas correctas:

| Comando | Debe decir |
|---|---|
| `gh api user --jq .login` | su usuario, no `rasheedb1` |
| `git config user.email` | su correo |
| `make github.status` | `fuga: ninguna credencial en claro` |

Y desde la de Rasheed, que el acceso quedó registrado a su nombre:

```bash
gh api repos/rasheedb1/rayit/collaborators --jq '.[].login'
```

---

## Si alguien se va

En este orden, y ninguno es opcional:

1. **Quitarle GitHub:**
   ```bash
   gh api -X DELETE repos/rasheedb1/rayit/collaborators/SU_USUARIO
   ```
2. **Rotar la frase del vault**, porque se la sabe:
   ```bash
   cd platform && ./scripts/vault.sh passphrase
   ```
3. **Rotar las contraseñas de Postgres**, porque el historial de git
   conserva las versiones viejas del archivo cifrado y la frase vieja
   las abre. Sin este paso, el paso 2 no sirve de nada:
   ```bash
   ./scripts/supabase-admin.sh sql "ALTER ROLE mc_app WITH PASSWORD '...'"
   ./scripts/supabase-admin.sh sql "ALTER ROLE mc_migrator WITH PASSWORD '...'"
   ```
4. **Rotar el token de GitHub del vault**, si llegó a usarlo:
   `make github.set`, y revocar el viejo en GitHub.

---

## El token compartido: cuándo sigue sirviendo

Queda en el vault y no estorba. Sirve para lo que no es una persona:
un servidor de integración continua, un script desatendido, una máquina
prestada. Para eso está `make github.install-forzado`.

Para Rasheed y Nicolas, cada uno con lo suyo. Es la diferencia entre
poder decir «esto lo empujó Nicolas» y no poder decirlo.
