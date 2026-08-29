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
    console.error('[Notifications GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Mark all as read handler (Supports PUT & POST across all common paths)
const handleMarkAllRead = async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE notifications
       SET is_read = TRUE
       WHERE user_id = $1 AND (is_read = FALSE OR is_read IS NULL)`,
      [req.user.id]
    );

    res.json({ message: 'All notifications marked as read', updated: result.rowCount });
  } catch (err) {
    console.error('[Notifications Mark All Read] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

router.put('/read-all/all', authenticate, handleMarkAllRead);
router.put('/read-all', authenticate, handleMarkAllRead);
router.post('/read-all', authenticate, handleMarkAllRead);
router.put('/mark-all-read', authenticate, handleMarkAllRead);
router.post('/mark-all-read', authenticate, handleMarkAllRead);

// Mark single notification as read handler
const handleMarkSingleRead = async (req, res) => {
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
      'UPDATE notifications SET is_read = TRUE WHERE id = $1 RETURNING *',
      [id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Notification Mark Single Read] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
};

router.put('/:id/read', authenticate, handleMarkSingleRead);
router.post('/:id/read', authenticate, handleMarkSingleRead);

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
    console.error('[Notification DELETE] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
