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
    // 1. Search user by case-insensitive admin_id or email
    const r = await pool.query(
      `SELECT * FROM users 
       WHERE deleted_at IS NULL 
         AND (UPPER(admin_id) = UPPER($1) OR LOWER(email) = LOWER($1))
       ORDER BY id ASC LIMIT 1`,
      [loginIdentifier]
    );

    const user = r.rows[0];

    if (!user) {
      return res.status(401).json({ error: `No user found with ID or Email "${loginIdentifier}"` });
    }

    // 2. Validate role compatibility
    const requestedRole = (role || 'student').toLowerCase();
    const userRole = (user.role || 'student').toLowerCase();

    if (requestedRole !== userRole) {
      // Allow admin to log into faculty role
      if (!(userRole === 'admin' && requestedRole === 'faculty')) {
        return res.status(401).json({
          error: `Role mismatch: This ID belongs to a ${userRole.toUpperCase()} account. Please select the "${userRole.charAt(0).toUpperCase() + userRole.slice(1)}" tab to sign in.`
        });
      }
    }

    // 3. Validate password (bcrypt hash or plaintext fallback)
    let valid = false;
    if (user.password_hash) {
      valid = await bcrypt.compare(password, user.password_hash);
    }
    if (!valid && user.plain_pass) {
      valid = (user.plain_pass === password);
    }

    if (!valid) {
      return res.status(401).json({ error: 'Invalid password. Please check your credentials.' });
    }

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
