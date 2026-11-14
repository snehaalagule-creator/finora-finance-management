"use strict";

const API_URL = "http://localhost:5000/api";
const $ = (id) => document.getElementById(id);
const THEMES = new Set(["midnight-purple", "minimalist-beige", "rose-burgundy"]);
const DEFAULT_THEME = "midnight-purple";

function applyTheme(theme) {
  const selectedTheme = THEMES.has(theme) ? theme : DEFAULT_THEME;
  document.documentElement.dataset.theme = selectedTheme;
  document.querySelectorAll("[data-theme-choice]").forEach((option) => {
    option.setAttribute("aria-pressed", String(option.dataset.themeChoice === selectedTheme));
  });
  return selectedTheme;
}

function setMessageState(element, state = "error") {
  element.classList.remove("success", "info");
  if (state === "success" || state === "info") element.classList.add(state);
}

try {
  applyTheme(localStorage.getItem("finora_theme") || DEFAULT_THEME);
} catch (error) {
  console.warn("Could not load the saved theme preference.", error);
  applyTheme(DEFAULT_THEME);
}

const themeToggle = $("themeToggle");
const themeMenu = $("themeMenu");

function closeThemeMenu() {
  themeMenu.classList.add("hidden");
  themeToggle.setAttribute("aria-expanded", "false");
}

themeToggle.addEventListener("click", () => {
  const isOpening = themeMenu.classList.contains("hidden");
  themeMenu.classList.toggle("hidden", !isOpening);
  themeToggle.setAttribute("aria-expanded", String(isOpening));
  if (isOpening) {
    const selectedOption = themeMenu.querySelector('[aria-pressed="true"]');
    selectedOption?.focus();
  }
});

themeMenu.addEventListener("click", (event) => {
  const option = event.target.closest("[data-theme-choice]");
  if (!option) return;

  const theme = option.dataset.themeChoice;
  if (!THEMES.has(theme)) return;
  const status = $("themeStatus");
  try {
    localStorage.setItem("finora_theme", theme);
    status.textContent = "";
  } catch (error) {
    console.error("Could not save the selected theme preference.", error);
    status.textContent = "Theme applied, but your preference could not be saved in this browser.";
  }
  applyTheme(theme);
  closeThemeMenu();
  themeToggle.focus();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".theme-switcher")) closeThemeMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !themeMenu.classList.contains("hidden")) {
    closeThemeMenu();
    themeToggle.focus();
  }
});

let authToken = localStorage.getItem("finora_token");
let currentUser = JSON.parse(localStorage.getItem("finora_user") || "null");
let pendingEmail = "";
let isNewUser = false;
let transactions = [];
let budgets = [];
let goals = [];
let activeSpeechRecognition = null;
let activeVoiceMicrophoneStream = null;
let activeVoiceAudioContext = null;
let activeVoiceMeterFrame = 0;
let voicePeakInputLevel = 0;
let voiceInputLevelAvailable = false;
let voiceInputWasDetected = false;
let voiceStartRequestId = 0;
let voiceSaveInProgress = false;
let voiceTransactionSaved = false;
let receiptOcrWorker = null;
let receiptOcrLibraryPromise = null;

// ── HELPERS ───────────────────────────────────────────────────────────────────

const money = (n) =>
  new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(n) || 0);

function parseCurrencyAmount(value) {
  const normalized = String(value).trim().replace(/^(?:₹|INR|Rs\.?)\s*/i, "").trim();
  const validAmount = /^(?:\d+|\d{1,2}(?:,\d{2})*,\d{3}|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/;
  if (!validAmount.test(normalized)) return null;

  const amount = Number(normalized.replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const roundedAmount = Math.round((amount + Number.EPSILON) * 100) / 100;
  return roundedAmount > 0 ? roundedAmount : null;
}

async function prepareReceiptImage(file) {
  const image = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    const maxDimension = 1800;
    let scale = Math.min(1, maxDimension / Math.max(image.width, image.height));

    for (let attempt = 0; attempt < 6; attempt += 1) {
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
      if (!blob) throw new Error("Could not prepare the receipt image. Try another image.");
      if (blob.size <= 950 * 1024) return blob;
      scale *= 0.8;
    }

    throw new Error("Receipt image is too large to process. Choose a smaller image.");
  } finally {
    image.close();
  }
}

function loadReceiptOcrLibrary() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  if (receiptOcrLibraryPromise) return receiptOcrLibraryPromise;

  receiptOcrLibraryPromise = new Promise((resolve, reject) => {
    const sources = [
      "https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js",
      "https://unpkg.com/tesseract.js@5.1.1/dist/tesseract.min.js"
    ];
    let sourceIndex = 0;

    const loadNextSource = () => {
      if (sourceIndex >= sources.length) {
        receiptOcrLibraryPromise = null;
        reject(new Error("Local receipt reading is unavailable."));
        return;
      }

      const script = document.createElement("script");
      script.src = sources[sourceIndex++];
      script.onload = () => window.Tesseract
        ? resolve(window.Tesseract)
        : loadNextSource();
      script.onerror = () => {
        script.remove();
        loadNextSource();
      };
      document.head.appendChild(script);
    };

    loadNextSource();
  });

  return receiptOcrLibraryPromise;
}

async function extractReceiptText(imageBlob) {
  const formData = new FormData();
  formData.append("file", imageBlob, "receipt.jpg");
  formData.append("language", "eng");
  formData.append("isOverlayRequired", "false");
  formData.append("detectOrientation", "true");
  formData.append("scale", "true");
  formData.append("apikey", "helloworld");

  try {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch("https://api.ocr.space/parse/image", {
        method: "POST",
        body: formData,
        signal: controller.signal
      });
    } finally {
      window.clearTimeout(timeout);
    }

    const data = await response.json();
    const providerErrors = Array.isArray(data?.ErrorMessage)
      ? data.ErrorMessage.map((error) => typeof error === "string" ? error : error?.Message).filter(Boolean).join(" ")
      : typeof data?.ErrorMessage === "string" ? data.ErrorMessage : "";
    const text = data?.ParsedResults?.[0]?.ParsedText || "";

    if (response.ok && data?.IsErroredOnProcessing !== true && data?.IsErroredOnProcessing !== "true" && text.trim()) {
      return text;
    }
    console.warn("Receipt OCR service unavailable; using local OCR.", providerErrors || response.status);
  } catch (error) {
    console.warn("Receipt OCR service unavailable; using local OCR.", error.message);
  }

  try {
    const tesseract = await loadReceiptOcrLibrary();
    if (!receiptOcrWorker) receiptOcrWorker = await tesseract.createWorker("eng");
    const { data } = await receiptOcrWorker.recognize(imageBlob);
    if (data.text?.trim()) return data.text;
  } catch (error) {
    console.warn("Local receipt OCR failed.", error.message);
  }

  throw new Error("We couldn't read this photo. Try a clearer, well-lit image, or enter the transaction manually.");
}

const today = () => new Date().toISOString().slice(0, 10);
const currentMonth = () => today().slice(0, 7);

const escapeHTML = (v) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function userKey(type) {
  return `finora_${type}_${currentUser.email.toLowerCase()}`;
}

function readJSON(key, fallback = []) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

async function api(endpoint, options = {}) {
  const res = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
      ...(options.headers || {})
    }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "Something went wrong");
  return data;
}

// ── 2-STEP AUTH ───────────────────────────────────────────────────────────────

$("loginTab").addEventListener("click", () => {
  isNewUser = false;
  $("emailForm").classList.remove("hidden");
  $("passwordForm").classList.add("hidden");
  $("authTitle").textContent = "Welcome back!";
  $("authDescription").textContent = "Enter your email to continue.";
  $("authMessage").textContent = "";
  $("loginTab").classList.add("active");
  $("signupTab").classList.remove("active");
});

$("signupTab").addEventListener("click", () => {
  isNewUser = true;
  $("emailForm").classList.remove("hidden");
  $("passwordForm").classList.add("hidden");
  $("authTitle").textContent = "Create your account";
  $("authDescription").textContent = "Enter your email to get started.";
  $("authMessage").textContent = "";
  $("signupTab").classList.add("active");
  $("loginTab").classList.remove("active");
});

// Step 1 — just capture email and move to password step
$("emailForm").addEventListener("submit", (event) => {
  event.preventDefault();
  pendingEmail = $("authEmail").value.trim().toLowerCase();
  if (!pendingEmail) return;
  // Always go to login password step — signup only if Sign Up tab selected
  showPasswordStep(isNewUser);
});

function showPasswordStep(signup) {
  $("emailForm").classList.add("hidden");
  $("passwordForm").classList.remove("hidden");
  $("passwordEmail").textContent = pendingEmail;
  $("passwordTitle").textContent = signup ? "Create your account" : "Enter your password";
  $("authSubmit").textContent = signup ? "Create account" : "Login";
  $("authPassword").value = "";
  $("authName").hidden = !signup;
  $("nameLabel").hidden = !signup;
  $("authName").required = signup;
  $("passwordMessage").textContent = "";
  $("authPassword").focus();
}

$("backToEmail").addEventListener("click", () => {
  $("passwordForm").classList.add("hidden");
  $("emailForm").classList.remove("hidden");
  $("authMessage").textContent = "";
  $("authEmail").focus();
});

// Step 2 — password (and name if signup)
$("passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const password = $("authPassword").value;
  const name = $("authName").value.trim();
  const msg = $("passwordMessage");
  const btn = $("authSubmit");
  msg.textContent = "";
  btn.disabled = true;

  try {
    if (isNewUser) {
      if (!name) { msg.textContent = "Please enter your name."; return; }
      await api("/auth/signup", { method: "POST", body: JSON.stringify({ name, email: pendingEmail, password }) });
      // Auto-login after signup
      const data = await api("/auth/login", { method: "POST", body: JSON.stringify({ email: pendingEmail, password }) });
      authToken = data.token;
      localStorage.setItem("finora_token", authToken);
      localStorage.setItem("finora_user", JSON.stringify(data.user));
      await openApp(data.user);
    } else {
      const data = await api("/auth/login", { method: "POST", body: JSON.stringify({ email: pendingEmail, password }) });
      authToken = data.token;
      localStorage.setItem("finora_token", authToken);
      localStorage.setItem("finora_user", JSON.stringify(data.user));
      await openApp(data.user);
    }
  } catch (err) {
    setMessageState(msg);
    // If login fails because account doesn't exist, offer signup
    if (err.message.toLowerCase().includes("invalid email or password") || err.message.toLowerCase().includes("not found")) {
      msg.textContent = "No account found. Switch to Sign Up to create one.";
    } else {
      msg.textContent = err.message;
    }
  } finally {
    btn.disabled = false;
  }
});

// ── APP OPEN ───────────────────────────────────────────────────────────────────

async function openApp(user) {
  currentUser = user;
  $("authPage").classList.add("hidden");
  $("app").classList.remove("hidden");
  updateProfileDisplay();
  showPage("dashboard");
  renderAll();
  try {
    await loadData();
    renderAll();
  } catch (err) {
    console.warn("Could not load data:", err.message);
  }
}

function updateProfileDisplay() {
  const name = currentUser.name || "User";
  $("welcomeName").textContent = name.split(" ")[0];
  $("profileName").value = name;
  $("profileEmail").value = currentUser.email;
}

// ── DATA LOADING ──────────────────────────────────────────────────────────────

async function loadData() {
  const [txData, budgetData] = await Promise.all([
    api("/transactions"),
    api(`/budgets?month=${currentMonth()}`)
  ]);
  transactions = txData;
  budgets = budgetData.map((b) => ({ ...b, limit: b.amount }));
  goals = readJSON(userKey("goals"));
  if (!Array.isArray(goals)) goals = [];
}

function saveGoals() {
  localStorage.setItem(userKey("goals"), JSON.stringify(goals));
}

// ── NAVIGATION ────────────────────────────────────────────────────────────────

function showPage(pageName) {
  const validPages = ["dashboard", "transactions", "budgets", "goals", "reports", "settings"];
  if (!validPages.includes(pageName)) return;
  document.querySelectorAll(".page").forEach((p) => p.classList.toggle("hidden", p.id !== pageName));
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === pageName));
}

document.addEventListener("click", (event) => {
  const pageButton = event.target.closest("[data-page]");
  if (pageButton) showPage(pageButton.dataset.page);

  const actionButton = event.target.closest('[data-action="add-transaction"]');
  if (actionButton) {
    showPage("transactions");
    $("transactionForm").classList.remove("hidden");
    $("transactionFormTitle").textContent = "New transaction";
    $("transactionDate").value = today();
    $("transactionDescription").focus();
  }
});

// ── TRANSACTIONS ──────────────────────────────────────────────────────────────

function getTotals() {
  const income = transactions.filter((i) => i.type === "income").reduce((s, i) => s + Number(i.amount), 0);
  const expenses = transactions.filter((i) => i.type === "expense").reduce((s, i) => s + Number(i.amount), 0);
  return { income, expenses, balance: income - expenses, savingsRate: income > 0 ? ((income - expenses) / income) * 100 : 0 };
}

function dateLabel(date) {
  if (!date) return "—";
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return "—";
  return parsed.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function transactionRow(item, includeActions = false) {
  const isIncome = item.type === "income";
  return `
    <tr>
      <td><div class="tx-name">${escapeHTML(item.description)}</div></td>
      <td>${escapeHTML(item.category)}</td>
      <td>${dateLabel(item.date)}</td>
      ${includeActions ? `<td><span class="type-pill ${isIncome ? "income" : "expense"}">${isIncome ? "Income" : "Expense"}</span></td>` : ""}
      <td class="${isIncome ? "amount-income" : "amount-expense"}">${isIncome ? "+" : "−"}${money(item.amount)}</td>
      <td><button class="delete-btn" data-delete-transaction="${item.id}">&#x2715;</button></td>
    </tr>`;
}

function renderTransactions() {
  const recent = [...transactions].sort((a, b) => String(b.date || "").localeCompare(String(a.date || ""))).slice(0, 5);
  $("recentTransactions").innerHTML = recent.length
    ? recent.map((i) => transactionRow(i)).join("")
    : `<tr><td colspan="5" class="empty-row">No transactions yet.</td></tr>`;

  const query = $("transactionSearch").value.trim().toLowerCase();
  const filter = $("transactionFilter").value;
  const filtered = [...transactions]
    .filter((i) => {
      const matchSearch = i.description.toLowerCase().includes(query) || i.category.toLowerCase().includes(query);
      return matchSearch && (filter === "all" || i.type === filter);
    })
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));

  $("allTransactions").innerHTML = filtered.length
    ? filtered.map((i) => transactionRow(i, true)).join("")
    : `<tr><td colspan="6" class="empty-row">No matching transactions.</td></tr>`;}

$("showTransactionForm").addEventListener("click", () => {
  $("transactionForm").classList.remove("hidden");
  $("transactionFormTitle").textContent = "New transaction";
  $("receiptOcrReview").classList.add("hidden");
  $("transactionDate").value = today();
  $("transactionMessage").textContent = "";
  $("transactionDescription").focus();
});

$("cancelTransaction").addEventListener("click", () => {
  $("transactionForm").classList.add("hidden");
  $("transactionForm").reset();
  $("transactionFormTitle").textContent = "New transaction";
  $("transactionDate").value = today();
  $("transactionMessage").textContent = "";
});

async function addTransaction(transaction) {
  const result = await api("/transactions", {
    method: "POST",
    body: JSON.stringify(transaction)
  });
  transactions.unshift({ ...transaction, id: result.id, amount: result.amount });
  renderAll();
  return result;
}

$("transactionForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const amount = parseCurrencyAmount($("transactionAmount").value);
  const description = $("transactionDescription").value.trim();
  if (!description || amount === null) {
    setMessageState($("transactionMessage"));
    $("transactionMessage").textContent = "Enter a description and a valid amount greater than zero.";
    return;
  }
  const submitButton = $("transactionForm").querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const date = $("transactionDate").value || today();
    const type = $("transactionType").value;
    const category = $("transactionCategory").value;
    const result = await addTransaction({ type, description, amount, category, date });
    $("transactionForm").reset();
    $("transactionFormTitle").textContent = "New transaction";
    $("transactionDate").value = today();
    $("transactionForm").classList.add("hidden");
    $("receiptOcrReview").classList.add("hidden");
    $("receiptPanel").classList.add("hidden");
    setMessageState($("transactionMessage"), "success");
    $("transactionMessage").textContent = `Transaction saved: ${money(result.amount)}. Your dashboard and transaction list are updated.`;
  } catch (err) {
    setMessageState($("transactionMessage"));
    $("transactionMessage").textContent = err.message;
  } finally {
    submitButton.disabled = false;
  }
});

$("transactionSearch").addEventListener("input", renderTransactions);
$("transactionFilter").addEventListener("change", renderTransactions);

$("allTransactions").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-transaction]");
  if (!button || !confirm("Delete this transaction?")) return;
  const id = button.dataset.deleteTransaction;
  try {
    await api(`/transactions/${id}`, { method: "DELETE" });
    transactions = transactions.filter((i) => i.id !== id);
    renderAll();
  } catch (err) {
    alert(err.message);
  }
});

$("recentTransactions").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-transaction]");
  if (!button || !confirm("Delete this transaction?")) return;
  const id = button.dataset.deleteTransaction;
  try {
    await api(`/transactions/${id}`, { method: "DELETE" });
    transactions = transactions.filter((i) => i.id !== id);
    renderAll();
  } catch (err) {
    alert(err.message);
  }
});

// ── CHART ─────────────────────────────────────────────────────────────────────

function renderOverviewChart() {
  const months = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - i);
    months.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`, label: d.toLocaleDateString("en-IN", { month: "short" }), income: 0, expenses: 0 });
  }
  transactions.forEach((item) => {
    const m = months.find((m) => m.key === (typeof item.date === "string" ? item.date.slice(0, 7) : ""));
    if (!m) return;
    if (item.type === "income") m.income += Number(item.amount);
    else m.expenses += Number(item.amount);
  });
  const maxValue = Math.max(1, ...months.flatMap((m) => [m.income, m.expenses]));
  $("overviewChart").innerHTML = months.map((m) => `
    <div class="chart-column">
      <div class="bar-pair">
        <div class="bar income-bar" title="Income: ${money(m.income)}" style="height:${Math.max(2, m.income / maxValue * 100)}%"></div>
        <div class="bar expense-bar" title="Expenses: ${money(m.expenses)}" style="height:${Math.max(2, m.expenses / maxValue * 100)}%"></div>
      </div>
      <span>${escapeHTML(m.label)}</span>
    </div>`).join("") + `<div class="legend"><span class="income-legend">Income</span><span class="expense-legend">Expenses</span></div>`;
}

// ── BUDGETS ───────────────────────────────────────────────────────────────────

function categorySpent(category) {
  return transactions
    .filter((i) => i.type === "expense" && i.category === category && typeof i.date === "string" && i.date.slice(0, 7) === currentMonth())
    .reduce((s, i) => s + Number(i.amount), 0);
}

function budgetMarkup(budget, deletable = false) {
  const spent = categorySpent(budget.category);
  const limit = Number(budget.limit);
  const percent = limit > 0 ? spent / limit * 100 : 0;
  const width = Math.min(100, percent);
  return `
    <div class="budget-item">
      <div class="budget-line"><strong>${escapeHTML(budget.category)}</strong><span>${money(spent)} / ${money(limit)}</span></div>
      <div class="progress-track"><div class="progress-fill ${percent > 100 ? "over" : ""}" style="width:${width}%"></div></div>
      <p class="muted">${percent > 100 ? `${money(spent - limit)} over budget` : `${Math.round(percent)}% used`}</p>
      ${deletable ? `<div class="card-actions"><button data-delete-budget="${budget.id}">Delete budget</button></div>` : ""}
    </div>`;
}

function renderBudgets() {
  $("dashboardBudgets").innerHTML = budgets.length
    ? budgets.slice(0, 4).map((b) => budgetMarkup(b)).join("")
    : `<p class="muted">No budgets yet. Add one in Budget Planner.</p>`;
  $("budgetList").innerHTML = budgets.length
    ? budgets.map((b) => `<article class="data-card"><h3>${escapeHTML(b.category)} Budget</h3>${budgetMarkup(b, true)}</article>`).join("")
    : `<article class="data-card"><p class="muted">No budgets created yet.</p></article>`;
}

$("budgetForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const category = $("budgetCategory").value;
  const amount = Number($("budgetLimit").value);
  if (!Number.isFinite(amount) || amount <= 0) { alert("Enter a budget greater than zero."); return; }
  try {
    const result = await api("/budgets", { method: "POST", body: JSON.stringify({ category, amount, month: currentMonth() }) });
    const existing = budgets.find((b) => b.category === category);
    if (existing) { existing.limit = amount; existing.amount = amount; }
    else budgets.push({ id: result.id, category, amount, limit: amount, month: result.month });
    $("budgetForm").reset();
    renderAll();
  } catch (err) {
    alert(err.message);
  }
});

$("budgetList").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-delete-budget]");
  if (!button) return;
  const id = button.dataset.deleteBudget;
  try {
    await api(`/budgets/${id}`, { method: "DELETE" });
    budgets = budgets.filter((b) => b.id !== id);
    renderAll();
  } catch (err) {
    alert(err.message);
  }
});

// ── GOALS (localStorage) ──────────────────────────────────────────────────────

function renderGoals() {
  $("goalList").innerHTML = goals.length
    ? goals.map((goal) => {
        const target = Number(goal.target), saved = Number(goal.saved);
        const percent = target > 0 ? saved / target * 100 : 0;
        return `
          <article class="data-card">
            <h3>${escapeHTML(goal.name)}</h3>
            <p class="muted">Savings progress</p>
            <div class="big-number">${money(saved)}</div>
            <div class="progress-track"><div class="progress-fill" style="width:${Math.min(100, percent)}%"></div></div>
            <p class="muted">${Math.round(percent)}% of ${money(target)}</p>
            <form class="goal-update-form" data-goal-id="${goal.id}">
              <label>Add savings (₹)<input name="addition" type="number" min="0.01" step="0.01" required placeholder="Enter amount"></label>
              <button class="secondary-btn" type="submit">Update savings</button>
            </form>
            <div class="card-actions"><button data-delete-goal="${goal.id}">Delete goal</button></div>
          </article>`;
      }).join("")
    : `<article class="data-card"><p class="muted">No savings goals yet.</p></article>`;
}

$("goalForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("goalName").value.trim();
  const target = Number($("goalTarget").value);
  const saved = Number($("goalSaved").value);
  if (!name || target <= 0 || saved < 0 || !Number.isFinite(target) || !Number.isFinite(saved)) { alert("Please enter valid savings goal amounts."); return; }
  goals.push({ id: Date.now(), name, target, saved });
  saveGoals();
  $("goalForm").reset();
  $("goalSaved").value = "0";
  renderAll();
});

$("goalList").addEventListener("submit", (event) => {
  const form = event.target.closest(".goal-update-form");
  if (!form) return;
  event.preventDefault();
  const addition = Number(new FormData(form).get("addition"));
  if (!Number.isFinite(addition) || addition <= 0) return;
  const goal = goals.find((g) => g.id === Number(form.dataset.goalId));
  if (!goal) return;
  goal.saved = Number(goal.saved) + addition;
  saveGoals();
  renderAll();
});

$("goalList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-delete-goal]");
  if (!button) return;
  goals = goals.filter((g) => g.id !== Number(button.dataset.deleteGoal));
  saveGoals();
  renderAll();
});

// ── REPORTS ───────────────────────────────────────────────────────────────────

function renderReports() {
  const totals = getTotals();
  $("reportIncome").textContent = money(totals.income);
  $("reportExpenses").textContent = money(totals.expenses);
  $("reportSavings").textContent = money(totals.balance);
  $("reportCount").textContent = transactions.length;

  const spending = {};
  transactions.filter((i) => i.type === "expense").forEach((i) => { spending[i.category] = (spending[i.category] || 0) + Number(i.amount); });
  const entries = Object.entries(spending).sort((a, b) => b[1] - a[1]);
  const totalSpending = entries.reduce((s, e) => s + e[1], 0);

  $("categoryChart").innerHTML = entries.length
    ? entries.map(([cat, amt]) => {
        const percent = totalSpending > 0 ? amt / totalSpending * 100 : 0;
        return `<div class="category-row"><div class="budget-line"><strong>${escapeHTML(cat)}</strong><span>${money(amt)} · ${Math.round(percent)}%</span></div><div class="progress-track"><div class="progress-fill" style="width:${percent}%"></div></div></div>`;
      }).join("")
    : `<p class="muted">Add expenses to see your spending report.</p>`;
}

function getTransactionDateParts(value) {
  let dateText = "";
  if (typeof value === "string") {
    dateText = value;
  } else if (value instanceof Date && Number.isFinite(value.getTime())) {
    dateText = [
      String(value.getUTCFullYear()).padStart(4, "0"),
      String(value.getUTCMonth() + 1).padStart(2, "0"),
      String(value.getUTCDate()).padStart(2, "0")
    ].join("-");
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(dateText);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
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

  return {
    monthKey: `${match[1]}-${match[2]}`,
    display: `${match[3]}-${match[2]}-${match[1]}`,
    sortKey: `${match[1]}-${match[2]}-${match[3]}`
  };
}

function getTransactionDateValue(transaction) {
  return transaction.transaction_date ?? transaction.transactionDate ?? transaction.date;
}

$("exportBtn").addEventListener("click", () => {
  const headers = ["Date", "Type", "Category", "Description", "Amount"];
  const monthNames = [
    "JANUARY", "FEBRUARY", "MARCH", "APRIL", "MAY", "JUNE",
    "JULY", "AUGUST", "SEPTEMBER", "OCTOBER", "NOVEMBER", "DECEMBER"
  ];
  const groups = new Map();

  transactions.forEach((transaction, index) => {
    const dateParts = getTransactionDateParts(getTransactionDateValue(transaction));
    const key = dateParts ? dateParts.monthKey : "undated";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ transaction, dateParts, index });
    if (!dateParts) {
      console.error("Transaction date unavailable in CSV export; investigate transaction record", transaction.id ?? transaction._id ?? index);
    }
  });

  const sortedGroups = [...groups.entries()].sort(([a], [b]) => {
    if (a === "undated") return 1;
    if (b === "undated") return -1;
    return b.localeCompare(a);
  });
  const rows = [];
  const excelText = (value) => `="${String(value).replace(/"/g, '""')}"`;

  sortedGroups.forEach(([key, entries]) => {
    if (key === "undated") {
      rows.push(["UNDATED", "", "", "", ""]);
    } else {
      const [year, month] = key.split("-");
      rows.push([excelText(`${monthNames[Number(month) - 1]} ${year}`), "", "", "", ""]);
    }
    rows.push(headers);

    entries
      .sort((a, b) => {
        const dateOrder = (b.dateParts?.sortKey || "").localeCompare(a.dateParts?.sortKey || "");
        return dateOrder || a.index - b.index;
      })
      .forEach(({ transaction, dateParts }) => {
        rows.push([
          dateParts ? excelText(dateParts.display) : "Date unavailable",
          transaction.type === "income" ? "Income" : "Expense",
          transaction.category,
          transaction.description,
          transaction.amount
        ]);
      });
  });

  const quote = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  const csv = rows.map((row) => row.map(quote).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "Finora_Transactions.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ── SETTINGS ──────────────────────────────────────────────────────────────────

$("profileForm").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("profileName").value.trim();
  if (!name) return;
  currentUser = { ...currentUser, name };
  localStorage.setItem("finora_user", JSON.stringify(currentUser));
  updateProfileDisplay();
  setMessageState($("profileMessage"), "success");
  $("profileMessage").textContent = "Profile name updated.";
});

$("resetBtn").addEventListener("click", async () => {
  if (!confirm("This will delete ALL your transactions and budgets. Continue?")) return;
  try {
    await Promise.all([
      ...transactions.map((t) => api(`/transactions/${t.id}`, { method: "DELETE" })),
      ...budgets.map((b) => api(`/budgets/${b.id}`, { method: "DELETE" }))
    ]);
    localStorage.removeItem(userKey("goals"));
    await loadData();
    renderAll();
  } catch (err) {
    alert(err.message);
  }
});

// ── MAIN RENDER ───────────────────────────────────────────────────────────────

function renderAll() {
  const totals = getTotals();
  $("totalBalance").textContent = money(totals.balance);
  $("totalIncome").textContent = money(totals.income);
  $("totalExpenses").textContent = money(totals.expenses);
  $("savingsRate").textContent = `${totals.savingsRate.toFixed(1)}%`;
  renderTransactions();
  renderOverviewChart();
  renderBudgets();
  renderGoals();
  renderReports();
}

$("closeModal").addEventListener("click", () => $("transactionModal").classList.add("hidden"));
$("modalContinue").addEventListener("click", () => {
  $("transactionModal").classList.add("hidden");
  showPage("transactions");
  $("transactionForm").classList.remove("hidden");
  $("transactionFormTitle").textContent = "New transaction";
  $("transactionDate").value = today();
});

// ── NO AUTO SESSION RESTORE — always show login on page open ────────────────

// ── RECEIPT SCANNER ───────────────────────────────────────────────────────────────

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

  // These are never the final payable total
  const SKIP_RE = /subtotal|sub\s*total|sgst|cgst|igst|\bgst\b|\bvat\b|\btax\b|discount|cash\s*(received|paid|tendered)|amount\s*received|change\s*due|round\s*off|item\s*total|qty|quantity/i;

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const candidates = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (SKIP_RE.test(line)) continue;

    for (const lbl of TOTAL_LABELS) {
      if (!lbl.re.test(line)) continue;

      // Strip the matched label keyword out, then grab all numbers from what remains
      const afterLabel = line.replace(lbl.re, "").replace(/[^\d.,₹]/g, " ").trim();
      // All numbers remaining after removing the label text
      const nums = [...afterLabel.matchAll(/(\d[\d,]*(?:\.\d{1,2})?)/g)]
        .map(m => toNum(m[1])).filter(n => n !== null);

      let amount = null;
      let matchedText = line;

      if (nums.length > 0) {
        // Take the LAST number — in receipt tables the total column is rightmost
        amount = nums[nums.length - 1];
      } else {
        // Label is alone on this line — amount is on the next non-empty line
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
        break; // only match highest-priority label per line
      }
    }
  }

  console.info("[Receipt OCR] raw text:", JSON.stringify(text));
  console.info("[Receipt OCR] candidates:", candidates);

  if (candidates.length === 0) {
    return { amount: null, label: "", matchedText: "", candidates: [], confidence: "not-found" };
  }

  // Best = lowest priority number = most authoritative label
  candidates.sort((a, b) => a.priority - b.priority);
  const best = candidates[0];

  console.info("[Receipt OCR] selected:", best);

  return {
    amount: best.amount,
    label: best.label,
    matchedText: best.matchedText,
    candidates,
    confidence: "high"
  };
}

$("openReceiptScanner").addEventListener("click", () => {
  stopVoiceRecognition();
  $("receiptPanel").classList.remove("hidden");
  $("voicePanel").classList.add("hidden");
  $("transactionForm").classList.add("hidden");
  $("receiptOcrReview").classList.add("hidden");
  $("receiptMessage").textContent = "";
  $("transactionMessage").textContent = "";
  $("receiptPreview").classList.add("hidden");
  $("receiptImage").value = "";
});

$("closeReceiptScanner").addEventListener("click", () => {
  $("receiptPanel").classList.add("hidden");
});

$("receiptImage").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    $("receiptPreview").src = ev.target.result;
    $("receiptPreview").classList.remove("hidden");
  };
  reader.readAsDataURL(file);
});

$("extractReceipt").addEventListener("click", async () => {
  const file = $("receiptImage").files[0];
  const msg = $("receiptMessage");

  if (!file) {
    setMessageState(msg);
    msg.textContent = "Please select a receipt image first.";
    return;
  }

  setMessageState(msg, "info");
  msg.textContent = "Reading receipt...";
  $("extractReceipt").disabled = true;

  try {
    const imageBlob = await prepareReceiptImage(file);
    msg.textContent = "Reading receipt...";
    const text = await extractReceiptText(imageBlob);

    const detection = parseReceiptAmount(text);
    const detectedAmount = detection.amount;

    const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 2);
    const detectedDesc = lines[0] || "Receipt transaction";

    const lower = text.toLowerCase();
    let detectedCategory = "Other";
    if (lower.includes("food") || lower.includes("restaurant") || lower.includes("cafe") || lower.includes("hotel") || lower.includes("swiggy") || lower.includes("zomato")) detectedCategory = "Food";
    else if (lower.includes("medical") || lower.includes("pharmacy") || lower.includes("medicine") || lower.includes("hospital") || lower.includes("clinic")) detectedCategory = "Health";
    else if (lower.includes("transport") || lower.includes("uber") || lower.includes("ola") || lower.includes("petrol") || lower.includes("fuel") || lower.includes("bus") || lower.includes("train")) detectedCategory = "Transport";
    else if (lower.includes("bill") || lower.includes("electricity") || lower.includes("water") || lower.includes("internet") || lower.includes("recharge")) detectedCategory = "Bills";
    else if (lower.includes("shop") || lower.includes("store") || lower.includes("mart") || lower.includes("amazon") || lower.includes("flipkart")) detectedCategory = "Shopping";

    $("receiptOcrReview").classList.remove("hidden");
    $("receiptOcrDetails").open = detection.confidence !== "high";
    $("receiptOcrText").textContent = text;
    $("receiptAmountSource").textContent = detection.confidence === "high"
      ? `Detected ${money(detectedAmount)} from ${detection.label}.`
      : "Receipt text was read, but a final total was not clear.";

    $("transactionForm").classList.remove("hidden");
    $("transactionFormTitle").textContent = "Review extracted transaction";
    $("transactionDescription").value = detectedDesc.slice(0, 100);
    $("transactionAmount").value = detectedAmount === null ? "" : String(detectedAmount);
    $("transactionCategory").value = detectedCategory;
    $("transactionDate").value = today();
    $("transactionType").value = "expense";
    $("receiptPanel").classList.add("hidden");
    setMessageState($("transactionMessage"), "info");
    $("transactionMessage").textContent = detectedAmount === null
      ? "Receipt read, but the amount was unclear. Review the details, enter the amount, and save when ready."
      : "Review the extracted details below. You can make changes before saving the transaction.";
    $("transactionDescription").focus();

  } catch (err) {
    $("transactionForm").classList.remove("hidden");
    $("transactionFormTitle").textContent = "Review transaction";
    $("transactionDescription").value = file.name.replace(/\.[^.]+$/, "").slice(0, 100) || "Receipt transaction";
    $("transactionAmount").value = "";
    $("transactionCategory").value = "Other";
    $("transactionDate").value = today();
    $("transactionType").value = "expense";
    $("receiptPanel").classList.add("hidden");
    setMessageState($("transactionMessage"));
    $("transactionMessage").textContent = `${err.message} Review or enter the transaction details, then save when ready.`;
    $("transactionDescription").focus();
  } finally {
    $("extractReceipt").disabled = false;
  }
});

// ── VOICE ENTRY ───────────────────────────────────────────────────────────────────

const voiceMonthNumbers = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8,
  oct: 9, nov: 10, dec: 11
};

function localDateString(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function parseVoiceDate(transcript) {
  let text = transcript;
  const relativeDate = /\b(today|yesterday|tomorrow)\b/i.exec(text);
  if (relativeDate) {
    const date = new Date();
    date.setDate(date.getDate() + (relativeDate[1].toLowerCase() === "yesterday" ? -1 : relativeDate[1].toLowerCase() === "tomorrow" ? 1 : 0));
    text = text.replace(relativeDate[0], " ");
    return { date: localDateString(date), text };
  }

  const isoDate = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(text);
  if (isoDate) {
    const date = new Date(Number(isoDate[1]), Number(isoDate[2]) - 1, Number(isoDate[3]));
    if (date.getFullYear() === Number(isoDate[1]) && date.getMonth() === Number(isoDate[2]) - 1 && date.getDate() === Number(isoDate[3])) {
      return { date: localDateString(date), text: text.replace(isoDate[0], " ") };
    }
  }

  const monthNames = Object.keys(voiceMonthNumbers).join("|");
  const datePatterns = [
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames})(?:\\s+(20\\d{2}))?\\b`, "i"),
    new RegExp(`\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?\\b`, "i")
  ];

  for (const [patternIndex, pattern] of datePatterns.entries()) {
    const match = pattern.exec(text);
    if (!match) continue;
    const day = Number(patternIndex === 0 ? match[1] : match[2]);
    const monthName = patternIndex === 0 ? match[2] : match[1].toLowerCase();
    const year = Number(match[3] || new Date().getFullYear());
    const month = voiceMonthNumbers[monthName.toLowerCase()];
    const date = new Date(year, month, day);
    if (date.getFullYear() === year && date.getMonth() === month && date.getDate() === day) {
      return { date: localDateString(date), text: text.replace(match[0], " ") };
    }
  }

  return { date: localDateString(new Date()), text };
}

const voiceNumberWords = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
  thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90
};

function numberFromVoiceWords(phrase) {
  let total = 0;
  let current = 0;
  for (const word of phrase.toLowerCase().replace(/-/g, " ").split(/\s+/)) {
    if (word === "and") continue;
    if (Object.hasOwn(voiceNumberWords, word)) current += voiceNumberWords[word];
    else if (word === "hundred") current = Math.max(current, 1) * 100;
    else if (["thousand", "lakh", "lakhs", "lac", "crore"].includes(word)) {
      const scale = word === "thousand" ? 1000 : word === "crore" ? 10000000 : 100000;
      total += Math.max(current, 1) * scale;
      current = 0;
    } else return null;
  }
  return total + current;
}

function parseVoiceAmount(text) {
  const numericAmount = /(?:₹\s*|(?:rs\.?|rupees?|inr)\s*)?(\d[\d,]*(?:\.\d{1,2})?)/i.exec(text);
  if (numericAmount) {
    const amount = Number(numericAmount[1].replace(/,/g, ""));
    if (Number.isFinite(amount) && amount > 0) return { amount, matched: numericAmount[0] };
  }

  const numberToken = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakhs?|lac|crore|and)";
  const wordAmount = new RegExp(`\\b${numberToken}(?:[\\s-]+${numberToken})*\\b`, "i").exec(text);
  if (wordAmount) {
    const amount = numberFromVoiceWords(wordAmount[0]);
    if (Number.isFinite(amount) && amount > 0) return { amount, matched: wordAmount[0] };
  }
  return { amount: "", matched: "" };
}

function suggestVoiceCategory(text) {
  const normalizedText = text.toLowerCase();
  const checks = [
    ["Freelance", /\b(freelance|freelancing|contract work|side gig)\b/],
    ["Salary", /\b(salary|paycheck|bonus|wage)\b/],
    ["Health", /\b(medicine|medicines|doctor|hospital|medical|pharmacy|clinic|health)\b/],
    ["Transport", /\b(petrol|fuel|bus|auto|uber|ola|train|taxi|transport|travel|travell?ing|trip|metro)\b/],
    ["Bills", /\b(electricity|electric|water bill|internet|phone bill|recharge|bill|utility)\b/],
    ["Education", /\b(education|school|college|tuition|course|class fee|books?)\b/],
    ["Investment", /\b(invest(?:ed|ment)?|mutual fund|stocks?|shares?)\b/],
    ["Entertainment", /\b(movie|cinema|game|netflix|spotify|entertainment|concert)\b/],
    ["Groceries", /\b(grocery|groceries)\b/],
    ["Food", /\b(food|maggi|lunch|dinner|breakfast|snack|chai|coffee|restaurant|cafe|hotel|meal|grocery|groceries)\b/],
    ["Shopping", /\b(shopping|shop|clothes|clothing|amazon|flipkart|purchase|purchased)\b/]
  ];
  const match = checks.find(([, pattern]) => pattern.test(normalizedText));
  return match ? match[0] : "Other";
}

function parseVoiceTransaction(transcript) {
  const parsedDate = parseVoiceDate(transcript);
  const amountResult = parseVoiceAmount(parsedDate.text);
  const incomeSignal = /\b(receiv(?:e|ed)|earn(?:ed)?|salary|bonus|income|credited|deposited|freelanc(?:e|ing)|wage)\b/i.test(parsedDate.text);
  const expenseSignal = /\b(spent|spend|paid|pay|purchased|bought|buy|shopping|expense|cost|bill|invested|investing|had\s+(?:a\s+)?(?:lunch|dinner|breakfast|meal))\b/i.test(parsedDate.text);
  const friendTransfer = /\bgot\b.*\bfrom\s+(?:my\s+)?friend\b/i.test(parsedDate.text);
  const detectedIncome = incomeSignal || friendTransfer;
  const type = detectedIncome === expenseSignal ? "" : detectedIncome ? "income" : "expense";

  const numberToken = "(?:zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|lakhs?|lac|crore|and)";
  const spokenAmountPattern = new RegExp(`\\b${numberToken}(?:[\\s-]+${numberToken})*\\b`, "gi");
  let description = parsedDate.text
    .replace(/(?:₹\s*)?\d[\d,]*(?:\.\d{1,2})?/g, " ")
    .replace(spokenAmountPattern, " ")
    .replace(/\b(?:rupees?|rs\.?|inr)\b/gi, " ")
    .replace(/^\s*(?:i\s+)?(?:have\s+)?(?:spent|spend|paid|pay|purchased|bought|buy|received|got|earned|earn|made|deposited|credited|invested|investing|invest|had|ate|ordered)\b/i, " ")
    .replace(/\b(?:as|on|for|at|from|into|in|to|the|a|an|of|my)\b/gi, " ")
    .replace(/[.,!?;:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  description = description.charAt(0).toUpperCase() + description.slice(1);

  return {
    type,
    amount: amountResult.amount,
    description,
    category: suggestVoiceCategory(parsedDate.text),
    date: parsedDate.date
  };
}

function stopVoiceInputMonitor() {
  if (activeVoiceMeterFrame) {
    window.cancelAnimationFrame(activeVoiceMeterFrame);
    activeVoiceMeterFrame = 0;
  }
  activeVoiceMicrophoneStream?.getTracks().forEach((track) => track.stop());
  activeVoiceMicrophoneStream = null;
  voiceInputLevelAvailable = false;
  voiceInputWasDetected = false;
  $("voiceInputMeter").classList.add("hidden");
  $("voiceInputHint").classList.add("hidden");
  $("voiceInputMeter").setAttribute("aria-valuenow", "0");
  $("voiceInputMeterFill").style.width = "0";
  if (activeVoiceAudioContext && activeVoiceAudioContext.state !== "closed") {
    activeVoiceAudioContext.close().catch((error) => {
      console.warn("[Finora Voice] Could not close the microphone level monitor.", error);
    });
  }
  activeVoiceAudioContext = null;
}

function stopVoiceRecognition() {
  voiceStartRequestId += 1;
  if (activeSpeechRecognition) {
    const recognition = activeSpeechRecognition;
    activeSpeechRecognition = null;
    recognition.onend = null;
    recognition.onerror = null;
    try {
      recognition.abort();
    } catch (error) {
      if (error.name !== "InvalidStateError") throw error;
    }
  }
  stopVoiceInputMonitor();
  $("startVoiceEntry").disabled = false;
  $("stopVoiceEntry").disabled = false;
  $("stopVoiceEntry").classList.add("hidden");
  $("startVoiceEntry").classList.remove("voice-recording");
  $("voiceListening").classList.add("hidden");
}

$("openVoiceEntry").addEventListener("click", () => {
  stopVoiceRecognition();
  $("voicePanel").classList.remove("hidden");
  $("receiptPanel").classList.add("hidden");
  $("transactionForm").classList.add("hidden");
  $("voiceConfirmation").classList.add("hidden");
  $("voiceTranscriptPreview").classList.add("hidden");
  $("voiceStatus").textContent = "Ready";
  $("voiceMessage").textContent = "";
  $("voiceMessage").className = "message voice-message";
  $("voiceDescription").value = "";
  $("voiceAmount").value = "";
  $("voiceType").value = "";
  $("voiceCategory").value = "Other";
  $("voiceDate").value = today();
  $("voiceTranscript").value = "";
  voiceTransactionSaved = false;
});

$("closeVoiceEntry").addEventListener("click", () => {
  stopVoiceRecognition();
  voiceTransactionSaved = false;
  $("voiceConfirmation").reset();
  $("voiceConfirmation").classList.add("hidden");
  $("voiceTranscriptPreview").classList.add("hidden");
  $("voicePanel").classList.add("hidden");
  $("voiceMessage").textContent = "";
  $("voiceStatus").textContent = "Ready";
});

$("startVoiceEntry").addEventListener("click", async () => {
  const msg = $("voiceMessage");
  const btn = $("startVoiceEntry");
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  console.info("[Finora Voice] Start Listening clicked.");
  if (!SpeechRecognition) {
    console.error("[Finora Voice] SpeechRecognition is not supported by this browser.");
    $("voiceStatus").textContent = "Not supported";
    msg.className = "message voice-message error";
    msg.textContent = "Voice recognition is unavailable in this browser. Try the latest Chrome or Edge, or enter the transaction manually.";
    return;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    console.error("[Finora Voice] getUserMedia is unavailable in this browser context.");
    $("voiceStatus").textContent = "Microphone unavailable";
    msg.className = "message voice-message error";
    msg.textContent = "Microphone access is unavailable. Use a secure connection (HTTPS or localhost) and enter the transaction manually if needed.";
    return;
  }

  stopVoiceRecognition();
  const requestId = voiceStartRequestId;
  $("voiceConfirmation").classList.add("hidden");
  $("voiceTranscriptPreview").classList.remove("hidden");
  $("voiceTranscriptText").textContent = "";
  $("voiceTranscript").value = "";
  $("voiceStatus").textContent = "Requesting microphone";
  msg.className = "message voice-message";
  msg.textContent = "Allow microphone access to begin.";
  btn.disabled = true;
  $("stopVoiceEntry").disabled = false;
  $("stopVoiceEntry").classList.remove("hidden");

  let microphoneStream;
  let recognition;
  let startTimeout;
  try {
    console.info("[Finora Voice] Requesting microphone permission.");
    microphoneStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    console.info("[Finora Voice] Microphone permission granted.");
    if (requestId !== voiceStartRequestId) {
      microphoneStream.getTracks().forEach((track) => track.stop());
      return;
    }
    if (!microphoneStream.getAudioTracks().some((track) => track.readyState === "live" && track.enabled)) {
      throw new Error("No active microphone audio track was found.");
    }

    activeVoiceMicrophoneStream = microphoneStream;
    microphoneStream = null;
    voicePeakInputLevel = 0;
    voiceInputLevelAvailable = false;

    recognition = new SpeechRecognition();
    activeSpeechRecognition = recognition;
    recognition.lang = "en-IN";
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    console.info("[Finora Voice] SpeechRecognition initialized.", {
      lang: recognition.lang,
      continuous: recognition.continuous,
      interimResults: recognition.interimResults
    });

    let recognitionError = "";
    const transcriptSegments = [];
    let recognitionTimeout;

    const finishRecognition = () => {
      window.clearTimeout(recognitionTimeout);
      window.clearTimeout(startTimeout);
      if (activeSpeechRecognition !== recognition) return;
      activeSpeechRecognition = null;
      const peakInputLevel = voicePeakInputLevel;
      const inputLevelAvailable = voiceInputLevelAvailable;
      stopVoiceInputMonitor();
      btn.disabled = false;
      btn.classList.remove("voice-recording");
      $("stopVoiceEntry").disabled = false;
      $("stopVoiceEntry").classList.add("hidden");
      $("voiceListening").classList.add("hidden");
      const finalTranscript = transcriptSegments
        .filter((segment) => segment?.isFinal)
        .map((segment) => segment.text)
        .join(" ")
        .trim();
      const transcript = finalTranscript || transcriptSegments
        .map((segment) => segment?.text || "")
        .join(" ")
        .trim();
      if (!transcript) {
        $("voiceStatus").textContent = recognitionError === "no-speech"
          ? "No speech detected"
          : recognitionError === "timeout" || recognitionError === "start-timeout"
            ? "Listening timed out"
            : recognitionError ? "Recognition failed" : "No speech detected";
        msg.className = "message voice-message error";
        if (!recognitionError || recognitionError === "no-speech") {
          msg.textContent = inputLevelAvailable && peakInputLevel < 0.008
            ? "Your microphone is not picking up your voice. Check that the correct microphone is selected in Windows/browser settings, unmute it, move closer, then try again."
            : "Your microphone is picking up sound, but the browser did not turn it into words. Check your internet connection and site microphone permission, then retry in the latest Chrome or Edge.";
        }
        if (recognitionError) console.error("[Finora Voice] Recognition ended with an error.", recognitionError);
        return;
      }

      console.info("[Finora Voice] Recognized transcript:", transcript);
      $("voiceStatus").textContent = "Preparing review";
      $("voiceTranscriptText").textContent = transcript;
      $("voiceTranscript").value = transcript;
      voiceTransactionSaved = false;
      const result = parseVoiceTransaction(transcript);
      console.info("[Finora Voice] Extracted transaction details:", result);
      $("voiceType").value = result.type;
      $("voiceAmount").value = result.amount;
      $("voiceDescription").value = result.description;
      $("voiceCategory").value = result.category;
      $("voiceDate").value = result.date;
      $("voiceConfirmation").classList.remove("hidden");
      $("voiceStatus").textContent = "Review transaction";
      msg.className = "message voice-message success";
      msg.textContent = `${finalTranscript ? "Speech recognized." : "Partial speech captured; check the transcript carefully."} ${!result.amount ? "Enter the amount. " : ""}${!result.type ? "Choose Income or Expense. " : ""}Review and edit every field before saving.`;
      $("voiceConfirmation").scrollIntoView({ behavior: "smooth", block: "nearest" });
    };

    recognition.onstart = () => {
      if (activeSpeechRecognition !== recognition) return;
      if (activeVoiceMicrophoneStream && (window.AudioContext || window.webkitAudioContext)) {
        try {
          const AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
          activeVoiceAudioContext = new AudioContextConstructor();
          if (activeVoiceAudioContext.state !== "running") {
            throw new Error("Microphone level monitor audio context is not running.");
          }
          const analyser = activeVoiceAudioContext.createAnalyser();
          analyser.fftSize = 2048;
          activeVoiceAudioContext.createMediaStreamSource(activeVoiceMicrophoneStream).connect(analyser);
          const samples = new Float32Array(analyser.fftSize);
          const measureInputLevel = () => {
            analyser.getFloatTimeDomainData(samples);
            let sumSquares = 0;
            for (const sample of samples) sumSquares += sample * sample;
            const inputLevel = Math.sqrt(sumSquares / samples.length);
            voicePeakInputLevel = Math.max(voicePeakInputLevel, inputLevel);
            const meterValue = Math.min(100, Math.round(inputLevel * 1200));
            $("voiceInputMeter").setAttribute("aria-valuenow", String(meterValue));
            $("voiceInputMeterFill").style.width = `${meterValue}%`;
            if (inputLevel > 0.008 && !voiceInputWasDetected) {
              voiceInputWasDetected = true;
              $("voiceStatus").textContent = "Voice input detected";
            }
            activeVoiceMeterFrame = window.requestAnimationFrame(measureInputLevel);
          };
          voiceInputLevelAvailable = true;
          $("voiceInputMeter").classList.remove("hidden");
          $("voiceInputHint").classList.remove("hidden");
          measureInputLevel();
        } catch (error) {
          console.warn("[Finora Voice] Could not monitor microphone input level.", error);
        }
      }
      btn.disabled = true;
      btn.classList.add("voice-recording");
      $("voiceListening").classList.remove("hidden");
      $("voiceStatus").textContent = "Listening... Speak now";
      msg.className = "message voice-message";
      msg.textContent = "Listening... Speak now";
      console.info("[Finora Voice] Recognition started; microphone is listening.");
      window.clearTimeout(startTimeout);
      recognitionTimeout = window.setTimeout(() => {
        if (activeSpeechRecognition !== recognition) return;
        recognitionError = "timeout";
        $("voiceStatus").textContent = "Listening timed out";
        msg.className = "message voice-message error";
        msg.textContent = "Listening timed out after 30 seconds. Try again and speak after listening starts.";
        try {
          recognition.abort();
        } catch (error) {
          if (error.name !== "InvalidStateError") throw error;
        }
      }, 30000);
    };

    recognition.onresult = (event) => {
      for (let index = event.resultIndex || 0; index < event.results.length; index += 1) {
        transcriptSegments[index] = {
          text: event.results[index][0].transcript,
          isFinal: event.results[index].isFinal
        };
      }
      const liveTranscript = transcriptSegments.map((segment) => segment?.text || "").join(" ").trim();
      $("voiceTranscriptText").textContent = liveTranscript;
      console.info("[Finora Voice] Speech result received.", {
        transcript: liveTranscript,
        isFinal: Array.from(event.results).every((result) => result.isFinal)
      });
    };

    recognition.onerror = (event) => {
      recognitionError = event.error || "unknown";
      console.error("[Finora Voice] Speech recognition error.", {
        error: recognitionError,
        message: event.message || ""
      });
      const messages = {
        "not-allowed": "Microphone permission was denied. Allow microphone access for this site and try again.",
        "service-not-allowed": "The browser blocked its speech recognition service. Check browser/site permissions and try again.",
        "audio-capture": "The browser could not capture microphone audio. Check that a microphone is connected and enabled.",
        "no-speech": "No speech was detected. Try again and speak after the listening indicator appears.",
        network: "Speech recognition could not connect. Check your internet connection and try again.",
        aborted: "Voice recognition was stopped before speech was recognized.",
        timeout: "Listening timed out after 30 seconds. Try again and speak after listening starts."
      };
      $("voiceStatus").textContent = recognitionError === "no-speech" ? "No speech detected" : "Recognition error";
      msg.className = "message voice-message error";
      msg.textContent = messages[recognitionError] || "Speech recognition failed. Please check microphone access and try again.";
    };

    recognition.onend = () => {
      console.info("[Finora Voice] Recognition ended.");
      finishRecognition();
    };
    startTimeout = window.setTimeout(() => {
      if (activeSpeechRecognition !== recognition) return;
      recognitionError = "start-timeout";
      msg.className = "message voice-message error";
      msg.textContent = "Speech recognition did not start. Check microphone and browser permissions, then try again.";
      console.error("[Finora Voice] Timed out waiting for the recognition start event.");
      try {
        recognition.abort();
      } catch (error) {
        if (error.name !== "InvalidStateError") throw error;
      }
      finishRecognition();
    }, 10000);
    recognition.start();
    console.info("[Finora Voice] recognition.start() called.");
  } catch (error) {
    console.error("[Finora Voice] Could not start recognition.", error);
    window.clearTimeout(startTimeout);
    microphoneStream?.getTracks().forEach((track) => track.stop());
    stopVoiceInputMonitor();
    if (activeSpeechRecognition === recognition) {
      activeSpeechRecognition = null;
    }
    if (requestId === voiceStartRequestId) {
      btn.disabled = false;
      btn.classList.remove("voice-recording");
      $("stopVoiceEntry").classList.add("hidden");
      $("voiceListening").classList.add("hidden");
      $("voiceStatus").textContent = "Could not start";
      msg.className = "message voice-message error";
      msg.textContent = error.name === "NotAllowedError" || error.name === "SecurityError"
        ? "Microphone permission was denied. Allow microphone access for this site and try again."
        : error.name === "NotFoundError" || error.name === "OverconstrainedError"
          ? "No microphone was found. Connect or enable a microphone and try again."
          : error.message || "Could not start voice recognition. Check microphone access and try again.";
    }
  }
});

$("stopVoiceEntry").addEventListener("click", () => {
  if (activeSpeechRecognition) {
    $("voiceStatus").textContent = "Finishing recognition...";
    $("voiceMessage").textContent = "Finishing recognition. Please wait...";
    $("stopVoiceEntry").disabled = true;
    try {
      activeSpeechRecognition.stop();
    } catch (error) {
      if (error.name !== "InvalidStateError") throw error;
    }
    return;
  }

  stopVoiceRecognition();
  $("voiceStatus").textContent = "Stopped";
  $("voiceMessage").className = "message voice-message";
  $("voiceMessage").textContent = "Microphone request cancelled.";
});

$("voiceConfirmation").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (voiceSaveInProgress || voiceTransactionSaved) return;

  const description = $("voiceDescription").value.trim();
  const amount = parseCurrencyAmount($("voiceAmount").value);
  const category = $("voiceCategory").value.trim();
  const type = $("voiceType").value;
  const date = $("voiceDate").value;
  const transcript = $("voiceTranscript").value.trim();
  const msg = $("voiceMessage");

  if (!["income", "expense"].includes(type)) {
    msg.className = "message voice-message error";
    msg.textContent = "Choose whether this transaction is Income or Expense before confirming.";
    $("voiceType").focus();
    return;
  }
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (
    !transcript ||
    !description ||
    amount === null ||
    !category ||
    !parsedDate ||
    Number.isNaN(parsedDate.getTime()) ||
    parsedDate.toISOString().slice(0, 10) !== date
  ) {
    msg.className = "message voice-message error";
    msg.textContent = "Enter a description, valid amount greater than zero, category, and date before saving.";
    return;
  }

  const saveButton = $("saveVoiceTransaction");
  const cancelButton = $("closeVoiceEntry");
  voiceSaveInProgress = true;
  saveButton.disabled = true;
  cancelButton.disabled = true;
  $("voiceStatus").textContent = "Saving";
  msg.className = "message voice-message";
  msg.textContent = "Saving your reviewed transaction...";
  try {
    await addTransaction({ type, description, amount, category, date });
    voiceTransactionSaved = true;
    $("voiceConfirmation").classList.add("hidden");
    $("voiceStatus").textContent = "Saved";
    msg.className = "message voice-message success";
    msg.textContent = "Transaction added successfully!";
  } catch (err) {
    $("voiceStatus").textContent = "Save failed";
    msg.className = "message voice-message error";
    msg.textContent = err instanceof TypeError && /fetch|network/i.test(err.message)
      ? "Could not connect to the backend. Check that the server is running, then try again."
      : err.message;
  } finally {
    voiceSaveInProgress = false;
    saveButton.disabled = false;
    cancelButton.disabled = false;
  }
});

// Read ?auth= param from landing page buttons
(function checkAuthParam() {
  const param = new URLSearchParams(window.location.search).get("auth");
  if (param === "signup") {
    isNewUser = true;
    $("signupTab").classList.add("active");
    $("loginTab").classList.remove("active");
    $("authTitle").textContent = "Create your account";
    $("authDescription").textContent = "Enter your email to get started.";
  }
})();
