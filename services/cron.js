const cron = require('node-cron');
const { pool } = require('../db');

/**
 * Runs every 2 minutes.
 * Finds approved OD requests older than 30 minutes with no geo photo,
 * marks them expired, and marks the student absent for that day.
 */
const startODExpiryJob = () => {
  cron.schedule('*/2 * * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      const expired = await pool.query(
        `SELECT * FROM od_requests
         WHERE status='approved'
           AND approved_at < $1
           AND geo_b64 IS NULL`,
        [cutoff]
      );

      for (const od of expired.rows) {
        // Mark OD expired
        await pool.query(
          "UPDATE od_requests SET status='expired' WHERE id=$1", [od.id]
        );

        // Mark student absent
        await pool.query(
          `INSERT INTO attendance (student_id, student_name, status, date)
           VALUES ($1, $2, 'Absent', $3)
           ON CONFLICT (student_id, date)
           DO UPDATE SET status='Absent'`,
          [od.student_id, od.student_name, od.date]
        );

        console.log(
          `⏰ OD expired for ${od.student_name} (${od.date}) — marked Absent`
        );
      }
    } catch (err) {
      console.error('Cron job error:', err.message);
    }
  });

  console.log('⏰ OD expiry cron job started (runs every 2 minutes)');
};

module.exports = { startODExpiryJob };
