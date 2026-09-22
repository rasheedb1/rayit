-- =====================================================================
-- 0015 · Tokens cifrados de las conexiones sociales (CON-3)
-- ---------------------------------------------------------------------
-- social_connection.secret_ref sigue siendo una referencia opaca (regla
-- de 0002: el token nunca se guarda en claro). Esta tabla es lo que esa
-- referencia resuelve cuando tiene la forma 'enc:<plataforma>:<uuid>':
-- el JSON de las credenciales cifrado con AES-256-GCM por el worker y
-- la web (packages/connectors/src/crypto/token-cipher.ts). La clave de
-- cifrado se deriva de TOKEN_ENCRYPTION_KEY y NO está en la base: leer
-- esta tabla sin la clave no sirve de nada.
--
-- Por qué una tabla y no Supabase Vault: mc_app, mc_worker y mc_migrator
-- no tienen USAGE sobre el esquema vault (comprobado el 22-sep-2026) y
-- pglite no lo trae, así que no se podría probar. Detalle en
-- docs/propuestas/CON-3.md §0.2.
--
-- La ref es estable: oauth.refresh escribe aquí ANTES de actualizar
-- social_connection y confía en que la ref no cambia. Por eso la fila se
-- reemplaza (UPSERT por secret_ref) y nunca se crea otra al renovar.
--
-- Privilegios: mc_migrator tiene DEFAULT PRIVILEGES para mc_app (admin)
-- y para mc_worker (0014), así que la tabla nace con los mismos permisos
-- de fila que las demás. RLS en FORCE como el resto de tablas con
-- workspace_id (0010).
-- =====================================================================

CREATE TABLE connection_secret (
  secret_ref    text PRIMARY KEY CHECK (secret_ref LIKE 'enc:%'),
  workspace_id  uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  -- AES-256-GCM: cuerpo, IV de 12 bytes y etiqueta de 16. AAD = secret_ref.
  ciphertext    bytea NOT NULL,
  iv            bytea NOT NULL CHECK (octet_length(iv) = 12),
  tag           bytea NOT NULL CHECK (octet_length(tag) = 16),
  -- Versión de la clave maestra con la que se cifró (rotación: v1 → v2).
  key_version   text NOT NULL DEFAULT 'v1' CHECK (key_version ~ '^v[0-9]+$'),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON connection_secret (workspace_id);
CREATE TRIGGER connection_secret_updated BEFORE UPDATE ON connection_secret
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE connection_secret ENABLE ROW LEVEL SECURITY;
ALTER TABLE connection_secret FORCE ROW LEVEL SECURITY;
CREATE POLICY connection_secret_ws_isolation ON connection_secret
  USING (workspace_id = current_workspace_id());
