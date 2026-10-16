import { MODULE_ID, getPatterns, detectWeaponGroup, isArmor, isToolProficient } from './rules.js';
import { applyPattern, currentPattern, patternState, setTriplexMode } from './patterns.js';
import { armorDamageState, repairArmors } from './armor.js';
import { requireTool } from './tools.js';
import { esc, formDialog, choose, getConfig, announce, run } from './shared.js';
import { openTargetAction } from './target-actions.js';

export function weaponGroup(item) {
  const limits = game.modules.get('the-horses-equipment-limits')?.active
    ? game.settings.get('the-horses-equipment-limits', 'rules')?.weaponTypes : {};
  return detectWeaponGroup(item, limits, CONFIG.DND5E.weaponTypeMap);
}
const description = pattern => `<div class="hwa-pattern"><h3>${esc(pattern.name)}</h3><p>${esc(pattern.effect)}</p><p><strong>Tradeoff:</strong> ${esc(pattern.tradeoff)}</p></div>`;

export function workbenchListeners(element, actor) {
  const weaponSelect = element.querySelector('[name=weapon]'), patternSelect = element.querySelector('[name=pattern]');
  const refresh = () => {
    const selected = actor.items.get(weaponSelect.value);
    const weapon = selected?.type === 'weapon' && weaponGroup(selected) ? selected : null;
    const available = weapon ? getPatterns(weaponGroup(weapon)) : [];
    patternSelect.innerHTML = available.map(pattern => `<option value="${pattern.id}">${esc(pattern.name)}</option>`).join('');
    if (weapon) patternSelect.value = currentPattern(weapon).id;
    element.querySelector('[data-current-pattern]').innerHTML = weapon
      ? `<p><strong>${esc(weapon.name)}</strong> (${esc(weaponGroup(weapon))})</p>${description(currentPattern(weapon))}`
      : '<p>Choose or drop a weapon from this character’s inventory.</p>';
    preview();
  };
  const preview = () => {
    const weapon = actor.items.get(weaponSelect.value);
    const pattern = weapon && getPatterns(weaponGroup(weapon)).find(pattern => pattern.id === patternSelect.value);
    element.querySelector('[data-pattern-preview]').innerHTML = pattern ? description(pattern) : '';
  };
  weaponSelect.addEventListener('change', refresh); patternSelect.addEventListener('change', preview);
  const drop = element.querySelector('.hwa-weapon-drop');
  drop.addEventListener('dragover', event => event.preventDefault());
  drop.addEventListener('drop', event => {
    event.preventDefault(); event.stopPropagation();
    try {
      const data = JSON.parse(event.dataTransfer.getData('text/plain'));
      const item = [...actor.items].find(item => item.uuid === data.uuid && item.type === 'weapon');
      if (data.type !== 'Item' || !item || !weaponGroup(item)) throw new Error('Drop a melee or ranged weapon from this character’s own inventory.');
      weaponSelect.value = item.id; refresh();
    } catch (error) { ui.notifications.warn(error.message); }
  });
  refresh();
}

export function openWeaponTools(tool) {
  requireTool(tool, 'weaponTools');
  const actor = tool.actor, weapons = [...actor.items].filter(item => item.type === 'weapon' && weaponGroup(item));
  const content = `<div class="hwa-workbench"><div class="hwa-weapon-drop"><label>Drop an inventory weapon here, or choose one:
    <select name="weapon"><option value="">Choose a weapon...</option>${weapons.map(item => `<option value="${item.id}">${esc(item.name)}</option>`).join('')}</select></label></div>
    <h3>Current pattern</h3><div data-current-pattern></div><label>Apply pattern<select name="pattern"></select></label><div data-pattern-preview></div>
    <p>One pattern per weapon. Imperial removes the pattern. Changing patterns does not repair a jammed or damaged weapon.</p></div>`;
  const selected = form => {
    const item = actor.items.get(form.elements.namedItem('weapon').value);
    if (!item) throw new Error('Choose a weapon first.');
    return item;
  };
  return formDialog('Weapon modification', content, [
    { action: 'apply', label: 'Apply pattern', default: true, callback: async (event, button) => {
      requireTool(tool, 'weaponTools');
      const item = selected(button.form), id = button.form.elements.namedItem('pattern').value;
      await applyPattern(item, id, { tool });
      await announce(actor, `<p>${esc(actor.name)} fitted ${esc(item.name)} with the <strong>${esc(currentPattern(item).name)}</strong> pattern.</p>`);
    } },
    { action: 'repair', label: 'Maintain weapon', callback: (event, button) => maintainWeapon(selected(button.form), tool) },
    { action: 'cancel', label: 'Close' }
  ], { width: 690, onRender: element => workbenchListeners(element, actor) });
}

export async function maintainWeapon(item, tool) {
  const validate = () => {
    if (!item?.isOwner || item.type !== 'weapon' || !item.actor?.isOwner || item.actor.items.get(item.id) !== item)
      throw new Error('Choose a weapon from a character inventory you own.');
  };
  const validateRepairTool = () => {
    requireTool(tool, 'weaponTools');
    if (tool.actor.uuid !== item.actor.uuid) throw new Error('Use Weapon Tools carried by this character.');
  };
  validate();
  const state = patternState(item);
  if (state.mercurianDamaged) {
    validateRepairTool();
    if (await choose('Repair damaged weapon', `<p>Confirm ${esc(item.actor.name)} has spent <strong>10 minutes</strong> repairing ${esc(item.name)} with ${esc(tool.name)}.</p>`, [
      { action: 'repair', label: 'Complete 10-minute repair' }, { action: 'cancel', label: 'Cancel' }
    ]) !== 'repair') return;
    validate(); validateRepairTool();
    const repaired = await item.update({ [`flags.${MODULE_ID}.mercurianDamaged`]: false });
    if (!repaired || patternState(item).mercurianDamaged) throw new Error('The weapon repair was blocked.');
    return announce(item.actor, `<p>${esc(item.actor.name)} spent 10 minutes repairing ${esc(item.name)} with weapon tools.</p>`);
  }
  const flag = state.jammed ? 'jammed' : state.modesLocked ? 'modesLocked' : null;
  if (!flag) return ui.notifications.info('This weapon does not need mending, recalibration, or a Mercurian repair.');
  if (await choose('Weapon maintenance', `<p>Spend <strong>one action</strong> ${flag === 'jammed' ? 'mending' : 'recalibrating'} ${esc(item.name)}?</p>`, [
    { action: 'maintain', label: 'Spend action' }, { action: 'cancel', label: 'Cancel' }
  ]) !== 'maintain') return;
  validate();
  const maintained = await item.update({ [`flags.${MODULE_ID}.${flag}`]: false });
  if (!maintained || patternState(item)[flag]) throw new Error('Weapon maintenance was blocked.');
  return announce(item.actor, `<p>${esc(item.actor.name)} spent an action ${flag === 'jammed' ? 'mending' : 'recalibrating'} ${esc(item.name)}.</p>`);
}

export function openArmorTools(tool) {
  requireTool(tool, 'armorTools', { proficiency: getConfig().repairRequiresProficiency });
  const armor = [...tool.actor.items].filter(item => isArmor(item) && armorDamageState(item).stacks > 0);
  if (!armor.length) return ui.notifications.info('This character has no damaged armor to repair.');
  const content = `<div class="hwa-workbench"><p>Select up to <strong>6 individual pieces of armor</strong>. Completing repairs confirms you spent <strong>one hour</strong> with your armor tools. All damage stacks on the selected armor are removed.</p>
    <div class="hwa-armor-list">${armor.map(item => `<label><input type="checkbox" name="armor" value="${item.id}">${esc(item.name)}: ${armorDamageState(item).stacks} damage stack(s)</label>`).join('')}</div></div>`;
  return formDialog('Repair armor', content, [
    { action: 'repair', label: 'Complete 1-hour repair', callback: async (event, button) => {
      requireTool(tool, 'armorTools', { proficiency: getConfig().repairRequiresProficiency });
      const items = [...button.form.querySelectorAll('input[name=armor]:checked')].map(input => tool.actor.items.get(input.value));
      if (await choose('Confirm repair time', '<p>Has the character completed the full hour of work?</p>', [
        { action: 'yes', label: 'Yes, complete repairs' }, { action: 'cancel', label: 'Cancel' }
      ]) !== 'yes') return;
      requireTool(tool, 'armorTools', { proficiency: getConfig().repairRequiresProficiency });
      const repaired = await repairArmors(items, tool.actor);
      await announce(tool.actor, `<p>${esc(tool.actor.name)} spent one hour repairing: ${repaired.map(item => esc(item.name)).join(', ')}. All armor damage stacks were removed.</p>`);
    } }, { action: 'cancel', label: 'Cancel' }
  ]);
}

export async function openPatternActions(item) {
  if (!item?.isOwner) throw new Error('You do not own this weapon.');
  const pattern = currentPattern(item), state = patternState(item);
  if (!pattern) throw new Error('Assign this weapon to a melee or ranged category before using pattern actions.');
  const buttons = [];
  if (state.jammed || state.modesLocked) buttons.push({ action: 'maintain', label: 'Mend / recalibrate (action)' });
  if (pattern.id === 'triplex') buttons.push({ action: 'mode', label: 'Change mode (bonus action)' });
  if (pattern.id === 'mars') buttons.push({ action: 'mars', label: 'Begin Attack action' });
  if (['lucius', 'tigrus', 'magnacore', 'umbra-ferrox'].includes(pattern.id)) buttons.push({ action: 'target', label: 'Resolve target effect' });
  if (['kalibrax', 'mezoa', 'vortannis', 'triplex'].includes(pattern.id)) buttons.push({ action: 'situational', label: 'Attack conditions' });
  buttons.push({ action: 'close', label: 'Close' });
  const result = await choose(`${item.name}: pattern actions`, `${description(pattern)}
    <p>${state.jammed ? 'Jammed. ' : ''}${state.modesLocked ? 'Special firing modes locked. ' : ''}${state.mercurianDamaged ? 'Damaged: requires 10 minutes with weapon tools. ' : ''}${pattern.id === 'triplex' ? `Mode: ${esc(state.triplexMode ?? 'standard')}.` : ''}</p>`, buttons);
  if (result === 'maintain') return maintainWeapon(item);
  if (result === 'target') return openTargetAction(item);
  if (result === 'situational') return configureAttackConditions(item);
  if (result === 'mars') {
    if (await choose('Mars: Attack action', '<p>Begin one Attack action and take 1 necrotic damage? Pay once for the whole action, including Extra Attack. Do not pay again for each attack roll. A separate Attack action costs another point.</p>', [
      { action: 'begin', label: 'Take 1 necrotic damage' }, { action: 'cancel', label: 'Cancel' }
    ]) !== 'begin') return;
    await item.actor.applyDamage([{ value: 1, type: 'necrotic' }]);
    return announce(item.actor, `<p>${esc(item.actor.name)} began an Attack action with ${esc(item.name)} and took 1 necrotic damage. Roll this action's attacks normally.</p>`);
  }
  if (result === 'mode') {
    const mode = await choose('Triplex firing mode', '<p>Changing modes spends a bonus action. Standard remains available while special modes are locked.</p>', [
      { action: 'standard', label: 'Standard' }, { action: 'energized', label: 'Energized' },
      { action: 'burst', label: 'Burst' }, { action: 'scoped', label: 'Scoped' }, { action: 'cancel', label: 'Cancel' }
    ]);
    if (!mode || mode === 'cancel' || mode === (state.triplexMode ?? 'standard')) return;
    await setTriplexMode(item, mode);
    return announce(item.actor, `<p>${esc(item.actor.name)} spent a bonus action switching ${esc(item.name)} to ${esc(mode)} mode.</p>`);
  }
}

export function configureAttackConditions(item) {
  const state = patternState(item);
  return formDialog('Pattern attack conditions', `<div class="hwa-settings"><p>These conditions apply to your next attack roll with this weapon, then clear. Keep unrelated advantage or disadvantage in Foundry's normal roll dialog.</p>
    <label><input type="checkbox" name="longRange"> This is a long-range shot</label>
    <label><input type="checkbox" name="underwater"> Underwater disadvantage applies</label>
    <label><input type="checkbox" name="nearby"> Hostile proximity disadvantage applies (within ${state.pattern === 'vortannis' ? '10' : '5'} feet)</label>
    <label>Attacks committed to Triplex burst<input name="burstCount" type="number" value="1" min="1" max="20" step="1"></label>
    <p>Burst uses one shared attack roll. Roll damage separately for each committed hit and consume the remaining ammunition as your weapon requires. Target selection and the number of available attacks require player confirmation.</p></div>`, [
    { action: 'save', label: 'Use for next attack', callback: async (event, button) => {
      if (!item.isOwner) throw new Error('You do not own this weapon.');
      const fields = button.form.elements;
      const burstCount = Number(fields.namedItem('burstCount').value);
      if (!Number.isInteger(burstCount) || burstCount < 1 || burstCount > 20) throw new Error('Enter 1 to 20 attacks.');
      await item.update({ [`flags.${MODULE_ID}.nextAttack`]: { longRange: fields.namedItem('longRange').checked,
        underwater: fields.namedItem('underwater').checked, nearby: fields.namedItem('nearby').checked, burstCount } });
    } }, { action: 'cancel', label: 'Cancel' }
  ]);
}
