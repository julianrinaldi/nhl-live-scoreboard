# NHL Live Scoreboard / GameTracker

This is an NHL-focused modified version of [MLB Live Scoreboard](https://github.com/johnbr/mlb-live-scoreboard), originally created by [@johnbr](https://github.com/johnbr). It follows the same adaptation and distribution approach as [NFL Live Scoreboard](https://github.com/julianrinaldi/nfl-live-scoreboard) and [NBA Live Scoreboard](https://github.com/julianrinaldi/nba-live-scoreboard).

A Home Assistant custom integration and bundled Lovelace card for live NHL game data from ESPN.

[![HACS](https://img.shields.io/badge/HACS-Custom-blue.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=julianrinaldi&repository=nhl-live-scoreboard&category=integration)
![Version](https://img.shields.io/github/v/release/julianrinaldi/nhl-live-scoreboard?label=version&color=blue)

## Features

- **The same card experience** — compact score rows, expandable live/upcoming/final panels, team logos, responsive portraits, and a visual editor.
- **Hockey tracking** — goals, shots on goal, three periods, overtime, shootouts, and intermissions.
- **Goalie matchup** — portraits and available goalie statistics in the original two-player layout.
- **Period play-by-play** — scoring/penalty indicators, period summaries, and navigation through earlier periods.
- **Game leaders** — hockey player portraits/statistics during intermissions and in final summaries.
- **Player career popup** — click a yellow player name for biography and season-by-season stats, or configure ESPN links.
- **Team stats popup** — click a team's matchup area to switch between Game and Season skater/goalie tables.
- **NHL standings** — division standings with wins, losses, overtime losses, and points.
- **Game-event actions** — run Home Assistant actions for scores, game start/end, wins, and losses.
- **Bundled card** — automatic resource registration after integration setup; no separate card download.

Hockey fields replace baseball/football concepts; unavailable feed data is not invented. See [Data Source](#data-source) and [validation notes](docs/VALIDATION.md).

## Installation

### HACS (Recommended)

This is a **custom Integration repository** for [HACS](https://hacs.xyz/), not a separate Dashboard download or a claimed default-store listing.

1. Open **HACS → ⋮ → Custom repositories**.
2. Add `https://github.com/julianrinaldi/nhl-live-scoreboard` with category **Integration**.
3. Search for **NHL Live Scoreboard** and choose **Download**.
4. Restart Home Assistant.
5. Add your team under **Settings → Devices & Services → Add Integration → NHL Live Scoreboard**.
6. **Refresh your dashboard/browser** to load the newly registered card.
7. Edit your dashboard, choose **Add card**, and search for **NHL Live Game Card**.

[Open this repository in HACS](https://my.home-assistant.io/redirect/hacs_repository/?owner=julianrinaldi&repository=nhl-live-scoreboard&category=integration).

Downloading in HACS alone does not configure a team or place a card on the dashboard. The card is included inside the integration, just like the original project.

### Manual Installation

1. Download a [release](https://github.com/julianrinaldi/nhl-live-scoreboard/releases).
2. Copy `custom_components/nhl_live_scoreboard` into Home Assistant's `config/custom_components/` folder.
3. Restart Home Assistant, add the integration, refresh the dashboard, and add the card as above.

Keep the folder name `nhl_live_scoreboard`. NHL, NFL, and MLB have separate domains, resources, events, and card elements and can coexist.

## Configuration

### Integration Setup

Select a team such as `NYR` for the New York Rangers and optionally set a display name. The sensor will be named like `sensor.nhl_live_scoreboard_nyr`. Add another integration entry for another team; duplicate entries for the same team are rejected.

### Lovelace Card Setup

The card is registered as a **JavaScript Module**, with a version query string for browser cache updates:

```text
/hacsfiles/nhl_live_scoreboard/nhl-live-game-card.js
```

It also works for manual installations without HACS. If copying into `www/community` fails, the integration registers `/nhl_live_scoreboard/nhl-live-game-card.js` instead.

**Visual:** Edit dashboard → Add card → search **NHL Live Game Card**. Choose your NHL sensor and options.

**Equivalent YAML:**

```yaml
type: custom:nhl-live-game-card
entity: sensor.nhl_live_scoreboard_nyr
```

If the card is missing from the picker, refresh the dashboard after setting up the integration. If automatic registration is unavailable, add the URL under **Settings → Dashboards → ⋮ → Resources**, with type **JavaScript Module**, then refresh. For YAML-managed resources, merge this into the existing list:

```yaml
lovelace:
  resources:
    - url: /hacsfiles/nhl_live_scoreboard/nhl-live-game-card.js?v=110
      type: module
```

Do not replace other resources or dashboards.

## Card Configuration Options

| Option | Default | Description |
| --- | --- | --- |
| `entity` | required | NHL scoreboard sensor |
| `title` | `""` | Upstream-compatible; no separate title heading is rendered |
| `refresh_rate` | `0` | Local repaint seconds; does not control feed polling |
| `show_within_hours` | `0` | Optional per-card visibility window; `0` always shows, positive hours show only near the next game or while live |
| `show_matchup` | `true` | Goalie matchup or Game Leaders |
| `show_records` | `true` | Win-loss-overtime-loss records on compact pregame/final cards |
| `show_linescore` | `false` | Period goals and shots on goal in the expanded live view |
| `show_plays` | `true` | Current/selected period play-by-play |
| `show_play_results` | `true` | Goal, penalty, and shot indicators |
| `show_period_summary` | `true` | Selected-period summary |
| `show_strength` | `true` | Strength/power-play and empty-net information when available |
| `show_rink` | `true` | Compact rink diagram; does not infer a live puck position |
| `show_situation` | `true` | Shots-on-goal row; strength information is controlled separately |
| `show_win_probability` | `true` | Probability bar when supplied by ESPN |
| `show_shot_chart` | `false` | Optional selected-period shot locations |
| `show_highlights` | `false` | ESPN highlights link when available |
| `player_link_target` | `popup` | `popup` or `espn` |
| `show_team_stats_popup` | `true` | Team Game/Season popup; player links remain independent |
| `team_stats_default_view` | `auto` | `auto`, `game`, or `season`; auto chooses Game live, Season otherwise |
| `show_schedule_nav` | `true` | Previous/upcoming game navigation |
| `show_period_nav` | `true` | Earlier-period navigation |
| `live_default_view` | `collapsed` | `collapsed` or `expanded` initial live layout |
| `headshot_size` | `auto` | `auto`, `small` (40px), `medium` (56px), `large` (72px), `xlarge` (88px) |

Expansion resets to the configured default for a new game. Schedule navigation returns to the automatically selected game after 60 seconds of inactivity; period navigation returns to the current period after 20 seconds.

### Optional game-time visibility

Set `show_within_hours: 24` to hide this card when the team's next game is more than 24 hours away, or no usable next start is available. It appears automatically as the window opens, without a page refresh, even with `refresh_rate: 0`. The default `0` leaves existing dashboards unchanged. Decimal hours are accepted; the visual editor uses half-hour steps.

Live games, intermissions, and in-progress delays stay visible. A completed game hides unless the next game is within the window; this option changes visibility only, so the normal recent-result display may remain when the card is visible. Browsing another game or period does not change eligibility. Cancelled, postponed, completed, and unknown-time schedule entries are excluded. A scheduled start may remain eligible for up to six hours after its timestamp while awaiting a live/final feed update; a pregame delay is not automatically treated as live.

Hidden cards remain connected and check the boundary at least once per minute while the dashboard is active. Browser background throttling may delay wake-up. The card stays visible in the editor/preview, and missing-entity or unavailable-data messages remain visible for troubleshooting. This is a per-card setting; it does not alter polling, sensors, or automations.

```yaml
type: custom:nhl-live-game-card
entity: sensor.nhl_live_scoreboard_nyr
show_within_hours: 24
```

Period plays are newest-first inside a keyboard-scrollable panel capped at 320px, keeping the dashboard compact while retaining the complete available period history.

```yaml
type: custom:nhl-live-game-card
entity: sensor.nhl_live_scoreboard_nyr
show_linescore: true
show_matchup: true
show_plays: true
show_period_nav: true
live_default_view: expanded
headshot_size: auto
```

## Game Event Actions

Under **Settings → Devices & Services → NHL Live Scoreboard → Configure**, assign action sequences to game events. Events are also fired on the event bus for separate automations.

| Event | Trigger |
| --- | --- |
| `nhl_live_scoreboard_team_scored` | Your team's score increased |
| `nhl_live_scoreboard_opponent_scored` | Opponent's score increased |
| `nhl_live_scoreboard_game_started` | Game became live |
| `nhl_live_scoreboard_game_ended` | Game became final |
| `nhl_live_scoreboard_game_won` | Your team won |
| `nhl_live_scoreboard_game_lost` | Your team lost |

Payloads include `team_abbr`, `team_name`, `team_score`, `opponent_abbr`, `opponent_name`, `opponent_score`, `is_home`, `period`, `clock`, `event_id`, and `status_detail`. Score events also include `score_delta` and available `scoring_play_text`.

The first refresh, a new game, and reload establish baselines without replaying celebrations. Corrections, score rebounds, jumps larger than one goal, and long polling gaps are suppressed. Lifecycle events are de-duplicated. Actions concern the configured club only. Shootout attempts and the final deciding-score bonus do not trigger goal actions; game-ended and win/loss actions use the official final score.

### Event-triggered automation

```yaml
automation:
  - alias: "Notify when the Rangers score"
    triggers:
      - trigger: event
        event_type: nhl_live_scoreboard_team_scored
        event_data:
          team_abbr: NYR
    actions:
      - action: persistent_notification.create
        data:
          title: "Rangers scored!"
          message: "{{ trigger.event.data.scoring_play_text }}"
```

### Action configured in the integration options

For **When my team wins**:

```yaml
- action: persistent_notification.create
  data:
    title: "{{ team_name }} won!"
    message: "Final: {{ team_score }}-{{ opponent_score }} vs {{ opponent_name }}"
```

Options actions use top-level variables such as `team_score`; event automations use `trigger.event.data.team_score`.

## Sensor State Attributes

`next_game_start` is the next usable selected-team schedule start as a UTC ISO timestamp, or `null`. It is independent of the displayed game's date and is derived from the existing schedule cache, without additional polling.

The state is the ESPN event ID, or `idle`. Attributes include `game_active`, `mode`, `is_live`, `status_text`, `competition`, `period_context`, `goalies`, `situation`, `current_period`, `recent_plays`, `scoring_plays`, `team_stats`, `leaders`, and `division_standings`.

Live attributes are excluded from recorder history to avoid large, rapidly changing records. The card reads current state directly.

To show a card only while a game is active, create a Template Binary Sensor helper:

```jinja
{{ state_attr('sensor.nhl_live_scoreboard_nyr', 'game_active') == true }}
```

Use that helper's `on` state in your conditional-card settings.

## Supported Teams

All 32 current clubs, using ESPN abbreviations:

| Abbreviation | Team | Abbreviation | Team |
| --- | --- | --- | --- |
| ANA | Anaheim Ducks | BOS | Boston Bruins |
| BUF | Buffalo Sabres | CGY | Calgary Flames |
| CAR | Carolina Hurricanes | CHI | Chicago Blackhawks |
| COL | Colorado Avalanche | CBJ | Columbus Blue Jackets |
| DAL | Dallas Stars | DET | Detroit Red Wings |
| EDM | Edmonton Oilers | FLA | Florida Panthers |
| LA | Los Angeles Kings | MIN | Minnesota Wild |
| MTL | Montreal Canadiens | NSH | Nashville Predators |
| NJ | New Jersey Devils | NYI | New York Islanders |
| NYR | New York Rangers | OTT | Ottawa Senators |
| PHI | Philadelphia Flyers | PIT | Pittsburgh Penguins |
| SJ | San Jose Sharks | SEA | Seattle Kraken |
| STL | St. Louis Blues | TB | Tampa Bay Lightning |
| TOR | Toronto Maple Leafs | UTAH | Utah Mammoth |
| VAN | Vancouver Canucks | VGK | Vegas Golden Knights |
| WSH | Washington Capitals | WPG | Winnipeg Jets |

## Data Source

Uses unauthenticated [ESPN NHL feeds](https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard). No account or API key is required. These interfaces are **unofficial and undocumented**, not a supported ESPN contract; availability and formats can change.

Polling is every **5 seconds** live, **30 seconds** near a game, and **5 minutes** idle. Broadcast synchronization is not guaranteed. Missing situation, coordinate, probability, or projected-goalie fields remain absent rather than guessed.

Schedules combine available preseason, regular-season, and postseason feeds. A previous result is preferred until 16 hours after scheduled start, then the next game is selected. Navigation is limited to returned events, not an unlimited archive. All-Star/international games do not replace your selected club's games.

Game statistics belong to the selected event. Season/career tables show available regular-season/career data when fetched, **not historical snapshots**. Pregame goalie information is not a confirmed start unless the feed explicitly identifies it. Live goalie displays may fall back to the primary box-score goalie when active-goalie attribution is unavailable.

## Development and Validation

See [ARCHITECTURE.md](ARCHITECTURE.md) and [docs/VALIDATION.md](docs/VALIDATION.md). Workflows retain Tests, Hassfest, HACS validation, and release-please.

```sh
python -m pip install pytest pytest-asyncio ruff
ruff check .
pytest tests/ -q
node --check custom_components/nhl_live_scoreboard/nhl-live-game-card.js
node --test tests/test_card.cjs
```

## License and Attribution

Based on [MLB Live Scoreboard](https://github.com/johnbr/mlb-live-scoreboard) by [@johnbr](https://github.com/johnbr), v1.28.2, commit `acda998cef7d9e8614d4f9a62be7dbb7645e68f4`, through the [NFL adaptation](https://github.com/julianrinaldi/nfl-live-scoreboard). The original [MIT license](LICENSE) is preserved.

NHL versions start independently at `1.0.0`. Team/league marks and player imagery belong to their owners. This community project is not affiliated with or endorsed by the NHL, ESPN, Home Assistant, or HACS.
