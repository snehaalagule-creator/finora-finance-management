/* eslint-disable */
const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const router = express.Router();

function isValidSignupBody(body) {
  const { name, email, password } = body || {};
  if (typeof name !== "string" || !name.trim() || name.trim().length > 100) return false;
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) return false;
  if (typeof password !== "string" || password.length < 8) return false;
  return true;
}

// POST /api/auth/signup
router.post("/signup", async (req, res) => {
  try {
    if (!isValidSignupBody(req.body)) {
      return res.status(400).json({
        message: "Enter a valid name, email and password of at least 8 characters"
      });
    }

    const { name, email, password } = req.body;
    const normalizedEmail = email.trim().toLowerCase();

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ message: "Email already registered" });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password_hash
    });

    return res.status(201).json({
      message: "Account created successfully",
      userId: user._id.toString()
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "Email already registered" });
    }
    console.error(err);
    return res.status(500).json({ message: "Could not create account" });
  }
});

// POST /api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (typeof email !== "string" || !email.trim() || typeof password !== "string" || !password) {
      return res.status(400).json({ message: "Email and password are required" });
    }

    const user = await User.findOne({ email: email.trim().toLowerCase() });
    const passwordMatch = user ? await bcrypt.compare(password, user.password_hash) : false;

    if (!user || !passwordMatch) {
      return res.status(401).json({ message: "Invalid email or password" });
    }

    const secret = process.env.JWT_SECRET;
    if (!secret) {
      return res.status(500).json({ message: "Server configuration error" });
    }

    const token = jwt.sign(
      { id: user._id.toString(), email: user.email },
      secret,
      { expiresIn: "2h" }
    );

    return res.json({
      message: "Login successful",
      token,
      user: { id: user._id.toString(), name: user.name, email: user.email }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not log in" });
  }
});

module.exports = router;
