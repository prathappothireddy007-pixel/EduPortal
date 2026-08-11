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
    console.error('[Documents GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / - upload document (both roles)
router.post('/', authenticate, async (req, res) => {
  try {
    const isFaculty = req.user.role === 'faculty';
    let { ownerId, category, title, filename, fileB64 } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    if (!isFaculty) {
      ownerId = req.user.id;
    } else {
      ownerId = ownerId || req.user.id;
    }

    const result = await pool.query(
      `INSERT INTO documents (owner_id, uploaded_by, category, title, filename, file_b64)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [ownerId, req.user.id, category || 'general', title, filename || title, fileB64 || '']
    );

    await logAction(req.user.id, req.user.name, req.user.role, 'upload_document', 'documents', result.rows[0].id);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Documents POST] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /:id/archive - toggle is_archived
router.put('/:id/archive', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const isFaculty = req.user.role === 'faculty';

    const docResult = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = docResult.rows[0];
    if (!isFaculty && doc.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(
      `UPDATE documents SET is_archived = NOT is_archived WHERE id = $1 RETURNING *`,
      [id]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Document Archive] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id
router.delete('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const isFaculty = req.user.role === 'faculty';

    const docResult = await pool.query('SELECT * FROM documents WHERE id = $1', [id]);
    if (docResult.rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const doc = docResult.rows[0];
    if (!isFaculty && doc.owner_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    await pool.query('DELETE FROM documents WHERE id = $1', [id]);
    res.json({ message: 'Document deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
