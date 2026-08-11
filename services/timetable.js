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

/**
 * Auto-generate timetable using greedy constraint-satisfaction.
 * Returns { allocated, unallocated } arrays.
 */
const autoGenerate = async (pool, classIds, days, slots) => {
  const allocated = [];
  const unallocated = [];

  // Fetch classes with their subjects and student counts
  const classRes = await pool.query(
    `SELECT c.id, c.name,
       (SELECT COUNT(*) FROM users u WHERE u.class_id=c.id AND u.role='student') as student_count
     FROM classes c WHERE c.id = ANY($1::int[])`,
    [classIds]
  );

  // Fetch classrooms
  const roomRes = await pool.query(
    `SELECT * FROM classrooms WHERE is_active=TRUE ORDER BY capacity ASC`
  );
  const rooms = roomRes.rows;

  // Fetch faculty
  const facultyRes = await pool.query(`SELECT id FROM users WHERE role='faculty' LIMIT 1`);
  const facultyId = facultyRes.rows[0]?.id || null;

  const usedSlots = {}; // track: room+day+slot, class+day+slot

  for (const cls of classRes.rows) {
    const subjects = await pool.query(
      `SELECT * FROM subjects WHERE class_id=$1`, [cls.id]
    );
    for (const sub of subjects.rows) {
      let placed = false;
      outer: for (const day of days) {
        for (const slot of slots) {
          const [startTime, endTime] = slot;
          // Find available room with sufficient capacity
          for (const room of rooms) {
            if (parseInt(cls.student_count) > room.capacity) continue;
            const roomKey = `${room.id}_${day}_${startTime}`;
            const classKey = `${cls.id}_${day}_${startTime}`;
            if (usedSlots[roomKey] || usedSlots[classKey]) continue;

            // No conflicts — allocate
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

module.exports = { haversineDistance, timesOverlap, checkConflicts, autoGenerate };
