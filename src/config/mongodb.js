import mongoose from "mongoose";
import { env } from "./env.js";

let isConnected = false;

export async function connectMongoDB() {
  if (isConnected) {
    console.log("MongoDB already connected");
    return;
  }

  try {
    await mongoose.connect(env.mongodb.uri, {
      retryWrites: env.mongodb.retryWrites,
      connectTimeoutMS: env.mongodb.connectTimeoutMS
    });
    isConnected = true;
    console.log("MongoDB connected successfully");
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    throw error;
  }
}

export async function disconnectMongoDB() {
  if (!isConnected) {
    return;
  }

  try {
    await mongoose.disconnect();
    isConnected = false;
    console.log("MongoDB disconnected");
  } catch (error) {
    console.error("MongoDB disconnection failed:", error);
    throw error;
  }
}

export function getMongoDBConnection() {
  return mongoose.connection;
}
