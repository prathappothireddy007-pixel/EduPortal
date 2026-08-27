const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');
const bcrypt = require('bcryptjs');
const { logAction } = require('../services/audit');

// GET /next-regno - Calculate next available Student Register Number based on engineering course and year
router.get('/next-regno', authenticate, requireFaculty, async (req, res) => {
  try {
    const course = (req.query.course || 'CSE').toUpperCase().trim();
    const year = req.query.year || new Date().getFullYear().toString();
    const prefix = `${year}${course}`;

    const result = await pool.query(
      `SELECT admin_id FROM users WHERE role='student' AND admin_id LIKE $1 ORDER BY admin_id DESC`,
      [`${prefix}%`]
    );

    let nextNum = 1;
    if (result.rows.length > 0) {
      for (const row of result.rows) {
        const idStr = row.admin_id || '';
        const numPart = idStr.replace(prefix, '');
        const parsed = parseInt(numPart, 10);
        if (!isNaN(parsed) && parsed >= nextNum) {
          nextNum = parsed + 1;
        }
      }
    }

    const regNo = `${prefix}${String(nextNum).padStart(3, '0')}`;
    res.json({ regNo, course, year, sequence: nextNum });
  } catch (err) {
    console.error('[Next RegNo] Error:', err);
    res.status(500).json({ error: 'Failed to generate register number' });
  }
});

// GET /next-facid - Calculate next available Faculty ID based on department and year
router.get('/next-facid', authenticate, requireFaculty, async (req, res) => {
  try {
    const dept = (req.query.dept || 'CSE').toUpperCase().trim();
    const year = req.query.year || new Date().getFullYear().toString();
    const prefix = `${year}FAC${dept}`;

    const result = await pool.query(
      `SELECT admin_id FROM users WHERE role='faculty' AND admin_id LIKE $1 ORDER BY admin_id DESC`,
      [`${prefix}%`]
    );

    let nextNum = 1;
    if (result.rows.length > 0) {
      for (const row of result.rows) {
        const idStr = row.admin_id || '';
        const numPart = idStr.replace(prefix, '');
        const parsed = parseInt(numPart, 10);
        if (!isNaN(parsed) && parsed >= nextNum) {
          nextNum = parsed + 1;
        }
      }
    }

    const facId = `${prefix}${String(nextNum).padStart(3, '0')}`;
    res.json({ facId, dept, year, sequence: nextNum });
  } catch (err) {
    console.error('[Next FacID] Error:', err);
    res.status(500).json({ error: 'Failed to generate faculty ID' });
  }
});

// GET /faculty-list - Public/Authenticated list of all faculty members for subject assignments & dropdowns
router.get('/faculty-list', authenticate, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, email, admin_id, department, designation
       FROM users WHERE role='faculty' AND deleted_at IS NULL
       ORDER BY name ASC`
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// GET all users/students (faculty/admin) or own profile (student)
router.get('/', authenticate, async (req, res) => {
  try {
    if (req.user.role === 'faculty' || req.user.role === 'admin') {
      const { role } = req.query;
      let query = `
        SELECT u.id, u.name, u.email, u.admin_id, u.parent_email, u.parent_phone,
               u.dob, u.class_id, u.role, u.department, u.designation, u.created_at,
               c.name as class_name
        FROM users u
        LEFT JOIN classes c ON u.class_id = c.id
        WHERE u.deleted_at IS NULL
      `;
      const params = [];
      if (role) {
        query += ` AND u.role = $1`;
        params.push(role);
      }
      query += ` ORDER BY u.role, u.admin_id, u.name`;
      const r = await pool.query(query, params);
      res.json(r.rows);
    } else {
      const r = await pool.query(
        `SELECT u.id, u.name, u.email, u.admin_id, u.parent_email, u.class_id, u.role,
                u.department, u.designation,
                c.name as class_name
         FROM users u LEFT JOIN classes c ON u.class_id=c.id
         WHERE u.id=$1`, [req.user.id]
      );
      res.json(r.rows[0] || {});
    }
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// GET single student or faculty
router.get('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.name, u.email, u.admin_id, u.parent_email, u.parent_phone,
              u.dob, u.class_id, u.role, u.department, u.designation, u.created_at, c.name as class_name
       FROM users u LEFT JOIN classes c ON u.class_id=c.id
       WHERE u.id=$1 AND u.deleted_at IS NULL`, [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    res.json(r.rows[0]);
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

// POST create student (faculty)
router.post('/', authenticate, requireFaculty, async (req, res) => {
  let { name, email, adminId, password, parentEmail, parentPhone, dob, aadhar, classId, course } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });

  try {
    if (!adminId || !adminId.trim()) {
      const courseCode = (course || 'CSE').toUpperCase().trim();
      const year = new Date().getFullYear().toString();
      const prefix = `${year}${courseCode}`;
      const existing = await pool.query(
        `SELECT admin_id FROM users WHERE role='student' AND admin_id LIKE $1 ORDER BY admin_id DESC`,
        [`${prefix}%`]
      );
      let nextNum = 1;
      if (existing.rows.length > 0) {
        for (const row of existing.rows) {
          const numPart = (row.admin_id || '').replace(prefix, '');
          const parsed = parseInt(numPart, 10);
          if (!isNaN(parsed) && parsed >= nextNum) nextNum = parsed + 1;
        }
      }
      adminId = `${prefix}${String(nextNum).padStart(3, '0')}`;
    }

    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (role,name,email,admin_id,password_hash,parent_email,parent_phone,dob,aadhar,class_id,department)
       VALUES ('student',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,name,email,admin_id,class_id,role`,
      [name, email || `${adminId.toLowerCase()}@eduportal.com`, adminId, hash, parentEmail, parentPhone, dob, aadhar, classId || null, course || 'CSE']
    );
    await logAction(req.user.id, req.user.name, 'faculty', 'create_student', 'users', r.rows[0].id, null, { name, adminId });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Student Register ID already exists' });
    console.error('[Create Student] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST create faculty user (admin only) with department & auto-generated faculty ID
router.post('/faculty', authenticate, requireFaculty, async (req, res) => {
  let { name, email, adminId, password, department, designation } = req.body;
  if (!name || !password) return res.status(400).json({ error: 'Name and password required' });

  try {
    const dept = (department || 'CSE').toUpperCase().trim();
    if (!adminId || !adminId.trim()) {
      const year = new Date().getFullYear().toString();
      const prefix = `${year}FAC${dept}`;
      const existing = await pool.query(
        `SELECT admin_id FROM users WHERE role='faculty' AND admin_id LIKE $1 ORDER BY admin_id DESC`,
        [`${prefix}%`]
      );
      let nextNum = 1;
      if (existing.rows.length > 0) {
        for (const row of existing.rows) {
          const numPart = (row.admin_id || '').replace(prefix, '');
          const parsed = parseInt(numPart, 10);
          if (!isNaN(parsed) && parsed >= nextNum) nextNum = parsed + 1;
        }
      }
      adminId = `${prefix}${String(nextNum).padStart(3, '0')}`;
    }

    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO users (role,name,email,admin_id,password_hash,department,designation)
       VALUES ('faculty',$1,$2,$3,$4,$5,$6) RETURNING id,name,email,admin_id,role,department,designation`,
      [name, email || `${adminId.toLowerCase()}@eduportal.com`, adminId, hash, dept, designation || 'Assistant Professor']
    );
    await logAction(req.user.id, req.user.name, 'faculty', 'create_faculty', 'users', r.rows[0].id, null, { name, adminId });
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Faculty ID already exists' });
    console.error('[Create Faculty] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT update student or faculty
router.put('/:id', authenticate, async (req, res) => {
  const targetId = req.params.id;
  if (req.user.role === 'student' && String(req.user.id) !== String(targetId)) {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const { name, email, parentEmail, parentPhone, dob, aadhar, classId, password, adminId, department, designation } = req.body;
  try {
    let updateQuery;
    let values;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      updateQuery = `UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id,name,role`;
      values = [hash, targetId];
    } else {
      updateQuery = `UPDATE users SET
        name=COALESCE($1,name), email=COALESCE($2,email),
        parent_email=COALESCE($3,parent_email), parent_phone=COALESCE($4,parent_phone),
        dob=COALESCE($5,dob), aadhar=COALESCE($6,aadhar),
        class_id=COALESCE($7::integer,class_id),
        admin_id=COALESCE($8,admin_id),
        department=COALESCE($9,department),
        designation=COALESCE($10,designation)
       WHERE id=$11 AND deleted_at IS NULL RETURNING id,name,email,class_id,admin_id,role,department,designation`;
      values = [name, email, parentEmail, parentPhone, dob, aadhar, classId || null, adminId || null, department || null, designation || null, targetId];
    }
    const r = await pool.query(updateQuery, values);
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' });
    await logAction(req.user.id, req.user.name, req.user.role, 'update_user', 'users', targetId);
    res.json(r.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// DELETE student or faculty (soft delete)
router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    await pool.query('UPDATE users SET deleted_at=NOW() WHERE id=$1', [req.params.id]);
    await logAction(req.user.id, req.user.name, 'faculty', 'delete_user', 'users', req.params.id);
    res.json({ message: 'User removed' });
  } catch (err) { res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
