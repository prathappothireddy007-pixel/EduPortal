const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    let r;
    if (req.user.role === 'faculty') {
      r = await pool.query(
        'SELECT * FROM grades ORDER BY date DESC'
      );
    } else {
      r = await pool.query(
        'SELECT * FROM grades WHERE student_id=$1 ORDER BY date DESC', [req.user.id]
      );
    }
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/', authenticate, requireFaculty, async (req, res) => {
  const { studentId, studentName, subjectId, subjectName, week, score } = req.body;
  if (!studentId || !subjectId || !week || !score)
    return res.status(400).json({ error: 'Missing fields' });
  try {
    // Upsert: update if week+student+subject combo exists
    const exists = await pool.query(
      'SELECT id FROM grades WHERE student_id=$1 AND subject_id=$2 AND week=$3',
      [studentId, subjectId, week]
    );
    let r;
    if (exists.rows.length > 0) {
      r = await pool.query(
        'UPDATE grades SET score=$1,date=NOW() WHERE id=$2 RETURNING *',
        [score, exists.rows[0].id]
      );
    } else {
      r = await pool.query(
        `INSERT INTO grades (student_id,student_name,subject_id,subject_name,week,score)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [studentId, studentName, subjectId, subjectName, week, score]
      );
    }
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
