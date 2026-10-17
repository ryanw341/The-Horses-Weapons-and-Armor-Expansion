# Changelog

## 0.1.2

- Fix the Configure tools and armor rules button failing before its window opens. The registered settings dialog now supplies its content and buttons during construction, as Foundry 14 requires.
- Keep the settings form open and restore its buttons after invalid tool UUIDs or failed saves, so the GM can correct and resubmit.
- Add regression coverage for Foundry's actual registered-menu construction/render path, saving, drag/drop listener attachment, and validation recovery.

## 0.1.1

- Add an optional Midi-QOL 14.0.x adapter, checked against the 14.0.9 source, for confirmed critical hits and attributed damage application.
- Deduplicate armor damage across workflow completion, damage parts, HP reapplication, and manual confirmation, including zero-damage critical hits.
- Resolve Kantreal before Midi checks hits, and keep its retry within the existing workflow.
- Retain Phobos and damage-conversion evidence on Midi cards; a Phobos miss clears damage pools and prevents armor damage.
- Make Tsun-Jin's weapon benefit set the critical threshold to 19 without stacking with Champion or overriding a lower threshold.
- Document remaining Midi limitations, including Noctis NPC death handling, earlier external hit macros, and automatic disadvantage from other modules.
- Kantreal remains 11+ by default, and armor repairs require tool proficiency by default.

## 0.1.0

- Link Weapon Tools and Armor Tools by UUID, drag/drop, or world-item picker.
- Add inventory tool activities with proficiency checks and weapon modification menus.
- Include all supplied ranged and melee patterns, reversible item effects, and pattern action controls.
- Add item-local Damaged armor effects, configurable stacking, and one-hour repairs for up to six armor items.
- Integrate core D&D 5e attack and damage rolls for fumbles, damage conversion, Phobos, Noctis, critical thresholds, and attributed armor damage.
- Provide explicit controls for target adjudication, action costs, attack conditions, and shared burst rolls.
- Add Equipment Limits interoperability for Accatran through its 0.3.2 update.
- Include automated regression tests; live Foundry and Midi-QOL validation remain pending.
