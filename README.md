# VentiReg

[![hacs_badge](https://img.shields.io/badge/HACS-Custom-41BDF5.svg)](https://github.com/hacs/integration)
[![GitHub release](https://img.shields.io/github/v/release/oleost/VentReg?include_prereleases&sort=semver)](https://github.com/oleost/VentReg/releases)
[![License](https://img.shields.io/github/license/oleost/VentReg)](LICENSE)

Home Assistant custom integration for **kurvestyring av tilluftstemperatur** på ventilasjon
(primært Flexit), basert på utetemperatur — slik en varmekurve / værkompensering fungerer.

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

## Innhold

- [Funksjoner](#funksjoner)
- [Krav](#krav)
- [Installasjon](#installasjon)
- [Oppsett](#oppsett)
- [Entiteter](#entiteter)
- [Grafisk kurve-kort](#grafisk-kurve-kort)
- [Tjenesten `ventireg.set_curve`](#tjenesten-ventiregset_curve)
- [Slik virker reguleringen](#slik-virker-reguleringen)
- [Feilsøking](#feilsøking)
- [Begrensninger](#begrensninger)
- [Lisens](#lisens)

## Funksjoner

- **Multipunkt-kurve** (minst 2 punkter), lineær interpolasjon, flat (clamp) utenfor ytterpunktene.
- **Alt konfigurerbart i UI** — utesensor, climate-entitet, kurvepunkter, intervall, toleranse, avrundingssteg.
- **Grafisk kort** med dra-i-punktene-redigering (auto-registreres, ingen byggesteg).
- **Auto-pause:** endrer noe annet enn VentiReg settpunktet, stopper reguleringen automatisk
  (overskriver aldri en manuell endring).
- **Varsling:** persistent notification i Home Assistant 24 timer etter at auto-pause inntraff.
- **Switch** for på/av, statussensor (`På` / `Av` / `Auto pauset`) og sensor for beregnet settpunkt.
- Avrunder settpunktet til 0,5 °C (Flexit-steg).

## Krav

- Home Assistant med [HACS](https://hacs.xyz/) installert.
- En **climate-entitet** (`climate.*`) der **target-temperaturen styrer tilluften** — typisk
  fra [Flexit Nordic (BACnet)](https://www.home-assistant.io/integrations/flexit_bacnet/) eller
  en Modbus/ESPHome-løsning. Sjekk at `climate.set_temperature` faktisk flytter tilluftssettpunktet
  på ditt aggregat (se [Feilsøking](#feilsøking)).
- En **utetemperatur-sensor** (`sensor.*`) med numerisk verdi i °C.

## Installasjon

### Via HACS (anbefalt)

1. HACS → **Integrasjoner** → tre prikker oppe til høyre → **Custom repositories**.
2. Lim inn `https://github.com/oleost/VentReg`, velg kategori **Integration**, og legg til.
3. Søk opp **VentiReg** i HACS og installer.
4. **Start Home Assistant på nytt.**
5. **Innstillinger → Enheter og tjenester → Legg til integrasjon → VentiReg.**

### Oppdatering

HACS → VentiReg → **Update** → start HA på nytt. Gjør en hard refresh i nettleseren
(Ctrl/Cmd+Shift+R) så det nye kortet lastes.

### Manuell installasjon

Kopier `custom_components/ventireg/` til `config/custom_components/` i HA, og start på nytt.

## Oppsett

Ved «Legg til integrasjon» (og senere via **Konfigurer**) setter du:

| Felt | Beskrivelse | Default |
|---|---|---|
| Utetemperatur-sensor | `sensor.*` som måler ute | – |
| Ventilasjon (climate) | `climate.*` der target = tilluftstemperatur | – |
| Kurvepunkter | `ute:tilluft`, skilt med komma/linjeskift, f.eks. `5:22, 20:10` | `5:22, 20:10` |
| Oppdateringsintervall | Minutter mellom hver beregning | 15 |
| Toleranse | °C-avvik som regnes som ekstern endring | 0,5 |
| Avrundingssteg | Steg settpunktet rundes til | 0,5 |

**Kurvepunkter-format:** hvert punkt er `utetemperatur:tilluftstemperatur`. Desimaler bruker
punktum. Punkter skilles med komma, semikolon eller linjeskift. Eksempler:

```
5:22, 20:10                      # to punkter (default)
-20:23, -10:23, 0:22, 10:21, 20:15, 25:15   # multipunkt
```

Innstillingene kan endres når som helst via **Konfigurer** på integrasjonen — uten å installere
noe på nytt.

## Entiteter

Integrasjonen lager én enhet med følgende entiteter (faktisk `entity_id` kan variere med
HA-språk — sjekk under Enheter og tjenester):

| Entitet (typisk id) | Type | Beskrivelse |
|---|---|---|
| `switch.ventireg_regulation` | switch | På = aktiv regulering. Av = stoppet (manuelt **eller** auto-pauset). |
| `sensor.ventireg_status` | sensor (enum) | `På` / `Av` / `Auto pauset`. |
| `sensor.ventireg_beregnet_settpunkt`¹ | sensor (°C) | Settpunktet kurven gir akkurat nå. Har attributtene `curve_points`, `outdoor_temp` og `status` (brukes av kortet). |

¹ Entitets-id-en følger **HA-språket** ditt. På norsk blir den `sensor.ventireg_beregnet_settpunkt`,
på engelsk `sensor.ventireg_calculated_setpoint`. **Sjekk den faktiske id-en** under Innstillinger →
Enheter og tjenester → VentiReg, og bruk den i kort-/tjeneste-konfigurasjonen under.

## Grafisk kurve-kort

Integrasjonen **registrerer kortet automatisk** som en Lovelace-ressurs (slik HACS gjør) — du
trenger *ikke* legge til en dashboard-ressurs manuelt. Det skjer like etter at Home Assistant har
startet. (Krever omstart av HA første gang; bruker du YAML-dashbord, se [Feilsøking](#feilsøking).)

### Legg kortet på et dashboard

Rediger dashboardet → **+ Legg til kort** → søk **VentiReg Kurve**, eller bruk YAML:

```yaml
type: custom:ventireg-card
entity: sensor.ventireg_beregnet_settpunkt   # bruk din faktiske entitets-id (se note ¹)
title: Utekompensert kurve
```

### Kort-innstillinger

| Felt | Påkrevd | Beskrivelse |
|---|---|---|
| `type` | ja | Må være `custom:ventireg-card`. |
| `entity` | ja | Beregnet-settpunkt-sensoren (den med `curve_points`-attributtet). |
| `title` | nei | Overskrift på kortet. Default «Utekompensert kurve». |

### Bruk

- **Dra hvert punkt opp/ned** for å endre tilluftstemperaturen ved den utetemperaturen.
  (Utetemperaturen/x-aksen er låst per punkt — du justerer kun tilluften.)
- Verdien snappes til 0,5 °C, og lagres **når du slipper** via `ventireg.set_curve`.
- Den **stiplede linja** viser nåværende utetemperatur, og **prikken** viser gjeldende settpunkt
  («ARB SP»).

Kortet er bare en penere måte å redigere kurven på — den kan **også** endres via **Konfigurer**
(tekstfelt) eller tjenesten under. Alle tre veiene skriver til samme innstilling.

## Tjenesten `ventireg.set_curve`

Overskriv kurvepunktene fra en automasjon, et skript eller utviklerverktøy.

| Parameter | Påkrevd | Beskrivelse |
|---|---|---|
| `entity_id` | nei | En VentiReg-entitet for instansen. Kan utelates hvis du bare har én instans. |
| `curve` | ja | Streng (`"5:22, 20:10"`) **eller** liste av `[ute, tilluft]`-par. |

```yaml
service: ventireg.set_curve
data:
  entity_id: sensor.ventireg_beregnet_settpunkt   # din faktiske entitets-id
  curve: "0:23, 10:18, 20:10"
```

## Slik virker reguleringen

Hvert 15. minutt (konfigurerbart), og kun når switchen er **på**:

1. Les utetemperaturen og regn ut tilluft fra kurven (lineær interpolasjon, clamp utenfor ytterpunkt).
2. Rund av til 0,5 °C.
3. **Sjekk først:** avviker climate-settpunktet fra det VentiReg satt sist (≥ toleranse)?
   - **Ja** → noen andre har endret det → **auto-pause** (switch av, status «Auto pauset»),
     skriv ingenting. Etter 24 t i pause sendes en persistent notification.
   - **Nei** → skriv kurveverdien til climate-entiteten og husk den.

**Gjenoppta:** slå switchen på igjen. Da nullstiller VentiReg referansen og skriver kurveverdien
**umiddelbart** (venter ikke 15 min), slik at den ikke pauser seg selv på nytt.

> Manuelt **av** (du slår switchen av selv) gir ingen varsling — varslingen gjelder kun auto-pause.

## Feilsøking

**Kortet vises ikke / «Custom element doesn't exist: ventireg-card».**
Start HA på nytt etter installasjon/oppdatering. Kortet registreres som Lovelace-ressurs rett etter
oppstart; sjekk **Innstillinger → Dashbord → Ressurser** — `/ventireg/ventireg-card.js` skal stå der.
Gjør så en hard refresh (Ctrl/Cmd+Shift+R). Bruker du et **YAML-dashbord** (`mode: yaml`), styres
ressurser i YAML — legg da til ressursen selv:

```yaml
# i konfigurasjonen for dashbordet (eller lovelace: resources:)
resources:
  - url: /ventireg/ventireg-card.js
    type: module
```

**Settpunktet på aggregatet flytter seg ikke.**
Bekreft at `climate.set_temperature` på din Flexit faktisk styrer *tilluft*. Test i
Utviklerverktøy → Tjenester: kall `climate.set_temperature` på entiteten og se om tilluften endres.
Hvis aggregatet ditt styrer tilluft via en `number.*`-entitet i stedet, [opprett en issue](https://github.com/oleost/VentReg/issues).

**Den går i «Auto pauset» uventet.**
Da har noe annet (app, annen automasjon, manuell endring på panelet) endret settpunktet med
≥ toleranse. Øk eventuelt toleransen, eller slå switchen på igjen for å gjenoppta.

**Ikke noe skjer / status står stille.**
Sjekk at utesensoren har en gyldig numerisk verdi (ikke `unavailable`/`unknown`), og at switchen
er på. Se loggen for «VentiReg»-meldinger.

## Begrensninger

- `_last_set` (referansen for pause-deteksjon) holdes i minne og lagres til disk, men en ekstern
  endring gjort *mens HA var nede* oppdages ikke før neste normale syklus.
- Kortet drar punktene **vertikalt** (utetemp er låst per punkt). Å flytte sidelengs eller legge
  til/fjerne punkter i grafen er ikke støttet ennå (bruk tekstfeltet under Konfigurer for det).
- Interpolasjonen er lineær og clamper utenfor ytterpunktene (ekstrapolerer ikke).

Se [CLAUDE.md](CLAUDE.md) for arkitektur og designvalg.

## Lisens

[MIT](LICENSE)
