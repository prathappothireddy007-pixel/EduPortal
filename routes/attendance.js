const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');

// GET attendance
router.get('/', authenticate, async (req, res) => {
  try {
    let r;
    if (req.user.role === 'faculty') {
      r = await pool.query('SELECT * FROM attendance ORDER BY date DESC, student_name');
    } else {
      r = await pool.query(
        'SELECT * FROM attendance WHERE student_id=$1 ORDER BY date DESC',
        [req.user.id]
      );
    }
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST mark attendance (faculty)
// KEY LOGIC: If marking OD but student has NO valid approved OD for today → auto-mark Absent
router.post('/', authenticate, requireFaculty, async (req, res) => {
  const { studentId, studentName, status, date } = req.body;
  if (!studentId || !status || !date)
    return res.status(400).json({ error: 'Missing fields' });

  try {
    let actualStatus = status;
    let autoAbsent = false;

    if (status === 'OD') {
      // Check if student has a valid approved/submitted/completed OD for this date
      const odCheck = await pool.query(
        `SELECT id FROM od_requests
         WHERE student_id=$1 AND date=$2
           AND status IN ('approved','geo_submitted','completed')`,
        [studentId, date]
      );

      if (odCheck.rows.length === 0) {
        // No valid OD — auto-mark Absent
        actualStatus = 'Absent';
        autoAbsent = true;
      }
    }

    const r = await pool.query(
      `INSERT INTO attendance (student_id,student_name,status,date)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (student_id,date)
       DO UPDATE SET status=$3
       RETURNING *`,
      [studentId, studentName, actualStatus, date]
    );

    // Trigger the 30-minute verification countdown on approved OD request
    await pool.query(
      `UPDATE od_requests
       SET attendance_marked_at = NOW(),
           geo_deadline = NOW() + INTERVAL '30 minutes'
       WHERE student_id = $1 AND date = $2 AND status = 'approved' AND attendance_marked_at IS NULL`,
      [studentId, date]
    );

    res.json({ ...r.rows[0], autoAbsent });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// GET today's stats
router.get('/stats', authenticate, requireFaculty, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const r = await pool.query(
      `SELECT status, COUNT(*) as count
       FROM attendance WHERE date=$1 GROUP BY status`, [today]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
