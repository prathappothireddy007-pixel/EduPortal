const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { notify, logAction } = require('../services/audit');
const crypto = require('crypto');

// Helper to calculate Grade Letter
function calculateGrade(grandTotal) {
  const score = parseFloat(grandTotal) || 0;
  if (score >= 450) return 'O';   // 90%+ Outstanding
  if (score >= 400) return 'A+';  // 80%+ Excellent
  if (score >= 350) return 'A';   // 70%+ Very Good
  if (score >= 300) return 'B+';  // 60%+ Good
  if (score >= 250) return 'B';   // 50%+ Pass
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
               s.is_phase1_submitted, s.is_phase2_submitted, s.is_results_published as course_results_published,
               s.exam_date, s.exam_session, s.exam_hall,
               htr.status as hall_ticket_request_status, htr.id as hall_ticket_request_id
        FROM grades g
        JOIN users u ON g.student_id = u.id
        JOIN subjects s ON g.subject_id = s.id
        LEFT JOIN hall_ticket_requests htr ON (htr.student_id = g.student_id AND htr.subject_id = g.subject_id)
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
      // Student View:
      // If results are published, show all 5 divisions and grand total.
      // If not yet published, student can only view Assessment marks (Div 1) as internal marks.
      r = await pool.query(
        `SELECT g.id, g.student_id, g.subject_id, g.week,
                g.div1_assessments,
                CASE WHEN s.is_results_published IS TRUE THEN g.div2_capstone ELSE 0 END as div2_capstone,
                CASE WHEN s.is_results_published IS TRUE THEN g.div3_class_lab ELSE 0 END as div3_class_lab,
                CASE WHEN s.is_results_published IS TRUE THEN g.div4_univ_lab ELSE 0 END as div4_univ_lab,
                CASE WHEN s.is_results_published IS TRUE THEN g.div5_univ_exam ELSE 0 END as div5_univ_exam,
                CASE WHEN s.is_results_published IS TRUE THEN g.total_internal ELSE g.div1_assessments END as total_internal,
                CASE WHEN s.is_results_published IS TRUE THEN g.grand_total ELSE g.div1_assessments END as grand_total,
                CASE WHEN s.is_results_published IS TRUE THEN g.grade_letter ELSE 'In Progress' END as grade_letter,
                g.phase1_submitted, g.phase2_submitted, g.phase3_submitted,
                s.is_results_published,
                s.name as subject_name, s.code as course_code, s.is_closed as course_is_closed,
                s.exam_date, s.exam_session, s.exam_hall,
                u_fac.name as faculty_name,
                htr.status as hall_ticket_request_status, htr.id as hall_ticket_request_id
         FROM grades g
         JOIN subjects s ON g.subject_id = s.id
         LEFT JOIN users u_fac ON s.faculty_id = u_fac.id
         LEFT JOIN hall_ticket_requests htr ON (htr.student_id = g.student_id AND htr.subject_id = g.subject_id)
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

// ── 1. PHASE 1 MARKS ENTRY: Faculty enters Assessment (Div 1) and Class Lab (Div 3) marks ──
router.post('/submit-phase1', authenticate, requireFaculty, async (req, res) => {
  const { studentId, subjectId, div1Assessments, div3ClassLab } = req.body;

  if (!studentId || !subjectId) {
    return res.status(400).json({ error: 'studentId and subjectId are required' });
  }

  const d1 = Math.min(100, Math.max(0, parseFloat(div1Assessments) || 0));
  const d3 = Math.min(100, Math.max(0, parseFloat(div3ClassLab) || 0));

  try {
    const student = await pool.query('SELECT name FROM users WHERE id=$1', [studentId]);
    const subject = await pool.query('SELECT name, code FROM subjects WHERE id=$1', [subjectId]);

    const studentName = student.rows[0]?.name || 'Student';
    const subjectName = subject.rows[0]?.name || 'Subject';

    const exists = await pool.query(
      'SELECT id, div2_capstone, div4_univ_lab, div5_univ_exam FROM grades WHERE student_id=$1 AND subject_id=$2',
      [studentId, subjectId]
    );

    let result;
    if (exists.rows.length > 0) {
      const d2 = parseFloat(exists.rows[0].div2_capstone) || 0;
      const d4 = parseFloat(exists.rows[0].div4_univ_lab) || 0;
      const d5 = parseFloat(exists.rows[0].div5_univ_exam) || 0;
      const totalInternal = d1 + d2 + d3 + d4;
      const grandTotal = totalInternal + d5;
      const gradeLetter = calculateGrade(grandTotal);

      result = await pool.query(
        `UPDATE grades SET
           div1_assessments = $1,
           div3_class_lab = $2,
           total_internal = $3,
           grand_total = $4,
           grade_letter = $5,
           phase1_submitted = TRUE,
           date = NOW()
         WHERE id = $6
         RETURNING *`,
        [d1, d3, totalInternal, grandTotal, gradeLetter, exists.rows[0].id]
      );
    } else {
      const totalInternal = d1 + d3;
      const grandTotal = totalInternal;
      const gradeLetter = calculateGrade(grandTotal);

      result = await pool.query(
        `INSERT INTO grades (
           student_id, student_name, subject_id, subject_name, week,
           div1_assessments, div2_capstone, div3_class_lab, div4_univ_lab, div5_univ_exam,
           total_internal, grand_total, grade_letter, score, phase1_submitted
         ) VALUES ($1,$2,$3,$4,1,$5,0,$6,0,0,$7,$8,$9,$10,TRUE)
         RETURNING *`,
        [studentId, studentName, subjectId, subjectName, d1, d3, totalInternal, grandTotal, gradeLetter, String(d1)]
      );
    }

    // Mark subject as phase1 submitted
    await pool.query('UPDATE subjects SET is_phase1_submitted = TRUE WHERE id = $1', [subjectId]);

    await notify(
      studentId,
      'assessment_marks',
      'Assessment Marks Recorded 📝',
      `Assessment marks (${d1}/100) recorded for "${subjectName}".`,
      'phase1_marks_entered',
      '📝 Phase 1 Assessment Marks Recorded',
      `Phase 1 marks (Assessments: ${d1}/100, Class Lab: ${d3}/100) recorded for "${subject.rows[0].name}".`,
      subjectId
    );

    await logAction(req.user.id, req.user.name, req.user.role, 'submit_phase1_individual', 'grades', result.rows[0].id);

    res.json({
      message: 'Phase 1 marks recorded for student!',
      grade: result.rows[0]
    });
  } catch (err) {
    console.error('[Submit Phase 1 Individual] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── 2. CLOSE COURSE / CLOSE LAUNCH: Locks enrollments & finalizes Phase 1 ──
router.post('/close-course/:subjectId', authenticate, requireFaculty, async (req, res) => {
  const { subjectId } = req.params;
  const { examDate, examSession, examHall } = req.body;

  try {
    const subject = await pool.query('SELECT * FROM subjects WHERE id=$1', [subjectId]);
    if (!subject.rows[0]) return res.status(404).json({ error: 'Course not found' });

    if (req.user.role === 'faculty' && subject.rows[0].faculty_id && subject.rows[0].faculty_id !== req.user.id) {
      return res.status(403).json({ error: 'You are only authorized to manage your own courses.' });
    }

    const finalExamDate = (examDate && String(examDate).trim()) ? String(examDate).trim() : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const finalExamSession = examSession || 'FN (09:30 AM - 12:30 PM)';
    const finalExamHall = examHall || 'University Exam Block - Hall A';

    const r = await pool.query(
      `UPDATE subjects SET
         is_closed = TRUE,
         is_launched = FALSE,
         is_phase1_submitted = TRUE,
         exam_date = $1,
         exam_session = $2,
         exam_hall = $3
       WHERE id = $4
       RETURNING *`,
      [finalExamDate, finalExamSession, finalExamHall, subjectId]
    );

    // Notify all enrolled students that course is closed and they must request hall ticket from faculty
    const enrolledStudents = await pool.query(
      `SELECT student_id FROM enrollment_requests WHERE subject_id=$1 AND status='enrolled'`,
      [subjectId]
    );

    for (const stu of enrolledStudents.rows) {
      await notify(
        stu.student_id,
        'course_closed_for_exam',
        '📢 Course Closed for University Exams',
        `"${subject.rows[0].name}" is closed for university exams. Please submit your Hall Ticket Request to the faculty.`,
        subjectId
      );
    }

    await logAction(req.user.id, req.user.name, req.user.role, 'close_course', 'subjects', subjectId);
    res.json({ message: 'Course launch closed successfully! Students can now request Hall Tickets.', subject: r.rows[0] });
  } catch (err) {
    console.error('[Close Course] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── 3. STUDENT HALL TICKET REQUEST TO FACULTY (Only after course launch is closed) ──
router.post('/hall-ticket/request', authenticate, async (req, res) => {
  const { subjectId } = req.body;
  if (!subjectId) return res.status(400).json({ error: 'subjectId is required' });

  try {
    const subject = await pool.query('SELECT * FROM subjects WHERE id=$1', [subjectId]);
    if (!subject.rows[0]) return res.status(404).json({ error: 'Subject not found' });

    if (!subject.rows[0].is_closed) {
      return res.status(400).json({
        error: 'Hall ticket can only be requested after the faculty closes the course launch.'
      });
    }

    const facultyId = subject.rows[0].faculty_id;

    const r = await pool.query(
      `INSERT INTO hall_ticket_requests (student_id, subject_id, faculty_id, status, request_date)
       VALUES ($1, $2, $3, 'requested', NOW())
       ON CONFLICT (student_id, subject_id)
       DO UPDATE SET status = 'requested', request_date = NOW()
       RETURNING *`,
      [req.user.id, subjectId, facultyId]
    );

    // Notify faculty of the request
    if (facultyId) {
      await notify(
        facultyId,
        'hall_ticket_request',
        '🎟️ Hall Ticket Request Received',
        `Student "${req.user.name}" requested Hall Ticket generation for "${subject.rows[0].name}".`,
        r.rows[0].id
      );
    }

    await logAction(req.user.id, req.user.name, 'student', 'request_hall_ticket', 'hall_ticket_requests', r.rows[0].id);

    res.json({ message: 'Hall ticket request sent to faculty successfully!', request: r.rows[0] });
  } catch (err) {
    console.error('[Hall Ticket Request] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── 4. FACULTY LISTS PENDING HALL TICKET REQUESTS ──
router.get('/hall-ticket/requests', authenticate, requireFaculty, async (req, res) => {
  try {
    const isStaff = req.user.role === 'faculty' || req.user.role === 'admin';
    let query = `
      SELECT htr.*, 
             u.name as student_name, u.admin_id as student_reg_no, u.department as student_dept,
             s.name as subject_name, s.code as course_code, s.is_closed as course_is_closed,
             s.exam_date, s.exam_session, s.exam_hall,
             g.div1_assessments, g.total_internal
      FROM hall_ticket_requests htr
      JOIN users u ON htr.student_id = u.id
      JOIN subjects s ON htr.subject_id = s.id
      LEFT JOIN grades g ON (g.student_id = htr.student_id AND g.subject_id = htr.subject_id)
      WHERE 1=1
    `;
    const params = [];
    if (req.user.role === 'faculty') {
      query += ` AND (htr.faculty_id = $1 OR s.faculty_id = $1)`;
      params.push(req.user.id);
    }
    query += ` ORDER BY htr.request_date DESC`;

    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) {
    console.error('[Hall Ticket Requests GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── 5. FACULTY APPROVES HALL TICKET GENERATION ──
router.put('/hall-ticket/approve/:requestId', authenticate, requireFaculty, async (req, res) => {
  const { requestId } = req.params;

  try {
    const reqRow = await pool.query(
      `SELECT htr.*, u.name as student_name, u.admin_id, s.name as subject_name
       FROM hall_ticket_requests htr
       JOIN users u ON htr.student_id = u.id
       JOIN subjects s ON htr.subject_id = s.id
       WHERE htr.id = $1`,
      [requestId]
    );

    if (!reqRow.rows[0]) return res.status(404).json({ error: 'Hall ticket request not found' });

    const student = reqRow.rows[0];
    const token = crypto.createHash('sha256')
      .update(`${student.admin_id}_${student.subject_id}_${Date.now()}`)
      .digest('hex').slice(0, 16).toUpperCase();

    const r = await pool.query(
      `UPDATE hall_ticket_requests SET
         status = 'approved',
         approved_at = NOW(),
         hall_ticket_token = $1
       WHERE id = $2
       RETURNING *`,
      [token, requestId]
    );

    await notify(
      student.student_id,
      'hall_ticket_approved',
      '🎟️ Hall Ticket Approved & Generated!',
      `Faculty has approved and generated your official University Hall Ticket for "${student.subject_name}".`,
      r.rows[0].id
    );

    await logAction(req.user.id, req.user.name, req.user.role, 'approve_hall_ticket', 'hall_ticket_requests', requestId);

    res.json({ message: 'Hall ticket approved and issued to student!', request: r.rows[0] });
  } catch (err) {
    console.error('[Approve Hall Ticket] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── 6. STUDENT GENERATES & DOWNLOADS UNIVERSITY EXAM HALL TICKET ──
router.get('/hall-ticket', authenticate, async (req, res) => {
  try {
    const student = await pool.query(
      `SELECT u.id, u.name, u.admin_id, u.department, u.email
       FROM users u WHERE u.id=$1`,
      [req.user.id]
    );

    if (!student.rows[0]) return res.status(404).json({ error: 'Student profile not found' });

    // Find all enrolled courses with closed status & hall ticket approval
    const courses = await pool.query(
      `SELECT s.id as subject_id, s.name as subject_name, s.code as course_code, s.subject_type,
              s.is_closed, s.exam_date, s.exam_session, s.exam_hall,
              u_fac.name as faculty_name,
              COALESCE(g.div1_assessments, 0) as assessment_marks,
              COALESCE(g.total_internal, 0) as total_internal,
              htr.id as request_id,
              COALESCE(htr.status, 'not_requested') as request_status,
              htr.hall_ticket_token
       FROM enrollment_requests er
       JOIN subjects s ON er.subject_id = s.id
       LEFT JOIN users u_fac ON s.faculty_id = u_fac.id
       LEFT JOIN grades g ON (g.student_id = er.student_id AND g.subject_id = s.id)
       LEFT JOIN hall_ticket_requests htr ON (htr.student_id = er.student_id AND htr.subject_id = s.id)
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
      .update(`${student.rows[0].admin_id}_HT_${Date.now()}`)
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

// ── 7. PHASE 2 MARKS ENTRY: Faculty enters Capstone (Div 2) and Univ Lab (Div 4) marks ──
router.post('/submit-phase2', authenticate, requireFaculty, async (req, res) => {
  const { studentId, subjectId, div2Capstone, div4UnivLab } = req.body;

  if (!studentId || !subjectId) {
    return res.status(400).json({ error: 'studentId and subjectId are required' });
  }

  const d2 = Math.min(100, Math.max(0, parseFloat(div2Capstone) || 0));
  const d4 = Math.min(100, Math.max(0, parseFloat(div4UnivLab) || 0));

  try {
    const subject = await pool.query('SELECT name, faculty_id, is_closed FROM subjects WHERE id=$1', [subjectId]);
    if (!subject.rows[0]) return res.status(404).json({ error: 'Subject not found' });
    if (req.user.role === 'faculty' && subject.rows[0].faculty_id && subject.rows[0].faculty_id !== req.user.id) {
      return res.status(403).json({ error: 'You are only authorized to enter marks for your own courses.' });
    }
    if (!subject.rows[0]?.is_closed) {
      return res.status(400).json({ error: 'Course launch must be closed before entering Phase 2 (Capstone & University Lab) marks.' });
    }

    const exists = await pool.query(
      'SELECT id, div1_assessments, div3_class_lab, div5_univ_exam FROM grades WHERE student_id=$1 AND subject_id=$2',
      [studentId, subjectId]
    );

    let result;
    if (exists.rows.length > 0) {
      const d1 = parseFloat(exists.rows[0].div1_assessments) || 0;
      const d3 = parseFloat(exists.rows[0].div3_class_lab) || 0;
      const d5 = parseFloat(exists.rows[0].div5_univ_exam) || 0;
      const totalInternal = d1 + d2 + d3 + d4;
      const grandTotal = totalInternal + d5;
      const gradeLetter = calculateGrade(grandTotal);

      result = await pool.query(
        `UPDATE grades SET
           div2_capstone = $1,
           div4_univ_lab = $2,
           total_internal = $3,
           grand_total = $4,
           grade_letter = $5,
           phase2_submitted = TRUE,
           date = NOW()
         WHERE id = $6
         RETURNING *`,
        [d2, d4, totalInternal, grandTotal, gradeLetter, exists.rows[0].id]
      );
    } else {
      const totalInternal = d2 + d4;
      result = await pool.query(
        `INSERT INTO grades (
           student_id, subject_id, div2_capstone, div4_univ_lab,
           total_internal, grand_total, phase2_submitted
         ) VALUES ($1,$2,$3,$4,$5,$5,TRUE)
         RETURNING *`,
        [studentId, subjectId, d2, d4, totalInternal]
      );
    }

    await pool.query('UPDATE subjects SET is_phase2_submitted = TRUE WHERE id = $1', [subjectId]);
    await logAction(req.user.id, req.user.name, req.user.role, 'submit_phase2_grades', 'grades', result.rows[0].id);

    res.json({ message: 'Phase 2 marks (Capstone & University Lab) recorded successfully!', grade: result.rows[0] });
  } catch (err) {
    console.error('[Submit Phase 2] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── 8. PHASE 3 MARKS ENTRY: Faculty enters Main Univ Exam (Div 5) & Publishes Results ──
router.post('/submit-phase3-results', authenticate, requireFaculty, async (req, res) => {
  const { subjectId, studentMarks } = req.body;
  // studentMarks is an array of { studentId, div5UnivExam }

  if (!subjectId) return res.status(400).json({ error: 'subjectId is required' });

  try {
    const subject = await pool.query('SELECT name, code, faculty_id FROM subjects WHERE id=$1', [subjectId]);
    if (!subject.rows[0]) return res.status(404).json({ error: 'Subject not found' });
    if (req.user.role === 'faculty' && subject.rows[0].faculty_id && subject.rows[0].faculty_id !== req.user.id) {
      return res.status(403).json({ error: 'You are only authorized to enter marks for your own courses.' });
    }

    if (Array.isArray(studentMarks) && studentMarks.length > 0) {
      for (const sm of studentMarks) {
        const d5 = Math.min(100, Math.max(0, parseFloat(sm.div5UnivExam) || 0));

        const gradeRow = await pool.query(
          'SELECT id, div1_assessments, div2_capstone, div3_class_lab, div4_univ_lab FROM grades WHERE student_id=$1 AND subject_id=$2',
          [sm.studentId, subjectId]
        );

        if (gradeRow.rows.length > 0) {
          const d1 = parseFloat(gradeRow.rows[0].div1_assessments) || 0;
          const d2 = parseFloat(gradeRow.rows[0].div2_capstone) || 0;
          const d3 = parseFloat(gradeRow.rows[0].div3_class_lab) || 0;
          const d4 = parseFloat(gradeRow.rows[0].div4_univ_lab) || 0;
          const totalInternal = d1 + d2 + d3 + d4; // Max 400
          const grandTotal = totalInternal + d5;   // Max 500
          const gradeLetter = calculateGrade(grandTotal);

          await pool.query(
            `UPDATE grades SET
               div5_univ_exam = $1,
               total_internal = $2,
               grand_total = $3,
               grade_letter = $4,
               score = $5,
               phase3_submitted = TRUE,
               is_results_published = TRUE,
               is_submitted = TRUE,
               date = NOW()
             WHERE id = $6`,
            [d5, totalInternal, grandTotal, gradeLetter, String(grandTotal), gradeRow.rows[0].id]
          );

          // Notify student
          await notify(
            sm.studentId,
            'results_published',
            '🎉 Official Examination Results Published!',
            `Results published for "${subject.rows[0].name}" (${subject.rows[0].code}). Grade: ${gradeLetter} (${grandTotal}/500).`,
            gradeRow.rows[0].id
          );
        }
      }
    }

    // Mark subject results as published
    await pool.query('UPDATE subjects SET is_results_published = TRUE WHERE id = $1', [subjectId]);
    await logAction(req.user.id, req.user.name, req.user.role, 'publish_results', 'subjects', subjectId);

    res.json({
      message: 'Main University Exam marks submitted and Official Results published successfully for all students!'
    });
  } catch (err) {
    console.error('[Submit Phase 3 Results] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── 8B. PHASE 3 INDIVIDUAL MARKS ENTRY: Faculty enters Main Univ Exam (Div 5) for a single student ──
router.post('/submit-phase3-individual', authenticate, requireFaculty, async (req, res) => {
  const { studentId, subjectId, div5UnivExam } = req.body;

  if (!studentId || !subjectId) {
    return res.status(400).json({ error: 'studentId and subjectId are required' });
  }

  const d5 = Math.min(100, Math.max(0, parseFloat(div5UnivExam) || 0));

  try {
    const subject = await pool.query('SELECT name, code, faculty_id FROM subjects WHERE id=$1', [subjectId]);
    if (!subject.rows[0]) return res.status(404).json({ error: 'Subject not found' });
    if (req.user.role === 'faculty' && subject.rows[0].faculty_id && subject.rows[0].faculty_id !== req.user.id) {
      return res.status(403).json({ error: 'You are only authorized to enter marks for your own courses.' });
    }

    const gradeRow = await pool.query(
      'SELECT id, div1_assessments, div2_capstone, div3_class_lab, div4_univ_lab FROM grades WHERE student_id=$1 AND subject_id=$2',
      [studentId, subjectId]
    );

    let result;
    if (gradeRow.rows.length > 0) {
      const d1 = parseFloat(gradeRow.rows[0].div1_assessments) || 0;
      const d2 = parseFloat(gradeRow.rows[0].div2_capstone) || 0;
      const d3 = parseFloat(gradeRow.rows[0].div3_class_lab) || 0;
      const d4 = parseFloat(gradeRow.rows[0].div4_univ_lab) || 0;
      const totalInternal = d1 + d2 + d3 + d4;
      const grandTotal = totalInternal + d5;
      const gradeLetter = calculateGrade(grandTotal);

      result = await pool.query(
        `UPDATE grades SET
           div5_univ_exam = $1,
           total_internal = $2,
           grand_total = $3,
           grade_letter = $4,
           score = $5,
           phase3_submitted = TRUE,
           is_results_published = TRUE,
           is_submitted = TRUE,
           date = NOW()
         WHERE id = $6
         RETURNING *`,
        [d5, totalInternal, grandTotal, gradeLetter, String(grandTotal), gradeRow.rows[0].id]
      );
    } else {
      const grandTotal = d5;
      const gradeLetter = calculateGrade(grandTotal);
      result = await pool.query(
        `INSERT INTO grades (
           student_id, subject_id, div5_univ_exam,
           total_internal, grand_total, grade_letter, score, phase3_submitted, is_results_published, is_submitted
         ) VALUES ($1,$2,$3,0,$4,$5,$6,TRUE,TRUE,TRUE)
         RETURNING *`,
        [studentId, subjectId, d5, grandTotal, gradeLetter, String(grandTotal)]
      );
    }

    // Notify student
    await notify(
      studentId,
      'results_published',
      '🎉 University Exam Marks Recorded!',
      `University Exam marks (${d5}/100) recorded for "${subject.rows[0].name}". Total: ${result.rows[0].grand_total}/500 (${result.rows[0].grade_letter}).`,
      result.rows[0].id
    );

    await logAction(req.user.id, req.user.name, req.user.role, 'submit_phase3_individual', 'grades', result.rows[0].id);

    res.json({
      message: 'University Exam marks recorded for student!',
      grade: result.rows[0]
    });
  } catch (err) {
    console.error('[Submit Phase 3 Individual] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── 9. SEMESTER RESULTS TRANSCRIPT (Student View) ──
router.get('/results', authenticate, async (req, res) => {
  try {
    const studentId = req.user.id;
    const r = await pool.query(
      `SELECT g.id, g.student_id, g.student_name, g.subject_id,
              g.div1_assessments, g.div2_capstone, g.div3_class_lab, g.div4_univ_lab, g.div5_univ_exam,
              g.total_internal, g.grand_total, g.grade_letter, g.date as published_date,
              s.name as subject_name, s.code as course_code, s.subject_type,
              s.is_results_published,
              u_fac.name as faculty_name
       FROM grades g
       JOIN subjects s ON g.subject_id = s.id
       LEFT JOIN users u_fac ON s.faculty_id = u_fac.id
       WHERE g.student_id = $1 AND s.is_results_published = TRUE
       ORDER BY s.code, s.name`,
      [studentId]
    );

    // Calculate Semester GPA
    const publishedCourses = r.rows;
    let totalScore = 0;
    publishedCourses.forEach(c => {
      totalScore += (parseFloat(c.grand_total) || 0) / 50; // out of 10
    });
    const gpa = publishedCourses.length > 0 ? (totalScore / publishedCourses.length).toFixed(2) : '0.00';

    res.json({
      results: publishedCourses,
      gpa,
      totalPassed: publishedCourses.filter(c => c.grade_letter !== 'RA').length,
      totalArrears: publishedCourses.filter(c => c.grade_letter === 'RA').length
    });
  } catch (err) {
    console.error('[Results GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
