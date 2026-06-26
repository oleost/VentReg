"""Auto-registrering av VentiReg-kortet som Lovelace-ressurs.

Følger det offisielle mønsteret for innebygde kort: server kort-fila via en statisk
HTTP-sti, og registrer den som en ekte Lovelace-ressurs i storage-modus (slik HACS gjør).
Dette laster kortet i frontend uten at brukeren må legge til ressursen manuelt.

Viktig: ressurs-API-et kalles først når `resources.loaded` er True, ellers kan
eksisterende ressurser bli slettet (home-assistant/core#165767).
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from homeassistant.components.frontend import add_extra_js_url
from homeassistant.components.http import StaticPathConfig
from homeassistant.core import HomeAssistant
from homeassistant.helpers.event import async_call_later

_LOGGER = logging.getLogger(__name__)

URL_BASE = "/ventireg"
CARD_FILENAME = "ventireg-card.js"
# Bumpes når kortet endres, så frontend henter ny versjon (cache-busting)
CARD_VERSION = "0.6.0"


class VentiRegCardRegistration:
    """Registrerer (og holder oppdatert) kortet som Lovelace-ressurs."""

    def __init__(self, hass: HomeAssistant) -> None:
        self.hass = hass
        self.lovelace = hass.data.get("lovelace")

    async def async_register(self) -> None:
        await self._async_register_path()
        if self._mode() == "storage":
            await self._async_wait_for_resources()
        else:
            # YAML-modus: ressurser styres i YAML, så vi laster modulen globalt i stedet.
            add_extra_js_url(self.hass, f"{URL_BASE}/{CARD_FILENAME}?v={CARD_VERSION}")
            _LOGGER.debug("YAML-modus: lastet kort via add_extra_js_url")

    def _mode(self) -> str:
        if self.lovelace is None:
            return "yaml"
        return getattr(
            self.lovelace, "mode", getattr(self.lovelace, "resource_mode", "yaml")
        )

    async def _async_register_path(self) -> None:
        www = Path(__file__).parent / "www"
        try:
            await self.hass.http.async_register_static_paths(
                [StaticPathConfig(URL_BASE, str(www), False)]
            )
            _LOGGER.debug("Kort-sti registrert: %s -> %s", URL_BASE, www)
        except RuntimeError:
            _LOGGER.debug("Kort-sti allerede registrert: %s", URL_BASE)

    async def _async_wait_for_resources(self) -> None:
        resources = self.lovelace.resources
        if resources is None:
            return

        # Tving frem lasting hvis nødvendig (trygt — setter loaded uten å overskrive).
        if not getattr(resources, "loaded", False):
            try:
                await resources.async_get_info()
            except Exception as err:  # noqa: BLE001
                _LOGGER.debug("Kunne ikke forhåndslaste ressurser: %s", err)

        async def _check(_now: Any) -> None:
            if getattr(resources, "loaded", False):
                await self._async_register_resource()
            else:
                _LOGGER.debug("Lovelace-ressurser ikke lastet ennå, prøver igjen om 5 s")
                async_call_later(self.hass, 5, _check)

        await _check(0)

    async def _async_register_resource(self) -> None:
        resources = self.lovelace.resources
        url = f"{URL_BASE}/{CARD_FILENAME}"
        versioned = f"{url}?v={CARD_VERSION}"

        for resource in resources.async_items():
            if resource["url"].split("?")[0] != url:
                continue
            # Finnes allerede — oppdater bare hvis versjonen er endret.
            current = ""
            if "?v=" in resource["url"]:
                current = resource["url"].split("?v=")[1]
            if current != CARD_VERSION:
                await resources.async_update_item(
                    resource["id"], {"res_type": "module", "url": versioned}
                )
                _LOGGER.info("Oppdaterte VentiReg-kortet til v%s", CARD_VERSION)
            return

        await resources.async_create_item({"res_type": "module", "url": versioned})
        _LOGGER.info("Registrerte VentiReg-kortet som Lovelace-ressurs (%s)", versioned)
