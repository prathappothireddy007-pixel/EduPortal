require('dotenv').config();
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const isProduction = process.env.NODE_ENV === 'production';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProduction ? { rejectUnauthorized: false } : false
});

const initDB = async () => {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        role VARCHAR(10) NOT NULL CHECK(role IN ('faculty','student')),
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255),
        admin_id VARCHAR(100),
        password_hash VARCHAR(255) NOT NULL,
        parent_email VARCHAR(255),
        parent_phone VARCHAR(30),
        dob VARCHAR(30),
        aadhar VARCHAR(30),
        class_id INTEGER,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS classes (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS subjects (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS grades (
        id SERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        student_name VARCHAR(255),
        subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
        subject_name VARCHAR(255),
        week INTEGER,
        score VARCHAR(20),
        date TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS attendance (
        id SERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        student_name VARCHAR(255),
        status VARCHAR(10) CHECK(status IN ('Present','Absent','OD')),
        date DATE NOT NULL,
        od_request_id INTEGER,
        UNIQUE(student_id, date)
      );

      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        event_date DATE,
        venue VARCHAR(255),
        created_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS event_registrations (
        id SERIAL PRIMARY KEY,
        event_id INTEGER REFERENCES events(id) ON DELETE CASCADE,
        student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(event_id, student_id)
      );

      CREATE TABLE IF NOT EXISTS od_requests (
        id SERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        student_name VARCHAR(255),
        event_id INTEGER REFERENCES events(id),
        event_name VARCHAR(255),
        letter_b64 TEXT,
        status VARCHAR(20) DEFAULT 'pending',
        approved_at TIMESTAMP,
        geo_b64 TEXT,
        geo_lat DOUBLE PRECISION,
        geo_lng DOUBLE PRECISION,
        date DATE DEFAULT CURRENT_DATE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS enrollment_requests (
        id SERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Migration: drop old OD status constraint and allow new status values
    try {
      await client.query(`ALTER TABLE od_requests DROP CONSTRAINT IF EXISTS od_requests_status_check`);
    } catch(e) { /* ignore */ }

    // Seed default faculty admin
    const adminCheck = await client.query(
      "SELECT id FROM users WHERE role='faculty' LIMIT 1"
    );
    if (adminCheck.rows.length === 0) {
      const hash = await bcrypt.hash(
        process.env.ADMIN_PASSWORD || 'katam@123', 10
      );
      await client.query(
        `INSERT INTO users (role, name, email, admin_id, password_hash)
         VALUES ($1,$2,$3,$4,$5)`,
        ['faculty','Administrator','admin@eduportal.com',
         process.env.ADMIN_ID || '192411184', hash]
      );
      console.log('✅ Default admin seeded');
    }

    console.log('✅ Database initialized');
  } catch (err) {
    console.error('❌ DB init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { pool, initDB };
