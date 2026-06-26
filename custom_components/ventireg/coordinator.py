"""VentiReg-koordinator: reguleringssløyfe, pause-logikk og varsling."""
from __future__ import annotations

import logging
from datetime import timedelta
from typing import Any

from homeassistant.components import persistent_notification
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.event import async_call_later
from homeassistant.helpers.storage import Store
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator
from homeassistant.util import dt as dt_util

from .const import (
    CONF_CLIMATE_ENTITY,
    CONF_CURVE_POINTS,
    CONF_OUTDOOR_SENSOR,
    CONF_STEP,
    CONF_TOLERANCE,
    CONF_UPDATE_INTERVAL,
    DEFAULT_CURVE_POINTS,
    DEFAULT_STEP,
    DEFAULT_TOLERANCE,
    DEFAULT_UPDATE_INTERVAL,
    DOMAIN,
    PAUSE_NOTIFY_AFTER,
    STATUS_AUTO_PAUSED,
    STATUS_OFF,
    STATUS_ON,
)
from .curve import interpolate, parse_points, round_to_step

_LOGGER = logging.getLogger(__name__)
STORAGE_VERSION = 1


class VentiRegCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """Styrer tilluftstemperaturen ut fra en kurve og utetemperatur."""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.entry = entry
        cfg = {**entry.data, **entry.options}
        interval = int(cfg.get(CONF_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL))
        super().__init__(
            hass,
            _LOGGER,
            name="VentiReg",
            update_interval=timedelta(minutes=interval),
        )

        # Tilstand (lastes/lagres via Store)
        self.enabled = True
        self.status = STATUS_ON
        self._last_set: float | None = None
        self._paused_since = None
        self._cancel_notify = None

        self._store = Store(hass, STORAGE_VERSION, f"{DOMAIN}.{entry.entry_id}")
        self.device_info = DeviceInfo(
            identifiers={(DOMAIN, entry.entry_id)},
            name="VentiReg",
            manufacturer="VentiReg",
        )

    # --------------------------------------------------------------- properties
    @property
    def last_set(self) -> float | None:
        return self._last_set

    def _config(self) -> dict[str, Any]:
        return {**self.entry.data, **self.entry.options}

    # ------------------------------------------------------------ livssyklus
    async def async_initialize(self) -> None:
        """Gjenopprett lagret tilstand før første kjøring."""
        data = await self._store.async_load()
        if data:
            self.enabled = data.get("enabled", True)
            self._last_set = data.get("last_set")
            paused = data.get("paused_since")
            self._paused_since = dt_util.parse_datetime(paused) if paused else None

        if self.enabled:
            self.status = STATUS_ON
        elif self._paused_since is not None:
            self.status = STATUS_AUTO_PAUSED
        else:
            self.status = STATUS_OFF

        # Gjenopprett 24-timers varslingen hvis vi fortsatt er auto-pauset
        if self.status == STATUS_AUTO_PAUSED and self._paused_since is not None:
            remaining = PAUSE_NOTIFY_AFTER - (dt_util.utcnow() - self._paused_since)
            if remaining.total_seconds() <= 0:
                self._notify_paused()
            else:
                self._schedule_notify(remaining)

    async def _save(self) -> None:
        await self._store.async_save(
            {
                "enabled": self.enabled,
                "last_set": self._last_set,
                "paused_since": (
                    self._paused_since.isoformat() if self._paused_since else None
                ),
            }
        )

    def async_shutdown_extra(self) -> None:
        self._cancel_pending_notify()

    # ------------------------------------------------------- reguleringssløyfe
    async def _async_update_data(self) -> dict[str, Any]:
        cfg = self._config()
        try:
            points = parse_points(cfg.get(CONF_CURVE_POINTS, DEFAULT_CURVE_POINTS))
        except ValueError as err:
            _LOGGER.error("Ugyldig kurve, hopper over: %s", err)
            return self.data or {"outdoor": None, "target": None, "status": self.status}

        step = float(cfg.get(CONF_STEP, DEFAULT_STEP))
        tolerance = float(cfg.get(CONF_TOLERANCE, DEFAULT_TOLERANCE))

        outdoor = self._read_float(cfg[CONF_OUTDOOR_SENSOR])
        if outdoor is None:
            _LOGGER.warning(
                "Utetemperatur utilgjengelig (%s) — hopper over denne syklusen",
                cfg[CONF_OUTDOOR_SENSOR],
            )
            return self.data or {"outdoor": None, "target": None, "status": self.status}

        target = round_to_step(interpolate(points, outdoor), step)
        result = {
            "outdoor": outdoor,
            "target": target,
            "status": self.status,
            "curve_points": [list(point) for point in points],
        }

        if not self.enabled:
            return result

        # Sjekk ALLTID før vi skriver: har noen andre endret settpunktet?
        current = self._read_climate_setpoint(cfg[CONF_CLIMATE_ENTITY])
        if (
            self._last_set is not None
            and current is not None
            and abs(current - self._last_set) >= tolerance
        ):
            await self._async_auto_pause()
            result["status"] = self.status
            return result

        # Ingen ekstern endring → skriv kurveverdien og husk den
        await self._async_write_setpoint(cfg[CONF_CLIMATE_ENTITY], target)
        self._last_set = target
        await self._save()
        return result

    async def _async_write_setpoint(self, climate_entity: str, target: float) -> None:
        await self.hass.services.async_call(
            "climate",
            "set_temperature",
            {"entity_id": climate_entity, "temperature": target},
            blocking=True,
        )

    # ---------------------------------------------------------------- pause
    async def _async_auto_pause(self) -> None:
        _LOGGER.info("Ekstern endring oppdaget — VentiReg går i auto-pause")
        self.enabled = False
        self.status = STATUS_AUTO_PAUSED
        self._paused_since = dt_util.utcnow()
        self._schedule_notify(PAUSE_NOTIFY_AFTER)
        await self._save()
        self.async_update_listeners()

    def _schedule_notify(self, delay: timedelta) -> None:
        self._cancel_pending_notify()
        self._cancel_notify = async_call_later(self.hass, delay, self._notify_paused_cb)

    def _cancel_pending_notify(self) -> None:
        if self._cancel_notify is not None:
            self._cancel_notify()
            self._cancel_notify = None

    @callback
    def _notify_paused_cb(self, _now) -> None:
        self._cancel_notify = None
        self._notify_paused()

    def _notify_paused(self) -> None:
        if self.status != STATUS_AUTO_PAUSED:
            return
        persistent_notification.async_create(
            self.hass,
            "VentiReg har vært i auto-pause i 24 timer fordi settpunktet ble endret "
            "utenfor VentiReg. Slå på switchen igjen for å gjenoppta reguleringen.",
            title="VentiReg pauset",
            notification_id=f"{DOMAIN}_{self.entry.entry_id}_paused",
        )

    # ------------------------------------------------------- bruker-handlinger
    async def async_enable(self) -> None:
        """Slå på regulering (også ut av auto-pause) og skriv umiddelbart."""
        self.enabled = True
        self.status = STATUS_ON
        self._paused_since = None
        self._last_set = None  # nullstill baseline → unngår å auto-pause seg selv
        self._cancel_pending_notify()
        persistent_notification.async_dismiss(
            self.hass, f"{DOMAIN}_{self.entry.entry_id}_paused"
        )
        await self._save()
        self.async_update_listeners()
        await self.async_request_refresh()

    async def async_disable(self) -> None:
        """Slå av regulering manuelt (ingen varsling)."""
        self.enabled = False
        self.status = STATUS_OFF
        self._paused_since = None
        self._cancel_pending_notify()
        persistent_notification.async_dismiss(
            self.hass, f"{DOMAIN}_{self.entry.entry_id}_paused"
        )
        await self._save()
        self.async_update_listeners()

    # ------------------------------------------------------------ avlesing
    def _read_float(self, entity_id: str) -> float | None:
        state = self.hass.states.get(entity_id)
        if state is None or state.state in (STATE_UNKNOWN, STATE_UNAVAILABLE):
            return None
        try:
            return float(state.state)
        except (ValueError, TypeError):
            return None

    def _read_climate_setpoint(self, entity_id: str) -> float | None:
        state = self.hass.states.get(entity_id)
        if state is None:
            return None
        temp = state.attributes.get("temperature")
        try:
            return float(temp) if temp is not None else None
        except (ValueError, TypeError):
            return None
