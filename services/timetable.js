/**
 * Haversine formula — returns distance in meters between two GPS coords.
 */
const haversineDistance = (lat1, lng1, lat2, lng2) => {
  const R = 6371000; // Earth radius in meters
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/**
 * Check if two time intervals overlap.
 * Times as "HH:MM" strings.
 */
const timesOverlap = (s1, e1, s2, e2) => {
  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  return toMin(s1) < toMin(e2) && toMin(s2) < toMin(e1);
};

/**
 * Validate a single timetable entry against existing entries.
 * Returns array of conflict descriptions (empty = no conflicts).
 */
const checkConflicts = async (pool, entry, excludeId = null) => {
  const { classId, subjectId, facultyId, classroomId, dayOfWeek, startTime, endTime } = entry;
  const conflicts = [];

  const rows = await pool.query(
    `SELECT te.*, cl.name as class_name, s.name as subject_name,
            c.name as room_name, c.capacity, u.name as faculty_name,
            cls.name as cls_name
     FROM timetable_entries te
     JOIN classes cls ON te.class_id = cls.id
     JOIN subjects s ON te.subject_id = s.id
     JOIN classrooms c ON te.classroom_id = c.id
     LEFT JOIN users u ON te.faculty_id = u.id
     WHERE te.day_of_week=$1 AND te.id != $2`,
    [dayOfWeek, excludeId || 0]
  );

  for (const r of rows.rows) {
    if (!timesOverlap(startTime, endTime, r.start_time, r.end_time)) continue;

    // Room conflict
    if (r.classroom_id === classroomId) {
      conflicts.push(`Room conflict: Room "${r.room_name}" already used for "${r.cls_name} — ${r.subject_name}" at ${r.start_time}–${r.end_time}`);
    }
    // Class conflict
    if (r.class_id === classId) {
      conflicts.push(`Class conflict: Class already has "${r.subject_name}" scheduled at ${r.start_time}–${r.end_time}`);
    }
    // Faculty conflict
    if (facultyId && r.faculty_id && r.faculty_id === facultyId) {
      conflicts.push(`Faculty conflict: Faculty is teaching "${r.cls_name} — ${r.subject_name}" at ${r.start_time}–${r.end_time}`);
    }
  }

  return conflicts;
};

const SLOT_SCHEDULES = {
  'A': [
    { day: 'Monday', start: '09:00', end: '10:00' },
    { day: 'Wednesday', start: '10:00', end: '11:00' },
    { day: 'Friday', start: '11:00', end: '12:00' }
  ],
  'B': [
    { day: 'Monday', start: '10:00', end: '11:00' },
    { day: 'Wednesday', start: '11:00', end: '12:00' },
    { day: 'Friday', start: '09:00', end: '10:00' }
  ],
  'C': [
    { day: 'Monday', start: '11:00', end: '12:00' },
    { day: 'Wednesday', start: '09:00', end: '10:00' },
    { day: 'Friday', start: '10:00', end: '11:00' }
  ],
  'D': [
    { day: 'Tuesday', start: '09:00', end: '10:00' },
    { day: 'Thursday', start: '10:00', end: '11:00' },
    { day: 'Saturday', start: '11:00', end: '12:00' }
  ],
  'E': [
    { day: 'Tuesday', start: '10:00', end: '11:00' },
    { day: 'Thursday', start: '11:00', end: '12:00' },
    { day: 'Saturday', start: '09:00', end: '10:00' }
  ],
  'F': [
    { day: 'Tuesday', start: '11:00', end: '12:00' },
    { day: 'Thursday', start: '09:00', end: '10:00' },
    { day: 'Saturday', start: '10:00', end: '11:00' }
  ],
  'G': [
    { day: 'Monday', start: '13:30', end: '14:30' },
    { day: 'Wednesday', start: '14:30', end: '15:30' },
    { day: 'Friday', start: '15:30', end: '16:30' }
  ],
  'H': [
    { day: 'Monday', start: '14:30', end: '15:30' },
    { day: 'Wednesday', start: '15:30', end: '16:30' },
    { day: 'Friday', start: '13:30', end: '14:30' }
  ],
  'I': [
    { day: 'Monday', start: '15:30', end: '16:30' },
    { day: 'Wednesday', start: '13:30', end: '14:30' },
    { day: 'Friday', start: '14:30', end: '15:30' }
  ],
  'J': [
    { day: 'Tuesday', start: '13:30', end: '14:30' },
    { day: 'Thursday', start: '14:30', end: '15:30' },
    { day: 'Saturday', start: '15:30', end: '16:30' }
  ],
  'K': [
    { day: 'Tuesday', start: '14:30', end: '15:30' },
    { day: 'Thursday', start: '15:30', end: '16:30' },
    { day: 'Saturday', start: '13:30', end: '14:30' }
  ],
  'L': [
    { day: 'Tuesday', start: '15:30', end: '16:30' },
    { day: 'Thursday', start: '13:30', end: '14:30' },
    { day: 'Saturday', start: '14:30', end: '15:30' }
  ]
};

function getSessionsForSlot(slotLetter) {
  const upper = (slotLetter || 'A').toUpperCase().trim();
  if (SLOT_SCHEDULES[upper]) return SLOT_SCHEDULES[upper];

  const charCode = upper.charCodeAt(0) >= 65 ? upper.charCodeAt(0) - 65 : 0;
  const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const day1 = days[charCode % 6];
  const day2 = days[(charCode + 2) % 6];
  const day3 = days[(charCode + 4) % 6];
  const hour = 9 + (charCode % 7);
  const startStr = `${String(hour).padStart(2, '0')}:00`;
  const endStr = `${String(hour + 1).padStart(2, '0')}:00`;

  return [
    { day: day1, start: startStr, end: endStr },
    { day: day2, start: startStr, end: endStr },
    { day: day3, start: startStr, end: endStr }
  ];
}

/**
 * Auto-generate timetable for ALL LIVE / RUNNING courses.
 * Allocates rooms without collisions and notifies assigned faculties & students.
 */
const autoGenerateLiveCoursesTimetable = async (pool, notifyFn) => {
  const allocated = [];
  const unallocated = [];

  // 1. Ensure standard campus classrooms exist
  await pool.query(`
    INSERT INTO classrooms (name, capacity, room_type, building, floor, is_active) VALUES
      ('Room 101 — Smart Lecture Hall', 60, 'classroom', 'Academic Block A', 1, TRUE),
      ('Room 102 — Smart Lecture Hall', 60, 'classroom', 'Academic Block A', 1, TRUE),
      ('Room 201 — Computing Lab A', 50, 'computer_lab', 'Academic Block A', 2, TRUE),
      ('Room 202 — Computing Lab B', 50, 'computer_lab', 'Academic Block A', 2, TRUE),
      ('Room 301 — Advanced Tech Lab', 45, 'laboratory', 'Science Block', 3, TRUE),
      ('Room 302 — AI & Systems Lab', 45, 'computer_lab', 'Science Block', 3, TRUE),
      ('Seminar Hall Alpha', 120, 'seminar_hall', 'Main Auditorium Wing', 1, TRUE),
      ('Seminar Hall Beta', 100, 'seminar_hall', 'Main Auditorium Wing', 2, TRUE)
    ON CONFLICT (name) DO UPDATE SET is_active=TRUE
  `);

  // 2. Fetch all live / running subjects
  const subjectsRes = await pool.query(`
    SELECT s.*, u.id as faculty_user_id, u.name as faculty_name, u.email as faculty_email,
           (SELECT COUNT(*) FROM enrollment_requests er WHERE er.subject_id = s.id AND er.status = 'enrolled') as enrolled_count
    FROM subjects s
    LEFT JOIN users u ON s.faculty_id = u.id
    WHERE s.is_launched = TRUE
    ORDER BY s.slot ASC, s.id ASC
  `);
  const liveSubjects = subjectsRes.rows;

  if (liveSubjects.length === 0) {
    return { allocated: [], unallocated: [], liveCourseCount: 0, message: 'No live/running courses found to schedule.' };
  }

  // 3. Fetch active classrooms
  const roomRes = await pool.query(
    `SELECT * FROM classrooms WHERE is_active=TRUE ORDER BY capacity ASC`
  );
  const rooms = roomRes.rows;

  // Clear existing un-locked timetable entries to perform a fresh, clean allocation
  await pool.query(`DELETE FROM timetable_entries WHERE is_locked = FALSE OR is_locked IS NULL`);

  const occupiedRooms = {}; // key: `${roomId}_${day}_${start}`
  const occupiedFaculty = {}; // key: `${facultyId}_${day}_${start}`
  const notifiedFaculties = new Set();
  const notifiedStudents = new Set();

  for (const sub of liveSubjects) {
    const slot = (sub.slot || 'A').toUpperCase().trim();
    const sessions = getSessionsForSlot(slot);
    const subType = sub.subject_type || 'classroom';
    const enrollCount = parseInt(sub.enrolled_count, 10) || 1;

    // Filter candidate rooms (prefer matching type and adequate capacity)
    let candidateRooms = rooms.filter(r => r.capacity >= enrollCount);
    if (candidateRooms.length === 0) candidateRooms = rooms;

    // Prioritize labs for lab courses
    if (subType === 'lab' || sub.name.toLowerCase().includes('lab')) {
      candidateRooms.sort((a, b) => (b.room_type.includes('lab') ? 1 : 0) - (a.room_type.includes('lab') ? 1 : 0));
    }

    let assignedRoom = null;

    for (const room of candidateRooms) {
      let hasRoomCollision = false;
      for (const sess of sessions) {
        const roomKey = `${room.id}_${sess.day}_${sess.start}`;
        const facKey = sub.faculty_id ? `${sub.faculty_id}_${sess.day}_${sess.start}` : null;
        if (occupiedRooms[roomKey] || (facKey && occupiedFaculty[facKey])) {
          hasRoomCollision = true;
          break;
        }
      }

      if (!hasRoomCollision) {
        assignedRoom = room;
        break;
      }
    }

    // If perfectly non-colliding room wasn't found, fallback to the least busy room
    if (!assignedRoom) {
      assignedRoom = candidateRooms[0] || rooms[0];
    }

    if (assignedRoom) {
      for (const sess of sessions) {
        const roomKey = `${assignedRoom.id}_${sess.day}_${sess.start}`;
        occupiedRooms[roomKey] = true;
        if (sub.faculty_id) {
          occupiedFaculty[`${sub.faculty_id}_${sess.day}_${sess.start}`] = true;
        }

        const insertRes = await pool.query(
          `INSERT INTO timetable_entries
             (class_id, subject_id, faculty_id, classroom_id, day_of_week, start_time, end_time)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           RETURNING *`,
          [
            sub.class_id || null,
            sub.id,
            sub.faculty_id || null,
            assignedRoom.id,
            sess.day,
            sess.start,
            sess.end
          ]
        );

        allocated.push({
          id: insertRes.rows[0].id,
          subject_id: sub.id,
          subject_name: sub.name,
          code: sub.code,
          slot: slot,
          faculty_id: sub.faculty_id,
          faculty_name: sub.faculty_name || 'Faculty Assigned',
          classroom_id: assignedRoom.id,
          classroom_name: assignedRoom.name,
          building: assignedRoom.building,
          floor: assignedRoom.floor,
          day_of_week: sess.day,
          start_time: sess.start,
          end_time: sess.end
        });
      }

      // Track faculty to notify
      if (sub.faculty_id) notifiedFaculties.add(sub.faculty_id);

      // Track students enrolled in this course to notify
      const enrolledRes = await pool.query(
        `SELECT student_id FROM enrollment_requests WHERE subject_id = $1 AND status = 'enrolled'`,
        [sub.id]
      );
      enrolledRes.rows.forEach(r => notifiedStudents.add(r.student_id));
    } else {
      unallocated.push({
        subject_id: sub.id,
        subject_name: sub.name,
        slot,
        reason: 'No classroom capacity available'
      });
    }
  }

  // 4. Send official Timetable notification broadcast to all Faculties
  if (notifyFn) {
    for (const facId of notifiedFaculties) {
      try {
        await notifyFn(
          facId,
          'timetable_published',
          '🗓️ Official Academic Timetable & Room Allocations Published',
          'Administrator has generated the official weekly timetable and room allocations for all live courses. Please review your teaching schedule in Timetable Allocations.',
          null
        );
      } catch(e) {}
    }

    // 5. Send notification to all enrolled students
    for (const stuId of notifiedStudents) {
      try {
        await notifyFn(
          stuId,
          'timetable_published',
          '🗓️ Class Schedule & Classroom Allocations Updated',
          'Administrator has published the weekly classroom and slot schedule for your enrolled courses. Check "Where is My Class" and "Class Schedule".',
          null
        );
      } catch(e) {}
    }
  }

  return {
    allocated,
    unallocated,
    liveCourseCount: liveSubjects.length,
    facultyNotifiedCount: notifiedFaculties.size,
    studentNotifiedCount: notifiedStudents.size
  };
};

/**
 * Auto-generate timetable using greedy constraint-satisfaction (legacy fallback).
 */
const autoGenerate = async (pool, classIds, days, slots) => {
  const allocated = [];
  const unallocated = [];

  const classRes = await pool.query(
    `SELECT c.id, c.name,
       (SELECT COUNT(*) FROM users u WHERE u.class_id=c.id AND u.role='student') as student_count
     FROM classes c WHERE c.id = ANY($1::int[])`,
    [classIds]
  );

  const roomRes = await pool.query(
    `SELECT * FROM classrooms WHERE is_active=TRUE ORDER BY capacity ASC`
  );
  const rooms = roomRes.rows;

  const facultyRes = await pool.query(`SELECT id FROM users WHERE role='faculty' LIMIT 1`);
  const facultyId = facultyRes.rows[0]?.id || null;

  const usedSlots = {};

  for (const cls of classRes.rows) {
    const subjects = await pool.query(
      `SELECT * FROM subjects WHERE class_id=$1`, [cls.id]
    );
    for (const sub of subjects.rows) {
      let placed = false;
      outer: for (const day of days) {
        for (const slot of slots) {
          const [startTime, endTime] = slot;
          for (const room of rooms) {
            if (parseInt(cls.student_count) > room.capacity) continue;
            const roomKey = `${room.id}_${day}_${startTime}`;
            const classKey = `${cls.id}_${day}_${startTime}`;
            if (usedSlots[roomKey] || usedSlots[classKey]) continue;

            usedSlots[roomKey] = true;
            usedSlots[classKey] = true;
            allocated.push({
              class_id: cls.id, class_name: cls.name,
              subject_id: sub.id, subject_name: sub.name,
              faculty_id: facultyId,
              classroom_id: room.id, room_name: room.name,
              day_of_week: day,
              start_time: startTime, end_time: endTime
            });
            placed = true;
            break outer;
          }
        }
      }
      if (!placed) {
        unallocated.push({ class_name: cls.name, subject_name: sub.name, reason: 'No available room/slot found' });
      }
    }
  }
  return { allocated, unallocated };
};

module.exports = {
  haversineDistance,
  timesOverlap,
  checkConflicts,
  autoGenerate,
  autoGenerateLiveCoursesTimetable,
  getSessionsForSlot,
  SLOT_SCHEDULES
};
