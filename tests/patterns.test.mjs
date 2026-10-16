import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_ID, EQUIPMENT_LIMITS_ID } from '../scripts/rules.js';
import { applyPattern, currentPattern, patternState, setTriplexMode, PATTERN_ACTION_ID } from '../scripts/patterns.js';

const setPath = (object, path, value) => {
  const keys = path.split('.'), last = keys.pop();
  const target = keys.reduce((current, key) => current[key] ??= {}, object);
  target[last] = structuredClone(value);
};
const getPath = (object, path) => path.split('.').reduce((current, key) => current?.[key], object);
function prepared(source, effects) {
  const data = structuredClone(source);
  for (const effect of effects) {
    if (effect.type !== 'enchantment' || effect.disabled) continue;
    for (const change of effect.changes ?? []) {
      if (change.key === 'system.properties') {
        data.system.properties = [...new Set([...data.system.properties, change.value])];
        continue;
      }
      const value = change.key.endsWith('.units') ? change.value : Number(change.value);
      setPath(data, change.key, change.mode === 1 ? getPath(data, change.key) * value
        : change.mode === 2 ? getPath(data, change.key) + value : value);
    }
  }
  return data.system;
}
function fixture(type = 'martialR') {
  const config = { weaponToolsUuid: 'Item.weaponTools' }, limits = { weaponTypes: {} };
  globalThis.game = {
    modules: new Map([[EQUIPMENT_LIMITS_ID, { active: true }]]),
    settings: { get: module => module === MODULE_ID ? config : limits }
  };
  globalThis.CONFIG = { DND5E: { weaponTypeMap: {} } };
  globalThis.CONST = { ACTIVE_EFFECT_MODES: { MULTIPLY: 1, ADD: 2, OVERRIDE: 5 } };
  const actor = { uuid: 'Actor.example', items: [] };
  const tool = { type: 'tool', uuid: 'Actor.example.Item.tools', actor, isOwner: true,
    _stats: { duplicateSource: config.weaponToolsUuid }, system: { proficiencyMultiplier: 1 } };
  const source = { system: { type: { value: type }, weight: { value: 8, units: 'lb' },
    range: { value: 80, long: 320, units: 'ft' }, properties: ['hvy'], equipped: true },
  flags: { [MODULE_ID]: {} } };
  const item = {
    type: 'weapon', uuid: 'Actor.example.Item.weapon', actor, parent: actor, isOwner: true,
    _source: source, effects: [], system: { ...structuredClone(source.system), activities: [] },
    flags: source.flags, updates: [], clones: [], blocked: false,
    clone(update) {
      this.clones.push(structuredClone(update));
      return { system: prepared(source, update.effects) };
    },
    async update(update) {
      if (this.blocked) return undefined;
      this.updates.push(structuredClone(update));
      let activities = [...this.system.activities];
      for (const [key, value] of Object.entries(update)) {
        if (key === 'effects') this.effects = structuredClone(value);
        else if (key.startsWith('system.activities.-=')) activities = activities.filter(a => a._id !== key.split('-=')[1]);
        else if (key.startsWith('system.activities.')) {
          const id = key.split('.').at(-1);
          activities = [...activities.filter(a => a._id !== id), structuredClone(value)];
        } else setPath(source, key, value);
      }
      this.system = { ...prepared(source, this.effects), activities };
      this.flags = source.flags;
      return this;
    }
  };
  actor.items.push(tool, item);
  return { item, tool, actor, config, limits, source };
}

test('applying and replacing patterns preserves base fields and unrelated effects', async () => {
  const { item, tool, source } = fixture();
  const unrelated = { _id: 'otherEnchantment', type: 'enchantment', changes: [
    { key: 'system.weight.value', mode: 2, value: '2' }
  ], flags: { other: { preserved: true } } };
  item.effects.push(unrelated);
  const baseline = structuredClone(source.system);
  await applyPattern(item, 'accatran', { tool });
  assert.equal(item.system.weight.value, 5);
  assert.equal(item.effects.length, 2);
  assert.deepEqual(item.effects[0], unrelated);
  assert.equal(item.effects[1].origin, item.actor.uuid);
  assert.equal(item.effects[1].transfer, false);
  assert.equal(item.effects[1].type, 'enchantment');
  assert.equal(item.system.activities[0]._id, PATTERN_ACTION_ID);
  await applyPattern(item, 'kalibrax', { tool });
  assert.equal(item.system.weight.value, 15);
  assert.equal(item.effects.length, 2);
  assert.deepEqual(source.system, baseline);
  assert.equal(currentPattern(item).id, 'kalibrax');
  assert.ok(item.updates.every(update => !Object.keys(update).some(key => key.startsWith('system.weight'))));
});

test('repeat applications do not duplicate effects or actions and Imperial removes only owned additions', async () => {
  const { item } = fixture();
  const unrelated = { _id: 'unrelated', name: 'Other', flags: {} };
  item.effects.push(unrelated);
  item.system.activities.push({ _id: 'otherActivity123', name: 'Existing attack', flags: {} });
  await applyPattern(item, 'accatran');
  await applyPattern(item, 'accatran');
  assert.equal(item.system.weight.value, 4);
  assert.equal(item.effects.length, 2);
  assert.equal(item.system.activities.length, 2);
  item.flags[MODULE_ID].jammed = true;
  item.flags[MODULE_ID].mercurianDamaged = true;
  await applyPattern(item, 'imperial');
  assert.deepEqual(item.effects, [unrelated]);
  assert.equal(item.system.weight.value, 8);
  assert.deepEqual(item.system.activities.map(a => a.name), ['Existing attack']);
  assert.equal(patternState(item).jammed, true);
  assert.equal(patternState(item).mercurianDamaged, true);
});

test('Vortannis includes unrelated range enchantments without repeatedly doubling its own effect', async () => {
  const { item } = fixture();
  item.effects.push({ _id: 'otherRangeEffect', type: 'enchantment', changes: [
    { key: 'system.range.value', mode: 2, value: '20' }
  ] });
  await applyPattern(item, 'vortannis');
  assert.equal(item.system.range.value, 200);
  await applyPattern(item, 'vortannis');
  assert.equal(item.system.range.value, 200);
  assert.ok(item.clones.every(clone => clone.effects.every(effect => effect.flags?.[MODULE_ID]?.kind !== 'pattern')));
  await applyPattern(item, 'imperial');
  assert.equal(item.system.range.value, 100);
});

test('Mercurian properties and ranges reverse without removing existing thrown properties', async () => {
  const { item, source } = fixture('martialM');
  await applyPattern(item, 'mercurian');
  assert.ok(item.system.properties.includes('thr'));
  assert.deepEqual(item.system.range, { value: 30, long: 60, units: 'ft' });
  assert.deepEqual(source.system.properties, ['hvy']);
  await applyPattern(item, 'imperial');
  assert.deepEqual(item.system.properties, ['hvy']);
  source.system.properties.push('thr');
  await applyPattern(item, 'mercurian');
  await applyPattern(item, 'imperial');
  assert.ok(item.system.properties.includes('thr'));
});

test('Tigrus and Umbra-Ferrox use equipped actor effects, not permanent actor mutations', async () => {
  const { item } = fixture('martialM');
  await applyPattern(item, 'tigrus');
  assert.equal(item.effects[0].transfer, true);
  assert.equal(item.effects[0].flags[MODULE_ID].whileEquipped, true);
  assert.equal(item.effects[0].changes[0].key, 'system.attributes.ac.bonus');
  assert.equal(item.effects[0].changes[0].value, '-1');
  await applyPattern(item, 'umbra-ferrox');
  assert.equal(item.effects.length, 1);
  assert.equal(item.effects[0].changes[0].key, 'system.attributes.senses.ranges.darkvision');
  assert.equal(item.effects[0].changes[0].value, '0');
});

test('pattern application rejects missing tools, insufficient proficiency, and foreign or unowned items', async () => {
  const { item, tool, config } = fixture();
  tool.system.proficiencyMultiplier = 0.5;
  await assert.rejects(applyPattern(item, 'accatran', { tool }), /proficiency/);
  tool.system.proficiencyMultiplier = 1;
  await assert.rejects(applyPattern(item, 'accatran', { tool: { ...tool, actor: { uuid: 'Actor.other' } } }), /carry/);
  config.weaponToolsUuid = '';
  await assert.rejects(applyPattern(item, 'accatran'), /link Weapon Tools/);
  config.weaponToolsUuid = 'Item.weaponTools'; item.isOwner = false;
  await assert.rejects(applyPattern(item, 'accatran'), /own/);
  assert.equal(item.updates.length, 0);
});

test('custom weapon assignments control which patterns are available', async () => {
  const { item, limits } = fixture('custom');
  await assert.rejects(applyPattern(item, 'noctis'), /not available/);
  CONFIG.DND5E.weaponTypeMap.custom = 'ranged';
  await applyPattern(item, 'noctis');
  assert.equal(currentPattern(item).id, 'noctis');
  limits.weaponTypes.custom = 'melee';
  await assert.rejects(applyPattern(item, 'noctis'), /not available/);
  await applyPattern(item, 'sunfury');
  limits.weaponTypes.custom = 'ignore';
  await assert.rejects(applyPattern(item, 'sunfury'), /not available/);
});

test('blocked item updates leave the prior pattern and effects intact', async () => {
  const { item } = fixture();
  await applyPattern(item, 'accatran');
  item.blocked = true;
  await assert.rejects(applyPattern(item, 'imperial'), /blocked/);
  assert.equal(currentPattern(item).id, 'accatran');
  assert.equal(item.system.weight.value, 4);
  assert.equal(item.effects.length, 1);
});

test('reserved ID conflicts are rejected instead of overwriting somebody else\'s effect or action', async () => {
  const { item } = fixture();
  item.effects.push({ _id: 'horsePatternItem', flags: { other: {} } });
  await assert.rejects(applyPattern(item, 'accatran'), /reserved pattern ID/);
  item.effects = [];
  item.system.activities.push({ _id: PATTERN_ACTION_ID, flags: { other: {} } });
  await assert.rejects(applyPattern(item, 'accatran'), /reserved pattern activity/);
  assert.equal(item.updates.length, 0);
});

test('Triplex locks only special modes, keeps standard fire available, and rejects other weapons', async () => {
  const { item } = fixture();
  await assert.rejects(setTriplexMode(item, 'burst'), /does not have/);
  await applyPattern(item, 'triplex');
  await setTriplexMode(item, 'energized');
  assert.equal(patternState(item).triplexMode, 'energized');
  item.flags[MODULE_ID].modesLocked = true;
  await assert.rejects(setTriplexMode(item, 'scoped'), /recalibrating/);
  await setTriplexMode(item, 'standard');
  assert.equal(patternState(item).triplexMode, 'standard');
  await assert.rejects(setTriplexMode(item, 'invalid'), /valid/);
  item.flags[MODULE_ID].modesLocked = false; item.blocked = true;
  await assert.rejects(setTriplexMode(item, 'burst'), /blocked/);
});
