"""Persistent end-of-game timing shared by the NFL, NHL, and NBA scoreboards.

ESPN end-game play wallclock is the only feed timestamp used. Modification
times and scheduled starts are not finish times. An observed transition is
explicitly approximate and is never initialized from a first-seen final.
"""

from __future__ import annotations

import logging
import re
import time
from datetime import UTC, datetime
from typing import Any

from homeassistant.helpers.storage import Store

_LOGGER = logging.getLogger(__name__)
_MAX_RECORDS = 32
_RETRY_SECONDS = 300
_TRANSITION_SECONDS = 120
_SOURCES = {"espn_end_play", "observed_transition"}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _timestamp(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.timestamp() if parsed.tzinfo is not None else None
    except (ValueError, OverflowError):
        return None


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, UTC).isoformat().replace("+00:00", "Z")


def _type(comp: dict[str, Any]) -> dict[str, Any]:
    return _dict(_dict(comp.get("status")).get("type"))


def _final(comp: dict[str, Any]) -> bool:
    status = _type(comp)
    name = str(status.get("name") or "").upper()
    if any(word in name for word in ("CANCEL", "POSTPON", "SUSPEND", "DELAY", "TBD")):
        return False
    return status.get("completed") is True or (
        status.get("state") == "post" and status.get("completed") is not False)


def _team_matches(comp: dict[str, Any], team_id: str) -> bool:
    return any(str(_dict(_dict(c).get("team")).get("id") or "") == team_id
               for c in _list(comp.get("competitors")))


def _event_comp(event: dict[str, Any]) -> dict[str, Any]:
    comp = _dict((_list(event.get("competitions")) or [{}])[0])
    return {**comp, "date": event.get("date") or comp.get("date"),
            "status": {**_dict(event.get("status")), **_dict(comp.get("status"))}}

def _summary_matches(summary: dict[str, Any], event_id: str) -> bool:
    header = _dict(summary.get("header"))
    summary_comp = _dict((_list(header.get("competitions")) or [{}])[0])
    return all(not value or str(value) == event_id for value in (header.get("id"), summary_comp.get("id")))


def _plays(summary: dict[str, Any]) -> list[dict[str, Any]]:
    plays = list(_list(summary.get("plays")))
    drives = _dict(summary.get("drives"))
    for drive in [*_list(drives.get("previous")), _dict(drives.get("current"))]:
        plays.extend(_list(_dict(drive).get("plays")))
    return [play for play in plays if isinstance(play, dict)]


def extract_game_end(
    summary: dict[str, Any], comp: dict[str, Any], team_id: str, now: float,
) -> float | None:
    """Extract an explicit final-game play time, never a last-play estimate."""
    if not _final(comp) or not _team_matches(comp, str(team_id)):
        return None
    if comp.get("id") and not _summary_matches(summary, str(comp["id"])):
        return None
    start = _timestamp(comp.get("date"))
    ends = []
    for play in _plays(summary):
        kind = str(_dict(play.get("type")).get("text") or "").strip().lower()
        # Verified primary feeds: NFL type 66 "End of Game", NHL 522
        # "End of Game", NBA 402 "End Game". Never accept End Period.
        if kind not in {"end of game", "end game", "game end"}:
            continue
        stamp = _timestamp(play.get("wallclock"))
        if stamp is not None and stamp <= now and (start is None or stamp >= start):
            ends.append(stamp)
    return max(ends) if ends else None


class GameEndTracker:
    """Keep stable club finish metadata, independently of card navigation."""

    def __init__(self, hass: Any, key: str, team_id: int) -> None:
        self.team_id = str(team_id)
        self._store = Store(hass, 1, key, atomic_writes=True)
        self._loaded = False
        self._load_retry_after = 0.0
        self._save_retry_after = 0.0
        self._records: dict[str, dict[str, str]] = {}
        self._invalidated: set[str] = set()
        self._retry_after: dict[str, float] = {}
        self._last_live: tuple[str, float] | None = None
        self._dirty = False

    async def _load(self, now: float) -> None:
        if self._loaded or now < self._load_retry_after:
            return
        try:
            payload = _dict(await self._store.async_load())
            self._loaded = True
            if str(payload.get("team_id") or "") != self.team_id:
                return
            for event_id, record in _dict(payload.get("records")).items():
                if str(event_id) in self._invalidated:
                    self._dirty = True
                    continue
                record = _dict(record)
                stamp = _timestamp(record.get("end"))
                if (re.fullmatch(r"[0-9]{1,20}", str(event_id)) and stamp is not None
                        and stamp <= now and record.get("source") in _SOURCES):
                    existing = self._records.get(str(event_id))
                    if not existing or record["source"] == "espn_end_play" or existing["source"] != "espn_end_play":
                        self._records[str(event_id)] = {"end": _iso(stamp), "source": record["source"]}
            self._prune()
        except Exception as err:
            self._load_retry_after = now + _RETRY_SECONDS
            _LOGGER.warning("Could not restore game-end timing; scoreboard remains available: %s", err)

    def _prune(self) -> None:
        while len(self._records) > _MAX_RECORDS:
            oldest = min(self._records, key=lambda key: _timestamp(self._records[key]["end"]) or 0)
            del self._records[oldest]
        while len(self._retry_after) > _MAX_RECORDS:
            del self._retry_after[min(self._retry_after, key=self._retry_after.get)]

    def _remember(self, event_id: str, stamp: float, source: str) -> None:
        existing = self._records.get(event_id)
        # Re-polling or reloading a final can never restart its window.
        # A real end play may replace the approximate observed transition.
        if existing and (existing["source"] == "espn_end_play" or source != "espn_end_play"):
            return
        self._records[event_id] = {"end": _iso(stamp), "source": source}
        self._dirty = True
        self._prune()

    async def _save(self, now: float) -> None:
        if not self._dirty or not self._loaded or now < self._save_retry_after:
            return
        try:
            await self._store.async_save({"team_id": self.team_id, "records": dict(self._records)})
            self._dirty = False
        except Exception as err:
            self._save_retry_after = now + _RETRY_SECONDS
            # Keep the in-memory timestamp without making the sensor unavailable.
            _LOGGER.warning("Could not persist game-end timing; scoreboard remains available: %s", err)

    def _metadata(self, event_id: str = "") -> dict[str, Any]:
        if not event_id and self._records:
            event_id = max(self._records, key=lambda key: _timestamp(self._records[key]["end"]) or 0)
        record = self._records.get(event_id, {})
        return {"last_game_end": record.get("end"),
                "last_game_end_event_id": event_id if record else "",
                "last_game_end_source": record.get("source", "")}

    async def async_update(
        self, *, events: list[dict[str, Any]], current_id: str,
        current_comp: dict[str, Any] | None, current_summary: dict[str, Any],
        summary_cache: dict[str, tuple[float, dict[str, Any]]], fetch_summary: Any,
        now: float | None = None,
    ) -> dict[str, Any]:
        """Update only during authoritative coordinator polls, never navigation."""
        now = time.time() if now is None else now
        await self._load(now)
        comp = _dict(current_comp)
        current_id = str(current_id or "")
        start = _timestamp(comp.get("date"))
        valid_current = (bool(re.fullmatch(r"[0-9]{1,20}", current_id))
                         and _team_matches(comp, self.team_id)
                         and str(comp.get("id") or current_id) == current_id
                         and _summary_matches(current_summary, current_id)
                         and (start is None or start <= now))
        if valid_current:
            if _final(comp):
                end = extract_game_end(current_summary, comp, self.team_id, now)
                if end is not None:
                    self._remember(current_id, end, "espn_end_play")
                elif (self._last_live and self._last_live[0] == current_id
                      and 0 <= now - self._last_live[1] <= _TRANSITION_SECONDS):
                    self._remember(current_id, now, "observed_transition")
                self._last_live = None
            else:
                if current_id in self._records:
                    del self._records[current_id]
                    self._dirty = True
                status = _type(comp)
                try:
                    period = float(_dict(comp.get("status")).get("period") or 0)
                except (ValueError, TypeError):
                    period = 0
                live = (status.get("state") in {"in", "live"} and period > 0
                        and not any(word in str(status.get("name") or "").upper() for word in ("CANCEL", "POSTPON")))
                if live:
                    # If storage is temporarily unreadable, remember a
                    # resumed game so restoring an old final cannot win.
                    self._invalidated.add(current_id)
                    if len(self._invalidated) > _MAX_RECORDS:
                        self._invalidated.pop()
                fetched_at = summary_cache.get(current_id, (0, {}))[0]
                if live and 0 <= now - fetched_at <= _TRANSITION_SECONDS:
                    # Use the original fetch time, not the poll time: stale
                    # fallback snapshots cannot continually renew evidence.
                    self._last_live = (current_id, fetched_at)
                elif not live:
                    self._last_live = None

        candidates = []
        for event in events:
            if not isinstance(event, dict):
                continue
            event_id = str(event.get("id") or "")
            candidate = comp if valid_current and event_id == current_id else _event_comp(event)
            if (event_id in self._records and
                    any(word in str(_type(candidate).get("name") or "").upper() for word in ("CANCEL", "POSTPON"))):
                del self._records[event_id]
                self._dirty = True
            start = _timestamp(candidate.get("date"))
            if (re.fullmatch(r"[0-9]{1,20}", event_id) and _team_matches(candidate, self.team_id)
                    and _final(candidate) and (start is None or start <= now)):
                candidates.append((start or 0, event_id, candidate))
        if valid_current and _final(comp) and not any(item[1] == current_id for item in candidates):
            candidates.append((_timestamp(comp.get("date")) or 0, current_id, comp))
        latest_id = ""
        if candidates:
            _start, latest_id, latest_comp = max(candidates, key=lambda item: item[0])
            if latest_id != current_id and latest_id not in self._records and now >= self._retry_after.get(latest_id, 0):
                first_attempt = latest_id not in self._retry_after
                self._retry_after[latest_id] = now + _RETRY_SECONDS
                self._prune()
                cached = summary_cache.get(latest_id)
                try:
                    summary = cached[1] if cached and first_attempt else await fetch_summary(latest_id, False)
                    fetched_comp = _dict((_list(_dict(summary.get("header")).get("competitions")) or [{}])[0])
                    latest_comp = {**latest_comp, **fetched_comp}
                    if str(latest_comp.get("id") or latest_id) == latest_id:
                        end = extract_game_end(summary, latest_comp, self.team_id, now)
                        if end is not None:
                            self._remember(latest_id, end, "espn_end_play")
                except Exception as err:
                    _LOGGER.debug("Previous-game end timing unavailable for %s: %s", latest_id, err)
        await self._save(now)
        return self._metadata(latest_id)
