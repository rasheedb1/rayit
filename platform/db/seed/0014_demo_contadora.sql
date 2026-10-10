-- =====================================================================
-- Seed 14 · La Contadora de la demo (CIERRE-ACC §5.5, R2-ACC)
-- ---------------------------------------------------------------------
-- La demo tenía un Mánager (Andrés, 0003) y ningún Contador, así que
-- ACC-5 (lo que ve y no ve el rol de fábrica 'finance': todo Finanzas,
-- nada de Campañas, Ventas ni Cotizar) no se podía mirar en la copia
-- sin llaves. Con DEMO_USER_ID=00000002-0000-4000-8000-000000000005 la
-- demo es Carolina y /campanas, /ventas y /cotizar responden 404.
-- Entró hace cuatro meses (sus facturas al día las lleva desde entonces).
--
-- Reglas del archivo (las de 0003 y 0011):
--   * Idempotente: ON CONFLICT DO NOTHING en las dos filas.
--   * app_user y membership solo admiten la fila PROPIA (0025 §4 y
--     0028): la sesión pasa a ser Carolina para darla de alta y vuelve a
--     ser Laura (que fijó 0002) al final.
--   * Entró hace cuatro meses: después que Andrés (0011, cinco meses) y
--     antes de la primera factura con cobro al día (0003). Solo se mueve
--     hacia atrás (least), y con margen: verify/run.mjs siembra con el
--     reloj adelantado hasta 48 días y comprueba con el reloj real, así
--     que la fecha tiene que quedar a más de 90 días en todos los casos.
-- =====================================================================
SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);
SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000005', false);

INSERT INTO app_user (id, email, name, locale)
VALUES ('00000002-0000-4000-8000-000000000005', 'carolina@ejemplo.com', 'Carolina Ruiz', 'es-CO')
ON CONFLICT DO NOTHING;

INSERT INTO membership (workspace_id, user_id, role_id)
VALUES ('00000002-0000-4000-8000-000000000001', '00000002-0000-4000-8000-000000000005', system_role_id('creator', 'finance'))
ON CONFLICT DO NOTHING;

SELECT set_config('app.user_id', '00000002-0000-4000-8000-000000000002', false);

-- La fecha de alta la fija la dueña (como en 0011): la membresía propia
-- solo admite su alta, no cambiarse la fecha.
UPDATE membership
   SET created_at = least(created_at, date_trunc('day', now()) - interval '4 months')
 WHERE workspace_id = '00000002-0000-4000-8000-000000000001'
   AND user_id = '00000002-0000-4000-8000-000000000005';
