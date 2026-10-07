import mongoose from 'mongoose';
import config from './config.js';

export async function connectDB() {
  // Reuse an existing connection on warm serverless invocations.
  // readyState: 1 = connected, 2 = connecting.
  if (mongoose.connection.readyState === 1) return mongoose.connection;

  if (!config.mongoUri) {
    throw new Error('MONGODB_URI is not set');
  }

  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, {
    serverSelectionTimeoutMS: 15000,
  });
  console.log(`[db] connected to MongoDB (${mongoose.connection.name})`);
  return mongoose.connection;
}
