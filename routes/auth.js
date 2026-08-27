const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

router.post('/login', async (req, res) => {
  const { role, adminId, email, password } = req.body;
  const loginIdentifier = (adminId || email || '').trim();

  if (!loginIdentifier || !password) {
    return res.status(400).json({ error: 'Identifier and password are required' });
  }

  try {
    let user;
    if (role === 'admin') {
      const r = await pool.query(
        "SELECT * FROM users WHERE role='admin' AND (admin_id=$1 OR LOWER(email)=LOWER($1))",
        [loginIdentifier]
      );
      user = r.rows[0];
    } else if (role === 'faculty') {
      const r = await pool.query(
        "SELECT * FROM users WHERE role='faculty' AND (admin_id=$1 OR LOWER(email)=LOWER($1))",
        [loginIdentifier]
      );
      user = r.rows[0];
    } else {
      const r = await pool.query(
        "SELECT * FROM users WHERE role='student' AND (admin_id=$1 OR LOWER(email)=LOWER($1))",
        [loginIdentifier]
      );
      user = r.rows[0];
    }

    if (!user) return res.status(401).json({ error: 'Invalid credentials or user role' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name },
      process.env.JWT_SECRET || 'supersecretjwtkey123',
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id,
        role: user.role,
        name: user.name,
        email: user.email,
        classId: user.class_id,
        admin_id: user.admin_id,
        department: user.department,
        designation: user.designation
      }
    });
  } catch (err) {
    console.error('[Auth Login] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
