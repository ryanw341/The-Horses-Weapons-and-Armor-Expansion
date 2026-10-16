import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_ID } from '../scripts/rules.js';
import { armorDamageState, damageEffectData, damageArmor, repairArmors, equippedArmor } from '../scripts/armor.js';

function fixture() {
  const actor = {
    uuid: 'Actor.armorOwner', isOwner: true, system: { attributes: { ac: {} } }, items: [], batches: [],
    async updateEmbeddedDocuments(type, updates) {
      this.batches.push({ type, updates: structuredClone(updates) });
      return Promise.all(updates.map(update => this.items.find(item => item.id === update._id).update(update)));
    }
  };
  function armor(id, { type = 'heavy', equipped = true, quantity = 1, flags = {}, effects = [] } = {}) {
    const item = {
      id, uuid: `${actor.uuid}.Item.${id}`, name: `Armor ${id}`, type: 'equipment', parent: actor,
      isOwner: true, flags: structuredClone(flags), effects: structuredClone(effects), updates: [],
      system: { type: { value: type }, equipped, quantity, armor: { value: 18 } },
      getFlag(scope, key) { return this.flags?.[scope]?.[key]; },
      toObject() { return { effects: structuredClone(this.effects) }; },
      async update(update) {
        if (this.beforeUpdate) await this.beforeUpdate(update);
        this.updates.push(structuredClone(update));
        for (const [path, value] of Object.entries(update)) {
          if (path === '_id') continue;
          const parts = path.split('.');
          let target = this;
          for (const part of parts.slice(0, -1)) target = target[part] ??= {};
          target[parts.at(-1)] = structuredClone(value);
        }
        return this;
      }
    };
    actor.items.push(item);
    return item;
  }
  return { actor, armor };
}

const ownDamage = item => item.effects.filter(effect => effect.flags?.[MODULE_ID]?.kind === 'armor-damage');

test('damage belongs to armor as a non-transferred enchantment and does not rewrite base AC', async () => {
  const { actor, armor } = fixture(), item = armor('first'), spare = armor('spare', { equipped: false });
  const result = await damageArmor(item, { eventId: 'critical-1' });
  assert.equal(result, item);
  assert.equal(armorDamageState(item).stacks, 1);
  assert.equal(item.system.armor.value, 18);
  assert.deepEqual(spare.updates, []);
  assert.equal(ownDamage(item).length, 1);
  const effect = ownDamage(item)[0];
  assert.equal(effect.name, 'Damaged (1)');
  assert.equal(effect.type, 'enchantment');
  assert.equal(effect.transfer, false);
  assert.equal(effect.origin, actor.uuid);
  assert.deepEqual(effect.changes, [{ key: 'system.armor.value', mode: 2, value: '-1', priority: 20 }]);
  assert.equal(actor.system.attributes.ac.value, undefined);
});

test('duplicate critical events do nothing, while stacking applies each distinct event once', async () => {
  const { armor } = fixture(), item = armor('first');
  await damageArmor(item, { stacking: true, eventId: 'critical-1' });
  const id = ownDamage(item)[0]._id;
  await damageArmor(item, { stacking: true, eventId: 'critical-1' });
  assert.equal(item.updates.length, 1);
  await damageArmor(item, { stacking: true, eventId: 'critical-2' });
  assert.equal(armorDamageState(item).stacks, 2);
  assert.equal(ownDamage(item).length, 1);
  assert.equal(ownDamage(item)[0]._id, id);
  assert.equal(ownDamage(item)[0].changes[0].value, '-2');
});

test('the same critical event cannot damage replacement armor after an equipment swap or repair', async () => {
  const { actor, armor } = fixture(), original = armor('original'), replacement = armor('replacement', { equipped: false });
  await damageArmor(original, { stacking: true, eventId: 'same-attack' });
  original.system.equipped = false; replacement.system.equipped = true;
  actor.system.attributes.ac.equippedArmor = replacement;
  assert.equal(equippedArmor(actor), replacement);
  assert.equal(await damageArmor(replacement, { stacking: true, eventId: 'same-attack' }), original);
  assert.equal(armorDamageState(replacement).stacks, 0);
  assert.equal(replacement.updates.length, 0);
  await repairArmors([original], actor);
  await damageArmor(replacement, { stacking: true, eventId: 'same-attack' });
  assert.equal(replacement.updates.length, 0);
  await damageArmor(replacement, { stacking: true, eventId: 'new-attack' });
  assert.equal(armorDamageState(replacement).stacks, 1);
  assert.equal(armorDamageState(original).stacks, 0);
});

test('disabling stacking prevents new stacks without repairing previously accumulated damage', async () => {
  const { armor } = fixture(), item = armor('first');
  await damageArmor(item);
  await damageArmor(item);
  assert.equal(armorDamageState(item).stacks, 1);
  await damageArmor(item, { stacking: true });
  await damageArmor(item, { stacking: false });
  assert.equal(armorDamageState(item).stacks, 2);
});

test('concurrent critical hits serialize, preserving both stacks and deduplication', async () => {
  const { armor } = fixture(), item = armor('first');
  await Promise.all([
    damageArmor(item, { stacking: true, eventId: 'one' }),
    damageArmor(item, { stacking: true, eventId: 'two' }),
    damageArmor(item, { stacking: true, eventId: 'one' })
  ]);
  assert.equal(armorDamageState(item).stacks, 2);
  assert.deepEqual(armorDamageState(item).events, ['one', 'two']);
  assert.equal(item.updates.length, 2);
});

test('repair clears all damage in one batch, preserving unrelated effects, flags and base values', async () => {
  const { actor, armor } = fixture();
  const unrelated = { _id: 'enchantedarmor01', name: 'Enchanted', type: 'enchantment', changes: [] };
  const one = armor('one', { effects: [unrelated], flags: { [MODULE_ID]: { pattern: 'custom' }, other: { value: 7 } } });
  const two = armor('two', { equipped: false });
  await damageArmor(one, { stacking: true, eventId: 'one-hit' });
  await damageArmor(one, { stacking: true, eventId: 'two-hit' });
  await damageArmor(two, { eventId: 'three-hit' });
  const result = await repairArmors([one, two], actor);
  assert.deepEqual(result, [one, two]);
  assert.equal(actor.batches.length, 1);
  assert.equal(actor.batches[0].type, 'Item');
  assert.equal(armorDamageState(one).stacks, 0);
  assert.equal(armorDamageState(two).stacks, 0);
  assert.deepEqual(one.effects, [unrelated]);
  assert.deepEqual(two.effects, []);
  assert.equal(one.flags[MODULE_ID].pattern, 'custom');
  assert.equal(one.flags.other.value, 7);
  assert.equal(one.system.armor.value, 18);
  const count = one.updates.length;
  await damageArmor(one, { eventId: 'one-hit', stacking: true });
  assert.equal(one.updates.length, count, 'old event must not damage repaired armor again');
});

test('repair validates the entire selection before writing any valid item', async () => {
  const { actor, armor } = fixture(), one = armor('one'), shield = armor('shield', { type: 'shield' });
  await assert.rejects(repairArmors([one, shield], actor), /body armor/);
  await assert.rejects(repairArmors([one, one], actor), /only once/);
  await assert.rejects(repairArmors([], actor), /between one and six/);
  const seven = Array.from({ length: 7 }, (_, index) => armor(`many${index}`));
  await assert.rejects(repairArmors(seven, actor), /between one and six/);
  assert.deepEqual(one.updates, []);
  assert.equal(actor.batches.length, 0);
  await repairArmors(seven.slice(0, 6), actor);
  assert.equal(actor.batches[0].updates.length, 6);
});

test('foreign armor, stale documents, permissions, and quantity stacks are rejected without writes', async () => {
  const { actor, armor } = fixture(), item = armor('one');
  const foreign = fixture().armor('other');
  foreign.parent.uuid = 'Actor.another';
  await assert.rejects(repairArmors([item, foreign], actor), /inventory/);
  actor.items.splice(actor.items.indexOf(item), 1);
  await assert.rejects(damageArmor(item), /inventory/);
  actor.items.push(item);
  item.system.quantity = 2;
  await assert.rejects(damageArmor(item), /Split this armor stack/);
  await assert.rejects(repairArmors([item], actor), /Split this armor stack/);
  item.system.quantity = 1;
  item.isOwner = false;
  await assert.rejects(damageArmor(item), /permission/);
  item.isOwner = true;
  actor.isOwner = false;
  await assert.rejects(damageArmor(item), /permission/);
  await assert.rejects(repairArmors([item], actor), /permission/);
  assert.deepEqual(item.updates, []);
  assert.equal(actor.batches.length, 0);
});

test('critical armor selection follows prepared armor and never selects shields or unequipped armor', () => {
  const { actor, armor } = fixture();
  armor('shield', { type: 'shield' });
  const first = armor('first'), second = armor('second'), spare = armor('spare', { equipped: false });
  assert.equal(equippedArmor(actor), first);
  actor.system.attributes.ac.equippedArmor = second;
  assert.equal(equippedArmor(actor), second);
  actor.system.attributes.ac.equippedArmor = second.id;
  assert.equal(equippedArmor(actor), second);
  actor.system.attributes.ac.equippedArmor = spare;
  assert.equal(equippedArmor(actor), first);
  first.system.equipped = second.system.equipped = false;
  assert.equal(equippedArmor(actor), null);
});

test('recent critical event history is bounded and callers cannot mutate stored history by reading it', async () => {
  const { armor } = fixture();
  const events = Array.from({ length: 64 }, (_, i) => `hit-${i}`);
  const item = armor('one', { flags: { [MODULE_ID]: { damagedEvents: events } } });
  await damageArmor(item, { eventId: 'latest' });
  const state = armorDamageState(item);
  assert.equal(state.events.length, 64);
  assert.equal(state.events[0], 'hit-1');
  assert.equal(state.events.at(-1), 'latest');
  state.events.push('tampered');
  assert.equal(armorDamageState(item).events.length, 64);
});

test('damage consolidates only owned damage effects and preserves same-named third-party effects', async () => {
  const { armor } = fixture();
  const other = { _id: 'thirdpartydamage', name: 'Damaged (4)', flags: { other: { damage: true } } };
  const item = armor('one', { effects: [other,
    { _id: 'ourdamagefirst01', flags: { [MODULE_ID]: { kind: 'armor-damage' } } },
    { _id: 'ourdamagesecond1', flags: { [MODULE_ID]: { kind: 'armor-damage' } } }
  ] });
  await damageArmor(item);
  assert.deepEqual(item.effects[0], other);
  assert.equal(ownDamage(item).length, 1);
  assert.equal(ownDamage(item)[0]._id, 'ourdamagefirst01');
});

test('a failed update does not wedge later damage operations', async () => {
  const { armor } = fixture(), item = armor('one');
  item.beforeUpdate = async () => { throw new Error('Update rejected'); };
  await assert.rejects(damageArmor(item, { eventId: 'one' }), /Update rejected/);
  delete item.beforeUpdate;
  await damageArmor(item, { eventId: 'two' });
  assert.deepEqual(armorDamageState(item), { stacks: 1, events: ['two'] });
});

test('effect helper rejects invalid stacks and substitutes a non-self actor origin', () => {
  const { actor, armor } = fixture(), item = armor('one');
  assert.equal(damageEffectData(item, 3, { origin: item.uuid }).origin, actor.uuid);
  assert.equal(damageEffectData(item, 3, { origin: 'Actor.source', id: 'exampleEffect001' }).origin, 'Actor.source');
  assert.throws(() => damageEffectData(item, 0), /positive integer/);
  assert.throws(() => damageEffectData(item, 1.5), /positive integer/);
  assert.throws(() => damageEffectData({ uuid: 'Item.world' }, 1), /actor origin/);
});
