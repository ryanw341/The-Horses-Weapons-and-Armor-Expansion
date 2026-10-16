import { MODULE_ID } from './rules.js';
import { registerSettings, openSettings } from './settings.js';
import { registerTools } from './tools.js';
import { registerCombat } from './combat.js';
import { registerEffects, refreshDerivedState } from './effects.js';
import { registerTargetActions, confirmCriticalArmor } from './target-actions.js';
import { openWeaponTools, openArmorTools, openPatternActions } from './workbench.js';
import { cleanupRuntime } from './shared.js';

export function preflight() {
  if (game.system.id !== 'dnd5e') throw new Error("The Horse's Weapons and Armor Expansion requires D&D 5e.");
  if (!globalThis.libWrapper || !game.modules.get('lib-wrapper')?.active) throw new Error('Enable libWrapper and reload the world.');
  if (!/^5\.3\./.test(game.system.version))
    throw new Error('This release targets D&D 5e 5.3.x. The installed system version is not supported; combat automation was not enabled.');
  if (typeof globalThis.foundry?.applications?.api?.DialogV2?.wait !== 'function') throw new Error('Foundry DialogV2 is unavailable.');
  if (typeof CONFIG.Dice?.DamageRoll?.buildEvaluate !== 'function') throw new Error('The expected D&D 5e damage roll API is unavailable.');
  if (typeof CONFIG.Token?.objectClass?.prototype?._getVisionSourceData !== 'function') throw new Error('The expected Foundry token vision API is unavailable.');
  let prototype = CONFIG.ActiveEffect?.documentClass?.prototype, descriptor;
  while (prototype && !descriptor) { descriptor = Object.getOwnPropertyDescriptor(prototype, 'isSuppressed'); prototype = Object.getPrototypeOf(prototype); }
  if (!descriptor?.get) throw new Error('The expected D&D 5e effect suppression API is unavailable.');
}

Hooks.once('init', () => {
  if (game.system.id === 'dnd5e') registerSettings();
});

Hooks.once('ready', () => {
  try {
    preflight();
    registerEffects();
    registerCombat();
    registerTargetActions();
    refreshDerivedState();
    registerTools({ openWeaponTools, openArmorTools, openPatternActions });
    game.modules.get(MODULE_ID).api = { openSettings, openWeaponTools, openArmorTools, openPatternActions, confirmCriticalArmor };
    console.info(`${MODULE_ID} | Tool workbenches, weapon patterns, and armor rules ready.`);
  } catch (error) {
    cleanupRuntime();
    console.error(`${MODULE_ID} | Startup failed`, error);
    ui.notifications.error(error.message, { permanent: true });
  }
});
