import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_ID } from '../scripts/rules.js';
import { armorDamageState } from '../scripts/armor.js';
import { afterDamage, registerCombat } from '../scripts/combat.js';
import { midiEnabled, midiCard, midiHit, midiAttack, midiContext, midiDamageContext } from '../scripts/midi-context.js';
import { registerMidi, prepareMidiDamage, finishMidiDamage, finishMidiWorkflow, consumeMidiCritical } from '../scripts/midi.js';

function setPath(object, path, value) {
  const parts = path.split('.');
  let target = object;
  for (const part of parts.slice(0, -1)) target = target[part] ??= {};
  target[parts.at(-1)] = structuredClone(value);
}

function collection(entries = []) {
  const result = new Map(entries);
  Object.defineProperty(result, 'contents', { get() { return [...this.values()]; } });
  result.find = predicate => result.contents.find(predicate);
  return result;
}

/** Token UUIDs, source documents and damage options match Midi-QOL 14.0.9. */
function fixture({ pattern = 'imperial', version = '14.0.9', active = true } = {}) {
  const state = { config: { armorDegradation: true, stackArmorDamage: true }, warnings: [], messages: [], hooks: new Map(), documents: new Map() };
  const gm = { id: 'gm', isGM: true, active: true };
  const player = { id: 'player', isGM: false, active: true };
  const users = [gm, player];
  users.activeGM = gm;
  globalThis.game = { modules: new Map([['midi-qol', { active, version }]]), settings: { get: () => state.config },
    user: gm, users, messages: new Map() };
  globalThis.ui = { notifications: { warn: message => state.warnings.push(message) } };
  globalThis.Hooks = { on(name, callback) { state.hooks.set(name, callback); return state.hooks.size; }, off() {} };
  globalThis.libWrapper = { register() {} };
  globalThis.foundry = { utils: { randomID: () => 'effectidentifier' } };
  globalThis.ChatMessage = { create: async message => state.messages.push(message), getSpeaker: ({ actor }) => ({ actor: actor?.id }) };
  globalThis.fromUuidSync = uuid => state.documents.get(uuid);
  globalThis.fromUuid = async uuid => state.documents.get(uuid);
  function actor(id, { type = 'character', playerOwned = true } = {}) {
    const result = { id, uuid: `Actor.${id}`, name: id, type, hasPlayerOwner: playerOwned, isOwner: true,
      items: collection(), statuses: new Set(), system: { attributes: { hp: { value: 20, temp: 0 }, ac: {} } },
      testUserPermission(user) { return user?.isGM || user?.id === player.id; },
      async toggleStatusEffect(status, { active }) { if (active) this.statuses.add(status); else this.statuses.delete(status); } };
    state.documents.set(result.uuid, result);
    return result;
  }
  const source = actor('attacker'), target = actor('defender');
  function armor(id = 'armor', owner = target, equipped = true) {
    const item = { id, uuid: `${owner.uuid}.Item.${id}`, name: id, actor: owner, parent: owner, type: 'equipment', isOwner: true,
      flags: {}, effects: [], updates: [], system: { type: { value: 'medium' }, equipped, quantity: 1, armor: { value: 14 } },
      toObject() { return { effects: structuredClone(this.effects) }; },
      async update(update) { this.updates.push(structuredClone(update)); for (const [key, value] of Object.entries(update)) setPath(this, key, value); return this; } };
    owner.items.set(item.id, item); state.documents.set(item.uuid, item); return item;
  }
  const worn = armor(), spare = armor('spare', target, false);
  const item = { id: 'weapon', uuid: `${source.uuid}.Item.weapon`, actor: source, parent: source, type: 'weapon', isOwner: true,
    flags: { [MODULE_ID]: { pattern } }, system: { activities: collection() } };
  const activity = { id: 'attack', uuid: `${item.uuid}.Activity.attack`, type: 'attack', hasAttack: true, item, actor: source };
  item.system.activities.set(activity.id, activity); source.items.set(item.id, item);
  state.documents.set(item.uuid, item); state.documents.set(activity.uuid, activity);
  const tokenDocument = { uuid: 'Scene.encounter.Token.defender', documentName: 'Token', actor: target };
  const token = { document: tokenDocument, actor: target };
  tokenDocument.object = token; state.documents.set(tokenDocument.uuid, tokenDocument);
  const card = { id: 'attackcard', uuid: 'ChatMessage.attackcard', documentName: 'ChatMessage', isOwner: true, author: player,
    flags: { dnd5e: { item: { uuid: item.uuid } }, 'midi-qol': { isCritical: true, isFumble: false, hitTargetUuids: [tokenDocument.uuid] } },
    updates: [], getAssociatedActivity: () => activity,
    async update(update) { this.updates.push(structuredClone(update)); for (const [key, value] of Object.entries(update)) setPath(this, key, value); return this; },
    async setFlag(scope, key, value) { return this.update({ [`flags.${scope}.${key}`]: value }); } };
  state.documents.set(card.uuid, card); game.messages.set(card.id, card);
  const workflow = { item, activity, attackRoll: { total: 24 }, itemCardUuid: card.uuid, isCritical: true,
    hitTargets: new Set([token]), hitTargetsEC: new Set(), targets: new Set([token]),
    damageRolls: [{ total: 6 }], otherDamageRolls: [{ total: 3 }], bonusDamageRolls: [{ total: 2 }],
    async setDamageRolls(rolls) { this.damageRolls = rolls; },
    async setOtherDamageRolls(rolls) { this.otherDamageRolls = rolls; },
    async setBonusDamageRolls(rolls) { this.bonusDamageRolls = rolls; } };
  function damageItem() {
    return { actorUuid: target.uuid, targetUuid: tokenDocument.uuid, isHit: true, wasHit: true, critical: true,
      oldHP: 20, newHP: 14, oldTempHP: 0, newTempHP: 0, hpDamage: 6, tempDamage: 0, totalDamage: 6, rawTotalDamage: 6,
      damageDetail: [{ type: 'piercing', value: 6 }], rawDamageDetail: [{ type: 'piercing', value: 6 }],
      calcDamageOptions: { midi: { isHit: true, isCritical: true, sourceActorUuid: source.uuid, targetUuid: tokenDocument.uuid } } };
  }
  return { state, gm, player, source, target, actor, armor, worn, spare, item, activity, token, tokenDocument, card, workflow, damageItem };
}

test('Midi adapter is optional and rejects unsupported version families without installing hooks', () => {
  for (const options of [{ active: false }, { version: '13.0.54' }, { version: '14.6.1' }, { version: '' }]) {
    const { state, workflow } = fixture(options);
    assert.equal(midiEnabled(), false);
    assert.equal(midiAttack(workflow), false);
    registerMidi();
    assert.equal(state.hooks.size, 0);
    assert.equal(state.warnings.length, options.active === false ? 0 : 1);
  }
  fixture(); game.modules.clear(); assert.equal(midiEnabled(), false);
});

test('supported adapter registers awaited workflow stages and the cross-client card consumer', () => {
  const { state } = fixture();
  registerMidi();
  assert.deepEqual([...state.hooks.keys()], ['midi-qol.preCheckHits', 'midi-qol.DamageRollComplete',
    'midi-qol.preTargetDamageApplication', 'midi-qol.RollComplete', 'updateChatMessage', 'renderChatMessageHTML']);
});

test('card lookup accepts only chat message UUIDs and falls back to the messages collection', () => {
  const { workflow, card, state } = fixture();
  assert.equal(midiCard(workflow), card);
  state.documents.delete(card.uuid);
  assert.equal(midiCard(workflow), card);
  assert.equal(midiCard({ itemCardUuid: 'Actor.attacker' }), null);
  assert.equal(midiCard({}), null);
});

test('workflow attribution requires an active attack, a roll, source actor, and existing card', () => {
  const { workflow, activity, token, tokenDocument } = fixture();
  assert.equal(midiAttack(workflow), true);
  assert.equal(midiHit(workflow, { actor: token.actor, document: { uuid: tokenDocument.uuid } }), true);
  assert.equal(midiHit(workflow, { document: { uuid: 'Scene.other.Token.other' } }), false);
  for (const altered of [{ aborted: true }, { activity: { ...activity, type: 'utility' } }, { attackRoll: null },
    { item: {} }, { itemCardUuid: 'ChatMessage.missing' }]) {
    assert.equal(midiAttack({ ...workflow, ...altered }), false);
    assert.equal(midiContext({ ...workflow, ...altered }, token), null);
  }
});

test('damage attribution survives JSON transport and resolves the same actor, source, and attack', () => {
  const { workflow, token, target, source, item, card, activity, damageItem } = fixture({ pattern: 'mars' });
  const damage = damageItem();
  prepareMidiDamage(token, { workflow, damageItem: damage });
  const received = JSON.parse(JSON.stringify(damage.calcDamageOptions));
  const context = midiDamageContext(target, received);
  assert.equal(context.message, card);
  assert.equal(context.activity, activity);
  assert.equal(context.sourceActorUuid, source.uuid);
  assert.equal(context.itemUuid, item.uuid);
  assert.equal(context.pattern, 'mars');
  assert.equal(context.eventId, `${card.uuid}:${target.uuid}`);
  assert.equal(context.critical, true);
});

test('damage context rejects mismatched target, source, token, hit, miss, and stale inventory documents', () => {
  const { workflow, token, target, source, item, damageItem } = fixture();
  const damage = damageItem(); prepareMidiDamage(token, { workflow, damageItem: damage });
  const original = damage.calcDamageOptions;
  for (const [path, value] of [[`${MODULE_ID}.midi.targetActorUuid`, 'Actor.someoneElse'],
    [`${MODULE_ID}.midi.sourceActorUuid`, 'Actor.someoneElse'], [`${MODULE_ID}.midi.targetUuid`, 'Scene.other.Token.other'],
    [`${MODULE_ID}.midi.hit`, false], [`${MODULE_ID}.midi.missed`, true], [`${MODULE_ID}.midi.version`, 99],
    ['midi.isHit', false], ['midi.sourceActorUuid', 'Actor.someoneElse'], ['midi.targetUuid', 'Scene.other.Token.other']]) {
    const options = structuredClone(original); setPath(options, path, value);
    assert.equal(midiDamageContext(target, options), null, path);
  }
  source.items.delete(item.id);
  assert.equal(midiDamageContext(target, original), null);
});

test('damage context rejects an unrelated source card and an author without source ownership', () => {
  const { workflow, token, target, card, damageItem } = fixture();
  const damage = damageItem(); prepareMidiDamage(token, { workflow, damageItem: damage });
  card.getAssociatedActivity = () => ({ item: { uuid: 'Actor.unrelated.Item.weapon' } });
  assert.equal(midiDamageContext(target, damage.calcDamageOptions), null);
  delete card.getAssociatedActivity;
  card.author = { id: 'stranger', isGM: false };
  assert.equal(midiDamageContext(target, damage.calcDamageOptions), null);
});

test('Phobos cancels every damage pool and all hit targets before application', async () => {
  const { workflow, token, card, state } = fixture({ pattern: 'phobos' });
  workflow[MODULE_ID] = { pattern: 'phobos', weaponUuid: workflow.item.uuid,
    phobos: { missed: true, original: [6], reroll: 1 } };
  workflow.hitTargetsEC.add(token);
  registerMidi();
  await state.hooks.get('midi-qol.DamageRollComplete')(workflow);
  assert.equal(workflow.hitTargets.size, 0);
  assert.equal(workflow.hitTargetsEC.size, 0);
  assert.equal(workflow.isCritical, false);
  assert.deepEqual(workflow.damageRolls, []);
  assert.deepEqual(workflow.otherDamageRolls, []);
  assert.deepEqual(workflow.bonusDamageRolls, []);
  assert.equal(card.flags[MODULE_ID].phobos.missed, true);
});

test('late damage additions cannot survive a Phobos miss or become reapply-card damage', () => {
  const { workflow, token, damageItem } = fixture({ pattern: 'phobos' });
  workflow[MODULE_ID] = { phobos: { missed: true } };
  const damage = damageItem();
  damage.damageDetails = { combinedDamage: [{ type: 'piercing', value: 6 }],
    rawcombinedDamage: [{ type: 'piercing', value: 6 }], otherDamage: [{ type: 'fire', value: 3 }],
    rawotherDamage: [{ type: 'fire', value: 3 }], calcDamageOptions: { combinedDamage: { multiplier: 1 } } };
  prepareMidiDamage(token, { workflow, damageItem: damage });
  assert.equal(damage.isHit, false);
  assert.equal(damage.wasHit, false);
  assert.equal(damage.critical, false);
  assert.equal(damage.calcDamageOptions.midi.isHit, false);
  assert.equal(damage.calcDamageOptions.midi.isCritical, false);
  assert.deepEqual(damage.damageDetail, []);
  assert.deepEqual(damage.rawDamageDetail, []);
  assert.equal(damage.hpDamage + damage.tempDamage + damage.totalDamage + damage.rawTotalDamage, 0);
  assert.equal(damage.newHP, damage.oldHP);
  assert.equal(damage.newTempHP, damage.oldTempHP);
  for (const key of ['combinedDamage', 'rawcombinedDamage', 'otherDamage', 'rawotherDamage']) {
    assert.deepEqual(damage.damageDetails[key], [], key);
  }
  assert.deepEqual(damage.damageDetails.calcDamageOptions, { combinedDamage: { multiplier: 1 } });
});

test('successful Phobos and unrelated damage preserve damage pools while recording conversion evidence', async () => {
  const { workflow, card } = fixture({ pattern: 'sunfury' });
  const rolls = workflow.damageRolls;
  workflow[MODULE_ID] = { pattern: 'sunfury', damageConversion: { original: [{ total: 6 }], type: 'fire' }, privateState: 42 };
  await finishMidiDamage(workflow);
  assert.equal(workflow.damageRolls, rolls);
  assert.equal(workflow.hitTargets.size, 1);
  assert.equal(card.flags[MODULE_ID].damageConversion.type, 'fire');
  assert.equal(card.flags[MODULE_ID].privateState, undefined);
});

test('confirmed critical completion damages one worn armor, including an immune hit with zero HP loss', async () => {
  const { workflow, worn, spare, target } = fixture();
  workflow.damageRolls = []; // Hit remains confirmed even when no HP damage can be applied.
  await finishMidiWorkflow(workflow);
  assert.equal(armorDamageState(worn).stacks, 1);
  assert.equal(armorDamageState(spare).stacks, 0);
  assert.equal(target.system.attributes.hp.value, 20);
  assert.equal(worn.system.armor.value, 14);
});

test('completion flushes delayed Midi hit evidence before authorizing armor damage', async () => {
  const { workflow, card, worn, tokenDocument } = fixture();
  card.flags['midi-qol'].isCritical = false;
  card.flags['midi-qol'].hitTargetUuids = [];
  workflow.performThrottledUpdate = async (message, updates, immediate) => {
    assert.equal(message, card); assert.equal(immediate, true);
    await card.update({ 'flags.midi-qol.isCritical': true,
      'flags.midi-qol.hitTargetUuids': [tokenDocument.uuid], ...updates });
  };
  await finishMidiWorkflow(workflow);
  assert.equal(armorDamageState(worn).stacks, 1);
});

test('Phobos flushes final miss evidence through Midi cache before later card updates', async () => {
  const { workflow, card } = fixture({ pattern: 'phobos' });
  workflow[MODULE_ID] = { phobos: { missed: true } };
  workflow.performThrottledUpdate = async (message, updates, immediate) => {
    assert.equal(immediate, true);
    await message.update(updates);
  };
  await finishMidiDamage(workflow);
  assert.equal(card.flags['midi-qol'].isCritical, false);
  assert.deepEqual(card.flags['midi-qol'].hitTargetUuids, []);
  assert.equal(card.flags[MODULE_ID].phobos.missed, true);
});

test('repeated completion, duplicate target tokens, and damage callbacks share one armor event', async () => {
  const { workflow, token, target, worn, card, damageItem, state } = fixture();
  const duplicateDocument = { uuid: 'Scene.encounter.Token.second', actor: target };
  const duplicate = { document: duplicateDocument, actor: target };
  state.documents.set(duplicateDocument.uuid, duplicateDocument);
  workflow.hitTargets.add(duplicate);
  card.flags['midi-qol'].hitTargetUuids.push(duplicateDocument.uuid);
  const damage = damageItem(); prepareMidiDamage(token, { workflow, damageItem: damage });
  registerCombat();
  const options = JSON.parse(JSON.stringify(damage.calcDamageOptions));
  state.hooks.get('dnd5e.preApplyDamage')(target, 6, { 'system.attributes.hp.value': 14 }, options);
  target.system.attributes.hp.value = 14;
  await afterDamage(target, 6, options);
  await finishMidiWorkflow(workflow);
  await consumeMidiCritical(card);
  await finishMidiWorkflow(workflow);
  assert.equal(worn.updates.length, 1);
  assert.equal(armorDamageState(worn).stacks, 1);
});

test('completion and then damage application also deduplicate in the reverse order', async () => {
  const { workflow, token, target, worn, damageItem, state } = fixture();
  const damage = damageItem(); prepareMidiDamage(token, { workflow, damageItem: damage });
  await finishMidiWorkflow(workflow);
  registerCombat();
  const options = JSON.parse(JSON.stringify(damage.calcDamageOptions));
  state.hooks.get('dnd5e.preApplyDamage')(target, 6, { 'system.attributes.hp.value': 14 }, options);
  target.system.attributes.hp.value = 14;
  await afterDamage(target, 6, options);
  assert.equal(worn.updates.length, 1);
});

test('cross-client completion waits for the elected GM instead of writing from a player client', async () => {
  const { workflow, worn, card, player, gm } = fixture();
  game.user = player;
  await finishMidiWorkflow(workflow);
  assert.equal(worn.updates.length, 0);
  assert.equal(card.flags[MODULE_ID].midiCritical.targets.length, 1);
  game.user = gm;
  await consumeMidiCritical(card);
  assert.equal(worn.updates.length, 1);
});

test('without an active GM only the elected active owner writes armor', async () => {
  const { workflow, worn, card, player } = fixture();
  game.users.activeGM = null;
  game.users[0].active = false;
  game.user = { id: 'observer' };
  await finishMidiWorkflow(workflow);
  assert.equal(worn.updates.length, 0);
  game.user = player;
  await consumeMidiCritical(card);
  assert.equal(worn.updates.length, 1);
});

test('ordinary hits, misses, disabled armor degradation, and Phobos misses do not damage armor', async () => {
  for (const kind of ['ordinary', 'miss', 'disabled', 'phobos']) {
    const { workflow, worn, card, state } = fixture();
    if (kind === 'ordinary') workflow.isCritical = false;
    if (kind === 'miss') workflow.hitTargets.clear();
    if (kind === 'disabled') state.config.armorDegradation = false;
    if (kind === 'phobos') workflow[MODULE_ID] = { phobos: { missed: true } };
    await finishMidiWorkflow(workflow);
    assert.equal(worn.updates.length, 0, kind);
    assert.equal(card.flags[MODULE_ID]?.midiCritical, undefined, kind);
  }
});

test('armor degeneration excludes NPCs and characters without player owners', async () => {
  for (const patch of [{ type: 'npc' }, { hasPlayerOwner: false }]) {
    const { workflow, target, worn } = fixture();
    Object.assign(target, patch);
    await finishMidiWorkflow(workflow);
    assert.equal(worn.updates.length, 0);
  }
});

test('critical request rejects unrelated source, unauthorized author, and mismatched target token', async () => {
  for (const kind of ['source', 'author', 'token', 'card', 'not-critical']) {
    const { workflow, card, worn, player } = fixture();
    game.user = player;
    await finishMidiWorkflow(workflow);
    game.user = game.users.activeGM;
    const event = card.flags[MODULE_ID].midiCritical;
    if (kind === 'source') event.sourceActorUuid = 'Actor.another';
    if (kind === 'author') card.author = { id: 'stranger', isGM: false };
    if (kind === 'token') event.targets[0].tokenUuid = 'Scene.other.Token.other';
    if (kind === 'card') card.getAssociatedActivity = () => ({ item: { uuid: 'Actor.other.Item.other' } });
    if (kind === 'not-critical') card.flags['midi-qol'].isCritical = false;
    await consumeMidiCritical(card);
    assert.equal(worn.updates.length, 0, kind);
  }
});

test('a target token must resolve to the actor named in the critical request', async () => {
  const { workflow, card, worn, source, tokenDocument, player } = fixture();
  game.user = player;
  await finishMidiWorkflow(workflow);
  game.user = game.users.activeGM;
  tokenDocument.actor = source;
  await consumeMidiCritical(card);
  assert.equal(worn.updates.length, 0);
});

test('armor captured before damage remains the recipient if armor changes before workflow completion', async () => {
  const { workflow, token, target, worn, spare, damageItem } = fixture();
  prepareMidiDamage(token, { workflow, damageItem: damageItem() });
  worn.system.equipped = false; spare.system.equipped = true;
  target.system.attributes.ac.equippedArmor = spare;
  await finishMidiWorkflow(workflow);
  assert.equal(worn.updates.length, 1);
  assert.equal(spare.updates.length, 0);
});

test('putting on armor after an unarmored critical hit does not damage the new armor', async () => {
  const { workflow, token, target, worn, spare, damageItem, state } = fixture();
  worn.system.equipped = false;
  const damage = damageItem();
  prepareMidiDamage(token, { workflow, damageItem: damage });
  assert.equal(workflow[MODULE_ID].armors[target.uuid], null);
  assert.equal(damage.calcDamageOptions[MODULE_ID].midi.armorUuid, null);
  spare.system.equipped = true;
  target.system.attributes.ac.equippedArmor = spare;
  registerCombat();
  const options = JSON.parse(JSON.stringify(damage.calcDamageOptions));
  state.hooks.get('dnd5e.preApplyDamage')(target, 6, { 'system.attributes.hp.value': 14 }, options);
  target.system.attributes.hp.value = 14;
  await afterDamage(target, 6, options);
  await finishMidiWorkflow(workflow);
  assert.equal(worn.updates.length, 0);
  assert.equal(spare.updates.length, 0);
});

test('Noctis reports a newly knocked-out NPC for GM resolution without racing Midi death effects', async () => {
  const { workflow, token, target, damageItem, state, worn } = fixture({ pattern: 'noctis' });
  target.type = 'npc'; target.hasPlayerOwner = false;
  const damage = damageItem(); prepareMidiDamage(token, { workflow, damageItem: damage });
  registerCombat();
  const options = JSON.parse(JSON.stringify(damage.calcDamageOptions));
  state.hooks.get('dnd5e.preApplyDamage')(target, 30, { 'system.attributes.hp.value': 0 }, options);
  target.system.attributes.hp.value = 0;
  target.statuses.add('dead');
  await afterDamage(target, 30, options);
  assert.equal(state.messages.length, 1);
  assert.match(state.messages[0].content, /GM must confirm unconscious instead of dead/);
  assert.equal(target.statuses.has('dead'), true);
  assert.equal(worn.updates.length, 0);
});
