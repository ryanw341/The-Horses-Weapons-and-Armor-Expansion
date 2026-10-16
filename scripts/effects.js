import { MODULE_ID } from './rules.js';
import { on, inventories } from './shared.js';

export function hasUmbraEquipped(actor) {
  return [...(actor?.items ?? [])].some(item => item.type === 'weapon' && item.system?.equipped === true
    && item.flags?.[MODULE_ID]?.pattern === 'umbra-ferrox');
}

/** The tradeoffs say equipped, even when a weapon requires attunement that has not been completed. */
export function wornSuppression(wrapped) {
  if (this.flags?.[MODULE_ID]?.kind === 'pattern-worn' && this.parent?.type === 'weapon')
    return this.parent.system?.equipped !== true;
  return wrapped();
}

/** Runtime-only standard darkvision suppression; saved token settings are never rewritten. */
export function umbraVision(data, actor) {
  if (!hasUmbraEquipped(actor) || data.visionMode !== 'darkvision') return data;
  const defaults = globalThis.CONFIG?.Canvas?.visionModes?.basic?.vision?.defaults ?? {};
  return { ...data, ...defaults, radius: 0, visionMode: 'basic' };
}

export function registerEffects() {
  if (typeof CONFIG.Token.objectClass.prototype._getVisionSourceData !== 'function')
    throw new Error('This Foundry version does not expose the expected token vision controls.');
  libWrapper.register(MODULE_ID, 'CONFIG.ActiveEffect.documentClass.prototype.isSuppressed', wornSuppression, 'MIXED');
  libWrapper.register(MODULE_ID, 'CONFIG.Token.objectClass.prototype._getVisionSourceData', function(wrapped, ...args) {
    return umbraVision(wrapped(...args), this.actor);
  }, 'WRAPPER');
  const refresh = item => {
    if (item.type === 'weapon' && globalThis.canvas?.ready) canvas.perception.update({ initializeVision: true, refreshVision: true });
  };
  for (const event of ['createItem', 'updateItem', 'deleteItem']) on(event, refresh);
}

export function refreshDerivedState() {
  // Run only after every adapter has registered successfully.
  for (const actor of inventories()) if ([...actor.items].some(item => item.flags?.[MODULE_ID]?.pattern)) actor.reset();
  if (globalThis.canvas?.ready) canvas.perception.update({ initializeVision: true, refreshVision: true });
}
