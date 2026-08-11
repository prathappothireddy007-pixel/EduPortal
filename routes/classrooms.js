const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { logAction } = require('../services/audit');

// GET / - list all classrooms
router.get('/', authenticate, async (req, res) => {
  try {
    const { building, room_type, available, day, start_time, end_time } = req.query;
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

    if (available === 'true' && day && start_time && end_time) {
      baseQuery += `
        AND id NOT IN (
          SELECT classroom_id FROM timetable_entries
          WHERE day_of_week = $${idx++}
            AND NOT (end_time <= $${idx++} OR start_time >= $${idx++})
        )`;
      params.push(day, start_time, end_time);
    }

    baseQuery += ' ORDER BY building, name';

    const result = await pool.query(baseQuery, params);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / - create classroom (faculty only)
router.post('/', authenticate, requireFaculty, async (req, res) => {
  try {
    const { name, capacity, room_type, building, floor } = req.body;

    if (!name || !capacity || !room_type || !building || floor === undefined) {
      return res.status(400).json({ error: 'name, capacity, room_type, building, and floor are required' });
    }

    const result = await pool.query(
      `INSERT INTO classrooms (name, capacity, room_type, building, floor, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING *`,
      [name, capacity, room_type, building, floor]
    );

    await logAction(req.user.id, 'CREATE', 'classroom', result.rows[0].id, { name, capacity, room_type, building, floor });
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /:id - update classroom (faculty only)
router.put('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, capacity, room_type, building, floor, is_active } = req.body;

    const existing = await pool.query('SELECT * FROM classrooms WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Classroom not found' });
    }

    const result = await pool.query(
      `UPDATE classrooms
       SET name = COALESCE($1, name),
           capacity = COALESCE($2, capacity),
           room_type = COALESCE($3, room_type),
           building = COALESCE($4, building),
           floor = COALESCE($5, floor),
           is_active = COALESCE($6, is_active),
           updated_at = NOW()
       WHERE id = $7
       RETURNING *`,
      [name, capacity, room_type, building, floor, is_active, id]
    );

    await logAction(req.user.id, 'UPDATE', 'classroom', id, req.body);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id - soft delete (faculty only)
router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query('SELECT * FROM classrooms WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Classroom not found' });
    }

    await pool.query(
      'UPDATE classrooms SET is_active = false, updated_at = NOW() WHERE id = $1',
      [id]
    );

    await logAction(req.user.id, 'SOFT_DELETE', 'classroom', id, {});
    res.json({ message: 'Classroom deactivated successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /:id/availability - check availability for a time slot
router.get('/:id/availability', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { day, start_time, end_time } = req.query;

    if (!day || !start_time || !end_time) {
      return res.status(400).json({ error: 'day, start_time, and end_time are required' });
    }

    const classroom = await pool.query('SELECT * FROM classrooms WHERE id = $1', [id]);
    if (classroom.rows.length === 0) {
      return res.status(404).json({ error: 'Classroom not found' });
    }

    const conflicts = await pool.query(
      `SELECT te.*, c.name AS class_name, s.name AS subject_name
       FROM timetable_entries te
       LEFT JOIN classes c ON te.class_id = c.id
       LEFT JOIN subjects s ON te.subject_id = s.id
       WHERE te.classroom_id = $1
         AND te.day_of_week = $2
         AND NOT (te.end_time <= $3 OR te.start_time >= $4)`,
      [id, day, start_time, end_time]
    );

    const available = conflicts.rows.length === 0;
    res.json({
      classroom: classroom.rows[0],
      available,
      conflicts: conflicts.rows,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
