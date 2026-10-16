/** Combat adapters for the core dnd5e 5.3 roll pipeline. */
import { MODULE_ID, kantrealOutcome } from './rules.js';
import { on, getConfig, announce, choose, esc, run, ownedItem } from './shared.js';
import { damageArmor, equippedArmor } from './armor.js';
import { midiDamageContext } from './midi-context.js';

const queues = new Map();
const handledAttacks = new Set();
const handledMidiAttacks = new WeakSet();
const damageSnapshots = new WeakMap();
const thresholdState = new WeakMap();
const damageType = roll => roll?.options?.type ?? '';
const flagsOf = item => item?.flags?.[MODULE_ID] ?? {};
const itemsOf = actor => actor?.items?.contents ?? Array.from(actor?.items ?? []);

function serialized(key, work) {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  queues.set(key, next);
  return next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
}

function remember(set, key) {
  if (!key) return false;
  if (set.has(key)) return true;
  set.add(key);
  if (set.size > 512) set.delete(set.values().next().value);
  return false;
}

function weaponFor(activity) {
  const item = ownedItem(activity);
  return item?.type === 'weapon' ? item : null;
}

function setMessageFlag(message, key, value) {
  message.data ??= {};
  message.data.flags ??= {};
  message.data.flags[MODULE_ID] ??= {};
  message.data.flags[MODULE_ID][key] = value;
}

function appendFlavor(message, text) {
  message.data ??= {};
  message.data.flavor = `${message.data.flavor ?? ''}<p class="horse-pattern-note">${esc(text)}</p>`;
}

function retainMidiMetadata(config, message) {
  if (!config.workflow) return;
  config.workflow[MODULE_ID] = { ...(config.workflow[MODULE_ID] ?? {}),
    ...(message.data?.flags?.[MODULE_ID] ?? {}) };
}

function rollSnapshot(roll) {
  return { formula: roll.formula, result: roll.result, total: roll.total, type: damageType(roll),
    roll: roll.toJSON?.() ?? null };
}

/** Preserve the evaluated value, type, properties and critical attribution without rolling twice. */
async function fixedDamageRoll(source, value, type = damageType(source)) {
  if (!Number.isFinite(value)) throw new Error('Cannot modify damage with a non-finite total.');
  const options = structuredClone(source.options ?? {});
  Object.assign(options, { type, configured: true, preprocessed: true });
  return new CONFIG.Dice.DamageRoll(String(value), {}, options).evaluate();
}

/** Allocate converted points in roll order, preserving each source's resistance properties. */
export function conversionPlan(rolls, type, maximum = 3) {
  let remaining = Math.max(0, maximum);
  const plan = [];
  for (const [index, roll] of rolls.entries()) {
    const currentType = damageType(roll);
    const total = Number(roll.total);
    if (!Number.isFinite(total)) throw new Error('Damage has not been evaluated.');
    const eligible = total > 0 && !['healing', 'temphp'].includes(currentType);
    const convert = eligible ? Math.min(total, remaining) : 0;
    remaining -= convert;
    if (!convert || currentType === type) plan.push({ index, value: total, type: currentType, unchanged: true });
    else {
      if (total > convert) plan.push({ index, value: total - convert, type: currentType });
      plan.push({ index, value: convert, type });
    }
  }
  return plan;
}

/** Only additive top-level dice can safely use a total delta; reject nonlinear/custom pools. */
export function rerollCandidates(rolls) {
  const candidates = [];
  for (const [rollIndex, roll] of rolls.entries()) {
    if (['healing', 'temphp'].includes(damageType(roll)) || !Number.isFinite(roll.total)) continue;
    const terms = roll.terms ?? [];
    let sign = 1;
    const local = [];
    let supported = terms.length > 0;
    for (const [termIndex, term] of terms.entries()) {
      if (term.operator !== undefined) {
        if (!['+', '-'].includes(term.operator)) { supported = false; break; }
        sign = term.operator === '-' ? -1 : 1;
      } else if (Number.isInteger(term.faces) && term.faces > 1 && Array.isArray(term.results)) {
        // Counting successes, exploding, and reroll modifiers have different result semantics.
        if (term.modifiers?.length) { supported = false; break; }
        for (const [resultIndex, result] of term.results.entries()) {
          if (result.active === false || result.discarded || !Number.isFinite(result.result)) continue;
          local.push({ rollIndex, termIndex, resultIndex, faces: term.faces, value: result.result, sign });
        }
      } else if (!Number.isFinite(term.number) || term.roll || term.rolls || term.terms) {
        supported = false;
        break;
      }
    }
    if (supported) candidates.push(...local);
  }
  return candidates;
}

export function combatTurnKey(combat) {
  return combat?.started && combat.uuid && Number.isInteger(combat.round) && Number.isInteger(combat.turn)
    ? `${combat.uuid}:${combat.round}:${combat.turn}` : null;
}

async function applyPhobos(rolls, item, message) {
  const turn = combatTurnKey(game.combat);
  if (!turn) {
    appendFlavor(message, 'Phobos: no active combat turn. Resolve the once-per-turn reroll manually.');
    return;
  }
  if (flagsOf(item).phobosTurn === turn) return;
  const candidates = rerollCandidates(rolls);
  if (!candidates.length) {
    appendFlavor(message, 'Phobos: these damage formulas need a manual die reroll. No reroll has been spent.');
    return;
  }
  const action = await choose('Phobos damage reroll',
    `<p>Reroll one die for ${esc(item.name)}. You must use the new result. A 1 makes this attack miss.</p>`,
    [...candidates.map((candidate, index) => ({ action: String(index),
      label: `d${candidate.faces}: ${candidate.value} (${damageType(rolls[candidate.rollIndex]) || 'untyped'}, part ${candidate.rollIndex + 1})` })),
    { action: 'keep', label: 'Keep damage' }]);
  const candidate = /^\d+$/.test(action ?? '') ? candidates[Number(action)] : null;
  if (!candidate) return;
  if (combatTurnKey(game.combat) !== turn || flagsOf(item).phobosTurn === turn) {
    appendFlavor(message, 'Phobos reroll cancelled because the turn changed or the reroll was already spent.');
    return;
  }
  await item.update({ [`flags.${MODULE_ID}.phobosTurn`]: turn });
  if (flagsOf(item).phobosTurn !== turn) return;
  const reroll = await new Roll(`1d${candidate.faces}`).evaluate();
  const value = Number(reroll.total);
  if (!Number.isInteger(value) || value < 1 || value > candidate.faces) throw new Error('Invalid Phobos die result.');
  setMessageFlag(message, 'phobos', { original: rolls.map(rollSnapshot), candidate, result: value,
    reroll: reroll.toJSON?.() ?? null, turn, missed: value === 1 });
  if (value === 1) {
    const zeros = await Promise.all(rolls.map(roll => fixedDamageRoll(roll, 0)));
    rolls.splice(0, rolls.length, ...zeros);
    appendFlavor(message, `Phobos rerolled d${candidate.faces}: ${candidate.value} → 1. The attack misses; all its damage is 0.`);
  } else {
    const original = rolls[candidate.rollIndex];
    const adjusted = original.total + candidate.sign * (value - candidate.value);
    rolls[candidate.rollIndex] = await fixedDamageRoll(original, adjusted);
    appendFlavor(message, `Phobos rerolled d${candidate.faces}: ${candidate.value} → ${value}. Original damage: ${original.formula} = ${original.total}; revised part: ${adjusted}.`);
  }
}

/** libWrapper WRAPPER: await evaluated dice, then finish before dnd5e posts their chat message. */
export async function evaluateDamage(wrapped, rolls, config = {}, message = {}) {
  const result = await wrapped(rolls, config, message);
  // Midi does not create the normal damage message. Retain the result on its
  // workflow, including a miss that must suppress later bonus/other damage.
  if (config.workflow?.[MODULE_ID]?.phobos?.missed && rolls.length && config.evaluate !== false) {
    const zeros = await Promise.all(rolls.map(roll => fixedDamageRoll(roll, 0)));
    rolls.splice(0, rolls.length, ...zeros);
    return result;
  }
  const item = weaponFor(config.subject);
  if (!item?.isOwner || !rolls.length || config.evaluate === false) return result;
  return serialized(item.uuid, async () => {
    const state = flagsOf(item);
    if (state.pattern === 'phobos') await applyPhobos(rolls, item, message);
    const type = state.pattern === 'sunfury' ? 'fire'
      : state.pattern === 'triplex' && state.triplexMode === 'energized' && !state.modesLocked ? 'lightning' : null;
    if (type) {
      const plan = conversionPlan(rolls, type);
      if (plan.some(part => !part.unchanged)) {
        const original = rolls.map(rollSnapshot);
        const changed = await Promise.all(plan.map(part => part.unchanged ? rolls[part.index]
          : fixedDamageRoll(rolls[part.index], part.value, part.type)));
        rolls.splice(0, rolls.length, ...changed);
        setMessageFlag(message, 'damageConversion', { original, type, maximum: 3 });
        appendFlavor(message, `${state.pattern === 'sunfury' ? 'Sunfury' : 'Triplex Energized'}: the first up to 3 damage points are ${type}; total damage is unchanged. Original: ${original.map(roll => `${roll.formula} = ${roll.total} ${roll.type}`).join('; ')}.`);
      }
    }
    retainMidiMetadata(config, message);
    return result;
  });
}

export function blockedWeapon(item) {
  const state = flagsOf(item);
  return state.jammed ? 'Spend an action mending this weapon before using it.'
    : state.mercurianDamaged ? 'Repair this weapon for 10 minutes with Weapon Tools before using it.' : null;
}

export function guardAttack(config, _dialog, message) {
  if (message && config.workflow?.itemCardUuid) setMessageFlag(message, 'midiAttackMessage', config.workflow.itemCardUuid);
  const item = weaponFor(config?.subject);
  const reason = blockedWeapon(item);
  if (reason) { ui.notifications.warn(reason); return false; }
  const targets = config[MODULE_ID]?.targets
    ?? [...(config.workflow?.targets ?? game.user.targets ?? [])].map(target => target.actor).filter(Boolean);
  const state = flagsOf(item), conditions = config[MODULE_ID]?.conditions ?? state.nextAttack;
  const scoped = state.pattern === 'triplex' && state.triplexMode === 'scoped' && !state.modesLocked;
  const causes = [];
  if (conditions?.longRange && !scoped) causes.push('long range');
  if (conditions?.underwater && state.pattern !== 'kalibrax') causes.push('underwater');
  if (conditions?.nearby && state.pattern !== 'mezoa') causes.push('hostile proximity');
  // Never clear an existing disadvantage: its cause is not identifiable in core dnd5e.
  if (causes.length) config.disadvantage = true;
  config[MODULE_ID] = { ...(config[MODULE_ID] ?? {}), targets,
    conditions: conditions ? structuredClone(conditions) : null, scoped: Boolean(conditions?.longRange && scoped),
    mode: state.triplexMode, pattern: state.pattern, causes };
}

function guardUse(activity) {
  if (!['attack', 'damage', 'save'].includes(activity?.type)) return;
  const reason = blockedWeapon(weaponFor(activity));
  if (reason) { ui.notifications.warn(reason); return false; }
}

export function effectiveThreshold(threshold, attackingTsunJin, targetTsunJin) {
  const base = Number.isFinite(threshold) ? Math.min(20, threshold) : 20;
  const weapon = attackingTsunJin ? Math.min(base, 19) : base;
  return Math.max(2, weapon - Number(Boolean(targetTsunJin)));
}

export function configureAttack(config, rollConfig) {
  const item = weaponFor(config.subject);
  const own = flagsOf(item).pattern === 'tsun-jin';
  const targets = config[MODULE_ID]?.targets ?? [...(game.user.targets ?? [])].map(target => target.actor).filter(Boolean);
  const target = targets.length === 1 && itemsOf(targets[0]).some(weapon => weapon.type === 'weapon'
    && weapon.system?.equipped === true && flagsOf(weapon).pattern === 'tsun-jin');
  rollConfig.options ??= {};
  const context = config[MODULE_ID];
  if (context) {
    rollConfig.options[MODULE_ID] = { nextAttack: context.conditions, pattern: context.pattern, mode: context.mode,
      midiWorkflow: Boolean(config.workflow || context.midiRetry) };
    if (context.scoped) {
      rollConfig.parts ??= [];
      if (!rollConfig.parts.includes('@horseScopedPenalty')) rollConfig.parts.push('@horseScopedPenalty');
      rollConfig.data ??= {};
      rollConfig.data.horseScopedPenalty = -5;
    }
  }
  const previous = thresholdState.get(rollConfig);
  const current = rollConfig.options.criticalSuccess;
  const base = previous && previous.applied === current ? previous.base : current;
  if (own || target || previous) {
    const applied = effectiveThreshold(base, own, target);
    rollConfig.options.criticalSuccess = applied;
    thresholdState.set(rollConfig, { base, applied });
  }
}

export function configureDamage(config, _dialog, message = {}) {
  if (config.workflow?.itemCardUuid) setMessageFlag(message, 'midiAttackMessage', config.workflow.itemCardUuid);
  if (config.workflow?.[MODULE_ID]?.phobos?.missed) return false;
  const item = weaponFor(config.subject);
  if (!item) return;
  const reason = blockedWeapon(item);
  if (reason) { ui.notifications.warn(reason); return false; }
  setMessageFlag(message, 'weaponUuid', item.uuid);
  setMessageFlag(message, 'pattern', flagsOf(item).pattern ?? 'imperial');
  const originId = message.data?.flags?.dnd5e?.originatingMessage
    ?? message.data?.['flags.dnd5e.originatingMessage']
    ?? config.event?.target?.closest?.('[data-message-id]')?.dataset.messageId;
  const attack = linkedAttackMessage({ flags: { dnd5e: { originatingMessage: originId } },
    getAssociatedActivity: () => config.subject });
  if (attack) setMessageFlag(message, 'attackMessage', attack.uuid ?? attack.id);
  retainMidiMetadata(config, message);
  if (flagsOf(item).pattern === 'mars' && !config.rolls.some(roll => roll.options?.[MODULE_ID]?.mars)) {
    config.rolls.push({ parts: ['1'], data: {}, options: { type: 'necrotic', isCritical: false,
      critical: { multiplier: 1, multiplyNumeric: false, powerfulCritical: false, bonusDice: 0, bonusDamage: '' },
      [MODULE_ID]: { mars: true } } });
  }
}

export function naturalResult(roll) {
  const die = roll?.d20 ?? roll?.dice?.find(die => die.faces === 20);
  const result = die?.results?.find(result => result.active !== false && !result.discarded);
  return result?.result;
}

async function dropWeapon(item, reason) {
  if (!item.isOwner) return;
  await item.update({ 'system.equipped': false });
  await announce(item.actor, `<p>${esc(item.name)} ${esc(reason)}. It is unequipped; mark its position on the scene.</p>`);
}

async function handleAttack(rolls, { subject } = {}, { retry, midi = false } = {}) {
  const item = weaponFor(subject);
  if (!item?.isOwner || !rolls?.length) return;
  // Core's postRollAttack hook is synchronous and supplies only the subject.
  // Midi's awaited preCheckHits hook owns the corresponding attack instead.
  if (!midi && rolls[0].options?.[MODULE_ID]?.midiWorkflow) return;
  const key = rolls[0].parent?.uuid ?? rolls[0].parent?.id;
  if (remember(handledAttacks, key)) return;
  const roll = rolls[0];
  const state = flagsOf(item);
  const used = roll.options?.[MODULE_ID];
  if (used?.nextAttack && JSON.stringify(used.nextAttack) === JSON.stringify(state.nextAttack)) {
    await item.update({ [`flags.${MODULE_ID}.nextAttack`]: null });
  }
  if (used?.pattern === 'triplex' && used.mode === 'burst' && Number(used.nextAttack?.burstCount) > 1) {
    await announce(item.actor, `<p>Triplex Burst: ${esc(used.nextAttack.burstCount)} committed attacks share this roll. They all hit or all miss. Resolve damage for each hit and spend any additional ammunition manually.</p>`);
  }
  if (naturalResult(roll) !== 1) return;
  if (state.pattern === 'kantreal') {
    const confirmation = await new Roll('1d20').evaluate();
    await confirmation.toMessage({ speaker: ChatMessage.getSpeaker({ actor: item.actor }),
      flavor: `${esc(item.name)}: Kantreal confirmation` });
    const result = kantrealOutcome(confirmation.total, { minimum: getConfig().kantrealMinimum ?? 11 });
    if (result === 'jammed') {
      await item.update({ [`flags.${MODULE_ID}.jammed`]: true });
      await announce(item.actor, `<p>${esc(item.name)} is jammed. Spend an action mending it before attacking again.</p>`);
    } else if (result === 'retry') {
      const choice = await choose('Kantreal retry', '<p>You may remake the attack. This is a new attack roll and consumes ammunition through the normal workflow.</p>',
        [{ action: 'retry', label: 'Remake attack' }, { action: 'keep', label: 'Keep failure' }]);
      if (choice === 'retry') {
        const activity = item.system.activities?.get(subject.id);
        if (activity && !blockedWeapon(item)) {
          if (retry) await retry(roll);
          else await activity.rollAttack({ attackMode: roll.options?.attackMode, ammunition: roll.options?.ammunition });
        }
      }
    } else await announce(item.actor, `<p>Kantreal confirmation: the critical failure stands.</p>`);
  } else if (state.pattern === 'accatran') await dropWeapon(item, 'flies out of your hands');
  else if (state.pattern === 'triplex') {
    await item.update({ [`flags.${MODULE_ID}.modesLocked`]: true, [`flags.${MODULE_ID}.triplexMode`]: 'standard' });
    await announce(item.actor, `<p>${esc(item.name)} has lost its special firing modes. Spend an action recalibrating it.</p>`);
  } else if (['sunfury', 'magnacore'].includes(state.pattern)) {
    const choice = await choose('Weapon overheated', `<p>${esc(item.name)} overheats. Drop it or take 1d4 fire damage.</p>`,
      [{ action: 'drop', label: 'Drop weapon' }, { action: 'damage', label: 'Take 1d4 fire' }]);
    if (choice === 'drop') await dropWeapon(item, 'was dropped after overheating');
    else if (choice === 'damage') {
      const damage = await new CONFIG.Dice.DamageRoll('1d4', {}, { type: 'fire' }).evaluate();
      await damage.toMessage({ speaker: ChatMessage.getSpeaker({ actor: item.actor }), flavor: `${esc(item.name)}: overheating` });
      await item.actor.applyDamage([{ value: damage.total, type: 'fire', properties: new Set() }]);
    } else await announce(item.actor, `<p>${esc(item.name)} overheated. The choice is unresolved: drop it or take 1d4 fire damage.</p>`);
  } else if (state.pattern === 'mercurian' && roll.options?.attackMode?.startsWith('thrown')) {
    await item.update({ [`flags.${MODULE_ID}.mercurianDamaged`]: true });
    await announce(item.actor, `<p>${esc(item.name)} is damaged. Repair it for 10 minutes with Weapon Tools before using it.</p>`);
  }
}

/** Midi 14.0.9 awaits preCheckHits before processing the final attack and damage. */
export async function handleMidiAttack(workflow) {
  if (!workflow?.attackRoll || !weaponFor(workflow.activity)?.isOwner) return;
  while (workflow.attackRoll && !handledMidiAttacks.has(workflow.attackRoll)) {
    const original = workflow.attackRoll;
    handledMidiAttacks.add(original);
    await handleAttack([original], { subject: workflow.activity }, { midi: true, retry: async roll => {
      const tracker = workflow.attackRollModifierTracker;
      if (typeof workflow.setAttackRoll !== 'function' || !tracker?.critical?.get || !tracker?.fumble?.get
        || typeof tracker.critical.restore !== 'function' || typeof tracker.fumble.restore !== 'function') {
        throw new Error('This Midi-QOL version cannot safely replace the Kantreal attack. Remake the attack after this workflow completes.');
      }
      // Midi 14.0.9 ignores updateWorkflow:false for attacks. Omitting workflow
      // deliberately selects its core rollAttack fallback, which still consumes
      // ammunition. Never recursively resume or create another Midi workflow.
      const used = roll.options?.[MODULE_ID];
      const rolls = await workflow.activity.rollAttack({
        attackMode: roll.options?.attackMode, ammunition: roll.options?.ammunition,
        advantage: Boolean(tracker.hasAdvantage), disadvantage: Boolean(tracker.hasDisadvantage),
        [MODULE_ID]: { midiRetry: true, conditions: used?.nextAttack ?? null,
          targets: [...(workflow.targets ?? [])].map(target => target.actor).filter(Boolean) }
      }, {}, { create: false });
      if (!rolls?.[0]) return;
      rolls[0].options ??= {};
      rolls[0].options[MODULE_ID] = { ...(rolls[0].options[MODULE_ID] ?? {}), midiWorkflow: true };
      // processAttackRoll sets natural=true when appropriate but never clears a
      // previous natural failure. Keep unrelated forced/suppressed states.
      for (const name of ['critical', 'fumble']) tracker[name].restore({ ...tracker[name].get, natural: false });
      await workflow.setAttackRoll(rolls[0]);
      workflow.attackRollCount = (workflow.attackRollCount ?? 1) + 1;
    } });
    if (workflow.attackRoll === original || workflow.aborted) break;
  }
}

export function damageMessage(options) {
  const origin = options?.origin ?? options?.originatingMessage;
  if (typeof origin === 'string') return game.messages?.get(origin) ?? globalThis.fromUuidSync?.(origin);
  return origin?.documentName === 'ChatMessage' || origin?.rolls ? origin : null;
}

export function attributedAttack(message) {
  const activity = message?.getAssociatedActivity?.();
  return activity?.type === 'attack' ? activity : null;
}

/** Match the origin card's attack, never an unrelated actor's latest attack. */
function linkedAttackMessage(message) {
  if (message?.flags?.dnd5e?.roll?.type === 'attack' || message?.rolls?.[0]?.options?.rollType === 'attack') return message;
  const recorded = message?.flags?.[MODULE_ID]?.attackMessage;
  if (recorded) {
    const saved = game.messages?.get(recorded) ?? globalThis.fromUuidSync?.(recorded);
    if (saved) return saved;
  }
  const originId = message?.flags?.dnd5e?.originatingMessage;
  if (!originId) return null;
  const origin = game.messages?.get(originId);
  if (origin?.flags?.dnd5e?.roll?.type === 'attack') return origin;
  const activity = message.getAssociatedActivity?.();
  const matches = globalThis.dnd5e?.registry?.messages?.get?.(originId, 'attack') ?? [];
  return [...matches].reverse().find(candidate => {
    const other = candidate.getAssociatedActivity?.();
    return activity && other?.id === activity.id && other.item?.uuid === activity.item?.uuid;
  }) ?? null;
}

export function criticalEventId(message, actor) {
  const midiOrigin = message?.flags?.[MODULE_ID]?.midiAttackMessage;
  if (typeof midiOrigin === 'string' && midiOrigin.startsWith('ChatMessage.') && actor?.uuid) return `${midiOrigin}:${actor.uuid}`;
  const attack = linkedAttackMessage(message) ?? message;
  const uuid = attack?.uuid ?? attack?.id;
  return uuid && actor?.uuid ? `${uuid}:${actor.uuid}` : null;
}

export function isCriticalAttackDamage(message, options = {}, amount = 0) {
  if (!message || !attributedAttack(message) || amount < 0 || options.only === 'healing'
    || message.flags?.[MODULE_ID]?.phobos?.missed
    || (Number.isFinite(options.multiplier) && options.multiplier <= 0)) return false;
  return (message.rolls ?? []).some(roll => roll.isCritical === true
    && !['healing', 'temphp'].includes(damageType(roll)));
}

function beforeDamage(actor, amount, updates, options) {
  const hp = actor.system?.attributes?.hp;
  const nextHp = updates?.['system.attributes.hp.value'] ?? updates?.system?.attributes?.hp?.value ?? hp?.value;
  const nextTemp = updates?.['system.attributes.hp.temp'] ?? updates?.system?.attributes?.hp?.temp ?? hp?.temp ?? 0;
  if (options && typeof options === 'object') damageSnapshots.set(options, {
    hp: hp?.value, temp: hp?.temp ?? 0, dead: actor.statuses?.has('dead'), actor: actor.uuid, amount,
    decreases: nextHp < hp?.value || nextTemp < (hp?.temp ?? 0),
    increases: nextHp > hp?.value || nextTemp > (hp?.temp ?? 0)
  });
}

export async function afterDamage(actor, amount, options = {}) {
  const midi = midiDamageContext(actor, options);
  const prior = damageSnapshots.get(options);
  // Midi's reapply buttons use inconsistent amount signs. Read the actual HP
  // direction captured before the write, and never mistake Undo for a new hit.
  if (options?.midi) {
    if (!actor?.isOwner || !midi || !prior || prior.actor !== actor.uuid || prior.increases) return;
    if (getConfig().armorDegradation && actor.type === 'character' && actor.hasPlayerOwner === true
      && midi.critical && options.midi.isCritical === true && prior.decreases) {
      const armor = itemsOf(actor).find(item => item.uuid === midi.armorUuid);
      if (armor) await damageArmor(armor, { stacking: getConfig().stackArmorDamage === true,
        eventId: midi.eventId, origin: actor.uuid });
    }
    if (midi.pattern === 'noctis' && prior.decreases && prior.hp > 0 && actor.system?.attributes?.hp?.value === 0) {
      // Midi's asynchronous NPC death processing can overwrite unconscious.
      // Explicitly request adjudication instead of claiming this race is fixed.
      await announce(actor, `<p>${esc(actor.name)} was reduced to 0 HP by a Noctis weapon. This is non-lethal: the GM must confirm unconscious instead of dead after Midi finishes applying damage.</p>`);
    }
    return;
  }
  const message = damageMessage(options);
  const activity = attributedAttack(message);
  if (!actor?.isOwner || !activity || amount < 0 || options.only === 'healing'
    || (Number.isFinite(options.multiplier) && options.multiplier <= 0)) return;
  if (getConfig().armorDegradation && actor.type === 'character' && actor.hasPlayerOwner === true
    && isCriticalAttackDamage(message, options, amount)) {
    const armor = equippedArmor(actor);
    if (armor) {
      const eventId = criticalEventId(message, actor);
      await damageArmor(armor, { stacking: getConfig().stackArmorDamage === true, eventId, origin: actor.uuid });
    }
  }
  const appliedPattern = message.flags?.[MODULE_ID]?.pattern ?? flagsOf(activity.item).pattern;
  if (appliedPattern === 'noctis' && amount > 0 && prior?.actor === actor.uuid && prior.hp > 0
    && actor.system?.attributes?.hp?.value === 0 && typeof actor.toggleStatusEffect === 'function') {
    await actor.toggleStatusEffect('unconscious', { active: true });
    if (!prior.dead && actor.statuses?.has('dead')) await actor.toggleStatusEffect('dead', { active: false });
    await announce(actor, `<p>${esc(actor.name)} was reduced to 0 HP by a Noctis weapon and is unconscious. The hit is non-lethal.</p>`);
  }
}

export function registerCombat() {
  on('dnd5e.preUseActivity', guardUse);
  on('dnd5e.preRollAttack', guardAttack);
  on('dnd5e.postBuildAttackRollConfig', configureAttack);
  on('dnd5e.preRollDamage', configureDamage);
  on('dnd5e.postRollAttack', (rolls, data) => run(handleAttack(rolls, data)));
  on('dnd5e.preApplyDamage', beforeDamage);
  on('dnd5e.applyDamage', (actor, amount, options) => run(afterDamage(actor, amount, options)));
  libWrapper.register(MODULE_ID, 'CONFIG.Dice.DamageRoll.buildEvaluate', evaluateDamage, 'WRAPPER');
}
