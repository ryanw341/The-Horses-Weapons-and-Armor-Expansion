import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_ID } from '../scripts/rules.js';
import { defaults, getConfig } from '../scripts/shared.js';
import { validateTools, toolDropListeners, openSettings, registerSettings } from '../scripts/settings.js';

function fixture() {
  const state = { config: defaults(), resolved: [], registered: new Map(), menus: new Map(), dialogs: [],
    warnings: [], notices: [], saves: [], hooks: [], documents: new Map(), rendered: [], listeners: [] };
  globalThis.game = { user: { isGM: true }, ready: true, items: [], settings: {
    get: () => state.config,
    set: async (scope, key, value) => { state.saves.push(value); state.config = value; },
    register: (scope, key, options) => state.registered.set(key, options),
    registerMenu: (scope, key, options) => state.menus.set(key, options)
  } };
  globalThis.ui = { notifications: { warn: text => state.warnings.push(text), info: text => state.notices.push(text) } };
  globalThis.Hooks = { callAll: name => state.hooks.push(name) };
  globalThis.foundry = { applications: { api: { DialogV2: class {
    constructor(options = {}) {
      // Foundry validates this before SettingsConfig can call render(true).
      if (!options.buttons?.length) throw new Error('You must define at least one entry in config.buttons');
      this.options = options;
      this.buttons = options.buttons.map(button => ({ dataset: { action: button.action }, disabled: false }));
      this.element = { querySelectorAll: selector => selector === '.form-footer button[data-action]' ? this.buttons
        : selector === '[data-tool-field]' ? [{
        querySelector: selector => selector === 'input' ? { value: '' }
          : { addEventListener: name => state.listeners.push(name) },
        addEventListener: name => state.listeners.push(name)
      }] : [] };
    }
    static async wait(options) { const dialog = new this(options); state.dialogs.push(dialog.options); return dialog.options; }
    async render(options) { state.rendered.push(this); await this._onRender({}, options); return this; }
    async _onRender() {}
    async _onSubmit(target, event) {
      event.preventDefault();
      const prior = this.buttons.map(button => [button, button.disabled]);
      for (const button of this.buttons) button.disabled = true;
      const button = this.options.buttons.find(button => button.action === target.dataset.action);
      await button.callback?.(event, target, this);
      // This intentionally matches Foundry 14: no finally on callback failure.
      for (const [button, disabled] of prior) button.disabled = disabled;
      this.closed = true;
      return this;
    }
  } } } };
  globalThis.fromUuid = async uuid => { state.resolved.push(uuid); return state.documents.get(uuid); };
  return state;
}

function form(values = {}) {
  const entries = {
    weaponToolsUuid: { value: '' }, armorToolsUuid: { value: '' }, armorDegradation: { checked: false },
    stackArmorDamage: { checked: false }, repairRequiresProficiency: { checked: true }, kantrealMinimum: { value: '11' }
  };
  for (const [key, value] of Object.entries(values)) Object.assign(entries[key], typeof value === 'boolean' ? { checked: value } : { value });
  return { elements: { namedItem: name => entries[name] } };
}

test('tool settings canonicalize compendium UUIDs and validate both sources before saving', async () => {
  const state = fixture();
  state.documents.set('Compendium.world.tools.Item.weapon', { documentName: 'Item', type: 'tool' });
  state.documents.set('Item.armor', { documentName: 'Item', type: 'tool' });
  const result = await validateTools(form({ weaponToolsUuid: ' Compendium.world.tools.weapon ', armorToolsUuid: 'Item.armor',
    armorDegradation: true, stackArmorDamage: true, kantrealMinimum: '10' }));
  assert.equal(result.weaponToolsUuid, 'Compendium.world.tools.Item.weapon');
  assert.equal(result.armorToolsUuid, 'Item.armor');
  assert.equal(result.armorDegradation, true);
  assert.equal(result.stackArmorDamage, true);
  assert.equal(result.kantrealMinimum, 10);
  assert.equal(state.resolved.length, 2);
  assert.equal(state.saves.length, 0);
  assert.equal(state.config.armorDegradation, false, 'Reading a form cannot mutate saved settings');
});

test('unresolved, wrong-type UUIDs and invalid retry thresholds are rejected', async () => {
  const state = fixture();
  state.documents.set('Item.weapon', { documentName: 'Item', type: 'weapon' });
  await assert.rejects(validateTools(form({ weaponToolsUuid: 'Item.weapon' })), /accessible Tool/);
  await assert.rejects(validateTools(form({ armorToolsUuid: 'Item.missing' })), /Armor Tools/);
  await assert.rejects(validateTools(form({ kantrealMinimum: '9' })), /valid Kantreal/);
  assert.equal(state.saves.length, 0);
  const unlinked = await validateTools(form());
  assert.equal(unlinked.weaponToolsUuid, '');
  assert.equal(unlinked.armorToolsUuid, '');
});

test('the settings menu escapes saved UUIDs and item names, while retaining saved checkbox values', async () => {
  const state = fixture();
  state.config.weaponToolsUuid = 'Item.\"<injected>';
  state.config.armorDegradation = true;
  game.items.push({ type: 'tool', uuid: 'Item.tools', name: '<img src=x onerror=alert(1)>' },
    { type: 'weapon', uuid: 'Item.weapon', name: 'Not a tool' });
  await openSettings();
  const content = state.dialogs[0].content;
  assert.ok(content.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(content.includes('Item.&quot;&lt;injected&gt;'));
  assert.ok(!content.includes('<img'));
  assert.ok(!content.includes('Not a tool'));
  assert.match(content, /name="armorDegradation" checked/);
});

test('saving validates everything before committing and requests tool synchronization', async () => {
  const state = fixture(); state.documents.set('Item.tool', { documentName: 'Item', type: 'tool' });
  await openSettings();
  const save = state.dialogs[0].buttons.find(button => button.action === 'save');
  await assert.rejects(save.callback({}, { form: form({ weaponToolsUuid: 'Item.tool', armorToolsUuid: 'Item.missing' }) }), /Armor Tools/);
  assert.equal(state.saves.length, 0);
  await save.callback({}, { form: form({ weaponToolsUuid: 'Item.tool', armorDegradation: true }) });
  assert.equal(state.saves.length, 1);
  assert.equal(state.saves[0].armorDegradation, true);
  assert.deepEqual(state.hooks, [`${MODULE_ID}.syncTools`]);
});

test('both opening settings and committing an already open form require GM permission', async () => {
  const state = fixture();
  await openSettings();
  game.user.isGM = false;
  assert.throws(openSettings, /Only a GM/);
  await assert.rejects(state.dialogs[0].buttons[0].callback({}, { form: form() }), /Only a GM/);
  assert.equal(state.saves.length, 0);
});

test('settings registration is world-scoped with a restricted menu and migration-safe defaults', () => {
  const state = fixture(); registerSettings();
  assert.equal(state.registered.get('rules').scope, 'world');
  assert.equal(state.registered.get('rules').config, false);
  assert.equal(state.menus.get('configure').restricted, true);
  state.config = { weaponToolsUuid: 'Item.old' };
  assert.equal(getConfig().repairRequiresProficiency, true);
  assert.equal(getConfig().armorDegradation, false);
  state.registered.get('rules').onChange();
  assert.deepEqual(state.hooks, [`${MODULE_ID}.syncTools`]);
});

test('the registered menu constructs without arguments and renders the actual tools form', async () => {
  const state = fixture(); registerSettings();
  const Menu = state.menus.get('configure').type;
  // Match SettingsConfig's click handler, rather than bypassing it via openSettings.
  const menu = new Menu();
  const rendered = await menu.render(true);
  assert.equal(rendered, menu);
  assert.deepEqual(state.rendered, [menu]);
  assert.match(menu.options.content, /name="weaponToolsUuid"/);
  assert.match(menu.options.content, /name="armorToolsUuid"/);
  assert.deepEqual(menu.options.buttons.map(button => button.action), ['save', 'cancel']);
  assert.deepEqual(state.listeners.sort(), ['change', 'dragover', 'drop']);
  assert.equal(state.dialogs.length, 0, 'The menu itself is the dialog, not a second launcher window');
});

test('saving through the registered menu validates and persists the selected tools and armor rules', async () => {
  const state = fixture(); registerSettings();
  state.documents.set('Item.tool', { documentName: 'Item', type: 'tool' });
  const menu = new (state.menus.get('configure').type)();
  await menu.render(true);
  const save = menu.options.buttons.find(button => button.action === 'save');
  await save.callback({}, { form: form({ weaponToolsUuid: 'Item.tool', armorToolsUuid: 'Item.tool', armorDegradation: true }) });
  assert.equal(state.saves.length, 1);
  assert.equal(state.saves[0].weaponToolsUuid, 'Item.tool');
  assert.equal(state.saves[0].armorToolsUuid, 'Item.tool');
  assert.equal(state.saves[0].armorDegradation, true);
  assert.deepEqual(state.hooks, [`${MODULE_ID}.syncTools`]);
  game.user.isGM = false;
  await assert.rejects(save.callback({}, { form: form() }), /Only a GM/);
  assert.equal(state.saves.length, 1);
});

test('an invalid tool UUID leaves the registered form open and usable for correction', async t => {
  t.mock.method(console, 'error', () => {});
  const state = fixture(); registerSettings();
  const menu = new (state.menus.get('configure').type)();
  await menu.render(true);
  const button = menu.buttons.find(button => button.dataset.action === 'save');
  button.form = form({ weaponToolsUuid: 'Item.missing' });
  const event = { preventDefault() {} };
  await menu._onSubmit(button, event);
  assert.equal(state.saves.length, 0);
  assert.match(state.warnings[0], /accessible Tool item UUID/);
  assert.equal(menu.closed, undefined);
  assert.equal(menu.buttons.every(button => !button.disabled), true);
  state.documents.set('Item.tool', { documentName: 'Item', type: 'tool' });
  button.form = form({ weaponToolsUuid: 'Item.tool' });
  await menu._onSubmit(button, event);
  assert.equal(state.saves.length, 1);
  assert.equal(state.saves[0].weaponToolsUuid, 'Item.tool');
  assert.equal(menu.closed, true);
});

test('drag/drop and the world-item picker populate UUID fields without accepting unrelated drag data', () => {
  const state = fixture(), handlers = {}, selectHandlers = {}, input = { value: 'original' };
  const area = { querySelector: query => query === 'input' ? input : { addEventListener: (name, fn) => { selectHandlers[name] = fn; } },
    addEventListener: (name, fn) => { handlers[name] = fn; } };
  toolDropListeners({ querySelectorAll: () => [area] });
  const drop = text => handlers.drop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { getData: () => text } });
  drop(JSON.stringify({ type: 'Item', uuid: 'Compendium.world.tools.Item.toolbox' }));
  assert.equal(input.value, 'Compendium.world.tools.Item.toolbox');
  drop(JSON.stringify({ type: 'Actor', uuid: 'Actor.hero' }));
  assert.equal(input.value, 'Compendium.world.tools.Item.toolbox');
  drop('invalid-json'); assert.equal(state.warnings.length, 1);
  selectHandlers.change({ target: { value: 'Item.worldTool' } });
  assert.equal(input.value, 'Item.worldTool');
});
