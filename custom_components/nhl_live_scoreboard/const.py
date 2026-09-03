"""Constants for the NHL Live Scoreboard integration."""

import json
from pathlib import Path

DOMAIN = "nhl_live_scoreboard"
PLATFORMS = ["sensor"]

try:
    with (Path(__file__).parent / "manifest.json").open() as manifest_file:
        _manifest = json.load(manifest_file)
except (OSError, ValueError):  # pragma: no cover - packaged alongside this file
    _manifest = {}
INTEGRATION_VERSION = _manifest.get("version", "0.0.0")
# A contact URL is required by ESPN's edge, which rejects bare product tokens.
USER_AGENT = (
    f"nhl-live-scoreboard/{INTEGRATION_VERSION} "
    f"(+{_manifest.get('documentation', 'https://github.com')})"
)

SITE_API = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl"
STANDINGS_API = "https://site.api.espn.com/apis/v2/sports/hockey/nhl/standings"
ATHLETE_API = "https://site.web.api.espn.com/apis/common/v3/sports/hockey/nhl/athletes"
CORE_API = "https://sports.core.api.espn.com/v2/sports/hockey/leagues/nhl"

CONF_TEAM = "team"
CONF_NAME = "name"
DEFAULT_NAME = "NHL Live Scoreboard"
DEFAULT_SCAN_INTERVAL_SECONDS = 5
SCAN_INTERVAL_LIVE_SECONDS = 5
SCAN_INTERVAL_NEAR_GAME_SECONDS = 30
SCAN_INTERVAL_IDLE_SECONDS = 300
NEAR_GAME_LEAD_SECONDS = 30 * 60
NEAR_GAME_LAG_SECONDS = 5 * 60 * 60
SHOW_NEXT_AFTER_PREV_SECONDS = 16 * 60 * 60

LIVE_STATES = frozenset({"in", "live"})
STATUS_NAME_IN_PROGRESS = "STATUS_IN_PROGRESS"
STATUS_NAME_DELAYED = "STATUS_DELAYED"
STATUS_NAME_FINAL = "STATUS_FINAL"
STATUS_NAME_SCHEDULED = "STATUS_SCHEDULED"
MAX_LINESCORES = 20  # Three periods plus even an unusually long postseason OT.
LEADER_LIMIT = 3
MAX_PLAUSIBLE_SCORE_DELTA = 1  # Each ordinary NHL goal is one point.

SCHEDULE_TTL_SECONDS = 30 * 60
# Stale windows are additional to the normal TTL, not shorter than it.
SCHEDULE_STALE_FALLBACK_SECONDS = 5 * 60
SUMMARY_STALE_FALLBACK_SECONDS = 90
TEAM_METADATA_TTL_SECONDS = 60 * 60
ROSTER_TTL_SECONDS = 60 * 60
PLAYER_CARD_TTL_SECONDS = 6 * 60 * 60
PLAYER_CARD_STALE_FALLBACK_SECONDS = 24 * 60 * 60
TEAM_SEASON_STATS_TTL_SECONDS = 6 * 60 * 60
TEAM_SEASON_STATS_STALE_FALLBACK_SECONDS = 24 * 60 * 60
STANDINGS_TTL_SECONDS = 10 * 60
STANDINGS_STALE_FALLBACK_SECONDS = 60 * 60
GROUPS_TTL_SECONDS = 24 * 60 * 60
GROUPS_STALE_FALLBACK_SECONDS = 7 * 24 * 60 * 60
SEASON_STATS_CONCURRENCY = 8

EVENT_TEAM_SCORED = f"{DOMAIN}_team_scored"
EVENT_OPPONENT_SCORED = f"{DOMAIN}_opponent_scored"
EVENT_GAME_STARTED = f"{DOMAIN}_game_started"
EVENT_GAME_ENDED = f"{DOMAIN}_game_ended"
EVENT_GAME_WON = f"{DOMAIN}_game_won"
EVENT_GAME_LOST = f"{DOMAIN}_game_lost"
OPT_ON_TEAM_SCORED = "on_team_scored"
OPT_ON_OPPONENT_SCORED = "on_opponent_scored"
OPT_ON_GAME_STARTED = "on_game_started"
OPT_ON_GAME_ENDED = "on_game_ended"
OPT_ON_GAME_WON = "on_game_won"
OPT_ON_GAME_LOST = "on_game_lost"
EVENT_OPTION_KEYS = {
    EVENT_TEAM_SCORED: OPT_ON_TEAM_SCORED,
    EVENT_OPPONENT_SCORED: OPT_ON_OPPONENT_SCORED,
    EVENT_GAME_STARTED: OPT_ON_GAME_STARTED,
    EVENT_GAME_ENDED: OPT_ON_GAME_ENDED,
    EVENT_GAME_WON: OPT_ON_GAME_WON,
    EVENT_GAME_LOST: OPT_ON_GAME_LOST,
}

# ESPN's canonical abbreviations and IDs, verified against the teams endpoint.
NHL_TEAM_MAP = {
    "ANA": 25,
    "BOS": 1,
    "BUF": 2,
    "CAR": 7,
    "CBJ": 29,
    "CGY": 3,
    "CHI": 4,
    "COL": 17,
    "DAL": 9,
    "DET": 5,
    "EDM": 6,
    "FLA": 26,
    "LA": 8,
    "MIN": 30,
    "MTL": 10,
    "NJ": 11,
    "NSH": 27,
    "NYI": 12,
    "NYR": 13,
    "OTT": 14,
    "PHI": 15,
    "PIT": 16,
    "SEA": 124292,
    "SJ": 18,
    "STL": 19,
    "TB": 20,
    "TOR": 21,
    "UTAH": 129764,
    "VAN": 22,
    "VGK": 37,
    "WPG": 28,
    "WSH": 23,
}
