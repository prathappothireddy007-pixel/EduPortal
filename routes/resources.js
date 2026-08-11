const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');

// GET / - list resources; ?subject_id= filter. Both roles can view.
router.get('/', authenticate, async (req, res) => {
  try {
    const { subject_id } = req.query;
    const params = [];
    let whereClause = 'WHERE 1=1';

    if (subject_id) {
      whereClause += ' AND r.subject_id = $1';
      params.push(subject_id);
    }

    const result = await pool.query(
      `SELECT r.*, s.name AS subject_name, u.name AS uploaded_by_name
       FROM resources r
       LEFT JOIN subjects s ON r.subject_id = s.id
       LEFT JOIN users u ON r.uploaded_by = u.id
       ${whereClause}
       ORDER BY r.created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /recommended/:studentId - recommended resources based on weak subjects (avg < 60%)
// NOTE: This route must be defined BEFORE /:id to prevent route shadowing
router.get('/recommended/:studentId', authenticate, async (req, res) => {
  try {
    const { studentId } = req.params;
    const isFaculty = req.user.role === 'faculty';

    if (!isFaculty && req.user.id !== parseInt(studentId, 10)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Calculate average score per subject; return only subjects where avg < 60%
    const gradesResult = await pool.query(
      `SELECT g.subject_id, s.name AS subject_name,
              AVG(g.score) AS avg_score,
              AVG(g.max_score) AS avg_max_score
       FROM grades g
       LEFT JOIN subjects s ON g.subject_id = s.id
       WHERE g.student_id = $1
       GROUP BY g.subject_id, s.name
       HAVING AVG(CASE WHEN g.max_score > 0 THEN (g.score / g.max_score) * 100 ELSE 0 END) < 60`,
      [studentId]
    );

    if (gradesResult.rows.length === 0) {
      return res.json({ weakSubjects: [], resources: [] });
    }

    const weakSubjectIds = gradesResult.rows.map((r) => r.subject_id);
    const placeholders = weakSubjectIds.map((_, i) => `$${i + 1}`).join(', ');

    const resourcesResult = await pool.query(
      `SELECT r.*, s.name AS subject_name
       FROM resources r
       LEFT JOIN subjects s ON r.subject_id = s.id
       WHERE r.subject_id IN (${placeholders})
       ORDER BY r.subject_id, r.created_at DESC`,
      weakSubjectIds
    );

    res.json({
      weakSubjects: gradesResult.rows,
      resources: resourcesResult.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / - faculty uploads resource
router.post('/', authenticate, requireFaculty, async (req, res) => {
  try {
    const { subjectId, title, resourceType, description, fileB64 } = req.body;

    if (!subjectId || !title || !resourceType) {
      return res.status(400).json({ error: 'subjectId, title, and resourceType are required' });
    }

    const result = await pool.query(
      `INSERT INTO resources (subject_id, title, resource_type, description, file_data, uploaded_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [subjectId, title, resourceType, description, fileB64, req.user.id]
    );

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id - faculty only
router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query('SELECT * FROM resources WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Resource not found' });
    }

    await pool.query('DELETE FROM resources WHERE id = $1', [id]);
    res.json({ message: 'Resource deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
