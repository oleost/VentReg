/**
 * VentiReg-kort — grafisk visning og redigering av tilluftskurven.
 *
 * Ren JavaScript (ingen byggesteg). Leser kurvepunkter fra en VentiReg-sensor
 * sine attributter, lar deg dra hvert punkt opp/ned, og lagrer ved å kalle
 * tjenesten ventireg.set_curve.
 *
 * Dashboard-konfig:
 *   type: custom:ventireg-card
 *   entity: sensor.ventireg_calculated_setpoint
 *   title: Utekompensert kurve     # valgfritt
 */

const SVGNS = "http://www.w3.org/2000/svg";

// Tegneflate i viewBox-koordinater (skaleres responsivt av nettleseren)
const VB_W = 1000;
const VB_H = 560;
const PAD = { left: 70, right: 30, top: 30, bottom: 50 };
const PLOT = {
  left: PAD.left,
  right: VB_W - PAD.right,
  top: PAD.top,
  bottom: VB_H - PAD.bottom,
};

class VentiRegCard extends HTMLElement {
  setConfig(config) {
    if (!config.entity) {
      throw new Error("Du må sette 'entity' (en VentiReg-sensor med kurvepunkter).");
    }
    this._config = config;
    this._points = null; // [[ute, tilluft], ...]
    this._dragIndex = null;
    this._yRange = null; // {min, max} fastsettes ved bygging
    this._built = false;
  }

  set hass(hass) {
    this._hass = hass;
    const stateObj = hass.states[this._config.entity];
    if (!stateObj) {
      this._renderError(`Ukjent entitet: ${this._config.entity}`);
      return;
    }

    this._outdoor = Number(stateObj.attributes.outdoor_temp);
    this._setpoint = Number(stateObj.state);
    this._status = stateObj.attributes.status;

    const incoming = stateObj.attributes.curve_points;
    if (!Array.isArray(incoming) || incoming.length < 2) {
      this._renderError("Entiteten mangler gyldige curve_points.");
      return;
    }

    // Ikke overstyr brukerens drag med innkommende tilstand mens han drar
    if (this._dragIndex === null) {
      const next = incoming
        .map((p) => [Number(p[0]), Number(p[1])])
        .sort((a, b) => a[0] - b[0]);
      const countChanged = !this._points || this._points.length !== next.length;
      this._points = next;
      if (!this._built || countChanged) {
        this._build();
      }
    }
    this._updateGeometry();
  }

  getCardSize() {
    return 6;
  }

  // ---------------------------------------------------------------- koordinater
  _xToPx(x) {
    const xs = this._points.map((p) => p[0]);
    const xMin = Math.min(...xs);
    const xMax = Math.max(...xs);
    const span = xMax - xMin || 1;
    return PLOT.left + ((x - xMin) / span) * (PLOT.right - PLOT.left);
  }

  _yToPx(y) {
    const { min, max } = this._yRange;
    const span = max - min || 1;
    return PLOT.bottom - ((y - min) / span) * (PLOT.bottom - PLOT.top);
  }

  _pxToY(py) {
    const { min, max } = this._yRange;
    const span = max - min || 1;
    const y = min + ((PLOT.bottom - py) / (PLOT.bottom - PLOT.top)) * span;
    return Math.round(y * 2) / 2; // snap til 0,5
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

  // ---------------------------------------------------------------- bygging
  _build() {
    this._yRange = this._computeYRange();

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
        <div class="vr-hint">Dra hvert punkt opp/ned for å justere kurven</div>
      </ha-card>
    `;

    const svg = this.querySelector("svg");
    this._svg = svg;
    this._spValEl = this.querySelector(".vr-sp-val");
    this._outEl = this.querySelector(".vr-out");
    this._setEl = this.querySelector(".vr-set");

    // Lag-rekkefølge: rutenett, fyll, linje, markør, punkter
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

    this._circles = this._points.map((_, i) => {
      const c = this._mk(svg, "circle", {
        r: "9",
        fill: "var(--card-background-color,#fff)",
        stroke: "var(--warning-color,#ff9800)",
        "stroke-width": "3",
      });
      c.classList.add("vr-pt");
      c.addEventListener("pointerdown", (ev) => this._onDown(ev, i));
      return c;
    });

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

    // Rutenett + akseetiketter (bygges på nytt; få elementer)
    this._gridG.innerHTML = "";
    const { min, max } = this._yRange;
    for (let y = min; y <= max; y++) {
      if ((max - min > 12) && y % 2 !== 0) continue;
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
    for (const [x] of this._points) {
      const px = this._xToPx(x);
      const t = this._mk(this._gridG, "text", {
        x: px, y: PLOT.bottom + 28, "text-anchor": "middle",
        "font-size": "20", fill: "var(--secondary-text-color,#888)",
      });
      t.textContent = `${x}°`;
    }

    // Linje + fyll
    const linePts = this._points.map(([x, y]) => `${this._xToPx(x)},${this._yToPx(y)}`);
    this._linePath.setAttribute("d", "M" + linePts.join(" L"));
    const x0 = this._xToPx(this._points[0][0]);
    const xN = this._xToPx(this._points[this._points.length - 1][0]);
    this._areaPath.setAttribute(
      "d",
      `M${x0},${PLOT.bottom} L` + linePts.join(" L") + ` L${xN},${PLOT.bottom} Z`
    );

    // Punkter
    this._points.forEach(([x, y], i) => {
      this._circles[i].setAttribute("cx", this._xToPx(x));
      this._circles[i].setAttribute("cy", this._yToPx(y));
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
    const xs = this._points.map((p) => p[0]);
    const cx = Math.max(Math.min(x, Math.max(...xs)), Math.min(...xs));
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
  _svgY(ev) {
    const rect = this._svg.getBoundingClientRect();
    return ((ev.clientY - rect.top) / rect.height) * VB_H;
  }

  _onDown(ev, i) {
    ev.preventDefault();
    this._dragIndex = i;
    this._svg.setPointerCapture(ev.pointerId);
    this._circles[i].setAttribute("r", "11");
  }

  _onMove(ev) {
    if (this._dragIndex === null) return;
    ev.preventDefault();
    const { min, max } = this._yRange;
    let y = this._pxToY(this._svgY(ev));
    y = Math.max(min, Math.min(max, y));
    this._points[this._dragIndex][1] = y;
    this._updateGeometry();
  }

  _onUp(ev) {
    if (this._dragIndex === null) return;
    const i = this._dragIndex;
    this._dragIndex = null;
    this._circles[i].setAttribute("r", "9");
    try {
      this._svg.releasePointerCapture(ev.pointerId);
    } catch (e) {
      /* ignore */
    }
    this._save();
  }

  _save() {
    const curve = this._points.map(([x, y]) => [x, y]);
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

customElements.define("ventireg-card", VentiRegCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ventireg-card",
  name: "VentiReg Kurve",
  description: "Grafisk visning og redigering av tilluftskurven (dra punktene).",
  preview: false,
});

console.info("%c VENTIREG-CARD %c lastet ", "background:#ff9800;color:#fff", "");
