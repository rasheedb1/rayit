# El vault

En esta carpeta hay dos archivos cifrados con AES-256, **con la misma
frase de paso**:

| Archivo | Qué guarda | Quién lo abre |
|---|---|---|
| `supabase.env.enc` | Credenciales de la base de datos | `make db.unlock` |
| `github.env.enc` | El token para empujar al repositorio | `make github.install` |

**Sí, están commiteados. Sí, es a propósito.**

## Por qué

El equipo necesita que cualquiera con el repositorio pueda tocar la
base de datos. Las dos salidas habituales fallan:

- **Credenciales en claro en el repo** — una fuga esperando a ocurrir.
  Basta que el repositorio se haga público un minuto, o que alguien
  comparta pantalla.
- **Credenciales solo fuera del repo** — todo el mundo termina
  pidiéndolas por WhatsApp y acaban en cinco chats distintos, que es
  peor que el repositorio.

Así que el archivo viaja con el repositorio, pero cifrado. Quien lo
abra sin la frase de paso ve sesenta líneas de base64 que no significan
nada. La frase se comparte una vez, por un canal aparte, y se queda en
el Llavero de macOS.

## Cómo se usa

```bash
cd platform
make db.unlock     # la pide una vez, la guarda en el Llavero
make db.info       # comprueba que conecta
```

Cambiar una credencial:

```bash
$EDITOR .env.local   # está descifrado, en platform/
make db.lock         # vuelve a cifrar
git add secrets/supabase.env.enc && git commit -m "rotar llave X"
```

Cambiar la frase de paso (cuando alguien sale del equipo):

```bash
./scripts/vault.sh passphrase
git add secrets/supabase.env.enc && git commit -m "rotar frase del vault"
```

## Qué protege esto y qué no

**Sí protege** contra el accidente real y frecuente: el repositorio se
vuelve público, alguien clona sin permiso, un backup queda en un disco
que se pierde, alguien comparte pantalla con el archivo abierto.

**No protege** contra quien tenga la frase de paso. Por eso la frase no
está aquí, y por eso el token de administración de Supabase tampoco:
ese vive solo en el Llavero de la máquina de Rasheed, porque puede
borrar el proyecto entero.

**El cifrado son 600 000 iteraciones de PBKDF2** sobre una frase de seis
palabras al azar. Probar frases por fuerza bruta contra eso, aunque
tengas el archivo, no es práctico. Si la frase fuera `123456` todo esto
no serviría de nada: por eso la genera el script, no una persona.

## Si la frase de paso se filtra

Las credenciales dentro también se consideran filtradas. En orden:

1. `./scripts/vault.sh passphrase` — frase nueva.
2. Rotar las contraseñas de Postgres:
   ```bash
   ./scripts/supabase-admin.sh sql "ALTER ROLE mc_app WITH PASSWORD '...'"
   ./scripts/supabase-admin.sh sql "ALTER ROLE mc_migrator WITH PASSWORD '...'"
   ```
3. Rotar las llaves de la API en el panel de Supabase → Settings → API.
4. Actualizar `.env.local`, `make db.lock`, commitear.

El historial de git conserva las versiones viejas del archivo cifrado.
Con la frase vieja se pueden abrir. Por eso el paso 2 no es opcional:
rotar la frase sin rotar las contraseñas no sirve de nada.

## La copia de emergencia

Si pierdes esta máquina, pierdes el Llavero, y con él la frase de paso.
El archivo cifrado del repositorio queda inservible. Por eso hay una
segunda copia **dentro de la propia base de datos**:

```bash
./scripts/supabase-admin.sh recover
```

o desde el panel de Supabase → SQL Editor:

```sql
select nombre, valor, para_que from recuperacion.llaves;
```

Guarda cuatro valores. Dos importan de verdad:

- **`frase_vault`** — la frase de paso. No se puede regenerar: o la
  tienes, o el `.enc` no se abre nunca más.
- **`token_encryption_key`** — descifra los tokens OAuth de las redes
  sociales. Si se pierde, hay que reconectar todas las cuentas a mano.

Las otras dos (`pg_mc_app`, `pg_mc_migrator`) están por comodidad; se
regeneran con `ALTER ROLE ... WITH PASSWORD` en cualquier momento.

### Por qué está ahí y no en el Vault de Supabase

El Vault de Supabase (`vault.decrypted_secrets`) parecía el sitio
natural, pero **`service_role` puede leerlo** y ese permiso lo otorgó
`supabase_admin`, así que el rol `postgres` no puede revocarlo. La
llave `service_role` acaba como variable de entorno en el servidor de
producción: si se filtra de ahí, quien la tenga podría leer la frase de
paso y abrir el archivo cifrado del repositorio. La cadena completa se
rompe con un esquema propio, donde los permisos sí son nuestros.

Verificado: `mc_app` y `mc_migrator` reciben `permission denied for
schema recuperacion` y ni siquiera ven que el esquema exista;
`service_role` por la API REST recibe `PGRST106` porque el esquema no
está expuesto.

### El límite honesto de esta copia

Es una segunda copia, no la única. Protege contra *perder el Llavero*.
No protege contra *perder el acceso a Supabase*: si te quedas fuera de
la cuenta, te quedas fuera de la copia también. Una copia en un gestor
de contraseñas (1Password, el Llavero de iCloud) cubre ese caso, y es
la que conviene tener además de esta.

El token de administración **no** está guardado ahí, a propósito: es la
llave que abre ese esquema. Guardarlo dentro sería como dejar la llave
de la caja fuerte dentro de la caja fuerte. Ese se saca de Supabase →
Account → Access Tokens cuando haga falta.

---

## El token de GitHub

Somos dos empujando al mismo repositorio. El token viaja cifrado por la
misma razón que las credenciales de la base: para que nadie tenga que
pedirlo por WhatsApp, y para que no quede en claro en ningún sitio.

### Al clonar por primera vez

```bash
cd platform
make db.unlock        # pide la frase de paso UNA vez, la guarda en el Llavero
make github.install   # remoto + credential helper, en tu clon
git push
```

No hay un secreto nuevo que compartir: la frase del vault ya abre los dos
archivos. Quien puede tocar la base de datos puede empujar.

### Por qué un credential helper y no la URL con el token

La forma corta y tentadora es `https://TOKEN@github.com/usuario/repo.git`.
No la usamos: eso deja el token **en claro** dentro de `.git/config`, y
sale en cualquier `git remote -v`, en un screenshot, en una pantalla
compartida. Además `.git/config` no se versiona, así que el otro tendría
que volver a pegarlo a mano.

Con el helper, git le pregunta a `scripts/github.sh` cada vez que necesita
autenticarse. El script descifra en memoria, entrega el token por una
tubería y termina. No toca el disco en claro y no entra en `.git/config`.

Compruébalo cuando quieras:

```bash
make github.status    # incluye una línea "fuga: ninguna credencial en claro"
```

### El helper se niega a entregar el token fuera de este repositorio

Un token clásico de GitHub (`ghp_…`) **no se puede limitar a un repo**:
vale para toda la cuenta. Como esa limitación no la da GitHub, la pone el
helper: comprueba el host y la ruta que git le pasa, y si no son las que
tiene guardadas, calla. Por eso `install` activa `credential.useHttpPath`,
que es lo que hace que git le mande la ruta.

```
github.com/rasheedb1/rayit   -> entrega el token
github.com/rasheedb1/otro    -> calla
gitlab.com/rasheedb1/rayit   -> calla
```

Es una red de seguridad, no un muro: quien tenga la frase de paso puede
descifrar el archivo y leer el token. Lo que evita es que un `git push`
distraído hacia otro remoto se lleve la credencial por delante.

### Rotar el token

```bash
make github.set       # lo pide sin mostrarlo, lo valida contra GitHub y lo cifra
git add secrets/github.env.enc && git commit -m "rotar token de GitHub"
```

El otro solo hace `git pull`. No tiene que reinstalar nada: el helper lee
del archivo, y el archivo ya trae el token nuevo.

### Cuándo rotarlo, sin discusión

- Si el token se escribió alguna vez fuera del vault: un chat, un correo,
  un ticket, un `export` en la terminal. El historial de esos sitios no se
  puede limpiar de verdad.
- Si alguien sale del equipo. Y entonces también
  `./scripts/vault.sh passphrase`, porque con la frase vieja se pueden
  abrir las versiones anteriores del archivo que quedan en el historial
  de git.

Rotar es revocarlo en GitHub (Settings → Developer settings → Tokens) y
crear uno nuevo. Cambiar solo el archivo cifrado no revoca nada.

### Lo que este diseño NO arregla

Un token compartido se autentica siempre como la misma persona. En el
historial, el autor de cada commit sale bien (eso lo pone tu `user.email`
local), pero para GitHub **todos los push son de la cuenta dueña del
token**. No hay auditoría por persona y revocar afecta a los dos a la vez.

La alternativa nativa, cuando moleste: añadir al otro como colaborador en
el repositorio y que cada uno use sus propias credenciales
(`gh auth login`, o una llave SSH). Entonces este vault deja de hacer
falta para GitHub —seguirá haciendo falta para la base de datos.
