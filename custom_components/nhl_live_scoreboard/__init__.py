from __future__ import annotations

import logging
import shutil
from pathlib import Path
from urllib.parse import urlsplit

from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EVENT_HOMEASSISTANT_STARTED
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, INTEGRATION_VERSION, PLATFORMS
from .coordinator import NhlLiveScoreboardCoordinator

_LOGGER = logging.getLogger(__name__)

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

type RuntimeData = NhlLiveScoreboardCoordinator

# Version comes from manifest.json (read once in const.py) and is used here for
# Lovelace cache busting.
_VERSION = INTEGRATION_VERSION

# Cache buster: convert 1.5.0 -> 150
_VERSION_NUM = _VERSION.replace(".", "")
CARD_FILENAME = "nhl-live-game-card.js"
# Preferred URL — matches the convention used by other HACS-installed
# integrations that bundle a Lovelace card. ``/hacsfiles/<name>/`` is mapped by
# HACS itself to ``<config>/www/community/<name>/``.
HACS_URL_BASE = f"/hacsfiles/{DOMAIN}/{CARD_FILENAME}"
# Legacy URL — kept so we can detect and migrate previously-registered
# resources that point at the integration's own static path.
LEGACY_URL_BASE = f"/{DOMAIN}/{CARD_FILENAME}"
# Fallback URL used when copying into ``www/community/`` fails (e.g. the
# directory is read-only). Mirrors the historical behavior.
FALLBACK_URL_BASE = LEGACY_URL_BASE
CARD_NAME = "nhl-live-game-card"


def _sync_card_to_www_community(hass_config_path: str, source: Path) -> Path | None:
    """Copy the bundled card JS into ``<config>/www/community/<DOMAIN>/``.

    Returns the target path on success, or ``None`` if the copy could not be
    completed (in which case callers should fall back to the legacy
    static-path serving model).
    """
    try:
        target_dir = Path(hass_config_path) / "www" / "community" / DOMAIN
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / CARD_FILENAME
        # A local edit may retain both size and mtime. Compare bytes so a
        # manual update cannot leave an older card paired with a new backend.
        if target.exists() and target.read_bytes() == source.read_bytes():
            return target
        shutil.copy2(source, target)
        return target
    except OSError as err:
        _LOGGER.warning(
            "Could not copy %s into www/community/%s (%s); falling back to /%s/ static path",
            CARD_FILENAME,
            DOMAIN,
            err,
            DOMAIN,
        )
        return None


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    source = Path(__file__).parent / CARD_FILENAME

    # Keep upstream's bundled-card / HACS delivery format. Register only the
    # JavaScript file, not the integration directory. The exact static route
    # also makes manual installs work when HACS's wildcard route is absent.
    target = await hass.async_add_executor_job(
        _sync_card_to_www_community, hass.config.path(), source
    )

    card_url_base = HACS_URL_BASE if target is not None else FALLBACK_URL_BASE
    paths = [
        StaticPathConfig(
            url_path=LEGACY_URL_BASE,
            path=str(source),
            cache_headers=False,
        )
    ]
    if target is not None:
        paths.append(
            StaticPathConfig(
                url_path=HACS_URL_BASE,
                path=str(target),
                cache_headers=False,
            )
        )
    await hass.http.async_register_static_paths(paths)

    card_url = f"{card_url_base}?v={_VERSION_NUM}"
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN]["_card_url"] = card_url
    hass.data[DOMAIN]["_card_url_base"] = card_url_base

    # Try to register card now, and also schedule for after HA fully starts
    await _async_register_card(hass, card_url, card_url_base)

    async def _register_on_start(event):
        await _async_register_card(hass, card_url, card_url_base)

    hass.bus.async_listen_once(EVENT_HOMEASSISTANT_STARTED, _register_on_start)

    if not hass.data[DOMAIN].get("_ws_registered"):
        _register_player_card_websocket(hass)
        _register_team_season_stats_websocket(hass)
        _register_game_at_offset_websocket(hass)
        _register_period_at_offset_websocket(hass)
        hass.data[DOMAIN]["_ws_registered"] = True

    return True


async def _async_register_card(
    hass: HomeAssistant, card_url: str, card_url_base: str
) -> None:
    """Register the custom card as a Lovelace resource."""
    try:
        from homeassistant.components.lovelace.const import DOMAIN as LOVELACE_DOMAIN

        # Get the lovelace data object
        lovelace_data = hass.data.get(LOVELACE_DOMAIN)
        if lovelace_data is None:
            _LOGGER.debug("Lovelace not ready yet")
            return

        # Access resources attribute (it's an object, not a dict)
        resources = getattr(lovelace_data, "resources", None)
        if resources is None:
            _LOGGER.debug("Lovelace resources not available")
            return

        if hasattr(resources, "loaded") and not resources.loaded:
            await resources.async_load()
            resources.loaded = True

        # Match resources pointing at either the preferred URL or the legacy
        # static path so old installs migrate to the new location seamlessly.
        def _is_ours(url: str) -> bool:
            return urlsplit(url).path in {HACS_URL_BASE, LEGACY_URL_BASE}

        existing = [r for r in resources.async_items() if _is_ours(r.get("url", ""))]
        if existing:
            for res in existing:
                if res.get("url") != card_url or res.get("type") != "module":
                    _LOGGER.info(
                        "Updating NHL Live Game Card resource: %s -> %s",
                        res.get("url"),
                        card_url,
                    )
                    await resources.async_update_item(
                        res["id"], {"url": card_url, "res_type": "module"}
                    )
                else:
                    _LOGGER.debug("NHL Live Game Card already registered with current URL")
            return

        # Register the resource
        await resources.async_create_item({
            "url": card_url,
            "res_type": "module",
        })
        _LOGGER.info("Registered NHL Live Game Card as Lovelace resource: %s", card_url)
    except ImportError:
        _LOGGER.debug("Lovelace resources module not available")
    except Exception as err:
        _LOGGER.warning("Could not auto-register card resource: %s", err)
        _LOGGER.info("Manually add this resource: %s (type: module)", card_url)


def _any_coordinator(hass: HomeAssistant) -> NhlLiveScoreboardCoordinator | None:
    """Return any loaded coordinator.

    ``_get_player_card`` is not team-specific (it uses the shared aiohttp
    session and its own per-athlete cache), so any configured entry's
    coordinator can service a player-card request. ``hass.data[DOMAIN]`` also
    holds non-coordinator string entries (``_card_url`` etc.), hence the
    isinstance filter.
    """
    for value in (hass.data.get(DOMAIN) or {}).values():
        if isinstance(value, NhlLiveScoreboardCoordinator):
            return value
    return None


def _coordinator_for_entity(hass: HomeAssistant, entity_id: str) -> NhlLiveScoreboardCoordinator | None:
    """Resolve the coordinator backing a specific scoreboard entity.

    Schedule navigation is team-specific, so — unlike the player-card /
    season-stats commands — we map the entity to its own config entry's
    coordinator rather than using any loaded one. Falls back to the sole
    coordinator when the registry lookup misses but exactly one entry is
    configured (the common single-team install).
    """
    from homeassistant.helpers import entity_registry as er

    domain_data = hass.data.get(DOMAIN) or {}
    record = er.async_get(hass).async_get(entity_id)
    if record is not None and record.config_entry_id:
        candidate = domain_data.get(record.config_entry_id)
        if isinstance(candidate, NhlLiveScoreboardCoordinator):
            return candidate

    coordinators = [v for v in domain_data.values() if isinstance(v, NhlLiveScoreboardCoordinator)]
    if len(coordinators) == 1:
        return coordinators[0]
    return None


def _register_game_at_offset_websocket(hass: HomeAssistant) -> None:
    """Register the ``nhl_live_scoreboard/game_at_offset`` WebSocket command.

    The card's schedule-navigation arrows call this with the scoreboard
    entity id and a signed ``offset`` (steps from the currently-displayed
    game) to fetch a previous result / upcoming game on demand. The payload is
    rendered in place of the live game on that one card without disturbing the
    shared sensor. Imports are local so the pure-helper test harness, which
    imports this package but stubs Home Assistant, doesn't need
    ``websocket_api``/``voluptuous``.
    """
    import voluptuous as vol
    from homeassistant.components import websocket_api

    @websocket_api.websocket_command(
        {
            vol.Required("type"): f"{DOMAIN}/game_at_offset",
            vol.Required("entity_id"): cv.entity_id,
            vol.Required("offset"): vol.All(vol.Coerce(int), vol.Range(min=-400, max=400)),
        }
    )
    @websocket_api.async_response
    async def _handle_game_at_offset(hass, connection, msg) -> None:
        coordinator = _coordinator_for_entity(hass, msg["entity_id"])
        if coordinator is None:
            connection.send_error(msg["id"], "not_ready", "No NHL Live Scoreboard entry is configured")
            return
        try:
            result = await coordinator.async_get_game_at_offset(int(msg["offset"]))
        except Exception as err:  # surface any fetch/parse failure to the card
            _LOGGER.debug("game_at_offset WS request failed: %s", err)
            connection.send_error(msg["id"], "fetch_failed", str(err))
            return
        connection.send_result(msg["id"], result or {})

    websocket_api.async_register_command(hass, _handle_game_at_offset)


def _register_period_at_offset_websocket(hass: HomeAssistant) -> None:
    """Register the ``nhl_live_scoreboard/period_at_offset`` WebSocket command.

    The card's period-pager arrows call this with the scoreboard entity id and a
    signed ``offset`` (steps back from the current period) to fetch an
    already-played period's play-by-play on demand. The plays are rendered
    in the card's play-by-play panel in place of the live period without disturbing
    the shared sensor. Imports are local so the pure-helper test harness, which
    imports this package but stubs Home Assistant, doesn't need
    ``websocket_api``/``voluptuous``.
    """
    import voluptuous as vol
    from homeassistant.components import websocket_api

    @websocket_api.websocket_command(
        {
            vol.Required("type"): f"{DOMAIN}/period_at_offset",
            vol.Required("entity_id"): cv.entity_id,
            vol.Required("offset"): vol.All(vol.Coerce(int), vol.Range(min=-100, max=0)),
        }
    )
    @websocket_api.async_response
    async def _handle_period_at_offset(hass, connection, msg) -> None:
        coordinator = _coordinator_for_entity(hass, msg["entity_id"])
        if coordinator is None:
            connection.send_error(msg["id"], "not_ready", "No NHL Live Scoreboard entry is configured")
            return
        try:
            result = await coordinator.async_period_at_offset(int(msg["offset"]))
        except Exception as err:  # surface any slice failure to the card
            _LOGGER.debug("period_at_offset WS request failed: %s", err)
            connection.send_error(msg["id"], "fetch_failed", str(err))
            return
        connection.send_result(msg["id"], result or {})

    websocket_api.async_register_command(hass, _handle_period_at_offset)


def _register_player_card_websocket(hass: HomeAssistant) -> None:
    """Register the ``nhl_live_scoreboard/player_card`` WebSocket command.

    The Lovelace card calls this with an ``athlete_id`` to fetch a player's
    career card on demand (server-side fetch reuses the coordinator's TTL
    cache and resilience). Imports are
    local so the pure-helper test harness, which imports this package but
    stubs Home Assistant, doesn't need ``websocket_api``/``voluptuous``.
    """
    import voluptuous as vol
    from homeassistant.components import websocket_api

    @websocket_api.websocket_command(
        {
            vol.Required("type"): f"{DOMAIN}/player_card",
            vol.Required("athlete_id"): vol.All(cv.string, vol.Match(r"^\d{1,20}$")),
        }
    )
    @websocket_api.async_response
    async def _handle_player_card(hass, connection, msg) -> None:
        coordinator = _any_coordinator(hass)
        if coordinator is None:
            connection.send_error(msg["id"], "not_ready", "No NHL Live Scoreboard entry is configured")
            return
        athlete_id = str(msg["athlete_id"]).strip()
        try:
            card = await coordinator.async_get_player_card(athlete_id)
        except Exception as err:  # surface any fetch/parse failure to the card
            _LOGGER.debug("player_card WS request failed for %s: %s", athlete_id, err)
            connection.send_error(msg["id"], "fetch_failed", str(err))
            return
        connection.send_result(msg["id"], {"player_card": card})

    websocket_api.async_register_command(hass, _handle_player_card)


def _register_team_season_stats_websocket(hass: HomeAssistant) -> None:
    """Register the ``nhl_live_scoreboard/team_season_stats`` WebSocket command.

    The team-statistics popup calls this with the athlete ids it is showing to fetch
    each player's current-season line on demand for the Season view
    (server-side batch fetch reuses the coordinator's per-athlete TTL cache
    and resilience). Imports are local so
    the pure-helper test harness, which imports this package but stubs Home
    Assistant, doesn't need ``websocket_api``/``voluptuous``.
    """
    import voluptuous as vol
    from homeassistant.components import websocket_api

    @websocket_api.websocket_command(
        {
            vol.Required("type"): f"{DOMAIN}/team_season_stats",
            vol.Required("athlete_ids"): vol.All(
                [vol.All(cv.string, vol.Match(r"^\d{1,20}$"))],
                vol.Length(min=1, max=100),
            ),
        }
    )
    @websocket_api.async_response
    async def _handle_team_season_stats(hass, connection, msg) -> None:
        coordinator = _any_coordinator(hass)
        if coordinator is None:
            connection.send_error(msg["id"], "not_ready", "No NHL Live Scoreboard entry is configured")
            return
        athlete_ids = [str(a).strip() for a in (msg.get("athlete_ids") or [])]
        try:
            stats = await coordinator.async_get_team_season_stats(athlete_ids)
        except Exception as err:  # surface any fetch/parse failure to the card
            _LOGGER.debug("team_season_stats WS request failed: %s", err)
            connection.send_error(msg["id"], "fetch_failed", str(err))
            return
        connection.send_result(msg["id"], {"season_stats": stats})

    websocket_api.async_register_command(hass, _handle_team_season_stats)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator = NhlLiveScoreboardCoordinator(hass, entry)
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = coordinator

    # Reload the entry whenever the user updates the options flow so newly
    # configured action sequences take effect immediately.
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    return True


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)
    return unload_ok
