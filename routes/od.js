const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty, requireStudent } = require('../middleware/auth');
const { haversineDistance } = require('../services/timetable');
const { logAction, notify } = require('../services/audit');

// GET OD requests
router.get('/', authenticate, async (req, res) => {
  try {
    let r;
    if (req.user.role === 'faculty') {
      r = await pool.query(`
        SELECT o.*, e.lat as event_lat, e.lng as event_lng,
               e.radius_meters, e.start_time as event_start, e.end_time as event_end
        FROM od_requests o
        LEFT JOIN events e ON o.event_id = e.id
        ORDER BY o.created_at DESC
      `);
    } else {
      r = await pool.query(`
        SELECT o.*, e.lat as event_lat, e.lng as event_lng,
               e.radius_meters, e.start_time as event_start, e.end_time as event_end,
               e.event_type, e.host_institution, e.venue
        FROM od_requests o
        LEFT JOIN events e ON o.event_id = e.id
        WHERE o.student_id=$1 ORDER BY o.created_at DESC
      `, [req.user.id]);
    }
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST submit OD request (student)
router.post('/', authenticate, requireStudent, async (req, res) => {
  const { eventId, eventName, letterB64 } = req.body;
  if (!letterB64) return res.status(400).json({ error: 'Letter photo required' });
  try {
    const today = new Date().toISOString().split('T')[0];
    // Verify student is registered for the event
    if (eventId) {
      const regCheck = await pool.query(
        `SELECT id FROM event_registrations WHERE event_id=$1 AND student_id=$2`,
        [eventId, req.user.id]
      );
      if (regCheck.rows.length === 0) {
        return res.status(400).json({ error: 'You must register for the event before submitting an OD request' });
      }
    }
    const existing = await pool.query(
      `SELECT id FROM od_requests WHERE student_id=$1 AND date=$2
       AND status IN ('pending','approved','geo_submitted','completed','checked_in','checked_out')`,
      [req.user.id, today]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'OD request already submitted for today' });
    }
    const r = await pool.query(
      `INSERT INTO od_requests (student_id,student_name,event_id,event_name,letter_b64,date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, req.user.name, eventId || null, eventName || 'Other', letterB64, today]
    );
    // Notify faculty
    const faculty = await pool.query(`SELECT id FROM users WHERE role='faculty' LIMIT 1`);
    if (faculty.rows[0]) {
      await notify(faculty.rows[0].id, 'od_request', 'New OD Request',
        `${req.user.name} submitted an OD request for ${eventName || 'Other'}`, r.rows[0].id);
    }
    res.status(201).json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// PUT approve OD (faculty)
router.put('/:id/approve', authenticate, requireFaculty, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE od_requests SET status='approved', approved_at=NOW()
       WHERE id=$1 RETURNING *`, [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });
    const od = r.rows[0];
    await pool.query(
      `INSERT INTO attendance (student_id,student_name,status,date,od_request_id)
       VALUES ($1,$2,'OD',$3,$4)
       ON CONFLICT (student_id,date) DO UPDATE SET status='OD', od_request_id=$4`,
      [od.student_id, od.student_name, od.date, od.id]
    );
    await notify(od.student_id, 'od_approved', 'OD Request Approved',
      `Your OD request for ${od.event_name} has been approved`, od.id);
    await logAction(req.user.id, req.user.name, 'faculty', 'approve_od', 'od_requests', od.id);
    res.json(od);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PUT reject OD (faculty)
router.put('/:id/reject', authenticate, requireFaculty, async (req, res) => {
  const { reason } = req.body;
  try {
    const r = await pool.query(
      `UPDATE od_requests SET status='rejected', rejection_reason=$1
       WHERE id=$2 RETURNING *`,
      [reason || 'Rejected by faculty', req.params.id]
    );
    const od = r.rows[0];
    if (od) {
      await pool.query(
        `INSERT INTO attendance (student_id,student_name,status,date)
         VALUES ($1,$2,'Absent',$3)
         ON CONFLICT (student_id,date) DO UPDATE SET status='Absent'`,
        [od.student_id, od.student_name, od.date]
      );
      await notify(od.student_id, 'od_rejected', 'OD Request Rejected',
        `Your OD request was rejected. Reason: ${reason || 'Not specified'}`, od.id);
      await logAction(req.user.id, req.user.name, 'faculty', 'reject_od', 'od_requests', od.id, null, { reason });
    }
    res.json(od);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST student submits geo-tagged photo with GPS validation
router.post('/:id/geo-photo', authenticate, requireStudent, async (req, res) => {
  const { geoB64, lat, lng } = req.body;
  if (!geoB64 || lat == null || lng == null)
    return res.status(400).json({ error: 'Geo photo, lat and lng required' });

  try {
    const r = await pool.query(`
      SELECT o.*, e.lat as event_lat, e.lng as event_lng, e.radius_meters,
             e.start_time, e.end_time, e.event_date
      FROM od_requests o
      LEFT JOIN events e ON o.event_id = e.id
      WHERE o.id=$1 AND o.student_id=$2
    `, [req.params.id, req.user.id]);

    const od = r.rows[0];
    if (!od) return res.status(404).json({ error: 'OD request not found' });
    if (od.status !== 'approved')
      return res.status(400).json({ error: 'OD must be in approved state to submit geo-photo' });

    let distanceMeters = null;
    let withinRadius = true;

    // GPS validation if event has location
    if (od.event_lat && od.event_lng) {
      distanceMeters = Math.round(haversineDistance(lat, lng, od.event_lat, od.event_lng));
      withinRadius = distanceMeters <= (od.radius_meters || 200);
    }

    const updated = await pool.query(
      `UPDATE od_requests
       SET geo_b64=$1, geo_lat=$2, geo_lng=$3, status='geo_submitted', distance_meters=$4
       WHERE id=$5 RETURNING *`,
      [geoB64, lat, lng, distanceMeters, od.id]
    );

    // Notify faculty
    const faculty = await pool.query(`SELECT id FROM users WHERE role='faculty' LIMIT 1`);
    if (faculty.rows[0]) {
      await notify(faculty.rows[0].id, 'geo_submitted', 'Geo-Photo Submitted',
        `${req.user.name} submitted geo-verification${distanceMeters !== null ? ` (${distanceMeters}m from event)` : ''}`, od.id);
    }

    res.json({ ...updated.rows[0], distanceMeters, withinRadius });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// PUT faculty verifies geo-photo
router.put('/:id/verify-geo', authenticate, requireFaculty, async (req, res) => {
  const { action, reason } = req.body;
  if (!['accept', 'reject'].includes(action))
    return res.status(400).json({ error: 'action must be accept or reject' });

  try {
    const odRes = await pool.query('SELECT * FROM od_requests WHERE id=$1', [req.params.id]);
    const od = odRes.rows[0];
    if (!od) return res.status(404).json({ error: 'OD request not found' });
    if (od.status !== 'geo_submitted')
      return res.status(400).json({ error: 'OD is not in geo_submitted state' });

    if (action === 'accept') {
      const r = await pool.query(
        "UPDATE od_requests SET status='completed' WHERE id=$1 RETURNING *", [od.id]
      );
      await notify(od.student_id, 'geo_verified', 'Geo-Verification Accepted',
        `Your geo-verification for ${od.event_name} was accepted`, od.id);
      await logAction(req.user.id, req.user.name, 'faculty', 'accept_geo', 'od_requests', od.id);
      res.json(r.rows[0]);
    } else {
      const r = await pool.query(
        "UPDATE od_requests SET status='geo_rejected', rejection_reason=$1 WHERE id=$2 RETURNING *",
        [reason || 'Geo-photo rejected by faculty', od.id]
      );
      await pool.query(
        `INSERT INTO attendance (student_id,student_name,status,date)
         VALUES ($1,$2,'Absent',$3)
         ON CONFLICT (student_id,date) DO UPDATE SET status='Absent'`,
        [od.student_id, od.student_name, od.date]
      );
      await notify(od.student_id, 'geo_rejected', 'Geo-Verification Rejected',
        `Your geo-verification was rejected. Reason: ${reason || 'Not specified'}`, od.id);
      await logAction(req.user.id, req.user.name, 'faculty', 'reject_geo', 'od_requests', od.id, null, { reason });
      res.json(r.rows[0]);
    }
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// POST check-in (student, after OD approved)
router.post('/:id/checkin', authenticate, requireStudent, async (req, res) => {
  const { lat, lng, photoB64 } = req.body;
  if (!lat || !lng) return res.status(400).json({ error: 'GPS coordinates required for check-in' });
  try {
    const r = await pool.query(`
      SELECT o.*, e.lat as event_lat, e.lng as event_lng, e.radius_meters,
             e.start_time, e.end_time
      FROM od_requests o
      LEFT JOIN events e ON o.event_id = e.id
      WHERE o.id=$1 AND o.student_id=$2
    `, [req.params.id, req.user.id]);

    const od = r.rows[0];
    if (!od) return res.status(404).json({ error: 'OD request not found' });
    if (!['approved', 'completed'].includes(od.status))
      return res.status(400).json({ error: 'OD must be approved before check-in' });
    if (od.checkin_time) return res.status(400).json({ error: 'Already checked in' });

    let distanceMeters = null;
    if (od.event_lat && od.event_lng) {
      distanceMeters = Math.round(haversineDistance(lat, lng, od.event_lat, od.event_lng));
      if (distanceMeters > (od.radius_meters || 200)) {
        return res.status(400).json({
          error: `You are ${distanceMeters}m from the event location. Must be within ${od.radius_meters || 200}m to check in.`,
          distanceMeters
        });
      }
    }

    const updated = await pool.query(
      `UPDATE od_requests SET checkin_time=NOW(), checkin_lat=$1, checkin_lng=$2,
         checkin_b64=$3, status='checked_in'
       WHERE id=$4 RETURNING *`,
      [lat, lng, photoB64 || null, od.id]
    );
    res.json({ ...updated.rows[0], distanceMeters });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// POST check-out (student)
router.post('/:id/checkout', authenticate, requireStudent, async (req, res) => {
  const { lat, lng, photoB64 } = req.body;
  try {
    const r = await pool.query(
      'SELECT * FROM od_requests WHERE id=$1 AND student_id=$2', [req.params.id, req.user.id]
    );
    const od = r.rows[0];
    if (!od) return res.status(404).json({ error: 'OD request not found' });
    if (od.status !== 'checked_in') return res.status(400).json({ error: 'Must check in before checking out' });
    if (od.checkout_time) return res.status(400).json({ error: 'Already checked out' });

    const now = new Date();
    const checkinTime = new Date(od.checkin_time);
    const durationMinutes = Math.round((now - checkinTime) / 60000);

    const updated = await pool.query(
      `UPDATE od_requests SET checkout_time=NOW(), checkout_lat=$1, checkout_lng=$2,
         checkout_b64=$3, status='checked_out'
       WHERE id=$4 RETURNING *`,
      [lat || null, lng || null, photoB64 || null, od.id]
    );
    res.json({ ...updated.rows[0], durationMinutes });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
