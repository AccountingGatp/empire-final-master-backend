import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';
import config from '../config.js';
import User from '../models/User.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();
const googleClient = new OAuth2Client(config.auth.googleClientId);

// POST /api/auth/google  { credential }
// Verify the Google ID token, enforce the allowed email domain, upsert the user
// into the `users` collection, and return a session JWT.
router.post('/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential) return res.status(400).json({ error: 'missing Google credential' });
  if (!config.auth.googleClientId) {
    return res.status(500).json({ error: 'GOOGLE_CLIENT_ID is not configured on the server' });
  }

  // 1) Verify the token really came from Google and was issued for our app.
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: config.auth.googleClientId,
    });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: 'invalid Google credential' });
  }

  // 2) Enforce the allowed domain.
  const email = String(payload.email || '').toLowerCase();
  const domain = config.auth.allowedDomain.toLowerCase();
  if (!payload.email_verified || !email.endsWith(`@${domain}`)) {
    return res.status(403).json({ error: `Access is restricted to @${domain} accounts.` });
  }

  // 3) Store / update the user.
  const user = await User.findOneAndUpdate(
    { email },
    {
      $set: {
        email,
        googleId: payload.sub,
        name: payload.name || '',
        picture: payload.picture || '',
        lastLoginAt: new Date(),
      },
      $inc: { loginCount: 1 },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );

  // 4) Issue a session token.
  const token = jwt.sign(
    { sub: String(user._id), email: user.email, name: user.name, picture: user.picture },
    config.auth.jwtSecret,
    { expiresIn: config.auth.sessionTtl }
  );

  res.json({
    token,
    user: { id: String(user._id), email: user.email, name: user.name, picture: user.picture },
  });
});

// GET /api/auth/me  (Bearer) -> the current session's user.
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

export default router;
