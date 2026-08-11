const { pool } = require('../db');

/**
 * Log an important action to the audit_logs table.
 * Call this after successful mutations in routes.
 */
const logAction = async (userId, userName, role, action, entityType, entityId, oldValue = null, newValue = null) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (user_id, user_name, role, action, entity_type, entity_id, old_value, new_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [userId, userName || 'System', role || 'system', action, entityType, entityId,
       oldValue ? JSON.stringify(oldValue) : null,
       newValue ? JSON.stringify(newValue) : null]
    );
  } catch (e) {
    console.error('[Audit] Failed to log:', e.message);
  }
};

/**
 * Send an in-app notification to a user.
 */
const notify = async (userId, type, title, message, relatedId = null) => {
  try {
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, message, related_id)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, type, title, message, relatedId]
    );
  } catch (e) {
    console.error('[Notify] Failed:', e.message);
  }
};

module.exports = { logAction, notify };
