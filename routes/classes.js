const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');

router.get('/', authenticate, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM classes ORDER BY name');
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

router.post('/', authenticate, requireFaculty, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const r = await pool.query('INSERT INTO classes (name) VALUES ($1) RETURNING *', [name]);
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    await pool.query('DELETE FROM classes WHERE id=$1', [req.params.id]);
    res.json({ message: 'Class deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
