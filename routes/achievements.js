const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { logAction, notify } = require('../services/audit');

// GET / - list achievements; ?student_id= filter
router.get('/', authenticate, async (req, res) => {
  try {
    const { student_id } = req.query;
    const isStaff = req.user.role === 'faculty' || req.user.role === 'admin';
    const params = [];
    let idx = 1;
    let whereClause = 'WHERE 1=1';

    if (!isStaff) {
      whereClause += ` AND a.student_id = $${idx++}`;
      params.push(req.user.id);
    } else if (student_id) {
      whereClause += ` AND a.student_id = $${idx++}`;
      params.push(student_id);
    }

    const result = await pool.query(
      `SELECT a.*, u.name AS student_name, v.name AS verified_by_name
       FROM achievements a
       LEFT JOIN users u ON a.student_id = u.id
       LEFT JOIN users v ON a.verified_by = v.id
       ${whereClause}
       ORDER BY a.created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[Achievements GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / - add achievement
router.post('/', authenticate, async (req, res) => {
  try {
    const { title, category, org, achDate, certB64 } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    const result = await pool.query(
      `INSERT INTO achievements (student_id, title, category, org, ach_date, cert_b64, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       RETURNING *`,
      [req.user.id, title, category || 'Extracurricular', org || '', achDate || null, certB64 || '']
    );

    await logAction(req.user.id, req.user.name, req.user.role, 'create_achievement', 'achievements', result.rows[0].id);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Achievements POST] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /:id/verify - faculty verifies achievement
router.put('/:id/verify', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `UPDATE achievements
       SET is_verified = true, verified_by = $1
       WHERE id = $2
       RETURNING *`,
      [req.user.id, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Achievement not found' });
    }

    const ach = result.rows[0];
    await notify(ach.student_id, 'achievement_verified', 'Achievement Verified 🏆', `Your achievement "${ach.title}" was verified!`, ach.id);
    await logAction(req.user.id, req.user.name, 'faculty', 'verify_achievement', 'achievements', id);
    res.json(ach);
  } catch (err) {
    console.error('[Achievement Verify] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const isFaculty = req.user.role === 'faculty';

    const achResult = await pool.query('SELECT * FROM achievements WHERE id = $1', [id]);
    if (achResult.rows.length === 0) {
      return res.status(404).json({ error: 'Achievement not found' });
    }

    const ach = achResult.rows[0];
    if (!isFaculty && ach.student_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await pool.query('DELETE FROM achievements WHERE id = $1', [id]);
    res.json({ message: 'Achievement deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
