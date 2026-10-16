/** Rules and catalogue only: no Foundry globals, document writes, or random rolls. */
export const MODULE_ID = 'the-horses-weapons-and-armor-expansion';
export const EQUIPMENT_LIMITS_ID = 'the-horses-equipment-limits';
export const MAX_REPAIR_ITEMS = 6;
export const REPAIR_SECONDS = 60 * 60;
export const KANTREAL_RETRY_MINIMUM = 11;

const patterns = [];
const add = (group, id, name, effect, tradeoff = 'None.') => patterns.push(Object.freeze({
  id, name, group, effect, tradeoff
}));

for (const group of ['ranged', 'melee']) {
  add(group, 'imperial', 'Imperial', 'No modification.');
  if (group === 'ranged') add(group, 'noctis', 'Noctis', 'The weapon becomes entirely non-lethal.');
  add(group, 'kantreal', 'Kantreal',
    'On a natural 1, roll another d20. Below 10 keeps the critical failure; above 10 allows you to remake the attack. A result of exactly 10 uses the GM\'s configured ruling.',
    'If the confirmation die is also a natural 1, the weapon cannot be used until you spend an action mending it.');
  add(group, 'lucius', 'Lucius', group === 'ranged'
    ? 'When you kill a creature with damage remaining, a creature within 5 feet of it in the direction of travel of the shot receives the remaining damage.'
    : 'When you kill a creature with damage remaining, a creature flanking the defeated creature receives the remaining damage.',
  'This damage can harm allies.');
  add(group, 'accatran', 'Accatran',
    'Weapon weight is reduced by 50%. A weapon using two equipment slots uses one; a weapon using one slot uses half a slot.',
    'On a natural 1, the weapon flies out of your hands.');
  if (group === 'ranged') add(group, 'triplex', 'Triplex',
    'Switch firing modes as a bonus action: Energized shot converts the first three damage points of each hit to lightning; Burst fire resolves all your attacks with one roll, so they all hit or all miss; Scoped fire replaces long-range disadvantage with a -5 attack penalty.',
    'On a natural 1, the special firing modes become unavailable until you spend an action recalibrating the weapon.');
  else add(group, 'sunfury', 'Sunfury',
    'The first three points of damage dealt by this weapon are fire damage.',
    'On a critical failure, the weapon overheats. Drop it or take 1d4 fire damage.');
  add(group, 'kalibrax', 'Kalibrax',
    `This weapon can be ${group === 'ranged' ? 'fired' : 'used'} underwater without penalty.`,
    'Weapon weight is increased by 50% by its reinforced waterproof construction.');
  if (group === 'ranged') {
    add(group, 'mezoa', 'Mezoa',
      'Being within 5 feet of a hostile creature does not impose disadvantage on ranged attacks with this weapon.',
      'Normal and long range are reduced by 50%.');
    add(group, 'phobos', 'Phobos',
      'Once per turn, reroll one of this weapon\'s damage dice. You must use the new result.',
      'If the rerolled damage die is a 1, the attack misses instead.');
    add(group, 'vortannis', 'Vortannis',
      'Double normal range, up to the weapon\'s long range. Long range does not change.',
      'Double the distance at which hostile creatures impose disadvantage on ranged attacks.');
    add(group, 'mars', 'Mars', 'The weapon deals 1 additional necrotic damage.',
      'You take 1 necrotic damage each time you take the Attack action with this weapon.');
  } else {
    add(group, 'tigrus', 'Tigrus',
      'On a miss, the target takes damage equal to your attack ability modifier, minimum 0. Other effects cannot increase this damage.',
      'Your AC is reduced by 1 while this weapon is equipped.');
    add(group, 'magnacore', 'Magnacore',
      'As a reaction when you strike a creature, ignite it. It must immediately drop prone to put out the flames or take 1d6 fire damage.',
      'On a critical failure, the weapon overheats. Drop it or take 1d4 fire damage.');
    add(group, 'umbra-ferrox', 'Umbra-Ferrox',
      'A critical hit blinds the target until the end of its next turn.',
      'You cannot benefit from darkvision while this weapon is equipped.');
    add(group, 'mercurian', 'Mercurian',
      'The weapon gains the thrown property with a range of 30/60 feet.',
      'If a thrown attack critically fails, the weapon is damaged until you spend 10 minutes repairing it with Weapon Tools.');
    add(group, 'tsun-jin', 'Tsun-Jin', 'Increase this weapon\'s critical threat range by 1.',
      'The critical threat range of attacks against you increases by 1 while this weapon is equipped.');
  }
}

export const PATTERNS = Object.freeze(patterns);
export const getPatterns = group => PATTERNS.filter(pattern => pattern.group === group);
export const getPattern = (id, group) => PATTERNS.find(pattern => pattern.id === id && pattern.group === group) ?? null;

export function itemTypeValue(item) {
  const type = item?.system?.type;
  return (typeof type === 'string' ? type : type?.value)
    || item?.system?.armor?.type || item?.system?.weaponType || '';
}

const STANDARD_WEAPONS = Object.freeze({
  simpleM: 'melee', martialM: 'melee', simpleR: 'ranged', martialR: 'ranged', siege: 'ranged'
});

/** An explicit Equipment Limits classification takes precedence, including exclusions. */
export function detectWeaponGroup(item, weaponTypes = {}, systemMap = {}) {
  if (item?.type !== 'weapon') return null;
  const type = itemTypeValue(item);
  const group = weaponTypes[type] ?? systemMap[type] ?? STANDARD_WEAPONS[type];
  return ['melee', 'ranged'].includes(group) ? group : null;
}

/** Derive every pattern from the saved original baseline, never the previous result. */
export function applyPatternModifiers(baseline, patternId) {
  const result = structuredClone(baseline);
  if (['accatran', 'kalibrax'].includes(patternId)) {
    const multiplier = patternId === 'accatran' ? 0.5 : 1.5;
    if (typeof result.weight === 'number' && Number.isFinite(result.weight)) result.weight *= multiplier;
    else if (Number.isFinite(result.weight?.value)) result.weight.value *= multiplier;
  }
  if (patternId === 'mezoa' && result.range) {
    for (const key of ['value', 'long']) if (Number.isFinite(result.range[key])) result.range[key] *= 0.5;
  }
  if (patternId === 'vortannis' && result.range && Number.isFinite(result.range.value)
      && Number.isFinite(result.range.long) && result.range.long >= result.range.value) {
    result.range.value = Math.min(result.range.value * 2, result.range.long);
  }
  if (patternId === 'mercurian') {
    const original = result.properties;
    const properties = new Set(original instanceof Set || Array.isArray(original) ? original : []);
    properties.add('thr');
    result.properties = original instanceof Set ? properties : [...properties];
    result.range = { ...result.range, value: 30, long: 60, units: 'ft' };
  }
  if (patternId === 'tsun-jin') {
    const threshold = Number.isFinite(result.criticalThreshold) ? result.criticalThreshold : 20;
    result.criticalThreshold = Math.max(2, Math.min(20, threshold) - 1);
  }
  return result;
}

export function slotWeightMultiplier(item) {
  return item?.type === 'weapon' && item.flags?.[MODULE_ID]?.pattern === 'accatran' ? 0.5 : 1;
}

/** Preserve the existing half-slot minimum for Light weapons. */
export function transformSlotCost(baseCost, pattern) {
  const id = typeof pattern === 'string' ? pattern : pattern?.flags?.[MODULE_ID]?.pattern;
  return id === 'accatran' ? Math.max(0.5, baseCost * 0.5) : baseCost;
}

export function isArmor(item) {
  return item?.type === 'equipment' && ['light', 'medium', 'heavy'].includes(itemTypeValue(item));
}

export function damagedStacks(old, { stacking = false, enabled = true } = {}) {
  const current = Number.isFinite(old) ? Math.max(0, Math.floor(old)) : 0;
  return !enabled ? current : stacking ? current + 1 : Math.max(current, 1);
}

/** Convert evaluated damage, not dice, before resistance. Healing/temp HP are never converted. */
export function splitDamage(points, amount = 3, type = 'fire') {
  if (!Array.isArray(points) || points.some(point => !Number.isFinite(point.value)))
    throw new TypeError('Damage points must be an array of {value: finite number, type: string}.');
  const result = points.map(point => ({ ...point }));
  let remaining = Math.max(0, Number.isFinite(amount) ? amount : 0), converted = 0;
  for (const point of result) {
    if (['healing', 'temphp'].includes(point.type) || point.value <= 0) continue;
    const value = Math.min(point.value, remaining);
    point.value -= value;
    converted += value;
    remaining -= value;
    if (remaining === 0) break;
  }
  if (converted > 0) {
    const existing = result.find(point => point.type === type);
    if (existing) existing.value += converted;
    else result.push({ value: converted, type });
  }
  return result;
}

/** An exactly-10 confirmation defaults to retaining the failure until the GM chooses otherwise. */
export function kantrealOutcome(confirmation, { minimum = KANTREAL_RETRY_MINIMUM } = {}) {
  if (!Number.isInteger(confirmation) || confirmation < 1 || confirmation > 20)
    throw new RangeError('Kantreal confirmation must be a natural d20 result from 1 to 20.');
  if (![10, 11].includes(minimum)) throw new RangeError('Kantreal retry minimum must be 10 or 11.');
  if (confirmation === 1) return 'jammed';
  return confirmation >= minimum ? 'retry' : 'critical-fail';
}

/** Validate the entire repair batch before any document is changed. */
export function validateRepairSelection(items, actor) {
  const fail = error => ({ valid: false, error, items: [] });
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_REPAIR_ITEMS)
    return fail(`Select between 1 and ${MAX_REPAIR_ITEMS} pieces of armor.`);
  const actorUuid = typeof actor === 'string' ? actor : actor?.uuid;
  if (!actorUuid) return fail('An owning character is required.');
  const seen = new Set();
  for (const item of items) {
    if (!item?.uuid || seen.has(item.uuid)) return fail('Each piece of armor can be selected only once.');
    seen.add(item.uuid);
    if ((item.actor?.uuid ?? item.parent?.uuid) !== actorUuid)
      return fail('Every selected piece of armor must belong to this character.');
    if (!isArmor(item)) return fail('Only light, medium, or heavy armor can be repaired.');
  }
  return { valid: true, error: null, items: [...items] };
}

export function canonicalUuid(value) {
  if (typeof value !== 'string') return '';
  const parts = value.trim().split('.');
  if (parts[0] === 'Compendium' && parts.length === 4) parts.splice(3, 0, 'Item');
  return parts.join('.');
}

export function toolIdentityMatches(item, configuredUuid) {
  const uuid = canonicalUuid(configuredUuid);
  if (!uuid || item?.type !== 'tool') return false;
  return [item.uuid, item._stats?.compendiumSource, item._stats?.duplicateSource,
    item.flags?.core?.sourceId, item.flags?.dnd5e?.sourceId].some(source => canonicalUuid(source) === uuid);
}

/** Mirrors dnd5e 5.3.3 ToolData.proficiencyMultiplier; half proficiency is insufficient. */
export function isToolProficient(item, actor = item?.actor ?? item?.parent) {
  if (item?.type !== 'tool') return false;
  const system = item.system ?? {};
  if (Number.isFinite(system.proficiencyMultiplier)) return system.proficiencyMultiplier >= 1;
  if (Number.isFinite(system.proficient)) return system.proficient >= 1;
  if (!actor) return false;
  if (actor.system?.isNPC) return true;
  const type = typeof system.type === 'object' ? system.type : { value: system.type };
  return Math.max(actor.system?.tools?.[type?.baseItem]?.value ?? 0,
    actor.system?.tools?.[type?.value]?.value ?? 0) >= 1;
}
