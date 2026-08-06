const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty, requireStudent } = require('../middleware/auth');

// GET all events
router.get('/', authenticate, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.*,
        (SELECT COUNT(*) FROM event_registrations er WHERE er.event_id=e.id) as reg_count
      FROM events e ORDER BY e.event_date DESC
    `);
    // If student, also include whether they registered
    if (req.user.role === 'student') {
      const regs = await pool.query(
        'SELECT event_id FROM event_registrations WHERE student_id=$1', [req.user.id]
      );
      const regSet = new Set(regs.rows.map(r => r.event_id));
      res.json(r.rows.map(e => ({ ...e, is_registered: regSet.has(e.id) })));
    } else {
      res.json(r.rows);
    }
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST create event (faculty)
router.post('/', authenticate, requireFaculty, async (req, res) => {
  const { title, description, eventDate, venue } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  try {
    const r = await pool.query(
      `INSERT INTO events (title,description,event_date,venue,created_by)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [title, description, eventDate, venue, req.user.id]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE event (faculty)
router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    await pool.query('DELETE FROM events WHERE id=$1', [req.params.id]);
    res.json({ message: 'Event deleted' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST register for event (student)
router.post('/:id/register', authenticate, requireStudent, async (req, res) => {
  try {
    await pool.query(
      `INSERT INTO event_registrations (event_id,student_id)
       VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Registered for event' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE unregister from event (student)
router.delete('/:id/register', authenticate, requireStudent, async (req, res) => {
  try {
    await pool.query(
      'DELETE FROM event_registrations WHERE event_id=$1 AND student_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ message: 'Unregistered from event' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET registrations for an event (faculty)
router.get('/:id/registrations', authenticate, requireFaculty, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT er.*, u.name, u.email
       FROM event_registrations er
       JOIN users u ON er.student_id=u.id
       WHERE er.event_id=$1`, [req.params.id]
    );
    res.json(r.rows);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
