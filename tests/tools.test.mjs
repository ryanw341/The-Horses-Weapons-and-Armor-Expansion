import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { MODULE_ID } from '../scripts/rules.js';
import { defaults, isWriter, inventories, ownedItem } from '../scripts/shared.js';
import { TOOL_ACTIONS, requireTool, utilityActivity, toolActivityUpdates, syncToolActor, registerTools } from '../scripts/tools.js';

class Collection extends Map { [Symbol.iterator]() { return this.values(); } }

function fixture() {
  const state = { config: { ...defaults(), weaponToolsUuid: 'Item.weaponTemplate', armorToolsUuid: 'Item.armorTemplate' },
    warnings: [], calls: [], probes: 0 };
  const gm = { id: 'gm', active: true, isGM: true }, player = { id: 'player', active: true, isGM: false };
  const users = [gm, player]; users.activeGM = gm;
  const callbacks = new Map();
  globalThis.Hooks = { on(name, fn) { const list = callbacks.get(name) ?? []; list.push(fn); callbacks.set(name, list); },
    callAll(name, ...args) { return (callbacks.get(name) ?? []).map(fn => fn(...args)); } };
  globalThis.game = { settings: { get: () => state.config }, users, user: gm, actors: [], scenes: [] };
  globalThis.ui = { notifications: { warn: message => state.warnings.push(message) } };
  const actor = { uuid: 'Actor.toolsOwner', isOwner: true, items: new Collection(), updates: [],
    get documentName() { state.probes++; return 'Actor'; }, testUserPermission: user => user.id === 'player',
    async updateEmbeddedDocuments(type, updates, options) {
      this.updates.push({ type, updates: structuredClone(updates), options: structuredClone(options) });
      for (const update of updates) {
        const item = this.items.get(update._id);
        for (const [path, value] of Object.entries(update)) {
          if (path === '_id') continue;
          const parts = path.split('.'); let target = item._source;
          for (const part of parts.slice(0, -1)) target = target[part] ??= {};
          if (parts.at(-1).startsWith('-=')) delete target[parts.at(-1).slice(2)];
          else target[parts.at(-1)] = structuredClone(value);
        }
        Hooks.callAll('updateItem', item, update, options, game.user.id);
      }
      return updates.map(update => this.items.get(update._id));
    }
  };
  function tool(id, source = 'Item.weaponTemplate') {
    const item = { id, uuid: `${actor.uuid}.Item.${id}`, type: 'tool', name: id,
      actor, parent: actor, isOwner: true, _stats: { duplicateSource: source }, flags: {},
      system: { proficiencyMultiplier: 1 }, _source: { system: { activities: {} } } };
    actor.items.set(id, item); return item;
  }
  game.actors.push(actor);
  return { ...state, state, actor, tool, gm, player, callbacks };
}

test('tool activity creation matches source UUID, preserves native actions, and is idempotent', async () => {
  const { actor, tool } = fixture(), weaponTool = tool('weapon'), armorTool = tool('armor', 'Item.armorTemplate');
  weaponTool._source.system.activities.nativeCheck = { _id: 'nativeCheck', type: 'check', name: 'Normal tool check' };
  await syncToolActor(actor);
  assert.equal(actor.updates.length, 1);
  assert.equal(actor.updates[0].updates.length, 2);
  assert.equal(weaponTool._source.system.activities.nativeCheck.name, 'Normal tool check');
  assert.equal(weaponTool._source.system.activities[TOOL_ACTIONS.weaponTools.id].flags[MODULE_ID].action, 'weaponTools');
  assert.equal(armorTool._source.system.activities[TOOL_ACTIONS.armorTools.id].flags[MODULE_ID].action, 'armorTools');
  await syncToolActor(actor);
  assert.equal(actor.updates.length, 1);
  const imposter = tool('weapon', 'Item.unrelated');
  assert.deepEqual(toolActivityUpdates(imposter), {}, 'Same names do not link a different source item');
});

test('relinking tool settings removes only module-owned actions and preserves ID collisions', () => {
  const { tool, state } = fixture(), item = tool('one');
  const id = TOOL_ACTIONS.weaponTools.id;
  item._source.system.activities[id] = utilityActivity(id, 'Modify', 'weaponTools');
  item._source.system.activities.native = { _id: 'native', name: 'Native' };
  state.config.weaponToolsUuid = 'Item.different';
  assert.deepEqual(toolActivityUpdates(item), { [`system.activities.-=${id}`]: null });
  state.config.weaponToolsUuid = 'Item.weaponTemplate';
  item._source.system.activities[id] = { _id: id, name: 'Someone else\'s action' };
  assert.throws(() => toolActivityUpdates(item), /collision/);
  assert.equal(item._source.system.activities[id].name, 'Someone else\'s action');
  assert.deepEqual(toolActivityUpdates({ type: 'weapon' }), {});
});

test('tool use rechecks ownership, source identity and full proficiency', () => {
  const { actor, tool } = fixture(), item = tool('one');
  assert.equal(requireTool(item, 'weaponTools'), item);
  item.system.proficiencyMultiplier = 0.5;
  assert.throws(() => requireTool(item, 'weaponTools'), /don't have proficiency/);
  assert.equal(requireTool(item, 'weaponTools', { proficiency: false }), item);
  item.system.proficiencyMultiplier = 1;
  assert.throws(() => requireTool(item, 'armorTools'), /not the configured tool/);
  item.isOwner = false;
  assert.throws(() => requireTool(item, 'weaponTools'), /inventory you own/);
  item.isOwner = true; actor.items.delete(item.id);
  assert.throws(() => requireTool(item, 'weaponTools'), /inventory you own/);
});

test('only the elected writer syncs, and world compendium actors are skipped', async () => {
  const { actor, tool, player, gm } = fixture(); tool('one');
  game.user = player;
  assert.equal(isWriter(actor), false);
  await syncToolActor(actor); assert.equal(actor.updates.length, 0);
  delete game.users.activeGM;
  assert.equal(isWriter(actor), true);
  await syncToolActor(actor); assert.equal(actor.updates.length, 1);
  game.user = gm; game.users.activeGM = gm; actor.pack = 'world.actors';
  actor.items.get('one')._source.system.activities = {};
  await syncToolActor(actor); assert.equal(actor.updates.length, 1);
});

test('inventory scanning deduplicates linked actors but retains distinct synthetic token actors', () => {
  const { actor } = fixture();
  const synthetic = { ...actor, uuid: 'Scene.room.Token.unlinked.Actor.toolsOwner' };
  game.scenes.push({ tokens: [{ actor }, { actor: synthetic }, { actor: synthetic }, { actor: null }] });
  assert.deepEqual(inventories(), [actor, synthetic]);
});

test('rapid synchronization requests do not duplicate tool actions', async () => {
  const { actor, tool } = fixture(); tool('one');
  await Promise.all([syncToolActor(actor), syncToolActor(actor), syncToolActor(actor)]);
  assert.equal(actor.updates.length, 1);
});

test('lifecycle handlers honor each actual Foundry hook signature and initialize new actors', async () => {
  const { actor, tool, state } = fixture(), item = tool('one');
  registerTools({}); await syncToolActor(actor);
  state.probes = 0;
  const ownOptions = { [MODULE_ID]: { toolsSync: true } };
  Hooks.callAll('createItem', item, ownOptions, 'gm');
  Hooks.callAll('updateItem', item, {}, ownOptions, 'gm');
  await nextTick();
  assert.equal(state.probes, 0, 'Own create/update hooks must not queue another sync');
  item._source.system.activities = {};
  Hooks.callAll('createItem', item, {}, 'gm');
  await syncToolActor(actor);
  assert.ok(item._source.system.activities[TOOL_ACTIONS.weaponTools.id]);
  item._source.system.activities = {};
  Hooks.callAll('createActor', actor, {}, 'gm');
  await syncToolActor(actor);
  assert.ok(item._source.system.activities[TOOL_ACTIONS.weaponTools.id]);
});

test('module activities open their menu before consumption; ordinary tool actions pass through', async () => {
  const { actor, tool, state } = fixture(), item = tool('one');
  const opened = [];
  registerTools({ openWeaponTools: selected => opened.push(selected), openArmorTools() {}, openPatternActions() {} });
  await syncToolActor(actor);
  const hook = (name, activity) => Hooks.callAll(name, activity)[0];
  assert.equal(hook('dnd5e.preUseActivity', { item, actor, flags: {} }), undefined);
  const activity = { item: { ...item, isOwner: false }, actor, flags: { [MODULE_ID]: { action: 'weaponTools' } } };
  assert.equal(ownedItem(activity), item, 'Activities use the live embedded item, not a rolled clone');
  assert.equal(hook('dnd5e.preUseActivity', activity), false);
  await nextTick();
  assert.deepEqual(opened, [item]);
  assert.equal(state.warnings.length, 0);
});

test('failed proficiency cancels the added action and reports a clear message', async t => {
  t.mock.method(console, 'error', () => {});
  const { actor, tool, state } = fixture(), item = tool('one');
  item.system.proficiencyMultiplier = 0;
  let opened = false;
  registerTools({ openWeaponTools() { opened = true; } }); await syncToolActor(actor);
  const [result] = Hooks.callAll('dnd5e.preUseActivity', { actor, item, flags: { [MODULE_ID]: { action: 'weaponTools' } } });
  assert.equal(result, false);
  await nextTick();
  assert.equal(opened, false);
  assert.match(state.warnings[0], /don't have proficiency/);
});

test('armor repair respects the configurable proficiency exception without weakening weapon tools', async () => {
  const { actor, tool, state } = fixture(), item = tool('armor', 'Item.armorTemplate');
  item.system.proficiencyMultiplier = 0; state.config.repairRequiresProficiency = false;
  const opened = [];
  registerTools({ openArmorTools: selected => opened.push(selected) }); await syncToolActor(actor);
  Hooks.callAll('dnd5e.preUseActivity', { actor, item, flags: { [MODULE_ID]: { action: 'armorTools' } } });
  await nextTick();
  assert.deepEqual(opened, [item]);
});
