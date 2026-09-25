/**
 * Cadencias · el estado de una secuencia (VEN-13): activar, pausar,
 * archivar, duplicar y cambiar el nombre.
 */
import type { WorkspaceTx } from '../../client.ts';
import { SEQUENCE_STATUSES } from '../../schema/ventas.ts';
import { assertEditable, assertId, CadenciaError, cleanName, lockSequence, type SequenceStatus } from './comun.ts';

export async function renameSequence(tx: WorkspaceTx, id: string, name: string): Promise<void> {
  const s = await lockSequence(tx, id);
  assertEditable(s, false);
  await tx.query(`UPDATE outbound_sequence SET name = $2 WHERE id = $1::uuid`, [id, cleanName(name)]);
}

// ---------------------------------------------------------------------
// Estado, copia y llamadas al modelo
// ---------------------------------------------------------------------

/**
 * Activa, pausa o archiva. Activar pide al menos un paso; lo archivado
 * no vuelve (se duplica). Pausar y archivar no cancelan nada aquí: el
 * despachador ya pospone lo de una secuencia pausada y cancela lo de una
 * archivada al reclamar (sequence_paused, sequence_archived).
 */
export async function setSequenceStatus(tx: WorkspaceTx, id: string, status: Exclude<SequenceStatus, 'draft'>): Promise<void> {
  if (status === ('draft' as string) || !(SEQUENCE_STATUSES as readonly string[]).includes(status)) {
    throw new CadenciaError('invalid', `Estado desconocido: ${status}.`);
  }
  const s = await lockSequence(tx, id);
  if (s.status === 'archived') throw new CadenciaError('archived', 'La secuencia está archivada: duplícala para volver a usarla.');
  if (status === 'active') {
    const n = (await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM outbound_step WHERE sequence_id = $1::uuid`, [id])).rows[0]!.n;
    if (n === 0) throw new CadenciaError('no_steps', 'Una secuencia sin pasos no se activa.');
  }
  await tx.query(`UPDATE outbound_sequence SET status = $2 WHERE id = $1::uuid`, [id, status]);
}

/**
 * Copia una secuencia, con sus pasos, en borrador y sin nadie dentro.
 * La propuesta se copia sin su persona ni su negocio: «Activar» en la
 * copia no vuelve a escribir a quien ya está en la original (se enrola
 * a quien toque desde un negocio). Devuelve el id de la copia.
 */
export async function duplicateSequence(tx: WorkspaceTx, id: string, copyName: (name: string) => string): Promise<string> {
  assertId('duplicateSequence', id);
  const src = (
    await tx.query<{ name: string }>(`SELECT name FROM outbound_sequence WHERE id = $1::uuid`, [id])
  ).rows[0];
  if (!src) throw new CadenciaError('not_found', `La secuencia ${id} no existe o no es de este espacio.`);
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO outbound_sequence (workspace_id, name, channel, status, automation_mode, timezone, template_id, signal_id, proposal, brief_id)
     SELECT workspace_id, $2, channel, 'draft', automation_mode, timezone, template_id, signal_id, proposal - 'contactId' - 'dealId', brief_id
       FROM outbound_sequence WHERE id = $1::uuid
     RETURNING id`,
    [id, cleanName(copyName(src.name))],
  );
  const copy = rows[0]!.id;
  await tx.query(
    `INSERT INTO outbound_step
       (workspace_id, sequence_id, day_offset, order_in_day, step_type, channel, scheduled_time, angle_id, guidance_es,
        guidance_source, guidance_for_type, subject_template, body_template, generate_with_ai, requires_asset)
     SELECT workspace_id, $2::uuid, day_offset, order_in_day, step_type, channel, scheduled_time, angle_id, guidance_es,
            guidance_source, guidance_for_type, subject_template, body_template, generate_with_ai, requires_asset
       FROM outbound_step WHERE sequence_id = $1::uuid`,
    [id, copy],
  );
  return copy;
}
