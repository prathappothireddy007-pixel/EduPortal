const router = require('express').Router();
const { pool } = require('../db');
const { authenticate, requireFaculty, requireStudent } = require('../middleware/auth');
const { logAction, notify } = require('../services/audit');

// GET / - list issues (faculty: all; student: own only)
router.get('/', authenticate, async (req, res) => {
  try {
    const { status, category } = req.query;
    const isStaff = req.user.role === 'faculty' || req.user.role === 'admin';
    const params = [];
    let idx = 1;
    let whereClause = 'WHERE 1=1';

    if (!isStaff) {
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
    console.error('[Issues GET] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST / - student creates issue
router.post('/', authenticate, async (req, res) => {
  try {
    const { title, category, description, priority } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'title is required' });
    }

    // Auto-assign to first faculty found
    const facultyResult = await pool.query(
      "SELECT id FROM users WHERE role = 'faculty' ORDER BY id LIMIT 1"
    );
    const assignedTo = facultyResult.rows[0]?.id || null;

    const result = await pool.query(
      `INSERT INTO issues (student_id, assigned_to, category, title, description, priority, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'open')
       RETURNING *`,
      [req.user.id, assignedTo, category || 'general', title, description || '', priority || 'medium']
    );

    const newIssue = result.rows[0];

    if (assignedTo) {
      await notify(
        assignedTo,
        'new_issue',
        'New Support Ticket',
        `A new ticket "${title}" was created by ${req.user.name}`,
        newIssue.id
      );
    }

    await logAction(req.user.id, req.user.name, req.user.role, 'create_issue', 'issues', newIssue.id);
    res.status(201).json(newIssue);
  } catch (err) {
    console.error('[Issues POST] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /:id - get issue details with responses
router.get('/:id', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
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

    if (req.user.role === 'student' && issue.student_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const responsesResult = await pool.query(
      `SELECT * FROM issue_responses WHERE issue_id = $1 ORDER BY created_at ASC`,
      [id]
    );

    res.json({ issue, responses: responsesResult.rows });
  } catch (err) {
    console.error('[Issue Detail] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Handler for updating issue status
async function handleUpdateIssueStatus(req, res) {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const issueResult = await pool.query('SELECT * FROM issues WHERE id = $1', [id]);
    if (issueResult.rows.length === 0) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const issue = issueResult.rows[0];

    if (req.user.role === 'student') {
      if (issue.student_id !== req.user.id) {
        return res.status(403).json({ error: 'Access denied' });
      }
      if (status !== 'closed') {
        return res.status(403).json({ error: 'Students can only close their own issues' });
      }
    }

    const isResolving = status === 'resolved' || status === 'closed';
    const updateResult = await pool.query(
      `UPDATE issues
       SET status = $1,
           resolved_at = CASE WHEN $2 THEN NOW() ELSE resolved_at END
       WHERE id = $3
       RETURNING *`,
      [status, isResolving, id]
    );

    const updatedIssue = updateResult.rows[0];

    // Notify student if faculty updated
    if (req.user.role === 'faculty' && issue.student_id) {
      await notify(
        issue.student_id,
        'issue_update',
        'Ticket Status Updated',
        `Your ticket "${issue.title}" status was changed to ${status}`,
        issue.id
      );
    }

    await logAction(req.user.id, req.user.name, req.user.role, 'update_issue_status', 'issues', issue.id, null, { status });
    res.json(updatedIssue);
  } catch (err) {
    console.error('[Issue Status PUT] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

// PUT /:id - update status
router.put('/:id', authenticate, handleUpdateIssueStatus);
router.put('/:id/status', authenticate, handleUpdateIssueStatus);

// POST /:id/respond - add response
router.post('/:id/respond', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const issueResult = await pool.query('SELECT * FROM issues WHERE id = $1', [id]);
    if (issueResult.rows.length === 0) {
      return res.status(404).json({ error: 'Issue not found' });
    }

    const issue = issueResult.rows[0];

    if (req.user.role === 'student' && issue.student_id !== req.user.id) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const responseResult = await pool.query(
      `INSERT INTO issue_responses (issue_id, user_id, user_name, message)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [id, req.user.id, req.user.name, message]
    );

    const newResponse = responseResult.rows[0];

    const notifyRecipient = req.user.role === 'faculty' ? issue.student_id : issue.assigned_to;
    if (notifyRecipient) {
      await notify(
        notifyRecipient,
        'issue_response',
        'New Ticket Response',
        `${req.user.name} responded to "${issue.title}"`,
        id
      );
    }

    res.status(201).json(newResponse);
  } catch (err) {
    console.error('[Issue Respond] Error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
