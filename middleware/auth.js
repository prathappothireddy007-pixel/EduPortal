const jwt = require('jsonwebtoken');

const authenticate = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer '))
    return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

const requireFaculty = (req, res, next) => {
  if (req.user.role !== 'faculty')
    return res.status(403).json({ error: 'Faculty access required' });
  next();
};

const requireStudent = (req, res, next) => {
  if (req.user.role !== 'student')
    return res.status(403).json({ error: 'Student access required' });
  next();
};

module.exports = { authenticate, requireFaculty, requireStudent };
