# EduPortal v2.0 — Full-Stack School Management System

## 🚀 Deploy on Render (3 steps)

### Step 1 — Push to GitHub
```bash
cd C:\Users\ragha\.gemini\antigravity\scratch\eduportal
git init
git add .
git commit -m "EduPortal v2.0 — Full stack with OD geo-verification"
git remote add origin https://github.com/YOUR_USERNAME/eduportal.git
git push -u origin main
```

### Step 2 — Create Render Services
1. Go to https://render.com → **New** → **Blueprint**
2. Connect your GitHub repo
3. Render will auto-read `render.yaml` and create:
   - **Web Service** (Node.js)
   - **PostgreSQL Database** (free tier)

### Step 3 — Set Environment Variables on Render
In your Web Service → **Environment** tab, verify these are set:
| Variable | Value |
|---|---|
| `GMAIL_USER` | j77269801@gmail.com |
| `GMAIL_APP_PASSWORD` | *(create App Password below)* |
| `JWT_SECRET` | *(auto-generated)* |
| `ADMIN_ID` | 192411184 |
| `ADMIN_PASSWORD` | katam@123 |

---

## ⚠️ Gmail App Password (Required for email)
Regular Gmail passwords don't work with SMTP. You need an App Password:
1. Go to https://myaccount.google.com/security
2. Enable **2-Step Verification** if not already
3. Go to **App Passwords** → Select "Mail" → Generate
4. Copy the 16-character password → paste in `GMAIL_APP_PASSWORD`

---

## 🏃 Run Locally
```bash
# Set up local PostgreSQL first, then:
npm start
# Visit: http://localhost:3000
```

---

## 🔐 Default Login
| Role | Field | Value |
|---|---|---|
| Faculty | Admin ID | 192411184 |
| Faculty | Password | katam@123 |
| Student | Email | (add students first from faculty panel) |
| Student | Password | welcome (default) |

---

## ✨ Features
- 🎓 **Faculty**: Students, Curriculum, Gradebook, Attendance, Events, Reports
- 👤 **Student**: Overview, Enrollment, Attendance, Events, OD Application
- 📋 **OD Flow**: Apply → Letter Photo → Faculty Approve → 30-min Geo-Cam → Auto-absent
- 📍 **Geo-Tag Camera**: Live in-app camera with GPS overlay, no file upload
- 📊 **Auto PPT**: 4-slide professional report auto-emailed to parent
- ⏰ **Auto Absent**: Cron job every 2 minutes expires ODs past 30-min window
- 🌙 **Dark Mode**: Beautiful glassmorphism UI
