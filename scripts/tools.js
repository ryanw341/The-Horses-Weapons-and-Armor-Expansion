import { MODULE_ID, toolIdentityMatches, isToolProficient } from './rules.js';
import { on, getConfig, isWriter, inventories, run, ownedItem } from './shared.js';

export const TOOL_ACTIONS = {
  weaponTools: { id: 'horseWeaponTools', field: 'weaponToolsUuid', name: 'Modify / repair weapon' },
  armorTools: { id: 'horseArmorTools1', field: 'armorToolsUuid', name: 'Repair armor (1 hour)' }
};
export function requireTool(tool, kind, { proficiency = true } = {}) {
  if (!tool?.actor?.isOwner || !tool.isOwner || !tool.actor.items.has(tool.id)) throw new Error('Use a tool in a character inventory you own.');
  if (!toolIdentityMatches(tool, getConfig()[TOOL_ACTIONS[kind]?.field])) throw new Error('This is not the configured tool. Check the module settings.');
  if (proficiency && !isToolProficient(tool)) throw new Error(`You don't have proficiency with ${tool.name}.`);
  return tool;
}
export function utilityActivity(id, name, action) {
  return { _id: id, type: 'utility', name, flags: { [MODULE_ID]: { action } },
    activation: { type: 'special', value: null }, consumption: { targets: [], spellSlot: false },
    roll: { formula: '', name: '', prompt: false, visible: false } };
}
export function toolActivityUpdates(item, config = getConfig()) {
  if (item.type !== 'tool') return {};
  const updates = {}, source = item._source?.system?.activities ?? {};
  for (const [action, entry] of Object.entries(TOOL_ACTIONS)) {
    const current = source[entry.id];
    const ours = current?.flags?.[MODULE_ID]?.action === action;
    if (toolIdentityMatches(item, config[entry.field])) {
      if (!current) updates[`system.activities.${entry.id}`] = utilityActivity(entry.id, entry.name, action);
      else if (!ours) throw new Error(`Activity ID collision on ${item.name}; existing action was preserved.`);
    } else if (ours) updates[`system.activities.-=${entry.id}`] = null;
  }
  return updates;
}
const pending = new Map();
export function syncToolActor(actor) {
  if (!actor || actor.documentName !== 'Actor' || actor.pack || !isWriter(actor)) return Promise.resolve();
  const prior = pending.get(actor.uuid) ?? Promise.resolve();
  const work = prior.catch(() => {}).then(async () => {
    const updates = [...actor.items].map(item => ({ _id: item.id, ...toolActivityUpdates(item) })).filter(update => Object.keys(update).length > 1);
    if (updates.length) await actor.updateEmbeddedDocuments('Item', updates, { [MODULE_ID]: { toolsSync: true } });
  });
  pending.set(actor.uuid, work);
  work.finally(() => { if (pending.get(actor.uuid) === work) pending.delete(actor.uuid); }).catch(() => {});
  return work;
}
export function registerTools({ openWeaponTools, openArmorTools, openPatternActions }) {
  const syncAll = () => { for (const actor of inventories()) run(syncToolActor(actor)); };
  on(`${MODULE_ID}.syncTools`, syncAll);
  on('createItem', (item, options) => {
    if (!options?.[MODULE_ID]?.toolsSync) run(syncToolActor(item.actor));
  });
  on('updateItem', (item, changes, options) => {
    if (!options?.[MODULE_ID]?.toolsSync) run(syncToolActor(item.actor));
  });
  on('createActor', actor => { run(syncToolActor(actor)); });
  on('dnd5e.preUseActivity', activity => {
    const action = activity.flags?.[MODULE_ID]?.action;
    if (!['weaponTools', 'armorTools', 'patternActions'].includes(action)) return;
    const item = ownedItem(activity);
    run(Promise.resolve().then(() => {
      if (action === 'weaponTools') return openWeaponTools(requireTool(item, action));
      if (action === 'armorTools') return openArmorTools(requireTool(item, action, { proficiency: getConfig().repairRequiresProficiency }));
      if (!item?.isOwner) throw new Error('You do not own this weapon.');
      return openPatternActions(item);
    }));
    return false;
  });
  syncAll();
}
