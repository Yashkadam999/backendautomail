import {
  getSetupStatus,
  loginAdmin,
  logoutAdmin,
  signupAdmin
} from "../services/authService.js";

function sanitizeAdmin(admin) {
  return {
    id: admin.id,
    email: admin.email,
    gmailUser: admin.gmailUser,
    gmailFromName: admin.gmailFromName,
    createdAt: admin.createdAt
  };
}

export async function setupStatusHandler(_req, res) {
  try {
    const status = await getSetupStatus();
    return res.json(status);
  } catch (error) {
    return res.status(500).json({ message: "Unable to fetch setup status" });
  }
}

export async function signupHandler(req, res) {
  try {
    const { admin, token } = await signupAdmin(req.body || {});
    return res.status(201).json({
      message: "Admin signup successful",
      admin: sanitizeAdmin(admin),
      token
    });
  } catch (error) {
    const status = error.status || 400;
    return res.status(status).json({ message: error.message || "Signup failed" });
  }
}

export async function loginHandler(req, res) {
  try {
    const { admin, token } = await loginAdmin(req.body || {});
    return res.json({
      message: "Login successful",
      admin: sanitizeAdmin(admin),
      token
    });
  } catch (error) {
    const status = error.status || 401;
    return res.status(status).json({ message: error.message || "Login failed" });
  }
}

export function meHandler(req, res) {
  return res.json({ admin: sanitizeAdmin(req.admin) });
}

export async function logoutHandler(req, res) {
  try {
    await logoutAdmin(req.admin.id);
    return res.json({ message: "Logged out successfully" });
  } catch (error) {
    return res.status(500).json({ message: "Logout failed" });
  }
}
