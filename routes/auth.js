const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');

router.post('/login', async (req, res) => {
  const { role, adminId, email, password } = req.body;
  try {
    let user;
    if (role === 'faculty') {
      const r = await pool.query(
        "SELECT * FROM users WHERE role='faculty' AND admin_id=$1", [adminId]
      );
      user = r.rows[0];
    } else {
      const r = await pool.query(
        "SELECT * FROM users WHERE role='student' AND LOWER(email)=LOWER($1)", [email]
      );
      user = r.rows[0];
    }

    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign(
      { id: user.id, role: user.role, name: user.name },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      token,
      user: {
        id: user.id, role: user.role, name: user.name,
        email: user.email, classId: user.class_id
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
