const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { logAction } = require('../services/audit');

// GET / - list all classrooms
router.get('/', authenticate, async (req, res) => {
  try {
    const { building, room_type } = req.query;
    const isFaculty = req.user.role === 'faculty';

    let baseQuery = 'SELECT * FROM classrooms WHERE 1=1';
    const params = [];
    let idx = 1;

    if (!isFaculty) {
      baseQuery += ' AND is_active = true';
    }

    if (building) {
      baseQuery += ` AND building = $${idx++}`;
      params.push(building);
    }

    if (room_type) {
      baseQuery += ` AND room_type = $${idx++}`;
      params.push(room_type);
    }

    baseQuery += ' ORDER BY building, name';

    const result = await pool.query(baseQuery, params);
    res.json(result.rows);
  } catch (err) {
    console.error('[Classrooms GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / - create classroom (faculty only)
router.post('/', authenticate, requireFaculty, async (req, res) => {
  try {
    const { name, capacity, room_type, building, floor } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'name is required' });
    }

    const result = await pool.query(
      `INSERT INTO classrooms (name, capacity, room_type, building, floor, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING *`,
      [name, capacity || 60, room_type || 'classroom', building || 'Main Block', floor != null ? floor : 1]
    );

    const classroom = result.rows[0];
    await logAction(req.user.id, req.user.name, 'faculty', 'create_classroom', 'classrooms', classroom.id);
    res.status(201).json(classroom);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Classroom with this name already exists' });
    }
    console.error('[Classrooms POST] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /:id - update classroom
router.put('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, capacity, room_type, building, floor, is_active } = req.body;

    const result = await pool.query(
      `UPDATE classrooms
       SET name = COALESCE($1, name),
           capacity = COALESCE($2, capacity),
           room_type = COALESCE($3, room_type),
           building = COALESCE($4, building),
           floor = COALESCE($5, floor),
           is_active = COALESCE($6, is_active)
       WHERE id = $7
       RETURNING *`,
      [name, capacity, room_type, building, floor, is_active, id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Classroom not found' });
    }

    await logAction(req.user.id, req.user.name, 'faculty', 'update_classroom', 'classrooms', id);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Classrooms PUT] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id - soft delete (set is_active=false)
router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'UPDATE classrooms SET is_active = false WHERE id = $1 RETURNING *',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Classroom not found' });
    }

    await logAction(req.user.id, req.user.name, 'faculty', 'delete_classroom', 'classrooms', id);
    res.json({ message: 'Classroom deactivated', classroom: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
