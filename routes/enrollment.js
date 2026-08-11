const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty, requireStudent } = require('../middleware/auth');
const { notify, logAction } = require('../services/audit');

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
         WHERE er.student_id=$1 ORDER BY er.created_at DESC`,
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
    await pool.query(
      "DELETE FROM enrollment_requests WHERE student_id=$1 AND status='pending'",
      [req.user.id]
    );
    const r = await pool.query(
      'INSERT INTO enrollment_requests (student_id,class_id) VALUES ($1,$2) RETURNING *',
      [req.user.id, classId]
    );
    // Notify faculty
    const faculty = await pool.query(`SELECT id FROM users WHERE role='faculty' LIMIT 1`);
    if (faculty.rows[0]) {
      await notify(faculty.rows[0].id, 'enrollment_request', 'New Enrollment Request',
        `${req.user.name} requested enrollment in a class`, r.rows[0].id);
    }
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
    const enr = r.rows[0];
    if (enr) {
      await pool.query('UPDATE users SET class_id=$1 WHERE id=$2', [enr.class_id, enr.student_id]);
      await notify(enr.student_id, 'enrollment_approved', 'Enrollment Approved',
        'Your class enrollment request has been approved!', enr.id);
      await logAction(req.user.id, req.user.name, 'faculty', 'approve_enrollment', 'enrollment_requests', enr.id);
    }
    res.json(enr);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PUT reject (faculty)
router.put('/:id/reject', authenticate, requireFaculty, async (req, res) => {
  try {
    const r = await pool.query(
      "UPDATE enrollment_requests SET status='rejected' WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    const enr = r.rows[0];
    if (enr) {
      await notify(enr.student_id, 'enrollment_rejected', 'Enrollment Rejected',
        'Your class enrollment request was rejected.', enr.id);
    }
    res.json(enr);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
