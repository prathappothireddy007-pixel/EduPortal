const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const QRCode = require('qrcode');
const { logAction, notify } = require('../services/audit');

// GET all events (with student registration flag)
router.get('/', authenticate, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.*,
        (SELECT COUNT(*) FROM event_registrations er WHERE er.event_id=e.id) as reg_count
      FROM events e
      WHERE e.deleted_at IS NULL
      ORDER BY e.event_date DESC
    `);
    if (req.user.role === 'student') {
      const regs = await pool.query(
        'SELECT event_id FROM event_registrations WHERE student_id=$1', [req.user.id]
      );
      const regSet = new Set(regs.rows.map(r => r.event_id));
      return res.json(r.rows.map(e => ({ ...e, is_registered: regSet.has(e.id) })));
    }
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST create event (faculty)
router.post('/', authenticate, requireFaculty, async (req, res) => {
  const { title, description, eventDate, venue, hostInstitution, lat, lng,
          radiusMeters, startTime, endTime, eventType } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  try {
    // Generate QR token for this event
    const qrToken = `EVT-${Date.now()}-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
    const qrExpires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000); // 1 year

    const r = await pool.query(
      `INSERT INTO events (title,description,event_date,venue,host_institution,lat,lng,
         radius_meters,start_time,end_time,event_type,qr_token,qr_expires_at,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [title, description, eventDate, venue, hostInstitution || null,
       lat || null, lng || null, radiusMeters || 200,
       startTime || null, endTime || null, eventType || 'general',
       qrToken, qrExpires, req.user.id]
    );
    await logAction(req.user.id, req.user.name, 'faculty', 'create_event', 'events', r.rows[0].id, null, { title });
    res.status(201).json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// PUT update event (faculty)
router.put('/:id', authenticate, requireFaculty, async (req, res) => {
  const { title, description, eventDate, venue, hostInstitution, lat, lng,
          radiusMeters, startTime, endTime, eventType, eventStatus } = req.body;
  try {
    const r = await pool.query(
      `UPDATE events SET title=COALESCE($1,title), description=COALESCE($2,description),
         event_date=COALESCE($3,event_date), venue=COALESCE($4,venue),
         host_institution=COALESCE($5,host_institution), lat=COALESCE($6,lat),
         lng=COALESCE($7,lng), radius_meters=COALESCE($8,radius_meters),
         start_time=COALESCE($9,start_time), end_time=COALESCE($10,end_time),
         event_type=COALESCE($11,event_type), event_status=COALESCE($12,event_status)
       WHERE id=$13 AND deleted_at IS NULL RETURNING *`,
      [title, description, eventDate, venue, hostInstitution, lat, lng,
       radiusMeters, startTime, endTime, eventType, eventStatus, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Event not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE event (soft delete)
router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    await pool.query('UPDATE events SET deleted_at=NOW() WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, req.user.name, 'faculty', 'delete_event', 'events', req.params.id);
    res.json({ message: 'Event deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST register for event (student)
router.post('/:id/register', authenticate, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only' });
  try {
    await pool.query(
      `INSERT INTO event_registrations (event_id,student_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Registered for event' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE unregister from event (student)
router.delete('/:id/register', authenticate, async (req, res) => {
  if (req.user.role !== 'student') return res.status(403).json({ error: 'Students only' });
  try {
    await pool.query(
      'DELETE FROM event_registrations WHERE event_id=$1 AND student_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Unregistered from event' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET registrations for an event (faculty)
router.get('/:id/registrations', authenticate, requireFaculty, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT er.*, u.name, u.email
       FROM event_registrations er JOIN users u ON er.student_id=u.id
       WHERE er.event_id=$1`, [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET QR code for an event (as data URL)
router.get('/:id/qr', authenticate, async (req, res) => {
  try {
    const r = await pool.query('SELECT qr_token, title, qr_expires_at FROM events WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Event not found' });
    const { qr_token, title, qr_expires_at } = r.rows[0];
    if (new Date() > new Date(qr_expires_at)) {
      return res.status(410).json({ error: 'QR code has expired' });
    }
    const qrDataUrl = await QRCode.toDataURL(
      JSON.stringify({ token: qr_token, eventId: req.params.id, title }),
      { errorCorrectionLevel: 'H', width: 300, margin: 2 }
    );
    res.json({ qrDataUrl, qrToken: qr_token, expiresAt: qr_expires_at });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// POST validate QR token
router.post('/validate-qr', authenticate, async (req, res) => {
  const { qrToken, eventId } = req.body;
  if (!qrToken || !eventId) return res.status(400).json({ error: 'qrToken and eventId required' });
  try {
    const r = await pool.query(
      `SELECT * FROM events WHERE id=$1 AND qr_token=$2 AND deleted_at IS NULL`,
      [eventId, qrToken]
    );
    if (!r.rows[0]) return res.status(404).json({ valid: false, error: 'Invalid QR code' });
    if (new Date() > new Date(r.rows[0].qr_expires_at)) {
      return res.status(410).json({ valid: false, error: 'QR code has expired' });
    }
    res.json({ valid: true, event: r.rows[0] });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
