require('dotenv').config();
const express = require('express');
const path = require('path');
const http = require('http');
const { WebSocketServer } = require('ws');
const twilio = require('twilio');
const { Resend } = require('resend');

const app = express();
app.use(express.json());

// Serve the static front-end (index.html, style.css, app.js)
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Notification clients. Keys live in environment variables (set locally in a
// gitignored .env file, and in Railway's Variables tab for production) --
// never commit real keys to the repo.
// ---------------------------------------------------------------------------

const twilioClient = (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN)
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

const resend = process.env.RESEND_API_KEY
  ? new Resend(process.env.RESEND_API_KEY)
  : null;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// DECISION: contacts are typed into one free-text field in the UI and routed
// by shape (looks like an email vs. looks like a phone number). If you'd
// rather collect a separate phone field and email field, split this out.
async function sendAlert(contact, message) {
  if (!contact) return;

  if (EMAIL_RE.test(contact)) {
    if (!resend) return console.warn('Resend not configured; skipping email alert');
    await resend.emails.send({
      from: process.env.ALERT_EMAIL_FROM || 'onboarding@resend.dev',
      to: contact,
      subject: 'Thermometer alert',
      text: message,
    });
  } else {
    if (!twilioClient) return console.warn('Twilio not configured; skipping SMS alert');
    await twilioClient.messages.create({
      from: process.env.TWILIO_FROM_NUMBER,
      to: contact,
      body: message,
    });
  }
}

// Alert settings currently live in memory only -- they reset if the server
// restarts. TODO: persist these somewhere (a small database, or even a JSON
// file) once you're past the prototype stage.
let alertSettings = { max: 45, min: 5, contact: '' };

app.post('/api/alerts', (req, res) => {
  const { max, min, contact } = req.body;
  alertSettings = { max, min, contact };
  console.log('Alert settings saved:', alertSettings);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// WebSocket layer: this is the low-latency path. The ESP32 connects here and
// pushes a reading roughly once/second; the server relays it to every
// connected browser immediately (no polling delay on either side). Commands
// (e.g. a software on/off toggle in the browser) flow the opposite direction
// over the same connection.
//
// Every client says who it is on connect via a "hello" message, since the
// server treats device connections and browser connections differently:
//   Device  -> Server:  { type: "hello", role: "device" }
//   Browser -> Server:  { type: "hello", role: "browser" }
// ---------------------------------------------------------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const deviceSockets = new Set();
const browserSockets = new Set();

function broadcast(sockets, payload) {
  const data = JSON.stringify(payload);
  for (const client of sockets) {
    if (client.readyState === client.OPEN) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.role = null;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed messages rather than crashing the connection
    }

    if (msg.type === 'hello' && (msg.role === 'device' || msg.role === 'browser')) {
      ws.role = msg.role;
      (msg.role === 'device' ? deviceSockets : browserSockets).add(ws);
      return;
    }

    // DECISION: status is reported by the device itself (it knows whether its
    // own sensor is plugged in / powered on). The alternative -- inferring
    // "unplugged" purely from the server never hearing from a device -- is
    // handled separately below via the missed-heartbeat timeout, since a
    // dropped Wi-Fi connection and an unplugged sensor are different failures
    // worth distinguishing if your rubric wants that.
    if (msg.type === 'reading' && ws.role === 'device') {
      const { sensorId, value, status } = msg;
      ws.lastSeen = Date.now();
      ws.lastSensorIds = ws.lastSensorIds || new Set();
      ws.lastSensorIds.add(sensorId);

      if (status === 'ok' && typeof value === 'number') {
        const { max, min, contact } = alertSettings;
        if (value > max || value < min) {
          sendAlert(contact, `Sensor ${sensorId} reading ${value}°C is outside ${min}–${max}°C`)
            .catch((err) => console.error('Failed to send alert:', err.message));
        }
      }

      broadcast(browserSockets, { type: 'reading', sensorId, value, status });
      return;
    }

    // A software toggle in the browser gets relayed straight to the device.
    // TODO: if you ever support more than one ESP32, this needs a device ID
    // so commands route to the right physical unit instead of broadcasting
    // to all connected devices.
    if (msg.type === 'command' && ws.role === 'browser') {
      broadcast(deviceSockets, msg);
    }
  });

  ws.on('close', () => {
    deviceSockets.delete(ws);
    browserSockets.delete(ws);
  });
});

// If a device stops sending readings without cleanly closing the socket (e.g.
// it loses Wi-Fi), readyState can stay OPEN indefinitely. This tells
// connected browsers "missing" for that device's sensors once it's been
// quiet too long, instead of freezing on the last good value forever.
// DECISION: 3000ms assumes the device reports roughly once/second -- tune
// this if your device's reporting interval changes.
const STALE_MS = 3000;
setInterval(() => {
  const now = Date.now();
  for (const ws of deviceSockets) {
    if (ws.lastSeen && now - ws.lastSeen > STALE_MS && ws.lastSensorIds) {
      for (const sensorId of ws.lastSensorIds) {
        broadcast(browserSockets, { type: 'reading', sensorId, value: null, status: 'missing' });
      }
    }
  }
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
