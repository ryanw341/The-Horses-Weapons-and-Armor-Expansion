import { MODULE_ID } from './rules.js';

export const defaults = () => ({ weaponToolsUuid: '', armorToolsUuid: '', armorDegradation: false,
  stackArmorDamage: false, repairRequiresProficiency: true, kantrealMinimum: 11 });

export function getConfig() { return { ...defaults(), ...game.settings.get(MODULE_ID, 'rules') }; }
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[c]);
export function ownedItem(activity) {
  const actor = activity?.actor ?? activity?.item?.actor;
  return actor?.items?.get(activity?.item?.id) ?? null;
}
export function report(error) {
  console.error(`${MODULE_ID} |`, error);
  ui.notifications.warn(error.message ?? String(error));
}
export function run(promise) { return Promise.resolve(promise).catch(report); }
const runtimeHooks = [];
export function on(name, listener) {
  const id = Hooks.on(name, listener);
  runtimeHooks.push({ name, id });
  return id;
}
export function cleanupRuntime() {
  for (const { name, id } of runtimeHooks.splice(0)) Hooks.off(name, id);
  globalThis.libWrapper?.unregister_all?.(MODULE_ID);
}
export function announce(actor, content) {
  return ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<div class="hwa-chat">${content}</div>` });
}

export async function formDialog(title, content, buttons, { width = 620, onRender } = {}) {
  class ExpansionDialog extends foundry.applications.api.DialogV2 {
    async _onRender(context, options) {
      await super._onRender(context, options);
      onRender?.(this.element, this);
    }
  }
  return ExpansionDialog.wait({ window: { title }, position: { width }, content,
    buttons, rejectClose: false, modal: false });
}

export function choose(title, content, buttons) {
  return formDialog(title, content, buttons.map(button => ({ ...button, callback: () => button.action })));
}

export function isWriter(actor) {
  if (game.users.activeGM) return game.user.id === game.users.activeGM.id;
  return [...game.users].filter(user => user.active && actor.testUserPermission(user, 'OWNER'))
    .sort((a, b) => a.id.localeCompare(b.id))[0]?.id === game.user.id;
}
export function inventories() {
  const actors = new Map([...game.actors].map(actor => [actor.uuid, actor]));
  for (const scene of game.scenes ?? []) for (const token of scene.tokens ?? []) {
    if (token.actor) actors.set(token.actor.uuid, token.actor);
  }
  return [...actors.values()];
}
