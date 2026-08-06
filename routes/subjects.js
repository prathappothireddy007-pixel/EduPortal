const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT s.*, c.name as class_name
       FROM subjects s
       LEFT JOIN classes c ON s.class_id = c.id
       ORDER BY c.name, s.name`
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/', authenticate, requireFaculty, async (req, res) => {
  const { name, classId } = req.body;
  if (!name || !classId) return res.status(400).json({ error: 'Name and classId required' });
  try {
    const r = await pool.query(
      'INSERT INTO subjects (name,class_id) VALUES ($1,$2) RETURNING *', [name, classId]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    await pool.query('DELETE FROM subjects WHERE id=$1', [req.params.id]);
    res.json({ message: 'Subject deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
