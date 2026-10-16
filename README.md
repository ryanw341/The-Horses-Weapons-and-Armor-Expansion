# The Horse's Weapons and Armor Expansion

Weapon patterns, proficient tool workbenches, and item-based armor damage for Foundry VTT and D&D 5e.

## Install and configure

Install using this manifest URL:

```text
https://raw.githubusercontent.com/ryanw341/The-Horses-Weapons-and-Armor-Expansion/main/module.json
```

Requires **Foundry 14**, **D&D 5e 5.3.3 / 5.3.x**, and **libWrapper**. This release targets the core D&D 5e roll and damage workflows. D&D 5e 6.x and Midi-QOL workflows have not been verified; this module does not claim compatibility with them. Live Foundry visual and multiplayer testing remains necessary.

1. Enable the module and libWrapper, then reload the world.
2. Open **Configure Settings > The Horse's Weapons and Armor Expansion > Configure tools and armor rules**.
3. Set **Weapon Tools** and **Armor Tools** by pasting a UUID, dropping a Tool item onto the field, or choosing a world Tool item from the dropdown. Compendium items work by UUID/drop.
4. Enable **Armor Degradation** if wanted and choose whether damage stacks. Choose whether armor repairs require proficiency.
5. Save. Inventory copies of the linked tools receive an additional activity. Their existing activities remain intact.

Tool identity uses source UUIDs, including world/compendium copies. Identical names alone do not establish a match. If an old custom inventory item has no source information, configure that item's own UUID or replace it with a copy of the configured source. Full proficiency or expertise qualifies; half proficiency does not.

## Modify a weapon

Use the configured Weapon Tools on a character sheet and choose **Modify / repair weapon**. An untrained user gets a proficiency message. Drop a weapon from that character's inventory into the workbench, or select it from the dropdown.

The menu shows the current pattern, its benefit and tradeoff, and the patterns available for that weapon. Melee/ranged classification follows The Horse's Equipment Limits custom weapon assignments when present, then D&D 5e's assignments. Natural or unclassified weapons are excluded.

Choose a pattern and apply it. Each weapon has one pattern. **Imperial** removes the pattern. Only this module's effects and activity are replaced; original weight, range, properties, unrelated effects, and normal attacks are retained. Pattern changes never repair a jammed or damaged weapon.

Modified weapons gain a **Pattern actions** activity. Use this for maintenance, firing modes, attack conditions, and effects that require a player or GM choice. Pattern application itself has no added time or material cost because the supplied rules specify none.

## Armor degradation

When enabled, applying attributed critical attack damage through D&D 5e's damage tray adds **Damaged (N)** to the target's equipped body armor. Automatic degradation applies to player-owned **character** actors. Shields, clothing, and other equipment are excluded.

The effect is stored on the armor and reduces its prepared armor AC by one per stack. Its base AC is untouched. Unequipping it removes its contribution to the character's AC; equipping different armor uses that armor's condition. Damage remains with the item when copied or transferred.

Without stacking, further critical hits do not add another penalty. Turning stacking off does not erase existing stacks. Turning degradation off stops new automatic damage; it does not repair existing damage.

Critical attack chat cards also have **Confirm critical hit: damage armor** for hits resolved outside the damage tray, including immunity. Select only characters actually hit. The same attributed attack is deduplicated when its damage is later applied. **Resolve a Phobos reroll first**, since rolling a 1 on that damage die makes the attack miss. Manual HP edits carry no attack information and cannot trigger automatic degradation.

Use Armor Tools to select up to **six individual armor items**, then confirm completion of **one hour** of work. All damage stacks on those selected items are removed. This confirms time spent and posts a record; it does not advance the world clock. Split armor stacks with quantity greater than one into individual items before damaging or repairing them. Move another character's armor into the repairing character's inventory first.

## Pattern behavior

All eleven ranged patterns and eleven melee patterns are included with their supplied descriptions.

| Pattern | Implemented behavior and choices |
| --- | --- |
| Imperial | Removes pattern modifications. Existing jams/damage still require maintenance. |
| Noctis, ranged | Attributed damage reducing a target to 0 HP makes it unconscious and clears newly applied death status. The GM still adjudicates unusual death mechanics and manually resolved damage. |
| Kantreal | Natural 1 rolls a confirmation d20. Another 1 jams the weapon; a qualifying result offers a fresh attack roll. The GM chooses **10+ or 11+** in settings, default 11+. A retry uses the ordinary ammunition workflow. Mend the jam with one action. |
| Lucius | Target an eligible recipient and use Pattern actions to request carryover damage. Enter the leftover damage and its type. The GM confirms the kill, direction/flanking, recipient, and any split damage types. Allies can receive it. |
| Accatran | Weight is halved. With **Equipment Limits 0.3.2+**, equipment cost changes 2 to 1 or 1 to 0.5; already-half-slot weapons remain 0.5. A natural 1 unequips the weapon and announces it was dropped; place it on the map manually. |
| Triplex, ranged | Change mode through Pattern actions, declaring the bonus action. Energized converts up to the first three damage points to lightning without adding damage. Scoped applies -5 for a declared long-range shot. Burst uses one shared attack roll and announces the committed attack count; resolve damage for each hit and extra ammunition manually. Natural 1 locks special modes until one action is spent recalibrating. Standard firing remains available. |
| Kalibrax | Weight increases by 50%. Its declared underwater disadvantage is suppressed; unrelated disadvantage remains. |
| Mezoa, ranged | Both ranges are halved. Its declared hostile-proximity disadvantage is suppressed; unrelated disadvantage remains. |
| Phobos, ranged | Before damage is posted, optionally pick one ordinary additive damage die to reroll. The new result is mandatory; 1 changes that attack's damage to zero and marks it a miss. Enforced once per combat turn for that weapon. Outside combat or with nonlinear/modified dice, a visible notice requests manual resolution. Original rolls and the reroll are retained in message flags and explained on the card. |
| Vortannis, ranged | Doubles normal range, capped by long range. Long range stays unchanged. Declare hostile-proximity disadvantage out to 10 feet. Reapply this pattern after changing another enchantment that changes its range cap. |
| Mars, ranged | Adds a separate +1 necrotic damage component. Use **Begin Attack action** once for the entire Attack action to take 1 necrotic damage, including all Extra Attacks. A separate Attack action requires another payment. Individual attack rolls do not charge it automatically. |
| Sunfury, melee | Converts up to the first three damage points to fire. A natural 1 asks whether to drop the weapon or take 1d4 fire damage. |
| Tigrus, melee | Equipped weapon applies -1 AC. After a confirmed miss, select the attack and request damage equal to its ability modifier, minimum 0. No extra damage dice or bonuses are added; reductions apply and the final amount is capped at the modifier. |
| Magnacore, melee | After confirming a hit, declare a reaction and request ignition. The target owner/GM chooses prone or 1d6 fire damage. Natural 1 uses the same overheat choice as Sunfury. |
| Umbra-Ferrox, melee | After confirming a critical hit, request blindness. The module removes its own blinded effect after the target's next turn ends; outside combat it requires manual removal. While equipped, darkvision sense range becomes zero and standard Foundry darkvision is suppressed without rewriting token settings. Custom vision modules/modes need separate verification. |
| Mercurian, melee | Adds Thrown with 30/60-foot range. A thrown natural 1 marks it damaged and blocks further attacks until 10 minutes with proficient Weapon Tools are confirmed. |
| Tsun-Jin, melee | Lowers the weapon's effective critical threshold by one. Attacks targeting exactly one creature with an equipped Tsun-Jin weapon also lower their threshold by one. Different defenders with different thresholds must be resolved separately. |

Target effects create a reviewable chat request. The active GM resolves it, or an active owner when no GM is connected. The module does not silently edit creatures the acting player does not own. Request and armor event IDs prevent repeat applications.

**Attack conditions:** use Pattern actions before the next attack to declare long range, underwater disadvantage, hostile proximity, or burst count. Those declarations clear after an actual roll. Keep unrelated advantage/disadvantage in the normal roll dialog. The module does not infer swimming exemptions, hostile incapacitation, cover, flanking, or facing from token placement.

**Action economy:** action, bonus action, reaction, repair time, and available burst attacks are player declarations recorded by the controls. The module does not infer Extra Attack, Action Surge, Haste, or reactions from individual attack rolls. A shared burst roll is not an automatic multiattack workflow.

## Compatibility and validation

The Horse's Equip Messages continues to see normal equip changes. Paper Doll Sync continues to display one item per square and fill overflow. Equipment Limits 0.3.2 includes the required Accatran cost integration, including blocking a pattern change that would newly exceed capacity in block mode.

Automated tests cover rule calculations, reversible item effects, source UUIDs/proficiency, menu actions, critical attribution, damage conversion, repair batching, ownership, and turn expiration. API contracts were checked against the official D&D 5e 5.3.3 source and Foundry 14 APIs. Tests simulate Foundry documents; they do not replace a live world test.

With Node.js 22+ and Python 3:

```sh
npm run check
npm test
npm run package
```

Release files are built in `dist/`. No vendor source, private world data, or reference downloads are included.
