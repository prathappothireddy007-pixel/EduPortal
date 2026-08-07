const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { generateStudentReport } = require('../services/ppt');
const { sendPPTReport } = require('../services/email');

// POST /api/reports/ppt/:studentId
router.post('/ppt/:studentId', authenticate, requireFaculty, async (req, res) => {
  const { studentId } = req.params;
  console.log(`[PPT] Starting report generation for student ${studentId}`);

  try {
    // Fetch student
    const sRes = await pool.query(
      `SELECT u.*, c.name as class_name
       FROM users u
       LEFT JOIN classes c ON u.class_id = c.id
       WHERE u.id=$1 AND u.role='student'`, [studentId]
    );
    const student = sRes.rows[0];
    if (!student) {
      console.log('[PPT] Student not found:', studentId);
      return res.status(404).json({ error: 'Student not found' });
    }
    console.log(`[PPT] Found student: ${student.name}`);

    // Fetch grades and attendance
    const grades = (await pool.query(
      'SELECT * FROM grades WHERE student_id=$1 ORDER BY week', [studentId]
    )).rows;
    const attendance = (await pool.query(
      'SELECT * FROM attendance WHERE student_id=$1 ORDER BY date', [studentId]
    )).rows;
    console.log(`[PPT] Grades: ${grades.length}, Attendance: ${attendance.length}`);

    // Generate PPT
    console.log('[PPT] Generating slides...');
    const buffer = await generateStudentReport(student, grades, attendance, student.class_name);
    console.log(`[PPT] Generated! Buffer: ${buffer.length} bytes`);

    // Send email to parent
    const fileName = `${student.name.replace(/\s+/g, '_')}_Weekly_Report.pptx`;
    let emailSent = false;
    if (student.parent_email) {
      try {
        console.log(`[PPT] Sending email to ${student.parent_email}...`);
        await sendPPTReport(student.parent_email, student.name, buffer, fileName);
        emailSent = true;
        console.log('[PPT] Email sent successfully');
      } catch (emailErr) {
        console.error('[PPT] Email failed:', emailErr.message);
      }
    } else {
      console.log('[PPT] No parent email configured');
    }

    // Return the file as download
    res.setHeader('Content-Type',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.setHeader('X-Email-Sent', emailSent ? 'true' : 'false');
    console.log('[PPT] Sending file to client...');
    res.send(Buffer.from(buffer));
  } catch (err) {
    console.error('[PPT] FATAL ERROR:', err.message);
    console.error(err.stack);
    res.status(500).json({ error: 'Failed to generate report: ' + err.message });
  }
});

module.exports = router;
