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
         cr.name AS classroom_name, cr.building, cr.floor,
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
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /conflicts - check conflicts on all existing entries
router.get('/conflicts', authenticate, requireFaculty, async (req, res) => {
  try {
    const entriesResult = await pool.query('SELECT * FROM timetable_entries');
    const conflicts = await checkConflicts(entriesResult.rows);
    res.json({ conflicts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /student/current-class - get current and next timetable entry for authenticated student
router.get('/student/current-class', authenticate, async (req, res) => {
  try {
    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const currentDay = days[now.getDay()];
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM

    const studentResult = await pool.query(
      'SELECT class_id FROM students WHERE user_id = $1',
      [req.user.id]
    );

    if (studentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Student record not found' });
    }

    const classId = studentResult.rows[0].class_id;

    const currentResult = await pool.query(
      `SELECT
         te.*,
         s.name AS subject_name,
         cr.name AS classroom_name, cr.building, cr.floor,
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
         cr.name AS classroom_name, cr.building, cr.floor,
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
    console.error(err);
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

    const { allocated, unallocated, conflicts } = await autoGenerate(classIds, days, slots);

    if (allocated && allocated.length > 0) {
      const insertPromises = allocated.map((entry) =>
        pool.query(
          `INSERT INTO timetable_entries
             (class_id, subject_id, faculty_id, classroom_id, day_of_week, start_time, end_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [entry.classId, entry.subjectId, entry.facultyId, entry.classroomId,
           entry.dayOfWeek, entry.startTime, entry.endTime]
        )
      );
      await Promise.all(insertPromises);
    }

    await logAction(req.user.id, 'GENERATE_TIMETABLE', 'timetable', null, { classIds, days, slots, replaceExisting });
    res.json({ allocated, unallocated, conflicts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /entry - manually add a single entry
router.post('/entry', authenticate, requireFaculty, async (req, res) => {
  try {
    const { classId, subjectId, facultyId, classroomId, dayOfWeek, startTime, endTime } = req.body;

    if (!classId || !subjectId || !facultyId || !classroomId || !dayOfWeek || !startTime || !endTime) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const newEntry = { classId, subjectId, facultyId, classroomId, dayOfWeek, startTime, endTime };
    const conflicts = await checkConflicts([newEntry]);

    if (conflicts.length > 0) {
      return res.status(409).json({ error: 'Conflicts detected', conflicts });
    }

    const result = await pool.query(
      `INSERT INTO timetable_entries
         (class_id, subject_id, faculty_id, classroom_id, day_of_week, start_time, end_time)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [classId, subjectId, facultyId, classroomId, dayOfWeek, startTime, endTime]
    );

    await logAction(req.user.id, 'CREATE', 'timetable_entry', result.rows[0].id, newEntry);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
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
    if (entry.is_locked && req.user.role !== 'faculty') {
      return res.status(403).json({ error: 'Entry is locked' });
    }

    const updatedEntry = {
      classId: classId || entry.class_id,
      subjectId: subjectId || entry.subject_id,
      facultyId: facultyId || entry.faculty_id,
      classroomId: classroomId || entry.classroom_id,
      dayOfWeek: dayOfWeek || entry.day_of_week,
      startTime: startTime || entry.start_time,
      endTime: endTime || entry.end_time,
      excludeId: id,
    };

    const conflicts = await checkConflicts([updatedEntry]);
    if (conflicts.length > 0) {
      return res.status(409).json({ error: 'Conflicts detected', conflicts });
    }

    const result = await pool.query(
      `UPDATE timetable_entries
       SET class_id = $1, subject_id = $2, faculty_id = $3, classroom_id = $4,
           day_of_week = $5, start_time = $6, end_time = $7, updated_at = NOW()
       WHERE id = $8
       RETURNING *`,
      [updatedEntry.classId, updatedEntry.subjectId, updatedEntry.facultyId,
       updatedEntry.classroomId, updatedEntry.dayOfWeek, updatedEntry.startTime,
       updatedEntry.endTime, id]
    );

    await logAction(req.user.id, 'UPDATE', 'timetable_entry', id, req.body);
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id - delete timetable entry (only if not locked)
router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await pool.query('SELECT * FROM timetable_entries WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Timetable entry not found' });
    }

    if (existing.rows[0].is_locked) {
      return res.status(403).json({ error: 'Cannot delete a locked entry' });
    }

    await pool.query('DELETE FROM timetable_entries WHERE id = $1', [id]);
    await logAction(req.user.id, 'DELETE', 'timetable_entry', id, {});
    res.json({ message: 'Timetable entry deleted' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/change-room - change classroom for an entry
router.post('/:id/change-room', authenticate, requireFaculty, async (req, res) => {
  try {
    const { id } = req.params;
    const { newClassroomId, reason } = req.body;

    if (!newClassroomId) {
      return res.status(400).json({ error: 'newClassroomId is required' });
    }

    const existing = await pool.query('SELECT * FROM timetable_entries WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Timetable entry not found' });
    }

    const entry = existing.rows[0];

    const conflictCheck = {
      classId: entry.class_id,
      subjectId: entry.subject_id,
      facultyId: entry.faculty_id,
      classroomId: newClassroomId,
      dayOfWeek: entry.day_of_week,
      startTime: entry.start_time,
      endTime: entry.end_time,
      excludeId: id,
    };

    const conflicts = await checkConflicts([conflictCheck]);
    if (conflicts.length > 0) {
      return res.status(409).json({ error: 'New classroom has conflicts', conflicts });
    }

    await pool.query(
      `INSERT INTO room_change_log (timetable_entry_id, old_classroom_id, new_classroom_id, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, entry.classroom_id, newClassroomId, reason, req.user.id]
    );

    const updated = await pool.query(
      'UPDATE timetable_entries SET classroom_id = $1, updated_at = NOW() WHERE id = $2 RETURNING *',
      [newClassroomId, id]
    );

    const studentsResult = await pool.query(
      'SELECT user_id FROM students WHERE class_id = $1',
      [entry.class_id]
    );

    const newClassroom = await pool.query(
      'SELECT name, building, floor FROM classrooms WHERE id = $1',
      [newClassroomId]
    );
    const roomInfo = newClassroom.rows[0];

    await Promise.all(
      studentsResult.rows.map((s) =>
        notify(
          s.user_id,
          'Room Change',
          `Your class room has been changed to ${roomInfo ? `${roomInfo.name}, ${roomInfo.building}` : 'a new room'}. Reason: ${reason || 'Not specified'}`,
          'timetable'
        )
      )
    );

    res.json(updated.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
