/** Item-local armor damage. No actor AC source data is changed. */
import { MODULE_ID, isArmor } from './rules.js';

const DAMAGE_KIND = 'armor-damage';
const MAX_EVENTS = 64;
const FALLBACK_EFFECT_ID = 'HorseArmorDamage';
const pending = new Map();

function clone(value) {
  return structuredClone(value);
}

function effectsOf(item) {
  const source = item.toObject?.().effects;
  if (Array.isArray(source)) return clone(source);
  return Array.from(item.effects ?? [], effect => clone(effect.toObject?.() ?? effect));
}

function isDamageEffect(effect) {
  return effect.flags?.[MODULE_ID]?.kind === DAMAGE_KIND;
}

/** Stored stacks and recent critical-event IDs. Returned arrays are safe to edit. */
export function armorDamageState(item) {
  const flags = item.flags?.[MODULE_ID] ?? {};
  const rawStacks = item.getFlag?.(MODULE_ID, 'damageStacks') ?? flags.damageStacks;
  const stacks = Number.isFinite(Number(rawStacks)) ? Math.max(0, Math.trunc(Number(rawStacks))) : 0;
  const rawEvents = item.getFlag?.(MODULE_ID, 'damagedEvents') ?? flags.damagedEvents;
  const events = Array.isArray(rawEvents)
    ? [...new Set(rawEvents.filter(event => typeof event === 'string' && event.length > 0))].slice(-MAX_EVENTS)
    : [];
  return { stacks, events };
}

/**
 * dnd5e 5.3.3 applies item effects only when they are enchantments with a
 * nonempty origin different from the item itself. ADD changes prepared armor
 * AC, keeping its source value and magic bonus intact when repaired or traded.
 */
export function damageEffectData(item, stacks, { origin, id = FALLBACK_EFFECT_ID } = {}) {
  if (!Number.isInteger(stacks) || stacks < 1) throw new Error('Armor damage stacks must be a positive integer.');
  const parentUuid = item.actor?.uuid ?? item.parent?.uuid;
  const effectOrigin = origin && origin !== item.uuid ? origin : parentUuid;
  if (!effectOrigin || effectOrigin === item.uuid) throw new Error('Damaged armor needs an actor origin.');
  return {
    _id: id,
    name: `Damaged (${stacks})`,
    img: 'icons/equipment/chest/breastplate-collared-steel.webp',
    type: 'enchantment',
    origin: effectOrigin,
    transfer: false,
    disabled: false,
    changes: [{ key: 'system.armor.value', mode: 2, value: String(-stacks), priority: 20 }],
    flags: { [MODULE_ID]: { kind: DAMAGE_KIND } }
  };
}

function itemsOf(actor) {
  return actor.items?.contents ?? Array.from(actor.items ?? []);
}

function belongsTo(item, actor) {
  return Boolean(actor?.uuid && (item.actor?.uuid ?? item.parent?.uuid) === actor.uuid
    && itemsOf(actor).some(owned => owned.id === item.id && owned.uuid === item.uuid));
}

function validateArmor(item, actor) {
  if (!actor?.isOwner || !item?.isOwner) throw new Error('You do not have permission to change this armor.');
  if (!belongsTo(item, actor)) throw new Error('Select armor from this character\'s inventory.');
  if (!isArmor(item)) throw new Error('Only body armor can be damaged or repaired. Shields are excluded.');
  if (Number(item.system?.quantity ?? 1) !== 1) {
    throw new Error('Split this armor stack into individual items first.');
  }
}

/** Prefer the armor dnd5e actually selected for AC, then another equipped suit. */
export function equippedArmor(actor) {
  if (!actor) return null;
  const owned = itemsOf(actor);
  const prepared = actor.system?.attributes?.ac?.equippedArmor;
  const selected = typeof prepared === 'string'
    ? owned.find(item => item.id === prepared || item.uuid === prepared)
    : owned.find(item => item === prepared || (prepared?.uuid && item.uuid === prepared.uuid));
  const eligible = item => Boolean(item && isArmor(item) && item.system?.equipped === true);
  return eligible(selected) ? selected : owned.find(eligible) ?? null;
}

function serialize(actor, action) {
  const key = actor?.uuid ?? actor;
  const previous = pending.get(key) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(action);
  pending.set(key, result);
  // Attach both outcomes without creating an unhandled rejected cleanup promise.
  const cleanup = () => { if (pending.get(key) === result) pending.delete(key); };
  result.then(cleanup, cleanup);
  return result;
}

function nextEffectId(effects) {
  const existing = effects.find(isDamageEffect);
  if (existing?._id) return existing._id;
  if (!effects.some(effect => effect._id === FALLBACK_EFFECT_ID)) return FALLBACK_EFFECT_ID;
  // A different effect already owns our normal stable ID. Preserve it.
  return foundry.utils.randomID();
}

/** Apply one confirmed critical-hit event to an owned armor item. */
export function damageArmor(item, { stacking = false, eventId, origin } = {}) {
  const actor = item?.actor ?? item?.parent;
  return serialize(actor, async () => {
    validateArmor(item, actor);
    const state = armorDamageState(item);
    const event = typeof eventId === 'string' && eventId.trim() ? eventId.trim() : null;
    // The character may change armor between confirming a critical hit and
    // applying its damage card. That same hit must not damage the replacement.
    if (event) {
      const alreadyDamaged = itemsOf(actor).find(owned => isArmor(owned) && armorDamageState(owned).events.includes(event));
      if (alreadyDamaged) return alreadyDamaged;
    }
    const stacks = stacking ? state.stacks + 1 : Math.max(1, state.stacks);
    const effects = effectsOf(item);
    const effect = damageEffectData(item, stacks, { origin, id: nextEffectId(effects) });
    const events = event ? [...state.events, event].slice(-MAX_EVENTS) : state.events;
    return item.update({
      effects: [...effects.filter(effect => !isDamageEffect(effect)), effect],
      [`flags.${MODULE_ID}.damageStacks`]: stacks,
      [`flags.${MODULE_ID}.damagedEvents`]: events
    });
  });
}

/**
 * Called only after the tool UI confirms completion of an hour's work.
 * Validate the whole selection before a single embedded-document batch write.
 * Event history is retained so a duplicate old workflow cannot damage it again.
 */
export function repairArmors(items, actor) {
  const selected = Array.from(items ?? []);
  return serialize(actor, async () => {
    if (!actor?.isOwner) throw new Error('You do not have permission to repair this character\'s armor.');
    if (selected.length < 1 || selected.length > 6) throw new Error('Select between one and six pieces of armor.');
    if (new Set(selected.map(item => item?.uuid)).size !== selected.length) {
      throw new Error('Select each piece of armor only once.');
    }
    for (const item of selected) validateArmor(item, actor);
    const updates = selected.map(item => ({
      _id: item.id,
      effects: effectsOf(item).filter(effect => !isDamageEffect(effect)),
      [`flags.${MODULE_ID}.damageStacks`]: 0
    }));
    return actor.updateEmbeddedDocuments('Item', updates);
  });
}
