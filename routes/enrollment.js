const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty, requireStudent } = require('../middleware/auth');
const { notify, logAction } = require('../services/audit');

// GET /available - Student gets all launched courses/subjects with slot (A-Z) & department filtering
router.get('/available', authenticate, async (req, res) => {
  try {
    const studentId = req.user.id;
    const userRes = await pool.query('SELECT department FROM users WHERE id=$1', [studentId]);
    const studentDept = userRes.rows[0]?.department || '';

    const r = await pool.query(
      `SELECT s.id, s.name as subject_name,
              COALESCE(s.slot, 'A') as slot,
              COALESCE(s.code, CONCAT('SUB', LPAD(s.id::text, 3, '0'))) as course_code,
              s.subject_type, COALESCE(s.target_dept, 'ALL') as target_dept, s.is_launched, s.description,
              u.name as faculty_name, u.email as faculty_email,
              EXISTS (
                SELECT 1 FROM enrollment_requests er 
                WHERE er.subject_id = s.id AND er.student_id = $1 AND er.status = 'enrolled'
              ) as is_enrolled,
              (
                s.target_dept IS NULL 
                OR s.target_dept = 'ALL' 
                OR $2 = '' 
                OR s.target_dept ILIKE CONCAT('%', $2, '%')
              ) as is_dept_eligible
       FROM subjects s
       LEFT JOIN users u ON s.faculty_id = u.id
       WHERE (s.is_launched IS TRUE OR s.is_launched IS NULL)
       ORDER BY s.slot ASC, is_enrolled DESC, s.name ASC`,
      [studentId, studentDept]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[Enrollment Available] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /my-courses - Current student gets enrolled courses with slot
router.get('/my-courses', authenticate, async (req, res) => {
  try {
    const studentId = req.user.id;
    const r = await pool.query(
      `SELECT er.id as enrollment_id, er.created_at as enrolled_at,
              s.id as subject_id, s.name as subject_name,
              COALESCE(s.slot, 'A') as slot,
              COALESCE(s.code, CONCAT('SUB', LPAD(s.id::text, 3, '0'))) as course_code,
              s.subject_type, s.target_dept,
              u.name as faculty_name, u.email as faculty_email
       FROM enrollment_requests er
       JOIN subjects s ON er.subject_id = s.id
       LEFT JOIN users u ON s.faculty_id = u.id
       WHERE er.student_id = $1 AND er.status = 'enrolled'
       ORDER BY s.slot ASC, s.name ASC`,
      [studentId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error('[My Courses] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET / - All enrollments (faculty view for their subjects or admin view for all) or own enrollments (student view)
router.get('/', authenticate, async (req, res) => {
  try {
    let r;
    if (req.user.role === 'admin') {
      r = await pool.query(
        `SELECT er.id, er.status, er.created_at,
                u_s.id as student_id, u_s.name as student_name, u_s.admin_id as reg_no, u_s.email as student_email,
                s.id as subject_id, s.name as subject_name, COALESCE(s.slot, 'A') as slot,
                COALESCE(s.code, CONCAT('SUB', LPAD(s.id::text, 3, '0'))) as course_code,
                u_f.name as faculty_name
         FROM enrollment_requests er
         JOIN users u_s ON er.student_id = u_s.id
         JOIN subjects s ON er.subject_id = s.id
         LEFT JOIN users u_f ON s.faculty_id = u_f.id
         ORDER BY er.created_at DESC`
      );
    } else if (req.user.role === 'faculty') {
      r = await pool.query(
        `SELECT er.id, er.status, er.created_at,
                u_s.id as student_id, u_s.name as student_name, u_s.admin_id as reg_no, u_s.email as student_email,
                s.id as subject_id, s.name as subject_name, COALESCE(s.slot, 'A') as slot,
                COALESCE(s.code, CONCAT('SUB', LPAD(s.id::text, 3, '0'))) as course_code,
                u_f.name as faculty_name
         FROM enrollment_requests er
         JOIN users u_s ON er.student_id = u_s.id
         JOIN subjects s ON er.subject_id = s.id
         LEFT JOIN users u_f ON s.faculty_id = u_f.id
         WHERE s.faculty_id = $1 OR s.faculty_id IS NULL
         ORDER BY er.created_at DESC`,
        [req.user.id]
      );
    } else {
      r = await pool.query(
        `SELECT er.id, er.status, er.created_at,
                s.id as subject_id, s.name as subject_name, COALESCE(s.slot, 'A') as slot,
                COALESCE(s.code, CONCAT('SUB', LPAD(s.id::text, 3, '0'))) as course_code,
                u_f.name as faculty_name
         FROM enrollment_requests er
         JOIN subjects s ON er.subject_id = s.id
         LEFT JOIN users u_f ON s.faculty_id = u_f.id
         WHERE er.student_id = $1
         ORDER BY er.created_at DESC`,
        [req.user.id]
      );
    }
    res.json(r.rows);
  } catch (err) {
    console.error('[Enrollment GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /enroll - Student enrolls directly into a course/subject
router.post('/enroll', authenticate, async (req, res) => {
  const { subjectId } = req.body;
  if (!subjectId) return res.status(400).json({ error: 'Subject ID required' });

  try {
    // Check if already enrolled
    const check = await pool.query(
      `SELECT * FROM enrollment_requests WHERE student_id=$1 AND subject_id=$2`,
      [req.user.id, subjectId]
    );

    if (check.rows.length > 0) {
      if (check.rows[0].status === 'enrolled') {
        return res.status(400).json({ error: 'You are already enrolled in this course' });
      }
      // Re-activate
      const r = await pool.query(
        `UPDATE enrollment_requests SET status='enrolled', created_at=NOW() WHERE id=$1 RETURNING *`,
        [check.rows[0].id]
      );
      return res.json(r.rows[0]);
    }

    const r = await pool.query(
      `INSERT INTO enrollment_requests (student_id, subject_id, status)
       VALUES ($1, $2, 'enrolled')
       RETURNING *`,
      [req.user.id, subjectId]
    );

    // Notify faculty in charge
    const sub = await pool.query(`SELECT s.name, s.faculty_id FROM subjects s WHERE s.id=$1`, [subjectId]);
    if (sub.rows[0] && sub.rows[0].faculty_id) {
      await notify(
        sub.rows[0].faculty_id,
        'student_enrolled',
        'New Course Enrollment 🎓',
        `${req.user.name} enrolled in "${sub.rows[0].name}"`,
        r.rows[0].id
      );
    }

    await logAction(req.user.id, req.user.name, req.user.role, 'enroll_course', 'subjects', subjectId);
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[Enroll POST] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /unenroll - Student drops course and attendance changes dynamically
router.post('/unenroll', authenticate, async (req, res) => {
  const { subjectId } = req.body;
  if (!subjectId) return res.status(400).json({ error: 'Subject ID required' });

  try {
    await pool.query(
      `DELETE FROM enrollment_requests WHERE student_id=$1 AND subject_id=$2`,
      [req.user.id, subjectId]
    );
    // Delete associated course attendance so standing updates dynamically
    await pool.query(
      `DELETE FROM attendance WHERE student_id=$1 AND subject_id=$2`,
      [req.user.id, subjectId]
    );
    await pool.query(
      `DELETE FROM grades WHERE student_id=$1 AND subject_id=$2`,
      [req.user.id, subjectId]
    );
    await pool.query(
      `DELETE FROM hall_ticket_requests WHERE student_id=$1 AND subject_id=$2`,
      [req.user.id, subjectId]
    );
    res.json({ message: 'Unenrolled from course and attendance recalculated.' });
  } catch (err) {
    console.error('[Unenroll] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /:id - Faculty removes enrollment
router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    const enr = await pool.query('SELECT student_id, subject_id FROM enrollment_requests WHERE id=$1', [req.params.id]);
    if (enr.rows.length > 0) {
      await pool.query('DELETE FROM attendance WHERE student_id=$1 AND subject_id=$2', [enr.rows[0].student_id, enr.rows[0].subject_id]);
    }
    await pool.query('DELETE FROM enrollment_requests WHERE id=$1', [req.params.id]);
    res.json({ message: 'Enrollment removed' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
