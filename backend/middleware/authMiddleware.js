/* eslint-disable */
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;

  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Authentication token is required" });
  }

  const token = header.slice(7).trim();
  if (!token) {
    return res.status(401).json({ message: "Authentication token is required" });
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    return res.status(500).json({ message: "Server configuration error" });
  }

  try {
    const payload = jwt.verify(token, secret);

    if (!payload.id || !mongoose.isValidObjectId(payload.id)) {
      return res.status(401).json({ message: "Invalid authentication token" });
    }

    req.user = { id: payload.id, email: payload.email };
    return next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired authentication token" });
  }
}

module.exports = authMiddleware;
