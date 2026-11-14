/* eslint-disable */
const express = require("express");
const mongoose = require("mongoose");
const Budget = require("../models/Budget");
const auth = require("../middleware/authMiddleware");

const router = express.Router();
router.use(auth);

function isValidMonth(month) {
  return typeof month === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(month);
}

function isValidBudgetBody(body) {
  const { category, amount, month } = body || {};
  const num = Number(amount);
  if (typeof category !== "string" || !category.trim() || category.trim().length > 100) return false;
  if (amount == null || amount === "" || !Number.isFinite(num) || num <= 0) return false;
  if (!isValidMonth(month)) return false;
  return true;
}

// GET /api/budgets
router.get("/", async (req, res) => {
  try {
    const filter = { user_id: req.user.id };

    if (req.query.month !== undefined) {
      if (!isValidMonth(req.query.month)) {
        return res.status(400).json({ message: "Month must use YYYY-MM format" });
      }
      filter.month = req.query.month;
    }

    const budgets = await Budget.find(filter)
      .sort({ month: -1, category: 1 })
      .lean();

    return res.json(budgets.map((item) => ({
      id: item._id.toString(),
      category: item.category,
      amount: item.amount,
      month: item.month
    })));
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not fetch budgets" });
  }
});

// POST /api/budgets
router.post("/", async (req, res) => {
  try {
    if (!isValidBudgetBody(req.body)) {
      return res.status(400).json({
        message: "Provide a category, positive amount, and month in YYYY-MM format"
      });
    }

    const { category, amount, month } = req.body;
    const numericAmount = Math.round(Number(amount) * 100) / 100;

    const budget = await Budget.findOneAndUpdate(
      { user_id: req.user.id, category: category.trim(), month },
      { $set: { amount: numericAmount } },
      { new: true, upsert: true, runValidators: true, setDefaultsOnInsert: true }
    );

    return res.status(201).json({
      message: "Budget saved successfully",
      id: budget._id.toString(),
      category: budget.category,
      amount: budget.amount,
      month: budget.month
    });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: "A budget for this category and month already exists" });
    }
    console.error(err);
    return res.status(500).json({ message: "Could not save budget" });
  }
});

// DELETE /api/budgets/:id
router.delete("/:id", async (req, res) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: "Invalid budget ID" });
    }

    const deleted = await Budget.findOneAndDelete({
      _id: req.params.id,
      user_id: req.user.id
    });

    if (!deleted) {
      return res.status(404).json({ message: "Budget not found" });
    }

    return res.json({ message: "Budget deleted successfully" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Could not delete budget" });
  }
});

module.exports = router;
