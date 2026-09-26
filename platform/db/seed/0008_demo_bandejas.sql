-- =====================================================================
-- Seed 8 · La conversación completa en la bandeja de la demo (VEN-14)
-- ---------------------------------------------------------------------
-- El seed 0005 dejó las dos respuestas de la demo en outbound_message,
-- pero no los correos a los que responden: el despachador copia a
-- outbound_message cada envío que confirma (recordSent, VEN-10) y la
-- demo los escribió directo en outbound_touch. En /ventas/bandeja la
-- conversación con Daniel (Sabores Caseros) empezaba por su respuesta.
--
-- Aquí, para los correos enviados de la demo:
--   * su copia en outbound_message, como la deja recordSent: la misma
--     cuenta, el mismo hilo, el mismo Message-ID y la hora del envío;
--   * la fuente de la intención de las dos respuestas ya clasificadas
--     (0064: intent_source), para que la bandeja diga quién las clasificó.
--
-- Reglas del archivo (las de 0002 a 0007):
--   * Idempotente: la copia entra una vez (la clave única del proveedor,
--     outbound_message_provider_idx) y la fuente solo se llena si falta.
--   * Nada nuevo que pase por real: son los mismos envíos del seed 0005,
--     con sus mismas pruebas de proveedor (de .test).
--   * Requiere 0064 y el seed 0005.
-- =====================================================================

SELECT set_config('app.workspace_id', '00000002-0000-4000-8000-000000000001', false);

INSERT INTO outbound_message
  (workspace_id, channel_account_id, enrollment_id, touch_id, contact_id, deal_id, direction, channel, thread_ref,
   provider_message_id, message_id_rfc, subject, body, occurred_at, created_at)
SELECT t.workspace_id, '00000005-0000-4000-8000-0000000ac001', t.enrollment_id, t.id, t.contact_id, t.deal_id, 'outbound', t.channel,
       t.thread_ref, t.provider_message_id, t.message_id_rfc, t.subject, t.body, t.sent_at, t.sent_at
  FROM outbound_touch t
 WHERE t.id IN ('00000005-0000-4000-8000-000000070002', '00000005-0000-4000-8000-000000070006',
                '00000005-0000-4000-8000-000000070008')
   AND t.status = 'sent' AND t.provider_message_id IS NOT NULL
ON CONFLICT (workspace_id, channel, provider_message_id) WHERE provider_message_id IS NOT NULL DO NOTHING;

UPDATE outbound_message
   SET intent_source = 'model'
 WHERE id IN ('00000005-0000-4000-8000-0000000a5001', '00000005-0000-4000-8000-0000000a5002')
   AND intent IS NOT NULL AND intent_source IS NULL;
