"""Sensorer for VentiReg: status og beregnet settpunkt."""
from __future__ import annotations

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN, STATUSES
from .coordinator import VentiRegCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: VentiRegCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities(
        [
            VentiRegStatusSensor(coordinator),
            VentiRegTargetSensor(coordinator),
        ]
    )


class VentiRegStatusSensor(CoordinatorEntity[VentiRegCoordinator], SensorEntity):
    """Tekststatus: På / Av / Auto pauset."""

    _attr_has_entity_name = True
    _attr_translation_key = "status"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = STATUSES

    def __init__(self, coordinator: VentiRegCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_status"
        self._attr_device_info = coordinator.device_info

    @property
    def native_value(self) -> str:
        return self.coordinator.status


class VentiRegTargetSensor(CoordinatorEntity[VentiRegCoordinator], SensorEntity):
    """Settpunktet kurven gir akkurat nå (°C)."""

    _attr_has_entity_name = True
    _attr_translation_key = "target"
    _attr_device_class = SensorDeviceClass.TEMPERATURE
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_suggested_display_precision = 1

    def __init__(self, coordinator: VentiRegCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_target"
        self._attr_device_info = coordinator.device_info

    @property
    def native_value(self) -> float | None:
        return (self.coordinator.data or {}).get("target")

    @property
    def extra_state_attributes(self) -> dict[str, object]:
        """Eksponer kurvedata slik at det grafiske kortet kan lese/tegne den."""
        data = self.coordinator.data or {}
        return {
            "curve_points": data.get("curve_points"),
            "outdoor_temp": data.get("outdoor"),
            "status": self.coordinator.status,
        }
