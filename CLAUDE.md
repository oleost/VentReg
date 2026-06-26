# VentiReg — Home Assistant custom integration

Kurvestyring (vær-/utetemperaturkompensering) av **tilluftstemperatur** på ventilasjon
(primært Flexit). Leser en utetemperatur-sensor, regner ønsket tilluftstemperatur ut fra
en konfigurerbar multipunkt-kurve, og skriver settpunktet til en `climate`-entitet.

## Kjernekonsept

```
Tilluft
 22°C │●─────╮
      │       ╲   (stykkevis lineær interpolasjon mellom punktene,
      │        ╲   flat/clamp utenfor ytterpunktene)
 10°C │         ╰──────●
      └──┬────────────┬────► Utetemperatur
        5°C          20°C
```

Standardkurven er to punkter (`5 °C → 22 °C`, `20 °C → 10 °C`), men kurven er **multipunkt**:
brukeren kan legge til flere knekkpunkter. Interpolasjon er **lineær** mellom punkter.
Ingen ekte spline (bevisst valg — unødvendig for luft-til-luft, vanskeligere å konfigurere).

## Reguleringssløyfe

Kjøres av en `DataUpdateCoordinator` hvert **15. minutt** (konfigurerbart). Kun når
switchen er **på**:

1. Les **faktisk** settpunkt på climate-entiteten.
2. Sammenlign med **«sist satt av VentiReg»** (`_last_set`).
3. Avvik ≥ toleranse (default 0,5 °C, som er Flexit sitt reguleringssteg) →
   **noen andre har endret settpunktet** → gå i **auto-pause**: slå switch av,
   status = «Auto pauset», skriv tidspunkt, skriv **ingenting** til aggregatet.
4. Ellers → regn kurveverdi ut fra utetemp, rund til nærmeste 0,5 °C, skriv til
   climate via `climate.set_temperature`, lagre verdien som `_last_set`.

Vi **lytter ikke løpende** på climate-entiteten. Konsekvens: en ekstern endring oppdages
først ved neste tikk (opptil 15 min forsinkelse). Dette er et bevisst, akseptert kompromiss
— det garanterer at vi aldri overskriver en manuell endring, fordi vi alltid sjekker før vi skriver.

## Pause og reaktivering

- **Auto-pause** skjer kun fra punkt 3 over. Switchen slås av.
- **24 timer** etter at auto-pause inntraff sendes en **persistent notification** i HA
  (kun hvis fortsatt pauset). Telleren nullstilles ved reaktivering.
- **Manuelt av** (bruker slår switch av) gir **ingen** varsling.
- **Reaktivering:** bruker slår switch på → VentiReg regner og skriver **umiddelbart**
  (venter ikke 15 min) og lagrer verdien som `_last_set`, slik at den ikke auto-pauser seg
  selv rett etterpå.

Switchen er **av** både ved manuelt av og auto-pause. Statussensoren skiller dem:
`På` / `Av` / `Auto pauset`.

## Entiteter

| Entitet | Beskrivelse |
|---|---|
| `switch.ventireg_*` | På = aktiv regulering, av = stoppet (manuelt eller auto-pauset). RestoreEntity. |
| `sensor.ventireg_*_status` | Enum: `on` / `off` / `auto_paused` (lokalisert). |
| `sensor.ventireg_*_target` | Beregnet settpunkt akkurat nå (°C), for innsyn/graf. |

## Konfigurasjon (config flow + options flow)

Alt er konfigurerbart i UI — **ingenting hardkodet**.

- `outdoor_sensor` — utetemperatur-sensor (`sensor.*`)
- `climate_entity` — ventilasjons-climate (`climate.*`), target = tilluftstemperatur
- `curve_points` — multilinje/komma-separert liste, format `ute:tilluft` (f.eks. `5:22, 20:10`)
- `update_interval` — minutter (default 15)
- `tolerance` — °C avvik som regnes som ekstern endring (default 0,5)
- `step` — avrundingssteg for settpunkt (default 0,5)

Kjerne-entitetene settes i første oppsett; kurve/intervall/toleranse kan endres i options
flow etterpå.

## Redigering av kurven — tre veier, én kilde til sannhet

Kurvepunktene lagres **kun** i `entry.options[CONF_CURVE_POINTS]` (streng på formatet
`ute:tilluft`). Alle tre redigeringsveiene skriver dit, og en `update_listener` laster
entryen på nytt (Store gjenoppretter `_last_set`, så pause-baselinen overlever reload):

1. **Options flow** (native, alltid tilgjengelig via «Konfigurer») — tekstfelt.
2. **Tjenesten `ventireg.set_curve`** — `entity_id` (valgfri) + `curve` (streng eller liste).
   Resolver config entry via entitetens `config_entry_id`. Validerer med `parse_points`.
3. **Det grafiske kortet** (`www/ventireg-card.js`) — dra punktene, kaller `set_curve` ved slipp.

Punktene eksponeres for kortet som attributter på beregnet-settpunkt-sensoren:
`curve_points`, `outdoor_temp`, `status`.

Kortet er **ren JavaScript** (ingen byggesteg). `__init__.py` (`async_setup`) serverer fila på
`/ventireg/ventireg-card.js` via `async_register_static_paths` og auto-laster den med
`add_extra_js_url`, så brukeren slipper å registrere dashboard-ressurs manuelt. Dragging er
**kun vertikal** (x/utetemp er låst, kun tilluft endres), snappet til 0,5 °C.

## Filstruktur

```
custom_components/ventireg/
├── __init__.py          # async_setup (tjeneste + kort-registrering), async_setup_entry
├── manifest.json
├── const.py             # DOMAIN, konfignøkler, defaults
├── config_flow.py       # ConfigFlow (oppsett) + OptionsFlow (endring)
├── coordinator.py       # VentiRegCoordinator: sløyfa, pause-logikk, varsling
├── curve.py             # parsing + interpolasjon + avrunding + points_to_string
├── switch.py            # switch-entitet (på/av/auto-pause)
├── sensor.py            # status- + beregnet-settpunkt-sensorer (curve_points-attributter)
├── services.yaml        # ventireg.set_curve
├── strings.json         # config/options UI-tekst (engelsk basis)
├── translations/        # en.json, nb.json
└── www/
    └── ventireg-card.js # grafisk kurve-kort (vanilla JS, ingen bygging)
```

## Designvalg / kjente begrensninger

- `_last_set` lagres **i minne**. Etter en HA-omstart er den `None`, og første tikk
  etablerer baseline på nytt uten å pause. En ekstern endring gjort *mens HA var nede*
  oppdages altså ikke. Akseptert kompromiss; switch-tilstanden (på/av) overlever omstart
  via RestoreEntity.
- Toleranse ≥ 0,5 °C fungerer rent fordi Flexit kun styrer i 0,5-steg: en ekte ekstern
  endring er minst ett helt steg unna det vi skrev.
- Interpolasjon clamper utenfor ytterpunktene (flatt), den ekstrapolerer ikke.

## Manuell testing

Integrasjonen krever en kjørende Home Assistant. For rask logikk-test av kurven uten HA,
se `curve.py` — funksjonene `parse_points`, `interpolate` og `round_to_step` er rene og
kan testes isolert.
