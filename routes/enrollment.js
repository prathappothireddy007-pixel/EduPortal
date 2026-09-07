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

// GET /subject/:subjectId/students - Faculty or Admin gets full enrolled student roster for a course
router.get('/subject/:subjectId/students', authenticate, requireFaculty, async (req, res) => {
  const { subjectId } = req.params;
  try {
    const subRes = await pool.query('SELECT * FROM subjects WHERE id=$1', [subjectId]);
    if (!subRes.rows[0]) return res.status(404).json({ error: 'Subject not found' });
    const subject = subRes.rows[0];

    const r = await pool.query(
      `SELECT er.id as enrollment_id, er.created_at as enrolled_at, er.status as enrollment_status,
              u.id as student_id, u.name as student_name, u.admin_id as reg_no, u.email as student_email,
              u.department as student_dept, u.parent_phone,
              COALESCE(g.div1_assessments, 0) as div1_assessments,
              COALESCE(g.div3_class_lab, 0) as div3_class_lab,
              COALESCE(g.total_internal, 0) as total_internal,
              COALESCE(g.grand_total, 0) as grand_total,
              COALESCE(g.grade_letter, 'In Progress') as grade_letter,
              htr.status as hall_ticket_status,
              (
                SELECT COUNT(*) FROM attendance a 
                WHERE a.student_id = u.id AND a.subject_id = $1
              ) as total_sessions,
              (
                SELECT COUNT(*) FROM attendance a 
                WHERE a.student_id = u.id AND a.subject_id = $1 AND a.status IN ('Present', 'OD')
              ) as attended_sessions
       FROM enrollment_requests er
       JOIN users u ON er.student_id = u.id
       LEFT JOIN grades g ON (g.student_id = u.id AND g.subject_id = $1)
       LEFT JOIN hall_ticket_requests htr ON (htr.student_id = u.id AND htr.subject_id = $1)
       WHERE er.subject_id = $1 AND er.status = 'enrolled'
       ORDER BY u.admin_id ASC, u.name ASC`,
      [subjectId]
    );

    const students = r.rows.map(stu => {
      const total = parseInt(stu.total_sessions || 0, 10);
      const attended = parseInt(stu.attended_sessions || 0, 10);
      const attendancePct = total > 0 ? Math.round((attended / total) * 100) : 100;
      return {
        ...stu,
        attendance_pct: attendancePct
      };
    });

    res.json({
      subject: {
        id: subject.id,
        name: subject.name,
        code: subject.code || `SUB${String(subject.id).padStart(3, '0')}`,
        slot: subject.slot || 'A',
        subject_type: subject.subject_type || 'classroom',
        target_dept: subject.target_dept || 'ALL',
        is_closed: subject.is_closed,
        faculty_id: subject.faculty_id
      },
      students,
      totalCount: students.length
    });
  } catch (err) {
    console.error('[Subject Enrolled Students GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /subject/:subjectId/drop-student - Faculty/Admin kicks out / drops a student from a course
router.post('/subject/:subjectId/drop-student', authenticate, requireFaculty, async (req, res) => {
  const { subjectId } = req.params;
  const { studentId, reason } = req.body;

  if (!studentId) return res.status(400).json({ error: 'studentId is required' });

  try {
    const subRes = await pool.query('SELECT * FROM subjects WHERE id=$1', [subjectId]);
    if (!subRes.rows[0]) return res.status(404).json({ error: 'Subject not found' });
    const subject = subRes.rows[0];

    const studentRes = await pool.query('SELECT id, name, email FROM users WHERE id=$1', [studentId]);
    if (!studentRes.rows[0]) return res.status(404).json({ error: 'Student not found' });
    const student = studentRes.rows[0];

    // Remove enrollment
    await pool.query(
      `DELETE FROM enrollment_requests WHERE student_id=$1 AND subject_id=$2`,
      [studentId, subjectId]
    );

    // Delete associated subject attendance & hall ticket requests
    await pool.query(`DELETE FROM attendance WHERE student_id=$1 AND subject_id=$2`, [studentId, subjectId]);
    await pool.query(`DELETE FROM hall_ticket_requests WHERE student_id=$1 AND subject_id=$2`, [studentId, subjectId]);

    const dropReason = reason || 'Course enrollment revoked by course faculty';

    // Notify student
    await notify(
      studentId,
      'course_dropped',
      '⚠️ Course Enrollment Revoked',
      `You have been dropped from "${subject.name}" (${subject.code || 'SUB'}) by ${req.user.name}. Reason: ${dropReason}`,
      subjectId
    );

    // Audit log
    await logAction(
      req.user.id,
      req.user.name,
      req.user.role,
      'drop_student_from_course',
      'enrollment_requests',
      subjectId,
      null,
      { studentId, studentName: student.name, reason: dropReason }
    );

    res.json({
      message: `Student ${student.name} was successfully dropped from ${subject.name}.`,
      droppedStudentId: studentId,
      subjectId
    });
  } catch (err) {
    console.error('[Drop Student POST] Error:', err);
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
