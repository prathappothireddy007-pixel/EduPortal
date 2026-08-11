const router = require('express').Router();
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');

// GET / - get notifications for current user (most recent 50)
router.get('/', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 50`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /read-all/all - mark all notifications as read for current user
// NOTE: This route must be defined BEFORE /:id/read to avoid route shadowing
router.put('/read-all/all', authenticate, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE notifications
       SET is_read = true, read_at = NOW()
       WHERE user_id = $1 AND is_read = false`,
      [req.user.id]
    );

    res.json({ message: 'All notifications marked as read', updated: result.rowCount });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /:id/read - mark a notification as read
router.put('/:id/read', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query(
      'SELECT * FROM notifications WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    const result = await pool.query(
      'UPDATE notifications SET is_read = true, read_at = NOW() WHERE id = $1 RETURNING *',
      [id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id - delete a notification (own only)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query(
      'SELECT * FROM notifications WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found or not authorized' });
    }

    await pool.query('DELETE FROM notifications WHERE id = $1', [id]);
    res.json({ message: 'Notification deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
