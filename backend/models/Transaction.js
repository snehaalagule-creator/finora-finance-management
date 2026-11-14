const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    user_id: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true
    },
    type: { type: String, enum: ["income", "expense"], required: true },
    amount: { type: Number, required: true, min: 0.01 },
    category: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, default: "", trim: true },
    transaction_date: { type: Date, required: true }
  },
  { timestamps: true }
);

module.exports = mongoose.model("Transaction", transactionSchema);
