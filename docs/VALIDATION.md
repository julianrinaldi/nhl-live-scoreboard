# v1.0.0 Release Validation

Validated September 3, 2026. The NHL implementation is based on the NFL adaptation of @johnbr's MLB Live Scoreboard v1.28.2. The NHL checks below were performed independently; the sibling's results were not used as proof.

## Automated checks

- All **104 Python** and **40 JavaScript** regression tests pass. Python tests use frozen real ESPN regulation, overtime, shootout, team, schedule, and athlete fixtures plus explicit edge-case variants.
- Coverage includes 32-team mapping, NHL season boundaries, period clocks, shot/penalty types, official shootout totals, goalie/skater statistics, missing fields, cache outages, score corrections, event baselines, action validation, resource registration, and MLB/NFL coexistence.
- JavaScript tests cover card/editor defaults, missing states, expansion, goalies, intermissions, period/SO distinctions, historical clock/score isolation, machine-key statistics, career/team popups, asynchronous navigation, stale responses, keyboard behavior, teardown, and bounded play-list scroll/focus preservation.
- Repository-wide Ruff and JavaScript syntax checks pass.

Run locally:

```sh
python -m pip install pytest pytest-asyncio ruff
ruff check .
pytest tests/ -q
node --check custom_components/nhl_live_scoreboard/nhl-live-game-card.js
node --test tests/test_card.cjs
```

## Real Home Assistant acceptance

Tested inside a disposable Home Assistant **2026.9.0**, Python **3.14.3**, with matching frontend **20260826.4**, bound only to localhost. The user's existing Home Assistant, dashboards, devices, and automations were not changed.

- Real team config flow, invalid-team and duplicate-team rejection, and available NHL sensor using current public ESPN data.
- Live upcoming-season acceptance selects NYR at New Jersey on **September 21, 2026, 7:00 PM Eastern** (event `401879645`). A captured-response regression covers ESPN's stale generic 2026 offseason metadata accompanying the actual 2027 schedule, including absent/stale requested-season fields.
- Options save/clear, a harmless test-only scoring action, and correctly rendered script template variables.
- Automatic module registration; preferred/fallback URLs return the exact bundled JavaScript. Python source files are not exposed by the static route.
- Authenticated game/period navigation and player career/season WebSockets, including malformed-ID rejection.
- Unload/reload without duplicate resources; NFL and NHL integrations loaded together with distinct resources and sensors.
- Actual frontend rendering of expanded hockey scores, goalie portraits, rink diagram, SOG, player career popup, Game/Season statistics, intermission leaders, and final scoring/standings panels. Final date markers identify overtime and shootout results without changing the regulation-final layout.
- A full 94-play period remains available in a bounded, keyboard-scrollable newest-first panel. Narrow-screen rendering was visually checked at a 360px browser viewport.

The fixture game NYR at Dallas finished **0–2 on April 11, 2026**. Live/intermission screens were explicitly labelled visual replays with final-game aggregate statistics, not second-by-second reconstructions. The scoreless Rangers have no scoring leaders in ESPN's response, so their intermission view correctly retains the goalie fallback; the Dallas replay verifies the three-leader panel.

## Limits

No currently live NHL broadcast was available for acceptance. ESPN interfaces are unofficial; latency, availability, and optional situations/coordinates vary. Missing starters and team-specific power-play/empty-net attribution are not guessed. Season and career tables reflect available fetched data rather than historical snapshots.

HACS installs the tagged source tree as a **custom Integration repository** with its bundled card. A default-store listing is a separate review process and is not claimed. Installation still requires a Home Assistant restart, team setup, dashboard refresh, and adding the card.
