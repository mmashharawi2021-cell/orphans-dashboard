const path = require("path");
const fs = require("fs");
const admin = require("firebase-admin");

function getFirebaseServiceAccount() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const json = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (json.private_key) {
      json.private_key = json.private_key.replace(/\\n/g, "\n");
    }
    return json;
  }

  const localPath = path.join(__dirname, "firebase-admin.json");
  if (fs.existsSync(localPath)) {
    return require(localPath);
  }

  throw new Error("Firebase service account is missing");
}

const serviceAccount = getFirebaseServiceAccount();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const authAdmin = admin.auth();
const db = admin.firestore();

const express = require("express");
const session = require("express-session");
const XLSX = require("xlsx");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 3000;
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || "AIzaSyCCte1c24D2w9jVsqoVlUKsGC8oShrFsrg";

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data.xlsx");
const USERS_FILE = path.join(ROOT, "users.json");
const ARCHIVE_FILE = path.join(ROOT, "archive.json");
const LOG_FILE = path.join(ROOT, "activity-log.json");
const SETTINGS_FILE = path.join(ROOT, "settings.json");
const BACKUPS_DIR = path.join(ROOT, "backups");

const INTERNAL_FIELDS = [
  "__record_id",
  "__created_by",
  "__created_at",
  "__updated_by",
  "__updated_at"
];

const DEFAULT_SETTINGS = {
  systemName: "نظام إدارة بيانات الأيتام",
  brand: "نظام إدارة بيانات الأيتام",
  sessionMinutes: 60,
  maxFailedAttempts: 5,
  lockMinutes: 20,
  themeDefault: "light",
  rateUSD: 3.65,
  rateJOD: 5.14,
  rateUSDT: 3.65,
  customCurrencyName: "",
  customCurrencyCode: "",
  customCurrencyRate: 0,
  customCurrencyIcon: "bi bi-currency-exchange"
};


const liveRatesCache = {
  at: 0,
  data: null,
  ttl: 5000
};

async function fetchJsonSafe(url) {
  const res = await fetch(url, { headers: { "accept": "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function getLiveRates() {
  const now = Date.now();
  if (liveRatesCache.data && now - liveRatesCache.at < liveRatesCache.ttl) {
    return liveRatesCache.data;
  }

  const settings = getSettings();
  const customCode = String(settings.customCurrencyCode || "").trim().toUpperCase();
  const wantedCodes = ["ILS", "JOD"];
  if (customCode && !wantedCodes.includes(customCode)) wantedCodes.push(customCode);

  let rates = {
    USDILS: Number(settings.rateUSD || 0),
    JODILS: Number(settings.rateJOD || 0),
    USDTILS: Number(settings.rateUSDT || 0)
  };

  try {
    const fiat = await fetchJsonSafe(`https://open.er-api.com/v6/latest/USD`);
    if (fiat?.rates?.ILS) {
      rates.USDILS = Number(fiat.rates.ILS);
      if (fiat.rates.JOD) rates.JODILS = Number(fiat.rates.ILS) / Number(fiat.rates.JOD);
      if (customCode && fiat.rates[customCode]) rates[`${customCode}ILS`] = Number(fiat.rates.ILS) / Number(fiat.rates[customCode]);
    }
  } catch (e) {}

  try {
    const cg = await fetchJsonSafe(`https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=ils&include_last_updated_at=true`);
    if (cg?.tether?.ils) rates.USDTILS = Number(cg.tether.ils);
  } catch (e) {}

  liveRatesCache.at = now;
  liveRatesCache.data = {
    ...rates,
    fetchedAt: new Date().toISOString(),
    sourceWindowMs: liveRatesCache.ttl
  };
  return liveRatesCache.data;
}

const ROLE_PRESETS = {
  "مدير نظام": {
    canSearch: true, canViewResults: true, canViewFullDetails: true, canAdd: true, canEdit: true,
    canEditOwnOnly: false, canArchive: true, canRestore: true, canExport: true, canImport: true,
    canManageUsers: true, canManagePermissions: true, canViewStats: true, canViewSensitive: true,
    canEditSensitive: true, canViewLogs: true, canManageSettings: true
  },
  "مشرف": {
    canSearch: true, canViewResults: true, canViewFullDetails: true, canAdd: true, canEdit: true,
    canEditOwnOnly: false, canArchive: false, canRestore: false, canExport: false, canImport: false,
    canManageUsers: false, canManagePermissions: false, canViewStats: true, canViewSensitive: false,
    canEditSensitive: false, canViewLogs: false, canManageSettings: false
  },
  "مدخل بيانات": {
    canSearch: true, canViewResults: true, canViewFullDetails: false, canAdd: true, canEdit: false,
    canEditOwnOnly: false, canArchive: false, canRestore: false, canExport: false, canImport: false,
    canManageUsers: false, canManagePermissions: false, canViewStats: false, canViewSensitive: false,
    canEditSensitive: false, canViewLogs: false, canManageSettings: false
  },
  "مراجع": {
    canSearch: true, canViewResults: true, canViewFullDetails: true, canAdd: false, canEdit: false,
    canEditOwnOnly: false, canArchive: false, canRestore: false, canExport: false, canImport: false,
    canManageUsers: false, canManagePermissions: false, canViewStats: true, canViewSensitive: false,
    canEditSensitive: false, canViewLogs: false, canManageSettings: false
  },
  "ضيف داخلي": {
    canSearch: true, canViewResults: true, canViewFullDetails: false, canAdd: false, canEdit: false,
    canEditOwnOnly: false, canArchive: false, canRestore: false, canExport: false, canImport: false,
    canManageUsers: false, canManagePermissions: false, canViewStats: false, canViewSensitive: false,
    canEditSensitive: false, canViewLogs: false, canManageSettings: false
  }
};

app.use(express.json({ limit: "8mb" }));
app.use(express.urlencoded({ extended: true }));

app.set("trust proxy", 1);
const isProduction = process.env.NODE_ENV === "production";

app.use(session({
  secret: process.env.SESSION_SECRET || "orphans-dashboard-v3-secret",
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction,
    maxAge: 1000 * 60 * 60
  }
}));

app.use(express.static(PUBLIC_DIR));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});
function ensureFiles() {
  if (!fs.existsSync(DATA_FILE)) {
    throw new Error("ملف البيانات غير موجود");
  }
  if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  if (!fs.existsSync(ARCHIVE_FILE)) fs.writeFileSync(ARCHIVE_FILE, "[]", "utf8");
  if (!fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "[]", "utf8");
  if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), "utf8");
  if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, "[]", "utf8");
  const maybeUsers = readJson(USERS_FILE, []);
  if (!Array.isArray(maybeUsers) || maybeUsers.length === 0) {
    const admin = {
      id: "u-admin",
      username: "admin",
      email: "test@test.com",
      displayName: "مدير النظام",
      role: "مدير نظام",
      gender: "male",
      active: true,
      passwordHash: bcrypt.hashSync("123456", 10),
      mustChangePassword: true,
      createdAt: new Date().toISOString(),
      failedAttempts: 0,
      lockUntil: null,
      sheetAccess: "*",
      fieldRules: { hideSensitive: false, hiddenFields: [] },
      permissions: ROLE_PRESETS["مدير نظام"]
    };
    fs.writeFileSync(USERS_FILE, JSON.stringify([admin], null, 2), "utf8");
  } else {
    let changed = false;
    maybeUsers.forEach(u => {
      if (u.username === 'admin' && !u.email) {
        u.email = 'test@test.com';
        changed = true;
      }
    });
    if (changed) fs.writeFileSync(USERS_FILE, JSON.stringify(maybeUsers, null, 2), 'utf8');
  }
}

function nowIso() { return new Date().toISOString(); }
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    return fallback;
  }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}
function randomId(prefix = "id") {
  return `${prefix}-${crypto.randomBytes(8).toString("hex")}`;
}
function getSettings() {
  ensureFiles();
  return { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_FILE, DEFAULT_SETTINGS) };
}
function readUsers() {
  ensureFiles();
  return readJson(USERS_FILE, []);
}
function writeUsers(users) {
  writeJson(USERS_FILE, users);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

async function getUserFromFirestoreByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const doc = await db.collection("users").doc(normalized).get();
  if (!doc.exists) return null;

  return doc.data();
}
function toFirestoreUserDoc(user) {
  return {
    id: user.id,
    username: user.username,
    email: normalizeEmail(user.email || ""),
    displayName: user.displayName || user.username,
    role: user.role,
    gender: user.gender || "male",
    active: !!user.active,
    mustChangePassword: !!user.mustChangePassword,
    createdAt: user.createdAt || nowIso(),
    failedAttempts: Number(user.failedAttempts || 0),
    lockUntil: user.lockUntil || null,
    sheetAccess: user.sheetAccess || "*",
    fieldRules: user.fieldRules || { hideSensitive: false, hiddenFields: [] },
    permissions: user.permissions || {}
  };
}
async function syncUserDocToFirestore(user) {
  const email = normalizeEmail(user.email || "");
  if (!email) return;
  await db.collection("users").doc(email).set(toFirestoreUserDoc(user), { merge: true });
}
async function deleteUserDocFromFirestore(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  await db.collection("users").doc(normalized).delete().catch(() => {});
}
async function createFirebaseAuthUserIfNeeded(user, plainPassword) {
  const email = normalizeEmail(user.email || "");
  if (!email) return null;
  try {
    return await authAdmin.createUser({
      email,
      password: String(plainPassword || "123456"),
      displayName: user.displayName || user.username,
      disabled: !user.active
    });
  } catch (error) {
    if (error.code === "auth/email-already-exists") {
      const existing = await authAdmin.getUserByEmail(email);
      await authAdmin.updateUser(existing.uid, {
        email,
        displayName: user.displayName || user.username,
        disabled: !user.active,
        ...(plainPassword ? { password: String(plainPassword) } : {})
      });
      return existing;
    }
    throw error;
  }
}
async function updateFirebaseAuthUserByEmail(currentEmail, updates = {}) {
  const normalizedCurrent = normalizeEmail(currentEmail);
  const normalizedNext = normalizeEmail(updates.email || currentEmail);
  if (!normalizedCurrent && !normalizedNext) return null;

  let userRecord = null;
  if (normalizedCurrent) {
    try {
      userRecord = await authAdmin.getUserByEmail(normalizedCurrent);
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }

  if (!userRecord && normalizedNext) {
    try {
      userRecord = await authAdmin.getUserByEmail(normalizedNext);
    } catch (error) {
      if (error.code !== "auth/user-not-found") throw error;
    }
  }

  if (!userRecord) {
    if (!normalizedNext) return null;
    return await authAdmin.createUser({
      email: normalizedNext,
      password: String(updates.password || "123456"),
      displayName: updates.displayName || updates.username || normalizedNext,
      disabled: updates.active === undefined ? false : !updates.active
    });
  }

  const payload = {};
  if (normalizedNext) payload.email = normalizedNext;
  if (updates.displayName !== undefined) payload.displayName = updates.displayName;
  if (updates.password) payload.password = String(updates.password);
  if (updates.active !== undefined) payload.disabled = !updates.active;

  if (Object.keys(payload).length) {
    userRecord = await authAdmin.updateUser(userRecord.uid, payload);
  }
  return userRecord;
}
async function deleteFirebaseAuthUserByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return;
  try {
    const userRecord = await authAdmin.getUserByEmail(normalized);
    await authAdmin.deleteUser(userRecord.uid);
  } catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
  }
}
async function verifyFirebaseEmailPassword(email, password) {
  if (!FIREBASE_API_KEY) throw new Error("FIREBASE_API_KEY غير مضبوط");
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = String(data?.error?.message || '').toUpperCase();
    if (msg.includes('INVALID_LOGIN_CREDENTIALS') || msg.includes('INVALID_PASSWORD') || msg.includes('EMAIL_NOT_FOUND')) {
      throw new Error('اسم المستخدم أو كلمة المرور غير صحيحين');
    }
    if (msg.includes('USER_DISABLED')) {
      throw new Error('حساب Firebase معطل');
    }
    throw new Error('تعذر التحقق من Firebase');
  }
  return data;
}
function readArchive() {
  ensureFiles();
  return readJson(ARCHIVE_FILE, []);
}
function writeArchive(items) {
  writeJson(ARCHIVE_FILE, items);
}
function readLogs() {
  ensureFiles();
  return readJson(LOG_FILE, []);
}
function appendLog(entry) {
  const logs = readLogs();
  logs.unshift({ id: randomId("log"), at: nowIso(), ...entry });
  writeJson(LOG_FILE, logs.slice(0, 3000));
}
function logAction(req, action, details = {}) {
  appendLog({
    userId: req.session?.user?.id || null,
    username: req.session?.user?.username || "anonymous",
    action,
    ip: req.headers["x-forwarded-for"] || req.socket.remoteAddress || "",
    userAgent: req.headers["user-agent"] || "",
    details
  });
}
function sanitizeSheetName(name) {
  return String(name || "").trim();
}
function normalizeHeader(value, index) {
  const text = String(value ?? "").trim();
  return text || `حقل ${index + 1}`;
}
function normalizeArabic(text) {
  return String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ");
}
function formatCell(value) {
  if (value === undefined || value === null) return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const d = String(value.getDate()).padStart(2, "0");
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const y = value.getFullYear();
    return `${d}/${m}/${y}`;
  }
  return String(value).trim();
}
function isSensitiveHeader(header) {
  const h = normalizeArabic(header);
  const patterns = [
    "رقم الهويه", "رقم الهوية", "هويه", "هويه",
    "رقم الجوال", "الجوال", "الهاتف", "رقم الهاتف", "الهاتف المحمول",
    "العنوان", "الموقع", "الملاحظات", "بيانات الوصي", "رقم الوصي",
    "رقم الكفيل", "رقم الملف", "المرفقات", "صوره", "صورة", "الميلاد الكامل"
  ];
  return patterns.some(p => h.includes(normalizeArabic(p)));
}
function isStatusLike(value) {
  const v = normalizeArabic(value);
  return ["ناقص", "مطلوب", "يتيم الاب", "يتيم الابوين", "جاهز", "تم", "ما وصل", "لا يوجد كفاله", "واصل"].some(k => v.includes(normalizeArabic(k)));
}
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}
function createBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(BACKUPS_DIR, `data-backup-${stamp}.xlsx`);
  fs.copyFileSync(DATA_FILE, target);
}
function readWorkbook() {
  ensureFiles();
  return XLSX.readFile(DATA_FILE, { cellDates: true });
}
function writeWorkbook(workbook) {
  createBackup();
  XLSX.writeFile(workbook, DATA_FILE);
}
function buildWorksheetFromRecords(headers, records) {
  const allHeaders = [...headers];
  INTERNAL_FIELDS.forEach(h => {
    if (!allHeaders.includes(h)) allHeaders.push(h);
  });
  const rows = [allHeaders];
  for (const record of records) {
    rows.push(allHeaders.map(h => record[h] ?? ""));
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const cols = allHeaders.map(h => INTERNAL_FIELDS.includes(h) ? { hidden: true } : { hidden: false });
  ws["!cols"] = cols;
  return ws;
}
function getAllowedSheetNames(user, workbook) {
  const all = workbook.SheetNames.slice();
  if (!user || user.sheetAccess === "*" || !Array.isArray(user.sheetAccess)) return all;
  return all.filter(name => user.sheetAccess.includes(name));
}
function parseSheet(workbook, sheetName) {
  const ws = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" });
  const headerRow = matrix[0] || [];
  const rawHeaders = headerRow.map((h, i) => normalizeHeader(h, i));
  let headers = rawHeaders.slice();
  let changed = false;

  INTERNAL_FIELDS.forEach(h => {
    if (!headers.includes(h)) {
      headers.push(h);
      changed = true;
    }
  });

  const records = [];
  for (let i = 1; i < matrix.length; i++) {
    const row = matrix[i] || [];
    const record = {};
    headers.forEach((header, idx) => {
      let value = row[idx];
      record[header] = formatCell(value);
    });
    const visibleValues = headers.filter(h => !INTERNAL_FIELDS.includes(h)).map(h => record[h]).join("").trim();
    if (!visibleValues) continue;

    if (!record.__record_id) { record.__record_id = randomId("rec"); changed = true; }
    if (!record.__created_at) { record.__created_at = nowIso(); changed = true; }
    if (!record.__updated_at) { record.__updated_at = record.__created_at; changed = true; }
    if (!record.__created_by) { record.__created_by = "system"; changed = true; }
    if (!record.__updated_by) { record.__updated_by = record.__created_by; changed = true; }

    records.push(record);
  }

  const visibleHeaders = headers.filter(h => !INTERNAL_FIELDS.includes(h));
  return { headers, visibleHeaders, records, changed };
}
function normalizeWorkbook() {
  const workbook = readWorkbook();
  let changed = false;
  workbook.SheetNames.forEach(name => {
    const parsed = parseSheet(workbook, name);
    if (parsed.changed) {
      workbook.Sheets[name] = buildWorksheetFromRecords(parsed.visibleHeaders, parsed.records);
      changed = true;
    }
  });
  if (changed) writeWorkbook(workbook);
}
function saveSheet(workbook, sheetName, visibleHeaders, records) {
  workbook.Sheets[sheetName] = buildWorksheetFromRecords(visibleHeaders, records);
  if (!workbook.SheetNames.includes(sheetName)) workbook.SheetNames.push(sheetName);
  writeWorkbook(workbook);
}
function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    email: user.email || "",
    displayName: user.displayName || user.username,
    role: user.role,
    gender: user.gender || "male",
    active: !!user.active,
    mustChangePassword: !!user.mustChangePassword,
    permissions: user.permissions || {},
    sheetAccess: user.sheetAccess || "*",
    fieldRules: user.fieldRules || { hideSensitive: false, hiddenFields: [] },
    createdAt: user.createdAt || null
  };
}
function requireAuth(req, res, next) {
  if (!req.session?.user) {
    return res.status(401).json({ success: false, message: "غير مصرح" });
  }
  const settings = getSettings();
  req.session.cookie.maxAge = settings.sessionMinutes * 60 * 1000;
  next();
}
function requirePerm(permission) {
  return (req, res, next) => {
    const perms = req.session?.user?.permissions || {};
    if (!perms[permission]) {
      return res.status(403).json({ success: false, message: "ليست لديك صلاحية كافية" });
    }
    next();
  };
}
function userCanSeeField(user, header) {
  if (!user) return false;
  if (user.permissions?.canViewSensitive) return true;
  if (Array.isArray(user.fieldRules?.hiddenFields) && user.fieldRules.hiddenFields.includes(header)) return false;
  if (user.fieldRules?.hideSensitive && isSensitiveHeader(header)) return false;
  return !isSensitiveHeader(header);
}
function filterRecordForUser(user, record, headers) {
  const result = {};
  headers.forEach(h => {
    if (userCanSeeField(user, h)) result[h] = record[h] ?? "";
  });
  result.__meta = {
    id: record.__record_id,
    createdBy: record.__created_by,
    createdAt: record.__created_at,
    updatedBy: record.__updated_by,
    updatedAt: record.__updated_at
  };
  return result;
}
function matchesSheetAccess(user, sheetName) {
  if (!user || user.sheetAccess === "*" || !Array.isArray(user.sheetAccess)) return true;
  return user.sheetAccess.includes(sheetName);
}
function canEditThisRecord(user, record) {
  if (user.permissions?.canEdit) return true;
  if (user.permissions?.canEditOwnOnly) {
    return record.__created_by === user.username;
  }
  return false;
}
function dedupeHeaders(list) {
  const out = [];
  list.forEach((item, idx) => {
    const base = normalizeHeader(item, idx);
    let candidate = base;
    let counter = 2;
    while (out.includes(candidate)) {
      candidate = `${base} (${counter})`;
      counter += 1;
    }
    out.push(candidate);
  });
  return out;
}
function applySort(records, sortField, sortDirection) {
  if (!sortField) return records;
  const dir = sortDirection === "desc" ? -1 : 1;
  return records.sort((a, b) => {
    const va = normalizeArabic(a[sortField] || "");
    const vb = normalizeArabic(b[sortField] || "");
    return va.localeCompare(vb, "ar") * dir;
  });
}
function paginate(arr, page, pageSize) {
  const p = Math.max(1, Number(page || 1));
  const size = Math.max(1, Math.min(200, Number(pageSize || 20)));
  const start = (p - 1) * size;
  return { items: arr.slice(start, start + size), page: p, pageSize: size, total: arr.length };
}

ensureFiles();
normalizeWorkbook();

app.get("/api/bootstrap", requireAuth, (req, res) => {
  const workbook = readWorkbook();
  const settings = getSettings();
  const allowedSheets = getAllowedSheetNames(req.session.user, workbook);
  res.json({
    success: true,
    user: req.session.user,
    settings,
    sheets: allowedSheets,
    availableRoles: Object.keys(ROLE_PRESETS)
  });
});

app.get("/api/public-info", (req, res) => {
  res.json({
    success: true,
    settings: getSettings(),
    availableRoles: Object.keys(ROLE_PRESETS)
  });
});

app.get("/api/session", (req, res) => {
  if (!req.session?.user) return res.json({ success: true, authenticated: false });
  return res.json({ success: true, authenticated: true, user: req.session.user, settings: getSettings() });
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  const loginId = String(username || "").trim();
  const pass = String(password || "");
  const settings = getSettings();
  const isEmailLogin = loginId.includes("@");

  let user = null;

  if (isEmailLogin) {
    try {
      const firebaseUser = await verifyFirebaseEmailPassword(loginId, pass);
      user = await getUserFromFirestoreByEmail(firebaseUser.email || loginId);
      if (!user) {
        logAction(req, 'login_failed', { username: loginId, reason: 'firebase_user_not_mapped' });
        return res.status(403).json({ success: false, message: 'تم التحقق من Firebase لكن لا يوجد مستخدم نظام مرتبط بهذا البريد' });
      }
    } catch (err) {
      logAction(req, 'login_failed', { username: loginId, reason: 'firebase_auth_failed' });
      return res.status(401).json({ success: false, message: err.message || 'فشل تسجيل الدخول عبر Firebase' });
    }
  } else {
    const users = readUsers();
    user = users.find(u => u.username === loginId);
    if (!user) {
      logAction(req, 'login_failed', { username: loginId, reason: 'not_found' });
      return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحين' });
    }
    const ok = bcrypt.compareSync(pass, user.passwordHash);
    if (!ok) {
      user.failedAttempts = Number(user.failedAttempts || 0) + 1;
      if (user.failedAttempts >= settings.maxFailedAttempts) {
        const until = new Date(Date.now() + settings.lockMinutes * 60000).toISOString();
        user.lockUntil = until;
        user.failedAttempts = 0;
      }
      writeUsers(users);
      logAction(req, 'login_failed', { username: loginId, reason: 'bad_password' });
      return res.status(401).json({ success: false, message: 'اسم المستخدم أو كلمة المرور غير صحيحين' });
    }
  }

  if (!user) {
    logAction(req, 'login_failed', { username: loginId, reason: 'not_found_after_auth' });
    return res.status(401).json({ success: false, message: 'المستخدم غير موجود' });
  }
  if (!user.active) {
    logAction(req, 'login_failed', { username: loginId, reason: 'inactive' });
    return res.status(403).json({ success: false, message: 'الحساب غير مفعل' });
  }
  if (user.lockUntil && new Date(user.lockUntil) > new Date()) {
    return res.status(423).json({ success: false, message: 'الحساب مقفل مؤقتًا بسبب كثرة محاولات الدخول الخاطئة' });
  }

  user.failedAttempts = 0;
  user.lockUntil = null;

  req.session.user = publicUser(user);
  logAction(req, 'login_success', { username: user.username, loginId, via: isEmailLogin ? 'firebase' : 'local' });
  res.json({ success: true, user: req.session.user, settings, message: 'تم تسجيل الدخول' });
});

app.post("/api/logout", requireAuth, (req, res) => {
  const username = req.session.user.username;
  logAction(req, "logout", { username });
  req.session.destroy(() => {
    res.json({ success: true, message: "تم تسجيل الخروج" });
  });
});

app.post("/api/change-password", requireAuth, async (req, res) => {
  try {
    const { currentPassword, newPassword, targetUserId } = req.body || {};
    const users = readUsers();
    const actor = users.find(u => u.id === req.session.user.id);
    let target = actor;

    if (targetUserId && req.session.user.permissions?.canManageUsers) {
      target = users.find(u => u.id === targetUserId);
    }
    if (!target) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });

    if (target.id === actor.id) {
      if (!bcrypt.compareSync(String(currentPassword || ""), actor.passwordHash)) {
        return res.status(400).json({ success: false, message: "كلمة المرور الحالية غير صحيحة" });
      }
    }

    const newPass = String(newPassword || "");
    if (newPass.length < 6) {
      return res.status(400).json({ success: false, message: "كلمة المرور يجب أن تكون 6 أحرف على الأقل" });
    }

    target.passwordHash = bcrypt.hashSync(newPass, 10);
    target.mustChangePassword = false;
    writeUsers(users);

    if (target.email) {
      await updateFirebaseAuthUserByEmail(target.email, {
        email: target.email,
        displayName: target.displayName || target.username,
        password: newPass,
        active: target.active,
        username: target.username
      });
      await syncUserDocToFirestore(target);
    }

    logAction(req, "change_password", { targetUser: target.username });
    res.json({ success: true, message: "تم تغيير كلمة المرور" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message || "تعذر تغيير كلمة المرور" });
  }
});

app.get("/api/users", requireAuth, requirePerm("canManageUsers"), (req, res) => {
  const users = readUsers().map(publicUser);
  res.json({ success: true, users });
});

app.post("/api/users", requireAuth, requirePerm("canManageUsers"), async (req, res) => {
  try {
    const body = req.body || {};
    const users = readUsers();
    const username = String(body.username || "").trim();
    const email = normalizeEmail(body.email || "");
    const plainPassword = String(body.password || "123456");

    if (!username) return res.status(400).json({ success: false, message: "اسم المستخدم مطلوب" });
    if (users.some(u => u.username === username)) {
      return res.status(400).json({ success: false, message: "اسم المستخدم مستخدم بالفعل" });
    }
    if (email && users.some(u => normalizeEmail(u.email || "") === email)) {
      return res.status(400).json({ success: false, message: "البريد الإلكتروني مستخدم بالفعل" });
    }

    const role = String(body.role || "ضيف داخلي").trim();
    const preset = deepClone(ROLE_PRESETS[role] || ROLE_PRESETS["ضيف داخلي"]);
    const permissions = { ...preset, ...(body.permissions || {}) };
    const newUser = {
      id: randomId("u"),
      username,
      email,
      displayName: String(body.displayName || username).trim(),
      role,
      gender: body.gender === "female" ? "female" : "male",
      active: body.active !== false,
      passwordHash: bcrypt.hashSync(plainPassword, 10),
      mustChangePassword: true,
      createdAt: nowIso(),
      failedAttempts: 0,
      lockUntil: null,
      sheetAccess: body.sheetAccess === "*" ? "*" : (Array.isArray(body.sheetAccess) ? body.sheetAccess : "*"),
      fieldRules: {
        hideSensitive: body.fieldRules?.hideSensitive !== false,
        hiddenFields: Array.isArray(body.fieldRules?.hiddenFields) ? body.fieldRules.hiddenFields : []
      },
      permissions
    };

    if (email) {
      await createFirebaseAuthUserIfNeeded(newUser, plainPassword);
    }

    users.push(newUser);
    writeUsers(users);
    await syncUserDocToFirestore(newUser);

    logAction(req, "user_create", { username: newUser.username, role, email });
    res.json({ success: true, user: publicUser(newUser), message: "تم إنشاء المستخدم" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message || "تعذر إنشاء المستخدم" });
  }
});

app.put("/api/users/:id", requireAuth, requirePerm("canManageUsers"), async (req, res) => {
  try {
    const users = readUsers();
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });

    const target = users[idx];
    const previousEmail = normalizeEmail(target.email || "");
    const body = req.body || {};

    if (target.username === "admin" && body.active === false) {
      return res.status(400).json({ success: false, message: "لا يمكن تعطيل admin" });
    }

    const nextEmail = body.email === undefined ? previousEmail : normalizeEmail(body.email || "");
    if (nextEmail && users.some(u => u.id !== target.id && normalizeEmail(u.email || "") === nextEmail)) {
      return res.status(400).json({ success: false, message: "البريد الإلكتروني مستخدم بالفعل" });
    }

    target.email = nextEmail;
    target.displayName = String(body.displayName ?? target.displayName).trim() || target.displayName;
    target.role = String(body.role ?? target.role).trim() || target.role;
    target.gender = body.gender === undefined ? (target.gender || "male") : (body.gender === "female" ? "female" : "male");
    target.active = body.active === undefined ? target.active : !!body.active;
    target.sheetAccess = body.sheetAccess === "*" ? "*" : (Array.isArray(body.sheetAccess) ? body.sheetAccess : target.sheetAccess);
    target.permissions = { ...target.permissions, ...(body.permissions || {}) };
    target.fieldRules = {
      hideSensitive: body.fieldRules?.hideSensitive === undefined ? target.fieldRules?.hideSensitive !== false : !!body.fieldRules.hideSensitive,
      hiddenFields: Array.isArray(body.fieldRules?.hiddenFields) ? body.fieldRules.hiddenFields : (target.fieldRules?.hiddenFields || [])
    };
    if (body.password) {
      target.passwordHash = bcrypt.hashSync(String(body.password), 10);
      target.mustChangePassword = false;
    }

    if (nextEmail) {
      await updateFirebaseAuthUserByEmail(previousEmail, {
        email: nextEmail,
        displayName: target.displayName,
        password: body.password ? String(body.password) : undefined,
        active: target.active,
        username: target.username
      });
    } else if (previousEmail) {
      await deleteFirebaseAuthUserByEmail(previousEmail);
      await deleteUserDocFromFirestore(previousEmail);
    }

    writeUsers(users);
    if (previousEmail && previousEmail !== nextEmail) {
      await deleteUserDocFromFirestore(previousEmail);
    }
    await syncUserDocToFirestore(target);

    if (req.session.user.id === target.id) req.session.user = publicUser(target);
    logAction(req, "user_update", { username: target.username, email: nextEmail });
    res.json({ success: true, user: publicUser(target), message: "تم تحديث المستخدم" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message || "تعذر تحديث المستخدم" });
  }
});

app.delete("/api/users/:id", requireAuth, requirePerm("canManageUsers"), async (req, res) => {
  try {
    const users = readUsers();
    const idx = users.findIndex(u => u.id === req.params.id);
    if (idx === -1) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });
    if (users[idx].username === "admin") {
      return res.status(400).json({ success: false, message: "لا يمكن حذف admin" });
    }

    const removed = users.splice(idx, 1)[0];
    writeUsers(users);

    if (removed.email) {
      await deleteFirebaseAuthUserByEmail(removed.email);
      await deleteUserDocFromFirestore(removed.email);
    }

    logAction(req, "user_delete", { username: removed.username, email: normalizeEmail(removed.email || "") });
    res.json({ success: true, message: "تم حذف المستخدم" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message || "تعذر حذف المستخدم" });
  }
});

app.get("/api/sheets/meta", requireAuth, requirePerm("canSearch"), (req, res) => {
  const workbook = readWorkbook();
  const sheetNames = getAllowedSheetNames(req.session.user, workbook);
  const meta = sheetNames.map(name => {
    const parsed = parseSheet(workbook, name);
    return {
      sheetName: name,
      headers: parsed.visibleHeaders,
      sensitiveHeaders: parsed.visibleHeaders.filter(isSensitiveHeader)
    };
  });
  res.json({ success: true, sheets: meta });
});

app.post("/api/search", requireAuth, requirePerm("canSearch"), (req, res) => {
  const body = req.body || {};
  const workbook = readWorkbook();
  const allowedSheets = getAllowedSheetNames(req.session.user, workbook);
  const requested = Array.isArray(body.sheetNames) && body.sheetNames.length ? body.sheetNames : allowedSheets;
  const sheetNames = requested.filter(name => allowedSheets.includes(name));
  const q = String(body.query || "");
  const filters = typeof body.filters === "object" && body.filters ? body.filters : {};
  const sortField = String(body.sortField || "");
  const sortDirection = String(body.sortDirection || "asc");
  const page = body.page || 1;
  const pageSize = body.pageSize || 20;

  let results = [];
  for (const sheetName of sheetNames) {
    const parsed = parseSheet(workbook, sheetName);
    const visibleHeaders = parsed.visibleHeaders;
    const records = parsed.records.filter(record => {
      const queryOk = !q || visibleHeaders.some(h => normalizeArabic(record[h]).includes(normalizeArabic(q)));
      const filtersOk = Object.entries(filters).every(([field, value]) => {
        const val = String(value || "").trim();
        if (!val) return true;
        return normalizeArabic(record[field]).includes(normalizeArabic(val));
      });
      return queryOk && filtersOk;
    }).map(record => ({
      sheetName,
      ...filterRecordForUser(req.session.user, record, visibleHeaders),
      __statusFlag: visibleHeaders.some(h => isStatusLike(record[h]))
    }));
    results = results.concat(records);
  }

  if (sortField) applySort(results, sortField, sortDirection);
  const paged = paginate(results, page, pageSize);

  logAction(req, "search", {
    query: q,
    filters,
    resultCount: paged.total,
    sheets: sheetNames
  });

  res.json({ success: true, ...paged });
});

app.post("/api/records", requireAuth, requirePerm("canAdd"), (req, res) => {
  const { sheetName, record } = req.body || {};
  const workbook = readWorkbook();
  if (!matchesSheetAccess(req.session.user, sheetName)) {
    return res.status(403).json({ success: false, message: "ليست لديك صلاحية على هذا الشيت" });
  }
  const parsed = parseSheet(workbook, sheetName);
  const input = record || {};
  const newRecord = {};
  parsed.visibleHeaders.forEach(h => {
    newRecord[h] = formatCell(input[h]);
  });
  newRecord.__record_id = randomId("rec");
  newRecord.__created_by = req.session.user.username;
  newRecord.__created_at = nowIso();
  newRecord.__updated_by = req.session.user.username;
  newRecord.__updated_at = nowIso();

  if (!req.session.user.permissions?.canEditSensitive) {
    for (const h of parsed.visibleHeaders) {
      if (isSensitiveHeader(h) && input[h]) {
        return res.status(403).json({ success: false, message: `لا يمكنك إدخال قيمة في الحقل الحساس: ${h}` });
      }
    }
  }

  const dedupeField = parsed.visibleHeaders.find(h => normalizeArabic(h).includes("رقم الملف") || normalizeArabic(h).includes("رقم الهويه") || normalizeArabic(h).includes("رقم الهوية"));
  if (dedupeField) {
    const value = normalizeArabic(newRecord[dedupeField]);
    if (value && parsed.records.some(r => normalizeArabic(r[dedupeField]) === value)) {
      return res.status(400).json({ success: false, message: `يوجد سجل مكرر في الحقل ${dedupeField}` });
    }
  }

  parsed.records.push(newRecord);
  saveSheet(workbook, sheetName, parsed.visibleHeaders, parsed.records);
  logAction(req, "record_add", { sheetName, recordId: newRecord.__record_id });
  res.json({ success: true, message: "تمت إضافة السجل" });
});

app.put("/api/records/:sheetName/:recordId", requireAuth, (req, res) => {
  const workbook = readWorkbook();
  const sheetName = decodeURIComponent(req.params.sheetName);
  const recordId = req.params.recordId;
  if (!matchesSheetAccess(req.session.user, sheetName)) {
    return res.status(403).json({ success: false, message: "ليست لديك صلاحية على هذا الشيت" });
  }
  const parsed = parseSheet(workbook, sheetName);
  const idx = parsed.records.findIndex(r => r.__record_id === recordId);
  if (idx === -1) return res.status(404).json({ success: false, message: "السجل غير موجود" });

  const current = parsed.records[idx];
  if (!canEditThisRecord(req.session.user, current)) {
    return res.status(403).json({ success: false, message: "ليست لديك صلاحية تعديل هذا السجل" });
  }

  const updates = req.body?.record || {};
  const before = {};
  const after = {};
  parsed.visibleHeaders.forEach(h => {
    before[h] = current[h];
    if (updates[h] !== undefined) {
      if (isSensitiveHeader(h) && !req.session.user.permissions?.canEditSensitive) return;
      current[h] = formatCell(updates[h]);
    }
    after[h] = current[h];
  });
  current.__updated_by = req.session.user.username;
  current.__updated_at = nowIso();

  saveSheet(workbook, sheetName, parsed.visibleHeaders, parsed.records);
  logAction(req, "record_edit", { sheetName, recordId, before, after });
  res.json({ success: true, message: "تم تعديل السجل" });
});

app.delete("/api/records/:sheetName/:recordId", requireAuth, requirePerm("canArchive"), (req, res) => {
  const workbook = readWorkbook();
  const sheetName = decodeURIComponent(req.params.sheetName);
  const recordId = req.params.recordId;
  if (!matchesSheetAccess(req.session.user, sheetName)) {
    return res.status(403).json({ success: false, message: "ليست لديك صلاحية على هذا الشيت" });
  }
  const parsed = parseSheet(workbook, sheetName);
  const idx = parsed.records.findIndex(r => r.__record_id === recordId);
  if (idx === -1) return res.status(404).json({ success: false, message: "السجل غير موجود" });

  const [removed] = parsed.records.splice(idx, 1);
  saveSheet(workbook, sheetName, parsed.visibleHeaders, parsed.records);

  const archive = readArchive();
  archive.unshift({
    archiveId: randomId("arc"),
    originalSheet: sheetName,
    archivedAt: nowIso(),
    archivedBy: req.session.user.username,
    reason: String(req.body?.reason || "تمت الأرشفة"),
    record: removed,
    visibleHeaders: parsed.visibleHeaders
  });
  writeArchive(archive);

  logAction(req, "record_archive", { sheetName, recordId, reason: req.body?.reason || "" });
  res.json({ success: true, message: "تمت أرشفة السجل" });
});

app.get("/api/archive", requireAuth, requirePerm("canRestore"), (req, res) => {
  let archive = readArchive();
  if (!req.session.user.permissions?.canViewSensitive) {
    archive = archive.map(item => ({
      ...item,
      record: Object.fromEntries(Object.entries(item.record).filter(([k]) => INTERNAL_FIELDS.includes(k) || !isSensitiveHeader(k)))
    }));
  }
  res.json({ success: true, archive });
});

app.post("/api/archive/:archiveId/restore", requireAuth, requirePerm("canRestore"), (req, res) => {
  const archive = readArchive();
  const idx = archive.findIndex(a => a.archiveId === req.params.archiveId);
  if (idx === -1) return res.status(404).json({ success: false, message: "العنصر المؤرشف غير موجود" });

  const item = archive.splice(idx, 1)[0];
  const workbook = readWorkbook();
  const parsed = parseSheet(workbook, item.originalSheet);
  parsed.records.push(item.record);
  saveSheet(workbook, item.originalSheet, parsed.visibleHeaders, parsed.records);
  writeArchive(archive);
  logAction(req, "record_restore", { archiveId: item.archiveId, sheetName: item.originalSheet, recordId: item.record.__record_id });
  res.json({ success: true, message: "تم استرجاع السجل" });
});

app.get("/api/stats", requireAuth, requirePerm("canViewStats"), (req, res) => {
  const workbook = readWorkbook();
  const allowedSheets = getAllowedSheetNames(req.session.user, workbook);
  const cards = [];
  let total = 0;
  let missing = 0;
  let updates = 0;
  const bySheet = [];
  allowedSheets.forEach(name => {
    const parsed = parseSheet(workbook, name);
    total += parsed.records.length;
    const missingCount = parsed.records.filter(r => parsed.visibleHeaders.some(h => normalizeArabic(r[h]).includes("ناقص") || normalizeArabic(r[h]).includes("مطلوب"))).length;
    missing += missingCount;
    const recentUpdates = parsed.records.filter(r => {
      const dt = new Date(r.__updated_at);
      return (Date.now() - dt.getTime()) < 7 * 24 * 3600 * 1000;
    }).length;
    updates += recentUpdates;
    bySheet.push({ label: name, value: parsed.records.length, missing: missingCount });
  });

  cards.push({ label: "إجمالي السجلات", value: total });
  cards.push({ label: "سجلات ناقصة", value: missing });
  cards.push({ label: "تعديلات هذا الأسبوع", value: updates });
  cards.push({ label: "مستخدمون نشطون", value: readUsers().filter(u => u.active).length });

  res.json({ success: true, cards, charts: { bySheet } });
});

app.get("/api/logs", requireAuth, requirePerm("canViewLogs"), (req, res) => {
  const logs = readLogs();
  res.json({ success: true, logs: logs.slice(0, 500) });
});

app.get("/api/export/search", requireAuth, requirePerm("canExport"), (req, res) => {
  const logs = readLogs(); // touch just to ensure file exists
  const workbook = readWorkbook();
  const allowedSheets = getAllowedSheetNames(req.session.user, workbook);
  const q = String(req.query.q || "");
  const rows = [];
  allowedSheets.forEach(sheetName => {
    const parsed = parseSheet(workbook, sheetName);
    parsed.records.forEach(record => {
      const ok = !q || parsed.visibleHeaders.some(h => normalizeArabic(record[h]).includes(normalizeArabic(q)));
      if (ok) {
        const row = { الشيت: sheetName };
        parsed.visibleHeaders.forEach(h => {
          if (userCanSeeField(req.session.user, h)) row[h] = record[h];
        });
        rows.push(row);
      }
    });
  });
  const outWb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(outWb, ws, "نتائج البحث");
  const fileName = `search-export-${Date.now()}.xlsx`;
  const filePath = path.join(ROOT, fileName);
  XLSX.writeFile(outWb, filePath);
  logAction(req, "export_search", { query: q, count: rows.length });
  res.download(filePath, fileName, () => {
    try { fs.unlinkSync(filePath); } catch (e) {}
  });
});


app.get("/api/live-rates", requireAuth, async (req, res) => {
  try {
    const rates = await getLiveRates();
    const settings = getSettings();
    settings.rateUSD = Number(rates.USDILS || settings.rateUSD || 0);
    settings.rateJOD = Number(rates.JODILS || settings.rateJOD || 0);
    settings.rateUSDT = Number(rates.USDTILS || settings.rateUSDT || 0);
    if (settings.customCurrencyCode) {
      const key = `${String(settings.customCurrencyCode).trim().toUpperCase()}ILS`;
      if (rates[key]) settings.customCurrencyRate = Number(rates[key]);
    }
    res.json({ success: true, rates, settings });
  } catch (e) {
    res.status(500).json({ success: false, message: "تعذر تحميل الأسعار الحية" });
  }
});

app.put("/api/settings", requireAuth, requirePerm("canManageSettings"), (req, res) => {
  const current = getSettings();
  const next = { ...current, ...(req.body || {}) };
  writeJson(SETTINGS_FILE, next);
  logAction(req, "settings_update", { keys: Object.keys(req.body || {}) });
  res.json({ success: true, settings: next, message: "تم حفظ الإعدادات" });
});

app.get("*", (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});


app.post("/api/users/:id/sync-firebase", requireAuth, requirePerm("canManageUsers"), async (req, res) => {
  try {
    const users = readUsers();
    const target = users.find(u => u.id === req.params.id);
    if (!target) return res.status(404).json({ success: false, message: "المستخدم غير موجود" });
    if (!target.email) return res.status(400).json({ success: false, message: "لا يوجد بريد إلكتروني للمستخدم" });

    await updateFirebaseAuthUserByEmail(target.email, {
      email: target.email,
      displayName: target.displayName || target.username,
      active: target.active,
      username: target.username
    });
    await syncUserDocToFirestore(target);

    logAction(req, "user_sync_firebase", { username: target.username, email: target.email });
    res.json({ success: true, message: "تمت مزامنة المستخدم مع Firebase" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message || "تعذر مزامنة المستخدم" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
