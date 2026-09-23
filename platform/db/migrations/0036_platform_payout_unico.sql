-- =====================================================================
-- 0036 · Un ingreso de plataforma por periodo (FIN-7)
-- ---------------------------------------------------------------------
-- Qué hace: da a `platform_payout` la clave natural que nunca tuvo, para
-- que volver a subir el mismo CSV de AdSense o de Creator Rewards no
-- escriba el mismo dinero dos veces. Sin ella, el `ON CONFLICT DO
-- NOTHING` de importPlatformPayouts falla con 42P10 («no unique or
-- exclusion constraint matching the ON CONFLICT specification») y la
-- única salida sería deduplicar leyendo antes y comparando en
-- TypeScript, que es una condición de carrera con dos pestañas abiertas.
-- La idempotencia de una cifra de dinero no puede depender de que nadie
-- pulse dos veces.
--
-- Por qué: 0008 creó la tabla sin índices. Un pago de plataforma es un
-- hecho con identidad propia —esta red, este creador, este periodo, esta
-- moneda, este monto—, y esa identidad es la que trae el archivo: los
-- CSV no dan un identificador de transacción.
--
-- Número: 0035 es la más alta de TODAS las ramas (0034_access_control
-- está en main; 0035_membership_scope en ACC-6 y
-- 0035_brand_snapshot_por_campana en CAM-3), así que esta es 0036. No
-- depende de ninguna de las anteriores —solo de platform_payout, que es
-- de 0008—, así que el integrador puede renumerarla si otra área eligió
-- también 0036.
--
-- Re-ejecutable: CREATE UNIQUE INDEX IF NOT EXISTS. No toca ninguna fila
-- y no hay filas que romper (no existe ningún INSERT de platform_payout
-- en db/seed/).
--
-- Aislamiento: el índice ABRE por workspace_id, así que no es un único
-- global y no necesita entrada en UNICOS_GLOBALES_DECLARADOS
-- (packages/db/src/esquema.ts). Dos espacios pueden tener el mismo pago
-- sin saber el uno del otro.
--
-- creator_id va con coalesce: un índice único trata dos NULL como
-- DISTINTOS, así que sin esto dos importaciones seguidas de un pago sin
-- creador —que es el caso del MVP, donde creator_id entra null— se
-- duplicarían, que es justo lo que este índice viene a impedir. No se
-- usa NULLS NOT DISTINCT porque es de PostgreSQL 15+ y las pruebas
-- corren sobre pglite; el coalesce funciona en cualquier versión.
-- El uuid de relleno es el cero: creator_profile.id es
-- gen_random_uuid(), que nunca lo produce.
-- =====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS platform_payout_natural_uidx
  ON platform_payout (
    workspace_id,
    platform_id,
    coalesce(creator_id, '00000000-0000-0000-0000-000000000000'::uuid),
    period_start,
    period_end,
    currency,
    amount
  );

COMMENT ON INDEX platform_payout_natural_uidx IS
  'FIN-7: clave natural de un pago de plataforma. La usa el ON CONFLICT DO NOTHING de importPlatformPayouts para que reimportar el mismo CSV no duplique el dinero.';

-- La lista por mes ordena por periodo descendente dentro del workspace.
CREATE INDEX IF NOT EXISTS platform_payout_workspace_period_idx
  ON platform_payout (workspace_id, period_start DESC);
