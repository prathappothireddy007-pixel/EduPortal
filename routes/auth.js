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

// POST /change-password - Change own password (Student & Faculty must verify current password; Admin can change directly)
router.post('/change-password', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET || 'supersecretjwtkey123');
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  const { currentPassword, newPassword, targetUserId } = req.body;

  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: 'New password must be at least 4 characters long' });
  }

  try {
    const isAdmin = decoded.role === 'admin';
    const userIdToUpdate = (isAdmin && targetUserId) ? targetUserId : decoded.id;

    const userRes = await pool.query('SELECT * FROM users WHERE id=$1 AND deleted_at IS NULL', [userIdToUpdate]);
    if (!userRes.rows[0]) return res.status(404).json({ error: 'User not found' });
    const user = userRes.rows[0];

    // Non-admins MUST verify their current password
    if (!isAdmin) {
      if (!currentPassword) {
        return res.status(400).json({ error: 'Current password verification is required to change your password.' });
      }

      let valid = false;
      if (user.password_hash) {
        valid = await bcrypt.compare(currentPassword, user.password_hash);
      }
      if (!valid && user.plain_pass) {
        valid = (user.plain_pass === currentPassword);
      }

      if (!valid) {
        return res.status(400).json({ error: 'Current password verification failed. Incorrect existing password.' });
      }
    }

    const hash = await bcrypt.hash(newPassword.trim(), 10);
    await pool.query(
      'UPDATE users SET password_hash=$1, plain_pass=$2 WHERE id=$3',
      [hash, newPassword.trim(), userIdToUpdate]
    );

    res.json({ message: 'Password updated successfully! 🔒' });
  } catch (err) {
    console.error('[Change Password] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
