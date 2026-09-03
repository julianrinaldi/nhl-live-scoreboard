# Changelog

## [1.2.0](https://github.com/julianrinaldi/nhl-live-scoreboard/releases/tag/v1.2.0) (2026-09-03)

### Features

- Add per-card `show_after_hours` in the visual editor and YAML. With `show_within_hours: 24` and `show_after_hours: 4`, the card is visible within 24 hours before a game, while live, and for four hours after its recorded finish.
- Expire the post-game window automatically, even with local refresh disabled. Live games and an overlapping next-game window remain visible.
- Derive finish times from explicit ESPN End of Game plays, with a persisted, approximate fallback only for a closely observed live-to-final transition. Dashboard refreshes and integration restarts do not start a new countdown.
- Expose `last_game_end`, `last_game_end_event_id`, and `last_game_end_source`; never estimate a finish from kickoff or a later data modification timestamp.
- Keep existing behavior by default: post-game zero/blank adds no extension, and pre-game zero/blank still means always visible. Automatic game selection and browsing remain unchanged.

Update through HACS, restart Home Assistant, and refresh the dashboard once to load the new bundled card.

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
