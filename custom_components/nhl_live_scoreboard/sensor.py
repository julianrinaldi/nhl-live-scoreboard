from __future__ import annotations

from typing import Any

from homeassistant.components.sensor import SensorEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import MATCH_ALL
from homeassistant.core import HomeAssistant
from homeassistant.helpers.device_registry import DeviceEntryType
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from . import RuntimeData
from .const import DOMAIN


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: RuntimeData = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([NhlLiveScoreboardSensor(coordinator, entry)])


def build_state_attributes(data: Any) -> dict[str, Any]:
    """Assemble the card-facing attribute dict from a coordinator data object.

    Shared by the sensor's ``extra_state_attributes`` (the live push) and the
    ``nhl_live_scoreboard/game_at_offset`` WebSocket command (schedule
    navigation), so a navigated game is delivered to the card in exactly the
    same shape as the live game.
    """
    # Strip plays to only the fields actually needed by the JS card
    recent_plays = []
    for play in data.recent_plays or []:
        recent_plays.append(
            {
                "id": play.get("id"),
                "text": play.get("text"),
                "away_score": play.get("away_score"),
                "home_score": play.get("home_score"),
                "wallclock_ts": play.get("wallclock_ts"),
                # Needed by the card to flag scoring plays in the play-result
                # indicator column even when the score didn't change relative
                # to the immediately-prior play in the (newest-first) list.
                "scoring_play": play.get("scoring_play"),
                "score_value": play.get("score_value"),
                "play_type": play.get("play_type"),
                "abbreviation": play.get("abbreviation"),
                "period": play.get("period"),
                "clock": play.get("clock"),
                "team_id": play.get("team_id"),
                "is_penalty": play.get("is_penalty"),
                "is_shootout": play.get("is_shootout"),
                "is_shot": play.get("is_shot"),
                "coordinate": play.get("coordinate"),
                "shot_type": play.get("shot_type"),
                "strength": play.get("strength"),
            }
        )
    return {
        "team_abbr": data.team_abbr,
        "team_id": data.team_id,
        "team_name": data.team_name,
        "league": "NHL",
        "mode": data.mode,
        # True only when the card is currently displaying the live game
        # (mode == "live", i.e. the displayed event is the live event).
        # Stable boolean for dashboards/automations to gate on "a game is
        # on screen right now" without string-comparing `mode`.
        "game_active": data.mode == "live",
        "is_live": data.is_live,
        "is_delayed": data.is_delayed,
        "status_text": data.status_text,
        "display_event_id": data.display_event_id,
        "live_event_id": data.live_event_id,
        "previous_event_id": data.previous_event_id,
        "next_event_id": data.next_event_id,
        "competition": data.selected_competition or {},
        "period_context": data.period_context,
        "recent_plays": recent_plays,
        "scoring_plays": data.scoring_plays or [],
        "away_team": data.away_team,
        "home_team": data.home_team,
        "goalies": data.goalies,
        "situation": data.situation,
        "current_period": data.current_period,
        "team_stats": data.team_stats,
        "win_probability": data.win_probability,
        "leaders": data.leaders,
        "division_standings": data.division_standings,
        "highlights_url": data.highlights_url,
    }


class NhlLiveScoreboardSensor(CoordinatorEntity[RuntimeData], SensorEntity):
    _attr_icon = "mdi:hockey-puck"
    _attr_has_entity_name = False
    # Live game data is a large, high-churn payload (box scores, leaders, plays,
    # standings, …) that blows past the recorder's 16 KB attribute cap and is
    # meaningless as history. Keep it out of the recorder entirely — the card
    # reads attributes from the live state object, not from history, so this is
    # purely a storage concern with no effect on the card.
    _unrecorded_attributes = frozenset({MATCH_ALL})

    def __init__(self, coordinator: RuntimeData, entry: ConfigEntry) -> None:
        super().__init__(coordinator)
        team = str(entry.data.get("team", "nhl")).lower()
        self._attr_unique_id = f"{entry.entry_id}_scoreboard"
        self._attr_name = f"NHL Live Scoreboard {team.upper()}"
        # Entity ID will be: sensor.nhl_live_scoreboard_nyr (for NYR team).
        self._attr_suggested_object_id = f"nhl_live_scoreboard_{team}"

    @property
    def native_value(self) -> str:
        return self.coordinator.data.display_event_id or "idle"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return build_state_attributes(self.coordinator.data)

    @property
    def device_info(self) -> dict[str, Any]:
        data = self.coordinator.data
        return {
            "identifiers": {(DOMAIN, self.coordinator.entry.entry_id)},
            "name": f"NHL Live Scoreboard {data.team_abbr}",
            "manufacturer": "ESPN / Custom",
            "model": "NHL Live Scoreboard",
            "entry_type": DeviceEntryType.SERVICE,
        }
