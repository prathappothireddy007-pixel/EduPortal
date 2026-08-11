const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { logAction } = require('../services/audit');

const scoreToGrade = (avg) => {
  if (avg >= 90) return 'S';
  if (avg >= 80) return 'A';
  if (avg >= 70) return 'B';
  if (avg >= 60) return 'C';
  if (avg >= 50) return 'D';
  return 'F';
};

const getSetting = async (key, fallback = '75') => {
  try {
    const r = await pool.query('SELECT value FROM settings WHERE key=$1', [key]);
    return parseFloat(r.rows[0]?.value ?? fallback);
  } catch { return parseFloat(fallback); }
};

// GET /risk - faculty only: compute risk for ALL students
router.get('/risk', authenticate, requireFaculty, async (req, res) => {
  try {
    const attendThreshHigh = await getSetting('academic_risk_attend_high', '60');
    const attendThreshMod  = await getSetting('academic_risk_attend_mod',  '75');
    const gradeThreshHigh  = await getSetting('academic_risk_grade_high',  '50');
    const gradeThreshMod   = await getSetting('academic_risk_grade_mod',   '60');

    const students = await pool.query(
      `SELECT id, name, class_id FROM users
       WHERE role='student' AND deleted_at IS NULL ORDER BY name`
    );

    const results = [];
    for (const s of students.rows) {
      // Attendance %
      const attRes = await pool.query(
        `SELECT COUNT(*) as total,
                COUNT(*) FILTER (WHERE status IN ('Present','OD')) as attended
         FROM attendance WHERE student_id=$1`, [s.id]
      );
      const att = attRes.rows[0];
      const total = parseInt(att.total, 10) || 0;
      const attendedDays = parseInt(att.attended, 10) || 0;
      const attendPct = total > 0 ? (attendedDays / total) * 100 : 100;

      // Average grade
      const gradeRes = await pool.query(
        `SELECT AVG(CAST(score AS FLOAT)) as avg
         FROM grades WHERE student_id=$1 AND score ~ '^[0-9]+(\\.[0-9]+)?$'`, [s.id]
      );
      const avgGrade = parseFloat(gradeRes.rows[0]?.avg ?? 100);

      // Risk classification
      const reasons = [];
      let riskLevel = 'low';

      if (attendPct < attendThreshHigh && avgGrade < gradeThreshHigh) {
        riskLevel = 'high';
        reasons.push(`Attendance critically low at ${attendPct.toFixed(1)}%`);
        reasons.push(`Average grade critically low at ${avgGrade.toFixed(1)}%`);
      } else if (attendPct < attendThreshMod || avgGrade < gradeThreshMod) {
        riskLevel = 'moderate';
        if (attendPct < attendThreshMod) reasons.push(`Attendance below threshold: ${attendPct.toFixed(1)}%`);
        if (avgGrade < gradeThreshMod)   reasons.push(`Average grade below threshold: ${avgGrade.toFixed(1)}%`);
      }

      // Persist to academic_risk
      await pool.query(
        `INSERT INTO academic_risk (student_id, risk_level, reasons_json, calculated_at)
         VALUES ($1,$2,$3,NOW())
         ON CONFLICT (student_id) DO UPDATE
           SET risk_level=$2, reasons_json=$3, calculated_at=NOW()`,
        [s.id, riskLevel, JSON.stringify(reasons)]
      );

      results.push({
        student_id: s.id, name: s.name, class_id: s.class_id,
        attend_pct: Math.round(attendPct * 10) / 10,
        avg_grade: Math.round(avgGrade * 10) / 10,
        grade_label: scoreToGrade(avgGrade),
        risk_level: riskLevel, reasons
      });
    }

    const order = { high: 0, moderate: 1, low: 2 };
    results.sort((a, b) => order[a.risk_level] - order[b.risk_level]);

    const summary = {
      high:     results.filter(r => r.risk_level === 'high').length,
      moderate: results.filter(r => r.risk_level === 'moderate').length,
      low:      results.filter(r => r.risk_level === 'low').length,
      total:    results.length
    };

    res.json({ summary, students: results });
  } catch (err) {
    console.error('[Academic Risk] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /risk/:studentId - risk for a single student
router.get('/risk/:studentId', authenticate, async (req, res) => {
  const sid = req.params.studentId;
  if (req.user.role === 'student' && String(req.user.id) !== String(sid)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  try {
    const r = await pool.query(
      `SELECT ar.*, u.name FROM academic_risk ar
       JOIN users u ON ar.student_id=u.id
       WHERE ar.student_id=$1`, [sid]
    );
    if (!r.rows[0]) return res.json({ risk_level: 'low', reasons: [] });
    const row = r.rows[0];
    res.json({ ...row, reasons: JSON.parse(row.reasons_json || '[]') });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /trends/:studentId
router.get('/trends/:studentId', authenticate, async (req, res) => {
  const sid = req.params.studentId;
  if (req.user.role === 'student' && String(req.user.id) !== String(sid)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  try {
    const r = await pool.query(
      `SELECT subject_name, subject_id, week,
              AVG(CAST(score AS FLOAT)) as avg_score
       FROM grades
       WHERE student_id=$1 AND score ~ '^[0-9]+(\\.[0-9]+)?$'
       GROUP BY subject_name, subject_id, week
       ORDER BY subject_name, week`,
      [sid]
    );
    const subjectMap = {};
    for (const row of r.rows) {
      if (!subjectMap[row.subject_name]) {
        subjectMap[row.subject_name] = { subject: row.subject_name, subject_id: row.subject_id, weeks: [], scores: [] };
      }
      subjectMap[row.subject_name].weeks.push(row.week);
      subjectMap[row.subject_name].scores.push(Math.round(parseFloat(row.avg_score) * 10) / 10);
    }
    res.json(Object.values(subjectMap));
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST /simulate - stateless what-if calculator
router.post('/simulate', authenticate, async (req, res) => {
  const { studentId, additionalScore } = req.body;
  const sid = studentId || req.user.id;
  if (req.user.role === 'student' && String(req.user.id) !== String(sid)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const newScore = parseFloat(additionalScore);
  if (isNaN(newScore) || newScore < 0 || newScore > 100) {
    return res.status(400).json({ error: 'additionalScore must be 0-100' });
  }
  try {
    const r = await pool.query(
      `SELECT CAST(score AS FLOAT) as score
       FROM grades WHERE student_id=$1 AND score ~ '^[0-9]+(\\.[0-9]+)?$'`,
      [sid]
    );
    const scores = r.rows.map(row => parseFloat(row.score));
    const currentAvg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const projectedScores = [...scores, newScore];
    const projectedAvg = projectedScores.reduce((a, b) => a + b, 0) / projectedScores.length;
    const difference = projectedAvg - currentAvg;

    res.json({
      currentAvg:     Math.round(currentAvg * 100) / 100,
      projectedAvg:   Math.round(projectedAvg * 100) / 100,
      currentGrade:   scoreToGrade(currentAvg),
      projectedGrade: scoreToGrade(projectedAvg),
      difference:     Math.round(difference * 100) / 100,
      totalGrades:    scores.length,
      newScore
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET /attendance-shortage/:studentId
router.get('/attendance-shortage/:studentId', authenticate, async (req, res) => {
  const sid = req.params.studentId;
  if (req.user.role === 'student' && String(req.user.id) !== String(sid)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  try {
    const threshold = await getSetting('attendance_threshold', '75');
    const r = await pool.query(
      `SELECT COUNT(*) as total,
              COUNT(*) FILTER (WHERE status IN ('Present','OD')) as attended
       FROM attendance WHERE student_id=$1`, [sid]
    );
    const { total, attended } = r.rows[0];
    const totalClasses  = parseInt(total, 10) || 0;
    const attendedClasses = parseInt(attended, 10) || 0;
    const currentPct = totalClasses > 0 ? (attendedClasses / totalClasses) * 100 : 100;

    let message = '';
    let canMiss = 0;
    let mustAttend = 0;

    if (currentPct >= threshold) {
      canMiss = Math.floor(attendedClasses / (threshold / 100) - totalClasses);
      canMiss = Math.max(0, canMiss);
      message = `You can miss up to ${canMiss} more class${canMiss !== 1 ? 'es' : ''} and remain above ${threshold}%`;
    } else {
      const t = threshold / 100;
      mustAttend = Math.ceil((t * totalClasses - attendedClasses) / (1 - t));
      mustAttend = Math.max(0, mustAttend);
      message = `You need to attend ${mustAttend} consecutive class${mustAttend !== 1 ? 'es' : ''} to reach ${threshold}%`;
    }

    res.json({
      totalClasses, attendedClasses,
      currentPct: Math.round(currentPct * 10) / 10,
      threshold, canMiss, mustAttend,
      isAboveThreshold: currentPct >= threshold,
      message
    });
  } catch (err) { console.error('[Attendance Shortage] Error:', err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
