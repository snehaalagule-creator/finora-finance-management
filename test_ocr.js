function parseReceiptAmount(text) {
  function toNum(str) {
    if (!str) return null;
    const n = parseFloat(str.replace(/[₹\s,]/g, ""));
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  const TOTAL_LABELS = [
    { label: "Grand Total",    re: /grand\s*total/i,    priority: 1 },
    { label: "Net Amount",     re: /net\s*amount/i,     priority: 2 },
    { label: "Total Amount",   re: /total\s*amount/i,   priority: 3 },
    { label: "Amount Payable", re: /amount\s*payable/i, priority: 4 },
    { label: "Payable Amount", re: /payable\s*amount/i, priority: 4 },
    { label: "Balance Due",    re: /balance\s*due/i,    priority: 5 },
    { label: "Bill Total",     re: /bill\s*total/i,     priority: 6 },
    { label: "Final Amount",   re: /final\s*amount/i,   priority: 7 },
    { label: "Amount Due",     re: /amount\s*due/i,     priority: 8 },
    { label: "Net Payable",    re: /net\s*payable/i,    priority: 9 },
    { label: "Total",          re: /\btotal\b/i,        priority: 10 }
  ];

  const SKIP_RE = /subtotal|sub\s*total|sgst|cgst|igst|\bgst\b|\bvat\b|\btax\b|discount|cash\s*(received|paid|tendered)|amount\s*received|change\s*due|round\s*off|item\s*total|qty|quantity/i;

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SKIP_RE.test(line)) continue;

    for (const lbl of TOTAL_LABELS) {
      if (!lbl.re.test(line)) continue;

      const afterLabel = line.replace(lbl.re, "").replace(/[^\d.,₹]/g, " ").trim();
      const nums = [...afterLabel.matchAll(/(\d[\d,]*(?:\.\d{1,2})?)/g)]
        .map(m => toNum(m[1])).filter(n => n !== null);

      let amount = null;
      let matchedText = line;

      if (nums.length > 0) {
        amount = nums[nums.length - 1];
      } else {
        for (let j = i + 1; j < lines.length && j <= i + 2; j++) {
          if (SKIP_RE.test(lines[j])) continue;
          const nextNums = [...lines[j].replace(/[^\d.,₹]/g, " ").matchAll(/(\d[\d,]*(?:\.\d{1,2})?)/g)]
            .map(m => toNum(m[1])).filter(n => n !== null);
          if (nextNums.length > 0) {
            amount = nextNums[nextNums.length - 1];
            matchedText = line + " " + lines[j];
            break;
          }
        }
      }

      if (amount !== null) {
        candidates.push({ amount, label: lbl.label, priority: lbl.priority, matchedText });
        break;
      }
    }
  }

  if (candidates.length === 0) return { amount: null, label: "", confidence: "not-found", candidates: [] };
  candidates.sort((a, b) => a.priority - b.priority);
  const best = candidates[0];
  return { amount: best.amount, label: best.label, matchedText: best.matchedText, candidates, confidence: "high" };
}

// Simulate the EXACT problem: "Total" word appears in item description lines
// This is what causes first amount to be picked
const problemCases = [
  // "Total" appears in item name like "Total Biscoff" or "Total yogurt"
  `Total Yogurt 1 x 40 = 40
Bread 30
Milk 80
Grand Total 150`,

  // "Total" label line has item numbers before it (OCR reads "2 Total 150")
  `Maggi 20
Bread 30
Biscuits 100
2 Total items: 150`,

  // Real Indian receipt - "Net Amount" line has multiple numbers
  `Maggi          1    20
Bread          1    30
Biscuits       1   100
Net Amount     3   150`,

  // Amount Payable with invoice number before it
  `Invoice No: 1234
Maggi 20
Bread 30
Amount Payable 150`,

  // "Total" appears in store name at top
  `Total Mart Store
Maggi 20
Bread 30
Grand Total 150`,
];

problemCases.forEach((text, i) => {
  const r = parseReceiptAmount(text);
  const lines = text.split('\n');
  console.log(`\nCase ${i+1}: "${lines[0]}..."`);
  console.log(`  => amount: ${r.amount}  label: ${r.label}`);
  r.candidates.forEach(c => console.log(`    candidate: "${c.label}" = ${c.amount}  from: "${c.matchedText}"`));
});
