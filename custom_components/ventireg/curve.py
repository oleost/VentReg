"""Ren kurvelogikk for VentiReg — parsing, interpolasjon og avrunding.

Disse funksjonene har ingen Home Assistant-avhengigheter og kan testes isolert.
"""
from __future__ import annotations

import re

Point = tuple[float, float]

# Et punkt skrives 'ute:tilluft' (eller 'ute/tilluft'). Desimaler bruker punktum.
_PAIR_RE = re.compile(r"^\s*(-?\d+(?:\.\d+)?)\s*[:/]\s*(-?\d+(?:\.\d+)?)\s*$")


def parse_points(raw: object) -> list[Point]:
    """Parse kurvepunkter til en sortert liste av (utetemp, tilluft).

    Godtar enten en ferdig liste/tuple av par, eller en streng der par er skilt
    med komma, semikolon eller linjeskift, f.eks. "5:22, 20:10".

    Kaster ValueError ved ugyldig format, færre enn 2 punkter, eller duplikat
    utetemperatur.
    """
    pairs: list[Point] = []

    if isinstance(raw, (list, tuple)):
        for item in raw:
            try:
                x, y = item
                pairs.append((float(x), float(y)))
            except (TypeError, ValueError) as err:
                raise ValueError(f"Ugyldig punkt: {item!r}") from err
    else:
        for token in re.split(r"[,;\n]", str(raw)):
            if not token.strip():
                continue
            match = _PAIR_RE.match(token)
            if not match:
                raise ValueError(
                    f"Ugyldig punkt: {token.strip()!r} "
                    "(forventet 'ute:tilluft', f.eks. 5:22)"
                )
            pairs.append((float(match.group(1)), float(match.group(2))))

    if len(pairs) < 2:
        raise ValueError("Kurven må ha minst 2 punkter")

    pairs.sort(key=lambda p: p[0])

    xs = [p[0] for p in pairs]
    if len(set(xs)) != len(xs):
        raise ValueError("To punkter har samme utetemperatur")

    return pairs


def interpolate(points: list[Point], outdoor: float) -> float:
    """Stykkevis lineær interpolasjon. Clamper (flatt) utenfor ytterpunktene.

    `points` må være sortert stigende på utetemperatur (slik parse_points gir).
    """
    if outdoor <= points[0][0]:
        return points[0][1]
    if outdoor >= points[-1][0]:
        return points[-1][1]

    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        if x0 <= outdoor <= x1:
            ratio = (outdoor - x0) / (x1 - x0)
            return y0 + ratio * (y1 - y0)

    return points[-1][1]


def round_to_step(value: float, step: float = 0.5) -> float:
    """Rund av til nærmeste `step` (f.eks. 0,5 °C for Flexit)."""
    if step <= 0:
        return value
    return round(value / step) * step


def points_to_string(points: list[Point]) -> str:
    """Serialiser punkter tilbake til 'ute:tilluft'-strengformatet."""

    def fmt(value: float) -> str:
        return str(int(value)) if float(value).is_integer() else str(value)

    return ", ".join(f"{fmt(x)}:{fmt(y)}" for x, y in points)
