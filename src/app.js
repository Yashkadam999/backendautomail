import cors from "cors";
import express from "express";
import morgan from "morgan";
import { requireAuth } from "./middleware/authMiddleware.js";
import authRoutes from "./routes/authRoutes.js";
import campaignRoutes from "./routes/campaignRoutes.js";

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: "20mb" }));
  app.use(morgan("dev"));

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", service: "skeduloo-message-scheduling" });
  });

  app.use("/auth", authRoutes);
  app.use("/api/auth", authRoutes);

  app.use(requireAuth);
  app.use("/", campaignRoutes);
  app.use("/api", campaignRoutes);

  app.use((error, _req, res, _next) => {
    console.error(error);
    return res.status(500).json({ message: "Unexpected server error" });
  });

  return app;
}
