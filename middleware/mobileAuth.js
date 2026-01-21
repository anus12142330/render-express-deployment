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

export const signMobileToken = (payload, expiresIn = "7d") =>
  jwt.sign(payload, MOBILE_JWT_SECRET, { expiresIn });
