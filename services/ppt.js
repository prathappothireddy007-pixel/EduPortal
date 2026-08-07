const PptxGenJS = require('pptxgenjs');

const getGradeInfo = (pct) => {
  if (!pct && pct !== 0) return { grade: 'N/A', status: 'No Data', color: '64748B' };
  if (pct >= 90) return { grade: 'S', status: 'Superior',  color: 'A855F7' };
  if (pct >= 80) return { grade: 'A', status: 'Very Good', color: '10B981' };
  if (pct >= 70) return { grade: 'B', status: 'Good',      color: '14B8A6' };
  if (pct >= 60) return { grade: 'C', status: 'Average',   color: '3B82F6' };
  if (pct >= 50) return { grade: 'D', status: 'Pass',      color: 'F59E0B' };
  return           { grade: 'F', status: 'Fail',       color: 'EF4444' };
};

const generateStudentReport = async (student, grades, attendance, className) => {
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_16x9';

  // Colors
  const DARK  = '0F172A';
  const SLATE = '1E293B';
  const LIGHT = 'F8FAFC';
  const ORANGE= 'F97316';
  const PINK  = 'EC4899';
  const TEXT  = '334155';

  // Calculate overall
  const numericScores = grades.map(g => parseFloat(g.score)).filter(n => !isNaN(n));
  const overallAvg = numericScores.length
    ? Math.round(numericScores.reduce((a, b) => a + b, 0) / numericScores.length)
    : null;
  const gInfo = getGradeInfo(overallAvg);

  const present = attendance.filter(a => a.status === 'Present').length;
  const absent  = attendance.filter(a => a.status === 'Absent').length;
  const od      = attendance.filter(a => a.status === 'OD').length;
  const total   = attendance.length || 1;
  const rate    = Math.round((present / total) * 100);

  // ── Slide 1: Cover ──
  const s1 = pres.addSlide();
  s1.background = { color: DARK };
  s1.addText('EDUPORTAL', {
    x: 0.5, y: 0.4, w: 9, h: 0.5,
    fontSize: 11, bold: true, color: ORANGE, charSpacing: 6, align: 'left'
  });
  s1.addText(`Weekly Academic Report`, {
    x: 0.5, y: 1.0, w: 9, h: 1.2,
    fontSize: 44, bold: true, color: LIGHT, align: 'left'
  });
  s1.addText(`Grade: ${gInfo.grade}  |  ${overallAvg !== null ? overallAvg + '%' : 'N/A'}  |  ${gInfo.status}`, {
    x: 0.5, y: 2.3, w: 9, h: 0.5,
    fontSize: 18, bold: true, color: ORANGE, align: 'left'
  });
  s1.addText(`Student: ${student.name}  |  Class: ${className || 'N/A'}`, {
    x: 0.5, y: 3.0, w: 9, h: 0.4,
    fontSize: 14, color: '94A3B8', align: 'left'
  });
  s1.addText(`Generated: ${new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' })}`, {
    x: 0.5, y: 3.5, w: 9, h: 0.3,
    fontSize: 10, color: '475569', align: 'left', italic: true
  });

  // Grade scale box
  const gradeScale = [
    { g: 'S', r: '≥90', c: 'A855F7' }, { g: 'A', r: '≥80', c: '10B981' },
    { g: 'B', r: '≥70', c: '14B8A6' }, { g: 'C', r: '≥60', c: '3B82F6' },
    { g: 'D', r: '≥50', c: 'F59E0B' }, { g: 'F', r: '<50',  c: 'EF4444' }
  ];
  gradeScale.forEach((item, i) => {
    s1.addText(`${item.g} (${item.r}%)`, {
      x: 0.5 + i * 1.6, y: 5.2, w: 1.4, h: 0.5,
      fontSize: 11, bold: true, color: item.c, align: 'center',
      fill: { type: 'solid', color: SLATE },
      rectRadius: 0.05
    });
  });

  // ── Slide 2: Grade Table ──
  const s2 = pres.addSlide();
  s2.background = { color: LIGHT };
  s2.addText('Academic Performance', {
    x: 0.4, y: 0.2, w: 9.2, h: 0.6,
    fontSize: 24, bold: true, color: DARK, align: 'left'
  });
  s2.addText(`Subject-wise Grades  |  ${student.name}`, {
    x: 0.4, y: 0.8, w: 9.2, h: 0.3,
    fontSize: 11, color: '64748B', align: 'left'
  });

  if (grades.length > 0) {
    const bySubject = {};
    grades.forEach(g => {
      if (!bySubject[g.subject_name]) bySubject[g.subject_name] = {};
      bySubject[g.subject_name][`W${g.week}`] = g.score;
    });
    const weeks    = [...new Set(grades.map(g => g.week))].sort((a, b) => a - b);
    const subjects = Object.keys(bySubject);

    const headerRow = [
      { text: 'Subject', options: { bold: true, fill: { type: 'solid', color: ORANGE }, color: LIGHT, fontSize: 10 } },
      ...weeks.map(w => ({ text: `Week ${w}`, options: { bold: true, fill: { type: 'solid', color: ORANGE }, color: LIGHT, fontSize: 10, align: 'center' } })),
      { text: 'Avg %', options: { bold: true, fill: { type: 'solid', color: PINK }, color: LIGHT, fontSize: 10, align: 'center' } },
      { text: 'Grade', options: { bold: true, fill: { type: 'solid', color: PINK }, color: LIGHT, fontSize: 10, align: 'center' } }
    ];

    const rows = subjects.map((sub, i) => {
      const scores = weeks.map(w => bySubject[sub][`W${w}`] || '—');
      const nums   = scores.map(s => parseFloat(s)).filter(n => !isNaN(n));
      const avg    = nums.length ? Math.round(nums.reduce((a, b) => a + b, 0) / nums.length) : null;
      const gi     = getGradeInfo(avg);
      const fill   = i % 2 === 0 ? LIGHT : 'F1F5F9';
      return [
        { text: sub, options: { bold: true, fill: { type: 'solid', color: fill }, color: TEXT, fontSize: 9 } },
        ...scores.map(s => ({ text: s, options: { fill: { type: 'solid', color: fill }, color: TEXT, fontSize: 9, align: 'center' } })),
        { text: avg !== null ? avg + '%' : '—', options: { bold: true, fill: { type: 'solid', color: gi.color }, color: LIGHT, fontSize: 9, align: 'center' } },
        { text: gi.grade, options: { bold: true, fill: { type: 'solid', color: gi.color }, color: LIGHT, fontSize: 12, align: 'center' } }
      ];
    });

    s2.addTable([headerRow, ...rows], {
      x: 0.4, y: 1.2, w: 9.2, rowH: 0.42,
      border: { pt: 0.5, color: 'E2E8F0' },
      autoPage: true
    });
  } else {
    s2.addText('No grade records available.', {
      x: 0.5, y: 3, w: 9, h: 0.5,
      fontSize: 14, color: '94A3B8', italic: true, align: 'center'
    });
  }

  // ── Slide 3: Attendance ──
  const s3 = pres.addSlide();
  s3.background = { color: DARK };
  s3.addText('Attendance Summary', {
    x: 0.4, y: 0.2, w: 9, h: 0.6,
    fontSize: 24, bold: true, color: LIGHT
  });
  s3.addText(student.name, {
    x: 0.4, y: 0.85, w: 9, h: 0.3,
    fontSize: 11, color: '64748B'
  });

  const attColor = rate >= 75 ? '10B981' : rate >= 50 ? 'F59E0B' : 'EF4444';
  s3.addText(`${rate}%`, {
    x: 3.5, y: 1.8, w: 3, h: 1.2,
    fontSize: 56, bold: true, color: attColor, align: 'center',
    fill: { type: 'solid', color: SLATE }, rectRadius: 0.15
  });
  s3.addText('Attendance Rate', { x: 3.5, y: 3.1, w: 3, h: 0.3, fontSize: 11, color: '94A3B8', align: 'center' });

  [
    { l: 'Present', v: present, c: '10B981', x: 0.5, y: 2.0 },
    { l: 'Absent',  v: absent,  c: 'EF4444', x: 0.5, y: 3.2 },
    { l: 'OD Days', v: od,      c: 'F59E0B', x: 7.2, y: 2.0 },
    { l: 'Total',   v: attendance.length, c: '6366F1', x: 7.2, y: 3.2 }
  ].forEach(s => {
    s3.addText(String(s.v), { x: s.x, y: s.y, w: 1.8, h: 0.6, fontSize: 28, bold: true, color: s.c, align: 'center', fill: { type: 'solid', color: SLATE }, rectRadius: 0.1 });
    s3.addText(s.l, { x: s.x, y: s.y + 0.62, w: 1.8, h: 0.3, fontSize: 10, color: '64748B', align: 'center' });
  });

  // ── Slide 4: Evaluation & Recommendations ──
  const s4 = pres.addSlide();
  s4.background = { color: LIGHT };
  s4.addText('Evaluation & Final Grade', {
    x: 0.4, y: 0.2, w: 9.2, h: 0.6,
    fontSize: 24, bold: true, color: DARK
  });
  s4.addText(student.name, { x: 0.4, y: 0.8, w: 9.2, h: 0.3, fontSize: 11, color: '64748B' });

  // Grade card
  s4.addText(gInfo.grade, {
    x: 0.4, y: 1.2, w: 1.5, h: 1.5,
    fontSize: 64, bold: true, color: gInfo.color, align: 'center',
    fill: { type: 'solid', color: SLATE }, rectRadius: 0.15
  });
  s4.addText(`${overallAvg !== null ? overallAvg + '%' : 'N/A'} — ${gInfo.status}`, {
    x: 2.1, y: 1.4, w: 7.5, h: 0.5, fontSize: 20, bold: true, color: gInfo.color
  });
  s4.addText(`Result: ${overallAvg !== null ? (overallAvg >= 50 ? '✅ PASS' : '❌ FAIL') : '—'}`, {
    x: 2.1, y: 1.95, w: 7.5, h: 0.4, fontSize: 14, bold: true, color: overallAvg >= 50 ? '10B981' : 'EF4444'
  });

  const performance =
    !overallAvg && overallAvg !== 0 ? 'Insufficient data to evaluate performance.' :
    overallAvg >= 90 ? '🌟 Superior performance (Grade S)! Excelling at the highest level.' :
    overallAvg >= 80 ? '🌟 Excellent performance (Grade A)! Very strong results.' :
    overallAvg >= 70 ? '✅ Good performance (Grade B). Consistently on track.' :
    overallAvg >= 60 ? '⚡ Average performance (Grade C). Maintaining acceptable standards.' :
    overallAvg >= 50 ? '⚠️ Pass (Grade D). Minimum threshold met, improvement needed.' :
    '❌ Fail (Grade F). Below 50%. Immediate attention and support required.';

  const attendanceNote =
    rate >= 85 ? '✅ Excellent attendance record.' :
    rate >= 75 ? '⚠️ Acceptable attendance, but could be improved.' :
    '❌ Poor attendance. Significantly impacting academic performance.';

  [
    { title: '📊 Academic Performance', body: performance },
    { title: '📅 Attendance', body: attendanceNote },
  ].forEach((item, i) => {
    const y = 3.0 + i * 1.3;
    s4.addText(item.title, { x: 0.4, y, w: 9.2, h: 0.35, fontSize: 12, bold: true, color: TEXT });
    s4.addText(item.body,  { x: 0.4, y: y+0.38, w: 9.2, h: 0.7, fontSize: 11, color: '64748B', wrap: true });
  });

  s4.addText(`Generated by EduPortal  |  ${new Date().toLocaleString()}`, {
    x: 0, y: 6.8, w: 10, h: 0.2,
    fontSize: 8, color: '94A3B8', italic: true, align: 'center'
  });

  // Return Node.js Buffer — use string form (most compatible)
  const buffer = await pres.write('nodebuffer');
  return buffer;
};

module.exports = { generateStudentReport };
