# Architecture

A hockey adaptation of the original MLB card through the NFL sibling. Distribution remains a HACS **Integration** with a bundled JavaScript card.

## Components

- `config_flow.py`: one team per entry, duplicate rejection, six configurable game-event actions.
- `coordinator.py`: ESPN data, bounded caches, schedule selection, hockey normalization, navigation, events.
- `const.py` / `types.py`: verified team IDs, polling policies, card-facing shapes.
- `sensor.py`: event ID and normalized attributes; large live payloads excluded from recorder.
- `__init__.py`: setup/unload, exact-file static routes, resource registration, authenticated WebSockets.
- `nhl-live-game-card.js`: scoreboards, goalies/leaders, period plays, rink/shot display, standings, popups, editor.

## Data flow

The coordinator selects a club's live game, recent final, or upcoming event and combines its summary with team, roster, standings, and player data. The sensor and game navigation use the same attribute builder. Period browsing changes only the requesting card, never the live sensor or event actions.

WebSocket commands under `nhl_live_scoreboard`: `game_at_offset`, `period_at_offset`, `player_card`, `team_season_stats`. Entity navigation resolves the correct config entry. Athlete IDs and batch sizes are validated. Player strings are escaped; optional fields remain absent instead of invented.

## Hockey semantics

Three regulation periods precede overtime. Shootouts use feed metadata, not merely a fifth period: postseason games can have multiple overtimes. Goals, shots, goalies, skater stats, overtime losses, and points use hockey fields. No football downs, yards, drives, or timeouts remain.

Optional strength/empty-net and coordinates render only when available. Goalie/roster fallbacks do not confirm a starting lineup. Season/career tables are current fetched data, not historical snapshots.

## Lifecycle and coexistence

Setup copies the module into `www/community/nhl_live_scoreboard` when writable and registers its versioned `/hacsfiles/nhl_live_scoreboard/nhl-live-game-card.js` URL. An exact-file fallback at `/nhl_live_scoreboard/nhl-live-game-card.js` also works; Python source directories are not exposed.

Storage-managed resources are created/updated; YAML-managed resources need manual setup. Refresh the browser after setup to load the module. No dashboard cards are automatically placed. MLB/NFL/NHL have separate domains, elements, popup caches/styles, resources, and event names.

## Event safety

First refresh/reload and new games establish baselines. Scores must be present and plausible; corrections, rebounds, and stale gaps do not replay celebrations. Lifecycle events are de-duplicated. Options actions use Home Assistant's script validation and expose event fields as template variables.

## Tests and releases

Python/Node tests cover normalization, caching, events, card rendering, navigation, and registration. Real HA testing is separate; import-stub tests do not prove installation success.

HACS installs the tagged source tree. Workflows: Tests, Hassfest, HACS Integration validation, release-please. Versions live in the manifest, release-please manifest, and marked card version. Tags start at `v1.0.0`. The original MIT notice and @johnbr attribution remain.
