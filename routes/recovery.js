const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { logAction } = require('../services/audit');

// GET /deleted - faculty only. Return soft-deleted students, classes, and events.
router.get('/deleted', authenticate, requireFaculty, async (req, res) => {
  try {
    const [studentsResult, classesResult, eventsResult] = await Promise.all([
      pool.query(
        `SELECT u.id, u.name, u.email, u.role, s.deleted_at
         FROM students s
         LEFT JOIN users u ON s.user_id = u.id
         WHERE s.deleted_at IS NOT NULL
         ORDER BY s.deleted_at DESC`
      ),
      pool.query(
        `SELECT * FROM classes
         WHERE deleted_at IS NOT NULL
         ORDER BY deleted_at DESC`
      ),
      pool.query(
        `SELECT * FROM events
         WHERE deleted_at IS NOT NULL
         ORDER BY deleted_at DESC`
      ),
    ]);

    res.json({
      students: studentsResult.rows,
      classes: classesResult.rows,
      events: eventsResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /recover/students/:id - recover a soft-deleted student
router.put('/recover/students/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query(
      'SELECT * FROM students WHERE user_id = $1 AND deleted_at IS NOT NULL',
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Deleted student not found' });
    }

    await pool.query('UPDATE students SET deleted_at = NULL WHERE user_id = $1', [id]);

    await logAction(req.user.id, 'RECOVER', 'student', id, {});
    res.json({ message: 'Student recovered successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /recover/classes/:id - recover a soft-deleted class
router.put('/recover/classes/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query(
      'SELECT * FROM classes WHERE id = $1 AND deleted_at IS NOT NULL',
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Deleted class not found' });
    }

    await pool.query('UPDATE classes SET deleted_at = NULL WHERE id = $1', [id]);

    await logAction(req.user.id, 'RECOVER', 'class', id, {});
    res.json({ message: 'Class recovered successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /recover/events/:id - recover a soft-deleted event
router.put('/recover/events/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query(
      'SELECT * FROM events WHERE id = $1 AND deleted_at IS NOT NULL',
      [id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Deleted event not found' });
    }

    await pool.query('UPDATE events SET deleted_at = NULL WHERE id = $1', [id]);

    await logAction(req.user.id, 'RECOVER', 'event', id, {});
    res.json({ message: 'Event recovered successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
