# NHL ESPN regression fixtures

Trimmed public ESPN responses captured September 3, 2026. Tests run offline;
fixtures retain actual IDs, numeric values, and ESPN's response structures.

| Fixture | Real event or athlete |
| --- | --- |
| `summary_401803619_final.json` | New York Rangers at Dallas Stars, April 11, 2026; final NYR 0, DAL 2 |
| `summary_401803625_overtime.json` | Vegas Golden Knights at Colorado Avalanche, April 11, 2026 local date; final VGK 3, COL 2 in overtime |
| `summary_401803626_shootout.json` | Vancouver Canucks at San Jose Sharks, April 11, 2026 local date; final VAN 4, SJ 3 in a shootout |
| `athlete_4233875_bio.json`, `_stats.json` | Jason Robertson, left wing; latest retained season 2025–26 |
| `athlete_3151297_bio.json`, `_stats.json` | Igor Shesterkin, goalie; latest retained season 2025–26 |
| `teams_20260903.json` | Current 32 NHL teams, including Utah Mammoth (ESPN ID 129764) |
| `groups_20260903.json` | Current conference/division hierarchy and team IDs |
| `standings_metropolitan_2026.json` | 2025–26 NYI, NJ, and NYR standings rows in ESPN order |
| `schedule_nyr_default_20260903.json` | Actual default NYR response: generic season 2026/offseason, but requested season and 84 scheduled games belong to 2027; first and last games retained |
| `schedule_nyr_preseason_2027.json` | 2026–27 NYR preseason response; first and last of four games retained, beginning September 21, 2026 |
| `schedule_nyr_postseason_2027.json` | Actual empty 2026–27 postseason response with `requestedSeason: null` |

## Source endpoints

- Summary: `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/summary?event={EVENT_ID}`
- Teams: `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams?limit=100`
- Divisions: `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/groups`
- Standings: `https://site.api.espn.com/apis/v2/sports/hockey/nhl/standings?season=2026&seasontype=2`
- Biography: `https://site.web.api.espn.com/apis/common/v3/sports/hockey/nhl/athletes/{ATHLETE_ID}?region=us&lang=en`
- Statistics: `https://site.web.api.espn.com/apis/common/v3/sports/hockey/nhl/athletes/{ATHLETE_ID}/stats?region=us&lang=en`
- Default schedule: `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/nyr/schedule`
- Preseason schedule: `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/nyr/schedule?season=2027&seasontype=1`
- Postseason schedule: `https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/nyr/schedule?season=2027&seasontype=3`

Summary trimming retains headers, per-period scores, final goalie decisions,
game leaders, on-ice data, team statistics, category schemas, and two athlete
rows per category. The plays retain scoring events, overtime/shootout events,
two early shots, and boundary events; unrelated news and media are removed.
The regulation fixture also retains two actual Roughing penalties, whose
penalty type/minutes distinguish them without the literal word "penalty".
Athlete statistics retain category schemas, the final two season rows,
career totals, glossary, and team lookup. Biography retains profile fields.
Schedule fixtures preserve season/requested-season metadata, event IDs, dates,
event seasons, phase fields, and competition status. Unrelated team metadata
and intermediate events are removed. Missing/stale requested-season metadata
and an older first event are explicit synthetic mutations in the tests.

Important feed semantics captured here:

- Play clocks count elapsed period time; scoreboard status clocks count down.
- `shootingPlay` can be true on period-start/end events. A valid shot marker
  requires an actual shot/goal type and valid rink coordinates.
- Shootout play score fields contain attempt tallies, not the official game
  total. Shootout conversions are not individual regulation/overtime goals.
- ESPN's skater career `SOG` label is attached to `shootoutGoals`, not
  `shotsTotal`. Tests require machine-key mappings rather than label guesses.
- Team records contain wins, losses, and overtime losses.
- During the offseason the generic `season` metadata may lag the effective
  `requestedSeason` and event years; it must not discard the upcoming schedule.

Live, pregame, intermission, postponed, missing-data, malformed, and
postseason multi-overtime cases are explicit synthetic tests. They are not
claimed to be captures of currently live games.
