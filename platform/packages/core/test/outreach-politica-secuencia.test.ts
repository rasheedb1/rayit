/**
 * VEN-10 · una secuencia frente a la política de la marca, antes de
 * activarla (checkSequenceAgainstPolicy).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSequenceAgainstPolicy, type PolicyStep } from '../src/outreach/sequence-policy.ts';

/** La cadencia recomendada de docs/ventas-outreach.md §5.3: cinco mensajes, con un «me gusta» de por medio. */
const CADENCIA_53: PolicyStep[] = [
  { id: 'd0-linkedin', stepType: 'linkedin_connect', dayOffset: 0 },
  { id: 'd1-like', stepType: 'linkedin_like', dayOffset: 1 },
  { id: 'd2-correo', stepType: 'email', dayOffset: 2 },
  { id: 'd3-respuesta', stepType: 'email_reply', dayOffset: 3 },
  { id: 'd6-linkedin', stepType: 'linkedin_message', dayOffset: 6 },
  { id: 'd10-cierre', stepType: 'email', dayOffset: 10 },
];

test('con la política por defecto (4 y 3) la cadencia de §5.3 pierde el cierre y corre dos pasos', () => {
  const r = checkSequenceAgainstPolicy(CADENCIA_53, { maxTouchesPerCompany: 4, minDaysBetweenTouches: 3 });
  assert.deepEqual(r.overCap, ['d10-cierre'], 'el quinto mensaje, el de la cotización, se cancelaría');
  assert.deepEqual(r.closerThanGap, ['d2-correo', 'd3-respuesta'], 'el «me gusta» no cuenta: el correo va a dos días de la invitación y la respuesta a uno del correo');
});

test('con un tope que la cubre y sin separación, no hay nada que avisar', () => {
  assert.deepEqual(checkSequenceAgainstPolicy(CADENCIA_53, { maxTouchesPerCompany: 5, minDaysBetweenTouches: 0 }), {
    overCap: [],
    closerThanGap: [],
  });
});

test('el orden es el de la secuencia (día y orden en el día), no el de la lista', () => {
  const pasos: PolicyStep[] = [
    { id: 'b', stepType: 'email', dayOffset: 0, orderInDay: 1 },
    { id: 'c', stepType: 'email', dayOffset: 4 },
    { id: 'a', stepType: 'email', dayOffset: 0, orderInDay: 0 },
  ];
  const r = checkSequenceAgainstPolicy(pasos, { maxTouchesPerCompany: 2, minDaysBetweenTouches: 1 });
  assert.deepEqual(r.overCap, ['c']);
  assert.deepEqual(r.closerThanGap, ['b'], 'dos pasos el mismo día');
});

test('un tope de cero cancela todo lo enviable; las tareas de una persona nunca cuentan', () => {
  const r = checkSequenceAgainstPolicy(
    [{ id: 'tarea', stepType: 'manual_task', dayOffset: 0 }, { id: 'correo', stepType: 'email', dayOffset: 1 }],
    { maxTouchesPerCompany: 0, minDaysBetweenTouches: 0 },
  );
  assert.deepEqual(r.overCap, ['correo']);
});
