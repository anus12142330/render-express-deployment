import jwt from "jsonwebtoken";

const MOBILE_JWT_SECRET = process.env.MOBILE_JWT_SECRET || "mobile-secret";

export const authenticateMobile = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ success: false, message: "Missing token" });
  }
  try {
    const decoded = jwt.verify(token, MOBILE_JWT_SECRET);
    req.mobileUser = decoded;
    return next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "Invalid token" });
  }
};

/**
 * Optional Bearer auth: if Authorization: Bearer <token> is present and valid,
 * set req.session.user so all routes that check req.session.user work from the mobile app
 * (where session cookies are not sent cross-origin). Does nothing if no Bearer header.
 */
export const optionalBearerSession = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return next();
  try {
    const decoded = jwt.verify(token, MOBILE_JWT_SECRET);
    if (!req.session) req.session = {};
    req.session.user = { id: decoded.id, email: decoded.email };
    return next();
  } catch (err) {
    return res.status(401).json({ error: "Not logged in" });
  }
};

export const signMobileToken = (payload, expiresIn = "7d") =>
  jwt.sign(payload, MOBILE_JWT_SECRET, { expiresIn });
