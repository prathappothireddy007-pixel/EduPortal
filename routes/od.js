const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty, requireStudent } = require('../middleware/auth');

// GET OD requests
router.get('/', authenticate, async (req, res) => {
  try {
    let r;
    if (req.user.role === 'faculty') {
      r = await pool.query(
        'SELECT * FROM od_requests ORDER BY created_at DESC'
      );
    } else {
      r = await pool.query(
        'SELECT * FROM od_requests WHERE student_id=$1 ORDER BY created_at DESC',
        [req.user.id]
      );
    }
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST submit OD request (student)
router.post('/', authenticate, requireStudent, async (req, res) => {
  const { eventId, eventName, letterB64 } = req.body;
  if (!letterB64) return res.status(400).json({ error: 'Letter photo required' });
  try {
    // Check no pending/approved OD for today
    const today = new Date().toISOString().split('T')[0];
    const existing = await pool.query(
      `SELECT id FROM od_requests
       WHERE student_id=$1 AND date=$2 AND status IN ('pending','approved')`,
      [req.user.id, today]
    );
    if (existing.rows.length > 0)
      return res.status(400).json({ error: 'OD request already submitted for today' });

    const r = await pool.query(
      `INSERT INTO od_requests (student_id,student_name,event_id,event_name,letter_b64,date)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [req.user.id, req.user.name, eventId || null, eventName || 'Other', letterB64, today]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// PUT approve OD (faculty)
router.put('/:id/approve', authenticate, requireFaculty, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE od_requests SET status='approved', approved_at=NOW()
       WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Not found' });

    const od = r.rows[0];
    // Mark attendance as OD
    await pool.query(
      `INSERT INTO attendance (student_id,student_name,status,date,od_request_id)
       VALUES ($1,$2,'OD',$3,$4)
       ON CONFLICT (student_id,date) DO UPDATE SET status='OD', od_request_id=$4`,
      [od.student_id, od.student_name, od.date, od.id]
    );

    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PUT reject OD (faculty)
router.put('/:id/reject', authenticate, requireFaculty, async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE od_requests SET status='rejected' WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST submit geo photo (student) - must be within 30 min of approval
router.post('/:id/geo-photo', authenticate, requireStudent, async (req, res) => {
  const { geoB64, lat, lng } = req.body;
  if (!geoB64 || lat == null || lng == null)
    return res.status(400).json({ error: 'Geo photo, lat and lng required' });

  try {
    const r = await pool.query(
      'SELECT * FROM od_requests WHERE id=$1 AND student_id=$2',
      [req.params.id, req.user.id]
    );
    const od = r.rows[0];
    if (!od) return res.status(404).json({ error: 'OD request not found' });
    if (od.status !== 'approved')
      return res.status(400).json({ error: 'OD is not in approved state' });

    // Check 30-minute window
    const approvedAt = new Date(od.approved_at);
    const now = new Date();
    const diffMs = now - approvedAt;
    if (diffMs > 30 * 60 * 1000) {
      // Expired — mark absent
      await pool.query(
        "UPDATE od_requests SET status='expired' WHERE id=$1", [od.id]
      );
      await pool.query(
        `INSERT INTO attendance (student_id,student_name,status,date)
         VALUES ($1,$2,'Absent',$3)
         ON CONFLICT (student_id,date) DO UPDATE SET status='Absent'`,
        [od.student_id, od.student_name, od.date]
      );
      return res.status(400).json({
        error: 'Time window expired (30 minutes). Marked as Absent.'
      });
    }

    // Save geo photo and complete
    const updated = await pool.query(
      `UPDATE od_requests
       SET geo_b64=$1, geo_lat=$2, geo_lng=$3, status='completed'
       WHERE id=$4 RETURNING *`,
      [geoB64, lat, lng, od.id]
    );
    res.json(updated.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
