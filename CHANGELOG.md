# Changelog

All notable changes to this system are documented in this file.

## [1.1.5] - 2026-11-27

### Added
- Feat prerequisites can now be combined with "and" as well as "or". Every prerequisite row on the feat sheet (attribute, feat, or custom) has an and/or connector, and the rule is the same for every kind of row: rows are read from top to bottom and a row's connector combines it with everything above it, so "Agility 5, or Might 5, and Battlefield Retribution" reads "(Agility 5 or Might 5) and Battlefield Retribution".
- Prerequisite rows can be grouped: tick "group with row above" to bracket rows of any kind together. A group is worked out on its own first, then combined with the rest, which makes requirements like "(Agility 5 and Might 5) or (Logic 6 and Lethal Strike II)" possible. Each tier shows a "Reads:" line with the result, and an info icon next to the Prerequisite button explains the rules.
- Prerequisite rows stay in the order they were added, whatever their type. A custom (free-text) prerequisite cannot be checked automatically, so it is listed for the GM to judge and never changes whether the feat counts as met.
- "Review Feat Prerequisites" (system settings, GM only): lists the feats in the world (Items sidebar, characters, alternate forms, unlinked tokens, world compendiums) whose prerequisites were saved before grouping existed and now read differently, showing how each read before and how it reads now. Nothing is converted automatically, since only the feat's author knows what was meant: open each feat to edit it, or keep it as it reads now. The list opens by itself the first time a GM logs in after the update if any such feat exists.
- Feat prerequisites of type "Feat" are now picked from a list of the system's feats and the world's non-private feats (plus an optional minimum tier) instead of typed as free text.

### Fixed
- Mimic (Alteration 4 and Deception 3) and Two Weapon Brute (Agility 4 and Might 5) now require every listed attribute instead of any one of them. Copies already in a world (on characters, in alternate forms, in the Items sidebar) are corrected automatically the first time a GM logs in, unless their prerequisites were edited (#13).
- Item sheets: the add [+] buttons on the Extraordinary tab (and other row lists) now add a row instead of doing nothing, and no longer wipe the rows already in that list (#14).
- Adventuring Gear now counts toward the inventory's item, heavy, and bulky counters, together with weapons and armor (#15).

## [1.1.4] - 2026-08-12

### Added
- Items created in the world (feats, banes, boons, gear, etc.) are now discoverable by the system's selection lists, with a "Private" checkbox on item sheets to opt out; a world item takes precedence over a same-named compendium entry (#8).
- New "Add" button on the inventory tab opens a dialog for quickly picking compendium items; the previous add button is now named "Create" (#12).
- Feats, banes, and boons can now be fully customized on their sheets — tier costs, prerequisites, and effects are all editable (#7).
- Placing line templates now shows on-screen instructions and a cursor-following progress HUD explaining the Open Legend placement rules (#11).

### Changed
- Item sheets restyled for better readability.

## [1.1.3] - 2026-07-30

### Added
- Dark mode support — the system now respects Foundry's dark theme (#5).
- Single-target or multi-target can now be chosen directly in the roll dialog, with a system setting to toggle the feature on/off (#3).
- System setting to unlock damage type restrictions on attributes (#9).
- Automated Foundry VTT package publishing when a release tag is pushed.

## [1.1.1] - 2026-07-29

### Added
- Perks and flaws can now be created and edited directly on the character sheet, and their restrictions have been loosened.
- Banes and boons can be dragged and dropped onto actions.
- Warning when an attribute is raised past its level cap.
- Banes applied from a chat card can now be undone.

### Changed
- Boons no longer require a power level up front — roll for the boon and the power level is derived from the roll, capped at your attribute.
- Mental and social sections on the character sheet swapped positions.

### Fixed
- Attribute rows no longer wrap incorrectly on the character sheet.
- Minimized sheets now resize properly (thanks @TrinitysEnd, #6).

## [1.0.0]

Initial release.
