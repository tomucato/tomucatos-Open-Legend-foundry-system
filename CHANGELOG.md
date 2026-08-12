# Changelog

All notable changes to this system are documented in this file.

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
