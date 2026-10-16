import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_ID } from '../scripts/rules.js';
import {
  workbenchListeners, openWeaponTools, openArmorTools, maintainWeapon, openPatternActions, configureAttackConditions
} from '../scripts/workbench.js';

class Items extends Map {
  [Symbol.iterator]() { return this.values(); }
  get contents() { return [...this.values()]; }
}
function fixture() {
  const dialogs = [], responses = [], chats = [], warnings = [], infos = [];
  const config = { weaponToolsUuid: 'Item.weaponTools', armorToolsUuid: 'Item.armorTools', repairRequiresProficiency: true };
  const limits = { weaponTypes: {} };
  class DialogV2 {
    static async wait(options) {
      dialogs.push(options);
      const response = responses.shift();
      return typeof response === 'function' ? response(options) : response;
    }
  }
  globalThis.foundry = { applications: { api: { DialogV2 } } };
  globalThis.game = { modules: new Map([['the-horses-equipment-limits', { active: true }]]),
    settings: { get: module => module === MODULE_ID ? config : limits } };
  globalThis.CONFIG = { DND5E: { weaponTypeMap: {} } };
  globalThis.CONST = { ACTIVE_EFFECT_MODES: { MULTIPLY: 1, ADD: 2, OVERRIDE: 5 } };
  globalThis.ui = { notifications: { warn: value => warnings.push(value), info: value => infos.push(value) } };
  globalThis.ChatMessage = { getSpeaker: ({ actor }) => ({ actor: actor.id }), create: async data => chats.push(data) };
  const actor = { id: 'actor', uuid: 'Actor.actor', name: 'Example', isOwner: true, items: new Items(),
    damage: [], batches: [],
    async applyDamage(points) { this.damage.push(structuredClone(points)); },
    async updateEmbeddedDocuments(type, updates) {
      this.batches.push(structuredClone(updates));
      return Promise.all(updates.map(update => this.items.get(update._id).update(update)));
    }
  };
  function item(id, type = 'weapon', typeValue = 'martialM', flags = {}) {
    const document = { id, uuid: `${actor.uuid}.Item.${id}`, name: id, type, actor, parent: actor, isOwner: true,
      system: { type: { value: typeValue }, quantity: 1, activities: [] }, flags: { [MODULE_ID]: { ...flags } },
      effects: [], updates: [],
      toObject() { return { effects: structuredClone(this.effects) }; },
      async update(update) {
        this.updates.push(structuredClone(update));
        for (const [path, value] of Object.entries(update)) {
          if (path === '_id') continue;
          const keys = path.split('.'), last = keys.pop();
          const target = keys.reduce((current, key) => current[key] ??= {}, this);
          target[last] = structuredClone(value);
        }
        return this;
      }
    };
    actor.items.set(id, document);
    return document;
  }
  const weaponTool = item('weaponsTool', 'tool');
  weaponTool.system.proficiencyMultiplier = 1;
  weaponTool._stats = { duplicateSource: config.weaponToolsUuid };
  const armorTool = item('armorTool', 'tool');
  armorTool.system.proficiencyMultiplier = 1;
  armorTool._stats = { duplicateSource: config.armorToolsUuid };
  return { actor, item, weaponTool, armorTool, config, limits, dialogs, responses, chats, warnings, infos };
}
const fields = values => ({ elements: { namedItem: name => typeof values[name] === 'object' ? values[name] : { value: values[name] } } });
const callback = (dialog, action, form) => dialog.buttons.find(button => button.action === action).callback(null, { form });
function element() {
  const nodes = new Map();
  for (const key of ['[name=weapon]', '[name=pattern]', '[data-current-pattern]', '[data-pattern-preview]', '.hwa-weapon-drop']) {
    nodes.set(key, { value: '', innerHTML: '', listeners: new Map(),
      addEventListener(name, listener) { this.listeners.set(name, listener); } });
  }
  return { querySelector: selector => nodes.get(selector) };
}
const drop = (dom, data) => dom.querySelector('.hwa-weapon-drop').listeners.get('drop')({
  preventDefault() {}, stopPropagation() {}, dataTransfer: { getData: () => typeof data === 'string' ? data : JSON.stringify(data) }
});

test('workbench dropdown and own-inventory drops detect weapon groups and show current and available patterns', () => {
  const { actor, item, warnings } = fixture();
  const melee = item('Blade', 'weapon', 'martialM', { pattern: 'sunfury' });
  const ranged = item('<Bow>', 'weapon', 'martialR');
  const dom = element();
  workbenchListeners(dom, actor);
  assert.match(dom.querySelector('[data-current-pattern]').innerHTML, /Choose or drop/);
  dom.querySelector('[name=weapon]').value = melee.id;
  dom.querySelector('[name=weapon]').listeners.get('change')();
  assert.equal(dom.querySelector('[name=pattern]').value, 'sunfury');
  assert.match(dom.querySelector('[data-current-pattern]').innerHTML, /Sunfury/);
  assert.doesNotMatch(dom.querySelector('[name=pattern]').innerHTML, /noctis/);
  drop(dom, { type: 'Item', uuid: ranged.uuid });
  assert.equal(dom.querySelector('[name=weapon]').value, ranged.id);
  assert.match(dom.querySelector('[name=pattern]').innerHTML, /noctis/);
  assert.match(dom.querySelector('[data-current-pattern]').innerHTML, /&lt;Bow&gt;/);
  assert.deepEqual(warnings, []);
});

test('foreign, malformed, and non-weapon drops never change the selected inventory weapon', () => {
  const { actor, item, warnings } = fixture();
  const blade = item('Blade'), armor = item('Armor', 'equipment', 'heavy');
  const dom = element();
  dom.querySelector('[name=weapon]').value = blade.id;
  workbenchListeners(dom, actor);
  drop(dom, { type: 'Item', uuid: 'Actor.foreign.Item.Blade' });
  drop(dom, { type: 'Item', uuid: armor.uuid });
  drop(dom, '{invalid');
  assert.equal(dom.querySelector('[name=weapon]').value, blade.id);
  assert.equal(warnings.length, 3);
});

test('changing category assignments while a workbench is open leaves an unavailable weapon unselected', () => {
  const { actor, item, limits } = fixture();
  const blade = item('Blade', 'weapon', 'custom');
  limits.weaponTypes.custom = 'melee';
  const dom = element(); dom.querySelector('[name=weapon]').value = blade.id;
  workbenchListeners(dom, actor);
  limits.weaponTypes.custom = 'ignore';
  assert.doesNotThrow(() => dom.querySelector('[name=weapon]').listeners.get('change')());
  assert.equal(dom.querySelector('[name=pattern]').innerHTML, '');
});

test('Weapon Tools refuses non-proficient use and exposes maintenance even when Imperial removed pattern actions', async () => {
  const { item, weaponTool, dialogs } = fixture();
  item('Blade', 'weapon', 'martialM', { pattern: 'imperial', jammed: true });
  weaponTool.system.proficiencyMultiplier = 0;
  assert.throws(() => openWeaponTools(weaponTool), /proficiency/);
  weaponTool.system.proficiencyMultiplier = 1;
  await openWeaponTools(weaponTool);
  assert.ok(dialogs[0].buttons.some(button => button.action === 'repair'));
  assert.match(dialogs[0].content, /Changing patterns does not repair/);
});

test('armor repair needs explicit hour confirmation and repairs all selected stacks only after confirmation', async () => {
  const { actor, item, armorTool, dialogs, responses, chats } = fixture();
  const suit = item('Suit', 'equipment', 'heavy', { damageStacks: 4 });
  await openArmorTools(armorTool);
  assert.match(dialogs[0].content, /one hour/);
  const form = { querySelectorAll: () => [{ value: suit.id }] };
  responses.push('cancel');
  await callback(dialogs[0], 'repair', form);
  assert.equal(actor.batches.length, 0);
  assert.equal(suit.flags[MODULE_ID].damageStacks, 4);
  responses.push('yes');
  await callback(dialogs[0], 'repair', form);
  assert.equal(actor.batches.length, 1);
  assert.equal(suit.flags[MODULE_ID].damageStacks, 0);
  assert.match(chats[0].content, /one hour/);
});

test('armor repair rechecks tool proficiency after the hour confirmation and before any item write', async () => {
  const { actor, item, armorTool, dialogs, responses } = fixture();
  const suit = item('Suit', 'equipment', 'heavy', { damageStacks: 2 });
  await openArmorTools(armorTool);
  responses.push(() => { armorTool.system.proficiencyMultiplier = 0; return 'yes'; });
  await assert.rejects(callback(dialogs[0], 'repair', { querySelectorAll: () => [{ value: suit.id }] }), /proficiency/);
  assert.equal(actor.batches.length, 0);
  assert.equal(suit.flags[MODULE_ID].damageStacks, 2);
});

test('armor repair proficiency option permits an untrained tool user when the GM disables the requirement', async () => {
  const { item, armorTool, config, dialogs, responses } = fixture();
  const suit = item('Suit', 'equipment', 'heavy', { damageStacks: 1 });
  armorTool.system.proficiencyMultiplier = 0;
  config.repairRequiresProficiency = false;
  await openArmorTools(armorTool);
  responses.push('yes');
  await callback(dialogs[0], 'repair', { querySelectorAll: () => [{ value: suit.id }] });
  assert.equal(suit.flags[MODULE_ID].damageStacks, 0);
});

test('weapon maintenance honors action/time cancellation and rechecks repair proficiency after waiting', async () => {
  const { item, weaponTool, responses, chats } = fixture();
  const weapon = item('Blade', 'weapon', 'martialM', { pattern: 'imperial', jammed: true });
  responses.push('cancel'); await maintainWeapon(weapon);
  assert.equal(weapon.flags[MODULE_ID].jammed, true);
  responses.push('maintain'); await maintainWeapon(weapon);
  assert.equal(weapon.flags[MODULE_ID].jammed, false);
  assert.match(chats[0].content, /spent an action/);
  weapon.flags[MODULE_ID].mercurianDamaged = true;
  responses.push(() => { weaponTool.system.proficiencyMultiplier = 0; return 'repair'; });
  await assert.rejects(maintainWeapon(weapon, weaponTool), /proficiency/);
  assert.equal(weapon.flags[MODULE_ID].mercurianDamaged, true);
  weaponTool.system.proficiencyMultiplier = 1;
  responses.push('repair'); await maintainWeapon(weapon, weaponTool);
  assert.equal(weapon.flags[MODULE_ID].mercurianDamaged, false);
  assert.match(chats.at(-1).content, /10 minutes/);
});

test('Mars charges one necrotic point per explicitly confirmed Attack action, never for menu opening', async () => {
  const { actor, item, responses, dialogs } = fixture();
  const weapon = item('Rifle', 'weapon', 'martialR', { pattern: 'mars' });
  responses.push('close'); await openPatternActions(weapon);
  assert.equal(actor.damage.length, 0);
  responses.push('mars', 'cancel'); await openPatternActions(weapon);
  assert.equal(actor.damage.length, 0);
  responses.push('mars', 'begin'); await openPatternActions(weapon);
  assert.deepEqual(actor.damage, [[{ value: 1, type: 'necrotic' }]]);
  assert.match(dialogs.at(-1).content, /once for the whole action/);
  responses.push('mars', 'begin'); await openPatternActions(weapon);
  assert.equal(actor.damage.length, 2);
});

test('blocked maintenance does not announce success and stale pattern activities report a clear category error', async () => {
  const { item, responses, chats } = fixture();
  const weapon = item('Blade', 'weapon', 'martialM', { pattern: 'kantreal', jammed: true });
  weapon.update = async () => undefined;
  responses.push('maintain');
  await assert.rejects(maintainWeapon(weapon), /blocked/);
  assert.equal(chats.length, 0);
  weapon.system.type.value = 'customUnclassified';
  await assert.rejects(openPatternActions(weapon), /melee or ranged category/);
});

test('next-attack conditions reject invalid burst sizes and store only validated one-roll settings', async () => {
  const { item, dialogs } = fixture();
  const weapon = item('Rifle', 'weapon', 'martialR', { pattern: 'triplex' });
  await configureAttackConditions(weapon);
  const conditionForm = count => fields({ burstCount: count, longRange: { checked: true },
    underwater: { checked: false }, nearby: { checked: true } });
  for (const invalid of ['0', '21', '1.5', 'NaN'])
    await assert.rejects(callback(dialogs[0], 'save', conditionForm(invalid)), /1 to 20/);
  assert.equal(weapon.updates.length, 0);
  await callback(dialogs[0], 'save', conditionForm('3'));
  assert.deepEqual(weapon.flags[MODULE_ID].nextAttack,
    { longRange: true, underwater: false, nearby: true, burstCount: 3 });
  weapon.isOwner = false;
  await assert.rejects(callback(dialogs[0], 'save', conditionForm('1')), /own/);
});
