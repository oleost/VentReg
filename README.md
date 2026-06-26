# VentiReg

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![GitHub release](https://img.shields.io/github/v/release/oleost/VentReg?include_prereleases&sort=semver)](https://github.com/oleost/VentReg/releases)
[![License](https://img.shields.io/github/license/oleost/VentReg)](LICENSE)

Home Assistant custom integration for **kurvestyring av tilluftstemperatur** på ventilasjon
(primært Flexit), basert på utetemperatur — slik en varmekurve/værkompensering fungerer.

Kald ute → varmere tilluft, varm ute → kjøligere tilluft, med lineær overgang mellom
konfigurerbare knekkpunkter.

```
Tilluft
 22°C │●─────╮
      │       ╲
 10°C │        ╰──────●
      └──┬────────────┬────► Utetemperatur
        5°C          20°C
```

## Funksjoner

- **Multipunkt-kurve** (minst 2 punkter), lineær interpolasjon, flat utenfor ytterpunktene.
- **Alt konfigurerbart i UI** — utesensor, climate-entitet, kurvepunkter, intervall, toleranse, avrundingssteg.
- **Auto-pause:** endrer noe annet enn VentiReg settpunktet, stopper reguleringen automatisk
  (overskriver aldri en manuell endring).
- **Varsling:** persistent notification i Home Assistant 24 timer etter at auto-pause inntraff.
- **Switch** for på/av, og statussensor (`På` / `Av` / `Auto pauset`).
- Avrunder settpunktet til 0,5 °C (Flexit-steg).

## Installasjon (HACS)

1. HACS → Integrasjoner → tre prikker → **Custom repositories**.
2. Legg til `https://github.com/oleost/VentReg` som kategori **Integration**.
3. Installer **VentiReg**, og start Home Assistant på nytt.
4. Innstillinger → Enheter og tjenester → **Legg til integrasjon** → VentiReg.

## Konfigurasjon

| Felt | Beskrivelse |
|---|---|
| Utetemperatur-sensor | `sensor.*` som måler ute |
| Ventilasjon (climate) | `climate.*` der target = tilluftstemperatur |
| Kurvepunkter | `ute:tilluft`, skilt med komma/linjeskift, f.eks. `5:22, 20:10` |
| Oppdateringsintervall | Minutter mellom hver beregning (default 15) |
| Toleranse | °C-avvik som regnes som ekstern endring (default 0,5) |
| Avrundingssteg | Steg settpunktet rundes til (default 0,5) |

## Slik virker pause/gjenoppta

VentiReg sjekker **før** hver skriving om climate-settpunktet avviker fra det den selv satt
sist. Avvik ≥ toleranse → auto-pause (switch av, status «Auto pauset»). Slå switchen på igjen
for å gjenoppta — da regner og skriver VentiReg umiddelbart.

Se [CLAUDE.md](CLAUDE.md) for arkitektur og designvalg.
