const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: 'smtp.gmail.com',
  port: 465,
  secure: true,          // SSL — more reliable than STARTTLS on cloud hosts
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD
  },
  tls: { rejectUnauthorized: false }
});

// Verify SMTP connection on startup (non-fatal)
transporter.verify((err) => {
  if (err) console.warn('⚠️  SMTP connection issue:', err.message);
  else console.log('✅ SMTP ready — emails will be sent via', process.env.GMAIL_USER);
});

const sendPPTReport = async (parentEmail, studentName, pptBuffer, fileName) => {
  if (!parentEmail) throw new Error('No parent email configured');

  await transporter.sendMail({
    from: `"EduPortal" <${process.env.GMAIL_USER}>`,
    to: parentEmail,
    subject: `📊 Academic Report — ${studentName}`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;background:#0f172a;color:#e2e8f0;padding:32px;border-radius:16px;">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:24px;">
          <div style="width:48px;height:48px;background:linear-gradient(135deg,#f97316,#ec4899);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:22px;font-weight:900;color:white;">E</div>
          <div>
            <h2 style="margin:0;color:#fff;font-size:20px;">EduPortal</h2>
            <p style="margin:0;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:2px;">Academic Report</p>
          </div>
        </div>
        <h1 style="font-size:22px;margin-bottom:8px;color:#fff;">Weekly Progress Report</h1>
        <p style="color:#cbd5e1;line-height:1.7;">
          Please find attached the academic progress report for
          <strong style="color:#f97316;">${studentName}</strong>.
        </p>
        <div style="background:#1e293b;border-radius:12px;padding:20px;margin:24px 0;border-left:4px solid #f97316;">
          <p style="margin:0;color:#f97316;font-weight:700;font-size:13px;">📎 ${fileName}</p>
        </div>
        <hr style="border:1px solid #1e293b;margin:24px 0;">
        <p style="color:#475569;font-size:11px;text-align:center;">This is an automated email from EduPortal. Do not reply.</p>
      </div>`,
    attachments: [{
      filename: fileName,
      content: pptBuffer,
      contentType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    }]
  });
};

module.exports = { sendPPTReport };
