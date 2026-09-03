# Changelog

## [1.1.0](https://github.com/julianrinaldi/nhl-live-scoreboard/releases/tag/v1.1.0) (2026-09-03)

### Features

- Add the optional per-card `show_within_hours` setting in the visual editor and YAML. For example, `24` hides the card until the team's next game is within 24 hours; live games remain visible.
- Expose an independent, validated `next_game_start` timestamp so recent final scores and schedule navigation do not interfere with the visibility rule.
- Hidden cards automatically reappear without a dashboard refresh or extra ESPN polling. Native Home Assistant visibility handling removes the card from the layout while preserving updates.
- Keep the existing behavior by default (`0` or blank), allow fractional hours, and keep editing previews and unavailable-entity diagnostics accessible.

After updating in HACS, restart Home Assistant and refresh the dashboard once to load the new integration and bundled card.

## [1.0.0](https://github.com/julianrinaldi/nhl-live-scoreboard/releases/tag/v1.0.0) (2026-09-03)

### Features

- Initial NHL adaptation retaining the compact/expanded card, visual editor, player career and team Game/Season popups.
- Hockey periods, overtime/shootouts, intermissions, goalies, shots, scoring plays, and period navigation.
- All 32 current clubs, including Utah Mammoth, and division standings.
- Six NHL game events and configurable Home Assistant actions.
- HACS Integration packaging with a bundled automatically registered card.

### Attribution

Modified from [@johnbr's MLB Live Scoreboard](https://github.com/johnbr/mlb-live-scoreboard), through the [NFL adaptation](https://github.com/julianrinaldi/nfl-live-scoreboard). The original MIT notice is preserved. NHL versions start independently at 1.0.0.
