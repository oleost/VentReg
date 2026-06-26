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
   Unntak: `_recently_wrote()` — innenfor `WRITE_CONFIRM_GRACE` (90 s) etter vår egen skriving
   ignoreres avvik, så aggregatets ennå-ubekreftede ekko ikke gir **falsk** auto-pause
   (var en reell feil ved raske kurve-endringer).
4. Ellers → regn kurveverdi ut fra utetemp, rund til nærmeste 0,5 °C, og skriv til climate via
   `climate.set_temperature` **kun når kurveverdien faktisk er endret** (`abs(target - _last_set)
   >= 0.01`), lagre verdien som `_last_set`. Unngår unødvendige skrivinger.

I tillegg til 15-minutterstikket **lytter** koordinatoren på utesensoren og climate-entiteten
(`async_setup_source_listener` → `async_track_state_change_event`) og kaller `async_request_refresh`
ved endring. Dette gjør at:
- «Beregnet settpunkt» ikke blir stående `unknown` hvis utesensoren er `unavailable` ved oppstart
  (regnes på nytt så snart sensoren får en verdi).
- reguleringen og **auto-pause** reagerer raskt, ikke bare hvert 15. min.

For climate filtreres det på endring i `temperature`-attributtet (settpunkt), så støy som
`current_temperature` ikke trigger unødvendige beregninger. Vi sjekker fortsatt alltid før vi
skriver, så vi overskriver aldri en manuell endring. Lytteren ryddes i `async_shutdown_extra`.

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
`ute:tilluft`). Alle tre redigeringsveiene skriver dit:

1. **Options flow** (native, alltid tilgjengelig via «Konfigurer») — tekstfelt.
2. **Tjenesten `ventireg.set_curve`** — `entity_id` (valgfri) + `curve` (streng eller liste).
   Resolver config entry via entitetens `config_entry_id`. Validerer med `parse_points`.
3. **Det grafiske kortet** (`www/ventireg-card.js`) — dra punktene, kaller `set_curve` ved slipp.

`update_listener` (`async_reload_entry`) er **smart**: koordinatoren leser kurve/toleranse/steg
**live** via `_config()`, så slike endringer trigger **ingen reload** — bare en umiddelbar
`async_refresh()` (som skriver nytt settpunkt til climate med en gang). Det unngår at kortet
flimrer og gir umiddelbar respons. Kun endret intervall eller kilde-entiteter (`requires_reload`)
gir full reload (der gjenoppretter Store `_last_set`).

Punktene eksponeres for kortet som attributter på beregnet-settpunkt-sensoren:
`curve_points`, `outdoor_temp`, `status`.

Kortet er **ren JavaScript** (ingen byggesteg). Punktene dras **fritt i 2D**: X (utetemp, snap til
`x_step`, default 1°) og Y (tilluft, snap 0,5 °C). X klemmes mellom naboene så kurven holder seg
strengt økende; X-aksen er fast (`min_outdoor`/`max_outdoor`, default ca. -25…30). Store usynlige
trefflater rundt hvert punkt gjør det lett å treffe på touch. Linja/fyllet forlenges flatt ut til
aksekantene for å vise clampingen. Endring lagres ved slipp via `set_curve`.

**Optimistisk oppdatering:** etter slipp holder kortet på din verdi og ignorerer innkommende
tilstand til backend bekrefter samme kurve (8 s timeout), så punktet ikke «spretter tilbake» mens
backend henger etter.

### Auto-innlasting av kortet (`frontend.py`)

`add_extra_js_url` alene er **ikke** pålitelig for å få kortet til å dukke opp (kortet finnes ikke
i frontend selv i inkognito). Den robuste, offisielle måten er å registrere kortet som en **ekte
Lovelace-ressurs** i storage-modus — slik HACS gjør. `frontend.py` (`VentiRegCardRegistration`):

1. Serverer `www/`-mappa på `/ventireg/` via `async_register_static_paths` (kort på
   `/ventireg/ventireg-card.js`).
2. **Storage-modus:** venter til `lovelace.resources.loaded` er True, og kaller deretter
   `async_create_item`/`async_update_item` med `{res_type: module, url: …?v=CARD_VERSION}`.
   Versjonert URL gir cache-busting; eksisterende ressurs oppdateres kun ved versjonsendring.
3. **YAML-modus:** faller tilbake til `add_extra_js_url` (ressurser styres i YAML der).

**Viktig timing-felle** (home-assistant/core#165767): kalles ressurs-API-et *før* ressurslista er
lastet, slettes alle eksisterende ressurser i stillhet. Derfor venter vi på `resources.loaded`, og
kjører registreringen først etter `EVENT_HOMEASSISTANT_STARTED` (eller umiddelbart hvis HA alt
kjører). `manifest.json` har `dependencies: [http, frontend]` + `after_dependencies: [lovelace]`.
Bump `CARD_VERSION` i `frontend.py` når kortet endres.

## Filstruktur

```
custom_components/ventireg/
├── __init__.py          # async_setup (tjeneste + frontend-trigger), async_setup_entry
├── frontend.py          # VentiRegCardRegistration: kortet som Lovelace-ressurs
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
