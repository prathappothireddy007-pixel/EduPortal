const cron = require('node-cron');
const { pool } = require('../db');

/**
 * Runs every 10 minutes.
 * Auto-rejects OD requests that are still 'pending' for more than 24 hours (cleanup).
 * NOTE: Geo-photo verification is now done MANUALLY by faculty.
 */
const startODExpiryJob = () => {
  cron.schedule('*/10 * * * *', async () => {
    try {
      // Auto-reject OD letters pending for more than 24 hours with no action
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const expired = await pool.query(
        `SELECT * FROM od_requests
         WHERE status='pending' AND created_at < $1`,
        [cutoff]
      );

      for (const od of expired.rows) {
        await pool.query(
          "UPDATE od_requests SET status='rejected' WHERE id=$1", [od.id]
        );
        await pool.query(
          `INSERT INTO attendance (student_id, student_name, status, date)
           VALUES ($1, $2, 'Absent', $3)
           ON CONFLICT (student_id, date) DO UPDATE SET status='Absent'`,
          [od.student_id, od.student_name, od.date]
        );
        console.log(`⏰ Auto-rejected stale OD for ${od.student_name} (${od.date})`);
      }
    } catch (err) {
      console.error('Cron error:', err.message);
    }
  });

  console.log('⏰ OD cleanup cron started (runs every 10 minutes)');
};

module.exports = { startODExpiryJob };
