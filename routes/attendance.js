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

// POST mark attendance (faculty: Present/Absent/OD)
router.post('/', authenticate, requireFaculty, async (req, res) => {
  const { studentId, studentName, status, date } = req.body;
  if (!studentId || !status || !date)
    return res.status(400).json({ error: 'Missing fields' });
  try {
    const r = await pool.query(
      `INSERT INTO attendance (student_id,student_name,status,date)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (student_id,date)
       DO UPDATE SET status=$3
       RETURNING *`,
      [studentId, studentName, status, date]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
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
