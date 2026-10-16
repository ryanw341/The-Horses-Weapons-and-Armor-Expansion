import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MODULE_ID, PATTERNS, getPatterns, getPattern, detectWeaponGroup, applyPatternModifiers,
  slotWeightMultiplier, transformSlotCost, isArmor, damagedStacks, splitDamage,
  kantrealOutcome, validateRepairSelection, toolIdentityMatches, isToolProficient
} from '../scripts/rules.js';

const weapon = (type, extra = {}) => ({ type: 'weapon', system: { type: { value: type } }, ...extra });
const actor = { uuid: 'Actor.example', system: { tools: {} } };
const armor = (id, type = 'heavy', parent = actor) => ({
  uuid: `${parent.uuid}.Item.${id}`, type: 'equipment', parent, system: { type: { value: type } }
});
const baseline = () => ({ weight: { value: 8, units: 'lb' }, range: { value: 80, long: 320, units: 'ft' },
  properties: ['hvy', 'two'], criticalThreshold: 20 });

test('the catalog includes every requested melee and ranged pattern with separate Lucius rules', () => {
  assert.equal(PATTERNS.length, 22);
  assert.deepEqual(getPatterns('ranged').map(p => p.id), ['imperial', 'noctis', 'kantreal', 'lucius',
    'accatran', 'triplex', 'kalibrax', 'mezoa', 'phobos', 'vortannis', 'mars']);
  assert.deepEqual(getPatterns('melee').map(p => p.id), ['imperial', 'kantreal', 'lucius', 'accatran',
    'sunfury', 'kalibrax', 'tigrus', 'magnacore', 'umbra-ferrox', 'mercurian', 'tsun-jin']);
  assert.match(getPattern('lucius', 'melee').effect, /flanking/);
  assert.match(getPattern('lucius', 'ranged').effect, /direction/);
  assert.equal(getPattern('noctis', 'melee'), null);
  assert.equal(getPattern('missing', 'ranged'), null);
  assert.deepEqual(getPatterns('unknown'), []);
  assert.ok(PATTERNS.every(p => p.effect && p.tradeoff && Object.isFrozen(p)));
});

test('weapon groups follow Equipment Limits overrides, then system mappings, then defaults', () => {
  assert.equal(detectWeaponGroup(weapon('martialM')), 'melee');
  assert.equal(detectWeaponGroup(weapon('martialR')), 'ranged');
  assert.equal(detectWeaponGroup(weapon('custom'), {}, { custom: 'ranged' }), 'ranged');
  assert.equal(detectWeaponGroup(weapon('custom'), { custom: 'melee' }, { custom: 'ranged' }), 'melee');
  assert.equal(detectWeaponGroup(weapon('martialM'), { martialM: 'ignore' }), null);
  assert.equal(detectWeaponGroup(weapon('natural')), null);
  assert.equal(detectWeaponGroup({ type: 'equipment', system: { type: 'martialM' } }), null);
});

test('pattern changes derive from the original baseline and Imperial fully restores it', () => {
  const original = baseline(), snapshot = structuredClone(original);
  const reduced = applyPatternModifiers(original, 'accatran');
  assert.equal(reduced.weight.value, 4);
  assert.equal(applyPatternModifiers(original, 'accatran').weight.value, 4);
  assert.equal(applyPatternModifiers(original, 'kalibrax').weight.value, 12);
  assert.deepEqual(applyPatternModifiers(original, 'imperial'), snapshot);
  assert.deepEqual(original, snapshot);
  assert.notEqual(reduced.range, original.range);
  assert.equal(applyPatternModifiers({ weight: 8 }, 'kalibrax').weight, 12);
});

test('range patterns preserve units, long-range caps, and missing data', () => {
  assert.deepEqual(applyPatternModifiers(baseline(), 'mezoa').range, { value: 40, long: 160, units: 'ft' });
  assert.deepEqual(applyPatternModifiers(baseline(), 'vortannis').range, { value: 160, long: 320, units: 'ft' });
  assert.equal(applyPatternModifiers({ range: { value: 100, long: 150 } }, 'vortannis').range.value, 150);
  assert.deepEqual(applyPatternModifiers({ range: { value: 20, long: null } }, 'vortannis').range,
    { value: 20, long: null });
  assert.deepEqual(applyPatternModifiers({ range: { value: 20, long: null } }, 'mezoa').range,
    { value: 10, long: null });
});

test('Mercurian adds thrown once and restores the original properties when removed', () => {
  const original = baseline();
  assert.deepEqual(applyPatternModifiers(original, 'mercurian').properties, ['hvy', 'two', 'thr']);
  assert.deepEqual(applyPatternModifiers(original, 'mercurian').range, { value: 30, long: 60, units: 'ft' });
  const withSet = { ...original, properties: new Set(['thr', 'fin']) };
  assert.deepEqual(applyPatternModifiers(withSet, 'mercurian').properties, new Set(['thr', 'fin']));
  assert.deepEqual(applyPatternModifiers(original, 'imperial').properties, ['hvy', 'two']);
});

test('Tsun-Jin improves existing critical thresholds and never makes natural 1 critical', () => {
  assert.equal(applyPatternModifiers(baseline(), 'tsun-jin').criticalThreshold, 19);
  assert.equal(applyPatternModifiers({ criticalThreshold: 19 }, 'tsun-jin').criticalThreshold, 18);
  assert.equal(applyPatternModifiers({ criticalThreshold: null }, 'tsun-jin').criticalThreshold, 19);
  assert.equal(applyPatternModifiers({ criticalThreshold: 2 }, 'tsun-jin').criticalThreshold, 2);
});

test('Accatran halves equipment cost while preserving the existing half-slot minimum', () => {
  assert.equal(transformSlotCost(2, 'accatran'), 1);
  assert.equal(transformSlotCost(1, 'accatran'), 0.5);
  assert.equal(transformSlotCost(0.5, 'accatran'), 0.5);
  assert.equal(transformSlotCost(2, 'imperial'), 2);
  const item = weapon('martialM', { flags: { [MODULE_ID]: { pattern: 'accatran' } } });
  assert.equal(transformSlotCost(2, item), 1);
  assert.equal(slotWeightMultiplier(item), 0.5);
  assert.equal(slotWeightMultiplier(armor('a')), 1);
});

test('degradation affects actual armor, not shields, clothing, custom equipment, or weapons', () => {
  for (const type of ['light', 'medium', 'heavy']) assert.equal(isArmor(armor(type, type)), true);
  for (const type of ['shield', 'clothing', 'implant']) assert.equal(isArmor(armor(type, type)), false);
  assert.equal(isArmor(weapon('heavy')), false);
  assert.equal(isArmor({ type: 'equipment', system: { armor: { type: 'heavy' } } }), true);
});

test('stacking settings add or preserve damage without silently repairing existing stacks', () => {
  assert.equal(damagedStacks(0), 1);
  assert.equal(damagedStacks(1), 1);
  assert.equal(damagedStacks(3), 3);
  assert.equal(damagedStacks(3, { stacking: true }), 4);
  assert.equal(damagedStacks(3, { enabled: false, stacking: true }), 3);
  assert.equal(damagedStacks(-5), 1);
  assert.equal(damagedStacks(undefined), 1);
});

test('damage conversion preserves totals across pools and does not add three damage', () => {
  const original = [{ value: 2, type: 'piercing' }, { value: 6, type: 'necrotic' }];
  const result = splitDamage(original);
  assert.deepEqual(result, [{ value: 0, type: 'piercing' }, { value: 5, type: 'necrotic' }, { value: 3, type: 'fire' }]);
  assert.equal(result.reduce((sum, point) => sum + point.value, 0), 8);
  assert.equal(original[0].value, 2);
  assert.deepEqual(splitDamage([{ value: 2, type: 'slashing' }], 3, 'lightning'),
    [{ value: 0, type: 'slashing' }, { value: 2, type: 'lightning' }]);
});

test('damage conversion counts existing elemental damage and ignores healing and temporary HP', () => {
  assert.deepEqual(splitDamage([{ value: 2, type: 'fire' }, { value: 8, type: 'slashing' }]),
    [{ value: 3, type: 'fire' }, { value: 7, type: 'slashing' }]);
  const mixed = [{ value: 3, type: 'healing' }, { value: 3, type: 'temphp' }, { value: -2, type: 'cold' }];
  assert.deepEqual(splitDamage(mixed), mixed);
  assert.deepEqual(splitDamage([]), []);
  assert.throws(() => splitDamage([{ value: NaN, type: 'fire' }]), TypeError);
});

test('Kantreal handles its ambiguous 10 by setting and always jams on a second natural 1', () => {
  assert.equal(kantrealOutcome(1), 'jammed');
  assert.equal(kantrealOutcome(9), 'critical-fail');
  assert.equal(kantrealOutcome(10), 'critical-fail');
  assert.equal(kantrealOutcome(10, { minimum: 10 }), 'retry');
  assert.equal(kantrealOutcome(11), 'retry');
  assert.equal(kantrealOutcome(20), 'retry');
  assert.throws(() => kantrealOutcome(0), RangeError);
  assert.throws(() => kantrealOutcome(21), RangeError);
  assert.throws(() => kantrealOutcome(10, { minimum: 9 }), RangeError);
});

test('repairs validate the entire set of at most six distinct owned armor items', () => {
  const selected = Array.from({ length: 6 }, (_, index) => armor(String(index)));
  assert.equal(validateRepairSelection(selected, actor).valid, true);
  assert.equal(validateRepairSelection(selected, actor.uuid).valid, true);
  assert.equal(validateRepairSelection([...selected, armor('7')], actor).valid, false);
  assert.equal(validateRepairSelection([selected[0], selected[0]], actor).valid, false);
  assert.equal(validateRepairSelection([armor('x', 'heavy', { uuid: 'Actor.other' })], actor).valid, false);
  assert.equal(validateRepairSelection([armor('x', 'shield')], actor).valid, false);
  assert.equal(validateRepairSelection([], actor).valid, false);
  assert.equal(validateRepairSelection(selected, null).valid, false);
});

test('tool identity matches owned copies by exact current or legacy source UUID, never name', () => {
  const source = 'Compendium.world.tools.Item.weapons';
  const tool = { type: 'tool', name: 'Weapon Tools', uuid: 'Actor.example.Item.tools',
    _stats: { compendiumSource: source } };
  assert.equal(toolIdentityMatches(tool, source), true);
  assert.equal(toolIdentityMatches(tool, 'Compendium.world.tools.weapons'), true);
  assert.equal(toolIdentityMatches(tool, 'Compendium.world.tools.Item.weapons-other'), false);
  assert.equal(toolIdentityMatches(tool, ''), false);
  assert.equal(toolIdentityMatches({ ...tool, type: 'loot' }, source), false);
  assert.equal(toolIdentityMatches({ ...tool, _stats: { duplicateSource: 'Item.original' } }, 'Item.original'), true);
  assert.equal(toolIdentityMatches({ ...tool, _stats: {}, flags: { core: { sourceId: source } } }, source), true);
  assert.equal(toolIdentityMatches({ ...tool, _stats: {}, flags: { dnd5e: { sourceId: source } } }, source), true);
});

test('tool proficiency respects the prepared multiplier and explicit item override', () => {
  const tool = { type: 'tool', system: { proficiencyMultiplier: 0.5, proficient: 2 } };
  assert.equal(isToolProficient(tool, actor), false);
  tool.system.proficiencyMultiplier = 1;
  assert.equal(isToolProficient(tool, actor), true);
  delete tool.system.proficiencyMultiplier;
  assert.equal(isToolProficient(tool, actor), true);
  tool.system.proficient = 0;
  assert.equal(isToolProficient(tool, { system: { isNPC: true } }), false);
});

test('tool proficiency inherits the best base-item/category training when no override exists', () => {
  const tool = { type: 'tool', system: { proficient: null, type: { value: 'artisan', baseItem: 'smith' } } };
  assert.equal(isToolProficient(tool, { system: { tools: { smith: { value: 1 } } } }), true);
  assert.equal(isToolProficient(tool, { system: { tools: { artisan: { value: 2 } } } }), true);
  assert.equal(isToolProficient(tool, { system: { tools: { artisan: { value: 0.5 } } } }), false);
  assert.equal(isToolProficient(tool, { system: { isNPC: true } }), true);
  assert.equal(isToolProficient(tool), false);
  assert.equal(isToolProficient({ ...tool, type: 'loot' }, actor), false);
});
