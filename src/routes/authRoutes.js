import { Router } from "express";
import {
  loginHandler,
  logoutHandler,
  meHandler,
  setupStatusHandler,
  signupHandler
} from "../controllers/authController.js";
import { requireAuth } from "../middleware/authMiddleware.js";

const router = Router();

router.get("/setup-status", setupStatusHandler);
router.post("/signup", signupHandler);
router.post("/login", loginHandler);
router.get("/me", requireAuth, meHandler);
router.post("/logout", requireAuth, logoutHandler);

export default router;
