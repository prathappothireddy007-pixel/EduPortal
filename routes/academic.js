const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { logAction } = require('../services/audit');

// Grade mapping helper
function scoreToGrade(score) {
  if (score >= 90) return 'S';
  if (score >= 80) return 'A';
  if (score >= 70) return 'B';
  if (score >= 60) return 'C';
  if (score >= 50) return 'D';
  return 'F';
}

// GET /risk - faculty only: compute risk for ALL students and persist to academic_risk
router.get('/risk', authenticate, requireFaculty, async (req, res) => {
  try {
    const settingsResult = await pool.query(
      `SELECT key, value FROM settings
       WHERE key IN ('attendance_high_threshold', 'attendance_mod_threshold',
                     'grade_high_threshold', 'grade_mod_threshold')`
    );

    const settings = {};
    for (const row of settingsResult.rows) {
      settings[row.key] = parseFloat(row.value);
    }

    const attendHighThreshold = settings['attendance_high_threshold'] ?? 60;
    const attendModThreshold  = settings['attendance_mod_threshold']  ?? 75;
    const gradeHighThreshold  = settings['grade_high_threshold']      ?? 50;
    const gradeModThreshold   = settings['grade_mod_threshold']       ?? 60;

    const studentsResult = await pool.query(
      "SELECT u.id, u.name FROM users u WHERE u.role = 'student'"
    );

    const results = [];

    for (const student of studentsResult.rows) {
      const attendResult = await pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'present') AS present_count,
           COUNT(*) AS total_count
         FROM attendance WHERE student_id = $1`,
        [student.id]
      );

      const presentCount = parseInt(attendResult.rows[0].present_count, 10) || 0;
      const totalCount   = parseInt(attendResult.rows[0].total_count, 10)   || 0;
      const attendanceRate = totalCount > 0 ? (presentCount / totalCount) * 100 : 100;

      const gradeResult = await pool.query(
        `SELECT AVG(CASE WHEN max_score > 0 THEN (score / max_score) * 100 ELSE 0 END) AS avg_pct
         FROM grades WHERE student_id = $1`,
        [student.id]
      );

      const avgGrade = parseFloat(gradeResult.rows[0].avg_pct) || 100;

      const trendResult = await pool.query(
        `SELECT DATE_TRUNC('week', created_at) AS week,
                AVG(CASE WHEN max_score > 0 THEN (score / max_score) * 100 ELSE 0 END) AS avg_pct
         FROM grades
         WHERE student_id = $1 AND created_at >= NOW() - INTERVAL '4 weeks'
         GROUP BY DATE_TRUNC('week', created_at)
         ORDER BY week ASC`,
        [student.id]
      );

      let riskLevel;
      const reasons = [];

      if (attendanceRate < attendHighThreshold && avgGrade < gradeHighThreshold) {
        riskLevel = 'High';
        reasons.push(`Attendance ${attendanceRate.toFixed(1)}% < ${attendHighThreshold}%`);
        reasons.push(`Avg grade ${avgGrade.toFixed(1)}% < ${gradeHighThreshold}%`);
      } else if (attendanceRate < attendModThreshold || avgGrade < gradeModThreshold) {
        riskLevel = 'Moderate';
        if (attendanceRate < attendModThreshold) {
          reasons.push(`Attendance ${attendanceRate.toFixed(1)}% < ${attendModThreshold}%`);
        }
        if (avgGrade < gradeModThreshold) {
          reasons.push(`Avg grade ${avgGrade.toFixed(1)}% < ${gradeModThreshold}%`);
        }
      } else {
        riskLevel = 'Low';
      }

      await pool.query(
        `INSERT INTO academic_risk (student_id, risk_level, attendance_rate, avg_grade, reasons, computed_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (student_id) DO UPDATE
           SET risk_level = EXCLUDED.risk_level, attendance_rate = EXCLUDED.attendance_rate,
               avg_grade = EXCLUDED.avg_grade, reasons = EXCLUDED.reasons,
               computed_at = EXCLUDED.computed_at`,
        [student.id, riskLevel, attendanceRate, avgGrade, JSON.stringify(reasons)]
      );

      results.push({
        studentId: student.id,
        studentName: student.name,
        riskLevel,
        attendanceRate: parseFloat(attendanceRate.toFixed(2)),
        avgGrade: parseFloat(avgGrade.toFixed(2)),
        reasons,
        weeklyTrend: trendResult.rows,
      });
    }

    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /risk/:studentId - get risk record for one student (faculty or own student)
router.get('/risk/:studentId', authenticate, async (req, res) => {
  try {
    const { studentId } = req.params;
    const isFaculty = req.user.role === 'faculty';

    if (!isFaculty && req.user.id !== parseInt(studentId, 10)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(
      `SELECT ar.*, u.name AS student_name
       FROM academic_risk ar
       LEFT JOIN users u ON ar.student_id = u.id
       WHERE ar.student_id = $1`,
      [studentId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Risk data not found. Run GET /risk to compute.' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /trends/:studentId - weekly grade trends per subject (both roles; student sees own)
router.get('/trends/:studentId', authenticate, async (req, res) => {
  try {
    const { studentId } = req.params;
    const isFaculty = req.user.role === 'faculty';

    if (!isFaculty && req.user.id !== parseInt(studentId, 10)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(
      `SELECT s.id AS subject_id, s.name AS subject,
              DATE_TRUNC('week', g.created_at) AS week,
              AVG(CASE WHEN g.max_score > 0 THEN (g.score / g.max_score) * 100 ELSE 0 END) AS avg_pct
       FROM grades g
       LEFT JOIN subjects s ON g.subject_id = s.id
       WHERE g.student_id = $1
       GROUP BY s.id, s.name, DATE_TRUNC('week', g.created_at)
       ORDER BY s.name, week ASC`,
      [studentId]
    );

    const subjectMap = {};
    for (const row of result.rows) {
      if (!subjectMap[row.subject_id]) {
        subjectMap[row.subject_id] = { subject: row.subject, weeklyScores: [] };
      }
      subjectMap[row.subject_id].weeklyScores.push({
        week: row.week,
        avgPct: parseFloat(parseFloat(row.avg_pct).toFixed(2)),
      });
    }

    res.json(Object.values(subjectMap));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /simulate - stateless grade simulation (no DB writes)
router.post('/simulate', authenticate, async (req, res) => {
  try {
    const { studentId, additionalScore } = req.body;

    if (!studentId || additionalScore === undefined) {
      return res.status(400).json({ error: 'studentId and additionalScore are required' });
    }

    const gradesResult = await pool.query(
      'SELECT score, max_score FROM grades WHERE student_id = $1',
      [studentId]
    );

    if (gradesResult.rows.length === 0) {
      return res.status(404).json({ error: 'No grades found for student' });
    }

    const totalScore = gradesResult.rows.reduce((sum, r) => sum + parseFloat(r.score), 0);
    const totalMax   = gradesResult.rows.reduce((sum, r) => sum + parseFloat(r.max_score), 0);
    const currentAvg = totalMax > 0 ? (totalScore / totalMax) * 100 : 0;

    // Assume new assessment is out of 100
    const newTotalScore = totalScore + parseFloat(additionalScore);
    const newTotalMax   = totalMax + 100;
    const projectedAvg  = newTotalMax > 0 ? (newTotalScore / newTotalMax) * 100 : 0;

    res.json({
      currentAvg: parseFloat(currentAvg.toFixed(2)),
      projectedAvg: parseFloat(projectedAvg.toFixed(2)),
      currentGrade: scoreToGrade(currentAvg),
      projectedGrade: scoreToGrade(projectedAvg),
      difference: parseFloat((projectedAvg - currentAvg).toFixed(2)),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /attendance-shortage/:studentId - attendance shortage analysis (both roles; student sees own)
router.get('/attendance-shortage/:studentId', authenticate, async (req, res) => {
  try {
    const { studentId } = req.params;
    const isFaculty = req.user.role === 'faculty';

    if (!isFaculty && req.user.id !== parseInt(studentId, 10)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const thresholdResult = await pool.query(
      "SELECT value FROM settings WHERE key = 'attendance_threshold'"
    );
    const threshold = thresholdResult.rows.length > 0
      ? parseFloat(thresholdResult.rows[0].value)
      : 75;

    const attendResult = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'present') AS present_count,
         COUNT(*) AS total_count
       FROM attendance WHERE student_id = $1`,
      [studentId]
    );

    const presentCount = parseInt(attendResult.rows[0].present_count, 10) || 0;
    const totalCount   = parseInt(attendResult.rows[0].total_count, 10)   || 0;
    const currentPct   = totalCount > 0 ? (presentCount / totalCount) * 100 : 0;

    const thresholdDecimal = threshold / 100;
    let classesNeeded = 0;
    let classesThatCanBeMissed = 0;

    if (currentPct < threshold) {
      // Solve: (present + n) / (total + n) >= threshold/100
      const numerator   = thresholdDecimal * totalCount - presentCount;
      const denominator = 1 - thresholdDecimal;
      classesNeeded = denominator > 0 ? Math.ceil(numerator / denominator) : Infinity;
    } else {
      // Solve: present / (total + n) >= threshold/100
      const maxMiss = Math.floor(presentCount / thresholdDecimal - totalCount);
      classesThatCanBeMissed = Math.max(0, maxMiss);
    }

    res.json({
      studentId: parseInt(studentId, 10),
      presentCount,
      totalCount,
      currentPercentage: parseFloat(currentPct.toFixed(2)),
      threshold,
      isShortage: currentPct < threshold,
      classesNeededToReachThreshold: currentPct < threshold ? classesNeeded : 0,
      classesThatCanBeMissed: currentPct >= threshold ? classesThatCanBeMissed : 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
