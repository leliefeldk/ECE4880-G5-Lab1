/* ==========================================================================
   Dual-thermometer web interface, connected to a real ESP32 over a
   persistent WebSocket connection at /ws.

   Data flow: the ESP32 pushes a reading once/second to the server, which
   relays it here immediately (no polling delay). A once-per-second local
   tick turns the latest known value into a chart history point so the
   graph's timing stays steady regardless of network jitter.

   Places marked TODO / DECISION are exactly the points the assignment
   handout leaves open to you — this file makes *a* choice for each so the
   prototype runs, not necessarily *the* choice for your final design.
   ========================================================================== */

const HISTORY_LENGTH = 300; // seconds of history kept per sensor (spec: 300s)

// Y-axis bounds are fixed by the handout and must not change with the C/F
// toggle -- only the axis *labels* convert.
const RANGE_C = { min: 10, max: 50 };

const state = {
  unit: 'C', // DECISION: default unit on load. Handout doesn't specify.
  boxOn: true,
  sensors: {
    1: { on: true, value: 22.0, latestValue: 22.0, latestStatus: 'ok', lastUpdate: null, history: [] },
    2: { on: true, value: 18.0, latestValue: 18.0, latestStatus: 'ok', lastUpdate: null, history: [] },
  },
  alerts: {
    max: 45,
    min: 5,
    contact: '',
  },
};

// Pre-fill history with "ok" samples so the chart isn't empty on first render.
for (const s of Object.values(state.sensors)) {
  for (let i = 0; i < HISTORY_LENGTH; i++) {
    s.history.push({ value: s.value, status: 'ok' });
  }
}

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const el = {
  boxPower: document.getElementById('boxPower'),
  unitC: document.getElementById('unitC'),
  unitF: document.getElementById('unitF'),
  chart: document.getElementById('chart'),
  alertForm: document.getElementById('alertForm'),
  maxTemp: document.getElementById('maxTemp'),
  minTemp: document.getElementById('minTemp'),
  alertContact: document.getElementById('alertContact'),
  alertLog: document.getElementById('alertLog'),
};

const ctx = el.chart.getContext('2d');

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

el.boxPower.addEventListener('click', () => {
  state.boxOn = !state.boxOn;
  el.boxPower.dataset.state = state.boxOn ? 'on' : 'off';
  el.boxPower.classList.toggle('pill--on', state.boxOn);
  el.boxPower.classList.toggle('pill--off', !state.boxOn);
  el.boxPower.innerHTML = `Third box: <strong>${state.boxOn ? 'ON' : 'OFF'}</strong>`;
});

el.unitC.addEventListener('click', () => setUnit('C'));
el.unitF.addEventListener('click', () => setUnit('F'));

function setUnit(unit) {
  state.unit = unit;
  el.unitC.classList.toggle('is-active', unit === 'C');
  el.unitF.classList.toggle('is-active', unit === 'F');
}

document.querySelectorAll('[data-action="toggle-sensor"]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const id = btn.dataset.sensor;
    const sensor = state.sensors[id];
    sensor.on = !sensor.on;
    btn.textContent = sensor.on ? 'ON' : 'OFF';
    btn.classList.toggle('is-on', sensor.on);

    // Relay the toggle to the ESP32 over the same socket the readings arrive
    // on. DECISION: this assumes a single connected device controlling both
    // sensors; see the server-side TODO if you add more devices.
    sendToDevice({ type: 'command', sensorId: id, action: sensor.on ? 'on' : 'off' });
  });
});

document.querySelectorAll('[data-action="toggle-plugged"]').forEach((input) => {
  // This checkbox was only meaningful in the fake-data prototype. Now that
  // real status comes from the ESP32 over the WebSocket, hide/remove these
  // controls from index.html once you're testing against real hardware.
  input.disabled = true;
  input.parentElement.style.opacity = '0.4';
});

el.alertForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  state.alerts.max = parseFloat(el.maxTemp.value);
  state.alerts.min = parseFloat(el.minTemp.value);
  state.alerts.contact = el.alertContact.value.trim();

  try {
    await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(state.alerts),
    });
    el.alertLog.textContent = `Saved: alerts fire outside ${state.alerts.min}–${state.alerts.max}°C` +
      (state.alerts.contact ? ` → ${state.alerts.contact}` : ' (no contact set yet)');
  } catch (err) {
    el.alertLog.textContent = 'Could not save alert settings — is the server running?';
  }
});

// ---------------------------------------------------------------------------
// WebSocket connection to the server. The ESP32 pushes readings to the
// server, which relays them here the instant they arrive -- no polling
// delay. This just stores the latest value per sensor; a once/second local
// tick (below) turns that into chart history points and re-renders, so the
// graph's timing stays steady even if network messages arrive a little
// unevenly.
// ---------------------------------------------------------------------------

function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);

  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ type: 'hello', role: 'browser' }));
  });

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (msg.type !== 'reading') return;

    const sensor = state.sensors[msg.sensorId];
    if (!sensor) return;

    sensor.latestValue = msg.value;
    sensor.latestStatus = msg.status;
    sensor.lastUpdate = Date.now();
  });

  // DECISION: reconnect after a fixed 1s delay. For a lab prototype this is
  // fine; a real deployment usually backs off (1s, 2s, 4s...) so a dead
  // server isn't hammered with reconnect attempts.
  socket.addEventListener('close', () => setTimeout(connectSocket, 1000));
  socket.addEventListener('error', () => socket.close());

  state.socket = socket;
}

function sendToDevice(payload) {
  if (state.socket && state.socket.readyState === WebSocket.OPEN) {
    state.socket.send(JSON.stringify(payload));
  }
}

connectSocket();

// ---------------------------------------------------------------------------
// Once-per-second local tick: turns the latest known value per sensor into a
// chart history point, independent of exactly when the last WebSocket
// message arrived. Also decides "missing" when a sensor hasn't reported in
// a while, in case the device disconnects without the server noticing yet.
// ---------------------------------------------------------------------------

const STALE_MS = 2500; // DECISION: tolerate a bit more than one missed report

function tick() {
  for (const [id, sensor] of Object.entries(state.sensors)) {
    let status = 'ok';
    let value = sensor.value;

    const stale = !sensor.lastUpdate || Date.now() - sensor.lastUpdate > STALE_MS;

    if (!state.boxOn) {
      status = 'missing'; // "no data available" case
    } else if (stale) {
      status = 'missing'; // haven't heard from the device recently enough
    } else if (sensor.latestStatus === 'unplugged' || sensor.latestStatus === 'off') {
      status = 'missing'; // device itself reported this sensor as unavailable
    } else {
      value = sensor.latestValue;
      sensor.value = value;
      if (typeof value === 'number' && (value > RANGE_C.max || value < RANGE_C.min)) {
        status = 'offscale'; // outside the graph's fixed 10-50°C window
      }
      if (status === 'ok') checkAlertDisplay(id, value);
    }

    sensor.history.push({ value, status });
    if (sensor.history.length > HISTORY_LENGTH) sensor.history.shift();
  }

  render();
}

// DECISION: the handout distinguishes "unplugged sensor" / "sensor off" /
// "no data available" as separate messages in the *text* readout, but only
// requires missing data be "obvious" on the *graph* -- it doesn't require the
// graph to distinguish those three sub-cases from each other. Here they all
// render as one "missing" gap style on the chart, while the text readout
// keeps them separate. Revisit this if your rubric wants finer-grained gaps.

// The server (which holds the Twilio/Resend keys) is what actually decides
// whether to fire a text/email -- it does that check itself when a reading
// comes in over the socket. This just updates the on-page alert log so the
// person watching the browser sees it too.
function checkAlertDisplay(sensorId, value) {
  if (value > state.alerts.max || value < state.alerts.min) {
    el.alertLog.textContent =
      `ALERT: Sensor ${sensorId} reading ${value}°C is outside ${state.alerts.min}–${state.alerts.max}°C`;
  }
}

setInterval(tick, 1000);

// ---------------------------------------------------------------------------
// Rendering: readouts
// ---------------------------------------------------------------------------

function toDisplayUnit(celsius) {
  return state.unit === 'C' ? celsius : celsius * 9 / 5 + 32;
}

function render() {
  for (const [id, sensor] of Object.entries(state.sensors)) {
    const valueEl = document.querySelector(`[data-el="value-${id}"]`);
    const unitEl = document.querySelector(`[data-el="unit-${id}"]`);
    const statusEl = document.querySelector(`[data-el="status-${id}"]`);

    unitEl.textContent = state.unit === 'C' ? '°C' : '°F';

    const stale = !sensor.lastUpdate || Date.now() - sensor.lastUpdate > STALE_MS;

    if (!state.boxOn) {
      valueEl.textContent = '—';
      statusEl.textContent = 'No data available (third box is off)';
    } else if (stale) {
      valueEl.textContent = '—';
      statusEl.textContent = 'No data available (device not connected)';
    } else if (sensor.latestStatus === 'unplugged') {
      valueEl.textContent = '—';
      statusEl.textContent = 'Unplugged sensor';
    } else if (sensor.latestStatus === 'off') {
      valueEl.textContent = '—';
      statusEl.textContent = `Sensor ${id} off`;
    } else {
      valueEl.textContent = toDisplayUnit(sensor.value).toFixed(1);
      statusEl.textContent = '';
    }
  }

  drawChart();
}

// ---------------------------------------------------------------------------
// Rendering: scrolling chart-recorder graph
// ---------------------------------------------------------------------------

function drawChart() {
  const w = el.chart.width;
  const h = el.chart.height;
  const padding = { top: 16, right: 16, bottom: 28, left: 46 };
  const plotW = w - padding.left - padding.right;
  const plotH = h - padding.top - padding.bottom;

  ctx.clearRect(0, 0, w, h);

  // --- Y axis (fixed 10-50C / 50-122F per the handout, labels follow unit) ---
  const yMin = RANGE_C.min;
  const yMax = RANGE_C.max;

  function yToPixel(celsius) {
    const clamped = Math.max(yMin, Math.min(yMax, celsius));
    const frac = (clamped - yMin) / (yMax - yMin);
    return padding.top + plotH * (1 - frac);
  }

  ctx.strokeStyle = '#34393b';
  ctx.fillStyle = '#8f9497';
  ctx.font = '11px monospace';
  ctx.lineWidth = 1;

  const ySteps = 4;
  for (let i = 0; i <= ySteps; i++) {
    const cVal = yMin + ((yMax - yMin) * i) / ySteps;
    const py = yToPixel(cVal);
    ctx.beginPath();
    ctx.moveTo(padding.left, py);
    ctx.lineTo(w - padding.right, py);
    ctx.stroke();
    const label = toDisplayUnit(cVal).toFixed(0) + (state.unit === 'C' ? '°C' : '°F');
    ctx.fillText(label, 4, py + 3);
  }

  // --- X axis: "seconds ago", 300 -> 0 left to right ---
  const xSteps = [300, 225, 150, 75, 0];
  xSteps.forEach((secAgo) => {
    const frac = (HISTORY_LENGTH - secAgo) / HISTORY_LENGTH;
    const px = padding.left + plotW * frac;
    ctx.fillText(String(secAgo), px - 10, h - 8);
  });

  // --- Draw each sensor's trace ---
  const colors = { 1: '#5ad1c9', 2: '#f2a641' };

  Object.entries(state.sensors).forEach(([id, sensor]) => {
    const history = sensor.history;
    let drawingSegment = false;

    ctx.strokeStyle = colors[id];
    ctx.lineWidth = 2;

    history.forEach((point, i) => {
      const px = padding.left + (plotW * i) / (HISTORY_LENGTH - 1);

      if (point.status === 'missing') {
        // End any open line segment; render a visible gap marker instead.
        if (drawingSegment) { ctx.stroke(); drawingSegment = false; }
        ctx.save();
        ctx.strokeStyle = '#54595b';
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(px, padding.top);
        ctx.lineTo(px, padding.top + plotH);
        ctx.stroke();
        ctx.restore();
        return;
      }

      const py = yToPixel(point.value);

      if (point.status === 'offscale') {
        // Draw the clamped point but mark it distinctly so it doesn't look
        // like a normal in-range reading.
        if (drawingSegment) { ctx.stroke(); drawingSegment = false; }
        ctx.save();
        ctx.fillStyle = '#e2584f';
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        return;
      }

      if (!drawingSegment) {
        ctx.beginPath();
        ctx.moveTo(px, py);
        drawingSegment = true;
      } else {
        ctx.lineTo(px, py);
      }
    });

    if (drawingSegment) ctx.stroke();
  });
}

// Initial paint
render();
