// The whole backend (app + serverless handler) lives in ../index.js.
// This re-export keeps /api/index.js valid in case Vercel resolves here.
export { default } from '../index.js';
