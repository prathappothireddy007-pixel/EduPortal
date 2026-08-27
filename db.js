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
    // ── Core Tables ──────────────────────────────────────────────────────────
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
        deleted_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS classes (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        deleted_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS subjects (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
        subject_type VARCHAR(30) DEFAULT 'classroom'
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
        host_institution VARCHAR(255),
        lat DOUBLE PRECISION,
        lng DOUBLE PRECISION,
        radius_meters INTEGER DEFAULT 200,
        start_time TIME,
        end_time TIME,
        event_type VARCHAR(50) DEFAULT 'general',
        event_status VARCHAR(20) DEFAULT 'active',
        qr_token VARCHAR(255),
        qr_expires_at TIMESTAMP,
        created_by INTEGER REFERENCES users(id),
        deleted_at TIMESTAMP,
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
        rejection_reason TEXT,
        approved_at TIMESTAMP,
        geo_b64 TEXT,
        geo_lat DOUBLE PRECISION,
        geo_lng DOUBLE PRECISION,
        distance_meters DOUBLE PRECISION,
        checkin_time TIMESTAMP,
        checkin_lat DOUBLE PRECISION,
        checkin_lng DOUBLE PRECISION,
        checkin_b64 TEXT,
        checkout_time TIMESTAMP,
        checkout_lat DOUBLE PRECISION,
        checkout_lng DOUBLE PRECISION,
        checkout_b64 TEXT,
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

      -- ── New: Classrooms ────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS classrooms (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        capacity INTEGER NOT NULL DEFAULT 40,
        room_type VARCHAR(30) DEFAULT 'classroom'
          CHECK(room_type IN ('classroom','computer_lab','laboratory','seminar_hall','auditorium','other')),
        building VARCHAR(100),
        floor INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- ── New: Timetable ────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS timetable_entries (
        id SERIAL PRIMARY KEY,
        class_id INTEGER REFERENCES classes(id) ON DELETE CASCADE,
        subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
        faculty_id INTEGER REFERENCES users(id),
        classroom_id INTEGER REFERENCES classrooms(id),
        day_of_week VARCHAR(10) CHECK(day_of_week IN ('Monday','Tuesday','Wednesday','Thursday','Friday','Saturday')),
        start_time TIME NOT NULL,
        end_time TIME NOT NULL,
        is_locked BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS room_change_log (
        id SERIAL PRIMARY KEY,
        timetable_entry_id INTEGER REFERENCES timetable_entries(id) ON DELETE CASCADE,
        old_classroom_id INTEGER REFERENCES classrooms(id),
        new_classroom_id INTEGER REFERENCES classrooms(id),
        changed_by INTEGER REFERENCES users(id),
        reason TEXT,
        changed_at TIMESTAMP DEFAULT NOW()
      );

      -- ── New: Notifications ────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS notifications (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        type VARCHAR(50),
        title VARCHAR(255),
        message TEXT,
        related_id INTEGER,
        is_read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- ── New: Issues ───────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS issues (
        id SERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        assigned_to INTEGER REFERENCES users(id),
        category VARCHAR(30) DEFAULT 'general'
          CHECK(category IN ('academic','attendance','od','technical','general')),
        title VARCHAR(255) NOT NULL,
        description TEXT,
        priority VARCHAR(10) DEFAULT 'medium'
          CHECK(priority IN ('low','medium','high')),
        status VARCHAR(20) DEFAULT 'open'
          CHECK(status IN ('open','in_progress','resolved','closed')),
        created_at TIMESTAMP DEFAULT NOW(),
        resolved_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS issue_responses (
        id SERIAL PRIMARY KEY,
        issue_id INTEGER REFERENCES issues(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id),
        user_name VARCHAR(255),
        message TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- ── New: Documents ────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS documents (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        uploaded_by INTEGER REFERENCES users(id),
        category VARCHAR(50) DEFAULT 'other',
        title VARCHAR(255) NOT NULL,
        filename VARCHAR(255),
        file_b64 TEXT,
        is_archived BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- ── New: Achievements ─────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS achievements (
        id SERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        category VARCHAR(50) DEFAULT 'other',
        org VARCHAR(255),
        ach_date DATE,
        cert_b64 TEXT,
        is_verified BOOLEAN DEFAULT FALSE,
        verified_by INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- ── New: Resources ────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS resources (
        id SERIAL PRIMARY KEY,
        subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
        uploaded_by INTEGER REFERENCES users(id),
        title VARCHAR(255) NOT NULL,
        resource_type VARCHAR(30) DEFAULT 'notes',
        description TEXT,
        file_b64 TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- ── New: Certificates ─────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS certificates (
        id SERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        event_id INTEGER REFERENCES events(id),
        cert_id VARCHAR(64) UNIQUE NOT NULL,
        student_name VARCHAR(255),
        event_name VARCHAR(255),
        host_org VARCHAR(255),
        issued_date DATE DEFAULT CURRENT_DATE,
        verify_qr_token VARCHAR(255),
        is_valid BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- ── New: Audit Logs ───────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS audit_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER,
        user_name VARCHAR(255),
        role VARCHAR(20),
        action VARCHAR(100),
        entity_type VARCHAR(50),
        entity_id INTEGER,
        old_value TEXT,
        new_value TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );

      -- ── New: Academic Risk ────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS academic_risk (
        id SERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES users(id) ON DELETE CASCADE UNIQUE,
        risk_level VARCHAR(20) DEFAULT 'low',
        reasons_json TEXT,
        calculated_at TIMESTAMP DEFAULT NOW()
      );

      -- ── New: Settings ─────────────────────────────────────────────────────
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(100) UNIQUE NOT NULL,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // ── Safe migrations for existing tables ──────────────────────────────────
    const migrations = [
      `ALTER TABLE od_requests DROP CONSTRAINT IF EXISTS od_requests_status_check`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`,
      `ALTER TABLE classes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`,
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMP`,
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS host_institution VARCHAR(255)`,
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS lat DOUBLE PRECISION`,
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS lng DOUBLE PRECISION`,
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS radius_meters INTEGER DEFAULT 200`,
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS start_time TIME`,
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS end_time TIME`,
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS event_type VARCHAR(50) DEFAULT 'general'`,
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS event_status VARCHAR(20) DEFAULT 'active'`,
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS qr_token VARCHAR(255)`,
      `ALTER TABLE events ADD COLUMN IF NOT EXISTS qr_expires_at TIMESTAMP`,
      `ALTER TABLE od_requests ADD COLUMN IF NOT EXISTS rejection_reason TEXT`,
      `ALTER TABLE od_requests ADD COLUMN IF NOT EXISTS distance_meters DOUBLE PRECISION`,
      `ALTER TABLE od_requests ADD COLUMN IF NOT EXISTS checkin_time TIMESTAMP`,
      `ALTER TABLE od_requests ADD COLUMN IF NOT EXISTS checkin_lat DOUBLE PRECISION`,
      `ALTER TABLE od_requests ADD COLUMN IF NOT EXISTS checkin_lng DOUBLE PRECISION`,
      `ALTER TABLE od_requests ADD COLUMN IF NOT EXISTS checkin_b64 TEXT`,
      `ALTER TABLE od_requests ADD COLUMN IF NOT EXISTS checkout_time TIMESTAMP`,
      `ALTER TABLE od_requests ADD COLUMN IF NOT EXISTS checkout_lat DOUBLE PRECISION`,
      `ALTER TABLE od_requests ADD COLUMN IF NOT EXISTS checkout_lng DOUBLE PRECISION`,
      `ALTER TABLE od_requests ADD COLUMN IF NOT EXISTS checkout_b64 TEXT`,
      `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS subject_type VARCHAR(30) DEFAULT 'classroom'`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS code VARCHAR(50)`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS faculty_id INTEGER`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS target_dept VARCHAR(100) DEFAULT 'ALL'`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS is_launched BOOLEAN DEFAULT TRUE`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS description TEXT`,
      `ALTER TABLE enrollment_requests ADD COLUMN IF NOT EXISTS subject_id INTEGER`,
      `ALTER TABLE users ADD COLUMN IF NOT EXISTS department VARCHAR(50)`,
      `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS pdf_b64 TEXT`,
      `ALTER TABLE announcements ADD COLUMN IF NOT EXISTS pdf_name VARCHAR(255)`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS is_closed BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS is_phase1_submitted BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS is_phase2_submitted BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS is_results_published BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS exam_date DATE`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS exam_session VARCHAR(10) DEFAULT 'FN'`,
      `ALTER TABLE subjects ADD COLUMN IF NOT EXISTS exam_hall VARCHAR(50) DEFAULT 'Main Hall A'`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS div1_assessments NUMERIC(5,2) DEFAULT 0`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS div2_capstone NUMERIC(5,2) DEFAULT 0`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS div3_class_lab NUMERIC(5,2) DEFAULT 0`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS div4_univ_lab NUMERIC(5,2) DEFAULT 0`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS div5_univ_exam NUMERIC(5,2) DEFAULT 0`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS total_internal NUMERIC(6,2) DEFAULT 0`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS grand_total NUMERIC(6,2) DEFAULT 0`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS grade_letter VARCHAR(10)`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS is_submitted BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS phase1_submitted BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS phase2_submitted BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS phase3_submitted BOOLEAN DEFAULT FALSE`,
      `ALTER TABLE grades ADD COLUMN IF NOT EXISTS is_results_published BOOLEAN DEFAULT FALSE`,
      `CREATE TABLE IF NOT EXISTS hall_ticket_requests (
        id SERIAL PRIMARY KEY,
        student_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        subject_id INTEGER REFERENCES subjects(id) ON DELETE CASCADE,
        faculty_id INTEGER,
        status VARCHAR(20) DEFAULT 'requested',
        request_date TIMESTAMP DEFAULT NOW(),
        approved_at TIMESTAMP,
        hall_ticket_token VARCHAR(100),
        UNIQUE(student_id, subject_id)
      )`,
      `CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        target_audience VARCHAR(50) DEFAULT 'ALL',
        priority VARCHAR(20) DEFAULT 'info',
        created_by INTEGER,
        created_by_name VARCHAR(255),
        is_pinned BOOLEAN DEFAULT FALSE,
        pdf_b64 TEXT,
        pdf_name VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      )`,
      `CREATE INDEX IF NOT EXISTS idx_attendance_student ON attendance(student_id)`,
      `CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date)`,
      `CREATE INDEX IF NOT EXISTS idx_grades_student ON grades(student_id)`,
      `CREATE INDEX IF NOT EXISTS idx_od_student ON od_requests(student_id)`,
      `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id)`,
      `CREATE INDEX IF NOT EXISTS idx_timetable_class ON timetable_entries(class_id)`,
      `CREATE INDEX IF NOT EXISTS idx_timetable_room ON timetable_entries(classroom_id)`,
    ];
    for (const sql of migrations) {
      try { await client.query(sql); } catch(e) { /* column already exists */ }
    }

    // ── Seed default settings ────────────────────────────────────────────────
    await client.query(`
      INSERT INTO settings(key, value) VALUES
        ('attendance_threshold', '75'),
        ('academic_risk_attend_high', '60'),
        ('academic_risk_attend_mod', '75'),
        ('academic_risk_grade_high', '50'),
        ('academic_risk_grade_mod', '60')
      ON CONFLICT (key) DO NOTHING
    `);

    // ── Seed default admin ───────────────────────────────────────────────────
    const adminCheck = await client.query(
      "SELECT id, role FROM users WHERE admin_id=$1 LIMIT 1",
      [process.env.ADMIN_ID || '192411184']
    );
    if (adminCheck.rows.length === 0) {
      const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'katam@123', 10);
      await client.query(
        `INSERT INTO users (role, name, email, admin_id, password_hash, designation)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        ['admin', 'Principal / Administrator', 'admin@eduportal.com',
         process.env.ADMIN_ID || '192411184', hash, 'Institutional Administrator']
      );
      console.log('✅ Default admin seeded with role=admin');
    } else if (adminCheck.rows[0].role !== 'admin') {
      await client.query("UPDATE users SET role='admin' WHERE id=$1", [adminCheck.rows[0].id]);
    }

    console.log('✅ Database initialized (v3.0 — full platform)');
  } catch (err) {
    console.error('❌ DB init error:', err.message);
    throw err;
  } finally {
    client.release();
  }
};

module.exports = { pool, initDB };
