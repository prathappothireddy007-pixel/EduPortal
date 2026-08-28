const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { logAction } = require('../services/audit');

// GET / - List all subjects / courses
router.get('/', authenticate, async (req, res) => {
  try {
    const { launched_only, dept, slot } = req.query;
    let whereConditions = [];
    let params = [];
    let idx = 1;

    if (launched_only === 'true') {
      whereConditions.push(`(s.is_launched IS TRUE OR s.is_launched IS NULL)`);
    }

    if (slot) {
      whereConditions.push(`UPPER(COALESCE(s.slot, 'A')) = UPPER($${idx++})`);
      params.push(slot.trim().toUpperCase());
    }

    if (dept && dept !== 'ALL') {
      whereConditions.push(`(s.target_dept = 'ALL' OR s.target_dept ILIKE $${idx++} OR s.target_dept IS NULL)`);
      params.push(`%${dept}%`);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    const r = await pool.query(
      `SELECT s.*, 
              COALESCE(s.slot, 'A') as slot,
              COALESCE(s.code, CONCAT('SUB', LPAD(s.id::text, 3, '0'))) as course_code,
              u.name as faculty_name, u.email as faculty_email,
              c.name as class_name,
              (SELECT COUNT(*) FROM enrollment_requests er WHERE er.subject_id = s.id AND er.status = 'enrolled') as enrolled_count
       FROM subjects s
       LEFT JOIN users u ON s.faculty_id = u.id
       LEFT JOIN classes c ON s.class_id = c.id
       ${whereClause}
       ORDER BY s.is_launched DESC, s.slot ASC, s.name ASC`,
      params
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[Subjects GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / - Create a new subject/course with course code, slot (A-Z), faculty in charge, target departments, and launch status
router.post('/', authenticate, requireFaculty, async (req, res) => {
  const { name, code, slot, subjectType, facultyId, targetDept, isLaunched, description, classId } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Subject / Course name is required' });

  try {
    const courseCode = (code || `CS${Math.floor(1000 + Math.random() * 9000)}`).toUpperCase().trim();
    const courseSlot = (slot || 'A').toUpperCase().trim().slice(0, 1);
    const assignedFaculty = facultyId ? parseInt(facultyId, 10) : req.user.id;
    const targetGroup = targetDept || 'ALL';
    const launched = isLaunched !== undefined ? Boolean(isLaunched) : true;

    const r = await pool.query(
      `INSERT INTO subjects (name, code, slot, subject_type, faculty_id, target_dept, is_launched, description, class_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [name.trim(), courseCode, courseSlot, subjectType || 'classroom', assignedFaculty, targetGroup, launched, description || '', classId || null]
    );

    await logAction(req.user.id, req.user.name, 'faculty', 'create_course', 'subjects', r.rows[0].id, null, { name, code: courseCode, slot: courseSlot, targetDept: targetGroup });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[Subjects POST] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /:id - Update subject details, slot, department, or toggle launch status
router.put('/:id', authenticate, requireFaculty, async (req, res) => {
  const { id } = req.params;
  const { name, code, slot, subjectType, facultyId, targetDept, isLaunched, description } = req.body;

  try {
    const courseSlot = slot ? slot.toUpperCase().trim().slice(0, 1) : null;
    const r = await pool.query(
      `UPDATE subjects SET
         name = COALESCE($1, name),
         code = COALESCE($2, code),
         slot = COALESCE($3, slot),
         subject_type = COALESCE($4, subject_type),
         faculty_id = COALESCE($5, faculty_id),
         target_dept = COALESCE($6, target_dept),
         is_launched = COALESCE($7, is_launched),
         description = COALESCE($8, description)
       WHERE id = $9
       RETURNING *`,
      [name ? name.trim() : null, code ? code.toUpperCase().trim() : null, courseSlot, subjectType, facultyId, targetDept, isLaunched, description, id]
    );

    if (r.rows.length === 0) return res.status(404).json({ error: 'Subject not found' });
    await logAction(req.user.id, req.user.name, 'faculty', 'update_course', 'subjects', id);
    res.json(r.rows[0]);
  } catch (err) {
    console.error('[Subjects PUT] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id - Delete subject
router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    await pool.query('DELETE FROM subjects WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, req.user.name, 'faculty', 'delete_course', 'subjects', req.params.id);
    res.json({ message: 'Subject deleted successfully' });
  } catch (err) {
    console.error('[Subjects DELETE] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
