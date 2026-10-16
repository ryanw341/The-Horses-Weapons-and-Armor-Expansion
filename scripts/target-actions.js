import { MODULE_ID } from './rules.js';
import { currentPattern } from './patterns.js';
import { damageArmor, equippedArmor } from './armor.js';
import { criticalEventId } from './combat.js';
import { midiEnabled } from './midi-context.js';
import { on, esc, formDialog, choose, announce, getConfig, isWriter, inventories, run } from './shared.js';

function oneTarget() {
  const targets = [...game.user.targets];
  if (targets.length !== 1 || !targets[0].actor) throw new Error('Target exactly one creature on the scene first.');
  return targets[0].actor;
}
export function nextTurnExpiry(actor, combat = game.combat) {
  if (!combat?.started || !Number.isInteger(combat.round) || !Number.isInteger(combat.turn)) return null;
  const index = combat.turns.findIndex(combatant => combatant.actor?.uuid === actor.uuid);
  if (index < 0) return null;
  return { combatId: combat.id, combatantId: combat.turns[index].id,
    round: combat.round + (index <= combat.turn ? 1 : 0) };
}
export function expiryReached(expiry, combat, prior, current) {
  if (!expiry || expiry.combatId !== combat.id || !Number.isInteger(expiry.round)
    || !Number.isInteger(prior?.round) || !Number.isInteger(prior?.turn)
    || !Number.isInteger(current?.round) || !Number.isInteger(current?.turn)) return false;
  if (current.round < prior.round || (current.round === prior.round && current.turn <= prior.turn)) return false;
  const index = combat.turns.findIndex(combatant => combatant.id === expiry.combatantId);
  if (index < 0) return false;
  return current.round > expiry.round || (current.round === expiry.round && current.turn > index);
}

const targetWrites = new Map();
const targetActions = new Set(['tigrus', 'lucius', 'magnacore', 'umbra-ferrox']);

function validateTarget(target) {
  if (target?.documentName !== 'Actor') throw new Error('Choose a creature actor as the target.');
  if (!target.isOwner) throw new Error('The target owner or GM must apply this effect.');
}

function conditionImmune(target, status) {
  const immunities = target.system?.traits?.ci?.value;
  return immunities?.has?.(status) === true || (Array.isArray(immunities) && immunities.includes(status));
}

function validateSource(source, action) {
  const actor = source?.actor;
  if (!targetActions.has(action) || source?.documentName !== 'Item' || source.type !== 'weapon'
    || actor?.documentName !== 'Actor' || actor.items?.get(source.id)?.uuid !== source.uuid
    || currentPattern(source)?.id !== action) {
    throw new Error('The source must be an inventory weapon with the matching pattern.');
  }
}

function tigrusDamage(source, data) {
  const activity = source.system.activities?.get(data?.activityId);
  if (activity?.type !== 'attack') throw new Error('Choose the weapon attack used for the Tigrus miss.');
  const modifier = source.actor.system.abilities?.[activity.ability]?.mod ?? 0;
  if (!Number.isFinite(modifier)) throw new Error('This attack has an invalid ability modifier.');
  const type = [...(source.system.damage?.base?.types ?? [])][0];
  if (!type || !Object.hasOwn(CONFIG.DND5E.damageTypes, type)) throw new Error('Set the weapon\'s base damage type first.');
  return { amount: Math.max(0, modifier), type };
}

/** Serialize writes to each target so concurrent requests cannot lose their event ledger. */
export function applyTargetAction(target, action, data = {}, { source, eventId } = {}) {
  const key = target?.uuid;
  const previous = targetWrites.get(key) ?? Promise.resolve();
  const work = previous.catch(() => {}).then(() => performTargetAction(target, action, data, { source, eventId }));
  targetWrites.set(key, work);
  const cleanup = () => { if (targetWrites.get(key) === work) targetWrites.delete(key); };
  work.then(cleanup, cleanup);
  return work;
}

async function performTargetAction(target, action, data, { source, eventId }) {
  validateTarget(target);
  validateSource(source, action);
  const stored = target.getFlag(MODULE_ID, 'resolvedActions');
  const prior = Array.isArray(stored) ? stored.filter(id => typeof id === 'string').slice(-100) : [];
  if (eventId && prior.includes(eventId)) return false;
  if (['tigrus', 'lucius'].includes(action)) {
    if (action === 'tigrus') data = tigrusDamage(source, data);
    if (!Number.isFinite(data?.amount) || data.amount < 0 || data.amount > 100000
      || (action === 'lucius' && data.amount === 0)) throw new Error('Invalid damage amount.');
    if (!Object.hasOwn(CONFIG.DND5E.damageTypes, data.type)) throw new Error('Choose a damage type.');
    if (action === 'tigrus') {
      const calculated = target.calculateDamage([{ value: data.amount, type: data.type }]);
      if (calculated === false) return false;
      if (!Number.isFinite(calculated?.amount)) throw new Error('Could not calculate Tigrus damage.');
      // Honor defensive reductions but never increase the ability-modifier cap.
      const amount = Math.min(data.amount, Math.max(0, calculated.amount));
      await target.applyDamage([{ value: amount, type: data.type }], { ignore: true });
    } else await target.applyDamage([{ value: data.amount, type: data.type }]);
  } else if (action === 'magnacore') {
    const proneImmune = conditionImmune(target, 'prone');
    const choice = await choose(`${target.name}: Magnacore`, proneImmune
      ? '<p>This target is immune to prone and cannot drop prone to extinguish the ignition.</p>'
      : '<p>Choose how the target responds to ignition.</p>', [
      ...(!proneImmune ? [{ action: 'prone', label: 'Drop prone and extinguish' }] : []),
      { action: 'damage', label: 'Take 1d6 fire damage' }, { action: 'cancel', label: 'Cancel' }
    ]);
    if (!['prone', 'damage'].includes(choice)) return false;
    validateTarget(target);
    validateSource(source, action);
    if (choice === 'prone') {
      if (conditionImmune(target, 'prone')) throw new Error('This target is immune to prone. Choose fire damage instead.');
      await target.toggleStatusEffect('prone', { active: true });
    }
    else {
      const roll = await new Roll('1d6').evaluate();
      await roll.toMessage({ speaker: ChatMessage.getSpeaker({ actor: target }), flavor: 'Magnacore ignition' });
      validateTarget(target);
      await target.applyDamage([{ value: roll.total, type: 'fire' }]);
    }
  } else if (action === 'umbra-ferrox') {
    if (conditionImmune(target, 'blinded')) {
      await announce(target, `<p>${esc(target.name)} is immune to blinded. Umbra-Ferrox has no effect.</p>`);
    } else {
      const expiry = nextTurnExpiry(target);
      await target.createEmbeddedDocuments('ActiveEffect', [{ name: 'Umbra-Ferrox: Blinded', img: 'icons/svg/blind.svg',
        statuses: ['blinded'], origin: source?.uuid, duration: {},
        description: 'Blinded until the end of this creature\'s next turn. Outside combat, remove this effect manually at that point.',
        flags: { [MODULE_ID]: { kind: 'umbra-blind', expiry, eventId } } }]);
    }
  } else throw new Error('Unknown pattern target action.');
  if (eventId) await target.setFlag(MODULE_ID, 'resolvedActions', [...prior, eventId].slice(-100));
  return true;
}

async function requestTargetAction(item, target, action, data, detail) {
  return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor: item.actor }),
    content: `<div class="hwa-chat"><p><strong>${esc(item.name)}: ${esc(currentPattern(item).name)}</strong></p><p>${detail}</p><p>The active GM, or a target owner when no GM is connected, can resolve this request below.</p></div>`,
    flags: { [MODULE_ID]: { request: { itemUuid: item.uuid, targetUuid: target.uuid, action, data }, resolved: false } } });
}

export async function openTargetAction(item) {
  if (!item?.isOwner || !item.actor?.isOwner) throw new Error('You do not own this weapon.');
  const pattern = currentPattern(item), target = oneTarget();
  validateSource(item, pattern?.id);
  if (pattern.id === 'lucius') {
    const content = `<div class="hwa-settings"><p>Confirm the original creature was killed. For a ranged attack, ${esc(target.name)} must be within 5 feet of that creature and along the shot's direction. For melee, confirm it is an eligible flanking creature. Allies are eligible.</p>
      <label>Leftover damage<input name="amount" type="number" min="0" max="100000" step="1" required></label>
      <label>Damage type<select name="type">${Object.entries(CONFIG.DND5E.damageTypes).map(([id, entry]) =>
        `<option value="${id}">${esc(game.i18n.localize(entry.label ?? entry))}</option>`).join('')}</select></label>
      <p>Use the resolved leftover damage. Facing, flanking, eligibility, and multi-type damage require GM adjudication.</p></div>`;
    return formDialog('Lucius: carry over damage', content, [
      { action: 'request', label: 'Request carryover', callback: (event, button) => {
        const amount = Number(button.form.elements.namedItem('amount').value), type = button.form.elements.namedItem('type').value;
        if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw new Error('Enter a positive leftover damage amount.');
        return requestTargetAction(item, target, 'lucius', { amount, type }, `Apply ${amount} ${esc(type)} leftover damage to ${esc(target.name)} after confirming eligibility.`);
      } }, { action: 'cancel', label: 'Cancel' }
    ]);
  }
  if (pattern.id === 'tigrus') {
    const attacks = [...item.system.activities].filter(activity => activity.type === 'attack');
    if (!attacks.length) throw new Error('This weapon has no attack activity.');
    return formDialog('Tigrus: damage after a miss', `<p>Confirm the attack missed ${esc(target.name)}. Choose the attack used:</p>
      <select name="attack">${attacks.map(activity => `<option value="${activity.id}">${esc(activity.name || 'Attack')} (${esc(activity.ability)})</option>`).join('')}</select>`, [
      { action: 'request', label: 'Request fixed damage', callback: (event, button) => {
        const activityId = button.form.elements.namedItem('attack').value;
        const { amount, type } = tigrusDamage(item, { activityId });
        return requestTargetAction(item, target, 'tigrus', { amount, type, activityId }, `${esc(item.actor.name)} missed ${esc(target.name)}. Apply up to ${amount} ${esc(type)} damage (attack ability modifier only). Immunity and damage reductions apply; vulnerability or other bonuses cannot increase this amount.`);
      } }, { action: 'cancel', label: 'Cancel' }
    ]);
  }
  if (pattern.id === 'magnacore') {
    if (await choose('Magnacore ignition', `<p>Confirm a hit on ${esc(target.name)} and spend your reaction to ignite them.</p>`, [
      { action: 'ignite', label: 'Spend reaction and ignite' }, { action: 'cancel', label: 'Cancel' }
    ]) !== 'ignite') return;
    return requestTargetAction(item, target, 'magnacore', {}, `${esc(item.actor.name)} spends a reaction after striking ${esc(target.name)}. The target must drop prone or take 1d6 fire damage.`);
  }
  if (pattern.id === 'umbra-ferrox') {
    if (await choose('Umbra-Ferrox critical hit', `<p>Confirm a critical hit on ${esc(target.name)}. Blind them until the end of their next turn?</p>`, [
      { action: 'blind', label: 'Request blindness' }, { action: 'cancel', label: 'Cancel' }
    ]) !== 'blind') return;
    return requestTargetAction(item, target, 'umbra-ferrox', {}, `${esc(target.name)} was critically hit. Apply blindness until the end of their next turn.`);
  }
}

const resolving = new Set();
export async function resolveRequest(message) {
  const key = message.uuid ?? message.id;
  if (resolving.has(key) || message.getFlag(MODULE_ID, 'resolved')) return;
  const request = message.getFlag(MODULE_ID, 'request');
  if (!request) return;
  resolving.add(key);
  try {
    const target = await fromUuid(request.targetUuid), source = await fromUuid(request.itemUuid);
    validateTarget(target);
    validateSource(source, request.action);
    if (!isWriter(target)) throw new Error('The active GM, or an owner when no GM is connected, must resolve this request.');
    const result = await applyTargetAction(target, request.action, request.data, { source, eventId: message.uuid ?? message.id });
    if (result) {
      // An owner may not own the attacker's ChatMessage; the actor's persisted event ledger still prevents repeats.
      if (message.isOwner) await message.setFlag(MODULE_ID, 'resolved', true);
      await announce(target, `<p>${esc(target.name)}: ${esc(request.action)} effect resolved.</p>`);
    }
  } finally { resolving.delete(key); }
}

export function criticalArmorCard(message) {
  return message?.getFlag('dnd5e', 'roll.type') === 'attack' && message.rolls?.some(roll => roll.isCritical)
    || midiEnabled() && message?.flags?.['midi-qol']?.isCritical === true
      && message.getAssociatedActivity?.()?.type === 'attack';
}

export async function confirmCriticalArmor(message) {
  const originUuid = message.flags?.[MODULE_ID]?.midiAttackMessage;
  const origin = typeof originUuid === 'string' ? globalThis.fromUuidSync?.(originUuid) ?? message : message;
  if (origin.flags?.[MODULE_ID]?.phobos?.missed) throw new Error('Phobos made this attack miss. It cannot damage armor.');
  if (!getConfig().armorDegradation || !criticalArmorCard(message)) return;
  const savedTargets = midiEnabled() && Array.isArray(message.flags?.['midi-qol']?.hitTargetUuids)
    ? message.flags['midi-qol'].hitTargetUuids.map(uuid => ({ uuid })) : message.getFlag('dnd5e', 'targets');
  const descriptors = Array.isArray(savedTargets) ? savedTargets : [];
  const targets = [];
  for (const entry of descriptors) {
    if (typeof entry?.uuid !== 'string') continue;
    const doc = await fromUuid(entry.uuid);
    const actor = doc?.documentName === 'Actor' ? doc : doc?.documentName === 'Token' ? doc.actor : null;
    if (actor?.isOwner && actor.type === 'character' && actor.hasPlayerOwner && equippedArmor(actor)) targets.push(actor);
  }
  if (!targets.length) for (const token of game.user.targets) {
    const actor = token.actor;
    if (actor?.isOwner && actor.type === 'character' && actor.hasPlayerOwner && equippedArmor(actor)) targets.push(actor);
  }
  const unique = [...new Map(targets.map(actor => [actor.uuid, actor])).values()];
  if (!unique.length) throw new Error('Target a player-owned character with equipped body armor that you can edit.');
  const armors = new Map(unique.map(actor => [actor.uuid, equippedArmor(actor)]));
  return formDialog('Confirm critical hit', `<p>Select characters actually hit by this critical attack. Resolve any Phobos reroll first. This also handles immune targets or damage resolved outside Foundry's damage tray.</p>
    ${unique.map((actor, index) => `<label><input type="checkbox" name="target" value="${index}"> ${esc(actor.name)} (${esc(equippedArmor(actor).name)})</label>`).join('')}`, [
    { action: 'damage', label: 'Damage selected armor', callback: async (event, button) => {
      if (origin.flags?.[MODULE_ID]?.phobos?.missed) throw new Error('Phobos made this attack miss. It cannot damage armor.');
      if (!getConfig().armorDegradation) throw new Error('Armor degradation is now disabled.');
      const selected = [...button.form.querySelectorAll('input[name=target]:checked')].map(input => unique[Number(input.value)]);
      if (!selected.length || selected.some(actor => !actor)) throw new Error('Select a listed character actually hit by the critical attack.');
      for (const actor of selected) {
        validateTarget(actor);
        if (!isWriter(actor)) throw new Error('The active GM, or an owner when no GM is connected, must confirm this hit.');
        if (equippedArmor(actor)?.uuid !== armors.get(actor.uuid)?.uuid) throw new Error('Equipped armor changed. Reopen this confirmation before applying damage.');
      }
      for (const actor of new Set(selected)) {
        await damageArmor(armors.get(actor.uuid), { stacking: getConfig().stackArmorDamage,
          eventId: criticalEventId(message, actor), origin: actor.uuid });
      }
    } }, { action: 'cancel', label: 'Cancel' }
  ]);
}

export function registerTargetActions() {
  on('renderChatMessageHTML', (message, html) => {
    const element = html?.[0] ?? html;
    if (!element?.querySelector) return;
    const add = (label, listener, className) => {
      if (element.querySelector(`.${className}`)) return;
      const button = document.createElement('button'); button.type = 'button'; button.className = className;
      button.textContent = label; button.addEventListener('click', () => run(listener()));
      (element.querySelector('.message-content') ?? element).append(button);
    };
    if (message.getFlag(MODULE_ID, 'request') && !message.getFlag(MODULE_ID, 'resolved')) {
      add('Resolve pattern effect (active GM / owner if no GM)', () => resolveRequest(message), 'hwa-resolve-target');
    }
    if (getConfig().armorDegradation && criticalArmorCard(message) && !message.flags?.[MODULE_ID]?.phobos?.missed) {
      add('Confirm critical hit: damage armor', () => confirmCriticalArmor(message), 'hwa-confirm-armor');
    }
  });
  on('combatTurnChange', (combat, prior, current) => {
    for (const actor of inventories()) {
      if (!actor.isOwner || !isWriter(actor)) continue;
      const expired = [...actor.effects].filter(effect => effect.flags?.[MODULE_ID]?.kind === 'umbra-blind'
        && expiryReached(effect.flags[MODULE_ID].expiry, combat, prior, current));
      if (expired.length) run(actor.deleteEmbeddedDocuments('ActiveEffect', expired.map(effect => effect.id)));
    }
  });
}
