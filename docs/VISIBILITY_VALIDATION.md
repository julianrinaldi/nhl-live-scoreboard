# Version 1.1.0 visibility-window validation

Validated September 3, 2026. The opt-in `show_within_hours` setting preserves the existing card behavior when omitted, blank, or zero.

## Automated checks

- 130 Python and 47 JavaScript tests pass, together with Ruff, JavaScript syntax, and whitespace checks.
- Schedule metadata uses the configured team's next eligible start, independently of a retained final or browsed game. Tests cover timezone offsets, invalid/TBD dates, cancellations/postponements, fresh-summary overrides, and the bounded pending-start grace interval.
- Card tests cover the inclusive hours boundary, live-game exceptions, final/no-game hiding, fractional and invalid input, editor/diagnostic visibility, per-card configuration, hidden-card lifecycle, and automatic reappearance with local refresh disabled.

## Isolated Home Assistant acceptance

All three updated integrations were loaded together in a disposable Home Assistant 2026.9.0 instance, bound only to localhost. The user's production Home Assistant, devices, dashboards, and automations were not changed.

- The real NFL, NHL, and NBA sensors expose UTC `next_game_start` values from the current team schedules.
- Each registered resource uses version 110 and its served JavaScript matches the tested source byte for byte.
- Synthetic timing applied to archived game fixtures verifies far-away and absent games hide all three cards, games within 12 hours appear, live games stay visible, and a final hides unless the next game qualifies.
- With `refresh_rate: 0`, all three cards remained mounted while hidden and automatically appeared when a test boundary arrived 10 seconds later, without a dashboard refresh or another game-state update.
- Native Home Assistant wrappers become hidden and have zero height in Sections, masonry, and vertical-stack layouts.
- Dashboard editing keeps previews accessible. Saving zero hours through the visual editor restores that card independently of the other cards.

These are explicit synthetic-time/archived-data UI tests, not a claim that broadcasts were live. Feed updates still depend on ESPN and normal integration polling. After installing this release through HACS, restart Home Assistant and refresh the dashboard once to load the new code.
