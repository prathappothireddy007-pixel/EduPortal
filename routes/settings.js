const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');

// GET all settings — faculty only
router.get('/', authenticate, requireFaculty, async (req, res) => {
  try {
    const r = await pool.query('SELECT key, value FROM settings ORDER BY key');
    const result = {};
    for (const row of r.rows) result[row.key] = row.value;
    res.json(result);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// PUT update a setting — faculty only
router.put('/:key', authenticate, requireFaculty, async (req, res) => {
  const { value } = req.body;
  if (value == null || value === '') return res.status(400).json({ error: 'Value required' });

  // Validate numeric settings
  const numericKeys = [
    'attendance_threshold', 'academic_risk_attend_high', 'academic_risk_attend_mod',
    'academic_risk_grade_high', 'academic_risk_grade_mod'
  ];
  if (numericKeys.includes(req.params.key)) {
    const num = parseFloat(value);
    if (isNaN(num) || num <= 0 || num > 100) {
      return res.status(400).json({ error: 'Value must be a number between 1 and 100' });
    }
  }

  try {
    const r = await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ($1,$2,NOW())
       ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()
       RETURNING *`,
      [req.params.key, String(value)]
    );
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
