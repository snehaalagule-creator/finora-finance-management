const express = require("express");
const mongoose = require("mongoose");
const Transaction = require("../models/Transaction");
const auth = require("../middleware/authMiddleware");

const router = express.Router();

function parseTransactionAmount(value) {
  const text = typeof value === "number"
    ? String(value)
    : typeof value === "string"
      ? value.trim().replace(/^(?:₹|INR|Rs\.?)\s*/i, "").trim()
      : "";
  const validAmount = /^(?:\d+|\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;
  if (!validAmount.test(text)) return null;

  const amount = Number(text.replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const roundedAmount = Math.round((amount + Number.EPSILON) * 100) / 100;
  return roundedAmount > 0 && Number.isSafeInteger(Math.round(roundedAmount * 100))
    ? roundedAmount
    : null;
}

function formatTransactionDate(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return value.toISOString().slice(0, 10);
  }

  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match) return null;

  const [year, month, day] = match.slice(1).map(Number);
  const validationDate = new Date(0);
  validationDate.setUTCHours(0, 0, 0, 0);
  validationDate.setUTCFullYear(year, month - 1, day);
  if (
    validationDate.getUTCFullYear() !== year ||
    validationDate.getUTCMonth() + 1 !== month ||
    validationDate.getUTCDate() !== day
  ) {
    return null;
  }

  return `${match[1]}-${match[2]}-${match[3]}`;
}

// All transaction routes require authentication.
router.use(auth);

// GET ALL TRANSACTIONS FOR THE LOGGED-IN USER
router.get("/", async (req, res, next) => {
  try {
    const transactions = await Transaction.find({
      user_id: req.user.id
    }).sort({
      transaction_date: -1,
      _id: -1
    }).lean();

    res.json(
      transactions.map((transaction) => ({
        id: transaction._id.toString(),
        type: transaction.type,
        amount: Number(transaction.amount),
        category: transaction.category,
        description: transaction.description,
        date: formatTransactionDate(
          transaction.transaction_date ?? transaction.transactionDate ?? transaction.date
        )
      }))
    );
  } catch (error) {
    next(error);
  }
});

// ADD A TRANSACTION
router.post("/", async (req, res, next) => {
  try {
    const { type, amount, category, description, date } = req.body;
    const numericAmount = parseTransactionAmount(amount);

    if (
      !["income", "expense"].includes(type) ||
      numericAmount === null ||
      typeof category !== "string" ||
      !category.trim() ||
      typeof date !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(date)) ||
      new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date ||
      (description != null && typeof description !== "string")
    ) {
      return res.status(400).json({
        message: "Please provide valid transaction details"
      });
    }

    const transaction = await Transaction.create({
      user_id: req.user.id,
      type,
      amount: numericAmount,
      category: category.trim(),
      description: (description || "").trim(),
      transaction_date: new Date(`${date}T00:00:00.000Z`)
    });

    res.status(201).json({
      message: "Transaction added successfully",
      id: transaction._id.toString(),
      amount: Number(transaction.amount)
    });
  } catch (error) {
    next(error);
  }
});

// DELETE A TRANSACTION
router.delete("/:id", async (req, res, next) => {
  try {
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({
        message: "Invalid transaction ID"
      });
    }

    const transaction = await Transaction.findOneAndDelete({
      _id: req.params.id,
      user_id: req.user.id
    });

    if (!transaction) {
      return res.status(404).json({
        message: "Transaction not found"
      });
    }

    res.json({
      message: "Transaction deleted successfully"
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
