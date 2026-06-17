import { getAdminFromToken } from "../services/authService.js";

function extractBearerToken(authorizationHeader = "") {
  const [scheme, token] = String(authorizationHeader).split(" ");
  if (scheme !== "Bearer" || !token) {
    return "";
  }

  return token.trim();
}

export async function requireAuth(req, res, next) {
  try {
    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      return res.status(401).json({ message: "Unauthorized: missing token" });
    }

    const admin = await getAdminFromToken(token);
    if (!admin) {
      return res.status(401).json({ message: "Unauthorized: invalid or expired token" });
    }

    req.admin = admin;
    return next();
  } catch (error) {
    return next(error);
  }
}
