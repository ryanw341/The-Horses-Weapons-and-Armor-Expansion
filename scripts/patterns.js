import {
  MODULE_ID, EQUIPMENT_LIMITS_ID, detectWeaponGroup, getPattern, isToolProficient, toolIdentityMatches
} from './rules.js';
import { getConfig } from './shared.js';

export const PATTERN_ACTION_ID = 'horsePatternAct1';
export const TRIPLEX_MODES = Object.freeze(['standard', 'energized', 'burst', 'scoped']);
const ITEM_EFFECT_ID = 'horsePatternItem';
const WORN_EFFECT_ID = 'horsePatternWear';
const pending = new Map();

export function patternState(item) { return { pattern: 'imperial', ...item.flags?.[MODULE_ID] }; }

export function weaponGroup(item) {
  const limits = game.modules.get(EQUIPMENT_LIMITS_ID)?.active
    ? game.settings.get(EQUIPMENT_LIMITS_ID, 'rules') : {};
  return detectWeaponGroup(item, limits?.weaponTypes, CONFIG.DND5E.weaponTypeMap);
}

export function currentPattern(item) {
  const group = weaponGroup(item);
  return getPattern(patternState(item).pattern, group) ?? getPattern('imperial', group);
}

function owningActor(item) {
  const actor = item?.actor ?? item?.parent;
  if (item?.type !== 'weapon' || !actor?.uuid || !item.isOwner || actor.pack)
    throw new Error('Choose a weapon from a character you own.');
  return actor;
}

function checkTool(actor, supplied, config) {
  if (!config.weaponToolsUuid) throw new Error('The GM must link Weapon Tools in the module settings first.');
  const candidates = supplied ? [supplied] : Array.from(actor.items ?? []);
  const matching = candidates.filter(tool => (tool.actor?.uuid ?? tool.parent?.uuid) === actor.uuid
    && toolIdentityMatches(tool, config.weaponToolsUuid));
  if (!matching.length) throw new Error('This character must carry the configured Weapon Tools.');
  if (!matching.some(tool => isToolProficient(tool, actor)))
    throw new Error('You do not have proficiency with these Weapon Tools.');
}

const isPatternEffect = effect => ['pattern', 'pattern-worn'].includes(effect.flags?.[MODULE_ID]?.kind);
const isPatternActivity = activity => activity.flags?.[MODULE_ID]?.action === 'patternActions';
const plain = value => typeof value.toObject === 'function' ? value.toObject() : structuredClone(value);
function effectsWithoutPattern(item) {
  return Array.from(item.effects ?? item._source?.effects ?? [], plain).filter(effect => !isPatternEffect(effect));
}

function change(key, mode, value) {
  return { key, mode, value: String(value), priority: mode === CONST.ACTIVE_EFFECT_MODES.OVERRIDE ? 50 : 30 };
}

function patternEffects(item, pattern, unrelated) {
  const modes = CONST.ACTIVE_EFFECT_MODES, changes = [], worn = [];
  switch (pattern.id) {
    case 'accatran': changes.push(change('system.weight.value', modes.MULTIPLY, 0.5)); break;
    case 'kalibrax': changes.push(change('system.weight.value', modes.MULTIPLY, 1.5)); break;
    case 'mezoa':
      changes.push(change('system.range.value', modes.MULTIPLY, 0.5), change('system.range.long', modes.MULTIPLY, 0.5));
      break;
    case 'vortannis': {
      // dnd5e Item5e.clone prepares enchantments, so unrelated bonuses remain in the calculation.
      // Removing our previous effects from the clone prevents doubling again on repeat application.
      const baseline = item.clone({ effects: unrelated }, { keepId: true }).system.range;
      if (Number.isFinite(baseline?.value) && Number.isFinite(baseline?.long) && baseline.long >= baseline.value)
        changes.push(change('system.range.value', modes.OVERRIDE, Math.min(baseline.value * 2, baseline.long)));
      break;
    }
    case 'mercurian':
      changes.push(change('system.properties', modes.ADD, 'thr'), change('system.range.value', modes.OVERRIDE, 30),
        change('system.range.long', modes.OVERRIDE, 60), change('system.range.units', modes.OVERRIDE, 'ft'));
      break;
    case 'tigrus': worn.push(change('system.attributes.ac.bonus', modes.ADD, -1)); break;
    case 'umbra-ferrox': worn.push(change('system.attributes.senses.ranges.darkvision', modes.OVERRIDE, 0)); break;
  }
  const make = (id, effectChanges, transfer) => ({
    _id: id, name: `${pattern.name} pattern`, img: item.img || 'icons/svg/sword.svg',
    type: transfer ? 'base' : 'enchantment', origin: item.actor?.uuid ?? item.parent.uuid,
    disabled: false, transfer, changes: effectChanges, duration: {}, statuses: [],
    flags: { [MODULE_ID]: { kind: transfer ? 'pattern-worn' : 'pattern', pattern: pattern.id, whileEquipped: transfer } }
  });
  return [...(changes.length ? [make(ITEM_EFFECT_ID, changes, false)] : []),
    ...(worn.length ? [make(WORN_EFFECT_ID, worn, true)] : [])];
}

function patternActivity(item) {
  return {
    _id: PATTERN_ACTION_ID, type: 'utility', name: 'Pattern actions', img: item.img || 'icons/svg/sword.svg',
    activation: { type: 'special', value: null, override: true },
    consumption: { spellSlot: false, targets: [], scaling: { allowed: false } },
    target: { prompt: false, override: true }, roll: { prompt: false, visible: false, formula: '' },
    flags: { [MODULE_ID]: { action: 'patternActions' } }
  };
}

function enqueue(item, task) {
  const key = item.uuid;
  const operation = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(task);
  pending.set(key, operation);
  return operation.finally(() => { if (pending.get(key) === operation) pending.delete(key); });
}

/** Only this module's enchantments/activity are replaced; base item fields are never rewritten. */
export function applyPattern(item, patternId, { tool } = {}) {
  return enqueue(item, async () => {
    const actor = owningActor(item), config = getConfig();
    if (config.enabled === false) throw new Error('Weapons and Armor Expansion is disabled.');
    checkTool(actor, tool, config);
    const pattern = getPattern(patternId, weaponGroup(item));
    if (!pattern) throw new Error('This pattern is not available for this weapon category.');
    const unrelated = effectsWithoutPattern(item);
    if (unrelated.some(effect => [ITEM_EFFECT_ID, WORN_EFFECT_ID].includes(effect._id)))
      throw new Error('A different effect uses a reserved pattern ID. Rename or duplicate that effect before applying a pattern.');
    const activities = Array.from(item.system.activities ?? []);
    if (activities.some(activity => (activity.id ?? activity._id) === PATTERN_ACTION_ID && !isPatternActivity(activity)))
      throw new Error('A different activity uses the reserved pattern activity ID.');
    const update = {
      effects: [...unrelated, ...patternEffects(item, pattern, unrelated)],
      [`flags.${MODULE_ID}.pattern`]: pattern.id
    };
    for (const activity of activities) {
      const id = activity.id ?? activity._id;
      if (isPatternActivity(activity) && (pattern.id === 'imperial' || id !== PATTERN_ACTION_ID))
        update[`system.activities.-=${id}`] = null;
    }
    if (pattern.id !== 'imperial') update[`system.activities.${PATTERN_ACTION_ID}`] = patternActivity(item);
    // Jammed and damaged flags deliberately survive pattern changes, including Imperial.
    const result = await item.update(update);
    if (!result || patternState(item).pattern !== pattern.id)
      throw new Error('The pattern change was blocked. Equipment limits or another module may prevent this change.');
    return result;
  });
}

export function setTriplexMode(item, mode) {
  return enqueue(item, async () => {
    owningActor(item);
    if (patternState(item).pattern !== 'triplex') throw new Error('This weapon does not have the Triplex pattern.');
    if (!TRIPLEX_MODES.includes(mode)) throw new Error('Choose a valid Triplex firing mode.');
    if (patternState(item).modesLocked && mode !== 'standard')
      throw new Error('Spend an action recalibrating this weapon before selecting a special firing mode.');
    const result = await item.update({ [`flags.${MODULE_ID}.triplexMode`]: mode });
    if (!result || patternState(item).triplexMode !== mode) throw new Error('The firing mode change was blocked.');
    return result;
  });
}
