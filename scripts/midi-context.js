/** Serializable attribution shared by Midi's originating client and its GM damage worker. */
import { MODULE_ID } from './rules.js';

export function midiEnabled() {
  const midi = globalThis.game?.modules?.get('midi-qol');
  return midi?.active === true && /^14\.0\./.test(midi.version ?? '');
}

export function midiCard(workflow) {
  const uuid = workflow?.itemCardUuid;
  return typeof uuid === 'string' && uuid.startsWith('ChatMessage.')
    ? globalThis.fromUuidSync?.(uuid) ?? game.messages?.get(uuid.slice(12)) : null;
}

export function midiHit(workflow, token) {
  const uuid = token?.document?.uuid ?? token?.uuid;
  return Boolean(uuid && [...(workflow?.hitTargets ?? [])].some(hit =>
    (hit.document?.uuid ?? hit.uuid) === uuid));
}

export function midiAttack(workflow) {
  return Boolean(midiEnabled() && !workflow?.aborted && workflow?.activity?.type === 'attack'
    && workflow.attackRoll && workflow.item?.actor && midiCard(workflow));
}

export function midiContext(workflow, token) {
  if (!midiAttack(workflow) || !token?.actor) return null;
  const state = workflow[MODULE_ID] ?? {};
  return {
    version: 1, attackMessage: workflow.itemCardUuid,
    sourceActorUuid: workflow.item.actor.uuid, itemUuid: workflow.item.uuid, activityId: workflow.activity.id,
    targetActorUuid: token.actor.uuid, targetUuid: token.document?.uuid ?? token.uuid,
    pattern: state.pattern ?? workflow.item.flags?.[MODULE_ID]?.pattern ?? 'imperial',
    critical: workflow.isCritical === true, hit: midiHit(workflow, token), missed: state.phobos?.missed === true
  };
}

/** Reject stale, unrelated, or incomplete damage-card context instead of guessing a source. */
export function midiDamageContext(actor, options = {}) {
  const context = options[MODULE_ID]?.midi;
  if (!midiEnabled() || context?.version !== 1 || context.targetActorUuid !== actor?.uuid
    || !['attackMessage', 'itemUuid', 'activityId', 'sourceActorUuid', 'targetUuid'].every(key => typeof context[key] === 'string' && context[key])
    || context.hit !== true || context.missed === true || options.midi?.isHit === false
    || options.midi?.sourceActorUuid !== context.sourceActorUuid
    || options.midi?.targetUuid !== context.targetUuid) return null;
  const message = globalThis.fromUuidSync?.(context.attackMessage);
  const item = globalThis.fromUuidSync?.(context.itemUuid);
  const activity = item?.system?.activities?.get(context.activityId);
  const target = globalThis.fromUuidSync?.(context.targetUuid);
  const associated = message?.getAssociatedActivity?.();
  const cardItem = associated?.item?.uuid ?? message?.flags?.dnd5e?.item?.uuid;
  const author = message?.author;
  if (message?.documentName !== 'ChatMessage' || item?.actor?.uuid !== context.sourceActorUuid
    || item.actor.items?.get(item.id)?.uuid !== item.uuid || activity?.type !== 'attack'
    || cardItem !== item.uuid || (associated && associated.id !== activity.id)
    || !author || (!author.isGM && !item.actor.testUserPermission(author, 'OWNER'))
    || target?.actor?.uuid !== actor.uuid) return null;
  return { ...context, message, activity, eventId: `${context.attackMessage}:${actor.uuid}` };
}
