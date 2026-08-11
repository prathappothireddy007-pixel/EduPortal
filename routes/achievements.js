const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { logAction, notify } = require('../services/audit');

// GET / - list achievements; ?student_id= filter
router.get('/', authenticate, async (req, res) => {
  try {
    const { student_id } = req.query;
    const isFaculty = req.user.role === 'faculty';
    const params = [];
    let idx = 1;
    let whereClause = 'WHERE 1=1';

    if (!isFaculty) {
      // Students see only their own
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
       ORDER BY a.ach_date DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / - student adds achievement
router.post('/', authenticate, async (req, res) => {
  try {
    const { title, category, org, achDate, certB64 } = req.body;

    if (!title || !category) {
      return res.status(400).json({ error: 'title and category are required' });
    }

    const result = await pool.query(
      `INSERT INTO achievements (student_id, title, category, org, ach_date, cert_data, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, false)
       RETURNING *`,
      [req.user.id, title, category, org, achDate, certB64]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /:id/verify - faculty verifies achievement
router.put('/:id/verify', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query('SELECT * FROM achievements WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Achievement not found' });
    }

    const result = await pool.query(
      `UPDATE achievements
       SET is_verified = true, verified_by = $1, verified_at = NOW(), updated_at = NOW()
       WHERE id = $2
       RETURNING *`,
      [req.user.id, id]
    );

    const achievement = result.rows[0];
    await logAction(req.user.id, 'VERIFY', 'achievement', id, {});

    // Notify student
    await notify(
      achievement.student_id,
      'Achievement Verified',
      `Your achievement "${achievement.title}" has been verified!`,
      'achievement'
    );

    res.json(achievement);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id - student deletes own unverified; faculty can delete any
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const isFaculty = req.user.role === 'faculty';

    const existing = await pool.query('SELECT * FROM achievements WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Achievement not found' });
    }

    const achievement = existing.rows[0];

    if (!isFaculty) {
      if (achievement.student_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (achievement.is_verified) {
        return res.status(403).json({ error: 'Cannot delete a verified achievement' });
      }
    }

    await pool.query('DELETE FROM achievements WHERE id = $1', [id]);
    await logAction(req.user.id, 'DELETE', 'achievement', id, {});
    res.json({ message: 'Achievement deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
