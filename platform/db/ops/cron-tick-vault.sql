-- =====================================================================
-- ¿Está Supabase Vault? (CIM-7). Primer paso de `make cron.install`,
-- ANTES de guardar el secreto y de programar la tarea: si falta, nada se
-- toca. No lleva secretos ni marcadores: se manda tal cual.
--
-- Mira también extensions.hmac (pgcrypto): la tarea firma cada llamada
-- con él en vez de mandar el secreto (cron-tick.sql), y sin él fallaría
-- cada minuto sin llamar.
--
-- Va aparte de cron-tick-secreto.sql para que esa llamada, la única con
-- el secreto, no tenga de qué fallar (un fallo registra la sentencia
-- entera en el log de Postgres), y aparte de cron-tick.sql para que la
-- tarea se programe DESPUÉS de que el secreto exista.
-- =====================================================================
DO $$
BEGIN
  IF to_regproc('vault.create_secret') IS NULL OR to_regproc('vault.update_secret') IS NULL THEN
    RAISE EXCEPTION 'Supabase Vault no está instalado (extensión supabase_vault): el secreto del turno no tiene dónde guardarse';
  END IF;
  IF to_regprocedure('extensions.hmac(text,text,text)') IS NULL THEN
    RAISE EXCEPTION 'falta extensions.hmac (pgcrypto en el esquema extensions): la tarea firma cada llamada con él';
  END IF;
END
$$;
SELECT true AS vault;
