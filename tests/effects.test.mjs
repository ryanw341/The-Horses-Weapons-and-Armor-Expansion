import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULE_ID } from '../scripts/rules.js';
import { hasUmbraEquipped, wornSuppression, umbraVision } from '../scripts/effects.js';

const weapon = (equipped = true) => ({ type: 'weapon', system: { equipped, attunement: 'required', attuned: false }, flags: { [MODULE_ID]: { pattern: 'umbra-ferrox' } } });
test('equipped penalties remain active without attunement, and stop when unequipped', () => {
  const effect = { flags: { [MODULE_ID]: { kind: 'pattern-worn' } }, parent: weapon() };
  assert.equal(wornSuppression.call(effect, () => true), false);
  effect.parent.system.equipped = false;
  assert.equal(wornSuppression.call(effect, () => false), true);
});
test('unrelated effects retain their normal suppression rules', () => {
  assert.equal(wornSuppression.call({ flags: {}, parent: weapon() }, () => true), true);
});
test('Umbra suppresses standard darkvision without changing token settings or light perception', () => {
  const actor = { items: [weapon()] }, original = { visionMode: 'darkvision', radius: 400, lightRadius: 2000, saturation: -1, x: 50 };
  globalThis.CONFIG = { Canvas: { visionModes: { basic: { vision: { defaults: { saturation: 0, brightness: 0 } } } } } };
  const changed = umbraVision(original, actor);
  assert.equal(changed.visionMode, 'basic'); assert.equal(changed.radius, 0); assert.equal(changed.lightRadius, 2000);
  assert.equal(changed.saturation, 0); assert.equal(original.radius, 400); assert.equal(original.saturation, -1);
  actor.items[0].system.equipped = false;
  assert.equal(umbraVision(original, actor), original); assert.equal(hasUmbraEquipped(actor), false);
});
test('unrelated vision modes are preserved', () => {
  const data = { visionMode: 'tremorsense', radius: 40 };
  assert.equal(umbraVision(data, { items: [weapon()] }), data);
});
