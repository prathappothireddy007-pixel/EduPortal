const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');

// GET all students (faculty) or own profile (student)
router.get('/', authenticate, async (req, res) => {
  try {
    if (req.user.role === 'faculty') {
      const r = await pool.query(
        `SELECT u.*, c.name as class_name
         FROM users u
         LEFT JOIN classes c ON u.class_id = c.id
         WHERE u.role='student'
         ORDER BY u.created_at DESC`
      );
      res.json(r.rows);
    } else {
      const r = await pool.query(
        `SELECT u.*, c.name as class_name
         FROM users u
         LEFT JOIN classes c ON u.class_id = c.id
         WHERE u.id=$1`, [req.user.id]
      );
      res.json(r.rows[0] || null);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST create student (faculty)
router.post('/', authenticate, requireFaculty, async (req, res) => {
  const { name, email, parentEmail, parentPhone, dob, aadhar, password } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email required' });
  try {
    const exists = await pool.query(
      "SELECT id FROM users WHERE LOWER(email)=LOWER($1)", [email]
    );
    if (exists.rows.length > 0)
      return res.status(400).json({ error: 'Email already exists' });

    const hash = await bcrypt.hash(password || 'welcome', 10);
    const r = await pool.query(
      `INSERT INTO users (role,name,email,password_hash,parent_email,parent_phone,dob,aadhar)
       VALUES ('student',$1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [name, email, hash, parentEmail, parentPhone, dob, aadhar]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT update student (faculty)
router.put('/:id', authenticate, requireFaculty, async (req, res) => {
  const { name, email, parentEmail, parentPhone, dob, aadhar } = req.body;
  try {
    const r = await pool.query(
      `UPDATE users SET name=$1,email=$2,parent_email=$3,parent_phone=$4,dob=$5,aadhar=$6
       WHERE id=$7 AND role='student' RETURNING *`,
      [name, email, parentEmail, parentPhone, dob, aadhar, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT update student class (faculty)
router.put('/:id/class', authenticate, requireFaculty, async (req, res) => {
  const { classId } = req.body;
  try {
    const r = await pool.query(
      "UPDATE users SET class_id=$1 WHERE id=$2 RETURNING *",
      [classId || null, req.params.id]
    );
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT change password (student)
router.put('/me/password', authenticate, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    await pool.query("UPDATE users SET password_hash=$1 WHERE id=$2", [hash, req.user.id]);
    res.json({ message: 'Password updated' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE student (faculty)
router.delete('/:id', authenticate, requireFaculty, async (req, res) => {
  try {
    await pool.query("DELETE FROM users WHERE id=$1 AND role='student'", [req.params.id]);
    res.json({ message: 'Student deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
