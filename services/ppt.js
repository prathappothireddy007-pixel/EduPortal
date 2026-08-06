const PptxGenJS = require('pptxgenjs');

/**
 * Generate a comprehensive PPT report for a student
 * Returns a Buffer containing the .pptx file
 */
const generateStudentReport = async (student, grades, attendance, className) => {
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_16x9';

  // ── Colors ──
  const ORANGE = 'F97316';
  const PINK   = 'EC4899';
  const DARK   = '0F172A';
  const SLATE  = '1E293B';
  const LIGHT  = 'F8FAFC';
  const TEXT   = '334155';

  // ── Slide 1: Cover ──
  const s1 = pres.addSlide();
  s1.background = { color: DARK };
  // Gradient accent bar
  s1.addShape(pres.ShapeType.rect, {
    x: 0, y: 0, w: 0.3, h: '100%',
    fill: { type: 'solid', color: ORANGE }
  });
  s1.addShape(pres.ShapeType.rect, {
    x: 0.3, y: 0, w: 0.1, h: '100%',
    fill: { type: 'solid', color: PINK }
  });
  s1.addText('E', {
    x: 0.8, y: 1.0, w: 0.8, h: 0.8,
    fontSize: 28, bold: true, color: LIGHT,
    align: 'center', valign: 'middle',
    fill: { type: 'solid', color: ORANGE },
    rectRadius: 0.1
  });
  s1.addText('EDUPORTAL', {
    x: 1.7, y: 1.1, w: 5, h: 0.35,
    fontSize: 11, bold: true, color: ORANGE,
    charSpacing: 4
  });
  s1.addText('Management System', {
    x: 1.7, y: 1.4, w: 5, h: 0.25,
    fontSize: 9, color: '64748B', charSpacing: 1
  });
  s1.addText('Weekly Academic\nProgress Report', {
    x: 0.8, y: 2.2, w: 8.5, h: 1.5,
    fontSize: 38, bold: true, color: LIGHT,
    lineSpacingMultiple: 1.2
  });
  s1.addShape(pres.ShapeType.rect, {
    x: 0.8, y: 3.9, w: 2.5, h: 0.04,
    fill: { type: 'solid', color: ORANGE }
  });
  s1.addText(`Student: ${student.name}`, {
    x: 0.8, y: 4.1, w: 8, h: 0.4,
    fontSize: 16, color: 'F1F5F9', bold: true
  });
  s1.addText(`Class: ${className || 'N/A'}  |  Date: ${new Date().toLocaleDateString('en-IN', { day:'2-digit', month:'long', year:'numeric' })}`, {
    x: 0.8, y: 4.55, w: 8, h: 0.3,
    fontSize: 11, color: '94A3B8'
  });
  s1.addText('CONFIDENTIAL — For parent/guardian use only', {
    x: 0.8, y: 6.8, w: 8, h: 0.2,
    fontSize: 8, color: '475569', italic: true
  });

  // ── Slide 2: Grades Table ──
  const s2 = pres.addSlide();
  s2.background = { color: LIGHT };
  s2.addShape(pres.ShapeType.rect, {
    x: 0, y: 0, w: '100%', h: 1.1,
    fill: { type: 'solid', color: DARK }
  });
  s2.addText('Academic Performance', {
    x: 0.5, y: 0.1, w: 8, h: 0.5,
    fontSize: 22, bold: true, color: LIGHT
  });
  s2.addText(`Week-by-Week Grade Breakdown  |  ${student.name}`, {
    x: 0.5, y: 0.62, w: 8, h: 0.3,
    fontSize: 10, color: '94A3B8'
  });

  if (grades.length > 0) {
    // Build table rows grouped by subject
    const bySubject = {};
    grades.forEach(g => {
      if (!bySubject[g.subject_name]) bySubject[g.subject_name] = {};
      bySubject[g.subject_name][`W${g.week}`] = g.score;
    });

    const weeks = [...new Set(grades.map(g => g.week))].sort((a, b) => a - b);
    const subjects = Object.keys(bySubject);

    const headerRow = [
      { text: 'Subject', options: { bold: true, fill: ORANGE, color: LIGHT, fontSize: 10 } },
      ...weeks.map(w => ({
        text: `Week ${w}`,
        options: { bold: true, fill: ORANGE, color: LIGHT, fontSize: 10, align: 'center' }
      })),
      { text: 'Average', options: { bold: true, fill: PINK, color: LIGHT, fontSize: 10, align: 'center' } }
    ];

    const rows = subjects.map((sub, i) => {
      const scores = weeks.map(w => bySubject[sub][`W${w}`] || '-');
      const numericScores = scores.map(s => parseFloat(s)).filter(n => !isNaN(n));
      const avg = numericScores.length > 0
        ? Math.round(numericScores.reduce((a, b) => a + b, 0) / numericScores.length)
        : '-';
      const fill = i % 2 === 0 ? LIGHT : 'F1F5F9';
      const avgColor = avg !== '-' ? (avg >= 75 ? '10B981' : avg >= 50 ? 'F59E0B' : 'EF4444') : '64748B';

      return [
        { text: sub, options: { bold: true, fill, color: TEXT, fontSize: 9 } },
        ...scores.map(s => ({ text: s, options: { fill, color: TEXT, fontSize: 9, align: 'center' } })),
        { text: avg !== '-' ? `${avg}%` : '-', options: { bold: true, fill: avgColor, color: LIGHT, fontSize: 9, align: 'center' } }
      ];
    });

    s2.addTable([headerRow, ...rows], {
      x: 0.4, y: 1.3, w: 9.2,
      rowH: 0.38,
      border: { pt: 0.5, color: 'E2E8F0' },
      autoPage: true
    });
  } else {
    s2.addText('No grade records available yet.', {
      x: 0.5, y: 2.5, w: 9, h: 0.5,
      fontSize: 14, color: '94A3B8', italic: true, align: 'center'
    });
  }

  // ── Slide 3: Attendance Summary ──
  const s3 = pres.addSlide();
  s3.background = { color: DARK };
  s3.addShape(pres.ShapeType.rect, {
    x: 0, y: 0, w: '100%', h: 1.1,
    fill: { type: 'solid', color: SLATE }
  });
  s3.addText('Attendance Summary', {
    x: 0.5, y: 0.12, w: 8, h: 0.5,
    fontSize: 22, bold: true, color: LIGHT
  });
  s3.addText(`Attendance Breakdown  |  ${student.name}`, {
    x: 0.5, y: 0.65, w: 8, h: 0.3,
    fontSize: 10, color: '64748B'
  });

  const present = attendance.filter(a => a.status === 'Present').length;
  const absent  = attendance.filter(a => a.status === 'Absent').length;
  const od      = attendance.filter(a => a.status === 'OD').length;
  const total   = attendance.length || 1;
  const rate    = Math.round((present / total) * 100);

  // Big rate display
  const rateColor = rate >= 75 ? '10B981' : rate >= 50 ? 'F59E0B' : 'EF4444';
  s3.addShape(pres.ShapeType.ellipse, {
    x: 3.5, y: 1.4, w: 3, h: 3,
    fill: { type: 'solid', color: SLATE },
    line: { pt: 4, color: rateColor }
  });
  s3.addText(`${rate}%`, {
    x: 3.5, y: 2.5, w: 3, h: 1,
    fontSize: 42, bold: true, color: rateColor, align: 'center', valign: 'middle'
  });
  s3.addText('Attendance Rate', {
    x: 3.5, y: 3.5, w: 3, h: 0.3,
    fontSize: 11, color: '94A3B8', align: 'center'
  });

  // Stats
  const stats = [
    { label: 'Present', val: present, color: '10B981' },
    { label: 'Absent', val: absent, color: 'EF4444' },
    { label: 'OD', val: od, color: 'F59E0B' },
    { label: 'Total Days', val: attendance.length, color: '6366F1' }
  ];
  stats.forEach((s, i) => {
    const x = 0.4 + (i % 2) * 1.5;
    const y = 1.8 + Math.floor(i / 2) * 1.1;
    s3.addShape(pres.ShapeType.rect, {
      x, y, w: 1.3, h: 0.85,
      fill: { type: 'solid', color: SLATE },
      line: { pt: 2, color: s.color },
      rectRadius: 0.08
    });
    s3.addText(String(s.val), {
      x, y: y + 0.05, w: 1.3, h: 0.45,
      fontSize: 22, bold: true, color: s.color, align: 'center'
    });
    s3.addText(s.label, {
      x, y: y + 0.48, w: 1.3, h: 0.25,
      fontSize: 9, color: '94A3B8', align: 'center'
    });
  });

  // ── Slide 4: Recommendations ──
  const s4 = pres.addSlide();
  s4.background = { color: LIGHT };
  s4.addShape(pres.ShapeType.rect, {
    x: 0, y: 0, w: '100%', h: 1.1,
    fill: { type: 'solid', color: DARK }
  });
  s4.addText('Summary & Recommendations', {
    x: 0.5, y: 0.12, w: 8, h: 0.5,
    fontSize: 22, bold: true, color: LIGHT
  });
  s4.addText(student.name, {
    x: 0.5, y: 0.65, w: 8, h: 0.3,
    fontSize: 10, color: '94A3B8'
  });

  const avgScores = grades.map(g => parseFloat(g.score)).filter(n => !isNaN(n));
  const overallAvg = avgScores.length
    ? Math.round(avgScores.reduce((a, b) => a + b, 0) / avgScores.length)
    : null;

  const getGradeInfo = (pct) => {
    if (pct === null) return { grade: 'N/A', status: 'No Data' };
    if (pct >= 90) return { grade: 'S', status: 'Superior (Pass)' };
    if (pct >= 80) return { grade: 'A', status: 'Very Good (Pass)' };
    if (pct >= 70) return { grade: 'B', status: 'Good (Pass)' };
    if (pct >= 60) return { grade: 'C', status: 'Average (Pass)' };
    if (pct >= 50) return { grade: 'D', status: 'Pass' };
    return { grade: 'F', status: 'Fail (Below 50%)' };
  };

  const gradeInfo = getGradeInfo(overallAvg);

  const performance =
    !overallAvg ? 'Insufficient data to evaluate performance.' :
    overallAvg >= 90 ? '🌟 Superior performance (Grade S)! Student is excelling at the top tier.' :
    overallAvg >= 80 ? '🌟 Excellent performance (Grade A)! Student is performing very well.' :
    overallAvg >= 70 ? '✅ Good performance (Grade B). Student is consistently on track.' :
    overallAvg >= 60 ? '⚡ Average performance (Grade C). Steady performance across subjects.' :
    overallAvg >= 50 ? '⚠️ Pass (Grade D). Minimum passing threshold met, needs improvement.' :
    '❌ Fail (Grade F). Overall score is below 50%. Immediate intervention required.';

  const attendanceNote =
    rate >= 85 ? '✅ Excellent attendance. Full participation.' :
    rate >= 75 ? '⚠️ Attendance is acceptable but could be improved.' :
    '❌ Low attendance. This may impact academic performance significantly.';

  [
    { icon: '📊', title: 'Evaluation & Final Grade', text: `Overall Percentage: ${overallAvg !== null ? overallAvg + '%' : 'N/A'} | Final Grade: ${gradeInfo.grade} (${gradeInfo.status})` },
    { icon: '🎓', title: 'Academic Standing', text: performance },
    { icon: '📅', title: 'Attendance Standing', text: attendanceNote }
  ].forEach((item, i) => {
    const y = 1.4 + i * 1.35;
    s4.addShape(pres.ShapeType.rect, {
      x: 0.4, y, w: 9.2, h: 1.15,
      fill: { type: 'solid', color: 'F8FAFC' },
      line: { pt: 1, color: 'E2E8F0' },
      rectRadius: 0.1
    });
    s4.addText(`${item.icon} ${item.title}`, {
      x: 0.7, y: y + 0.1, w: 8.5, h: 0.35,
      fontSize: 12, bold: true, color: TEXT
    });
    s4.addText(item.text, {
      x: 0.7, y: y + 0.45, w: 8.5, h: 0.55,
      fontSize: 11, color: '64748B', wrap: true
    });
  });

  s4.addText(`Generated by EduPortal on ${new Date().toLocaleString()}`, {
    x: 0, y: 6.8, w: 10, h: 0.2,
    fontSize: 8, color: '94A3B8', italic: true, align: 'center'
  });

  // Write to buffer
  const buffer = await pres.write({ outputType: 'nodebuffer' });
  return buffer;
};

module.exports = { generateStudentReport };
