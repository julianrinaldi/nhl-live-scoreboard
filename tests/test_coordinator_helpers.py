"""Offline NHL regressions using captured ESPN data and explicit edge cases."""

from __future__ import annotations

import copy
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from custom_components.nhl_live_scoreboard.const import (
    EVENT_GAME_ENDED,
    EVENT_GAME_LOST,
    EVENT_GAME_STARTED,
    EVENT_GAME_WON,
    EVENT_OPPONENT_SCORED,
    EVENT_TEAM_SCORED,
    NHL_TEAM_MAP,
    SCHEDULE_STALE_FALLBACK_SECONDS,
    SCHEDULE_TTL_SECONDS,
    USER_AGENT,
)
from custom_components.nhl_live_scoreboard.coordinator import (
    NhlLiveScoreboardCoordinator as C,
)
from custom_components.nhl_live_scoreboard.coordinator import (
    NhlLiveScoreboardData as Data,
)
from custom_components.nhl_live_scoreboard.coordinator import (
    _is_final,
    _optional_int,
    _parse_iso_ts,
    _safe_int,
    _team_id,
)

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


@pytest.fixture
def final():
    return fixture("summary_401803619_final.json")


@pytest.fixture
def overtime():
    return fixture("summary_401803625_overtime.json")


@pytest.fixture
def shootout():
    return fixture("summary_401803626_shootout.json")


@pytest.fixture
def coordinator():
    hass = SimpleNamespace(config=SimpleNamespace(time_zone="America/New_York"))
    entry = SimpleNamespace(data={"team": "NYR"}, title="NHL", options={})
    return C(hass, entry)


def competition(state="in", name="STATUS_IN_PROGRESS", away=1, home=2, period=2):
    return {
        "id": "1", "date": "2026-04-11T21:00Z", "season": 2026, "seasonType": 2,
        "status": {"period": period, "displayClock": "8:15", "type": {
            "state": state, "name": name, "completed": state == "post" and name == "STATUS_FINAL",
            "detail": "Final" if state == "post" else "8:15 - 2nd Period"}},
        "competitors": [
            {"homeAway": "home", "score": str(home), "team": {"id": "13", "abbreviation": "NYR", "displayName": "New York Rangers"}},
            {"homeAway": "away", "score": str(away), "team": {"id": "9", "abbreviation": "DAL", "displayName": "Dallas Stars"}},
        ],
    }


def data(comp=None, event_id="1", is_live=True, delayed=False):
    comp = comp or competition()
    result = Data(team_abbr="NYR", team_id=13, team_name="New York Rangers", display_event_id=event_id,
                  selected_competition=comp, period_context={"period": comp["status"]["period"], "display_clock": "8:15"},
                  is_live=is_live, is_delayed=delayed, status_text="8:15 - 2nd Period")
    return result


def event(event_id, hours, state="pre", name="STATUS_SCHEDULED", phase=2):
    timestamp = datetime(2026, 4, 11, 21, tzinfo=UTC) + timedelta(hours=hours)
    comp = competition(state, name)
    comp["id"] = str(event_id)
    return {"id": str(event_id), "date": timestamp.isoformat(), "season": {"year": 2026},
            "seasonType": {"type": phase}, "competitions": [comp]}


@pytest.mark.parametrize(("value", "expected"), [(None, 0), ("", 0), ("2", 2), ("2.0", 2), ("bad", 0),
                                                 ("nan", 0), ("inf", 0), (True, 0), ({"value": 3}, 3)])
def test_safe_scores(value, expected):
    assert _safe_int(value) == expected


def test_dates_and_reference_ids():
    assert _parse_iso_ts("2026-04-11T21:00Z") == datetime(2026, 4, 11, 21, tzinfo=UTC).timestamp()
    assert _parse_iso_ts("2026-04-11T21:00:00") is None
    assert _parse_iso_ts("bad") is None
    assert _team_id({"$ref": "http://sports.core.api.espn.com/x/competitors/13?lang=en"}) == "13"
    assert _team_id("13") == "13"
    assert _optional_int("0") == 0


def test_exact_current_32_team_map_and_contact_user_agent():
    teams = fixture("teams_20260903.json")["teams"]
    assert {t["abbreviation"]: int(t["id"]) for t in teams} == NHL_TEAM_MAP
    assert len(NHL_TEAM_MAP) == 32
    assert NHL_TEAM_MAP["UTAH"] == 129764
    assert next(t for t in teams if t["abbreviation"] == "UTAH")["displayName"] == "Utah Mammoth"
    assert USER_AGENT.startswith("nhl-live-scoreboard/")
    assert "(+https://github.com/julianrinaldi/nhl-live-scoreboard)" in USER_AGENT


def test_real_regulation_final_has_three_periods_and_ot_loss_record(final):
    comp = final["header"]["competitions"][0]
    compact = C._compact_competition(comp)
    home, away = compact["competitors"]
    assert home["recordSummary"].startswith("48-20-12")
    assert away["recordSummary"].startswith("33-38-9")
    assert [q["value"] for q in home["linescores"]] == [0, 0, 2]
    assert sum(q["value"] for q in home["linescores"]) == int(home["score"]) == 2
    context = C._normalize_period_context(final, comp)
    assert context["period"] == 3
    assert context["display_clock"] == ""


@pytest.mark.parametrize(("period", "label"), [(1, "1st"), (2, "2nd"), (3, "3rd"), (4, "OT"), (5, "2OT"), (6, "3OT"), (0, "")])
def test_three_regulation_periods_and_postseason_overtimes(period, label):
    assert C._period_label(period) == label


def test_live_period_uses_countdown_status_clock_not_elapsed_play_clock(final):
    comp = competition(period=3)
    comp["status"]["displayClock"] = "7:11"
    summary = copy.deepcopy(final)
    summary["plays"] = [p for p in summary["plays"] if p.get("clock", {}).get("displayValue") == "12:49"]
    context = C._normalize_period_context(summary, comp)
    assert context["display_clock"] == "7:11"


def test_real_overtime_and_shootout_are_distinct(overtime, shootout):
    ot = C._normalize_period_context(overtime, overtime["header"]["competitions"][0])
    so = C._normalize_period_context(shootout, shootout["header"]["competitions"][0])
    assert ot["display_period"] == "OT"
    assert ot["is_overtime"] is True
    assert not ot.get("is_shootout", False)
    assert so["display_period"] == "SO"
    assert so["is_shootout"] is True


def test_intermission_clears_clock_and_is_not_halftime():
    comp = competition(name="STATUS_END_PERIOD", period=2)
    comp["status"]["type"]["detail"] = "2nd Intermission"
    context = C._normalize_period_context({}, comp)
    assert context["is_intermission"] is True
    assert context["display_clock"] == ""
    assert "halftime" not in json.dumps(context).lower()


def test_missing_live_clock_does_not_substitute_elapsed_play_time(final):
    comp = competition(period=3)
    comp["status"].pop("displayClock")
    comp["status"]["type"]["detail"] = "In Progress"
    assert C._normalize_period_context(final, comp)["display_clock"] == ""


def test_real_periods_sort_and_deduplicate_plays(final):
    shuffled = copy.deepcopy(final)
    shuffled["plays"] = [*reversed(final["plays"]), final["plays"][0]]
    periods = C._all_periods(shuffled)
    assert [p["number"] for p in periods] == [1, 2, 3]
    assert len(C._all_plays(shuffled)) == len(final["plays"])
    current = C._selected_period(shuffled)
    assert current["number"] == 3
    normalized = C._normalize_period(current, final["header"]["competitions"][0])
    assert normalized["goals"] == 2
    assert normalized["away_goals"] == 0
    assert normalized["home_goals"] == 2
    assert all(p["period"] == 3 for p in C._normalize_recent_plays(shuffled))


def test_new_empty_period_does_not_show_prior_period_plays(final):
    summary = copy.deepcopy(final)
    summary["plays"] = [p for p in summary["plays"] if p["period"]["number"] == 1]
    summary["header"]["competitions"] = [competition(period=2)]
    assert C._selected_period(summary)["number"] == 2
    assert C._normalize_recent_plays(summary) == []


def test_real_goal_summary_uses_plays_and_excludes_shootout_attempts(final, shootout):
    goals = C._normalize_scoring_plays(final)
    assert len(goals) == 2
    assert [g["score_value"] for g in goals] == [1, 1]
    assert [g["home_score"] for g in goals] == [1, 2]
    assert goals[0]["strength"] == "Power Play"
    assert goals[1]["strength"] == "Empty Net"
    so_goals = C._normalize_scoring_plays(shootout)
    assert len(so_goals) == 6  # Three regulation goals each, not the4-3 official SO result.
    assert all(not p["is_shootout"] and p["period"] < 5 for p in so_goals)
    so_plays = C._normalize_recent_plays(shootout)
    assert any(p["scoring_play"] for p in so_plays)
    assert all(p["is_shootout"] for p in so_plays)
    assert all(p["away_score"] is None and p["home_score"] is None and p["score_value"] == 0 for p in so_plays)
    assert C._normalize_period(C._selected_period(shootout))["goals"] == 0


def test_real_shot_coordinates_and_false_shootingplay_boundary(final):
    first = C._all_periods(final)[0]
    plays = C._normalize_recent_plays(final, first)
    boundary = next(p for p in plays if p["play_type"] == "Period Start")
    assert boundary["is_shot"] is False
    assert boundary["coordinate"] == {}
    shot = next(p for p in plays if p["play_type"] == "Shot")
    assert shot["coordinate"] == {"x": 57, "y": 29}
    assert shot["clock"] == "7:58"  # Play clocks stay explicitly elapsed.


def test_real_penalty_types_do_not_need_a_literal_penalty_word(final):
    first = C._all_periods(final)[0]
    penalties = [p for p in C._normalize_recent_plays(final, first) if p["play_type"] == "Roughing"]
    assert len(penalties) == 2
    assert all(p["is_penalty"] and not p["is_shot"] for p in penalties)


@pytest.mark.parametrize(("text", "abbreviation"), [("Missed", "shot-missed"), ("Blocked", "shot-blocked")])
def test_espn_missed_and_blocked_shot_types_are_retained(text, abbreviation):
    raw = {"id": "1", "text": "Shot event", "type": {"text": text, "abbreviation": abbreviation},
           "period": {"number": 1}, "coordinate": {"x": 70, "y": -10}}
    normalized = C._normalize_recent_plays({"plays": [raw]})[0]
    assert normalized["is_shot"] is True
    assert normalized["coordinate"] == {"x": 70, "y": -10}


@pytest.mark.parametrize("coordinate", [{"x": 101, "y": 0}, {"x": 0, "y": 43}, {"x": float("nan"), "y": 0}, {"x": True, "y": 0}, {"x": 0}, {}])
def test_invalid_rink_coordinates_are_not_plotted(coordinate):
    raw = {"id": "1", "sequenceNumber": "1", "text": "Shot saved", "type": {"text": "Shot"},
           "period": {"number": 1}, "coordinate": coordinate}
    result = C._normalize_recent_plays({"plays": [raw]})[0]
    assert result["coordinate"] == {}


def test_situation_uses_actual_shots_not_shootout_goals_and_no_stale_manpower(final):
    comp = final["header"]["competitions"][0]
    result = C._normalize_situation(final, comp)
    assert result["away_shots_on_goal"] == 22
    assert result["home_shots_on_goal"] == 19  # Includes the empty-net goal; goalie faced18.
    assert result["strength"] == ""
    assert result["away_empty_net"] is None
    assert result["home_empty_net"] is None
    live = copy.deepcopy(comp)
    live["status"] = competition()["status"]
    known = C._normalize_situation(final, live, {"awayShotsOnGoal": 0, "strength": "Power Play", "powerPlayTeamId": "9", "awayEmptyNet": True, "homeEmptyNet": False})
    assert known["away_shots_on_goal"] == 0
    assert known["power_play_team_id"] == "9"
    assert known["away_empty_net"] is True
    assert known["home_empty_net"] is False


def test_global_live_power_play_and_empty_net_flags_do_not_invent_team_identity():
    result = C._normalize_situation({}, competition(), {"powerPlay": True, "emptyNet": True})
    assert result["power_play"] is True
    assert result["empty_net"] is True
    assert result["power_play_team_id"] == ""
    assert result["away_empty_net"] is None and result["home_empty_net"] is None
    unknown = C._normalize_situation({}, competition(), {"powerPlay": "false", "emptyNet": 0})
    assert unknown["power_play"] is None and unknown["empty_net"] is None
    assert unknown["strength"] == ""


def test_real_boxscore_separates_skater_and_goalie_stats(final):
    stats = C._normalize_team_stats(final)
    home = {c["name"]: c for c in stats["home"]["categories"]}
    assert {"forwards", "defenses", "goalies"} <= set(home)
    assert home["goalies"]["rows"][0]["name"] == "Jake Oettinger"
    goalie = C._stats_by_key(home["goalies"], home["goalies"]["rows"][0])
    assert goalie["saves"] == "22"
    assert goalie["savePct"] == "1.000"
    assert "goalsAgainst" not in home["forwards"]["keys"]
    assert all(len(r["stats"]) == len(c["keys"]) for c in home.values() for r in c["rows"])


def test_real_goalie_matchup_uses_goalie_statistics(final):
    goalies = C._normalize_goalies(final, C._normalize_team_stats(final))
    assert goalies["away"]["display_name"] == "Igor Shesterkin"
    assert goalies["home"]["display_name"] == "Jake Oettinger"
    assert goalies["home"]["game_stats"]["saves"] == "22"
    assert goalies["home"]["game_stats"]["save_percentage"] == "1.000"


def test_live_goalie_substitution_uses_latest_saver_participant():
    rows = [{"id": "1", "name": "Starter Goalie", "position": "G", "stats": ["20", "18", "2", ".900"]},
            {"id": "2", "name": "Backup Goalie", "position": "G", "stats": ["1", "1", "0", "1.000"]}]
    stats = {"home": {"team_id": "13", "source": "game", "categories": [
        {"name": "goalies", "keys": ["shotsAgainst", "saves", "goalsAgainst", "savePct"], "rows": rows}]}}
    summary = {"plays": [{"id": "1", "text": "Shot saved", "period": {"number": 3},
                          "participants": [{"type": "saver", "athlete": {"id": "2"}}]}]}
    assert C._normalize_goalies(summary, stats, live=True)["home"]["id"] == "2"
    assert C._normalize_goalies(summary, stats, live=False)["home"]["id"] == "1"


def test_pregame_roster_order_does_not_invent_a_starting_goalie():
    comp = competition("pre", "STATUS_SCHEDULED", away=0, home=0, period=0)
    roster = {"13": {"athletes": [{"id": "1", "displayName": "First Listed Goalie", "position": {"abbreviation": "G"}},
                                  {"id": "2", "displayName": "Forward", "position": {"abbreviation": "C"}}]}}
    summary = {"header": {"competitions": [comp]}}
    stats = C._normalize_team_stats(summary, comp, roster)
    assert stats["home"]["source"] == "roster"
    assert C._normalize_goalies(summary, stats, roster, live=False)["home"] == {}
    comp["competitors"][0]["probables"] = [{"name": "startingGoalie", "athlete": roster["13"]["athletes"][0]}]
    chosen = C._normalize_goalies(summary, stats, roster, live=False)["home"]
    assert chosen["id"] == "1"
    assert chosen["source"] == "probable"


def test_zeroed_pregame_boxscore_does_not_turn_a_roster_goalie_into_a_starter():
    comp = competition("pre", "STATUS_SCHEDULED", away=0, home=0, period=0)
    stats = {"home": {"team_id": "13", "source": "game", "categories": [
        {"name": "goalies", "keys": ["shotsAgainst", "saves"], "rows": [
            {"id": "1", "name": "Unconfirmed Goalie", "position": "G", "stats": ["0", "0"]}]}]}}
    assert C._normalize_goalies({"header": {"competitions": [comp]}}, stats, live=False)["home"] == {}


def test_real_leaders_map_by_team_identity_not_array_order(final):
    result = C._normalize_leaders(final)
    assert result["away"] == []
    assert [p["category"] for p in result["home"]] == ["Goals", "Assists", "Points"]
    assert result["home"][0]["value"] == "2"


@pytest.mark.parametrize(("athlete_id", "kind", "stat_key", "value"), [("3151297", "goalies", "saves", "1299"), ("4233875", "forwards", "goals", "45")])
def test_real_goalie_and_skater_season_stats(athlete_id, kind, stat_key, value):
    stats = fixture(f"athlete_{athlete_id}_stats.json")
    line = C._extract_season_line(stats)
    assert str(line["season"]) in {"2026", "25-26", "2025-26"}
    category = line["categories"][kind]
    assert dict(zip(category["keys"], category["stats"], strict=True))[stat_key] == value
    if kind == "forwards":
        assert dict(zip(category["keys"], category["stats"], strict=True)).get("shotsTotal", "") == ""


@pytest.mark.parametrize("athlete_id", ["3151297", "4233875"])
def test_real_hockey_career_tables_remain_position_specific(athlete_id):
    bio = fixture(f"athlete_{athlete_id}_bio.json")
    stats = fixture(f"athlete_{athlete_id}_stats.json")
    card = C._parse_player_card(athlete_id, bio, stats)
    assert card["bio"]["name"] == bio["athlete"]["displayName"]
    assert len(card["career"]["seasons"]) == 2
    assert card["career"]["seasons"][-1]["team"] in {"NYR", "DAL"}
    assert "bats_throws" not in card["bio"]
    assert "completions" not in card["career"]["keys"]


def test_traded_goalie_prefers_espn_total_over_team_split_without_adding_rates():
    raw = fixture("athlete_3151297_stats.json")
    category = raw["categories"][0]
    template = copy.deepcopy(category["statistics"][-1])
    total = copy.deepcopy(template)
    total["teamId"], total["teamSlug"] = "0", "total"
    saves = category["names"].index("saves")
    rate = category["names"].index("savePct")
    template["stats"][saves], template["stats"][rate] = "200", ".800"
    total["stats"][saves], total["stats"][rate] = "1499", ".910"
    category["statistics"] = [total, template]  # Total need not be the last row.
    result = C._extract_season_line(raw)["categories"]["goalies"]
    values = dict(zip(result["keys"], result["stats"], strict=True))
    assert values["saves"] == "1499"
    assert values["savePct"] == ".910"


def test_real_metropolitan_standings_include_overtime_losses_and_points():
    groups = fixture("groups_20260903.json")
    standings = fixture("standings_metropolitan_2026.json")
    divisions = C._team_id_division_index(groups)
    result = C._normalize_standings(standings, divisions, 13)
    assert result["division_name"] == "Metropolitan Division"
    assert [e["team_id"] for e in result["entries"]] == ["12", "11", "13"]
    rangers = result["entries"][-1]
    assert (rangers["wins"], rangers["losses"], rangers["overtime_losses"], rangers["points"]) == ("34", "39", "9", "77")
    assert C._records_from_standings(standings)["13"].startswith("34-39-9")


def test_schedule_selection_sorts_and_prefers_live(coordinator, monkeypatch):
    now = datetime(2026, 4, 11, 21, tzinfo=UTC).timestamp()
    monkeypatch.setattr("custom_components.nhl_live_scoreboard.coordinator.time.time", lambda: now)
    previous, future, live = event(1, -48, "post", "STATUS_FINAL"), event(3, 48), event(2, -1, "in", "STATUS_IN_PROGRESS")
    result = coordinator._select_event([future, live, previous])
    assert result[:4] == ("1", "3", "2", "2")


def test_recent_final_holds_then_next_game_and_stale_pregame_is_fetched(coordinator, monkeypatch):
    now = datetime(2026, 4, 11, 21, tzinfo=UTC).timestamp()
    monkeypatch.setattr("custom_components.nhl_live_scoreboard.coordinator.time.time", lambda: now)
    assert coordinator._select_event([event(1, -10, "post", "STATUS_FINAL"), event(2, 36)])[3] == "1"
    assert coordinator._select_event([event(1, -20, "post", "STATUS_FINAL"), event(2, 36)])[3] == "2"
    assert coordinator._select_event([event(2, -1), event(3, 48)])[3] == "2"


def test_merge_deduplicates_phases_and_rejects_wrong_year():
    early, later = event(1, -24, phase=1), event(2, 24, phase=2)
    wrong = copy.deepcopy(later)
    wrong["id"], wrong["season"]["year"] = "3", 2025
    merged = C._merge_schedules([{"events": [later]}, {"events": [wrong, early, later]}], 2026)
    assert [e["id"] for e in merged["events"]] == ["1", "2"]


@pytest.mark.asyncio
@pytest.mark.parametrize("metadata_mode", ["observed", "missing_requested", "stale_requested", "older_first_event"])
async def test_offseason_schedule_uses_actual_upcoming_year(coordinator, monkeypatch, metadata_mode):
    """ESPN advertises generic 2026 metadata alongside the 2026-27 schedule."""
    now = datetime(2026, 9, 3, 16, tzinfo=UTC).timestamp()
    monkeypatch.setattr("custom_components.nhl_live_scoreboard.coordinator.time.time", lambda: now)
    default = fixture("schedule_nyr_default_20260903.json")
    assert default["season"]["year"] == 2026
    assert default["requestedSeason"]["year"] == 2027
    if metadata_mode in {"missing_requested", "older_first_event"}:
        default.pop("requestedSeason")
    elif metadata_mode == "stale_requested":
        default["requestedSeason"]["year"] = 2025
    if metadata_mode == "older_first_event":
        # Synthetic mixed-year response: do not mistake its first event for
        # the effective season when most events belong to the upcoming year.
        comp = fixture("summary_401803619_final.json")["header"]["competitions"][0]
        default["events"].insert(0, {"id": comp["id"], "date": comp["date"],
            "season": {"year": 2026}, "seasonType": {"type": 2}, "competitions": [comp]})
    base = "https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/teams/nyr/schedule"
    responses = {
        base: default,
        f"{base}?season=2027&seasontype=1": fixture("schedule_nyr_preseason_2027.json"),
        f"{base}?season=2027&seasontype=3": fixture("schedule_nyr_postseason_2027.json"),
    }
    coordinator._get_json = AsyncMock(side_effect=lambda url: copy.deepcopy(responses[url]))
    schedule = await coordinator._fetch_schedule()
    assert schedule["season"]["year"] == 2027
    assert [e["id"] for e in schedule["events"]] == ["401879645", "401879649", "401891774", "401893730"]
    assert {call.args[0] for call in coordinator._get_json.await_args_list} == set(responses)
    assert coordinator._select_event(schedule["events"])[:4] == ("", "401879645", "", "401879645")
    assert schedule["events"][0]["date"] == "2026-09-21T23:00Z"
    # The effective season and its upcoming events also survive the cache.
    assert await coordinator._fetch_schedule() == schedule
    assert coordinator._get_json.await_count == 3


@pytest.mark.parametrize(("offset", "expected"), [(-99, ("1", -1, False, True)), (0, ("2", 0, True, True)), (99, ("3", 1, True, False))])
def test_game_navigation_clamps(offset, expected):
    assert C._event_at_offset([event(3, 24), event(1, -24), event(2, 0)], "2", offset) == expected


def test_one_goal_events_use_nhl_period_and_team_context():
    events = C._detect_game_events(data(competition(home=2)), data(competition(home=3)), 13)
    assert events[0][0] == EVENT_TEAM_SCORED
    assert events[0][1]["score_delta"] == 1
    assert events[0][1]["period"] == 2
    assert events[0][1]["team_abbr"] == "NYR"
    assert "quarter" not in events[0][1]
    assert "down" not in events[0][1]
    assert C._detect_game_events(data(), data(competition(away=2)), 13)[0][0] == EVENT_OPPONENT_SCORED


def test_goal_event_does_not_attach_an_old_or_opponent_scoring_description():
    previous, current = data(competition(home=2)), data(competition(home=3))
    current.scoring_plays = [{"team_id": "13", "home_score": 2, "away_score": 1, "text": "An earlier Rangers goal"}]
    current.recent_plays = [{"team_id": "9", "home_score": 2, "away_score": 1, "scoring_play": True, "text": "An opponent goal"}]
    events = C._detect_game_events(previous, current, 13)
    assert events[0][1]["scoring_play_text"] == ""
    current.scoring_plays.append({"team_id": "13", "home_score": 3, "away_score": 1, "text": "The actual new Rangers goal"})
    assert C._detect_game_events(previous, current, 13)[0][1]["scoring_play_text"] == "The actual new Rangers goal"


@pytest.mark.parametrize("delta", [-2, -1, 0, 2, 3, 6])
def test_score_corrections_and_multiple_missed_goals_not_announced(delta):
    assert C._detect_game_events(data(competition(home=3)), data(competition(home=3 + delta)), 13) == []


def test_startup_new_game_and_delay_suppress_goal_events():
    current = data()
    assert C._detect_game_events(None, current, 13) == []
    assert C._detect_game_events(data(event_id="0"), current, 13) == []
    assert C._detect_game_events(data(), data(competition(home=3), delayed=True), 13) == []
    assert C._detect_game_events(data(), current, 129764) == []


def test_delay_before_puck_drop_then_live_starts_once():
    scheduled = data(competition("pre", "STATUS_SCHEDULED", away=0, home=0, period=0), is_live=False)
    delayed = data(competition("pre", "STATUS_DELAYED", away=0, home=0, period=0), delayed=True)
    current = data(competition(away=0, home=0, period=1))
    assert C._detect_game_events(scheduled, delayed, 13) == []
    assert [e[0] for e in C._detect_game_events(delayed, current, 13)] == [EVENT_GAME_STARTED]
    assert C._detect_game_events(current, current, 13) == []


@pytest.mark.parametrize(("home", "away", "expected"), [(3, 2, [EVENT_GAME_ENDED, EVENT_GAME_WON]), (2, 3, [EVENT_GAME_ENDED, EVENT_GAME_LOST])])
def test_final_won_lost(home, away, expected):
    previous = data(competition(home=home, away=away))
    current = data(competition("post", "STATUS_FINAL", home=home, away=away), is_live=False)
    assert [e[0] for e in C._detect_game_events(previous, current, 13)] == expected


def test_shootout_winning_point_fires_result_but_not_individual_goal():
    previous = data(competition(away=3, home=3, period=5))
    current = data(competition("post", "STATUS_FINAL", away=3, home=4, period=5), is_live=False)
    previous.period_context["is_shootout"] = current.period_context["is_shootout"] = True
    current.selected_competition["status"]["type"]["detail"] = "Final/SO"
    assert [e[0] for e in C._detect_game_events(previous, current, 13)] == [EVENT_GAME_ENDED, EVENT_GAME_WON]


@pytest.mark.parametrize("missing", [None, "", "bad", "nan", "-1"])
def test_final_waits_for_numeric_scores(missing):
    previous = data(competition(home=3, away=2))
    incomplete = data(competition("post", "STATUS_FINAL", home=3, away=2), is_live=False)
    incomplete.selected_competition["competitors"][0]["score"] = missing
    current = data(competition("post", "STATUS_FINAL", home=3, away=2), is_live=False)
    assert C._detect_game_events(previous, incomplete, 13) == []
    assert [e[0] for e in C._detect_game_events(incomplete, current, 13)] == [EVENT_GAME_ENDED, EVENT_GAME_WON]


@pytest.mark.parametrize("name", ["STATUS_POSTPONED", "STATUS_CANCELED", "STATUS_CANCELLED"])
def test_unplayed_post_status_is_not_a_final(name):
    comp = competition("post", name)
    comp["status"]["type"]["completed"] = False
    assert not _is_final(comp)
    assert C._detect_game_events(data(), data(comp, is_live=False), 13) == []


@pytest.mark.parametrize("name", ["STATUS_DELAYED", "STATUS_SUSPENDED"])
def test_interruptions_keep_fast_poll(name):
    assert C._resolve_status_info(competition(name=name))[1:] == (True, True)


def test_goal_rebound_and_missed_polling_are_rebaselined(coordinator, monkeypatch):
    now = [1000.0]
    monkeypatch.setattr("custom_components.nhl_live_scoreboard.coordinator.time.time", lambda: now[0])
    high, low = data(competition(home=3)), data(competition(home=2))
    coordinator._filter_score_rebounds([], high)
    now[0] += 5
    coordinator._filter_score_rebounds([], low)
    now[0] += 5
    assert coordinator._filter_score_rebounds(C._detect_game_events(low, high, 13), high) == []
    current = data(competition(home=4))
    now[0] += 5
    assert coordinator._filter_score_rebounds(C._detect_game_events(high, current, 13), current)
    missed = data(competition(home=5))
    now[0] += 180
    assert coordinator._filter_score_rebounds(C._detect_game_events(current, missed, 13), missed) == []


def test_start_and_final_deduplication_is_per_game(coordinator):
    event_pair = (EVENT_GAME_STARTED, {})
    assert coordinator._suppress_repeat_once_events([event_pair], "1") == [event_pair]
    assert coordinator._suppress_repeat_once_events([event_pair], "1") == []
    assert coordinator._suppress_repeat_once_events([event_pair], "2") == [event_pair]


@pytest.mark.asyncio
async def test_optional_cache_stale_deadline_is_bounded(coordinator, monkeypatch):
    monkeypatch.setattr("custom_components.nhl_live_scoreboard.coordinator.time.time", lambda: 110)
    coordinator._json_cache["x"] = (0, {"retained": True})
    coordinator._get_json = AsyncMock(side_effect=RuntimeError("offline"))
    assert await coordinator._cached_json("x", "https://example.com", 100, 20) == {"retained": True}
    assert await coordinator._cached_json("x", "https://example.com", 100, 5) == {}


@pytest.mark.asyncio
async def test_partial_schedule_failure_cannot_extend_original_cache_age(coordinator, monkeypatch):
    now = [SCHEDULE_TTL_SECONDS + 1]
    monkeypatch.setattr("custom_components.nhl_live_scoreboard.coordinator.time.time", lambda: now[0])
    pre, regular, post = event(1, -24, phase=1), event(2, 0, phase=2), event(3, 24, phase=3)
    coordinator._schedule_cache = (0, {"season": {"year": 2026}, "events": [pre, regular, post]})
    async def fetch(url):
        if "seasontype=2" in url:
            raise RuntimeError("Regular season unavailable")
        if "seasontype=3" in url:
            return {"events": [post]}
        return {"season": {"year": 2026, "type": 1}, "events": [pre]}
    coordinator._get_json = AsyncMock(side_effect=fetch)
    assert len((await coordinator._fetch_schedule())["events"]) == 3
    assert coordinator._schedule_cache[0] == 0
    now[0] = SCHEDULE_TTL_SECONDS + SCHEDULE_STALE_FALLBACK_SECONDS + 1
    with pytest.raises(Exception, match="Unable to fetch NHL schedule"):
        await coordinator._fetch_schedule()


@pytest.mark.asyncio
async def test_player_ids_are_validated_and_requests_cached(coordinator):
    with pytest.raises(ValueError):
        await coordinator.async_get_player_card("../13")
    with pytest.raises(ValueError):
        await coordinator.async_get_team_season_stats(["1", "not-an-id"])
    coordinator._get_json = AsyncMock(side_effect=[fixture("athlete_3151297_bio.json"), fixture("athlete_3151297_stats.json")])
    card = await coordinator.async_get_player_card("3151297")
    assert card["bio"]["name"] == "Igor Shesterkin"
    assert await coordinator.async_get_player_card("3151297") == card
    assert coordinator._get_json.await_count == 2


@pytest.mark.asyncio
async def test_season_batch_deduplicates_and_isolates_failures(coordinator):
    coordinator._get_one_season_line = AsyncMock(side_effect=[{"season": "2026"}, RuntimeError("offline")])
    assert await coordinator.async_get_team_season_stats(["1", "1", "2"]) == {"1": {"season": "2026"}}
    assert coordinator._get_one_season_line.await_count == 2


@pytest.mark.asyncio
async def test_real_final_assembly_and_period_navigation(coordinator, final):
    comp = final["header"]["competitions"][0]
    entry = {"id": comp["id"], "date": comp["date"], "season": {"year": 2026}, "seasonType": {"type": 2}, "competitions": [comp]}
    async def fetch(url):
        return final if "/summary?" in url else {}
    coordinator._get_json = AsyncMock(side_effect=fetch)
    result = await coordinator._assemble_game_data([entry], comp["id"], comp["id"], "", "",
                                                  {"team": {"displayName": "New York Rangers"}, "season": {"year": 2026}}, live_bridge=True)
    assert result.mode == "final"
    assert result.current_period["number"] == 3
    assert result.goalies["home"]["display_name"] == "Jake Oettinger"
    assert result.situation["home_shots_on_goal"] == 19
    middle = await coordinator.async_period_at_offset(-1)
    assert middle["current_period"]["number"] == 2
    assert middle["away_score"] == middle["home_score"] == 0
    assert middle["period_context"]["display_clock"] == ""  # Never label elapsed history as countdown.
    earliest = await coordinator.async_period_at_offset(-999)
    assert earliest["has_prev"] is False
    assert earliest["total_periods"] == 3
    assert all(p["period"] == 1 for p in earliest["recent_plays"])


@pytest.mark.asyncio
async def test_core_status_new_period_clears_old_plays_before_summary_catches_up(coordinator, final):
    summary = copy.deepcopy(final)
    comp = summary["header"]["competitions"][0]
    comp["status"] = competition(period=1)["status"]
    summary["plays"] = [p for p in summary["plays"] if p["period"]["number"] == 1]
    refreshed = competition(period=2)["status"]
    refreshed["displayClock"] = "20:00"
    async def fetch(url):
        if "/summary?" in url:
            return summary
        if url.endswith("/status"):
            return refreshed
        if url.endswith("/situation"):
            return {"powerPlay": False, "emptyNet": False}
        return {}
    coordinator._get_json = AsyncMock(side_effect=fetch)
    entry = {"id": comp["id"], "date": comp["date"], "season": {"year": 2026}, "seasonType": {"type": 2}, "competitions": [comp]}
    result = await coordinator._assemble_game_data([entry], comp["id"], "", "", comp["id"],
                                                  {"team": {"displayName": "New York Rangers"}, "season": {"year": 2026}}, live_bridge=True)
    assert result.is_live is True
    assert result.current_period["number"] == 2
    assert result.period_context["display_clock"] == "20:00"
    assert result.recent_plays == []


@pytest.mark.asyncio
async def test_shootout_period_navigation_never_uses_attempt_scores_as_game_totals(coordinator, shootout):
    context = C._normalize_period_context(shootout, shootout["header"]["competitions"][0])
    coordinator._live_summary_cache = ("401803626", shootout, context)
    overtime = await coordinator.async_period_at_offset(-1)
    assert overtime["period_context"]["display_period"] == "OT"
    assert overtime["away_score"] == overtime["home_score"] == 3
    current = await coordinator.async_period_at_offset(0)
    assert current["period_context"]["is_shootout"] is True
    assert (current["away_score"], current["home_score"]) != (2, 1)


def test_poll_intervals(coordinator, monkeypatch):
    now = datetime(2026, 4, 11, 21, tzinfo=UTC).timestamp()
    monkeypatch.setattr("custom_components.nhl_live_scoreboard.coordinator.time.time", lambda: now)
    assert coordinator._compute_update_interval(data(), []).total_seconds() == 5
    assert coordinator._compute_update_interval(data(is_live=False), [event(1, 0.1)]).total_seconds() == 30
    assert coordinator._compute_update_interval(data(is_live=False), [event(1, 24 * 7)]).total_seconds() == 300
