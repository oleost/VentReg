"""Config- og options-flow for VentiReg."""
from __future__ import annotations

from typing import Any

import voluptuous as vol
from homeassistant.config_entries import ConfigEntry, ConfigFlow, OptionsFlow
from homeassistant.core import callback
from homeassistant.data_entry_flow import FlowResult
from homeassistant.helpers import selector

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
)
from .curve import parse_points


def _build_schema(defaults: dict[str, Any]) -> vol.Schema:
    """Bygg skjema; bruk lagrede verdier som default der de finnes."""

    def default(key: str, fallback: Any = vol.UNDEFINED) -> Any:
        return defaults.get(key, fallback)

    return vol.Schema(
        {
            vol.Required(
                CONF_OUTDOOR_SENSOR, default=default(CONF_OUTDOOR_SENSOR)
            ): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="sensor")
            ),
            vol.Required(
                CONF_CLIMATE_ENTITY, default=default(CONF_CLIMATE_ENTITY)
            ): selector.EntitySelector(
                selector.EntitySelectorConfig(domain="climate")
            ),
            vol.Required(
                CONF_CURVE_POINTS,
                default=default(CONF_CURVE_POINTS, DEFAULT_CURVE_POINTS),
            ): selector.TextSelector(
                selector.TextSelectorConfig(multiline=True)
            ),
            vol.Required(
                CONF_UPDATE_INTERVAL,
                default=default(CONF_UPDATE_INTERVAL, DEFAULT_UPDATE_INTERVAL),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=1,
                    max=180,
                    step=1,
                    mode=selector.NumberSelectorMode.BOX,
                    unit_of_measurement="min",
                )
            ),
            vol.Required(
                CONF_TOLERANCE,
                default=default(CONF_TOLERANCE, DEFAULT_TOLERANCE),
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=0.1,
                    max=5,
                    step=0.1,
                    mode=selector.NumberSelectorMode.BOX,
                    unit_of_measurement="°C",
                )
            ),
            vol.Required(
                CONF_STEP, default=default(CONF_STEP, DEFAULT_STEP)
            ): selector.NumberSelector(
                selector.NumberSelectorConfig(
                    min=0.1,
                    max=1,
                    step=0.1,
                    mode=selector.NumberSelectorMode.BOX,
                    unit_of_measurement="°C",
                )
            ),
        }
    )


class VentiRegConfigFlow(ConfigFlow, domain=DOMAIN):
    """Førstegangsoppsett."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                parse_points(user_input[CONF_CURVE_POINTS])
            except ValueError:
                errors["base"] = "invalid_curve"
            if not errors:
                return self.async_create_entry(title="VentiReg", data=user_input)

        return self.async_show_form(
            step_id="user",
            data_schema=_build_schema(user_input or {}),
            errors=errors,
        )

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return VentiRegOptionsFlow()


class VentiRegOptionsFlow(OptionsFlow):
    """Endring av konfigurasjon etter oppsett."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> FlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            try:
                parse_points(user_input[CONF_CURVE_POINTS])
            except ValueError:
                errors["base"] = "invalid_curve"
            if not errors:
                return self.async_create_entry(title="", data=user_input)

        defaults = {**self.config_entry.data, **self.config_entry.options}
        return self.async_show_form(
            step_id="init",
            data_schema=_build_schema(defaults),
            errors=errors,
        )
