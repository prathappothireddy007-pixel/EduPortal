const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { logAction, notify } = require('../services/audit');
const { checkConflicts, autoGenerate } = require('../services/timetable');

// GET / - list timetable entries with full joins
router.get('/', authenticate, async (req, res) => {
  try {
    const { class_id, day_of_week, classroom_id } = req.query;
    const params = [];
    let idx = 1;
    let whereClause = 'WHERE 1=1';

    if (class_id) {
      whereClause += ` AND te.class_id = $${idx++}`;
      params.push(class_id);
    }
    if (day_of_week) {
      whereClause += ` AND te.day_of_week = $${idx++}`;
      params.push(day_of_week);
    }
    if (classroom_id) {
      whereClause += ` AND te.classroom_id = $${idx++}`;
      params.push(classroom_id);
    }

    const result = await pool.query(
      `SELECT
         te.*,
         c.name AS class_name,
         s.name AS subject_name,
         cr.name AS classroom_name, cr.name AS room_name, cr.building, cr.floor,
         u.name AS faculty_name
       FROM timetable_entries te
       LEFT JOIN classes c ON te.class_id = c.id
       LEFT JOIN subjects s ON te.subject_id = s.id
       LEFT JOIN classrooms cr ON te.classroom_id = cr.id
       LEFT JOIN users u ON te.faculty_id = u.id
       ${whereClause}
       ORDER BY te.day_of_week, te.start_time`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error('[Timetable GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /conflicts - check conflicts on all existing entries
router.get('/conflicts', authenticate, requireFaculty, async (req, res) => {
  try {
    const entriesResult = await pool.query('SELECT * FROM timetable_entries');
    const conflicts = [];
    for (const entry of entriesResult.rows) {
      const c = await checkConflicts(pool, entry, entry.id);
      if (c.length > 0) conflicts.push(...c);
    }
    res.json({ conflicts });
  } catch (err) {
    console.error('[Timetable Conflicts] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /student/current-class - get current and next timetable entry for authenticated student
router.get('/student/current-class', authenticate, async (req, res) => {
  try {
    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = days[now.getDay()];
    const currentTime = now.toTimeString().slice(0, 8); // HH:MM:SS

    const studentResult = await pool.query(
      'SELECT class_id FROM users WHERE id = $1',
      [req.user.id]
    );

    if (studentResult.rows.length === 0 || !studentResult.rows[0].class_id) {
      return res.json({ current: null, next: null });
    }

    const classId = studentResult.rows[0].class_id;

    const currentResult = await pool.query(
      `SELECT
         te.*,
         s.name AS subject_name,
         cr.name AS room_name, cr.building, cr.floor,
         u.name AS faculty_name
       FROM timetable_entries te
       LEFT JOIN subjects s ON te.subject_id = s.id
       LEFT JOIN classrooms cr ON te.classroom_id = cr.id
       LEFT JOIN users u ON te.faculty_id = u.id
       WHERE te.class_id = $1
         AND te.day_of_week = $2
         AND te.start_time <= $3
         AND te.end_time > $3
       LIMIT 1`,
      [classId, currentDay, currentTime]
    );

    const nextResult = await pool.query(
      `SELECT
         te.*,
         s.name AS subject_name,
         cr.name AS room_name, cr.building, cr.floor,
         u.name AS faculty_name
       FROM timetable_entries te
       LEFT JOIN subjects s ON te.subject_id = s.id
       LEFT JOIN classrooms cr ON te.classroom_id = cr.id
       LEFT JOIN users u ON te.faculty_id = u.id
       WHERE te.class_id = $1
         AND te.day_of_week = $2
         AND te.start_time > $3
       ORDER BY te.start_time ASC
       LIMIT 1`,
      [classId, currentDay, currentTime]
    );

    res.json({
      current: currentResult.rows[0] || null,
      next: nextResult.rows[0] || null,
    });
  } catch (err) {
    console.error('[Current Class] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /generate - auto-generate timetable
router.post('/generate', authenticate, requireFaculty, async (req, res) => {
  try {
    const { classIds, days, slots, replaceExisting } = req.body;

    if (!classIds || !days || !slots) {
      return res.status(400).json({ error: 'classIds, days, and slots are required' });
    }

    if (replaceExisting) {
      const placeholders = classIds.map((_, i) => `$${i + 1}`).join(', ');
      await pool.query(
        `DELETE FROM timetable_entries WHERE class_id IN (${placeholders})`,
        classIds
      );
    }

    const { allocated, unallocated } = await autoGenerate(pool, classIds, days, slots);

    if (allocated && allocated.length > 0) {
      for (const entry of allocated) {
        await pool.query(
          `INSERT INTO timetable_entries
             (class_id, subject_id, faculty_id, classroom_id, day_of_week, start_time, end_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entry.class_id, entry.subject_id, entry.faculty_id, entry.classroom_id,
           entry.day_of_week, entry.start_time, entry.end_time]
        );
      }
    }

    await logAction(req.user.id, req.user.name, 'faculty', 'generate_timetable', 'timetable_entries', null);
    res.json({ allocated, unallocated, conflicts: [] });
  } catch (err) {
    console.error('[Timetable Generate] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /entry - manually add a single entry
router.post('/entry', authenticate, requireFaculty, async (req, res) => {
  try {
    const { classId, subjectId, facultyId, classroomId, dayOfWeek, startTime, endTime } = req.body;

    if (!classId || !subjectId || !classroomId || !dayOfWeek || !startTime || !endTime) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const newEntry = { classId, subjectId, facultyId, classroomId, dayOfWeek, startTime, endTime };
    const conflicts = await checkConflicts(pool, newEntry);

    if (conflicts.length > 0) {
      return res.status(409).json({ error: 'Conflicts detected', conflicts });
    }

    const result = await pool.query(
      `INSERT INTO timetable_entries
         (class_id, subject_id, faculty_id, classroom_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [classId, subjectId, facultyId || req.user.id, classroomId, dayOfWeek, startTime, endTime]
    );

    await logAction(req.user.id, req.user.name, 'faculty', 'create_entry', 'timetable_entries', result.rows[0].id);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[Timetable Entry] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /:id - update timetable entry
router.put('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;
    const { classId, subjectId, facultyId, classroomId, dayOfWeek, startTime, endTime } = req.body;

    const existing = await pool.query('SELECT * FROM timetable_entries WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Timetable entry not found' });
    }

    const entry = existing.rows[0];

    const updatedEntry = {
      classId: classId || entry.class_id,
      subjectId: subjectId || entry.subject_id,
      facultyId: facultyId || entry.faculty_id,
      classroomId: classroomId || entry.classroom_id,
      dayOfWeek: dayOfWeek || entry.day_of_week,
      startTime: startTime || entry.start_time,
      endTime: endTime || entry.end_time
    };

    const conflicts = await checkConflicts(pool, updatedEntry, id);
    if (conflicts.length > 0) {
      return res.status(409).json({ error: 'Conflicts detected', conflicts });
    }

    const result = await pool.query(
      `UPDATE timetable_entries
       SET class_id = $1, subject_id = $2, faculty_id = $3, classroom_id = $4,
           day_of_week = $5, start_time = $6, end_time = $7
       WHERE id = $8
       RETURNING *`,
      [updatedEntry.classId, updatedEntry.subjectId, updatedEntry.facultyId,
       updatedEntry.classroomId, updatedEntry.dayOfWeek, updatedEntry.startTime,
       updatedEntry.endTime, id]
    );

    await logAction(req.user.id, req.user.name, 'faculty', 'update_entry', 'timetable_entries', id);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Timetable Update] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id
router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    await pool.query('DELETE FROM timetable_entries WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, req.user.name, 'faculty', 'delete_entry', 'timetable_entries', req.params.id);
    res.json({ message: 'Timetable entry deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/change-room
router.post('/:id/change-room', authenticate, requireFaculty, async (req, res) => {
  const { newClassroomId, reason } = req.body;
  try {
    const entryRes = await pool.query('SELECT * FROM timetable_entries WHERE id=$1', [req.params.id]);
    const entry = entryRes.rows[0];
    if (!entry) return res.status(404).json({ error: 'Entry not found' });

    const oldRoomId = entry.classroom_id;
    await pool.query('UPDATE timetable_entries SET classroom_id=$1 WHERE id=$2', [newClassroomId, entry.id]);

    await pool.query(
      `INSERT INTO room_change_log (timetable_entry_id, old_classroom_id, new_classroom_id, changed_by, reason)
       VALUES ($1, $2, $3, $4, $5)`,
      [entry.id, oldRoomId, newClassroomId, req.user.id, reason || 'Room changed by faculty']
    );

    const roomRes = await pool.query('SELECT name FROM classrooms WHERE id=$1', [newClassroomId]);
    const roomName = roomRes.rows[0]?.name || 'new room';

    const students = await pool.query('SELECT id FROM users WHERE class_id=$1 AND role=\'student\'', [entry.class_id]);
    for (const s of students.rows) {
      await notify(s.id, 'room_change', '🔔 Class Room Changed', `Your class room has been moved to ${roomName}`, entry.id);
    }

    res.json({ message: 'Room updated successfully', newClassroomId });
  } catch (err) {
    console.error('[Room Change] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
