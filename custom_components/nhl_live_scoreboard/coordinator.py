"""ESPN NHL fetching, normalization, navigation, and Home Assistant events."""

from __future__ import annotations

import asyncio
import logging
import math
import re
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import aiohttp
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import Context, HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.script import Script
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .const import (
    ATHLETE_API,
    CONF_NAME,
    CONF_TEAM,
    CORE_API,
    DEFAULT_SCAN_INTERVAL_SECONDS,
    DOMAIN,
    EVENT_GAME_ENDED,
    EVENT_GAME_LOST,
    EVENT_GAME_STARTED,
    EVENT_GAME_WON,
    EVENT_OPPONENT_SCORED,
    EVENT_OPTION_KEYS,
    EVENT_TEAM_SCORED,
    GROUPS_STALE_FALLBACK_SECONDS,
    GROUPS_TTL_SECONDS,
    LEADER_LIMIT,
    LIVE_STATES,
    MAX_LINESCORES,
    MAX_PLAUSIBLE_SCORE_DELTA,
    NEAR_GAME_LAG_SECONDS,
    NEAR_GAME_LEAD_SECONDS,
    NHL_TEAM_MAP,
    PLAYER_CARD_STALE_FALLBACK_SECONDS,
    PLAYER_CARD_TTL_SECONDS,
    ROSTER_TTL_SECONDS,
    SCAN_INTERVAL_IDLE_SECONDS,
    SCAN_INTERVAL_LIVE_SECONDS,
    SCAN_INTERVAL_NEAR_GAME_SECONDS,
    SCHEDULE_STALE_FALLBACK_SECONDS,
    SCHEDULE_TTL_SECONDS,
    SEASON_STATS_CONCURRENCY,
    SHOW_NEXT_AFTER_PREV_SECONDS,
    SITE_API,
    STANDINGS_API,
    STANDINGS_STALE_FALLBACK_SECONDS,
    STANDINGS_TTL_SECONDS,
    STATUS_NAME_IN_PROGRESS,
    SUMMARY_STALE_FALLBACK_SECONDS,
    TEAM_METADATA_TTL_SECONDS,
    TEAM_SEASON_STATS_STALE_FALLBACK_SECONDS,
    TEAM_SEASON_STATS_TTL_SECONDS,
    USER_AGENT,
)
from .game_end import GameEndTracker
from .types import (
    Competition,
    GamePeriod,
    Goalies,
    Leaders,
    PeriodContext,
    PlayerCard,
    RecentPlay,
    ScoringPlay,
    Situation,
    Standings,
    TeamMetadata,
    TeamStats,
    WinProbability,
)

_LOGGER = logging.getLogger(__name__)
_ID_RE = re.compile(r"^[0-9]{1,20}$")
_CLOCK_RE = re.compile(r"\b(\d{1,2}:\d{2})\b")
_REF_TEAM_RE = re.compile(r"/(?:competitors|teams)/(\d+)(?:[/?]|$)")

# The same game-column schema is used for pregame rosters and the Season view.
# Keeping the ESPN machine keys (not column positions) prevents stat drift.
_SKATER_COLUMNS = ["G", "A", "PTS", "+/-", "SOG", "PIM", "HIT", "BLK", "TOI"]
_SKATER_KEYS = ["goals", "assists", "points", "plusMinus", "shotsTotal", "penaltyMinutes",
                "hits", "blockedShots", "timeOnIce"]
_STAT_SCHEMAS: dict[str, tuple[str, list[str], list[str]]] = {
    "forwards": ("Forwards", _SKATER_COLUMNS, _SKATER_KEYS),
    "defenses": ("Defense", _SKATER_COLUMNS, _SKATER_KEYS),
    "skaters": ("Skaters", _SKATER_COLUMNS, _SKATER_KEYS),
    "goalies": ("Goalies", ["SV", "SA", "GA", "SV%", "TOI"],
                ["saves", "shotsAgainst", "goalsAgainst", "savePct", "timeOnIce"]),
}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _text(value: Any) -> str:
    return "" if value is None else str(value)


def _parse_iso_ts(value: Any) -> float | None:
    if not value:
        return None
    try:
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        # ESPN dates are UTC; never interpret a malformed zone-less date locally.
        if result.tzinfo is None:
            return None
        return result.timestamp()
    except (TypeError, ValueError, OverflowError):
        return None


def _optional_int(value: Any) -> int | None:
    if value is None or value == "" or isinstance(value, bool):
        return None
    if isinstance(value, dict):
        value = value.get("value", value.get("displayValue"))
    try:
        number = float(str(value).replace(",", ""))
        return int(number) if math.isfinite(number) else None
    except (TypeError, ValueError, OverflowError):
        return None


def _safe_int(value: Any) -> int:
    return _optional_int(value) or 0


def _team_id(value: Any) -> str:
    if isinstance(value, dict):
        if value.get("id") is not None:
            return str(value["id"])
        match = _REF_TEAM_RE.search(str(value.get("$ref") or ""))
        return match.group(1) if match else ""
    return str(value) if value is not None else ""


def _competitor_for_side(comp: dict[str, Any], side: str) -> dict[str, Any]:
    return next((c for c in _list(comp.get("competitors")) if isinstance(c, dict)
                 and c.get("homeAway") == side), {})


def _resolve_my_side(comp: dict[str, Any], team_id: int) -> tuple[str | None, str | None]:
    for competitor in _list(comp.get("competitors")):
        competitor = _dict(competitor)
        if _team_id(competitor.get("team")) == str(team_id):
            side = competitor.get("homeAway")
            if side in {"home", "away"}:
                return side, "away" if side == "home" else "home"
    return None, None


def _scores_for_sides(comp: dict[str, Any], my_side: str, opp_side: str) -> tuple[int, int]:
    return (_safe_int(_competitor_for_side(comp, my_side).get("score")),
            _safe_int(_competitor_for_side(comp, opp_side).get("score")))


def _status_type(comp: dict[str, Any] | None) -> dict[str, Any]:
    return _dict(_dict(_dict(comp).get("status")).get("type"))


def _is_unplayed(comp: dict[str, Any] | None) -> bool:
    status = _status_type(comp)
    name = str(status.get("name") or "").upper()
    return ("CANCEL" in name or "POSTPON" in name
            or (status.get("state") == "post" and status.get("completed") is False))


def _is_final(comp: dict[str, Any] | None) -> bool:
    if not comp or _is_unplayed(comp):
        return False
    status = _status_type(comp)
    return status.get("completed") is True or status.get("state") == "post"


def _headshot(athlete: dict[str, Any]) -> str:
    value = athlete.get("headshot")
    return str(_dict(value).get("href") or "") if isinstance(value, dict) else _text(value)


def _athlete_name(athlete: dict[str, Any]) -> str:
    return str(athlete.get("displayName") or athlete.get("fullName") or athlete.get("shortName") or "")


def _short_name(athlete: dict[str, Any]) -> str:
    if athlete.get("shortName"):
        return str(athlete["shortName"])
    name = _athlete_name(athlete)
    parts = name.split(" ", 1)
    return f"{parts[0][0]}. {parts[1]}" if len(parts) == 2 and parts[0] else name


@dataclass
class NhlLiveScoreboardData:
    team_abbr: str = ""
    team_id: int = 0
    team_name: str = ""
    display_event_id: str = ""
    live_event_id: str = ""
    previous_event_id: str = ""
    next_event_id: str = ""
    next_game_start: str | None = None
    last_game_end: str | None = None
    last_game_end_event_id: str = ""
    last_game_end_source: str = ""
    selected_competition: Competition | None = None
    period_context: PeriodContext = field(default_factory=dict)
    recent_plays: list[RecentPlay] = field(default_factory=list)
    scoring_plays: list[ScoringPlay] = field(default_factory=list)
    away_team: TeamMetadata = field(default_factory=dict)
    home_team: TeamMetadata = field(default_factory=dict)
    goalies: Goalies = field(default_factory=dict)
    situation: Situation = field(default_factory=dict)
    current_period: GamePeriod = field(default_factory=dict)
    team_stats: TeamStats = field(default_factory=dict)
    win_probability: WinProbability = field(default_factory=dict)
    leaders: Leaders = field(default_factory=dict)
    division_standings: Standings = field(default_factory=dict)
    highlights_url: str = ""
    mode: str = "idle"
    status_text: str = ""
    is_live: bool = False
    is_delayed: bool = False


class NhlLiveScoreboardCoordinator(DataUpdateCoordinator[NhlLiveScoreboardData]):
    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.hass = hass
        self.entry = entry
        self.team_abbr = str(entry.data[CONF_TEAM]).upper()
        self.team_id = NHL_TEAM_MAP[self.team_abbr]
        self.display_name = str(entry.data.get(CONF_NAME) or entry.title or self.team_abbr)
        self._session = async_get_clientsession(hass)
        self._json_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._schedule_cache: tuple[float, dict[str, Any]] | None = None
        self._summary_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._player_card_cache: dict[str, tuple[float, PlayerCard]] = {}
        self._team_season_stats_cache: dict[str, tuple[float, dict[str, Any]]] = {}
        self._season_stats_semaphore = asyncio.Semaphore(SEASON_STATS_CONCURRENCY)
        self._live_summary_cache: tuple[str, dict[str, Any], dict[str, Any]] | None = None
        self._fired_once_event_id: str | None = None
        self._fired_once_events: set[str] = set()
        self._score_high_water: dict[str, int] = {}
        self._event_baseline_ts: float | None = None
        self._game_end_tracker = GameEndTracker(
            hass, f"{DOMAIN}.{getattr(entry, 'entry_id', self.team_id)}.game_end", self.team_id)
        super().__init__(hass, _LOGGER, name=f"{DOMAIN}_{self.team_abbr}",
                         update_interval=timedelta(seconds=DEFAULT_SCAN_INTERVAL_SECONDS))

    async def _get_json(self, url: str) -> dict[str, Any]:
        async with self._session.get(
            url, headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            timeout=aiohttp.ClientTimeout(total=20),
        ) as response:
            if response.status != 200:
                raise UpdateFailed(f"ESPN returned HTTP {response.status}")
            payload = await response.json()
            if not isinstance(payload, dict):
                raise UpdateFailed("ESPN returned an unexpected response shape")
            return payload

    async def _cached_json(
        self, key: str, url: str, ttl: int, stale: int = 0,
    ) -> dict[str, Any]:
        now = time.time()
        cached = self._json_cache.get(key)
        if cached and now - cached[0] < ttl:
            return cached[1]
        try:
            payload = await self._get_json(url)
        except Exception as err:
            if cached and now - cached[0] < ttl + stale:
                _LOGGER.debug("Using cached %s after an ESPN error: %s", key, err)
                return cached[1]
            _LOGGER.debug("Optional ESPN data unavailable for %s: %s", key, err)
            return {}
        self._json_cache[key] = (now, payload)
        return payload

    @staticmethod
    def _resolve_status_info(display_comp: dict[str, Any] | None) -> tuple[str, bool, bool]:
        status = _status_type(display_comp)
        name = str(status.get("name") or "").upper()
        detail = str(status.get("detail") or status.get("shortDetail")
                     or status.get("statusPrimary") or status.get("description") or "").strip()
        delayed = any(word in name for word in ("DELAY", "SUSPEND")) or any(
            word in detail.lower() for word in ("delay", "suspend"))
        live = not _is_final(display_comp) and not _is_unplayed(display_comp) and (
            status.get("state") in LIVE_STATES or name == STATUS_NAME_IN_PROGRESS or delayed)
        return detail, live, delayed

    def _select_event(self, events: list[dict[str, Any]]) -> tuple[str, str, str, str, dict[str, Any] | None]:
        now = time.time()
        previous = upcoming = live = pending = None
        ordered = sorted((e for e in events if isinstance(e, dict)),
                         key=lambda e: _parse_iso_ts(e.get("date")) or 0)
        for event in ordered:
            comp = _dict((_list(event.get("competitions")) or [{}])[0])
            if not comp.get("status") and event.get("status"):
                comp = {**comp, "status": event["status"]}
            _detail, is_live, _delayed = self._resolve_status_info(comp)
            if is_live:
                live = event
                continue
            timestamp = _parse_iso_ts(event.get("date"))
            if timestamp is None:
                continue
            if _is_final(comp) and timestamp <= now:
                previous = event
            elif timestamp > now and upcoming is None:
                upcoming = event
            elif timestamp <= now and now - timestamp < SHOW_NEXT_AFTER_PREV_SECONDS:
                # The schedule is cached. A just-started game may still be
                # marked scheduled; fetch its summary rather than skipping it.
                pending = event
        display = live
        if display is None and pending is not None:
            pending_ts = _parse_iso_ts(pending.get("date")) or 0
            previous_ts = _parse_iso_ts(_dict(previous).get("date")) or 0
            if pending_ts >= previous_ts:
                display = pending
        if display is None:
            display = previous or upcoming
            if previous and upcoming:
                previous_ts = _parse_iso_ts(previous.get("date")) or 0
                if now >= previous_ts + SHOW_NEXT_AFTER_PREV_SECONDS:
                    display = upcoming
        previous_id, next_id, live_id, display_id = (
            str(_dict(e).get("id") or "") for e in (previous, upcoming, live, display))
        return previous_id, next_id, live_id, display_id, display

    def _next_game_start(
        self, events: list[dict[str, Any]], display_id: str = "", display_comp: Competition | None = None,
    ) -> str | None:
        """Return the next usable club start from the already-fetched schedule.

        This is independent of the recent-final display hold. A fresh summary
        overrides its cached schedule status, especially immediately after a
        game ends. A short pending-start grace avoids a visibility flicker
        while ESPN still labels a just-started game as scheduled.
        """
        now = time.time()
        candidates = []
        for event in events:
            if not isinstance(event, dict):
                continue
            comp = _dict((_list(event.get("competitions")) or [{}])[0])
            status = {**_dict(event.get("status")), **_dict(comp.get("status"))}
            comp = {**comp, "status": status}
            fresh = _dict(display_comp) if display_id and str(event.get("id") or "") == str(display_id) else {}
            if fresh:
                comp = {**comp, **fresh, "status": {**status, **_dict(fresh.get("status"))}}
            if _resolve_my_side(comp, self.team_id)[0] is None or _is_final(comp) or _is_unplayed(comp):
                continue
            status_type = _status_type(comp)
            state = str(status_type.get("state") or "").lower()
            name = str(status_type.get("name") or "").upper()
            if "FINAL" in name or "TBD" in name or "TBA" in name:
                continue
            _detail, live, delayed = self._resolve_status_info(comp)
            pregame_delay = delayed and _safe_int(_dict(comp.get("status")).get("period")) <= 0
            if (live and not pregame_delay) or not (state == "pre" or name == "STATUS_SCHEDULED" or pregame_delay):
                continue
            if comp.get("timeValid", event.get("timeValid")) is False or comp.get("dateValid", event.get("dateValid")) is False:
                continue
            status = _dict(comp.get("status"))
            detail = " ".join(str(status_type.get(key) or "") for key in ("detail", "shortDetail", "description"))
            if (status_type.get("isTBDFlex") is True or status.get("isTBDFlex") is True
                    or comp.get("isTBDFlex") is True or event.get("isTBDFlex") is True
                    or re.search(r"\b(?:TBD|TBA)\b|to be determined|to be announced", detail, re.IGNORECASE)):
                continue
            start = _parse_iso_ts(fresh.get("date") or event.get("date") or comp.get("date"))
            if start is not None and start >= now - 6 * 60 * 60:
                candidates.append(start)
        return datetime.fromtimestamp(min(candidates), UTC).isoformat().replace("+00:00", "Z") if candidates else None

    @staticmethod
    def _event_at_offset(
        events: list[dict[str, Any]], anchor_event_id: str, offset: int,
    ) -> tuple[str | None, int, bool, bool]:
        ordered = sorted((e for e in events if isinstance(e, dict) and e.get("id")),
                         key=lambda e: _parse_iso_ts(e.get("date")) or 0)
        ids = list(dict.fromkeys(str(e["id"]) for e in ordered))
        if str(anchor_event_id) not in ids:
            return None, 0, False, False
        anchor = ids.index(str(anchor_event_id))
        target = max(0, min(anchor + int(offset), len(ids) - 1))
        return ids[target], target - anchor, target > 0, target < len(ids) - 1

    @staticmethod
    def _team_display_name(team: dict[str, Any]) -> str:
        return str(team.get("name") or team.get("displayName") or team.get("abbreviation") or "")

    @staticmethod
    def _record_summary(competitor: dict[str, Any]) -> str:
        direct = competitor.get("recordSummary")
        if direct:
            return str(direct)
        records = _list(competitor.get("record")) or _list(competitor.get("records"))
        overall = next((r for r in records if isinstance(r, dict) and (
            r.get("type") == "total" or str(r.get("name") or "").lower() == "overall")), {})
        return str(overall.get("summary") or overall.get("displayValue") or "")

    @classmethod
    def _compact_competition(
        cls, display_comp: dict[str, Any] | None, records_map: dict[str, str] | None = None,
    ) -> Competition | None:
        if not display_comp:
            return None
        records_map = records_map or {}
        competitors = []
        for competitor in _list(display_comp.get("competitors")):
            competitor = _dict(competitor)
            team = _dict(competitor.get("team"))
            logos = _list(team.get("logos"))
            lines = []
            for line in _list(competitor.get("linescores"))[:MAX_LINESCORES]:
                line = _dict(line)
                value = line.get("value", line.get("displayValue"))
                lines.append({"value": _optional_int(value), "displayValue": _text(line.get("displayValue", value))})
            score = _text(_dict(competitor.get("score")).get("displayValue")
                          if isinstance(competitor.get("score"), dict) else competitor.get("score"))
            status_type = _status_type(display_comp)
            final_so = _is_final(display_comp) and bool(re.search(
                r"\bSO\b|shootout", str(status_type.get("detail") or status_type.get("shortDetail") or ""), re.IGNORECASE))
            if final_so and len(lines) >= 5:
                prior = [line["value"] for line in lines[:4]]
                total = _optional_int(score)
                # A shootout awards one deciding team goal. Attempt tallies
                # from the play feed must never become a period goal score.
                deciding = total - sum(prior) if total is not None and all(v is not None for v in prior) else None
                lines[4:] = [{"value": deciding if deciding in {0, 1} else None,
                              "displayValue": str(deciding) if deciding in {0, 1} else ""}]
            competitors.append({
                "homeAway": competitor.get("homeAway"),
                "score": score,
                "winner": competitor.get("winner"),
                "recordSummary": records_map.get(_team_id(team)) or cls._record_summary(competitor),
                "linescores": lines,
                "team": {
                    "id": _team_id(team), "abbreviation": team.get("abbreviation") or "",
                    "name": cls._team_display_name(team),
                    "displayName": team.get("displayName") or cls._team_display_name(team),
                    "shortDisplayName": team.get("shortDisplayName") or cls._team_display_name(team),
                    "logo": team.get("logo") or _dict((logos or [{}])[0]).get("href") or "",
                },
            })
        status = _dict(display_comp.get("status"))
        return {
            "id": _text(display_comp.get("id")), "date": display_comp.get("date"),
            "status": {
                "period": _optional_int(status.get("period")),
                "displayClock": status.get("displayClock"),
                "clock": status.get("clock"),
                "type": {k: v for k, v in _dict(status.get("type")).items()
                         if k in {"id", "state", "name", "detail", "shortDetail", "description", "completed"}},
                "isTBDFlex": status.get("isTBDFlex", False),
            },
            "timeValid": display_comp.get("timeValid", True),
            "neutralSite": display_comp.get("neutralSite", False),
            "season": display_comp.get("season"), "seasonType": display_comp.get("seasonType"),
            "week": display_comp.get("week"), "venue": display_comp.get("venue"),
            "broadcasts": display_comp.get("broadcasts") or [],
            "competitors": competitors,
        }

    @staticmethod
    def _resolve_display_comp(
        summary: dict[str, Any], display_id: str, display_event: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        event = _dict(display_event)
        fallback = _dict((_list(event.get("competitions")) or [{}])[0])
        candidates = _list(_dict(summary.get("header")).get("competitions"))
        selected = next((c for c in candidates if isinstance(c, dict)
                         and str(c.get("id") or "") == str(display_id)), None)
        selected = selected or (candidates[0] if candidates else None)
        if not selected and not fallback:
            return None
        comp = {**fallback, **_dict(selected)}
        comp["status"] = {**_dict(event.get("status")), **_dict(fallback.get("status")),
                          **_dict(comp.get("status"))}
        comp["season"] = _dict(_dict(summary.get("header")).get("season")).get("year") or _dict(event.get("season")).get("year")
        comp["seasonType"] = (_dict(_dict(summary.get("header")).get("season")).get("type")
                              or _dict(event.get("seasonType")).get("type")
                              or _dict(event.get("season")).get("type"))
        comp["week"] = event.get("week") or _dict(summary.get("header")).get("week")
        comp["venue"] = _dict(summary.get("gameInfo")).get("venue") or comp.get("venue")
        return comp

    @staticmethod
    def _resolve_competitor_ids(comp: dict[str, Any] | None) -> tuple[str, str]:
        return tuple(_team_id(_competitor_for_side(comp or {}, side).get("team")) for side in ("away", "home"))

    @staticmethod
    def _all_plays(summary: dict[str, Any]) -> list[dict[str, Any]]:
        by_id: dict[str, dict[str, Any]] = {}
        anonymous: list[dict[str, Any]] = []
        for play in _list(summary.get("plays")):
            if not isinstance(play, dict):
                continue
            if play.get("id"):
                by_id[str(play["id"])] = play
            else:
                anonymous.append(play)
        return sorted([*by_id.values(), *anonymous],
                      key=lambda p: (_safe_int(p.get("sequenceNumber")) or _safe_int(p.get("id")),
                                     _parse_iso_ts(p.get("wallclock")) or 0))

    @classmethod
    def _all_periods(cls, summary: dict[str, Any]) -> list[dict[str, Any]]:
        grouped: dict[int, dict[str, Any]] = {}
        for play in cls._all_plays(summary):
            number = _safe_int(_dict(play.get("period")).get("number"))
            if number <= 0:
                continue
            period = grouped.setdefault(number, {"id": str(number), "number": number, "plays": [],
                                                 "is_shootout": False, "_is_current": False})
            period["plays"].append(play)
            period["is_shootout"] |= cls._is_shootout_play(play)
        comp = _dict((_list(_dict(summary.get("header")).get("competitions")) or [{}])[0])
        status = _dict(comp.get("status"))
        number = _safe_int(status.get("period")) or max(grouped, default=0)
        if number and cls._resolve_status_info(comp)[1]:
            grouped.setdefault(number, {"id": str(number), "number": number, "plays": [],
                                        "is_shootout": False, "_is_current": False})["_is_current"] = True
        return [grouped[key] for key in sorted(grouped)]

    @classmethod
    def _selected_period(cls, summary: dict[str, Any]) -> dict[str, Any]:
        periods = cls._all_periods(summary)
        return next((p for p in periods if p.get("_is_current")), periods[-1] if periods else {})

    @classmethod
    def _normalize_period(cls, period: dict[str, Any], comp: dict[str, Any] | None = None) -> GamePeriod:
        if not period:
            return {}
        number = _safe_int(period.get("number"))
        shootout = bool(period.get("is_shootout"))
        label = cls._period_label(number, shootout)
        plays = _list(period.get("plays"))
        goals = [p for p in plays if _dict(p).get("scoringPlay") and not cls._is_shootout_play(_dict(p))]
        away_id, home_id = cls._resolve_competitor_ids(comp)
        # With no side metadata, do not invent per-side goal counts.
        away_goals = sum(_team_id(_dict(p).get("team")) == away_id for p in goals) if away_id else None
        home_goals = sum(_team_id(_dict(p).get("team")) == home_id for p in goals) if home_id else None
        return {
            "id": str(period.get("id") or number), "number": number, "label": label,
            "description": "Shootout" if shootout else f"{label} period",
            "play_count": len(plays), "goals": len(goals), "away_goals": away_goals,
            "home_goals": home_goals, "is_current": bool(period.get("_is_current")), "is_shootout": shootout,
        }

    @staticmethod
    def _is_shootout_play(play: dict[str, Any]) -> bool:
        period = _dict(play.get("period"))
        values = [period.get("displayValue"), period.get("type"), _dict(play.get("shotInfo")).get("text"),
                  _dict(play.get("type")).get("text")]
        return any(str(value or "").upper() == "SO" or "shootout" in str(value or "").lower()
                   for value in values)

    @staticmethod
    def _ordinal(value: int) -> str:
        if value <= 0:
            return ""
        suffix = "th" if 10 <= value % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(value % 10, "th")
        return f"{value}{suffix}"

    @classmethod
    def _period_label(cls, period: int, is_shootout: bool = False) -> str:
        if is_shootout:
            return "SO"
        return cls._ordinal(period) if 0 < period <= 3 else ("OT" if period == 4 else f"{period - 3}OT" if period > 4 else "")

    @classmethod
    def _normalize_period_context(cls, summary: dict[str, Any], comp: dict[str, Any] | None) -> PeriodContext:
        status = _dict(_dict(comp).get("status"))
        status_type = _dict(status.get("type"))
        detail = str(status_type.get("detail") or status_type.get("shortDetail") or "")
        name = str(status_type.get("name") or "").upper()
        plays = cls._all_plays(summary)
        latest = plays[-1] if plays else {}
        period = max(_safe_int(status.get("period")), _safe_int(_dict(latest.get("period")).get("number")))
        if not period and _is_final(comp):
            period = max((len(_list(_dict(c).get("linescores"))) for c in _list(_dict(comp).get("competitors"))), default=0)
        intermission = not _is_final(comp) and ("INTERMISSION" in name or "intermission" in detail.lower()
                                               or "END_PERIOD" in name or "end of" in detail.lower())
        end_period = intermission
        shootout = cls._is_shootout_play(latest) or "SHOOTOUT" in name or bool(re.search(r"\bSO\b", detail))
        _detail, live, _delayed = cls._resolve_status_info(comp)
        clock = _text(status.get("displayClock"))
        if not clock:
            match = _CLOCK_RE.search(detail)
            clock = match.group(1) if match else ""
        # NHL play clocks are elapsed while status clocks count down. Never
        # substitute one for the other when the live status clock is missing.
        if not live or intermission or shootout:
            clock = ""
        period_label = cls._period_label(period, shootout)
        final_label = "Final/SO" if shootout else f"Final/{period_label}" if period > 3 else "Final"
        label = (f"{period_label} Intermission" if intermission else final_label if _is_final(comp)
                 else f"{clock} · {period_label}".strip(" ·") if live else "")
        return {
            "period": period, "display_period": period_label, "display_clock": clock,
            "period_prefix": "Intermission" if intermission else "",
            "label": label, "is_intermission": intermission, "is_end_period": end_period,
            "is_overtime": period > 3 and not shootout, "is_shootout": shootout,
        }

    @classmethod
    def _normalize_situation(
        cls, summary: dict[str, Any], comp: dict[str, Any] | None = None,
        live_situation: dict[str, Any] | None = None,
    ) -> Situation:
        if comp is None:
            comp = _dict((_list(_dict(summary.get("header")).get("competitions")) or [{}])[0])
        source = {**_dict(comp.get("situation")), **_dict(summary.get("situation")), **_dict(live_situation)}
        result: Situation = {"away_shots_on_goal": None, "home_shots_on_goal": None,
                             "strength": "", "power_play_team_id": "", "away_empty_net": None,
                             "home_empty_net": None, "power_play": None, "empty_net": None}
        for side in ("away", "home"):
            competitor = _competitor_for_side(comp, side)
            tid = _team_id(competitor.get("team"))
            block = next((_dict(t) for t in _list(_dict(summary.get("boxscore")).get("teams"))
                          if _team_id(_dict(t).get("team")) == tid), {})
            stats = cls._stat_map(_list(block.get("statistics")))
            stats.update(cls._stat_map(_list(competitor.get("statistics"))))
            # ESPN calls actual shots on goal shotsTotal; shootoutGoals is
            # misleadingly abbreviated SOG and must never be used here.
            result[f"{side}_shots_on_goal"] = _optional_int(
                source.get(f"{side}ShotsOnGoal", stats.get("shotsTotal")))
        if cls._resolve_status_info(comp)[1]:
            strength = source.get("strength")
            result["strength"] = strength if isinstance(strength, str) else str(_dict(strength).get("text") or "")
            result["power_play"] = source.get("powerPlay") if isinstance(source.get("powerPlay"), bool) else None
            result["empty_net"] = source.get("emptyNet") if isinstance(source.get("emptyNet"), bool) else None
            if not result["strength"]:
                if result["power_play"]:
                    result["strength"] = "Power Play"
                elif result["empty_net"]:
                    result["strength"] = "Empty Net"
                elif result["power_play"] is False:
                    result["strength"] = "Even Strength"
            result["power_play_team_id"] = _team_id(source.get("powerPlayTeam")) or _text(source.get("powerPlayTeamId"))
            for side in ("away", "home"):
                value = source.get(f"{side}EmptyNet")
                result[f"{side}_empty_net"] = value if isinstance(value, bool) else None
        # A previous shot's strength/empty-net annotation is a historical
        # fact, not proof of the current manpower. Do not carry it forward.
        return result

    @classmethod
    def _normalize_recent_plays(
        cls, summary: dict[str, Any], period: dict[str, Any] | None = None,
    ) -> list[RecentPlay]:
        selected = period if period is not None else cls._selected_period(summary)
        selected_ids = {str(_dict(p).get("id") or "") for p in _list(selected.get("plays"))}
        if selected and not selected_ids:
            return []
        result: list[RecentPlay] = []
        for play in cls._all_plays(summary):
            if selected_ids and str(play.get("id") or "") not in selected_ids:
                continue
            text = str(play.get("text") or "").strip()
            if not text:
                continue
            play_type = _dict(play.get("type"))
            type_text = str(play_type.get("text") or "")
            low = type_text.lower()
            shootout = cls._is_shootout_play(play)
            is_shot = low in {"shot", "goal", "missed", "blocked", "missed shot", "blocked shot"}
            coordinate = _dict(play.get("coordinate"))
            valid_coordinate = all(isinstance(coordinate.get(k), (int, float))
                                   and not isinstance(coordinate.get(k), bool)
                                   and math.isfinite(coordinate[k]) for k in ("x", "y"))
            # NHL coordinates are centered rink feet. Reject invalid data
            # instead of clipping it into a convincing but incorrect chart.
            valid_coordinate = valid_coordinate and abs(coordinate["x"]) <= 100 and abs(coordinate["y"]) <= 42.5
            result.append({
                "id": str(play.get("id") or ""), "text": text,
                # ESPN's SO play scores reset to attempt tallies, not game
                # goals. Official competition scores remain authoritative.
                "away_score": None if shootout else _optional_int(play.get("awayScore")),
                "home_score": None if shootout else _optional_int(play.get("homeScore")),
                "wallclock_ts": _parse_iso_ts(play.get("wallclock")),
                "scoring_play": bool(play.get("scoringPlay")),
                "score_value": 0 if shootout else 1 if play.get("scoringPlay") else 0,
                "play_type": type_text,
                "abbreviation": str(play_type.get("abbreviation") or ""),
                "period": _safe_int(_dict(play.get("period")).get("number")),
                "clock": str(_dict(play.get("clock")).get("displayValue") or ""),
                "team_id": _team_id(play.get("team")), "is_shootout": shootout,
                "is_penalty": bool(play.get("isPenalty")) or "penalty" in low
                              or bool(play_type.get("penaltyType")) or _safe_int(play_type.get("penaltyMinutes")) > 0,
                "is_shot": is_shot,
                "coordinate": {"x": coordinate["x"], "y": coordinate["y"]} if is_shot and valid_coordinate else {},
                "shot_type": str(_dict(play.get("shotInfo")).get("text") or ""),
                "strength": str(_dict(play.get("strength")).get("text") or ""),
            })
        return result

    @classmethod
    def _normalize_scoring_plays(cls, summary: dict[str, Any]) -> list[ScoringPlay]:
        result = []
        plays = cls._all_plays(summary) or _list(summary.get("scoringPlays"))
        for play in plays:
            play = _dict(play)
            if not play.get("text") or not play.get("scoringPlay") or cls._is_shootout_play(play):
                continue
            period = _safe_int(_dict(play.get("period")).get("number"))
            result.append({
                "id": str(play.get("id") or ""), "text": str(play["text"]),
                "period_type": cls._period_label(period), "period_number": period, "period": period,
                "clock": str(_dict(play.get("clock")).get("displayValue") or ""),
                "away_score": _optional_int(play.get("awayScore")),
                "home_score": _optional_int(play.get("homeScore")), "score_value": 1,
                "team_id": _team_id(play.get("team")),
                "play_type": str(_dict(play.get("type")).get("text") or ""),
                "abbreviation": str(_dict(play.get("type")).get("abbreviation") or ""),
                "strength": str(_dict(play.get("strength")).get("text") or ""), "is_shootout": False,
            })
        return result

    @staticmethod
    def _normalize_win_probability(summary: dict[str, Any] | None) -> WinProbability:
        series = _list(_dict(summary).get("winprobability"))
        latest = next((e for e in reversed(series) if isinstance(e, dict)
                       and e.get("homeWinPercentage") is not None), {})
        try:
            home = float(latest["homeWinPercentage"])
            tie = float(latest.get("tiePercentage") or 0)
        except (KeyError, TypeError, ValueError):
            return {}
        if not math.isfinite(home) or not math.isfinite(tie) or not 0 <= home <= 1 or not 0 <= tie <= 1:
            return {}
        return {"home": round(home * 100, 1), "away": round(max(0, 1 - home - tie) * 100, 1),
                "tie": round(tie * 100, 1)}

    @staticmethod
    def _normalize_team_payload(payload: dict[str, Any]) -> TeamMetadata:
        team = _dict(payload.get("team")) or payload
        records = _list(_dict(team.get("record")).get("items"))
        record = next((r for r in records if isinstance(r, dict) and r.get("type") == "total"),
                      records[0] if records else {})
        logos = _list(team.get("logos"))
        return {
            "id": _team_id(team), "abbreviation": str(team.get("abbreviation") or ""),
            "name": str(team.get("displayName") or team.get("name") or ""),
            "short_name": str(team.get("shortDisplayName") or team.get("name") or team.get("abbreviation") or ""),
            "logo": str(team.get("logo") or _dict((logos or [{}])[0]).get("href") or ""),
            "record_summary": str(_dict(record).get("summary") or ""),
        }

    @staticmethod
    def _team_id_division_index(payload: dict[str, Any] | None) -> dict[str, str]:
        result = {}
        for conference in _list(_dict(payload).get("groups")):
            for division in _list(_dict(conference).get("children")):
                division = _dict(division)
                name = str(division.get("name") or "")
                for team in _list(division.get("teams")):
                    tid = _team_id(team)
                    if tid and name:
                        result[tid] = name
        return result

    @staticmethod
    def _standings_entries(payload: dict[str, Any] | None) -> list[dict[str, Any]]:
        result = []
        for conference in _list(_dict(payload).get("children")):
            result.extend(e for e in _list(_dict(_dict(conference).get("standings")).get("entries"))
                          if isinstance(e, dict))
        return result

    @staticmethod
    def _stat_map(stats: list[Any]) -> dict[str, str]:
        result = {}
        for stat in stats:
            stat = _dict(stat)
            name = str(stat.get("name") or "")
            value = stat.get("displayValue")
            if value is None:
                value = stat.get("summary", stat.get("value"))
            if name:
                result[name] = _text(value)
        return result

    @classmethod
    def _records_from_standings(cls, payload: dict[str, Any] | None) -> dict[str, str]:
        result = {}
        for entry in cls._standings_entries(payload):
            tid = _team_id(entry.get("team"))
            stats = cls._stat_map(_list(entry.get("stats")))
            # The record's displayValue includes ', 113 PTS'; the compact
            # matchup row needs only the native W-L-OTL summary.
            overall = next((_dict(s) for s in _list(entry.get("stats")) if _dict(s).get("name") == "overall"), {})
            record = _text(overall.get("summary")) or stats.get("overall") or ""
            if not record and "wins" in stats and "losses" in stats:
                record = f"{stats['wins']}-{stats['losses']}"
                if "overtimeLosses" in stats:
                    record += f"-{stats['overtimeLosses']}"
            if tid and record:
                result[tid] = record
        return result

    @classmethod
    def _normalize_standings(
        cls, payload: dict[str, Any] | None, division_index: dict[str, str], team_id: int,
    ) -> Standings:
        division = division_index.get(str(team_id), "")
        entries = []
        # ESPN's ordering carries NHL tiebreakers. Do not re-sort it by wins
        # alone (OT losses, unequal games played, and tiebreakers matter).
        for entry in cls._standings_entries(payload):
            team = _dict(entry.get("team"))
            if not division or division_index.get(_team_id(team)) != division:
                continue
            stats = cls._stat_map(_list(entry.get("stats")))
            entries.append({
                "team_id": _team_id(team),
                "team_name": str(team.get("displayName") or team.get("name") or ""),
                "team_short_name": str(team.get("shortDisplayName") or team.get("name")
                                       or team.get("abbreviation") or ""),
                "wins": stats.get("wins", ""), "losses": stats.get("losses", ""),
                "overtime_losses": stats.get("overtimeLosses", ""), "points": stats.get("points", ""),
            })
        return {"division_name": division, "entries": entries}

    @classmethod
    def _normalize_leaders(cls, summary: dict[str, Any], comp: dict[str, Any] | None = None) -> Leaders:
        if comp is None:
            comp = _dict((_list(_dict(summary.get("header")).get("competitions")) or [{}])[0])
        side_map = {_team_id(_dict(c).get("team")): _dict(c).get("homeAway")
                    for c in _list(comp.get("competitors"))}
        result: Leaders = {"away": [], "home": []}
        for block in _list(summary.get("leaders")):
            block = _dict(block)
            side = block.get("homeAway") or side_map.get(_team_id(block.get("team")))
            if side not in result:
                continue
            for category in _list(block.get("leaders")):
                category = _dict(category)
                leader = _dict((_list(category.get("leaders")) or [{}])[0])
                athlete = _dict(leader.get("athlete"))
                if not athlete:
                    continue
                result[side].append({
                    "id": _text(athlete.get("id")), "name": _short_name(athlete),
                    "headshot": _headshot(athlete),
                    "category": str(category.get("displayName") or category.get("name") or ""),
                    "value": _text(leader.get("displayValue", leader.get("value"))),
                })
                if len(result[side]) >= LEADER_LIMIT:
                    break
        return result

    @staticmethod
    def _extract_highlights_url(summary: dict[str, Any]) -> str:
        for link in _list(_dict(summary.get("header")).get("links")):
            link = _dict(link)
            if "videos" in _list(link.get("rel")) and str(link.get("href") or "").startswith("https://"):
                return str(link["href"])
        return ""

    @staticmethod
    def _roster_athletes(payload: dict[str, Any]) -> dict[str, dict[str, Any]]:
        result = {}
        for group in _list(payload.get("athletes")):
            group = _dict(group)
            # NHL roster responses may be flat or grouped by position.
            entries = _list(group.get("items")) if "items" in group else [group]
            for value in entries:
                athlete = _dict(value)
                aid = str(athlete.get("id") or "")
                if aid:
                    result[aid] = athlete
        return result

    @staticmethod
    def _boxscore_player_row(entry: dict[str, Any], roster: dict[str, dict[str, Any]]) -> dict[str, Any]:
        athlete = _dict(entry.get("athlete"))
        athlete = {**roster.get(str(athlete.get("id") or ""), {}), **athlete}
        return {
            "id": _text(athlete.get("id")), "name": _athlete_name(athlete),
            "short_name": _short_name(athlete), "headshot": _headshot(athlete),
            "position": str(_dict(athlete.get("position")).get("abbreviation") or ""),
            "jersey": _text(athlete.get("jersey")),
            "stats": [_text(s) for s in _list(entry.get("stats"))],
        }

    @classmethod
    def _normalize_team_stats(
        cls, summary: dict[str, Any], comp: dict[str, Any] | None = None,
        rosters: dict[str, dict[str, Any]] | None = None,
    ) -> TeamStats:
        if comp is None:
            comp = _dict((_list(_dict(summary.get("header")).get("competitions")) or [{}])[0])
        rosters = rosters or {}
        result: TeamStats = {}
        player_blocks = _list(_dict(summary.get("boxscore")).get("players"))
        for side in ("away", "home"):
            competitor = _competitor_for_side(comp, side)
            team = _dict(competitor.get("team"))
            tid = _team_id(team)
            if not tid:
                continue
            roster = cls._roster_athletes(rosters.get(tid, {}))
            block = next((_dict(p) for p in player_blocks if _team_id(_dict(p).get("team")) == tid), {})
            categories = []
            for category in _list(block.get("statistics")):
                category = _dict(category)
                name = str(category.get("name") or category.get("type") or "")
                schema = _STAT_SCHEMAS.get(name)
                keys = [_text(k) for k in _list(category.get("keys"))]
                columns = [_text(k) for k in _list(category.get("labels"))]
                columns = ["SO G" if key == "shootoutGoals" else "SOG" if key == "shotsTotal"
                           else (columns[index] if index < len(columns) else key)
                           for index, key in enumerate(keys)]
                if not name or not keys:
                    continue
                rows = [cls._boxscore_player_row(_dict(a), roster)
                        for a in _list(category.get("athletes")) if _dict(a).get("athlete")]
                if not rows:
                    continue
                categories.append({
                    "name": name, "label": schema[0] if schema else name.replace("_", " ").title(),
                    "columns": columns, "keys": keys,
                    "descriptions": [_text(s) for s in _list(category.get("descriptions"))],
                    "totals": [_text(s) for s in _list(category.get("totals"))], "rows": rows,
                })
            source = "game"
            if not categories and roster:
                source = "roster"
                positions = {
                    "forwards": {"C", "LW", "RW", "F"}, "defenses": {"D"}, "goalies": {"G"},
                }
                for name, allowed in positions.items():
                    label, columns, keys = _STAT_SCHEMAS[name]
                    rows = []
                    for athlete in roster.values():
                        position = str(_dict(athlete.get("position")).get("abbreviation") or "")
                        if position in allowed:
                            rows.append(cls._boxscore_player_row(
                                {"athlete": athlete, "stats": [""] * len(keys)}, roster))
                    if rows:
                        categories.append({"name": name, "label": label, "columns": columns,
                                           "keys": keys, "descriptions": [], "totals": [], "rows": rows})
            logos = _list(team.get("logos"))
            result[side] = {
                "team_id": tid, "abbreviation": str(team.get("abbreviation") or ""),
                "name": str(team.get("displayName") or cls._team_display_name(team)),
                "short_name": str(team.get("shortDisplayName") or cls._team_display_name(team)),
                "logo": str(team.get("logo") or _dict((logos or [{}])[0]).get("href") or ""),
                "source": source, "categories": categories,
            }
        return result

    @staticmethod
    def _stats_by_key(category: dict[str, Any], row: dict[str, Any]) -> dict[str, str]:
        return {str(key): _text(value) for key, value in
                zip(_list(category.get("keys")), _list(row.get("stats")), strict=False)}

    @staticmethod
    def _goalie_stat_line(values: dict[str, str]) -> dict[str, str]:
        return {
            "saves": values.get("saves", ""), "shots_against": values.get("shotsAgainst", ""),
            "goals_against": values.get("goalsAgainst", ""), "save_percentage": values.get("savePct", ""),
            "wins": values.get("wins", ""), "losses": values.get("losses", ""),
            "overtime_losses": values.get("overtimeLosses", ""),
            "goals_against_average": values.get("avgGoalsAgainst", ""), "shutouts": values.get("shutouts", ""),
        }

    @classmethod
    def _normalize_goalies(
        cls, summary: dict[str, Any], team_stats: TeamStats,
        rosters: dict[str, dict[str, Any]] | None = None, *, live: bool | None = None,
    ) -> Goalies:
        result: Goalies = {"away": {}, "home": {}}
        rosters = rosters or {}
        comp = _dict((_list(_dict(summary.get("header")).get("competitions")) or [{}])[0])
        if live is None:
            live = cls._resolve_status_info(comp)[1]
        for side in ("away", "home"):
            team = _dict(team_stats.get(side))
            tid = str(team.get("team_id") or "")
            category = next((_dict(c) for c in _list(team.get("categories"))
                             if _dict(c).get("name") == "goalies"), {})
            rows = [r for r in _list(category.get("rows")) if isinstance(r, dict)]
            chosen = {}
            source = "game"
            game_observed = live or _is_final(comp) or (not comp and bool(cls._all_plays(summary)))
            if team.get("source") == "game" and rows and game_observed:
                # A saver participant identifies the most recently observed
                # goalie. It does not imply the goalie is currently on ice.
                if live:
                    ids = {str(row.get("id")): row for row in rows}
                    for play in reversed(cls._all_plays(summary)):
                        for participant in _list(play.get("participants")):
                            participant = _dict(participant)
                            if str(participant.get("type") or "").lower() not in {"saver", "goalie", "goaltender"}:
                                continue
                            aid = str(_dict(participant.get("athlete")).get("id") or "")
                            if aid in ids:
                                chosen = ids[aid]
                                break
                        if chosen:
                            break
                if not chosen:
                    eligible = [r for r in rows if any(v not in {"", "-", "--"} for v in _list(r.get("stats")))]
                    if eligible:
                        chosen = max(eligible, key=lambda row: _safe_int(
                            cls._stats_by_key(category, row).get("shotsAgainst")))
            if not chosen:
                # Only an explicitly supplied starter/probable goalie is
                # suitable before puck drop. Roster/depth ordering is not.
                source = "probable"
                competitor = _competitor_for_side(comp, side)
                for probable in _list(competitor.get("probables")):
                    probable = _dict(probable)
                    athlete = _dict(probable.get("athlete"))
                    position = str(_dict(athlete.get("position")).get("abbreviation") or "")
                    label = str(probable.get("name") or probable.get("displayName") or "").lower()
                    if athlete.get("id") and (position == "G" or "goal" in label):
                        chosen = cls._boxscore_player_row(
                            {"athlete": athlete, "stats": []}, cls._roster_athletes(rosters.get(tid, {})))
                        break
            if not chosen:
                continue
            result[side] = {
                "id": str(chosen.get("id") or ""), "display_name": str(chosen.get("name") or ""),
                "short_name": str(chosen.get("short_name") or chosen.get("name") or ""),
                "headshot": str(chosen.get("headshot") or ""), "team_id": tid, "source": source,
                "game_stats": cls._goalie_stat_line(cls._stats_by_key(category, chosen)) if source == "game" else {},
                "season_stats": {},
            }
        return result

    @staticmethod
    def _team_abbr_map(payload: dict[str, Any]) -> dict[str, str]:
        return {_team_id(v): str(v.get("abbreviation") or "") for v in _dict(payload.get("teams")).values()
                if isinstance(v, dict) and _team_id(v)}

    @staticmethod
    def _project_season_category(name: str, values: dict[str, str]) -> dict[str, Any]:
        # Season tables have their own columns. Preserve all published
        # machine keys rather than relabeling average TOI as total TOI or
        # shootoutGoals as shotsTotal.
        labels = {"games": "GP", "gameStarted": "GS", "goals": "G", "assists": "A", "points": "PTS",
                  "plusMinus": "+/-", "penaltyMinutes": "PIM", "shootoutGoals": "SO G", "shotsTotal": "SOG",
                  "shootingPct": "SH%", "powerPlayGoals": "PPG", "powerPlayAssists": "PPA",
                  "shortHandedGoals": "SHG", "shortHandedAssists": "SHA", "gameWinningGoals": "GWG",
                  "timeOnIcePerGame": "TOI/G", "production": "PROD", "wins": "W", "losses": "L",
                  "ties": "T", "overtimeLosses": "OTL", "goalsAgainst": "GA", "avgGoalsAgainst": "GAA",
                  "shotsAgainst": "SA", "saves": "SV", "savePct": "SV%", "shutouts": "SO"}
        keys = list(values)
        return {"columns": [labels.get(key, key) for key in keys], "keys": keys,
                "stats": [values[key] for key in keys]}

    @classmethod
    def _extract_season_line(cls, payload: dict[str, Any]) -> dict[str, Any]:
        categories = [c for c in _list(payload.get("categories")) if isinstance(c, dict)]
        years = [_safe_int(_dict(_dict(row).get("season")).get("year")) for category in categories
                 for row in _list(category.get("statistics"))]
        season = max(years, default=0)
        if not season:
            return {}
        result = {}
        display_season = str(season)
        for category in categories:
            name = str(category.get("name") or "")
            rows = [r for r in _list(category.get("statistics")) if isinstance(r, dict)
                    and _safe_int(_dict(r.get("season")).get("year")) == season]
            if not rows:
                continue
            # Traded players have splits plus a total. Use ESPN's total,
            # never add rate statistics or confuse an individual club split.
            total = next((r for r in rows if not r.get("teamId") or str(r.get("teamId")) == "0"
                          or str(r.get("teamSlug") or "").lower() in {"tot", "total"}), rows[-1])
            display_season = str(_dict(total.get("season")).get("displayName") or season)
            names = [_text(n) for n in _list(category.get("names"))]
            values = {key: _text(value) for key, value in zip(names, _list(total.get("stats")), strict=False)}
            if name in {"goaltender", "goalies", "goalie"} or total.get("position") == "G":
                targets = ("goalies",)
            elif name in {"center", "left-wing", "right-wing", "defense", "defenseman", "skaters",
                          "forwards", "defenses"} or total.get("position") in {"C", "LW", "RW", "F", "D"}:
                targets = ("forwards", "defenses", "skaters")
            else:
                targets = ()
            for target in targets:
                result[target] = cls._project_season_category(target, values)
            if not targets and name:
                result[name] = {"columns": [_text(x) for x in _list(category.get("labels"))],
                                "keys": names, "stats": [_text(x) for x in _list(total.get("stats"))]}
        return {"season": display_season, "categories": result} if result else {}

    @classmethod
    def _parse_player_card(
        cls, athlete_id: str, bio_payload: dict[str, Any], stats_payload: dict[str, Any],
    ) -> PlayerCard:
        athlete = _dict(bio_payload.get("athlete"))
        position = _dict(athlete.get("position"))
        team = _dict(athlete.get("team"))
        bio = {
            "name": _athlete_name(athlete), "team": str(team.get("displayName") or team.get("name") or ""),
            "position": str(position.get("abbreviation") or position.get("displayName") or ""),
            "height": str(athlete.get("displayHeight") or ""), "weight": str(athlete.get("displayWeight") or ""),
            "age": _text(athlete.get("age")), "jersey": _text(athlete.get("jersey") or athlete.get("displayJersey")),
            "headshot": _headshot(athlete), "draft": str(athlete.get("displayDraft") or ""),
            "college": str(_dict(athlete.get("college")).get("name") or ""),
            "experience": str(athlete.get("displayExperience") or ""),
            "hometown": str(athlete.get("displayBirthPlace") or ""),
        }
        categories = [c for c in _list(stats_payload.get("categories")) if isinstance(c, dict)
                      and _list(c.get("statistics")) and _list(c.get("names"))]
        position_category = {"G": "goaltender", "C": "center", "LW": "left-wing", "RW": "right-wing", "D": "defense"}
        preferred = position_category.get(str(position.get("abbreviation") or ""), "skaters")
        primary = next((c for c in categories if c.get("name") == preferred), categories[0] if categories else {})
        career = {}
        if primary:
            teams = cls._team_abbr_map(stats_payload)
            career = {
                "kind": str(primary.get("name") or ""), "label": str(primary.get("displayName") or ""),
                "columns": ["SO G" if key == "shootoutGoals" else "SOG" if key == "shotsTotal"
                            else _text((_list(primary.get("labels")) + [""] * len(_list(primary.get("names"))))[index])
                            for index, key in enumerate(_list(primary.get("names")))],
                "keys": [_text(v) for v in _list(primary.get("names"))],
                "seasons": [{"year": _text(_dict(_dict(r).get("season")).get("displayName") or _dict(_dict(r).get("season")).get("year")),
                             "team": teams.get(str(_dict(r).get("teamId") or ""), "")
                             or str(_dict(r).get("teamSlug") or "TOT"),
                             "stats": [_text(v) for v in _list(_dict(r).get("stats"))]}
                            for r in _list(primary.get("statistics")) if isinstance(r, dict)],
                "totals": [_text(v) for v in _list(primary.get("totals"))],
            }
        glossary = {str(_dict(g).get("abbreviation") or "").strip(): str(_dict(g).get("displayName") or "")
                    for g in _list(stats_payload.get("glossary")) if _dict(g).get("abbreviation")}
        glossary.update({"SO G": "Shootout goals", "SOG": "Shots on goal"})
        return {"id": str(athlete_id), "bio": bio, "career": career, "glossary": glossary}

    async def async_get_player_card(self, athlete_id: str) -> PlayerCard:
        return await self._get_player_card(athlete_id)

    async def _get_player_card(self, athlete_id: str) -> PlayerCard:
        athlete_id = str(athlete_id).strip()
        if not _ID_RE.fullmatch(athlete_id):
            raise ValueError("Invalid ESPN athlete ID")
        now = time.time()
        cached = self._player_card_cache.get(athlete_id)
        if cached and now - cached[0] < PLAYER_CARD_TTL_SECONDS:
            return cached[1]
        bio, stats = await asyncio.gather(
            self._get_json(f"{ATHLETE_API}/{athlete_id}?region=us&lang=en"),
            self._get_json(f"{ATHLETE_API}/{athlete_id}/stats?region=us&lang=en"),
            return_exceptions=True,
        )
        if not isinstance(bio, dict) and not isinstance(stats, dict):
            if cached and now - cached[0] < PLAYER_CARD_STALE_FALLBACK_SECONDS:
                return cached[1]
            return {}
        card = self._parse_player_card(athlete_id, _dict(bio), _dict(stats))
        # A partial response may be rendered, but never overwrite a complete
        # cached card with half of its data during a transient endpoint outage.
        if isinstance(bio, dict) and isinstance(stats, dict):
            self._player_card_cache[athlete_id] = (now, card)
        elif cached and now - cached[0] < PLAYER_CARD_STALE_FALLBACK_SECONDS:
            return cached[1]
        return card

    async def async_get_team_season_stats(self, athlete_ids: list[str]) -> dict[str, dict[str, Any]]:
        return await self._get_team_season_stats(athlete_ids)

    async def _get_team_season_stats(self, athlete_ids: list[str]) -> dict[str, dict[str, Any]]:
        ids = list(dict.fromkeys(str(a).strip() for a in athlete_ids))
        if len(ids) > 100 or any(not _ID_RE.fullmatch(a) for a in ids):
            raise ValueError("Invalid ESPN athlete IDs")
        results = await asyncio.gather(*(self._get_one_season_line(a) for a in ids), return_exceptions=True)
        return {aid: result for aid, result in zip(ids, results, strict=True) if isinstance(result, dict) and result}

    async def _get_one_season_line(self, athlete_id: str) -> dict[str, Any]:
        if not _ID_RE.fullmatch(str(athlete_id)):
            return {}
        now = time.time()
        cached = self._team_season_stats_cache.get(athlete_id)
        if cached and now - cached[0] < TEAM_SEASON_STATS_TTL_SECONDS:
            return cached[1]
        async with self._season_stats_semaphore:
            try:
                payload = await self._get_json(f"{ATHLETE_API}/{athlete_id}/stats?region=us&lang=en")
            except Exception:
                return cached[1] if cached and now - cached[0] < TEAM_SEASON_STATS_STALE_FALLBACK_SECONDS else {}
        parsed = self._extract_season_line(payload)
        if parsed:
            self._team_season_stats_cache[athlete_id] = (now, parsed)
        return parsed

    @staticmethod
    def _merge_schedules(payloads: list[dict[str, Any]], year: int) -> dict[str, Any]:
        events: dict[str, dict[str, Any]] = {}
        team = {}
        for payload in payloads:
            if not team and isinstance(payload.get("team"), dict):
                team = payload["team"]
            for event in _list(payload.get("events")):
                if not isinstance(event, dict) or not _ID_RE.fullmatch(str(event.get("id") or "")):
                    continue
                # Query response metadata may still describe ESPN's current
                # season even for a requested older year; trust event data.
                event_year = _safe_int(_dict(event.get("season")).get("year"))
                if event_year and event_year != year:
                    continue
                events[str(event["id"])] = event
        return {"team": team, "season": {"year": year}, "events": sorted(
            events.values(), key=lambda e: _parse_iso_ts(e.get("date")) or 0)}

    async def _fetch_schedule(self) -> dict[str, Any]:
        now = time.time()
        cached = self._schedule_cache
        if cached and now - cached[0] < SCHEDULE_TTL_SECONDS:
            return cached[1]
        base = f"{SITE_API}/teams/{self.team_abbr.lower()}/schedule"
        try:
            default = await self._get_json(base)
            if not isinstance(default.get("events"), list):
                raise UpdateFailed("ESPN schedule has no events list")
            # During the NHL offseason ESPN's generic `season` still names
            # the completed league year, while requestedSeason and the
            # events describe the newly published upcoming schedule. Trust
            # the effective schedule, not that stale league-wide metadata.
            event_years = [_safe_int(_dict(_dict(event).get("season")).get("year"))
                           for event in _list(default.get("events"))]
            event_years = [year for year in event_years if year > 0]
            requested = _dict(default.get("requestedSeason"))
            year = _safe_int(requested.get("year"))
            if not year or (event_years and year not in event_years):
                year = (max(set(event_years), key=lambda value: (event_years.count(value), value))
                        if event_years else _safe_int(_dict(default.get("season")).get("year")))
            year = year or datetime.now().year
            default_type = _safe_int(requested.get("type")) or _safe_int(_dict(default.get("season")).get("type"))
            first_event = _dict((_list(default.get("events")) or [{}])[0])
            default_type = _safe_int(_dict(first_event.get("seasonType")).get("type")) or default_type
            types = [value for value in (1, 2, 3) if value != default_type]
            responses = await asyncio.gather(
                *(self._get_json(f"{base}?season={year}&seasontype={value}") for value in types),
                return_exceptions=True,
            )
            payloads = [default]
            used_cached_phase = False
            for phase, response in zip(types, responses, strict=True):
                if isinstance(response, dict) and isinstance(response.get("events"), list):
                    payloads.append(response)
                elif (cached and now - cached[0] < SCHEDULE_TTL_SECONDS + SCHEDULE_STALE_FALLBACK_SECONDS
                      and _safe_int(_dict(cached[1].get("season")).get("year")) == year):
                    # A single phase outage must not drop half the schedule.
                    payloads.append({"events": [e for e in _list(cached[1].get("events"))
                        if _safe_int(_dict(_dict(e).get("seasonType")).get("type")) == phase]})
                    used_cached_phase = True
                else:
                    raise UpdateFailed(f"Unable to fetch NHL season phase {phase}")
            schedule = self._merge_schedules(payloads, year)
            # A partial success must never renew the age of a stale phase.
            # Retry on the next update and expire all fallback at its original
            # bounded deadline instead of retaining it indefinitely.
            self._schedule_cache = (cached[0] if used_cached_phase and cached else now, schedule)
            return schedule
        except Exception as err:
            if cached and now - cached[0] < SCHEDULE_TTL_SECONDS + SCHEDULE_STALE_FALLBACK_SECONDS:
                _LOGGER.warning("ESPN schedule unavailable; retaining recent schedule: %s", err)
                return cached[1]
            raise UpdateFailed(f"Unable to fetch NHL schedule: {err}") from err

    async def _resolve_schedule(self) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        schedule = await self._fetch_schedule()
        return schedule, _list(schedule.get("events"))

    async def _fetch_team_payload(self, team_id: str, side: str = "") -> dict[str, Any]:
        if not _ID_RE.fullmatch(team_id):
            return {}
        return await self._cached_json(f"team:{team_id}", f"{SITE_API}/teams/{team_id}",
                                       TEAM_METADATA_TTL_SECONDS, 24 * 60 * 60)

    async def _get_groups(self) -> dict[str, Any]:
        return await self._cached_json("groups", f"{SITE_API}/groups",
                                       GROUPS_TTL_SECONDS, GROUPS_STALE_FALLBACK_SECONDS)

    async def _get_standings(self, year: int, season_type: int) -> dict[str, Any]:
        phase = 1 if season_type == 1 else 2
        return await self._cached_json(
            f"standings:{year}:{phase}", f"{STANDINGS_API}?season={year}&seasontype={phase}",
            STANDINGS_TTL_SECONDS, STANDINGS_STALE_FALLBACK_SECONDS,
        )

    async def _get_summary(self, event_id: str, looks_live: bool) -> dict[str, Any]:
        now = time.time()
        url = f"{SITE_API}/summary?event={event_id}"
        if looks_live:
            url += f"&_={int(now)}"
        try:
            summary = await self._get_json(url)
            if not _list(_dict(summary.get("header")).get("competitions")):
                raise UpdateFailed("ESPN summary has no competition")
            self._summary_cache[event_id] = (now, summary)
            # Navigation may visit many games. Bound the retained snapshots.
            while len(self._summary_cache) > 8:
                oldest = min(self._summary_cache, key=lambda key: self._summary_cache[key][0])
                del self._summary_cache[oldest]
            return summary
        except Exception as err:
            cached = self._summary_cache.get(event_id)
            if cached and now - cached[0] < SUMMARY_STALE_FALLBACK_SECONDS:
                return cached[1]
            raise UpdateFailed(f"Unable to fetch NHL game {event_id}: {err}") from err

    async def _assemble_game_data(
        self, events: list[dict[str, Any]], display_id: str, prev_id: str, next_id: str,
        live_id: str, schedule: dict[str, Any], *, live_bridge: bool,
    ) -> NhlLiveScoreboardData:
        team_name = str(_dict(schedule.get("team")).get("displayName") or self.team_abbr)
        if not display_id:
            return NhlLiveScoreboardData(team_abbr=self.team_abbr, team_id=self.team_id, team_name=team_name,
                                         next_game_start=self._next_game_start(events))
        if not _ID_RE.fullmatch(str(display_id)):
            raise UpdateFailed("Invalid ESPN event ID")
        event = next((e for e in events if str(e.get("id") or "") == str(display_id)), {})
        start = _parse_iso_ts(event.get("date"))
        looks_live = display_id == live_id or bool(
            live_bridge and getattr(self, "data", None) and self.data.display_event_id == display_id and self.data.is_live)
        if start is not None and start <= time.time() <= start + NEAR_GAME_LAG_SECONDS:
            looks_live = True
        summary = await self._get_summary(display_id, looks_live)
        comp = self._resolve_display_comp(summary, display_id, event)
        detail, is_live, delayed = self._resolve_status_info(comp)
        core_situation = {}
        if is_live:
            base = f"{CORE_API}/events/{display_id}/competitions/{display_id}"
            status_response, situation_response = await asyncio.gather(
                self._get_json(f"{base}/status"), self._get_json(f"{base}/situation"), return_exceptions=True,
            )
            if isinstance(status_response, dict) and isinstance(status_response.get("type"), dict):
                comp = {**(comp or {}), "status": {**_dict(_dict(comp).get("status")),
                                                  **{k: v for k, v in status_response.items() if k != "$ref"}}}
            core_situation = _dict(situation_response)
            detail, is_live, delayed = self._resolve_status_info(comp)
        if comp:
            # Keep every derived field on the same refreshed status. At a
            # period boundary the core status can advance before plays do;
            # the current-period list must then be empty, not last period's.
            summary = {**summary, "header": {**_dict(summary.get("header")), "competitions": [comp]}}
        away_id, home_id = self._resolve_competitor_ids(comp)
        year = _safe_int(_dict(comp).get("season")) or _safe_int(_dict(schedule.get("season")).get("year"))
        phase = _safe_int(_dict(comp).get("seasonType")) or 2
        team_ids = [away_id, home_id]
        results = await asyncio.gather(
            self._fetch_team_payload(away_id), self._fetch_team_payload(home_id),
            *(self._cached_json(f"roster:{year}:{tid}", f"{SITE_API}/teams/{tid}/roster?season={year}",
                               ROSTER_TTL_SECONDS, 24 * 60 * 60) if tid else asyncio.sleep(0, result={})
              for tid in team_ids),
            self._get_standings(year, phase), self._get_groups(),
        )
        away_payload, home_payload, away_roster, home_roster, standings, groups = results
        rosters = {away_id: away_roster, home_id: home_roster}
        team_stats = self._normalize_team_stats(summary, comp, rosters)
        goalies = self._normalize_goalies(summary, team_stats, rosters, live=is_live)
        goalie_ids = [str(_dict(goalies.get(side)).get("id") or "") for side in ("away", "home")]
        goalie_seasons = await self._get_team_season_stats([aid for aid in goalie_ids if aid])
        for side in ("away", "home"):
            goalie = _dict(goalies.get(side))
            season = goalie_seasons.get(str(goalie.get("id") or ""), {})
            category = _dict(_dict(season.get("categories")).get("goalies"))
            if goalie and season:
                goalie["season_stats"] = {**self._goalie_stat_line(self._stats_by_key(category, category)),
                                          "season": str(season.get("season") or "")}
        records = self._records_from_standings(standings)
        # Historical navigation keeps the record captured with that game.
        # Current live/upcoming games use phase-correct standings; never
        # replace a 0-0 regular-season record with a preseason record.
        use_live_records = live_bridge and (not _is_final(comp) or (
            start is not None and time.time() - start < SHOW_NEXT_AFTER_PREV_SECONDS))
        compact = self._compact_competition(comp, records if use_live_records else None)
        away_team, home_team = self._normalize_team_payload(away_payload), self._normalize_team_payload(home_payload)
        for side, normalized in (("away", away_team), ("home", home_team)):
            competitor = _competitor_for_side(compact or {}, side)
            fallback = self._normalize_team_payload({"team": _dict(competitor.get("team"))})
            for key in ("id", "abbreviation", "name", "short_name", "logo"):
                if not normalized.get(key):
                    normalized[key] = fallback.get(key, "")
            normalized["record_summary"] = str(competitor.get("recordSummary") or "")
        context = self._normalize_period_context(summary, comp)
        if live_bridge:
            self._live_summary_cache = (str(display_id), summary, dict(context))
        mode = "live" if is_live else "final" if _is_final(comp) else "next"
        return NhlLiveScoreboardData(
            team_abbr=self.team_abbr, team_id=self.team_id, team_name=team_name,
            display_event_id=display_id, previous_event_id=display_id if _is_final(comp) else prev_id,
            next_event_id=next_id, live_event_id=display_id if is_live else ("" if live_id == display_id else live_id),
            next_game_start=self._next_game_start(events, display_id, comp),
            selected_competition=compact, period_context=context,
            recent_plays=self._normalize_recent_plays(summary), scoring_plays=self._normalize_scoring_plays(summary),
            away_team=away_team, home_team=home_team, goalies=goalies,
            situation=self._normalize_situation(summary, comp, core_situation),
            current_period=self._normalize_period(self._selected_period(summary), comp), team_stats=team_stats,
            win_probability=self._normalize_win_probability(summary), leaders=self._normalize_leaders(summary, comp),
            division_standings=self._normalize_standings(standings, self._team_id_division_index(groups), self.team_id),
            highlights_url=self._extract_highlights_url(summary), mode=mode,
            status_text=detail, is_live=is_live, is_delayed=delayed,
        )

    async def async_get_game_at_offset(self, offset: int) -> dict[str, Any] | None:
        schedule, events = await self._resolve_schedule()
        prev_id, next_id, live_id, display_id, _ = self._select_event(events)
        # The summary may have become live while the cached schedule still
        # says pregame. The current sensor remains the navigation anchor.
        if getattr(self, "data", None) and self.data.display_event_id in {str(e.get("id")) for e in events}:
            display_id = self.data.display_event_id
        target, offset, has_prev, has_next = self._event_at_offset(events, display_id, offset)
        if not target:
            return None
        data = await self._assemble_game_data(events, target, prev_id, next_id, live_id, schedule, live_bridge=False)
        from .sensor import build_state_attributes
        return {"game_data": build_state_attributes(data), "offset": offset,
                "has_prev": has_prev, "has_next": has_next, "event_id": target}

    async def async_period_at_offset(self, offset: int) -> dict[str, Any] | None:
        if not self._live_summary_cache:
            return None
        _event_id, summary, context = self._live_summary_cache
        periods = self._all_periods(summary)
        if not periods:
            return None
        anchor = len(periods) - 1
        target = max(0, min(anchor + min(0, int(offset)), anchor))
        selected = periods[target]
        plays = self._normalize_recent_plays(summary, selected)
        last = plays[-1] if plays else {}
        number = _safe_int(selected.get("number"))
        shootout = bool(selected.get("is_shootout"))
        label = self._period_label(number, shootout)
        period_context = {**context, "period": number, "display_period": label, "display_clock": "",
                          "label": label, "is_shootout": shootout, "is_overtime": number > 3 and not shootout,
                          "is_intermission": False, "is_end_period": False, "period_prefix": ""}
        comp = _dict((_list(_dict(summary.get("header")).get("competitions")) or [{}])[0])
        return {"offset": target - anchor, "has_prev": target > 0, "has_next": target < anchor,
                "recent_plays": plays, "current_period": self._normalize_period(selected, comp),
                "period_context": period_context, "total_periods": len(periods), "is_current": target == anchor,
                "away_score": last.get("away_score"), "home_score": last.get("home_score")}

    @staticmethod
    def _detect_game_events(
        prev: NhlLiveScoreboardData | None, curr: NhlLiveScoreboardData, team_id: int,
    ) -> list[tuple[str, dict[str, Any]]]:
        if prev is None or prev.display_event_id != curr.display_event_id or not prev.selected_competition:
            return []
        comp = curr.selected_competition or {}
        my_side, opp_side = _resolve_my_side(comp, team_id)
        if my_side is None or opp_side is None:
            return []
        my_score, opp_score = _scores_for_sides(comp, my_side, opp_side)
        previous_my, previous_opp = _scores_for_sides(prev.selected_competition, my_side, opp_side)
        opponent = _dict(_competitor_for_side(comp, opp_side).get("team"))
        period = _safe_int(curr.period_context.get("period"))
        base = {
            "team_abbr": curr.team_abbr, "team_name": curr.team_name, "team_score": my_score,
            "opponent_abbr": opponent.get("abbreviation") or "",
            "opponent_name": opponent.get("displayName") or opponent.get("name") or "",
            "opponent_score": opp_score, "is_home": my_side == "home",
            "period": period, "clock": curr.period_context.get("display_clock") or "",
            "is_overtime": bool(curr.period_context.get("is_overtime")),
            "is_shootout": bool(curr.period_context.get("is_shootout")),
            "strength": curr.situation.get("strength") or "",
            "power_play_team_id": curr.situation.get("power_play_team_id") or "",
            "event_id": curr.display_event_id, "status_detail": curr.status_text,
        }
        events = []
        previous_scores = [_optional_int(_competitor_for_side(prev.selected_competition, s).get("score"))
                           for s in (my_side, opp_side)]
        current_scores = [_optional_int(_competitor_for_side(comp, s).get("score")) for s in (my_side, opp_side)]
        valid_previous_scores = all(score is not None and score >= 0 for score in previous_scores)
        valid_current_scores = all(score is not None and score >= 0 for score in current_scores)
        if (valid_previous_scores and valid_current_scores and not curr.is_delayed
                and not curr.period_context.get("is_shootout")
                and not _is_unplayed(comp) and (curr.is_live or prev.is_live)):
            for name, delta, scoring_side in (
                (EVENT_TEAM_SCORED, my_score - previous_my, my_side),
                (EVENT_OPPONENT_SCORED, opp_score - previous_opp, opp_side),
            ):
                if not 0 < delta <= MAX_PLAUSIBLE_SCORE_DELTA:
                    continue
                scoring_team = _team_id(_competitor_for_side(comp, scoring_side).get("team"))
                new_score = _optional_int(_competitor_for_side(comp, scoring_side).get("score"))
                scoring_text = next((str(p.get("text") or "") for p in reversed(curr.scoring_plays)
                                     if p.get("team_id") == scoring_team and not p.get("is_shootout")
                                     and _optional_int(p.get(f"{scoring_side}_score")) == new_score), "")
                if not scoring_text:
                    scoring_text = next((str(p.get("text") or "") for p in reversed(curr.recent_plays)
                                         if p.get("scoring_play") and not p.get("is_shootout")
                                         and p.get("team_id") == scoring_team
                                         and _optional_int(p.get(f"{scoring_side}_score")) == new_score), "")
                events.append((name, {**base, "score_delta": delta, "scoring_play_text": scoring_text}))
        # A delay before puck drop is not a game start.
        previous_period = _safe_int(prev.period_context.get("period"))
        previous_pre_game_delay = prev.is_delayed and previous_period == 0
        if ((not prev.is_live or previous_pre_game_delay) and curr.is_live
                and (period > 0 or not curr.is_delayed)):
            events.append((EVENT_GAME_STARTED, dict(base)))
        if (valid_current_scores and _is_final(comp)
                and (not _is_final(prev.selected_competition) or not valid_previous_scores)):
            events.append((EVENT_GAME_ENDED, dict(base)))
            if my_score > opp_score:
                events.append((EVENT_GAME_WON, dict(base)))
            elif my_score < opp_score:
                events.append((EVENT_GAME_LOST, dict(base)))
        return events

    _ONCE_PER_GAME_EVENTS = frozenset({EVENT_GAME_STARTED, EVENT_GAME_ENDED, EVENT_GAME_WON, EVENT_GAME_LOST})

    def _suppress_repeat_once_events(
        self, events: list[tuple[str, dict[str, Any]]], event_id: str | None,
    ) -> list[tuple[str, dict[str, Any]]]:
        if event_id != self._fired_once_event_id:
            self._fired_once_event_id = event_id
            self._fired_once_events = set()
        result = []
        for name, payload in events:
            if name in self._ONCE_PER_GAME_EVENTS:
                if name in self._fired_once_events:
                    continue
                self._fired_once_events.add(name)
            result.append((name, payload))
        return result

    def _filter_score_rebounds(
        self, events: list[tuple[str, dict[str, Any]]], data: NhlLiveScoreboardData,
    ) -> list[tuple[str, dict[str, Any]]]:
        now = time.time()
        if getattr(self, "_score_event_id", None) != data.display_event_id:
            self._score_event_id = data.display_event_id
            self._score_high_water = {}
            self._event_baseline_ts = None
        previous_high = dict(self._score_high_water)
        comp = data.selected_competition or {}
        sides = _resolve_my_side(comp, self.team_id)
        if all(sides):
            for label, side in zip(("team", "opponent"), sides, strict=True):
                score = _optional_int(_competitor_for_side(comp, side).get("score"))
                if score is not None:
                    self._score_high_water[label] = max(score, previous_high.get(label, score))
        gap = now - self._event_baseline_ts if self._event_baseline_ts is not None else None
        self._event_baseline_ts = now
        result = []
        for name, payload in events:
            if name in {EVENT_TEAM_SCORED, EVENT_OPPONENT_SCORED}:
                label = "team" if name == EVENT_TEAM_SCORED else "opponent"
                score = _safe_int(payload.get(f"{label}_score"))
                # Startup, a missed stretch of polling, and ESPN's stale
                # score -> corrected score bounce all rebaseline silently.
                if label not in previous_high or (gap is not None and gap > 120) or score <= previous_high[label]:
                    continue
            result.append((name, payload))
        return result

    def _dispatch_game_events(self, events: list[tuple[str, dict[str, Any]]]) -> None:
        options = self.entry.options or {}
        for name, payload in events:
            self.hass.bus.async_fire(name, payload)
            sequence = options.get(EVENT_OPTION_KEYS.get(name, ""))
            if sequence:
                self.hass.async_create_task(self._run_event_action(name, sequence, payload))

    async def _run_event_action(self, event_name: str, sequence: Any, payload: dict[str, Any]) -> None:
        from homeassistant.helpers import config_validation as cv
        from homeassistant.helpers.script import async_validate_actions_config

        script = None
        try:
            # Options selectors store JSON, not the validated Template and
            # condition objects expected by Home Assistant's script engine.
            validated = await async_validate_actions_config(self.hass, cv.SCRIPT_SCHEMA(sequence))
            script = Script(self.hass, validated, f"{DOMAIN} {event_name}", DOMAIN)
            await script.async_run(payload, Context())
        except Exception as err:
            _LOGGER.warning("Configured action for %s failed: %s", event_name, err)
        finally:
            # Current HA retains top-level scripts in its registry. Each
            # one-shot game action must release that registration afterwards.
            if script is not None and hasattr(script, "async_unload"):
                await script.async_unload()

    def _compute_update_interval(self, data: NhlLiveScoreboardData, events: list[dict[str, Any]]) -> timedelta:
        if data.is_live:
            return timedelta(seconds=SCAN_INTERVAL_LIVE_SECONDS)
        now = time.time()
        for event in events:
            start = _parse_iso_ts(event.get("date"))
            if start is not None and start - NEAR_GAME_LEAD_SECONDS <= now <= start + NEAR_GAME_LAG_SECONDS:
                return timedelta(seconds=SCAN_INTERVAL_NEAR_GAME_SECONDS)
        return timedelta(seconds=SCAN_INTERVAL_IDLE_SECONDS)

    async def _async_update_data(self) -> NhlLiveScoreboardData:
        schedule, events = await self._resolve_schedule()
        prev_id, next_id, live_id, display_id, _ = self._select_event(events)
        data = await self._assemble_game_data(
            events, display_id, prev_id, next_id, live_id, schedule, live_bridge=True)
        # Only authoritative polling updates finish metadata. Historical
        # card navigation must never establish or restart a postgame window.
        live_summary = self._live_summary_cache
        end_metadata = await self._game_end_tracker.async_update(
            events=events, current_id=data.display_event_id, current_comp=data.selected_competition,
            current_summary=live_summary[1] if live_summary and live_summary[0] == data.display_event_id else {},
            summary_cache=self._summary_cache, fetch_summary=self._get_summary)
        for key, value in end_metadata.items():
            setattr(data, key, value)
        self.update_interval = self._compute_update_interval(data, events)
        try:
            detected = self._detect_game_events(getattr(self, "data", None), data, self.team_id)
            detected = self._filter_score_rebounds(detected, data)
            detected = self._suppress_repeat_once_events(detected, data.display_event_id)
            self._dispatch_game_events(detected)
            if any(name == EVENT_GAME_ENDED for name, _payload in detected):
                for key in list(self._json_cache):
                    if key.startswith("standings:"):
                        del self._json_cache[key]
                self._schedule_cache = None
        except Exception as err:
            _LOGGER.warning("Game-event dispatch failed without interrupting the scoreboard: %s", err)
        return data
