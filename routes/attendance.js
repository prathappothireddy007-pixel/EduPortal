const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { notify, notifyRole } = require('../services/audit');

// Helper to automatically expire unverified OD requests after 30 minutes and convert attendance to Absent
async function sweepExpiredODRequests() {
  try {
    const expired = await pool.query(`
      UPDATE od_requests
      SET status = 'geo_rejected',
          rejection_reason = 'Geo-verification deadline expired: 30 minutes elapsed without 30m GPS location check-in'
      WHERE status = 'approved'
        AND attendance_marked_at IS NOT NULL
        AND NOW() > geo_deadline
      RETURNING id, student_id, date, slot, student_name, event_name
    `);

    for (const exp of expired.rows) {
      await pool.query(
        `UPDATE attendance SET status = 'Absent' WHERE student_id = $1 AND date = $2 AND (slot = $3 OR slot = 'ALL')`,
        [exp.student_id, exp.date, exp.slot]
      );
      await notify(
        exp.student_id,
        'od_expired',
        '⚠️ OD Verification Expired · Marked Absent',
        `Your 30-minute verification window for Slot ${exp.slot} (${exp.event_name}) expired without GPS check-in. Attendance has been marked Absent and percentage updated.`,
        exp.id
      );
    }
  } catch (e) {
    console.error('[Sweep Expired OD Error]:', e.message);
  }
}

// GET attendance list
router.get('/', authenticate, async (req, res) => {
  await sweepExpiredODRequests();
  const { slot, subjectId, date } = req.query;
  try {
    let query = `
      SELECT a.id, a.student_id, a.student_name, a.status, a.date, a.slot, a.subject_id,
             s.name as subject_name, s.code as subject_code, s.faculty_id
      FROM attendance a
      LEFT JOIN subjects s ON a.subject_id = s.id
      WHERE 1=1
    `;
    const params = [];

    if (req.user.role === 'student') {
      params.push(req.user.id);
      query += ` AND a.student_id = $${params.length}`;
    } else if (req.user.role === 'faculty') {
      if (subjectId) {
        params.push(subjectId);
        query += ` AND a.subject_id = $${params.length}`;
      }
    }

    if (slot && slot !== 'ALL') {
      params.push(slot.toUpperCase());
      query += ` AND a.slot = $${params.length}`;
    }

    if (date) {
      params.push(date);
      query += ` AND a.date = $${params.length}`;
    }

    query += ` ORDER BY a.date DESC, a.slot ASC, a.student_name ASC`;
    const r = await pool.query(query, params);
    res.json(r.rows);
  } catch (err) {
    console.error('[Attendance GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET student slot-wise attendance standing breakdown (Student Dashboard)
router.get('/student-standing', authenticate, async (req, res) => {
  await sweepExpiredODRequests();
  try {
    const studentId = req.user.role === 'student' ? req.user.id : (req.query.studentId || req.user.id);

    // Get active enrolled courses
    const enrolled = await pool.query(
      `SELECT s.id, s.name, s.code, s.slot, s.subject_type, u.name as faculty_name
       FROM enrollment_requests er
       JOIN subjects s ON er.subject_id = s.id
       LEFT JOIN users u ON s.faculty_id = u.id
       WHERE er.student_id = $1 AND er.status = 'enrolled'
       ORDER BY s.slot ASC, s.name ASC`,
      [studentId]
    );

    const activeSubjectIds = enrolled.rows.map(s => s.id);

    // Fetch attendance for these enrolled subjects (or general)
    let attendQuery = `SELECT * FROM attendance WHERE student_id = $1`;
    const attendParams = [studentId];
    if (activeSubjectIds.length > 0) {
      attendQuery += ` AND (subject_id = ANY($2::int[]) OR subject_id IS NULL)`;
      attendParams.push(activeSubjectIds);
    }
    const attendRows = (await pool.query(attendQuery, attendParams)).rows;

    // Slot-wise breakdown map
    const slotMap = {};
    enrolled.rows.forEach(course => {
      const slotKey = (course.slot || 'A').toUpperCase();
      if (!slotMap[slotKey]) {
        slotMap[slotKey] = {
          slot: slotKey,
          courseId: course.id,
          courseName: course.name,
          courseCode: course.code,
          facultyName: course.faculty_name || 'Faculty',
          totalSessions: 0,
          presentCount: 0,
          odCount: 0,
          absentCount: 0,
          percentage: 100
        };
      }
    });

    let overallTotal = 0;
    let overallAttended = 0;

    attendRows.forEach(row => {
      const sKey = (row.slot || 'A').toUpperCase();
      overallTotal++;
      if (row.status === 'Present' || row.status === 'OD') overallAttended++;

      if (slotMap[sKey]) {
        slotMap[sKey].totalSessions++;
        if (row.status === 'Present') slotMap[sKey].presentCount++;
        else if (row.status === 'OD') slotMap[sKey].odCount++;
        else slotMap[sKey].absentCount++;
      }
    });

    Object.values(slotMap).forEach(s => {
      if (s.totalSessions > 0) {
        s.percentage = Math.round(((s.presentCount + s.odCount) / s.totalSessions) * 100);
      }
    });

    const overallPercentage = overallTotal > 0 ? Math.round((overallAttended / overallTotal) * 100) : 100;

    res.json({
      overallPercentage,
      totalSessions: overallTotal,
      attendedSessions: overallAttended,
      slotBreakdown: Object.values(slotMap),
      enrolledCourses: enrolled.rows
    });
  } catch (err) {
    console.error('[Student Standing GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET course roster & slot attendance for faculty (with approved OD pre-population)
router.get('/course-roster/:subjectId', authenticate, requireFaculty, async (req, res) => {
  await sweepExpiredODRequests();
  const { subjectId } = req.params;
  try {
    const subject = await pool.query('SELECT * FROM subjects WHERE id=$1', [subjectId]);
    if (!subject.rows[0]) return res.status(404).json({ error: 'Course not found' });

    // Verify faculty ownership
    if (req.user.role === 'faculty' && subject.rows[0].faculty_id && subject.rows[0].faculty_id !== req.user.id) {
      return res.status(403).json({ error: 'You can only view your own courses.' });
    }

    // Get enrolled students
    const studentsRes = await pool.query(
      `SELECT u.id, u.name, u.admin_id, u.email, u.department, er.created_at as enrolled_at
       FROM enrollment_requests er
       JOIN users u ON er.student_id = u.id
       WHERE er.subject_id = $1 AND er.status = 'enrolled' AND u.deleted_at IS NULL
       ORDER BY u.admin_id ASC, u.name ASC`,
      [subjectId]
    );

    // Calculate attendance for this course
    const attendRes = await pool.query(
      `SELECT student_id, status FROM attendance WHERE subject_id = $1`,
      [subjectId]
    );

    const studentStats = {};
    attendRes.rows.forEach(a => {
      if (!studentStats[a.student_id]) studentStats[a.student_id] = { total: 0, attended: 0 };
      studentStats[a.student_id].total++;
      if (a.status === 'Present' || a.status === 'OD') studentStats[a.student_id].attended++;
    });

    // Check approved ODs for today and this subject's slot
    const todayStr = new Date().toISOString().split('T')[0];
    const targetSlot = (subject.rows[0].slot || 'A').toUpperCase();

    const activeOds = await pool.query(
      `SELECT id, student_id, event_name, location_name, letter_b64, status
       FROM od_requests
       WHERE date = $1 AND (slot = $2 OR slot = 'ALL') AND status IN ('approved', 'geo_submitted', 'completed')`,
      [todayStr, targetSlot]
    );
    const odMap = {};
    activeOds.rows.forEach(o => { odMap[o.student_id] = o; });

    const students = studentsRes.rows.map(stu => {
      const stat = studentStats[stu.id] || { total: 0, attended: 0 };
      const pct = stat.total > 0 ? Math.round((stat.attended / stat.total) * 100) : 100;
      const od = odMap[stu.id] || null;
      return {
        ...stu,
        totalSessions: stat.total,
        attendedSessions: stat.attended,
        attendancePercentage: pct,
        is_od_approved: Boolean(od),
        od_id: od ? od.id : null,
        od_event_name: od ? od.event_name : null,
        od_location_name: od ? od.location_name : null,
        od_letter: od ? od.letter_b64 : null
      };
    });

    res.json({
      subject: subject.rows[0],
      students
    });
  } catch (err) {
    console.error('[Course Roster GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST mark individual or batch slot attendance (faculty)
router.post('/', authenticate, requireFaculty, async (req, res) => {
  const { studentId, studentName, status, date, slot, subjectId, records } = req.body;
  const attDate = date || new Date().toISOString().split('T')[0];
  const targetSlot = (slot || 'A').toUpperCase();

  try {
    const items = records && Array.isArray(records) ? records : [{ studentId, studentName, status, date: attDate, slot: targetSlot, subjectId }];

    const results = [];
    for (const item of items) {
      if (!item.studentId || !item.status) continue;

      let actualStatus = item.status;
      let autoAbsent = false;
      const recDate = item.date || attDate;
      const recSlot = (item.slot || targetSlot).toUpperCase();
      const recSubId = item.subjectId || subjectId || null;

      if (actualStatus === 'OD') {
        const odCheck = await pool.query(
          `SELECT id FROM od_requests
           WHERE student_id=$1 AND date=$2
             AND (slot=$3 OR slot='ALL')
             AND status IN ('approved','geo_submitted','completed')`,
          [item.studentId, recDate, recSlot]
        );
        if (odCheck.rows.length === 0) {
          actualStatus = 'Absent';
          autoAbsent = true;
        }
      }

      // Check existing attendance for this student on this date + slot + subject
      const existing = await pool.query(
        `SELECT id FROM attendance
         WHERE student_id=$1 AND date=$2 AND slot=$3 AND COALESCE(subject_id, 0)=COALESCE($4, 0)`,
        [item.studentId, recDate, recSlot, recSubId]
      );

      let saved;
      if (existing.rows.length > 0) {
        saved = await pool.query(
          `UPDATE attendance SET status=$1, student_name=COALESCE($2, student_name)
           WHERE id=$3 RETURNING *`,
          [actualStatus, item.studentName, existing.rows[0].id]
        );
      } else {
        saved = await pool.query(
          `INSERT INTO attendance (student_id, student_name, status, date, slot, subject_id)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING *`,
          [item.studentId, item.studentName, actualStatus, recDate, recSlot, recSubId]
        );
      }

      // Trigger 30-minute verification countdown on approved OD request & send notification
      const odUpdate = await pool.query(
        `UPDATE od_requests
         SET attendance_marked_at = NOW(),
             geo_deadline = NOW() + INTERVAL '30 minutes'
         WHERE student_id = $1 AND date = $2 AND (slot = $3 OR slot = 'ALL') AND status = 'approved' AND attendance_marked_at IS NULL
         RETURNING *`,
        [item.studentId, recDate, recSlot]
      );

      if (odUpdate.rows[0]) {
        const od = odUpdate.rows[0];
        await notify(
          item.studentId,
          'od_attendance_marked',
          '⏳ Attendance Marked · 30m Check-In Window Active',
          `Attendance for Slot ${recSlot} (${item.studentName}) has been marked! You have 30 minutes to complete GPS verification within 30m of "${od.location_name || od.event_name}".`,
          od.id
        );
      }

      results.push({ ...saved.rows[0], autoAbsent });
    }

    res.json({ message: `Slot ${targetSlot} attendance saved successfully!`, results });
  } catch (err) {
    console.error('[Attendance POST] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET today's stats
router.get('/stats', authenticate, requireFaculty, async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  try {
    const r = await pool.query(
      `SELECT status, slot, COUNT(*) as count
       FROM attendance WHERE date=$1 GROUP BY status, slot`, [today]
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
