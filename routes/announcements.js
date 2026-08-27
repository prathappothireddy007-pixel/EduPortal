const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { notify, logAction } = require('../services/audit');

// GET / - List announcements matching the user's role or department
router.get('/', authenticate, async (req, res) => {
  try {
    const userRole = req.user.role;
    const userDept = req.user.department || '';

    let whereClause = `WHERE (a.target_audience = 'ALL'`;
    const params = [];
    let idx = 1;

    if (userRole === 'admin') {
      whereClause = 'WHERE 1=1'; // Admin sees all
    } else if (userRole === 'faculty') {
      whereClause += ` OR a.target_audience = 'faculty' OR a.target_audience = 'ALL'`;
      if (userDept) {
        whereClause += ` OR a.target_audience = $${idx++}`;
        params.push(userDept);
      }
      whereClause += ')';
    } else { // Student
      whereClause += ` OR a.target_audience = 'student' OR a.target_audience = 'ALL'`;
      if (userDept) {
        whereClause += ` OR a.target_audience = $${idx++}`;
        params.push(userDept);
      }
      whereClause += ')';
    }

    const r = await pool.query(
      `SELECT a.*, COALESCE(u.name, a.created_by_name, 'Administration') as author_name
       FROM announcements a
       LEFT JOIN users u ON a.created_by = u.id
       ${whereClause}
       ORDER BY a.is_pinned DESC, a.created_at DESC`,
      params
    );

    res.json(r.rows);
  } catch (err) {
    console.error('[Announcements GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / - Admin creates and broadcasts an announcement
router.post('/', authenticate, requireAdmin, async (req, res) => {
  const { title, content, targetAudience, priority, isPinned, pdfB64, pdfName } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content are required' });

  try {
    const audience = targetAudience || 'ALL';
    const prio = priority || 'info';
    const pinned = Boolean(isPinned);

    const r = await pool.query(
      `INSERT INTO announcements (title, content, target_audience, priority, created_by, created_by_name, is_pinned, pdf_b64, pdf_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [title.trim(), content.trim(), audience, prio, req.user.id, req.user.name, pinned, pdfB64 || null, pdfName || null]
    );

    const newAnnouncement = r.rows[0];

    // Broadcast notification to targeted users
    let userQuery = "SELECT id FROM users WHERE deleted_at IS NULL";
    const userParams = [];
    if (audience === 'faculty') {
      userQuery += " AND role='faculty'";
    } else if (audience === 'student') {
      userQuery += " AND role='student'";
    } else if (audience !== 'ALL') {
      userQuery += " AND department=$1";
      userParams.push(audience);
    }

    const recipients = await pool.query(userQuery, userParams);
    for (const u of recipients.rows) {
      if (u.id !== req.user.id) {
        await notify(
          u.id,
          'announcement',
          `📢 Campus Announcement: ${title}`,
          content.slice(0, 120) + (content.length > 120 ? '...' : ''),
          newAnnouncement.id
        );
      }
    }

    await logAction(req.user.id, req.user.name, 'admin', 'create_announcement', 'announcements', newAnnouncement.id, null, { title, audience });
    res.status(201).json(newAnnouncement);
  } catch (err) {
    console.error('[Announcements POST] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /:id/pin - Toggle pinned announcement
router.put('/:id/pin', authenticate, requireAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      `UPDATE announcements SET is_pinned = NOT is_pinned WHERE id = $1 RETURNING *`,
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Announcement not found' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id - Delete announcement
router.delete('/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    await pool.query('DELETE FROM announcements WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, req.user.name, 'admin', 'delete_announcement', 'announcements', req.params.id);
    res.json({ message: 'Announcement deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
