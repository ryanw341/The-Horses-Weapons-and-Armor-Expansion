import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_ID } from '../scripts/rules.js';
import { conversionPlan, rerollCandidates, combatTurnKey, effectiveThreshold, configureAttack,
  configureDamage, evaluateDamage, blockedWeapon, naturalResult, criticalEventId,
  isCriticalAttackDamage, afterDamage, registerCombat, handleMidiAttack } from '../scripts/combat.js';

function setPath(object, path, value) {
  const keys = path.split('.');
  let target = object;
  for (const key of keys.slice(0, -1)) target = target[key] ??= {};
  target[keys.at(-1)] = value;
}

function fixture(pattern = 'imperial') {
  const state = { config: {}, choices: [], random: [], messages: [], warnings: [], hooks: new Map(), wrappers: [] };
  class MockRoll {
    constructor(formula, _data = {}, options = {}) {
      this.formula = formula; this.options = options;
      this.terms = []; this.result = formula;
    }
    async evaluate() { this.total = this.formula.includes('d') ? state.random.shift() : Number(this.formula); return this; }
    get isCritical() { return this.options.isCritical === true; }
    toJSON() { return { formula: this.formula, total: this.total, options: this.options }; }
    async toMessage(message) { state.messages.push(message); }
  }
  globalThis.Roll = MockRoll;
  globalThis.CONFIG = { Dice: { DamageRoll: MockRoll } };
  globalThis.foundry = { applications: { api: { DialogV2: class {
    static async wait() { return state.choices.shift() ?? null; }
  } } }, utils: { randomID: () => 'randomid12345678' } };
  globalThis.game = { settings: { get: () => state.config }, user: { id: 'user', targets: new Set() },
    messages: new Map(), combat: { started: true, uuid: 'Combat.example', round: 1, turn: 0 } };
  globalThis.ChatMessage = { create: async message => state.messages.push(message), getSpeaker: ({ actor }) => ({ actor: actor?.id }) };
  globalThis.ui = { notifications: { warn: text => state.warnings.push(text) } };
  globalThis.Hooks = { on: (name, callback) => state.hooks.set(name, callback) };
  globalThis.libWrapper = { register: (...args) => state.wrappers.push(args) };
  globalThis.dnd5e = { registry: { messages: { get: () => [] } } };
  globalThis.fromUuidSync = uuid => [...game.messages.values()].find(message => message.uuid === uuid);
  const actor = { id: 'actor', uuid: 'Actor.example', name: 'Aster', type: 'character', hasPlayerOwner: true,
    isOwner: true, items: new Map(), statuses: new Set(), system: { attributes: { hp: { value: 12 } } },
    async applyDamage(damage) { this.damage = damage; },
    async toggleStatusEffect(status, { active }) { if (active) this.statuses.add(status); else this.statuses.delete(status); } };
  Object.defineProperty(actor.items, 'contents', { get() { return [...this.values()]; } });
  const item = { id: 'weapon', uuid: 'Actor.example.Item.weapon', actor, parent: actor, isOwner: true,
    type: 'weapon', name: '<Weapon>', flags: { [MODULE_ID]: { pattern } }, system: { equipped: true },
    updates: [], async update(update) { this.updates.push(update); for (const [path, value] of Object.entries(update)) setPath(this, path, value); return this; } };
  actor.items.set(item.id, item);
  const activity = { id: 'attack', type: 'attack', actor, item, async rollAttack(config) { state.retry = config; } };
  item.system.activities = new Map([[activity.id, activity]]);
  function armor() {
    const armor = { ...item, id: 'armor', uuid: 'Actor.example.Item.armor', type: 'equipment', effects: [],
      flags: {}, updates: [], system: { equipped: true, quantity: 1, type: { value: 'medium' }, armor: { value: 14 } },
      toObject() { return { effects: this.effects }; } };
    actor.items.set(armor.id, armor);
    return armor;
  }
  return { state, actor, item, activity, armor };
}

function damage(total, type = 'slashing', extra = {}) {
  return { total, formula: '2d6+3', result: String(total), options: { type, properties: ['mgc'], ...extra },
    get isCritical() { return this.options.isCritical === true; }, toJSON() { return { total, type }; } };
}
function additiveRoll() {
  return { ...damage(12), terms: [{ faces: 6, modifiers: [], results: [{ result: 4, active: true }, { result: 5, active: true }] },
    { operator: '+' }, { number: 3 }] };
}

test('damage conversion preserves total and per-source properties, skips healing, handles short damage', () => {
  const rolls = [damage(1), damage(8, 'piercing'), damage(5, 'healing')];
  const plan = conversionPlan(rolls, 'fire');
  assert.deepEqual(plan.map(({ value, type }) => [value, type]), [[1, 'fire'], [6, 'piercing'], [2, 'fire'], [5, 'healing']]);
  assert.equal(plan.reduce((sum, part) => sum + part.value, 0), 14);
  assert.equal(conversionPlan([damage(2)], 'fire')[0].value, 2);
  assert.equal(conversionPlan([damage(3, 'fire'), damage(8)], 'fire').every(part => part.unchanged), true);
});

test('Phobos candidate detection excludes inactive dice, nonlinear formulas and modified pools', () => {
  const roll = additiveRoll();
  roll.terms[0].results.push({ result: 1, active: false });
  assert.equal(rerollCandidates([roll]).length, 2);
  roll.terms[1].operator = '*';
  assert.equal(rerollCandidates([roll]).length, 0);
  roll.terms[1].operator = '+';
  roll.terms[0].modifiers = ['kh'];
  assert.equal(rerollCandidates([roll]).length, 0);
});

test('Tsun-Jin caps the weapon threshold at 19 without stacking; defender drawback remains independent', () => {
  const { actor, activity } = fixture('tsun-jin');
  assert.equal(effectiveThreshold(20, true, false), 19);
  assert.equal(effectiveThreshold(19, true, false), 19);
  assert.equal(effectiveThreshold(18, true, false), 18);
  assert.equal(effectiveThreshold(20, true, true), 18);
  assert.equal(effectiveThreshold(2, true, true), 2);
  const config = { subject: activity, [MODULE_ID]: { targets: [] } }, roll = { options: { criticalSuccess: 18 } };
  configureAttack(config, roll); configureAttack(config, roll);
  assert.equal(roll.options.criticalSuccess, 18);
  config[MODULE_ID].targets = [actor];
  configureAttack(config, roll);
  assert.equal(roll.options.criticalSuccess, 17);
});

test('Mars adds one separate noncritical necrotic point without self damage or duplicate additions', () => {
  const { actor, activity } = fixture('mars');
  const config = { subject: activity, rolls: [{ parts: ['1d8'] }] }, message = {};
  configureDamage(config, {}, message); configureDamage(config, {}, message);
  assert.equal(config.rolls.length, 2);
  assert.deepEqual(config.rolls[1].parts, ['1']);
  assert.equal(config.rolls[1].options.type, 'necrotic');
  assert.equal(config.rolls[1].options.critical.multiplyNumeric, false);
  assert.equal(actor.damage, undefined);
  assert.equal(message.data.flags[MODULE_ID].pattern, 'mars');
});

test('Sunfury converts evaluated damage before posting, keeps critical metadata and original roll evidence', async () => {
  const { activity } = fixture('sunfury');
  const rolls = [damage(13, 'slashing', { isCritical: true })], message = {};
  let evaluated = false;
  await evaluateDamage(async () => { evaluated = true; }, rolls, { subject: activity }, message);
  assert.equal(evaluated, true);
  assert.deepEqual(rolls.map(roll => [roll.total, roll.options.type]), [[10, 'slashing'], [3, 'fire']]);
  assert.equal(rolls.every(roll => roll.isCritical && roll.options.properties.includes('mgc')), true);
  assert.equal(message.data.flags[MODULE_ID].damageConversion.original[0].total, 13);
  assert.match(message.data.flavor, /Original: 2d6\+3 = 13/);
});

test('Triplex standard and locked modes never convert damage; energized converts only three points', async () => {
  const { item, activity } = fixture('triplex');
  for (const [mode, locked, expected] of [['standard', false, 'slashing'], ['energized', true, 'slashing'], ['energized', false, 'lightning']]) {
    Object.assign(item.flags[MODULE_ID], { triplexMode: mode, modesLocked: locked });
    const rolls = [damage(2)];
    await evaluateDamage(async () => {}, rolls, { subject: activity }, {});
    assert.equal(rolls[0].options.type, expected);
    assert.equal(rolls[0].total, 2);
  }
});

test('Phobos rerolls one chosen die, preserves other dice contribution, and spends at most once per turn', async () => {
  const { state, item, activity } = fixture('phobos');
  state.choices.push('0'); state.random.push(6);
  const rolls = [additiveRoll()], message = {};
  await evaluateDamage(async () => {}, rolls, { subject: activity }, message);
  assert.equal(rolls[0].total, 14);
  assert.equal(item.flags[MODULE_ID].phobosTurn, 'Combat.example:1:0');
  assert.equal(message.data.flags[MODULE_ID].phobos.candidate.value, 4);
  const again = [additiveRoll()];
  await evaluateDamage(async () => {}, again, { subject: activity }, {});
  assert.equal(again[0].total, 12);
});

test('Phobos rerolled 1 makes the whole damage batch zero, including separate riders', async () => {
  const { state, activity } = fixture('phobos');
  state.choices.push('1'); state.random.push(1);
  const rolls = [additiveRoll(), damage(4, 'necrotic')], message = {};
  await evaluateDamage(async () => {}, rolls, { subject: activity }, message);
  assert.deepEqual(rolls.map(roll => roll.total), [0, 0]);
  assert.equal(message.data.flags[MODULE_ID].phobos.missed, true);
});

test('Phobos out of combat explicitly leaves reroll for manual resolution without spending it', async () => {
  const { item, activity } = fixture('phobos');
  game.combat = null;
  assert.equal(combatTurnKey(game.combat), null);
  const rolls = [additiveRoll()], message = {};
  await evaluateDamage(async () => {}, rolls, { subject: activity }, message);
  assert.equal(rolls[0].total, 12);
  assert.equal(item.flags[MODULE_ID].phobosTurn, undefined);
  assert.match(message.data.flavor, /no active combat turn/);
});

test('damage adaptations never mutate an unowned weapon', async () => {
  const { item, activity } = fixture('sunfury');
  item.isOwner = false;
  const rolls = [damage(10)];
  await evaluateDamage(async () => {}, rolls, { subject: activity }, {});
  assert.equal(rolls.length, 1);
  assert.equal(rolls[0].total, 10);
});

test('jam and damaged guards block attacks, while natural result respects discarded dice', () => {
  const { item, activity, state } = fixture('kantreal');
  registerCombat();
  item.flags[MODULE_ID].jammed = true;
  assert.match(blockedWeapon(item), /mending/);
  assert.equal(state.hooks.get('dnd5e.preUseActivity')(activity), false);
  assert.equal(state.hooks.get('dnd5e.preUseActivity')({ ...activity, type: 'damage' }), false);
  assert.equal(state.hooks.get('dnd5e.preUseActivity')({ ...activity, type: 'utility' }), undefined);
  assert.equal(state.hooks.get('dnd5e.preRollAttack')({ subject: activity }), false);
  assert.equal(state.hooks.get('dnd5e.preRollDamage')({ subject: activity, rolls: [] }), false);
  item.flags[MODULE_ID] = { mercurianDamaged: true };
  assert.match(blockedWeapon(item), /10 minutes/);
  assert.equal(naturalResult({ d20: { results: [{ result: 1, active: false }, { result: 12, active: true }] } }), 12);
  assert.equal(state.wrappers[0][1], 'CONFIG.Dice.DamageRoll.buildEvaluate');
});

test('critical damage attribution accepts zero damage but rejects healing, reversed damage and missing attack source', () => {
  const { activity } = fixture();
  const message = { rolls: [damage(0, 'slashing', { isCritical: true })], getAssociatedActivity: () => activity };
  assert.equal(isCriticalAttackDamage(message, {}, 0), true);
  assert.equal(isCriticalAttackDamage(message, { multiplier: -1 }, 0), false);
  assert.equal(isCriticalAttackDamage(message, { only: 'healing' }, 0), false);
  assert.equal(isCriticalAttackDamage(message, {}, -5), false);
  assert.equal(isCriticalAttackDamage({ rolls: message.rolls }, {}, 5), false);
  message.flags = { [MODULE_ID]: { phobos: { missed: true } } };
  assert.equal(isCriticalAttackDamage(message, {}, 0), false);
});

test('critical event ID joins damage to the same attack message and armor applies only once', async () => {
  const { state, actor, activity, armor: addArmor } = fixture();
  state.config = { armorDegradation: true, stackArmorDamage: true };
  const armor = addArmor();
  const attack = { id: 'attack1', uuid: 'ChatMessage.attack1', flags: { dnd5e: { roll: { type: 'attack' } } } };
  game.messages.set(attack.id, attack);
  const message = { id: 'damage1', uuid: 'ChatMessage.damage1', flags: { dnd5e: { originatingMessage: 'attack1' } },
    rolls: [damage(5, 'slashing', { isCritical: true })], getAssociatedActivity: () => activity };
  assert.equal(criticalEventId(message, actor), criticalEventId(attack, actor));
  await afterDamage(actor, 5, { origin: message });
  await afterDamage(actor, 5, { originatingMessage: message });
  assert.equal(armor.flags[MODULE_ID].damageStacks, 1);
  assert.equal(armor.system.armor.value, 14);
});

test('Noctis makes a newly reduced owned target unconscious, without rewriting HP', async () => {
  const { state, actor, activity } = fixture('noctis');
  registerCombat();
  const options = { origin: { rolls: [damage(15)], getAssociatedActivity: () => activity } };
  state.hooks.get('dnd5e.preApplyDamage')(actor, 15, {}, options);
  actor.system.attributes.hp.value = 0;
  actor.statuses.add('dead');
  await afterDamage(actor, 15, options);
  assert.equal(actor.statuses.has('unconscious'), true);
  assert.equal(actor.statuses.has('dead'), false);
  assert.equal(actor.system.attributes.hp.value, 0);
});

test('accatran fumble unequips without deleting, and mercurian only breaks on a thrown fumble', async () => {
  const { state, item, activity } = fixture('accatran');
  registerCombat();
  const roll = { d20: { results: [{ result: 1, active: true }] }, options: {}, parent: { uuid: 'ChatMessage.fumbleA' } };
  await state.hooks.get('dnd5e.postRollAttack')([roll], { subject: activity });
  assert.equal(item.system.equipped, false);
  item.flags[MODULE_ID].pattern = 'mercurian';
  roll.parent.uuid = 'ChatMessage.fumbleB';
  await state.hooks.get('dnd5e.postRollAttack')([roll], { subject: activity });
  assert.equal(item.flags[MODULE_ID].mercurianDamaged, undefined);
  roll.parent.uuid = 'ChatMessage.fumbleC'; roll.options.attackMode = 'thrown';
  await state.hooks.get('dnd5e.postRollAttack')([roll], { subject: activity });
  assert.equal(item.flags[MODULE_ID].mercurianDamaged, true);
});

test('declared scoped long range adds -5 once and keeps unrelated disadvantage', async () => {
  const { state, item, activity } = fixture('triplex');
  registerCombat();
  Object.assign(item.flags[MODULE_ID], { triplexMode: 'scoped', nextAttack: { longRange: true } });
  const config = { subject: activity, disadvantage: true };
  state.hooks.get('dnd5e.preRollAttack')(config);
  assert.equal(config.disadvantage, true);
  const rollConfig = { options: {}, parts: ['@mod'], data: { mod: 3 } };
  configureAttack(config, rollConfig); configureAttack(config, rollConfig);
  assert.equal(rollConfig.parts.filter(part => part === '@horseScopedPenalty').length, 1);
  assert.equal(rollConfig.data.horseScopedPenalty, -5);
  const roll = { options: rollConfig.options, d20: { results: [{ result: 12 }] }, parent: { uuid: 'ChatMessage.scoped' } };
  await state.hooks.get('dnd5e.postRollAttack')([roll], { subject: activity });
  assert.equal(item.flags[MODULE_ID].nextAttack, null);
});

test('Kalibrax and Mezoa ignore only their declared disadvantage source, preserving other causes', () => {
  const { state, item, activity } = fixture('kalibrax');
  registerCombat();
  item.flags[MODULE_ID].nextAttack = { underwater: true };
  const first = { subject: activity };
  state.hooks.get('dnd5e.preRollAttack')(first);
  assert.equal(first.disadvantage, undefined);
  item.flags[MODULE_ID].nextAttack.nearby = true;
  const second = { subject: activity };
  state.hooks.get('dnd5e.preRollAttack')(second);
  assert.equal(second.disadvantage, true);
  item.flags[MODULE_ID] = { pattern: 'mezoa', nextAttack: { nearby: true } };
  const third = { subject: activity, disadvantage: true };
  state.hooks.get('dnd5e.preRollAttack')(third);
  assert.equal(third.disadvantage, true);
});

test('Kantreal confirmation 1 jams, and a successful confirmation remakes the same attack normally', async () => {
  const { state, item, activity } = fixture('kantreal');
  registerCombat();
  const roll = { d20: { results: [{ result: 1 }] }, options: { attackMode: 'oneHanded', ammunition: 'ammo' },
    parent: { uuid: 'ChatMessage.kantreal1' } };
  state.random.push(1);
  await state.hooks.get('dnd5e.postRollAttack')([roll], { subject: activity });
  assert.equal(item.flags[MODULE_ID].jammed, true);
  item.flags[MODULE_ID].jammed = false;
  roll.parent.uuid = 'ChatMessage.kantreal2';
  state.random.push(11); state.choices.push('retry');
  await state.hooks.get('dnd5e.postRollAttack')([roll], { subject: activity });
  assert.deepEqual(state.retry, { attackMode: 'oneHanded', ammunition: 'ammo' });
});

test('automatic armor damage excludes NPCs, unowned actors, and playerless characters', async () => {
  const { state, actor, activity, armor: addArmor } = fixture();
  state.config.armorDegradation = true;
  const armor = addArmor();
  const message = { id: 'critical-scope', rolls: [damage(3, 'piercing', { isCritical: true })], getAssociatedActivity: () => activity };
  actor.type = 'npc';
  await afterDamage(actor, 3, { origin: message });
  actor.type = 'character'; actor.hasPlayerOwner = false;
  await afterDamage(actor, 3, { origin: message });
  actor.hasPlayerOwner = true; actor.isOwner = false;
  await afterDamage(actor, 3, { origin: message });
  assert.equal(armor.updates.length, 0);
});

function midiWorkflow(activity, roll) {
  const tracker = () => ({ get: { natural: true, forced: false, suppressed: false, override: undefined },
    restore(state) { this.get = state; } });
  return { activity, item: activity.item, attackRoll: roll, targets: new Set(), attackRollCount: 1,
    attackRollModifierTracker: { critical: tracker(), fumble: tracker(), hasAdvantage: true, hasDisadvantage: false },
    async setAttackRoll(replacement) { this.attackRoll = replacement; } };
}

test('Midi attack skips the unawaited core fumble hook and resolves once in its awaited hook', async () => {
  const { state, item, activity } = fixture('accatran');
  registerCombat();
  const config = { subject: activity, workflow: { targets: new Set() } };
  state.hooks.get('dnd5e.preRollAttack')(config);
  const roll = { options: {}, d20: { results: [{ result: 1 }] } };
  configureAttack(config, roll);
  assert.equal(roll.options[MODULE_ID].midiWorkflow, true);
  await state.hooks.get('dnd5e.postRollAttack')([roll], { subject: activity });
  assert.equal(item.system.equipped, true);
  const workflow = midiWorkflow(activity, roll);
  await handleMidiAttack(workflow);
  await handleMidiAttack(workflow);
  assert.equal(item.system.equipped, false);
  assert.equal(item.updates.length, 1);
});

test('Midi Kantreal retry replaces the same workflow before hit checks and preserves unrelated tracker state', async () => {
  const { state, activity } = fixture('kantreal');
  const original = { options: { attackMode: 'oneHanded', ammunition: 'ammo',
    [MODULE_ID]: { midiWorkflow: true, nextAttack: { underwater: true } } }, d20: { results: [{ result: 1 }] } };
  const replacement = { options: {}, d20: { results: [{ result: 17 }] } };
  const workflow = midiWorkflow(activity, original);
  workflow.attackRollModifierTracker.critical.get = { natural: false, forced: true, suppressed: true, override: false };
  let resolved = false;
  activity.rollAttack = async (config, _dialog, message) => {
    assert.equal(config.workflow, undefined);
    assert.equal(config[MODULE_ID].midiRetry, true);
    assert.deepEqual(config[MODULE_ID].conditions, { underwater: true });
    assert.equal(config.advantage, true);
    assert.equal(config.disadvantage, false);
    assert.equal(config.ammunition, 'ammo');
    assert.equal(message.create, false);
    await Promise.resolve();
    resolved = true;
    return [replacement];
  };
  state.random.push(11); state.choices.push('retry');
  await handleMidiAttack(workflow);
  assert.equal(resolved, true);
  assert.equal(workflow.attackRoll, replacement);
  assert.equal(replacement.options[MODULE_ID].midiWorkflow, true);
  assert.equal(workflow.attackRollCount, 2);
  assert.equal(workflow.attackRollModifierTracker.fumble.get.natural, false);
  assert.deepEqual(workflow.attackRollModifierTracker.critical.get,
    { natural: false, forced: true, suppressed: true, override: false });
});

test('Midi Kantreal confirmation ten retains failure and a retry fumble can jam before workflow continues', async () => {
  const { state, item, activity } = fixture('kantreal');
  const attack = () => ({ options: { [MODULE_ID]: { midiWorkflow: true } }, d20: { results: [{ result: 1 }] } });
  const failed = midiWorkflow(activity, attack());
  state.random.push(10);
  await handleMidiAttack(failed);
  assert.equal(state.retry, undefined);
  assert.equal(failed.attackRollCount, 1);
  const workflow = midiWorkflow(activity, attack());
  activity.rollAttack = async () => [attack()];
  state.random.push(11, 1); state.choices.push('retry');
  await handleMidiAttack(workflow);
  assert.equal(item.flags[MODULE_ID].jammed, true);
  assert.equal(workflow.attackRollCount, 2);
  assert.equal(state.random.length, 0);
});

test('Midi cancelled Kantreal remake retains the failed roll and its natural-fumble tracker', async () => {
  const { state, activity } = fixture('kantreal');
  const original = { options: {}, d20: { results: [{ result: 1 }] } };
  const workflow = midiWorkflow(activity, original);
  activity.rollAttack = async () => null;
  state.random.push(11); state.choices.push('retry');
  await handleMidiAttack(workflow);
  assert.equal(workflow.attackRoll, original);
  assert.equal(workflow.attackRollModifierTracker.fumble.get.natural, true);
  assert.equal(workflow.attackRollCount, 1);
});

test('Midi Phobos miss survives suppressed chat creation and blocks or zeroes later damage batches', async () => {
  const { state, activity } = fixture('phobos');
  const workflow = { activity }, message = { create: false };
  const config = { subject: activity, workflow, rolls: [] };
  configureDamage(config, {}, message);
  assert.equal(workflow[MODULE_ID].weaponUuid, activity.item.uuid);
  assert.equal(workflow[MODULE_ID].pattern, 'phobos');
  state.choices.push('0'); state.random.push(1);
  const first = [additiveRoll()];
  await evaluateDamage(async () => {}, first, config, message);
  assert.equal(workflow[MODULE_ID].phobos.missed, true);
  assert.equal(workflow[MODULE_ID].phobos.original[0].total, 12);
  assert.equal(configureDamage({ ...config, subject: { type: 'damage' } }, {}, {}), false);
  const later = [damage(7, 'fire'), damage(4, 'necrotic')];
  await evaluateDamage(async () => {}, later, { workflow }, {});
  assert.deepEqual(later.map(roll => roll.total), [0, 0]);
});

test('Midi damage conversion evidence remains on workflow when the core chat message is suppressed', async () => {
  const { activity } = fixture('sunfury');
  const workflow = { activity }, message = { create: false }, rolls = [damage(9)];
  await evaluateDamage(async () => {}, rolls, { subject: activity, workflow }, message);
  assert.equal(workflow[MODULE_ID].damageConversion.type, 'fire');
  assert.equal(workflow[MODULE_ID].damageConversion.original[0].total, 9);
  assert.deepEqual(rolls.map(roll => roll.total), [6, 3]);
});
