const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  },
  tls: { rejectUnauthorized: false }
});

/**
 * Send PPT report to parent email
 * @param {string} parentEmail
 * @param {string} studentName
 * @param {Buffer} pptBuffer
 * @param {string} fileName
 */
const sendPPTReport = async (parentEmail, studentName, pptBuffer, fileName) => {
  if (!parentEmail) throw new Error('No parent email');

  const mailOptions = {
    from: `"EduPortal System" <${process.env.GMAIL_USER}>`,
    to: parentEmail,
    subject: `📊 Weekly Academic Report — ${studentName}`,
    html: `
      <div style="font-family: 'Segoe UI', Arial, sans-serif; max-width:600px; margin:0 auto; background:#0f172a; color:#e2e8f0; padding:32px; border-radius:16px;">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:24px;">
          <div style="width:48px;height:48px;background:linear-gradient(135deg,#f97316,#ec4899);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;color:white;">E</div>
          <div>
            <h2 style="margin:0;color:#fff;font-size:20px;">EduPortal</h2>
            <p style="margin:0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:2px;">Academic Report</p>
          </div>
        </div>

        <h1 style="font-size:22px;margin-bottom:8px;color:#fff;">Weekly Progress Report</h1>
        <p style="color:#94a3b8;margin-bottom:24px;">Dear Parent / Guardian,</p>

        <p style="color:#cbd5e1;line-height:1.7;">
          Please find attached the weekly academic progress report for
          <strong style="color:#f97316;">${studentName}</strong>.
          This report includes grade performance across all subjects and attendance summary for this week.
        </p>

        <div style="background:#1e293b;border-radius:12px;padding:20px;margin:24px 0;border-left:4px solid #f97316;">
          <p style="margin:0;color:#f97316;font-weight:700;font-size:13px;text-transform:uppercase;letter-spacing:1px;">📎 Attachment</p>
          <p style="margin:8px 0 0;color:#cbd5e1;font-size:14px;">${fileName}</p>
        </div>

        <p style="color:#94a3b8;font-size:13px;">
          For any queries, please contact the school administration directly.
        </p>

        <hr style="border:1px solid #1e293b;margin:24px 0;">
        <p style="color:#475569;font-size:11px;text-align:center;">
          This is an automated email from EduPortal Management System. Do not reply to this email.
        </p>
      </div>
    `,
    attachments: [{
      filename: fileName,
      content: pptBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }]
  };

  const info = await transporter.sendMail(mailOptions);
  console.log(`📧 Email sent to ${parentEmail}: ${info.messageId}`);
  return info;
};

/**
 * Send absence alert to parent
 */
const sendAbsenceAlert = async (parentEmail, studentName, date) => {
  if (!parentEmail) return;
  try {
    await transporter.sendMail({
      from: `"EduPortal System" <${process.env.GMAIL_USER}>`,
      to: parentEmail,
      subject: `⚠️ Attendance Alert — ${studentName} marked Absent`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width:500px; margin:0 auto; padding:24px; background:#1e293b; color:#e2e8f0; border-radius:12px;">
          <h2 style="color:#ef4444;">Absence Notification</h2>
          <p>Dear Parent,</p>
          <p><strong>${studentName}</strong> was marked <strong style="color:#ef4444;">ABSENT</strong> on <strong>${date}</strong>.</p>
          <p>Please contact the school if you have any questions.</p>
          <p style="color:#64748b;font-size:12px;">— EduPortal Management System</p>
        </div>
      `
    });
  } catch (err) {
    console.error('Absence alert email error:', err.message);
  }
};

module.exports = { sendPPTReport, sendAbsenceAlert };
