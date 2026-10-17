import { MODULE_ID, canonicalUuid } from './rules.js';
import { defaults, getConfig, esc, formDialog, report } from './shared.js';

export async function validateTools(form) {
  const read = name => form.elements.namedItem(name);
  const config = { ...getConfig(), weaponToolsUuid: canonicalUuid(read('weaponToolsUuid').value),
    armorToolsUuid: canonicalUuid(read('armorToolsUuid').value),
    armorDegradation: read('armorDegradation').checked, stackArmorDamage: read('stackArmorDamage').checked,
    repairRequiresProficiency: read('repairRequiresProficiency').checked, kantrealMinimum: Number(read('kantrealMinimum').value) };
  if (![10, 11].includes(config.kantrealMinimum)) throw new Error('Choose a valid Kantreal retry threshold.');
  for (const [label, uuid] of [['Weapon Tools', config.weaponToolsUuid], ['Armor Tools', config.armorToolsUuid]]) {
    if (!uuid) continue;
    const item = await fromUuid(uuid);
    if (!item || item.documentName !== 'Item' || item.type !== 'tool') throw new Error(`${label} must reference an accessible Tool item UUID.`);
  }
  return config;
}

export function toolDropListeners(element) {
  for (const area of element.querySelectorAll('[data-tool-field]')) {
    const input = area.querySelector('input');
    area.addEventListener('dragover', event => { event.preventDefault(); });
    area.addEventListener('drop', event => {
      event.preventDefault(); event.stopPropagation();
      try {
        const data = JSON.parse(event.dataTransfer.getData('text/plain'));
        if (data.type !== 'Item' || !data.uuid) return;
        input.value = data.uuid;
      } catch { ui.notifications.warn('Drop a Tool item from a sidebar, compendium, or inventory.'); }
    });
    area.querySelector('select')?.addEventListener('change', event => { if (event.target.value) input.value = event.target.value; });
  }
}

function settingsDialogOptions() {
  if (!game.user.isGM) throw new Error('Only a GM can configure these rules.');
  const config = getConfig();
  const tools = [...game.items].filter(item => item.type === 'tool').sort((a, b) => a.name.localeCompare(b.name));
  const picker = (field, label) => `<fieldset class="hwa-tool-drop" data-tool-field="${field}"><legend>${label}</legend>
    <label>Item UUID<input name="${field}" type="text" value="${esc(config[field])}" placeholder="Paste a UUID, or drop a Tool item here"></label>
    <select aria-label="Select ${label}"><option value="">Select a world Tool item...</option>${tools.map(item =>
      `<option value="${esc(item.uuid)}">${esc(item.name)}</option>`).join('')}</select></fieldset>`;
  const content = `<div class="hwa-settings"><p>Choose the source Tool items. Inventory copies are matched by their source UUID. Name alone is never used.</p>
    ${picker('weaponToolsUuid', 'Weapon Tools')}${picker('armorToolsUuid', 'Armor Tools')}
    <label><input type="checkbox" name="armorDegradation"${config.armorDegradation ? ' checked' : ''}> Armor Degradation: critical hits damage equipped body armor</label>
    <label><input type="checkbox" name="stackArmorDamage"${config.stackArmorDamage ? ' checked' : ''}> Stack armor damage (-1 AC per stack)</label>
    <label><input type="checkbox" name="repairRequiresProficiency"${config.repairRequiresProficiency ? ' checked' : ''}> Require armor-tool proficiency for repairs</label>
    <label>Kantreal confirmation roll needed to retry<select name="kantrealMinimum"><option value="11"${config.kantrealMinimum === 11 ? ' selected' : ''}>11 or higher</option><option value="10"${config.kantrealMinimum === 10 ? ' selected' : ''}>10 or higher</option></select></label>
    <p>Weapon modification always requires proficiency. Repair completion confirms that the character spent the stated time; it does not advance the world's clock.</p></div>`;
  return { window: { title: "The Horse's Weapons and Armor Expansion" }, position: { width: 620 }, content, buttons: [
    { action: 'save', label: 'Save changes', default: true, callback: async (event, button) => {
      if (!game.user.isGM) throw new Error('Only a GM can change these settings.');
      await game.settings.set(MODULE_ID, 'rules', await validateTools(button.form));
      Hooks.callAll(`${MODULE_ID}.syncTools`);
      ui.notifications.info('Saved. Matching inventory tools are being updated with their new actions.');
    } },
    { action: 'cancel', label: 'Cancel' }
  ] };
}

export function openSettings() {
  const { window, position, content, buttons } = settingsDialogOptions();
  return formDialog(window.title, content, buttons, { width: position.width, onRender: toolDropListeners });
}

export function registerSettings() {
  game.settings.register(MODULE_ID, 'rules', { name: 'Expansion rules', scope: 'world', config: false, type: Object,
    default: defaults(), onChange: () => { if (game.ready) Hooks.callAll(`${MODULE_ID}.syncTools`); } });
  class ConfigMenu extends foundry.applications.api.DialogV2 {
    constructor(options = {}) {
      // SettingsConfig constructs menus with no arguments. DialogV2 validates
      // its buttons in the constructor, before render can open anything.
      super({ ...options, ...settingsDialogOptions() });
    }

    async _onRender(context, options) {
      await super._onRender(context, options);
      toolDropListeners(this.element);
    }

    async _onSubmit(target, event) {
      const buttons = Array.from(this.element.querySelectorAll('.form-footer button[data-action]'),
        button => [button, button.disabled]);
      try {
        return await super._onSubmit(target, event);
      } catch (error) {
        // Foundry disables dialog buttons before calling the save callback.
        // A failed UUID validation must leave this form editable for a retry.
        report(error);
        return this;
      } finally {
        for (const [button, disabled] of buttons) button.disabled = disabled;
      }
    }
  }
  game.settings.registerMenu(MODULE_ID, 'configure', { name: "The Horse's Weapons and Armor Expansion",
    label: 'Configure tools and armor rules', hint: 'Link your Weapon Tools and Armor Tools; configure degradation and stacking.',
    icon: 'fas fa-screwdriver-wrench', type: ConfigMenu, restricted: true });
}
