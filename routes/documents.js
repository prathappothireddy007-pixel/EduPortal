const router = require('express').Router();
const { pool } = require('../db');
const { authenticate } = require('../middleware/auth');
const { logAction } = require('../services/audit');

// GET / - student gets own docs; faculty gets all (can filter by owner_id). Support ?category=
router.get('/', authenticate, async (req, res) => {
  try {
    const { category, owner_id } = req.query;
    const isFaculty = req.user.role === 'faculty';
    const params = [];
    let idx = 1;
    let whereClause = 'WHERE 1=1';

    if (!isFaculty) {
      whereClause += ` AND d.owner_id = $${idx++}`;
      params.push(req.user.id);
    } else if (owner_id) {
      whereClause += ` AND d.owner_id = $${idx++}`;
      params.push(owner_id);
    }

    if (category) {
      whereClause += ` AND d.category = $${idx++}`;
      params.push(category);
    }

    const result = await pool.query(
      `SELECT d.*, u.name AS owner_name
       FROM documents d
       LEFT JOIN users u ON d.owner_id = u.id
       ${whereClause}
       ORDER BY d.created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / - upload document (both roles)
router.post('/', authenticate, async (req, res) => {
  try {
    const isFaculty = req.user.role === 'faculty';
    let { ownerId, category, title, filename, fileB64 } = req.body;

    if (!category || !title || !filename) {
      return res.status(400).json({ error: 'category, title, and filename are required' });
    }

    // Students can only upload for themselves
    if (!isFaculty) {
      ownerId = req.user.id;
    } else {
      ownerId = ownerId || req.user.id;
    }

    const result = await pool.query(
      `INSERT INTO documents (owner_id, category, title, filename, file_data, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [ownerId, category, title, filename, fileB64, req.user.id]
    );

    await logAction(req.user.id, 'UPLOAD', 'document', result.rows[0].id, { category, title, filename, ownerId });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /:id - get single document
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const isFaculty = req.user.role === 'faculty';

    const result = await pool.query(
      `SELECT d.*, u.name AS owner_name
       FROM documents d
       LEFT JOIN users u ON d.owner_id = u.id
       WHERE d.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = result.rows[0];

    if (!isFaculty && doc.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(doc);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /:id/archive - toggle is_archived
router.put('/:id/archive', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const isFaculty = req.user.role === 'faculty';

    const existing = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = existing.rows[0];

    if (!isFaculty && doc.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(
      'UPDATE documents SET is_archived = NOT is_archived, updated_at = NOW() WHERE id = $1 RETURNING *',
      [id]
    );

    await logAction(req.user.id, 'TOGGLE_ARCHIVE', 'document', id, { is_archived: result.rows[0].is_archived });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id - delete document (students can only delete own)
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const isFaculty = req.user.role === 'faculty';

    const existing = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = existing.rows[0];

    if (!isFaculty && doc.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await pool.query('DELETE FROM documents WHERE id = $1', [id]);
    await logAction(req.user.id, 'DELETE', 'document', id, {});
    res.json({ message: 'Document deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
