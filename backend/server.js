/* eslint-disable */
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");
const { exec } = require("child_process");
const connectDB = require("./config/db");

const app = express();

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "1mb" }));

// Serve landing page as homepage
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "landing.html"));
});

// Serve frontend static files
app.use(express.static(path.join(__dirname, "..")));

// Health check
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", message: "Backend is working" });
});

// API routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/transactions", require("./routes/transactions"));
app.use("/api/budgets", require("./routes/budgets"));

// Serve index.html for any non-API route
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "index.html"));
});

// Global error handler
app.use((err, req, res, _next) => {
  console.error(err);
  if (err.name === "ValidationError") {
    return res.status(400).json({ message: "Invalid data provided" });
  }
  if (err.name === "CastError") {
    return res.status(400).json({ message: "Invalid ID or data format" });
  }
  return res.status(500).json({ message: "Something went wrong on the server" });
});

const PORT = process.env.PORT || 5000;

async function startServer() {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`App running at http://localhost:${PORT}`);
      exec(`start http://localhost:${PORT}`);
    });
  } catch (err) {
    console.error("Could not start backend:", err.message);
    process.exit(1);
  }
}

startServer();
