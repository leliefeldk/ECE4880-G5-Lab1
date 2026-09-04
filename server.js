const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

// Serve the static front-end (index.html, style.css, app.js)
app.use(express.static(path.join(__dirname, 'public')));

// TODO: this is where the alert form's fetch() call will land once you wire
// it up in app.js. See the SMS/email setup step for the actual notification
// logic that goes inside this route.
app.post('/api/alerts', (req, res) => {
  const { max, min, contact } = req.body;
  console.log('Alert settings received:', { max, min, contact });
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
