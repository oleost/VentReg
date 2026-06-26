/**
 * VentiReg-kort — grafisk visning og redigering av tilluftskurven.
 *
 * Ren JavaScript (ingen byggesteg). Leser kurvepunkter fra en VentiReg-sensor
 * sine attributter, lar deg dra hvert punkt fritt (venstre/høyre + opp/ned), og
 * lagrer ved å kalle tjenesten ventireg.set_curve.
 *
 * Dashboard-konfig:
 *   type: custom:ventireg-card
 *   entity: sensor.ventireg_beregnet_settpunkt   # din faktiske id (avhenger av HA-språk)
 *   title: Utekompensert kurve     # valgfritt
 *   min_outdoor: -25               # valgfritt, fast venstre kant på X-aksen
 *   max_outdoor: 30                # valgfritt, fast høyre kant på X-aksen
 *   x_step: 1                      # valgfritt, snapping på utetemperatur (grader)
 */

const SVGNS = "http://www.w3.org/2000/svg";

// Tegneflate i viewBox-koordinater (skaleres responsivt av nettleseren)
const VB_W = 1000;
const VB_H = 600;
const PAD = { left: 88, right: 30, top: 30, bottom: 78 };
const PLOT = {
  left: PAD.left,
  right: VB_W - PAD.right,
  top: PAD.top,
  bottom: VB_H - PAD.bottom,
};
const Y_SNAP = 0.5; // Flexit-steg
const X_TICK = 5; // gradering på X-aksen

class VentiRegCard extends HTMLElement {
  setConfig(config) {
    if (!config.entity) {
      throw new Error("Du må sette 'entity' (en VentiReg-sensor med kurvepunkter).");
    }
    this._config = config;
    this._xStep = Number(config.x_step) > 0 ? Number(config.x_step) : 1;
    this._points = null; // [[ute, tilluft], ...]
    this._dragIndex = null;
    this._xRange = null; // {min, max} — fast X-akse
    this._yRange = null; // {min, max}
    this._built = false;
    this._pendingCurve = null; // kurve vi nettopp lagret, venter på bekreftelse
    this._pendingTimer = null;
  }

  set hass(hass) {
    this._hass = hass;
    const stateObj = hass.states[this._config.entity];
    const incoming =
      stateObj && stateObj.attributes ? stateObj.attributes.curve_points : null;
    const valid = Array.isArray(incoming) && incoming.length >= 2;

    if (!valid) {
      // Forbigående utilgjengelig (typisk under en reload) → behold forrige gyldige
      // visning i stedet for å blinke opp en feilmelding.
      if (this._built && this._points) return;
      this._renderError(
        stateObj
          ? "Venter på gyldige curve_points …"
          : `Ukjent entitet: ${this._config.entity}`
      );
      return;
    }

    this._outdoor = Number(stateObj.attributes.outdoor_temp);
    this._setpoint = Number(stateObj.state);
    this._status = stateObj.attributes.status;

    // Ikke overstyr brukerens drag med innkommende tilstand mens han drar
    // Ikke overstyr brukerens drag med innkommende tilstand mens han drar
    if (this._dragIndex === null) {
      const next = incoming
        .map((p) => [Number(p[0]), Number(p[1])])
        .sort((a, b) => a[0] - b[0]);

      // Optimistisk: etter at vi har lagret, ignorer stale innkommende data helt til
      // backend bekrefter vår nye kurve (ellers «spretter» punktet tilbake).
      if (this._pendingCurve) {
        if (this._curvesEqual(next, this._pendingCurve)) {
          this._clearPending(); // bekreftet
        } else {
          this._updateGeometry(); // behold vår visning
          return;
        }
      }

      const countChanged = !this._points || this._points.length !== next.length;
      this._points = next;
      if (!this._built || countChanged) {
        this._build();
      } else {
        this._recomputeRanges();
      }
    }
    this._updateGeometry();
  }

  _curvesEqual(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (Math.abs(a[i][0] - b[i][0]) > 0.001 || Math.abs(a[i][1] - b[i][1]) > 0.001) {
        return false;
      }
    }
    return true;
  }

  _clearPending() {
    this._pendingCurve = null;
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
  }

  getCardSize() {
    return 6;
  }

  // ---------------------------------------------------------------- områder
  _recomputeRanges() {
    this._xRange = this._computeXRange();
    this._yRange = this._computeYRange();
  }

  _computeXRange() {
    const xs = this._points.map((p) => p[0]);
    const cfgMin = this._config.min_outdoor;
    const cfgMax = this._config.max_outdoor;
    let min =
      cfgMin !== undefined ? Number(cfgMin) : Math.min(-25, Math.floor(Math.min(...xs)) - 5);
    let max =
      cfgMax !== undefined ? Number(cfgMax) : Math.max(30, Math.ceil(Math.max(...xs)) + 5);
    if (max - min < 10) max = min + 10;
    return { min, max };
  }

  _computeYRange() {
    const ys = this._points.map((p) => p[1]);
    let min = Math.floor(Math.min(...ys) - 1);
    let max = Math.ceil(Math.max(...ys) + 1);
    if (Number.isFinite(this._setpoint)) {
      min = Math.min(min, Math.floor(this._setpoint));
      max = Math.max(max, Math.ceil(this._setpoint));
    }
    if (max - min < 4) max = min + 4;
    return { min, max };
  }

  // ---------------------------------------------------------------- koordinater
  _xToPx(x) {
    const { min, max } = this._xRange;
    return PLOT.left + ((x - min) / (max - min || 1)) * (PLOT.right - PLOT.left);
  }

  _pxToX(px) {
    const { min, max } = this._xRange;
    return min + ((px - PLOT.left) / (PLOT.right - PLOT.left)) * (max - min || 1);
  }

  _yToPx(y) {
    const { min, max } = this._yRange;
    return PLOT.bottom - ((y - min) / (max - min || 1)) * (PLOT.bottom - PLOT.top);
  }

  _pxToY(py) {
    const { min, max } = this._yRange;
    const y = min + ((PLOT.bottom - py) / (PLOT.bottom - PLOT.top)) * (max - min || 1);
    return Math.round(y / Y_SNAP) * Y_SNAP;
  }

  _snapX(x) {
    return Math.round(x / this._xStep) * this._xStep;
  }

  // ---------------------------------------------------------------- bygging
  _build() {
    this._recomputeRanges();

    const title = this._config.title || "Utekompensert kurve";
    this.innerHTML = `
      <ha-card>
        <style>
          .vr-head { display:flex; align-items:center; justify-content:space-between;
                     padding:16px 16px 0; }
          .vr-title { font-size:1.4em; font-weight:600; }
          .vr-sp { background:var(--label-badge-green,#41bdf5); color:#fff;
                   border-radius:10px; padding:4px 10px; font-weight:600; text-align:center; }
          .vr-sp small { display:block; font-size:.7em; opacity:.85; font-weight:500; }
          .vr-chips { display:flex; gap:10px; justify-content:center; padding:4px 16px 8px;
                      flex-wrap:wrap; }
          .vr-chip { background:var(--secondary-background-color); border-radius:16px;
                     padding:6px 14px; font-size:.95em; }
          .vr-chip b { margin-left:6px; }
          .vr-hint { text-align:center; color:var(--secondary-text-color);
                     font-size:.85em; padding:0 16px 14px; }
          svg { width:100%; height:auto; display:block; touch-action:none; }
          .vr-pt { cursor:grab; }
          .vr-pt:active { cursor:grabbing; }
        </style>
        <div class="vr-head">
          <div class="vr-title">${title}</div>
          <div class="vr-sp"><small>ARB SP</small><span class="vr-sp-val">–</span></div>
        </div>
        <svg viewBox="0 0 ${VB_W} ${VB_H}" preserveAspectRatio="xMidYMid meet"></svg>
        <div class="vr-chips">
          <div class="vr-chip">Ute<b class="vr-out">–</b></div>
          <div class="vr-chip">Settpunkt<b class="vr-set">–</b></div>
        </div>
        <div class="vr-hint">Dra punktene fritt — venstre/høyre (ute) og opp/ned (tilluft)</div>
      </ha-card>
    `;

    const svg = this.querySelector("svg");
    this._svg = svg;
    this._spValEl = this.querySelector(".vr-sp-val");
    this._outEl = this.querySelector(".vr-out");
    this._setEl = this.querySelector(".vr-set");

    // Akse-titler (statiske)
    const xMid = (PLOT.left + PLOT.right) / 2;
    const yMid = (PLOT.top + PLOT.bottom) / 2;
    const xTitle = this._mk(svg, "text", {
      x: xMid,
      y: VB_H - 16,
      "text-anchor": "middle",
      "font-size": "22",
      fill: "var(--secondary-text-color,#888)",
    });
    xTitle.textContent = "Utetemperatur (°C)";
    const yTitle = this._mk(svg, "text", {
      x: 26,
      y: yMid,
      "text-anchor": "middle",
      "font-size": "22",
      fill: "var(--secondary-text-color,#888)",
      transform: `rotate(-90 26 ${yMid})`,
    });
    yTitle.textContent = "Tilluft (°C)";

    // Lag-rekkefølge: rutenett, fyll, linje, markør, punkter, dra-etikett
    this._gridG = this._mk(svg, "g");
    this._areaPath = this._mk(svg, "path", {
      fill: "var(--warning-color,#ff9800)",
      "fill-opacity": "0.18",
      stroke: "none",
    });
    this._linePath = this._mk(svg, "path", {
      fill: "none",
      stroke: "var(--warning-color,#ff9800)",
      "stroke-width": "3",
      "stroke-linejoin": "round",
    });
    this._marker = this._mk(svg, "line", {
      stroke: "var(--primary-color,#41bdf5)",
      "stroke-width": "2",
      "stroke-dasharray": "5 5",
      opacity: "0.7",
    });
    this._spDot = this._mk(svg, "circle", {
      r: "6",
      fill: "var(--primary-color,#41bdf5)",
    });

    // Synlige prikker (litt større for å se/sikte bedre)
    this._circles = this._points.map(() =>
      this._mk(svg, "circle", {
        r: "12",
        fill: "var(--card-background-color,#fff)",
        stroke: "var(--warning-color,#ff9800)",
        "stroke-width": "3",
      })
    );

    // Store, usynlige trefflater oppå — gjør det lett å treffe på touch
    this._hitCircles = this._points.map((_, i) => {
      const h = this._mk(svg, "circle", { r: "45", fill: "transparent" });
      h.classList.add("vr-pt");
      h.style.touchAction = "none";
      h.addEventListener("pointerdown", (ev) => this._onDown(ev, i));
      return h;
    });

    // Verdivisning som dukker opp mens man drar
    this._dragLabel = this._mk(svg, "text", {
      "text-anchor": "middle",
      "font-size": "22",
      "font-weight": "600",
      fill: "var(--primary-text-color,#222)",
    });
    this._dragLabel.style.display = "none";
    this._dragLabel.style.pointerEvents = "none";

    svg.addEventListener("pointermove", (ev) => this._onMove(ev));
    svg.addEventListener("pointerup", (ev) => this._onUp(ev));
    svg.addEventListener("pointercancel", (ev) => this._onUp(ev));

    this._built = true;
  }

  _mk(parent, tag, attrs = {}) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    parent.appendChild(el);
    return el;
  }

  // ---------------------------------------------------------------- oppdatering
  _updateGeometry() {
    if (!this._built) return;

    // Rutenett + akseetiketter
    this._gridG.innerHTML = "";
    const { min: yMin, max: yMax } = this._yRange;
    for (let y = yMin; y <= yMax; y++) {
      if (yMax - yMin > 12 && y % 2 !== 0) continue;
      const py = this._yToPx(y);
      this._mk(this._gridG, "line", {
        x1: PLOT.left, y1: py, x2: PLOT.right, y2: py,
        stroke: "var(--divider-color,#e0e0e0)", "stroke-width": "1",
      });
      const t = this._mk(this._gridG, "text", {
        x: PLOT.left - 10, y: py + 4, "text-anchor": "end",
        "font-size": "20", fill: "var(--secondary-text-color,#888)",
      });
      t.textContent = `${y}°`;
    }
    // Faste vertikale gradlinjer på X-aksen
    const { min: xMin, max: xMax } = this._xRange;
    const startX = Math.ceil(xMin / X_TICK) * X_TICK;
    for (let x = startX; x <= xMax; x += X_TICK) {
      const px = this._xToPx(x);
      this._mk(this._gridG, "line", {
        x1: px, y1: PLOT.top, x2: px, y2: PLOT.bottom,
        stroke: "var(--divider-color,#e0e0e0)", "stroke-width": "1",
      });
      const t = this._mk(this._gridG, "text", {
        x: px, y: PLOT.bottom + 28, "text-anchor": "middle",
        "font-size": "20", fill: "var(--secondary-text-color,#888)",
      });
      t.textContent = `${x}°`;
    }

    // Linje + fyll — forlenges flatt ut til aksekantene for å vise clampingen
    const n = this._points.length;
    const linePts = this._points.map(([x, y]) => `${this._xToPx(x)},${this._yToPx(y)}`);
    const xLeft = this._xToPx(this._xRange.min);
    const xRight = this._xToPx(this._xRange.max);
    const yFirst = this._yToPx(this._points[0][1]);
    const yLast = this._yToPx(this._points[n - 1][1]);

    this._linePath.setAttribute(
      "d",
      `M${xLeft},${yFirst} L` + linePts.join(" L") + ` L${xRight},${yLast}`
    );
    this._areaPath.setAttribute(
      "d",
      `M${xLeft},${PLOT.bottom} L${xLeft},${yFirst} L` +
        linePts.join(" L") +
        ` L${xRight},${yLast} L${xRight},${PLOT.bottom} Z`
    );

    // Punkter (synlig prikk + usynlig trefflate)
    this._points.forEach(([x, y], i) => {
      const cx = this._xToPx(x);
      const cy = this._yToPx(y);
      this._circles[i].setAttribute("cx", cx);
      this._circles[i].setAttribute("cy", cy);
      this._hitCircles[i].setAttribute("cx", cx);
      this._hitCircles[i].setAttribute("cy", cy);
    });

    // Ute-markør + nåværende settpunkt
    if (Number.isFinite(this._outdoor)) {
      const px = this._clampX(this._outdoor);
      const sp = Number.isFinite(this._setpoint)
        ? this._setpoint
        : this._interp(this._outdoor);
      this._marker.setAttribute("x1", px);
      this._marker.setAttribute("x2", px);
      this._marker.setAttribute("y1", PLOT.top);
      this._marker.setAttribute("y2", PLOT.bottom);
      this._marker.style.display = "";
      this._spDot.setAttribute("cx", px);
      this._spDot.setAttribute("cy", this._yToPx(sp));
      this._spDot.style.display = "";
    } else {
      this._marker.style.display = "none";
      this._spDot.style.display = "none";
    }

    // Tekstverdier
    this._spValEl.textContent = Number.isFinite(this._setpoint)
      ? `${this._setpoint.toFixed(1)}°C`
      : "–";
    this._outEl.textContent = Number.isFinite(this._outdoor)
      ? ` ${this._outdoor.toFixed(1)}°C`
      : " –";
    this._setEl.textContent = Number.isFinite(this._setpoint)
      ? ` ${this._setpoint.toFixed(1)}°C`
      : " –";
  }

  _clampX(x) {
    const cx = Math.max(Math.min(x, this._xRange.max), this._xRange.min);
    return this._xToPx(cx);
  }

  _interp(x) {
    const p = this._points;
    if (x <= p[0][0]) return p[0][1];
    if (x >= p[p.length - 1][0]) return p[p.length - 1][1];
    for (let i = 0; i < p.length - 1; i++) {
      const [x0, y0] = p[i];
      const [x1, y1] = p[i + 1];
      if (x >= x0 && x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
    return p[p.length - 1][1];
  }

  // ---------------------------------------------------------------- dra
  _svgX(ev) {
    const rect = this._svg.getBoundingClientRect();
    return ((ev.clientX - rect.left) / rect.width) * VB_W;
  }

  _svgY(ev) {
    const rect = this._svg.getBoundingClientRect();
    return ((ev.clientY - rect.top) / rect.height) * VB_H;
  }

  _onDown(ev, i) {
    ev.preventDefault();
    this._dragIndex = i;
    this._svg.setPointerCapture(ev.pointerId);
    this._circles[i].setAttribute("r", "16");
    this._dragLabel.style.display = "";
  }

  _onMove(ev) {
    if (this._dragIndex === null) return;
    ev.preventDefault();
    const i = this._dragIndex;
    const n = this._points.length;

    // Y: klem til området, snap til 0,5
    let y = this._pxToY(this._svgY(ev));
    y = Math.max(this._yRange.min, Math.min(this._yRange.max, y));

    // X: snap til x_step, klem mellom naboene (bevarer rekkefølgen)
    let x = this._snapX(this._pxToX(this._svgX(ev)));
    const gap = this._xStep;
    const leftBound = i > 0 ? this._points[i - 1][0] + gap : this._xRange.min;
    const rightBound = i < n - 1 ? this._points[i + 1][0] - gap : this._xRange.max;
    x = Math.max(leftBound, Math.min(rightBound, x));

    this._points[i] = [x, y];
    this._updateGeometry();

    // Verdivisning over punktet
    const px = this._xToPx(x);
    const py = this._yToPx(y);
    this._dragLabel.setAttribute("x", Math.max(PLOT.left + 40, Math.min(PLOT.right - 40, px)));
    this._dragLabel.setAttribute("y", Math.max(PLOT.top + 20, py - 18));
    this._dragLabel.textContent = `${x}° / ${y}°`;
  }

  _onUp(ev) {
    if (this._dragIndex === null) return;
    const i = this._dragIndex;
    this._dragIndex = null;
    this._circles[i].setAttribute("r", "12");
    this._dragLabel.style.display = "none";
    try {
      this._svg.releasePointerCapture(ev.pointerId);
    } catch (e) {
      /* ignore */
    }
    this._save();
  }

  _save() {
    const curve = this._points.map(([x, y]) => [x, y]);
    // Hold på vår verdi til backend bekrefter (eller til en timeout, som sikkerhetsnett)
    this._pendingCurve = curve.map((p) => [p[0], p[1]]);
    if (this._pendingTimer) clearTimeout(this._pendingTimer);
    this._pendingTimer = setTimeout(() => this._clearPending(), 8000);
    this._hass.callService("ventireg", "set_curve", {
      entity_id: this._config.entity,
      curve,
    });
  }

  // ---------------------------------------------------------------- feil
  _renderError(msg) {
    this.innerHTML = `<ha-card><div style="padding:16px;color:var(--error-color,#db4437)">VentiReg: ${msg}</div></ha-card>`;
    this._built = false;
  }
}

if (!customElements.get("ventireg-card")) {
  customElements.define("ventireg-card", VentiRegCard);

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "ventireg-card",
    name: "VentiReg Kurve",
    description: "Grafisk visning og redigering av tilluftskurven (dra punktene).",
    preview: false,
  });

  console.info(
    "%c VENTIREG-CARD %c lastet ",
    "background:#ff9800;color:#fff;border-radius:3px",
    ""
  );
}
