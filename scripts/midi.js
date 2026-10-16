/** Optional adapters checked against Midi-QOL 14.0.9's awaited workflow hooks. */
import { MODULE_ID } from './rules.js';
import { on, getConfig, run, isWriter } from './shared.js';
import { damageArmor, equippedArmor } from './armor.js';
import { handleMidiAttack } from './combat.js';
import { midiEnabled, midiCard, midiAttack, midiContext } from './midi-context.js';

const stateOf = workflow => workflow[MODULE_ID] ??= {};

/** Clear remaining damage pools and targets after a Phobos miss. Earlier external macros cannot be undone. */
export async function finishMidiDamage(workflow) {
  if (!midiAttack(workflow)) return;
  const state = stateOf(workflow);
  if (state.phobos?.missed) {
    workflow.hitTargets = new Set();
    workflow.hitTargetsEC = new Set();
    workflow.isCritical = false;
    for (const method of ['setDamageRolls', 'setOtherDamageRolls', 'setBonusDamageRolls']) {
      if (typeof workflow[method] === 'function') await workflow[method]([]);
    }
  }
  const card = midiCard(workflow);
  if (card?.isOwner) {
    const evidence = {};
    for (const key of ['pattern', 'weaponUuid', 'phobos', 'damageConversion']) {
      if (state[key] !== undefined) evidence[key] = state[key];
    }
    const updates = { [`flags.${MODULE_ID}`]: evidence };
    if (state.phobos?.missed) {
      updates['flags.midi-qol.hitTargetUuids'] = [];
      updates['flags.midi-qol.hitECTargetUuids'] = [];
      updates['flags.midi-qol.isCritical'] = false;
    }
    if (Object.keys(evidence).length) {
      if (typeof workflow.performThrottledUpdate === 'function') await workflow.performThrottledUpdate(card, updates, true);
      else await card.update(updates);
    }
  }
}

/** Runs before GM serialization; never treat this hook as proof that HP changed. */
export function prepareMidiDamage(token, { workflow, damageItem } = {}) {
  const context = midiContext(workflow, token);
  if (!context || !damageItem) return;
  const state = stateOf(workflow);
  state.armors ??= {};
  if (!Object.hasOwn(state.armors, token.actor.uuid)) state.armors[token.actor.uuid] = equippedArmor(token.actor)?.uuid ?? null;
  context.armorUuid = state.armors[token.actor.uuid];
  const options = damageItem.calcDamageOptions ??= {};
  options[MODULE_ID] = { ...(options[MODULE_ID] ?? {}), midi: context };
  if (context.missed) {
    // Additional modules can add damage after DamageRollComplete. Cancel that
    // damage too, including raw values used by Midi's apply/reapply card.
    damageItem.isHit = false;
    damageItem.wasHit = false;
    damageItem.critical = false;
    options.midi ??= {};
    options.midi.isHit = false;
    options.midi.isCritical = false;
    for (const key of ['damageDetail', 'rawDamageDetail']) damageItem[key] = [];
    for (const key of Object.keys(damageItem.damageDetails ?? {})) {
      if (Array.isArray(damageItem.damageDetails[key])) damageItem.damageDetails[key] = [];
    }
    for (const key of ['hpDamage', 'tempDamage', 'totalDamage', 'rawTotalDamage']) damageItem[key] = 0;
    damageItem.newHP = damageItem.oldHP;
    damageItem.newTempHP = damageItem.oldTempHP;
  }
}

/** Publish settled hit evidence on the original card so the target's writer can handle it. */
export async function finishMidiWorkflow(workflow) {
  if (!midiAttack(workflow) || stateOf(workflow).phobos?.missed || workflow.isCritical !== true
    || !getConfig().armorDegradation) return;
  const card = midiCard(workflow);
  if (!card?.isOwner) return;
  if (typeof workflow.performThrottledUpdate === 'function') await workflow.performThrottledUpdate(card, {}, true);
  const targets = [];
  for (const token of workflow.hitTargets ?? []) {
    const actor = token.actor;
    if (actor?.type !== 'character' || actor.hasPlayerOwner !== true) continue;
    const snapshots = stateOf(workflow).armors ?? {};
    const armorUuid = Object.hasOwn(snapshots, actor.uuid) ? snapshots[actor.uuid] : equippedArmor(actor)?.uuid;
    if (armorUuid) targets.push({ actorUuid: actor.uuid, armorUuid, tokenUuid: token.document?.uuid ?? token.uuid });
  }
  if (!targets.length) return;
  await card.setFlag(MODULE_ID, 'midiCritical', { version: 1, itemUuid: workflow.item.uuid,
    activityId: workflow.activity.id, sourceActorUuid: workflow.item.actor.uuid,
    targets: [...new Map(targets.map(target => [target.actorUuid, target])).values()] });
  await consumeMidiCritical(card);
}

/** Runs on each client, but only the active GM (or elected owner) writes armor. */
export async function consumeMidiCritical(message) {
  const event = message.flags?.[MODULE_ID]?.midiCritical;
  const midi = message.flags?.['midi-qol'];
  if (!midiEnabled() || !getConfig().armorDegradation || event?.version !== 1
    || message.flags?.[MODULE_ID]?.phobos?.missed || !Array.isArray(event.targets)
    || midi?.isCritical !== true || !Array.isArray(midi.hitTargetUuids)) return;
  const source = await fromUuid(event.itemUuid);
  const author = message.author;
  const cardItem = message.getAssociatedActivity?.()?.item?.uuid ?? message.flags?.dnd5e?.item?.uuid;
  if (source?.actor?.uuid !== event.sourceActorUuid || source.actor.items?.get(source.id)?.uuid !== source.uuid
    || cardItem !== source.uuid
    || source.system?.activities?.get(event.activityId)?.type !== 'attack'
    || !author || (!author.isGM && !source.actor.testUserPermission(author, 'OWNER'))) return;
  for (const target of event.targets.slice(0, 100)) {
    if (!midi.hitTargetUuids.includes(target.tokenUuid)) continue;
    const actor = await fromUuid(target.actorUuid);
    const token = await fromUuid(target.tokenUuid);
    if (token?.actor?.uuid !== actor?.uuid) continue;
    if (actor?.type !== 'character' || actor.hasPlayerOwner !== true || !actor.isOwner || !isWriter(actor)) continue;
    const armor = actor.items?.find?.(item => item.uuid === target.armorUuid)
      ?? actor.items?.contents?.find(item => item.uuid === target.armorUuid);
    if (!armor) continue;
    await damageArmor(armor, { stacking: getConfig().stackArmorDamage === true,
      eventId: `${message.uuid}:${actor.uuid}`, origin: actor.uuid });
  }
}

export function registerMidi() {
  if (!midiEnabled()) {
    if (game.modules.get('midi-qol')?.active) ui.notifications.warn('Weapons and Armor Expansion: this Midi-QOL version has not been checked. The Midi adapter requires 14.0.x.');
    return;
  }
  on('midi-qol.preCheckHits', workflow => run(handleMidiAttack(workflow)));
  on('midi-qol.DamageRollComplete', workflow => run(finishMidiDamage(workflow)));
  on('midi-qol.preTargetDamageApplication', prepareMidiDamage);
  on('midi-qol.RollComplete', workflow => run(finishMidiWorkflow(workflow)));
  on('updateChatMessage', message => run(consumeMidiCritical(message)));
  on('renderChatMessageHTML', (message, html) => {
    if (!message.flags?.['midi-qol']) return;
    const element = html?.[0] ?? html;
    if (!element?.querySelector || element.querySelector('.hwa-midi-result')) return;
    const evidence = message.flags?.[MODULE_ID], notes = [];
    if (evidence?.phobos) notes.push(evidence.phobos.missed
      ? 'Phobos final result: MISS. All damage from this attack is cancelled. Any earlier external hit-macro effects require GM review.'
      : `Phobos reroll: ${evidence.phobos.candidate?.value} to ${evidence.phobos.result}. The new damage is used.`);
    if (evidence?.damageConversion) notes.push(`The first up to 3 damage points were converted to ${evidence.damageConversion.type}; total damage is unchanged.`);
    if (!notes.length) return;
    const note = document.createElement('p'); note.className = 'hwa-midi-result'; note.textContent = notes.join(' ');
    (element.querySelector('.message-content') ?? element).append(note);
  });
}
