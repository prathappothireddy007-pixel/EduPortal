const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty } = require('../middleware/auth');

// GET audit logs — faculty only, paginated + filtered
router.get('/', authenticate, requireFaculty, async (req, res) => {
  const { entity_type, from, to, user_id, action } = req.query;
  const page  = Math.max(1, parseInt(req.query.page)  || 1);
  const limit = Math.min(100, parseInt(req.query.limit) || 50);
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];
  let i = 1;

  if (entity_type) { conditions.push(`entity_type=$${i++}`); params.push(entity_type); }
  if (action)      { conditions.push(`action ILIKE $${i++}`); params.push(`%${action}%`); }
  if (user_id)     { conditions.push(`user_id=$${i++}`);      params.push(user_id); }
  if (from)        { conditions.push(`created_at>=$${i++}`);  params.push(from); }
  if (to)          { conditions.push(`created_at<=$${i++}`);  params.push(to); }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const countRes = await pool.query(
      `SELECT COUNT(*) as total FROM audit_logs ${where}`, params
    );
    const total = parseInt(countRes.rows[0].total);
    const pages = Math.ceil(total / limit);

    const logsRes = await pool.query(
      `SELECT * FROM audit_logs ${where}
       ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...params, limit, offset]
    );

    res.json({ logs: logsRes.rows, total, page, pages, limit });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

module.exports = router;
