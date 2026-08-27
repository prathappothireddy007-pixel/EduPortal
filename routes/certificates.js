const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const { notify, logAction } = require('../services/audit');
const crypto = require('crypto');

// GET certificates — faculty/admin: all; student: own
router.get('/', authenticate, async (req, res) => {
  try {
    let r;
    if (req.user.role === 'faculty' || req.user.role === 'admin') {
      const { student_id } = req.query;
      const filter = student_id ? `WHERE c.student_id=$1` : '';
      const params = student_id ? [student_id] : [];
      r = await pool.query(
        `SELECT c.*, u.name as student_display_name, COALESCE(c.event_name, e.title, 'Academic Achievement') as display_event_title
         FROM certificates c
         JOIN users u ON c.student_id=u.id
         LEFT JOIN events e ON c.event_id=e.id
         ${filter} ORDER BY c.created_at DESC`, params
      );
    } else {
      r = await pool.query(
        `SELECT c.*, COALESCE(c.event_name, e.title, 'Academic Achievement') as display_event_title
         FROM certificates c
         LEFT JOIN events e ON c.event_id=e.id
         WHERE c.student_id=$1 ORDER BY c.created_at DESC`, [req.user.id]
      );
    }
    res.json(r.rows);
  } catch (err) {
    console.error('[Certificates GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /generate — faculty/admin generates certificate
router.post('/generate', authenticate, requireFaculty, async (req, res) => {
  const { studentId, eventId, eventName, hostOrg } = req.body;
  if (!studentId) return res.status(400).json({ error: 'studentId is required' });
  try {
    const student = await pool.query('SELECT name FROM users WHERE id=$1', [studentId]);
    if (!student.rows[0]) return res.status(404).json({ error: 'Student not found' });

    let finalEventName = eventName || 'Excellence in Academic Engineering Curriculum';
    let finalHostOrg = hostOrg || 'EduPortal Autonomous Institute of Technology';

    if (eventId) {
      const event = await pool.query('SELECT title, host_institution FROM events WHERE id=$1', [eventId]);
      if (event.rows[0]) {
        finalEventName = event.rows[0].title;
        finalHostOrg = event.rows[0].host_institution || finalHostOrg;
      }
    }

    const certId  = crypto.randomUUID();
    const qrToken = crypto.randomUUID();

    const r = await pool.query(
      `INSERT INTO certificates
         (student_id, event_id, cert_id, student_name, event_name, host_org, verify_qr_token)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [studentId, eventId || null, certId, student.rows[0].name, finalEventName, finalHostOrg, qrToken]
    );

    await notify(studentId, 'certificate_issued', 'Certificate Issued 🎓',
      `Your certificate for "${finalEventName}" is ready!`, r.rows[0].id);
    await logAction(req.user.id, req.user.name, req.user.role, 'generate_certificate', 'certificates', r.rows[0].id);

    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error('[Certificates Generate] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /verify/:certId — PUBLIC verification
router.get('/verify/:certId', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT cert_id, student_name, event_name, host_org, issued_date, is_valid, created_at
       FROM certificates WHERE cert_id=$1`, [req.params.certId]
    );
    if (!r.rows[0]) return res.status(404).json({ valid: false, error: 'Certificate not found' });
    const cert = r.rows[0];
    res.json({
      valid:       cert.is_valid,
      certId:      cert.cert_id,
      studentName: cert.student_name,
      eventName:   cert.event_name,
      hostOrg:     cert.host_org,
      issuedDate:  cert.issued_date,
      issuedAt:    cert.created_at
    });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// DELETE /:id — invalidate
router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    await pool.query('UPDATE certificates SET is_valid=FALSE WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, req.user.name, req.user.role, 'invalidate_certificate', 'certificates', req.params.id);
    res.json({ message: 'Certificate invalidated' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
