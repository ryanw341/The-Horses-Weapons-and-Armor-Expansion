import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTick } from 'node:timers/promises';
import { MODULE_ID } from '../scripts/rules.js';
import { cleanupRuntime } from '../scripts/shared.js';

const lifecycle = new Map();
globalThis.Hooks = { once: (event, callback) => lifecycle.set(event, callback) };
await import('../scripts/main.js');

class Collection extends Map { [Symbol.iterator]() { return this.values(); } }

function descriptor(object, name) {
  for (let current = object; current; current = Object.getPrototypeOf(current)) {
    const found = Object.getOwnPropertyDescriptor(current, name);
    if (found) return found;
  }
}

function fixture() {
  if (typeof globalThis.Hooks?.off === 'function') cleanupRuntime();
  const state = { hooks: new Map(), wrappers: new Map(), registrations: [], errors: [], warnings: [],
    resets: 0, writes: 0, refreshes: 0, getterReads: 0, unregistered: 0 };
  let nextHook = 1;
  globalThis.Hooks = {
    on(name, callback) { const id = nextHook++; state.hooks.set(id, { name, callback }); return id; },
    off(name, id) { const hook = state.hooks.get(id); if (hook?.name === name) state.hooks.delete(id); },
    once(name, callback) { return this.on(name, callback); }, callAll() {}
  };
  class BaseEffect { get isSuppressed() { state.getterReads++; return true; } }
  class Effect extends BaseEffect {}
  class Token { _getVisionSourceData() { return { visionMode: 'darkvision', radius: 300, lightRadius: 2000 }; } }
  class BasicRoll { static async buildEvaluate() {} }
  class DamageRoll extends BasicRoll {}
  class D20Roll {}
  class Actor { async applyDamage() {} }
  globalThis.CONFIG = { ActiveEffect: { documentClass: Effect }, Token: { objectClass: Token },
    Actor: { documentClass: Actor }, Dice: { DamageRoll, D20Roll },
    DND5E: { weaponTypeMap: {} }, Canvas: { visionModes: { basic: { vision: { defaults: { saturation: 0 } } } } } };
  globalThis.libWrapper = {
    register(id, path, callback, kind) {
      assert.equal(id, MODULE_ID);
      const parts = path.split('.'), name = parts.pop();
      const target = parts.reduce((object, key) => object[key], globalThis);
      const source = descriptor(target, name);
      if (!source || (!source.get && typeof source.value !== 'function')) throw new Error(`Missing wrapper target: ${path}`);
      const own = Object.getOwnPropertyDescriptor(target, name);
      if (source.get) Object.defineProperty(target, name, { configurable: true,
        get() { return callback.call(this, source.get.bind(this)); } });
      else Object.defineProperty(target, name, { configurable: true, writable: true,
        value: function(...args) { return callback.call(this, source.value.bind(this), ...args); } });
      const restore = () => { if (own) Object.defineProperty(target, name, own); else delete target[name]; };
      state.wrappers.set(path, restore); state.registrations.push({ path, kind });
      return state.registrations.length;
    },
    unregister_all(id) {
      assert.equal(id, MODULE_ID); state.unregistered++;
      for (const restore of [...state.wrappers.values()].reverse()) restore();
      state.wrappers.clear();
    }
  };
  globalThis.foundry = { applications: { api: { DialogV2: class { static async wait() {} } } } };
  globalThis.canvas = { ready: true, perception: { update() { state.refreshes++; } } };
  globalThis.ui = { notifications: { error: message => state.errors.push(message), warn: message => state.warnings.push(message) } };
  const gm = { id: 'gm', isGM: true, active: true }, users = [gm]; users.activeGM = gm;
  const module = { active: true };
  globalThis.game = { system: { id: 'dnd5e', version: '5.3.3' }, ready: true, user: gm, users,
    modules: new Map([[MODULE_ID, module], ['lib-wrapper', { active: true }]]), actors: [], scenes: [],
    settings: { get: () => ({ weaponToolsUuid: 'Item.sourceTool' }), register() {}, registerMenu() {} } };
  const actor = { documentName: 'Actor', uuid: 'Actor.boot', isOwner: true, items: new Collection(),
    reset() { state.resets++; }, async updateEmbeddedDocuments() { state.writes++; } };
  actor.items.set('weapon', { id: 'weapon', type: 'weapon', flags: { [MODULE_ID]: { pattern: 'umbra-ferrox' } }, system: { equipped: true } });
  actor.items.set('tool', { id: 'tool', type: 'tool', name: 'Tool', uuid: 'Actor.boot.Item.tool',
    _stats: { duplicateSource: 'Item.sourceTool' }, _source: { system: { activities: {} } } });
  game.actors.push(actor);
  return { state, actor, module, Effect, Token };
}

test('startup wraps inherited getters and methods, refreshes existing vision, then syncs tools', async t => {
  t.mock.method(console, 'info', () => {});
  const { state, actor, module, Effect, Token } = fixture();
  await lifecycle.get('ready')();
  await nextTick();
  assert.deepEqual(state.errors, []);
  assert.equal(state.getterReads, 0, 'Capability checks must inspect descriptors rather than invoke instance getters');
  assert.equal(state.wrappers.size, 3);
  assert.equal(state.resets, 1);
  assert.ok(state.refreshes >= 1, 'Already-built vision sources must refresh after wrapping');
  assert.equal(state.writes, 1);
  assert.equal(typeof module.api.openWeaponTools, 'function');
  const effect = new Effect(); effect.parent = actor.items.get('weapon'); effect.flags = { [MODULE_ID]: { kind: 'pattern-worn' } };
  assert.equal(effect.isSuppressed, false);
  const token = new Token(); token.actor = actor;
  assert.deepEqual(token._getVisionSourceData(), { visionMode: 'basic', radius: 0, lightRadius: 2000, saturation: 0 });
});

test('missing vision capability stops startup before wrappers, hooks, resets, or inventory writes', async t => {
  t.mock.method(console, 'error', () => {});
  const { state, module } = fixture();
  delete CONFIG.Token.objectClass.prototype._getVisionSourceData;
  await lifecycle.get('ready')(); await nextTick();
  assert.equal(state.errors.length, 1);
  assert.equal(state.wrappers.size, 0);
  assert.equal(state.hooks.size, 0);
  assert.equal(state.resets, 0);
  assert.equal(state.writes, 0);
  assert.equal(module.api, undefined);
});

test('missing damage capability stops startup before any earlier effect wrappers are installed', async t => {
  t.mock.method(console, 'error', () => {});
  const { state } = fixture();
  CONFIG.Dice.DamageRoll = class {};
  await lifecycle.get('ready')(); await nextTick();
  assert.equal(state.errors.length, 1);
  assert.equal(state.wrappers.size, 0);
  assert.equal(state.hooks.size, 0);
  assert.equal(state.resets, 0);
  assert.equal(state.writes, 0);
});

test('missing libWrapper and unsupported system major produce no runtime mutations', async t => {
  t.mock.method(console, 'error', () => {});
  for (const setup of [() => game.modules.get('lib-wrapper').active = false, () => game.system.version = '6.0.0']) {
    const { state } = fixture(); setup();
    await lifecycle.get('ready')(); await nextTick();
    assert.equal(state.errors.length, 1);
    assert.equal(state.wrappers.size, 0);
    assert.equal(state.hooks.size, 0);
    assert.equal(state.resets, 0);
    assert.equal(state.writes, 0);
  }
});

test('a wrapper registration failure cleans earlier wrappers and event handlers without syncing tools', async t => {
  t.mock.method(console, 'error', () => {});
  const { state, module, Effect } = fixture();
  const register = libWrapper.register;
  libWrapper.register = (...args) => {
    if (args[1] === 'CONFIG.Dice.DamageRoll.buildEvaluate') throw new Error('Simulated wrapper registration conflict');
    return register(...args);
  };
  await lifecycle.get('ready')(); await nextTick();
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0], /registration conflict/);
  assert.equal(state.wrappers.size, 0);
  assert.equal(state.hooks.size, 0);
  assert.equal(state.writes, 0);
  assert.equal(state.unregistered, 1);
  assert.equal(module.api, undefined);
  const effect = new Effect();
  effect.flags = { [MODULE_ID]: { kind: 'pattern-worn' } };
  effect.parent = { type: 'weapon', system: { equipped: true } };
  assert.equal(effect.isSuppressed, true, 'The original inherited getter is restored');
});
