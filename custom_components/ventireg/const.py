"""Konstanter for VentiReg."""
from __future__ import annotations

from datetime import timedelta

from homeassistant.const import Platform

DOMAIN = "ventireg"
PLATFORMS = [Platform.SWITCH, Platform.SENSOR]

# Konfignøkler
CONF_OUTDOOR_SENSOR = "outdoor_sensor"
CONF_CLIMATE_ENTITY = "climate_entity"
CONF_CURVE_POINTS = "curve_points"
CONF_UPDATE_INTERVAL = "update_interval"
CONF_TOLERANCE = "tolerance"
CONF_STEP = "step"

# Defaults
DEFAULT_CURVE_POINTS = "-5:23, 5:20, 10:18, 20:10"
DEFAULT_UPDATE_INTERVAL = 15  # minutter
DEFAULT_TOLERANCE = 0.5  # °C
DEFAULT_STEP = 0.5  # °C (Flexit regulerer i 0,5-steg)

# Hvor lenge i auto-pause før varsling
PAUSE_NOTIFY_AFTER = timedelta(hours=24)

# Statusverdier (enum-sensor)
STATUS_ON = "on"
STATUS_OFF = "off"
STATUS_AUTO_PAUSED = "auto_paused"
STATUSES = [STATUS_ON, STATUS_OFF, STATUS_AUTO_PAUSED]
