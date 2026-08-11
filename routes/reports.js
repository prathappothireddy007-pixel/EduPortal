const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { generateStudentReport } = require('../services/ppt');
const { sendPPTReport } = require('../services/email');

const handlePPTGeneration = async (req, res) => {
  const { studentId } = req.params;
  console.log(`[PPT] Generating report for student ${studentId}...`);

  try {
    // 1. Fetch student
    const sRes = await pool.query(
      `SELECT u.*, c.name as class_name
       FROM users u
       LEFT JOIN classes c ON u.class_id = c.id
       WHERE u.id=$1 AND u.role='student'`, [studentId]
    );
    const student = sRes.rows[0];
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // 2. Fetch grades and attendance
    const grades = (await pool.query(
      'SELECT * FROM grades WHERE student_id=$1 ORDER BY week', [studentId]
    )).rows;
    const attendance = (await pool.query(
      'SELECT * FROM attendance WHERE student_id=$1 ORDER BY date', [studentId]
    )).rows;

    // 3. Generate PPT synchronously (~1-2 seconds)
    const buffer = await generateStudentReport(student, grades, attendance, student.class_name);
    const fileName = `${student.name.replace(/\s+/g, '_')}_Weekly_Report.pptx`;

    // 4. Send PPT binary file to client
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    res.send(Buffer.from(buffer));

    // 5. Send Email in Background (Non-blocking with 5s timeout)
    if (student.parent_email) {
      Promise.race([
        sendPPTReport(student.parent_email, student.name, buffer, fileName),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Email send timeout (5s)')), 5000))
      ])
      .then(() => console.log(`[PPT] Email sent to ${student.parent_email}`))
      .catch(err => console.error(`[PPT] Email failed/timed out: ${err.message}`));
    }
  } catch (err) {
    console.error('[PPT] Generation error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate report: ' + err.message });
    }
  }
};

// Support both endpoint URLs
router.post('/ppt/:studentId', authenticate, requireFaculty, handlePPTGeneration);
router.post('/generate-ppt/:studentId', authenticate, requireFaculty, handlePPTGeneration);

module.exports = router;
