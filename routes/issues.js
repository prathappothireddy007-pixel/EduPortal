const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty, requireStudent } = require('../middleware/auth');
const { logAction, notify } = require('../services/audit');

// GET / - list issues (faculty: all; student: own only)
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, category } = req.query;
    const isFaculty = req.user.role === 'faculty';
    const params = [];
    let idx = 1;
    let whereClause = 'WHERE 1=1';

    if (!isFaculty) {
      whereClause += ` AND i.student_id = $${idx++}`;
      params.push(req.user.id);
    }

    if (status) {
      whereClause += ` AND i.status = $${idx++}`;
      params.push(status);
    }

    if (category) {
      whereClause += ` AND i.category = $${idx++}`;
      params.push(category);
    }

    const result = await pool.query(
      `SELECT i.*,
         u_student.name AS student_name,
         u_faculty.name AS assigned_faculty_name
       FROM issues i
       LEFT JOIN users u_student ON i.student_id = u_student.id
       LEFT JOIN users u_faculty ON i.assigned_to = u_faculty.id
       ${whereClause}
       ORDER BY i.created_at DESC`,
      params
    );

    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / - student creates issue
router.post('/', authenticate, requireStudent, async (req, res) => {
  try {
    const { title, category, description, priority } = req.body;

    if (!title || !category || !description) {
      return res.status(400).json({ error: 'title, category, and description are required' });
    }

    // Auto-assign to first faculty found
    const facultyResult = await pool.query(
      "SELECT id FROM users WHERE role = 'faculty' ORDER BY id LIMIT 1"
    );
    const assignedTo = facultyResult.rows.length > 0 ? facultyResult.rows[0].id : null;

    const result = await pool.query(
      `INSERT INTO issues (student_id, title, category, description, priority, status, assigned_to)
       VALUES ($1, $2, $3, $4, $5, 'open', $6)
       RETURNING *`,
      [req.user.id, title, category, description, priority || 'medium', assignedTo]
    );

    if (assignedTo) {
      await notify(
        assignedTo,
        'New Issue Assigned',
        `A new issue has been assigned to you: "${title}"`,
        'issue'
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /:id - get issue details with responses
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const isFaculty = req.user.role === 'faculty';

    const issueResult = await pool.query(
      `SELECT i.*,
         u_student.name AS student_name,
         u_faculty.name AS assigned_faculty_name
       FROM issues i
       LEFT JOIN users u_student ON i.student_id = u_student.id
       LEFT JOIN users u_faculty ON i.assigned_to = u_faculty.id
       WHERE i.id = $1`,
      [id]
    );

    if (issueResult.rows.length === 0) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const issue = issueResult.rows[0];

    if (!isFaculty && issue.student_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const responsesResult = await pool.query(
      `SELECT ir.*, u.name AS author_name, u.role AS author_role
       FROM issue_responses ir
       LEFT JOIN users u ON ir.user_id = u.id
       WHERE ir.issue_id = $1
       ORDER BY ir.created_at ASC`,
      [id]
    );

    res.json({ ...issue, responses: responsesResult.rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /:id - update issue status
router.put('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    const isFaculty = req.user.role === 'faculty';

    if (!status) {
      return res.status(400).json({ error: 'status is required' });
    }

    const existing = await pool.query('SELECT * FROM issues WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const issue = existing.rows[0];

    if (!isFaculty) {
      if (issue.student_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      // Students can only close their own resolved issues
      if (!(issue.status === 'resolved' && status === 'closed')) {
        return res.status(403).json({ error: 'Students can only close resolved issues' });
      }
    }

    const resolvedAt = (status === 'resolved' || status === 'closed') ? new Date() : issue.resolved_at;

    const result = await pool.query(
      `UPDATE issues
       SET status = $1, resolved_at = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [status, resolvedAt, id]
    );

    await logAction(req.user.id, 'UPDATE_STATUS', 'issue', id, { status });

    // Notify student if faculty updates
    if (isFaculty) {
      await notify(
        issue.student_id,
        'Issue Status Updated',
        `Your issue "${issue.title}" status has been updated to: ${status}`,
        'issue'
      );
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /:id/respond - add response to issue
router.post('/:id/respond', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    const isFaculty = req.user.role === 'faculty';

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const existing = await pool.query('SELECT * FROM issues WHERE id = $1', [id]);
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const issue = existing.rows[0];

    if (!isFaculty && issue.student_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const result = await pool.query(
      `INSERT INTO issue_responses (issue_id, user_id, message)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [id, req.user.id, message]
    );

    // Notify the other party
    const notifyUserId = isFaculty ? issue.student_id : issue.assigned_to;
    if (notifyUserId) {
      await notify(
        notifyUserId,
        'New Response on Issue',
        `A new response has been added to issue "${issue.title}"`,
        'issue'
      );
    }

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
