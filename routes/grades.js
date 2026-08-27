const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty, requireStudent } = require('../middleware/auth');
const { notify, logAction } = require('../services/audit');
const crypto = require('crypto');

// Helper to calculate Grade Letter
function calculateGrade(grandTotal) {
  const score = parseFloat(grandTotal) || 0;
  if (score >= 450) return 'O';   // 90%+
  if (score >= 400) return 'A+';  // 80%+
  if (score >= 350) return 'A';   // 70%+
  if (score >= 300) return 'B+';  // 60%+
  if (score >= 250) return 'B';   // 50%+
  return 'RA';                    // Re-Appear (<50%)
}

// GET / - List all grades or student's own grades
router.get('/', authenticate, async (req, res) => {
  try {
    const isStaff = req.user.role === 'faculty' || req.user.role === 'admin';
    let r;
    if (isStaff) {
      const { subjectId, studentId } = req.query;
      let query = `
        SELECT g.*, 
               u.name as student_name, u.admin_id as student_reg_no, u.department as student_dept,
               s.name as subject_name, s.code as course_code, s.is_closed as course_is_closed,
               s.exam_date, s.exam_session, s.exam_hall
        FROM grades g
        JOIN users u ON g.student_id = u.id
        JOIN subjects s ON g.subject_id = s.id
        WHERE 1=1
      `;
      const params = [];
      let idx = 1;
      if (subjectId) {
        query += ` AND g.subject_id = $${idx++}`;
        params.push(subjectId);
      }
      if (studentId) {
        query += ` AND g.student_id = $${idx++}`;
        params.push(studentId);
      }
      query += ` ORDER BY s.name, u.name`;
      r = await pool.query(query, params);
    } else {
      r = await pool.query(
        `SELECT g.*, 
                s.name as subject_name, s.code as course_code, s.is_closed as course_is_closed,
                s.exam_date, s.exam_session, s.exam_hall,
                u_fac.name as faculty_name
         FROM grades g
         JOIN subjects s ON g.subject_id = s.id
         LEFT JOIN users u_fac ON s.faculty_id = u_fac.id
         WHERE g.student_id = $1
         ORDER BY s.code, s.name`,
        [req.user.id]
      );
    }
    res.json(r.rows);
  } catch (err) {
    console.error('[Grades GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /submit-divisions — Faculty enters 5 academic divisions marks (total internal: 400, univ: 100)
router.post('/submit-divisions', authenticate, requireFaculty, async (req, res) => {
  const {
    studentId,
    subjectId,
    div1Assessments, // Max 100
    div2Capstone,    // Max 100
    div3ClassLab,    // Max 100
    div4UnivLab,     // Max 100
    div5UnivExam     // Max 100
  } = req.body;

  if (!studentId || !subjectId) {
    return res.status(400).json({ error: 'studentId and subjectId are required' });
  }

  const d1 = Math.min(100, Math.max(0, parseFloat(div1Assessments) || 0));
  const d2 = Math.min(100, Math.max(0, parseFloat(div2Capstone) || 0));
  const d3 = Math.min(100, Math.max(0, parseFloat(div3ClassLab) || 0));
  const d4 = Math.min(100, Math.max(0, parseFloat(div4UnivLab) || 0));
  const d5 = Math.min(100, Math.max(0, parseFloat(div5UnivExam) || 0));

  const totalInternal = d1 + d2 + d3 + d4; // Max 400
  const grandTotal = totalInternal + d5;   // Max 500
  const gradeLetter = calculateGrade(grandTotal);

  try {
    const student = await pool.query('SELECT name FROM users WHERE id=$1', [studentId]);
    const subject = await pool.query('SELECT name, code FROM subjects WHERE id=$1', [subjectId]);

    const studentName = student.rows[0]?.name || 'Student';
    const subjectName = subject.rows[0]?.name || 'Subject';

    // Check if grade record exists
    const exists = await pool.query(
      'SELECT id FROM grades WHERE student_id=$1 AND subject_id=$2',
      [studentId, subjectId]
    );

    let result;
    if (exists.rows.length > 0) {
      result = await pool.query(
        `UPDATE grades SET
           div1_assessments = $1,
           div2_capstone = $2,
           div3_class_lab = $3,
           div4_univ_lab = $4,
           div5_univ_exam = $5,
           total_internal = $6,
           grand_total = $7,
           grade_letter = $8,
           score = $9,
           is_submitted = TRUE,
           date = NOW()
         WHERE id = $10
         RETURNING *`,
        [d1, d2, d3, d4, d5, totalInternal, grandTotal, gradeLetter, String(grandTotal), exists.rows[0].id]
      );
    } else {
      result = await pool.query(
        `INSERT INTO grades (
           student_id, student_name, subject_id, subject_name, week,
           div1_assessments, div2_capstone, div3_class_lab, div4_univ_lab, div5_univ_exam,
           total_internal, grand_total, grade_letter, score, is_submitted
         ) VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,TRUE)
         RETURNING *`,
        [studentId, studentName, subjectId, subjectName, d1, d2, d3, d4, d5, totalInternal, grandTotal, gradeLetter, String(grandTotal)]
      );
    }

    await notify(
      studentId,
      'internal_marks',
      'Internal Marks Updated 📊',
      `Your marks for "${subjectName}" (Internal Total: ${totalInternal}/400) have been submitted by faculty.`,
      result.rows[0].id
    );

    await logAction(req.user.id, req.user.name, req.user.role, 'submit_grades', 'grades', result.rows[0].id, null, {
      studentId, subjectId, totalInternal, grandTotal
    });

    res.json(result.rows[0]);
  } catch (err) {
    console.error('[Grades Submit Divisions] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /close-course/:subjectId — Faculty completes & closes course for exams
router.post('/close-course/:subjectId', authenticate, requireFaculty, async (req, res) => {
  const { subjectId } = req.params;
  const { examDate, examSession, examHall } = req.body;

  try {
    const subject = await pool.query('SELECT * FROM subjects WHERE id=$1', [subjectId]);
    if (!subject.rows[0]) return res.status(404).json({ error: 'Course not found' });

    const finalExamDate = examDate || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const finalExamSession = examSession || 'FN (09:30 AM - 12:30 PM)';
    const finalExamHall = examHall || 'University Exam Block - Hall A';

    const r = await pool.query(
      `UPDATE subjects SET
         is_closed = TRUE,
         is_launched = FALSE,
         exam_date = $1,
         exam_session = $2,
         exam_hall = $3
       WHERE id = $4
       RETURNING *`,
      [finalExamDate, finalExamSession, finalExamHall, subjectId]
    );

    // Notify all enrolled students
    const enrolledStudents = await pool.query(
      `SELECT student_id FROM enrollment_requests WHERE subject_id=$1 AND status='enrolled'`,
      [subjectId]
    );

    for (const stu of enrolledStudents.rows) {
      await notify(
        stu.student_id,
        'hall_ticket_ready',
        '🎟️ University Hall Ticket Ready!',
        `Course "${subject.rows[0].name}" (${subject.rows[0].code}) is closed for exams. You can now generate your University Hall Ticket!`,
        subjectId
      );
    }

    await logAction(req.user.id, req.user.name, req.user.role, 'close_course', 'subjects', subjectId);
    res.json({ message: 'Course closed successfully and Hall Tickets unlocked for students', subject: r.rows[0] });
  } catch (err) {
    console.error('[Close Course] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /hall-ticket — Student generates University Exam Hall Ticket
router.get('/hall-ticket', authenticate, async (req, res) => {
  try {
    const student = await pool.query(
      `SELECT u.id, u.name, u.admin_id, u.department, u.email
       FROM users u WHERE u.id=$1`,
      [req.user.id]
    );

    if (!student.rows[0]) return res.status(404).json({ error: 'Student profile not found' });

    // Find all enrolled courses
    const courses = await pool.query(
      `SELECT s.id as subject_id, s.name as subject_name, s.code as course_code, s.subject_type,
              s.is_closed, s.exam_date, s.exam_session, s.exam_hall,
              COALESCE(g.total_internal, 0) as total_internal,
              COALESCE(g.is_submitted, false) as is_marks_submitted
       FROM enrollment_requests er
       JOIN subjects s ON er.subject_id = s.id
       LEFT JOIN grades g ON (g.student_id = er.student_id AND g.subject_id = s.id)
       WHERE er.student_id = $1 AND er.status = 'enrolled'`,
      [req.user.id]
    );

    // Attendance calculation
    const attResult = await pool.query(
      `SELECT 
         COUNT(*) as total_days,
         COUNT(CASE WHEN status IN ('Present', 'OD') THEN 1 END) as attended_days
       FROM attendance WHERE student_id = $1`,
      [req.user.id]
    );

    const totalDays = parseInt(attResult.rows[0]?.total_days || 0, 10);
    const attendedDays = parseInt(attResult.rows[0]?.attended_days || 0, 10);
    const attendancePct = totalDays > 0 ? Math.round((attendedDays / totalDays) * 100) : 88;

    const qrVerificationCode = crypto.createHash('sha256')
      .update(`${student.rows[0].admin_id}_${Date.now()}`)
      .digest('hex').slice(0, 16).toUpperCase();

    res.json({
      student: student.rows[0],
      attendancePct,
      isEligible: attendancePct >= 75,
      qrVerificationCode,
      generatedAt: new Date().toISOString(),
      courses: courses.rows
    });
  } catch (err) {
    console.error('[Hall Ticket GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Legacy POST for compatibility
router.post('/', authenticate, requireFaculty, async (req, res) => {
  const { studentId, studentName, subjectId, subjectName, week, score } = req.body;
  if (!studentId || !subjectId) return res.status(400).json({ error: 'Missing fields' });
  try {
    const exists = await pool.query('SELECT id FROM grades WHERE student_id=$1 AND subject_id=$2', [studentId, subjectId]);
    let r;
    if (exists.rows.length > 0) {
      r = await pool.query('UPDATE grades SET score=$1, date=NOW() WHERE id=$2 RETURNING *', [score, exists.rows[0].id]);
    } else {
      r = await pool.query(
        `INSERT INTO grades (student_id, student_name, subject_id, subject_name, week, score, is_submitted)
         VALUES ($1,$2,$3,$4,$5,$6,TRUE) RETURNING *`,
        [studentId, studentName, subjectId, subjectName, week || 1, score]
      );
    }
    res.status(201).json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
