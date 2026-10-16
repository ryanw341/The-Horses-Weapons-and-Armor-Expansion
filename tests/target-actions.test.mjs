import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { MODULE_ID } from '../scripts/rules.js';
import { defaults } from '../scripts/shared.js';
import { armorDamageState, damageArmor } from '../scripts/armor.js';
import { criticalEventId } from '../scripts/combat.js';
import { nextTurnExpiry, expiryReached, applyTargetAction, openTargetAction, resolveRequest,
  confirmCriticalArmor, registerTargetActions } from '../scripts/target-actions.js';

class Collection extends Map { [Symbol.iterator]() { return this.values(); } }
const read = (object, path) => path.split('.').reduce((current, part) => current?.[part], object);
function write(object, path, value) {
  const keys = path.split('.'); let current = object;
  for (const key of keys.slice(0, -1)) current = current[key] ??= {};
  current[keys.at(-1)] = structuredClone(value);
}

function fixture(pattern = 'lucius') {
  const state = { config: { ...defaults(), armorDegradation: true, stackArmorDamage: true },
    documents: new Map(), dialogs: [], choices: [], messages: [], rolls: [], hooks: new Map(), nextRoll: 4 };
  const gm = { id: 'gm', active: true, isGM: true, targets: new Set() };
  const player = { id: 'player', active: true, isGM: false, targets: new Set() };
  const users = [gm, player]; users.activeGM = gm;
  globalThis.game = { user: gm, users, actors: [], scenes: [], messages: new Map(), modules: new Map(),
    settings: { get: () => state.config }, i18n: { localize: value => value } };
  globalThis.CONFIG = { DND5E: { weaponTypeMap: {}, damageTypes: { slashing: 'Slashing', fire: 'Fire', piercing: 'Piercing' } } };
  globalThis.Hooks = { on(name, callback) { state.hooks.set(name, callback); } };
  globalThis.ChatMessage = { getSpeaker: ({ actor }) => ({ actor: actor?.uuid }), create: async data => {
    state.messages.push(data); return data;
  } };
  globalThis.foundry = { applications: { api: { DialogV2: class {
    static async wait(options) { state.dialogs.push(options); return state.choices.length ? state.choices.shift() : options; }
    async _onRender() {}
  } } } };
  globalThis.fromUuid = async uuid => state.documents.get(uuid);
  globalThis.Roll = class {
    constructor(formula) { this.formula = formula; }
    async evaluate() { this.total = state.nextRoll; return this; }
    async toMessage(options) { state.rolls.push({ formula: this.formula, total: this.total, options }); }
  };
  function actor(id) {
    const result = { id, uuid: `Actor.${id}`, documentName: 'Actor', name: id, type: 'character', hasPlayerOwner: true,
      isOwner: true, flags: {}, effects: [], items: new Collection(), damage: [], conditions: [], deletions: [], multiplier: 1,
      system: { abilities: { str: { mod: 3 }, dex: { mod: 1 } }, attributes: { ac: {}, hp: { value: 30 } } },
      getFlag(scope, key) { return read(this.flags[scope], key); },
      async setFlag(scope, key, value) { write(this.flags, `${scope}.${key}`, value); },
      testUserPermission: user => user.id === player.id,
      calculateDamage(damage) {
        if (this.cancelDamage) return false;
        return { amount: Math.trunc(damage.reduce((sum, entry) => sum + entry.value, 0) * this.multiplier) };
      },
      async applyDamage(damage, options = {}) {
        this.damage.push({ damage: structuredClone(damage), options: structuredClone(options) });
        this.system.attributes.hp.value -= options.ignore ? damage.reduce((sum, entry) => sum + entry.value, 0) : this.calculateDamage(damage).amount;
        return this;
      },
      async toggleStatusEffect(status, options) { this.conditions.push({ status, options }); return []; },
      async createEmbeddedDocuments(type, effects) {
        this.effects.push(...effects.map((effect, index) => ({ id: `effect${this.effects.length + index}`, ...structuredClone(effect) })));
        return this.effects;
      },
      async deleteEmbeddedDocuments(type, ids) {
        this.deletions.push({ type, ids }); this.effects = this.effects.filter(effect => !ids.includes(effect.id));
      }
    };
    state.documents.set(result.uuid, result); game.actors.push(result); return result;
  }
  const attacker = actor('attacker'), target = actor('target'), third = actor('third');
  const source = { id: 'weapon', uuid: `${attacker.uuid}.Item.weapon`, documentName: 'Item', type: 'weapon',
    name: 'Pattern weapon', actor: attacker, parent: attacker, isOwner: true, flags: { [MODULE_ID]: { pattern } },
    system: { type: { value: pattern === 'lucius' ? 'martialR' : 'martialM' }, damage: { base: { types: new Set(['slashing']) } },
      activities: new Collection([['attack', { id: 'attack', type: 'attack', name: 'Strike', ability: 'str' }]]) } };
  attacker.items.set(source.id, source); state.documents.set(source.uuid, source);
  game.user.targets.add({ actor: target });
  game.combat = { id: 'encounter', started: true, round: 4, turn: 0,
    turns: [{ id: 'attackerCombatant', actor: attacker }, { id: 'targetCombatant', actor: target }, { id: 'thirdCombatant', actor: third }] };
  function message(action = pattern, data = { amount: 7, type: 'piercing' }, id = 'request') {
    const result = { id, uuid: `ChatMessage.${id}`, documentName: 'ChatMessage', isOwner: true,
      flags: { [MODULE_ID]: { request: { itemUuid: source.uuid, targetUuid: target.uuid, action, data }, resolved: false } },
      getFlag(scope, key) { return read(this.flags[scope], key); },
      async setFlag(scope, key, value) { write(this.flags, `${scope}.${key}`, value); } };
    return result;
  }
  function armor(owner = target, id = 'armor') {
    const item = { id, uuid: `${owner.uuid}.Item.${id}`, documentName: 'Item', name: id, type: 'equipment',
      parent: owner, actor: owner, isOwner: true, effects: [], flags: {}, updates: [],
      system: { type: { value: 'heavy' }, quantity: 1, equipped: true },
      getFlag(scope, key) { return read(this.flags[scope], key); }, toObject() { return { effects: structuredClone(this.effects) }; },
      async update(data) { this.updates.push(data); for (const [path, value] of Object.entries(data)) write(this, path, value); return this; } };
    owner.items.set(id, item); owner.system.attributes.ac.equippedArmor = item;
    state.documents.set(item.uuid, item); return item;
  }
  return { ...state, state, attacker, target, third, source, actor, message, armor, gm, player };
}

test('Umbra expiry means the end of the next target turn, including when applied during that target turn', () => {
  const { target } = fixture('umbra-ferrox');
  assert.deepEqual(nextTurnExpiry(target), { combatId: 'encounter', combatantId: 'targetCombatant', round: 4 });
  game.combat.turn = 1;
  assert.equal(nextTurnExpiry(target).round, 5, 'A hit during the target turn lasts through its next turn');
  game.combat.turn = 2;
  assert.equal(nextTurnExpiry(target).round, 5);
  game.combat.started = false; assert.equal(nextTurnExpiry(target), null);
  game.combat.started = true; game.combat.turn = null; assert.equal(nextTurnExpiry(target), null);
});

test('Umbra expires after the intended turn, including skips, but never on a rewind or another encounter', () => {
  fixture('umbra-ferrox');
  const expiry = { combatId: 'encounter', combatantId: 'targetCombatant', round: 5 };
  const crossed = (prior, current) => expiryReached(expiry, game.combat, prior, current);
  assert.equal(crossed({ round: 5, turn: 0 }, { round: 5, turn: 1 }), false);
  assert.equal(crossed({ round: 5, turn: 1 }, { round: 5, turn: 2 }), true);
  assert.equal(crossed({ round: 4, turn: 2 }, { round: 6, turn: 0 }), true);
  assert.equal(crossed({ round: 6, turn: 0 }, { round: 5, turn: 2 }), false);
  assert.equal(crossed({ round: 5, turn: 2 }, { round: 5, turn: 1 }), false);
  assert.equal(crossed({ round: 5, turn: 2 }, { round: 5, turn: 2 }), false);
  assert.equal(crossed({ round: 5, turn: 1 }, { round: 5, turn: null }), false);
  game.combat.id = 'other'; assert.equal(crossed({ round: 5, turn: 1 }, { round: 5, turn: 2 }), false);
});

test('Lucius applies confirmed typed leftover damage and rejects invalid amounts or types', async () => {
  const { target, source } = fixture();
  await applyTargetAction(target, 'lucius', { amount: 7, type: 'piercing' }, { source, eventId: 'spill' });
  assert.deepEqual(target.damage[0].damage, [{ value: 7, type: 'piercing' }]);
  for (const amount of [-1, 0, NaN, Infinity, 100001]) {
    await assert.rejects(applyTargetAction(target, 'lucius', { amount, type: 'piercing' }, { source }), /Invalid damage/);
  }
  await assert.rejects(applyTargetAction(target, 'lucius', { amount: 1, type: '__proto__' }, { source }), /damage type/);
  assert.equal(target.damage.length, 1);
});

test('Tigrus recomputes the ability modifier and caps damage increases while retaining reductions', async () => {
  const { target, source, attacker } = fixture('tigrus');
  const data = { amount: 999, type: 'fire', activityId: 'attack' };
  target.multiplier = 2;
  await applyTargetAction(target, 'tigrus', data, { source });
  assert.deepEqual(target.damage[0], { damage: [{ value: 3, type: 'slashing' }], options: { ignore: true } });
  target.multiplier = 0.5;
  await applyTargetAction(target, 'tigrus', data, { source });
  assert.equal(target.damage[1].damage[0].value, 1);
  target.multiplier = 0;
  await applyTargetAction(target, 'tigrus', data, { source });
  assert.equal(target.damage[2].damage[0].value, 0);
  target.multiplier = 1; attacker.system.abilities.str.mod = -2;
  await applyTargetAction(target, 'tigrus', data, { source });
  assert.equal(target.damage[3].damage[0].value, 0);
  await assert.rejects(applyTargetAction(target, 'tigrus', { activityId: 'missing' }, { source }), /weapon attack/);
});

test('a cancelled Tigrus calculation leaves damage and the event ledger untouched', async () => {
  const { target, source } = fixture('tigrus'); target.cancelDamage = true;
  assert.equal(await applyTargetAction(target, 'tigrus', { activityId: 'attack' }, { source, eventId: 'cancelled' }), false);
  assert.equal(target.damage.length, 0);
  assert.equal(target.getFlag(MODULE_ID, 'resolvedActions'), undefined);
});

test('Magnacore offers prone or fire damage and leaves cancelled requests unresolved', async () => {
  const { target, source, state } = fixture('magnacore');
  state.choices.push('prone');
  await applyTargetAction(target, 'magnacore', {}, { source, eventId: 'prone' });
  assert.deepEqual(target.conditions, [{ status: 'prone', options: { active: true } }]);
  assert.equal(target.damage.length, 0);
  state.choices.push('damage');
  await applyTargetAction(target, 'magnacore', {}, { source, eventId: 'fire' });
  assert.deepEqual(target.damage[0].damage, [{ value: 4, type: 'fire' }]);
  assert.equal(state.rolls[0].formula, '1d6');
  state.choices.push('cancel');
  assert.equal(await applyTargetAction(target, 'magnacore', {}, { source, eventId: 'cancel' }), false);
  assert.deepEqual(target.getFlag(MODULE_ID, 'resolvedActions'), ['prone', 'fire']);
});

test('Magnacore rechecks target ownership after the response dialog', async () => {
  const { target, source } = fixture('magnacore');
  foundry.applications.api.DialogV2.wait = async () => { target.isOwner = false; return 'prone'; };
  await assert.rejects(applyTargetAction(target, 'magnacore', {}, { source, eventId: 'lost-owner' }), /owner or GM/);
  assert.equal(target.conditions.length, 0);
  assert.equal(target.getFlag(MODULE_ID, 'resolvedActions'), undefined);
});

test('Magnacore removes the prone choice for prone-immune targets and rejects a stale prone response', async () => {
  const { target, source, state } = fixture('magnacore');
  target.system.traits = { ci: { value: new Set(['prone']) } };
  state.choices.push('damage');
  await applyTargetAction(target, 'magnacore', {}, { source, eventId: 'immune-prone' });
  assert.ok(!state.dialogs[0].buttons.some(button => button.action === 'prone'));
  assert.equal(target.conditions.length, 0);
  assert.equal(target.damage.length, 1);
  state.choices.push('prone');
  await assert.rejects(applyTargetAction(target, 'magnacore', {}, { source }), /immune to prone/);
});

test('Umbra stores its own blinded effect and removes only that effect after the next turn', async () => {
  const { target, source, state } = fixture('umbra-ferrox'); game.combat.turn = 1;
  target.effects.push({ id: 'other', flags: { other: { kind: 'blind' } } });
  await applyTargetAction(target, 'umbra-ferrox', {}, { source, eventId: 'blind' });
  const effect = target.effects.find(entry => entry.id !== 'other');
  assert.deepEqual(effect.statuses, ['blinded']);
  assert.equal(effect.origin, source.uuid);
  assert.equal(effect.flags[MODULE_ID].expiry.round, 5);
  registerTargetActions();
  state.hooks.get('combatTurnChange')(game.combat, { round: 4, turn: 1 }, { round: 4, turn: 2 });
  await nextTick(); assert.equal(target.deletions.length, 0);
  state.hooks.get('combatTurnChange')(game.combat, { round: 5, turn: 1 }, { round: 5, turn: 2 });
  await nextTick(); assert.deepEqual(target.deletions, [{ type: 'ActiveEffect', ids: [effect.id] }]);
  assert.deepEqual(target.effects.map(entry => entry.id), ['other']);
});

test('Umbra respects blinded immunity, announces no effect, and resolves the event once', async () => {
  const { target, source, state } = fixture('umbra-ferrox');
  target.system.traits = { ci: { value: new Set(['blinded']) } };
  assert.equal(await applyTargetAction(target, 'umbra-ferrox', {}, { source, eventId: 'immune-blind' }), true);
  assert.equal(target.effects.length, 0);
  assert.match(state.messages[0].content, /immune to blinded/);
  assert.equal(await applyTargetAction(target, 'umbra-ferrox', {}, { source, eventId: 'immune-blind' }), false);
  assert.equal(state.messages.length, 1);
});

test('concurrent target actions apply each event once and preserve both ledger entries', async () => {
  const { target, source } = fixture();
  const apply = eventId => applyTargetAction(target, 'lucius', { amount: 1, type: 'piercing' }, { source, eventId });
  const results = await Promise.all([apply('one'), apply('one'), apply('two')]);
  assert.deepEqual(results, [true, false, true]);
  assert.equal(target.damage.length, 2);
  assert.deepEqual(target.getFlag(MODULE_ID, 'resolvedActions'), ['one', 'two']);
  await target.setFlag(MODULE_ID, 'resolvedActions', Array.from({ length: 100 }, (_, i) => `old-${i}`));
  await apply('new');
  const events = target.getFlag(MODULE_ID, 'resolvedActions');
  assert.equal(events.length, 100); assert.equal(events.at(-1), 'new');
});

test('double-click resolution locks before UUID reads and remains deduplicated without message ownership', async () => {
  const { target, message } = fixture(), request = message(); request.isOwner = false;
  await Promise.all([resolveRequest(request), resolveRequest(request)]);
  await resolveRequest(request);
  assert.equal(target.damage.length, 1);
  assert.equal(request.getFlag(MODULE_ID, 'resolved'), false);
  assert.deepEqual(target.getFlag(MODULE_ID, 'resolvedActions'), [request.uuid]);
});

test('resolution requires an editable actual actor and a matching embedded weapon pattern', async () => {
  const { target, source, message, state } = fixture(), request = message();
  target.isOwner = false;
  await assert.rejects(resolveRequest(request), /owner or GM/);
  target.isOwner = true;
  state.documents.set(target.uuid, { documentName: 'Item', isOwner: true });
  await assert.rejects(resolveRequest(request), /creature actor/);
  state.documents.set(target.uuid, target);
  source.flags[MODULE_ID].pattern = 'imperial';
  await assert.rejects(resolveRequest(request), /matching pattern/);
  source.flags[MODULE_ID].pattern = 'lucius'; source.actor.items.delete(source.id);
  await assert.rejects(resolveRequest(request), /matching pattern/);
  assert.equal(target.damage.length, 0);
});

test('only the active GM resolves requests while connected; an owner can resolve when there is no GM', async () => {
  const { target, message, player } = fixture(), request = message();
  game.user = player;
  await assert.rejects(resolveRequest(request), /active GM/);
  delete game.users.activeGM;
  await resolveRequest(request);
  assert.equal(target.damage.length, 1);
  assert.equal(request.getFlag(MODULE_ID, 'resolved'), true);
});

test('Tigrus menu records the selected attack and asks for fixed damage without applying it immediately', async () => {
  const { source, target, state } = fixture('tigrus');
  await openTargetAction(source);
  const button = state.dialogs[0].buttons.find(entry => entry.action === 'request');
  await button.callback({}, { form: { elements: { namedItem: () => ({ value: 'attack' }) } } });
  const request = state.messages[0].flags[MODULE_ID].request;
  assert.equal(request.data.activityId, 'attack');
  assert.equal(request.data.amount, 3);
  assert.equal(request.targetUuid, target.uuid);
  assert.equal(target.damage.length, 0);
  assert.match(state.messages[0].content, /cannot increase/);
});

function criticalMessage(targets) {
  return { id: 'critical', uuid: 'ChatMessage.critical', rolls: [{ isCritical: true }],
    flags: { dnd5e: { roll: { type: 'attack' }, targets } },
    getFlag(scope, key) { return read(this.flags[scope], key); } };
}
const selectedForm = (...indexes) => ({ querySelectorAll: () => indexes.map(index => ({ value: String(index) })) });

test('critical confirmation resolves actual Actor UUID descriptors and shares event IDs with automatic damage', async () => {
  const { target, armor, state } = fixture(), worn = armor();
  const message = criticalMessage([{ uuid: target.uuid }, { uuid: target.uuid }, { uuid: worn.uuid }]);
  game.user.targets.clear();
  await confirmCriticalArmor(message);
  const dialog = state.dialogs[0];
  assert.equal((dialog.content.match(/name="target"/g) ?? []).length, 1);
  assert.match(dialog.content, /Phobos reroll first/);
  await dialog.buttons[0].callback({}, { form: selectedForm(0) });
  assert.equal(armorDamageState(worn).stacks, 1);
  await damageArmor(worn, { stacking: true, eventId: criticalEventId(message, target) });
  assert.equal(armorDamageState(worn).stacks, 1, 'Manual and automatic paths must share one critical-event identity');
});

test('critical confirmation rejects armor changes, disabled rules, and invalid selections before writing', async () => {
  const { target, armor, state } = fixture(), original = armor();
  await confirmCriticalArmor(criticalMessage([{ uuid: target.uuid }]));
  const apply = values => state.dialogs[0].buttons[0].callback({}, { form: selectedForm(...values) });
  await assert.rejects(apply([]), /Select a listed/);
  await assert.rejects(apply([99]), /Select a listed/);
  const replacement = armor(target, 'replacement'); original.system.equipped = false;
  await assert.rejects(apply([0]), /armor changed/);
  state.config.armorDegradation = false;
  await assert.rejects(apply([0]), /disabled/);
  assert.equal(original.updates.length, 0); assert.equal(replacement.updates.length, 0);
});

test('non-critical and non-attack cards cannot open the armor confirmation', async () => {
  const { target, armor, state } = fixture(); armor();
  const message = criticalMessage([{ uuid: target.uuid }]);
  message.rolls[0].isCritical = false; await confirmCriticalArmor(message);
  message.rolls[0].isCritical = true; message.flags.dnd5e.roll.type = 'damage'; await confirmCriticalArmor(message);
  assert.equal(state.dialogs.length, 0);
});

test('Phobos misses cannot confirm armor damage, including a reroll while the confirmation is open', async () => {
  const { target, armor, state } = fixture(), worn = armor();
  const message = criticalMessage([{ uuid: target.uuid }]);
  await confirmCriticalArmor(message);
  message.flags[MODULE_ID] = { phobos: { missed: true } };
  await assert.rejects(state.dialogs[0].buttons[0].callback({}, { form: selectedForm(0) }), /Phobos made this attack miss/);
  await assert.rejects(confirmCriticalArmor(message), /Phobos made this attack miss/);
  assert.equal(worn.updates.length, 0);
});

test('Midi critical cards offer manual confirmation for their hit tokens with a shared event identity', async () => {
  const { target, armor, state, source } = fixture(), worn = armor();
  game.modules.set('midi-qol', { active: true, version: '14.0.9' });
  const token = { documentName: 'Token', uuid: 'Scene.scene.Token.target', actor: target };
  state.documents.set(token.uuid, token);
  const message = criticalMessage([]);
  message.flags.dnd5e.roll.type = 'midi'; message.rolls = [];
  message.flags['midi-qol'] = { isCritical: true, hitTargetUuids: [token.uuid] };
  message.getAssociatedActivity = () => ({ type: 'attack', item: source });
  game.user.targets.clear();
  await confirmCriticalArmor(message);
  await state.dialogs[0].buttons[0].callback({}, { form: selectedForm(0) });
  assert.deepEqual(armorDamageState(worn).events, [`${message.uuid}:${target.uuid}`]);
});
