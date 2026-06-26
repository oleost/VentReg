"""VentiReg — kurvestyring av tilluftstemperatur."""
from __future__ import annotations

from pathlib import Path

import voluptuous as vol
from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, ServiceCall
from homeassistant.exceptions import HomeAssistantError, ServiceValidationError
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers import entity_registry as er
from homeassistant.helpers.typing import ConfigType

from .const import CONF_CURVE_POINTS, DOMAIN, PLATFORMS
from .coordinator import VentiRegCoordinator
from .curve import parse_points, points_to_string

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

SERVICE_SET_CURVE = "set_curve"
CARD_URL = "/ventireg/ventireg-card.js"
# Bumpes ved endringer i kortet, så nettleseren henter ny versjon (cache-busting)
CARD_VERSION = "0.2.1"

SET_CURVE_SCHEMA = vol.Schema(
    {
        vol.Optional("entity_id"): cv.entity_id,
        vol.Required("curve"): vol.Any(str, list),
    }
)


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Globalt oppsett (kjøres én gang): registrer tjeneste og det grafiske kortet."""
    await _async_register_card(hass)
    _async_register_services(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Sett opp VentiReg fra en config entry."""
    coordinator = VentiRegCoordinator(hass, entry)
    await coordinator.async_initialize()
    await coordinator.async_config_entry_first_refresh()

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(async_reload_entry))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Avlast en config entry."""
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        coordinator: VentiRegCoordinator = hass.data[DOMAIN].pop(entry.entry_id)
        coordinator.async_shutdown_extra()
    return unload_ok


async def async_reload_entry(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """Last inn på nytt når konfigurasjonen endres."""
    await hass.config_entries.async_reload(entry.entry_id)


async def _async_register_card(hass: HomeAssistant) -> None:
    """Server kort-fila og last den automatisk inn i frontend (kun én gang)."""
    if hass.data.get(f"{DOMAIN}_card_registered"):
        return
    card_path = Path(__file__).parent / "www" / "ventireg-card.js"
    await hass.http.async_register_static_paths(
        [StaticPathConfig(CARD_URL, str(card_path), False)]
    )
    # Versjonert URL → nettleseren henter ny fil etter oppdatering
    add_extra_js_url(hass, f"{CARD_URL}?v={CARD_VERSION}")
    hass.data[f"{DOMAIN}_card_registered"] = True


def _async_register_services(hass: HomeAssistant) -> None:
    """Registrer ventireg.set_curve (kun én gang)."""
    if hass.services.has_service(DOMAIN, SERVICE_SET_CURVE):
        return

    async def _handle_set_curve(call: ServiceCall) -> None:
        try:
            points = parse_points(call.data["curve"])
        except ValueError as err:
            raise ServiceValidationError(str(err)) from err

        entry = _resolve_entry(hass, call.data.get("entity_id"))
        if entry is None:
            raise ServiceValidationError(
                "Fant ikke hvilken VentiReg-instans kurven gjelder. "
                "Oppgi entity_id når du har flere instanser."
            )

        options = {**entry.options, CONF_CURVE_POINTS: points_to_string(points)}
        hass.config_entries.async_update_entry(entry, options=options)

    hass.services.async_register(
        DOMAIN, SERVICE_SET_CURVE, _handle_set_curve, schema=SET_CURVE_SCHEMA
    )


def _resolve_entry(hass: HomeAssistant, entity_id: str | None) -> ConfigEntry | None:
    """Finn config entry ut fra en VentiReg-entitet, eller den eneste som finnes."""
    entries = hass.config_entries.async_entries(DOMAIN)
    if entity_id:
        entity = er.async_get(hass).async_get(entity_id)
        if entity and entity.config_entry_id:
            return hass.config_entries.async_get_entry(entity.config_entry_id)
        raise HomeAssistantError(f"Ukjent entitet: {entity_id}")
    if len(entries) == 1:
        return entries[0]
    return None
