require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { initDB } = require('./db');
const { startODExpiryJob } = require('./services/cron');

const app = express();

// ── Security middleware ──────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ────────────────────────────────────────────────────────────
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { error: 'Too many login attempts. Try again later.' }
}));

// ── API Routes — Existing ────────────────────────────────────────────────────
app.use('/api/auth',       require('./routes/auth'));
app.use('/api/students',   require('./routes/students'));
app.use('/api/classes',    require('./routes/classes'));
app.use('/api/subjects',   require('./routes/subjects'));
app.use('/api/grades',     require('./routes/grades'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/od',         require('./routes/od'));
app.use('/api/events',     require('./routes/events'));
app.use('/api/enrollment', require('./routes/enrollment'));
app.use('/api/reports',    require('./routes/reports'));

// ── API Routes — New Modules ─────────────────────────────────────────────────
app.use('/api/classrooms',    require('./routes/classrooms'));
app.use('/api/timetable',     require('./routes/timetable'));
app.use('/api/academic',      require('./routes/academic'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/issues',        require('./routes/issues'));
app.use('/api/documents',     require('./routes/documents'));
app.use('/api/achievements',  require('./routes/achievements'));
app.use('/api/resources',     require('./routes/resources'));
app.use('/api/certificates',  require('./routes/certificates'));
app.use('/api/audit',         require('./routes/audit'));
app.use('/api/settings',      require('./routes/settings'));
app.use('/api/recovery',      require('./routes/recovery'));
app.use('/api/announcements', require('./routes/announcements'));

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => res.json({
  status: 'OK',
  version: '3.0.0',
  time: new Date().toISOString(),
  env: process.env.NODE_ENV
}));

// ── Serve frontend ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDB();
    startODExpiryJob();
    app.listen(PORT, () => {
      console.log(`🚀 EduPortal v3.0 running on port ${PORT}`);
      console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
})();
