import jwt from 'jsonwebtoken';
import config from '../config.js';

// Verify the Bearer session token and attach req.user. 401 if missing/invalid.
export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'authentication required' });

  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      name: decoded.name,
      picture: decoded.picture,
    };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid or expired session' });
  }
}
