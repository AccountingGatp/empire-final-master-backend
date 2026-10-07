import mongoose from 'mongoose';

// A signed-in user (Google account restricted to the allowed domain).
const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    googleId: { type: String, index: true },
    name: { type: String, default: '' },
    picture: { type: String, default: '' },
    lastLoginAt: { type: Date, default: null },
    loginCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

export default mongoose.model('User', userSchema);
