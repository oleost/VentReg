"""Switch som slår VentiReg-reguleringen på/av."""
from __future__ import annotations

from typing import Any

from homeassistant.components.switch import SwitchEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import VentiRegCoordinator


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    coordinator: VentiRegCoordinator = hass.data[DOMAIN][entry.entry_id]
    async_add_entities([VentiRegSwitch(coordinator)])


class VentiRegSwitch(CoordinatorEntity[VentiRegCoordinator], SwitchEntity):
    """På = aktiv regulering. Av = stoppet (manuelt eller auto-pauset)."""

    _attr_has_entity_name = True
    _attr_translation_key = "regulation"
    _attr_icon = "mdi:thermostat-auto"

    def __init__(self, coordinator: VentiRegCoordinator) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.entry.entry_id}_switch"
        self._attr_device_info = coordinator.device_info

    @property
    def is_on(self) -> bool:
        return self.coordinator.enabled

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {
            "status": self.coordinator.status,
            "last_set": self.coordinator.last_set,
        }

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.coordinator.async_enable()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.async_disable()
