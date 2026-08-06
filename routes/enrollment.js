const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty, requireStudent } = require('../middleware/auth');

// GET enrollment requests
router.get('/', authenticate, async (req, res) => {
  try {
    let r;
    if (req.user.role === 'faculty') {
      r = await pool.query(
        `SELECT er.*, u.name as student_name, u.email as student_email, c.name as class_name
         FROM enrollment_requests er
         JOIN users u ON er.student_id=u.id
         JOIN classes c ON er.class_id=c.id
         ORDER BY er.created_at DESC`
      );
    } else {
      r = await pool.query(
        `SELECT er.*, c.name as class_name
         FROM enrollment_requests er
         JOIN classes c ON er.class_id=c.id
         WHERE er.student_id=$1
         ORDER BY er.created_at DESC`,
        [req.user.id]
      );
    }
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST create request (student)
router.post('/', authenticate, requireStudent, async (req, res) => {
  const { classId } = req.body;
  if (!classId) return res.status(400).json({ error: 'classId required' });
  try {
    // Cancel previous pending requests
    await pool.query(
      "DELETE FROM enrollment_requests WHERE student_id=$1 AND status='pending'",
      [req.user.id]
    );
    const r = await pool.query(
      'INSERT INTO enrollment_requests (student_id,class_id) VALUES ($1,$2) RETURNING *',
      [req.user.id, classId]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PUT approve (faculty)
router.put('/:id/approve', authenticate, requireFaculty, async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE enrollment_requests SET status='approved' WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    const req2 = r.rows[0];
    if (req2) {
      await pool.query('UPDATE users SET class_id=$1 WHERE id=$2', [req2.class_id, req2.student_id]);
    }
    res.json(req2);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PUT reject (faculty)
router.put('/:id/reject', authenticate, requireFaculty, async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE enrollment_requests SET status='rejected' WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
