"""End-game timing regressions: real ESPN fixtures plus restart/error edges."""

from __future__ import annotations

import copy
import json
from datetime import UTC, datetime
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from custom_components.nhl_live_scoreboard.game_end import GameEndTracker, extract_game_end

NOW = datetime(2026, 9, 3, 12, tzinfo=UTC).timestamp()
TEAM = "18"
FIXTURES = Path(__file__).parent / "fixtures"


def iso(stamp):
    return datetime.fromtimestamp(stamp, UTC).isoformat().replace("+00:00", "Z")


def competition(event_id="100", state="post", start=None):
    return {"id": event_id, "date": iso(NOW - 3600 if start is None else start),
            "competitors": [{"homeAway": "home", "team": {"id": TEAM}}],
            "status": {"period": 4, "type": {"state": state, "completed": state == "post",
                       "name": "STATUS_FINAL" if state == "post" else "STATUS_IN_PROGRESS" if state == "in" else "STATUS_SCHEDULED"}}}


def summary(comp, end=None):
    return {"header": {"id": comp["id"], "competitions": [copy.deepcopy(comp)]},
            "plays": [] if end is None else [{"type": {"text": "End of Game"}, "wallclock": iso(end)}]}


class MemoryStore:
    def __init__(self, payload=None):
        self.payload = copy.deepcopy(payload)
        self.loads = self.saves = 0
        self.fail_load = self.fail_save = False

    async def async_load(self):
        self.loads += 1
        if self.fail_load:
            raise OSError("temporary load failure")
        return copy.deepcopy(self.payload)

    async def async_save(self, payload):
        self.saves += 1
        if self.fail_save:
            raise OSError("temporary save failure")
        self.payload = copy.deepcopy(payload)


def tracker(store=None):
    result = GameEndTracker(None, "test.game_end", int(TEAM))
    result._store = store or MemoryStore()
    return result


async def poll(subject, comp, payload=None, *, now=NOW, events=None, current_id=None, cache=None, fetch=None):
    current_id = current_id or comp["id"]
    payload = summary(comp) if payload is None else payload
    return await subject.async_update(
        events=[{"id": comp["id"], "date": comp["date"], "competitions": [comp]}] if events is None else events,
        current_id=current_id, current_comp=comp, current_summary=payload,
        summary_cache={current_id: (now, payload)} if cache is None else cache,
        fetch_summary=fetch or AsyncMock(return_value={}), now=now)


@pytest.mark.parametrize(("filename", "expected"), [["summary_401803619_final.json","2026-04-11T23:38:10Z"],["summary_401803625_overtime.json","2026-04-12T02:48:25Z"],["summary_401803626_shootout.json","2026-04-12T05:01:49Z"]])
def test_real_espn_end_game_wallclock(filename, expected):
    payload = json.loads((FIXTURES / filename).read_text())
    comp = payload["header"]["competitions"][0]
    team_id = comp["competitors"][0]["team"]["id"]
    assert iso(extract_game_end(payload, comp, team_id, NOW)) == expected


@pytest.mark.parametrize("invalid", [
    "future_end", "naive_end", "modified_only", "period_end", "cancelled", "postponed",
    "live", "future_start", "end_before_start", "wrong_team", "wrong_header", "wrong_comp",
])
def test_end_extraction_rejects_untrusted_or_nonfinal_data(invalid):
    comp = competition()
    payload = summary(comp, NOW - 10)
    play = payload["plays"][0]
    if invalid == "future_end":
        play["wallclock"] = iso(NOW + 1)
    elif invalid == "naive_end":
        play["wallclock"] = "2026-09-03T11:59:50"
    elif invalid == "modified_only":
        play["modified"] = play.pop("wallclock")
    elif invalid == "period_end":
        play["type"]["text"] = "End Period"
    elif invalid in {"cancelled", "postponed"}:
        comp["status"]["type"]["name"] = "STATUS_" + invalid.upper()
    elif invalid == "live":
        comp["status"]["type"] = {"name": "STATUS_IN_PROGRESS", "state": "in"}
    elif invalid == "future_start":
        comp["date"] = iso(NOW + 60)
    elif invalid == "end_before_start":
        comp["date"] = iso(NOW - 5)
    elif invalid == "wrong_team":
        comp["competitors"][0]["team"]["id"] = "99"
    elif invalid == "wrong_header":
        payload["header"]["id"] = "101"
    elif invalid == "wrong_comp":
        payload["header"]["competitions"][0]["id"] = "101"
    assert extract_game_end(payload, comp, TEAM, NOW) is None


@pytest.mark.asyncio
async def test_end_play_is_stable_through_reload_and_no_further_fetch():
    store = MemoryStore()
    comp = competition()
    payload = summary(comp, NOW - 30)
    first = await poll(tracker(store), comp, payload)
    second = await poll(tracker(store), comp, summary(comp), now=NOW + 60)
    assert first == second == {"last_game_end": iso(NOW - 30), "last_game_end_event_id": "100",
                              "last_game_end_source": "espn_end_play"}
    assert store.saves == 1


@pytest.mark.asyncio
async def test_first_seen_final_without_end_never_starts_window():
    subject = tracker()
    assert (await poll(subject, competition()))["last_game_end"] is None
    assert (await poll(subject, competition(), now=NOW + 60))["last_game_end"] is None
    assert subject._store.saves == 0


@pytest.mark.asyncio
@pytest.mark.parametrize("gap", [1, 120, 120.001])
async def test_observed_samegame_transition_is_bounded_and_persisted(gap):
    store = MemoryStore()
    subject = tracker(store)
    await poll(subject, competition(state="in"), now=NOW)
    result = await poll(subject, competition(), now=NOW + gap)
    if gap > 120:
        assert result["last_game_end"] is None
    else:
        assert result["last_game_end"] == iso(NOW + gap)
        assert result["last_game_end_source"] == "observed_transition"
        restored = await poll(tracker(store), competition(), now=NOW + gap + 600)
        assert restored == result


@pytest.mark.asyncio
@pytest.mark.parametrize("invalid", ["other_game", "pregame", "stale_live", "future_start", "wrong_header", "wrong_comp"])
async def test_observed_fallback_requires_fresh_matching_started_game(invalid):
    subject = tracker()
    live = competition(state="in")
    if invalid == "pregame":
        live["status"]["period"] = 0
    await poll(subject, live, cache={"100": (NOW - 121 if invalid == "stale_live" else NOW, summary(live))})
    final = competition(event_id="101" if invalid == "other_game" else "100",
                        start=NOW + 600 if invalid == "future_start" else None)
    payload = summary(final)
    if invalid == "wrong_header":
        payload["header"]["id"] = "102"
    elif invalid == "wrong_comp":
        final["id"] = "102"
    result = await poll(subject, final, payload, now=NOW + 5, current_id="101" if invalid == "other_game" else "100")
    assert result["last_game_end"] is None


@pytest.mark.asyncio
async def test_actual_end_replaces_observed_approximation_without_refresh_rebase():
    subject = tracker()
    await poll(subject, competition(state="in"), now=NOW)
    await poll(subject, competition(), now=NOW + 5)
    result = await poll(subject, competition(), summary(competition(), NOW + 1), now=NOW + 10)
    assert result["last_game_end"] == iso(NOW + 1)
    assert result["last_game_end_source"] == "espn_end_play"
    later = await poll(subject, competition(), summary(competition(), NOW + 9), now=NOW + 20)
    assert later == result


@pytest.mark.asyncio
async def test_next_selected_game_recovers_previous_final_once():
    subject = tracker()
    final = competition()
    upcoming = competition("101", "pre", start=NOW + 86400)
    events = [{"id": c["id"], "date": c["date"], "competitions": [c]} for c in (final, upcoming)]
    fetch = AsyncMock(return_value=summary(final, NOW - 30))
    result = await poll(subject, upcoming, events=events, fetch=fetch)
    assert result["last_game_end_event_id"] == "100"
    assert result["last_game_end"] == iso(NOW - 30)
    await poll(subject, upcoming, events=events, fetch=fetch, now=NOW + 600)
    fetch.assert_awaited_once_with("100", False)


@pytest.mark.asyncio
async def test_previous_final_uses_existing_summary_cache():
    final, upcoming = competition(), competition("101", "pre", start=NOW + 86400)
    fetch = AsyncMock(side_effect=AssertionError("Cached summary should be reused"))
    result = await poll(tracker(), upcoming,
                        events=[{"id": "100", "date": final["date"], "competitions": [final]}],
                        cache={"100": (NOW - 1, summary(final, NOW - 30))}, fetch=fetch)
    assert result["last_game_end"] == iso(NOW - 30)
    fetch.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["error", "no_end", "wrong_game", "postponed"])
async def test_previous_final_missing_end_retries_with_throttle(failure):
    final, upcoming = competition(), competition("101", "pre", start=NOW + 86400)
    payload = summary(final)
    if failure == "wrong_game":
        payload = summary(competition("102"), NOW - 30)
    elif failure == "postponed":
        payload = summary(final, NOW - 30)
        payload["header"]["competitions"][0]["status"]["type"]["name"] = "STATUS_POSTPONED"
    fetch = AsyncMock(side_effect=OSError("offline")) if failure == "error" else AsyncMock(return_value=payload)
    subject = tracker()
    events = [{"id": "100", "date": final["date"], "competitions": [final]}]
    assert (await poll(subject, upcoming, events=events, fetch=fetch))["last_game_end"] is None
    await poll(subject, upcoming, events=events, fetch=fetch, now=NOW + 299)
    assert fetch.await_count == 1
    await poll(subject, upcoming, events=events, fetch=fetch, now=NOW + 300)
    assert fetch.await_count == 2


@pytest.mark.asyncio
async def test_storage_failure_retries_without_moving_observed_end():
    store = MemoryStore()
    subject = tracker(store)
    await poll(subject, competition(state="in"))
    store.fail_save = True
    initial = await poll(subject, competition(), now=NOW + 5)
    store.fail_save = False
    await poll(subject, competition(), now=NOW + 6)
    assert store.saves == 1
    result = await poll(subject, competition(), now=NOW + 305)
    assert store.saves == 2
    assert result == initial
    assert await poll(tracker(store), competition(), now=NOW + 600) == initial


@pytest.mark.asyncio
async def test_load_failure_does_not_overwrite_existing_records():
    store = MemoryStore({"team_id": TEAM, "records": {"99": {"end": iso(NOW - 500), "source": "espn_end_play"}}})
    store.fail_load = True
    subject = tracker(store)
    await poll(subject, competition(), summary(competition(), NOW - 10))
    assert store.saves == 0
    store.fail_load = False
    await poll(subject, competition(), now=NOW + 300)
    assert set(store.payload["records"]) == {"99", "100"}


@pytest.mark.asyncio
async def test_storage_restore_rejects_future_malformed_and_wrong_source():
    records = {"1": {"end": iso(NOW + 1), "source": "espn_end_play"},
               "2": {"end": "not a date", "source": "espn_end_play"},
               "3": {"end": iso(NOW - 2), "source": "first_seen_final"},
               "4": {"end": iso(NOW - 10), "source": "observed_transition"}}
    subject = tracker(MemoryStore({"team_id": TEAM, "records": records}))
    result = await poll(subject, competition("100", "pre", NOW + 600), events=[])
    assert result["last_game_end_event_id"] == "4"
    assert set(subject._records) == {"4"}


@pytest.mark.asyncio
async def test_records_are_bounded_and_cancelled_game_is_not_a_finished_game():
    subject = tracker()
    await subject._load(NOW)
    for index in range(40):
        subject._remember(str(index), NOW - 100 + index, "espn_end_play")
    assert len(subject._records) == 32
    comp = competition("39")
    comp["status"]["type"]["name"] = "STATUS_CANCELLED"
    result = await poll(subject, comp)
    assert "39" not in subject._records
    assert result["last_game_end_event_id"] == "38"


@pytest.mark.asyncio
async def test_delayed_restore_cannot_resurrect_a_resumed_games_old_end():
    store = MemoryStore({"team_id": TEAM, "records": {"100": {"end": iso(NOW - 500), "source": "espn_end_play"}}})
    store.fail_load = True
    subject = tracker(store)
    await poll(subject, competition(state="in"), now=NOW)
    observed = await poll(subject, competition(), now=NOW + 5)
    store.fail_load = False
    restored = await poll(subject, competition(), now=NOW + 300)
    assert restored == observed
    assert restored["last_game_end_source"] == "observed_transition"


@pytest.mark.asyncio
async def test_coordinator_publishes_metadata_but_navigation_never_updates_tracker():
    from types import SimpleNamespace

    from custom_components.nhl_live_scoreboard.coordinator import (
        NhlLiveScoreboardCoordinator,
        NhlLiveScoreboardData,
    )
    from custom_components.nhl_live_scoreboard.sensor import build_state_attributes

    coordinator = NhlLiveScoreboardCoordinator(
        SimpleNamespace(config=SimpleNamespace(time_zone="UTC")),
        SimpleNamespace(data={"team": "NYR"}, title="Test", options={}, entry_id="entry-123"))
    comp = competition()
    comp["competitors"][0]["team"]["id"] = str(coordinator.team_id)
    events = [{"id": "100", "date": comp["date"], "competitions": [comp]}]
    data = NhlLiveScoreboardData(display_event_id="100", selected_competition=comp)
    coordinator._resolve_schedule = AsyncMock(return_value=({}, events))
    coordinator._assemble_game_data = AsyncMock(return_value=data)
    expected = {"last_game_end": iso(NOW - 10), "last_game_end_event_id": "100", "last_game_end_source": "espn_end_play"}
    coordinator._game_end_tracker.async_update = AsyncMock(return_value=expected)
    result = await coordinator._async_update_data()
    assert {key: build_state_attributes(result)[key] for key in expected} == expected
    coordinator._game_end_tracker.async_update.assert_awaited_once()
    await coordinator.async_get_game_at_offset(0)
    coordinator._game_end_tracker.async_update.assert_awaited_once()
    assert coordinator._assemble_game_data.await_args.kwargs["live_bridge"] is False

