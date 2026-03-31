const state = {
  user: null,
  settings: null,
  sheets: [],
  sheetsMeta: [],
  allResults: [],
  renderedCount: 0,
  renderBatch: 8,
  currentView: "overview",
  currentViewMode: "cards",
  users: [],
  archive: [],
  logs: [],
  stats: null,
  cardPrefs: { density: "comfortable", highlightFields: [] },
  availableRoles: [],
  lastSearchPayload: null,
  observer: null,
  dragOrder: [],
  searchCache: new Map(),
  searchDebounce: null,
  liveRates: null,
  liveRatesTimer: null,
  pageAnimating: false
};

const $ = id => document.getElementById(id);

async function api(url, options = {}) {
  const opts = { credentials: "same-origin", headers: { "Content-Type": "application/json" }, ...options };
  if (opts.body && typeof opts.body !== "string") opts.body = JSON.stringify(opts.body);
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw new Error('فشل الاتصال بالخادم');
  }
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || data.success === false) throw new Error(data.message || "حدث خطأ غير متوقع");
  return data;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function escapeAttr(s){ return escapeHtml(s).replace(/"/g, "&quot;"); }
function inlinePayload(obj){ return encodeURIComponent(JSON.stringify(obj || {})); }
function attachmentFieldName(recordOrMeta){
  const keys = Array.isArray(recordOrMeta) ? recordOrMeta : Object.keys(recordOrMeta || {});
  return keys.find(k => ["الأوراق الثبوتيه","الأوراق الثبوتية","الاوراق الثبوتيه","الاوراق الثبوتية","مرفقات"].includes(String(k).trim())) || null;
}
function normalizeRecordId(record){
  return record?.__record_id || record?.__meta?.id || "";
}
function parseAttachments(value){
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return String(value).startsWith("data:") ? [{ name: "مرفق", type: "", dataUrl: value }] : [];
  }
}
function renderAttachmentPreview(items){
  const files = parseAttachments(items);
  if (!files.length) return '<div class="muted">لا توجد مرفقات</div>';
  return `<div class="attachments-grid">${files.map((file, idx) => {
    const isImage = String(file.type || '').startsWith('image/');
    const thumb = isImage ? `<img src="${escapeAttr(file.dataUrl)}" alt="${escapeAttr(file.name || 'file')}" class="attachment-thumb" />`
                          : `<div class="attachment-file"><i class="bi bi-paperclip"></i></div>`;
    return `<div class="attachment-item">
      ${thumb}
      <div class="attachment-name">${escapeHtml(file.name || `مرفق ${idx + 1}`)}</div>
      <div class="attachment-actions">
        <a class="btn ghost" href="${escapeAttr(file.dataUrl)}" download="${escapeAttr(file.name || 'attachment')}">تحميل</a>
        <button type="button" class="btn ghost danger mini" data-remove-attachment="${idx}">حذف</button>
      </div>
    </div>`;
  }).join("")}</div>`;
}
function toast(message, type = "info") {
  const el = $("toast");
  el.textContent = message;
  el.style.borderColor = type === "error" ? "rgba(255,109,122,.55)" : type === "success" ? "rgba(49,203,138,.55)" : "var(--border)";
  el.classList.add("show");
  clearTimeout(window.__toast);
  window.__toast = setTimeout(() => el.classList.remove("show"), 2600);
}
function openModal(id){ $(id).classList.add("open"); }
function closeModal(id){ $(id).classList.remove("open"); }
window.closeModal = closeModal;

function perm(name){ return !!state.user?.permissions?.[name]; }
function initials(name){ return String(name || "?").slice(0,1).toUpperCase(); }
function userStorageKey(suffix){ return `${state.user?.username || "guest"}:${suffix}`; }

function getUserThemeClass(){
  if (state.user?.role === "مدير نظام") return "theme-admin";
  return state.user?.gender === "female" ? "theme-female" : "theme-male";
}
function setTheme(theme){
  document.body.classList.toggle("light", theme === "light");
  document.body.classList.toggle("dark", theme !== "light");
  localStorage.setItem("ui-theme", theme);
  document.body.classList.remove("theme-admin","theme-male","theme-female");
  document.body.classList.add(getUserThemeClass());
  $("themeToggle").textContent = theme === "light" ? "الوضع الداكن" : "الوضع الفاتح";
}
function applySettings(){
  document.title = state.settings?.systemName || "نظام إدارة بيانات الأيتام";
  const theme = localStorage.getItem("ui-theme") || state.settings?.themeDefault || "light";
  setTheme(theme);
}

function animateEntrance(){
  if (!window.gsap) return;
  gsap.fromTo(".login-card", { y: 24, opacity: 0, scale: 0.985 }, { y: 0, opacity: 1, scale: 1, duration: 0.65, ease: "power3.out" });
}
function animateAppReveal(){
  if (!window.gsap) return;
  gsap.fromTo([".sidebar", ".topbar", ".view:not(.hidden) .panel", ".view:not(.hidden) .widget", ".view:not(.hidden) .mini-stat"],
    { y: 18, opacity: 0 },
    { y: 0, opacity: 1, duration: 0.5, ease: "power3.out", stagger: 0.05 });
}
function animateViewEnter(view){
  const el = $(`view-${view}`);
  if (!el) return;
  el.classList.remove("view-enter");
  void el.offsetWidth;
  el.classList.add("view-enter");
  if (window.gsap) {
    gsap.fromTo(el.querySelectorAll(".panel, .widget, .record-card, .mini-stat, .log-item, .archive-card, .user-card"),
      { y: 16, opacity: 0 },
      { y: 0, opacity: 1, duration: 0.38, ease: "power3.out", stagger: 0.03 });
  }
}
function formatRateValue(value){
  const num = Number(value || 0);
  return Number.isFinite(num) ? num.toFixed(3).replace(/0+$/,'').replace(/\.$/,'') : "0";
}
function getCurrencySnapshot(){
  const settings = state.settings || {};
  const live = state.liveRates || {};
  const currencies = [
    { id: "usd", title: "الدولار", value: live.USDILS ?? settings.rateUSD ?? 3.65, sub: "USD / ILS", icon: "bi bi-currency-dollar", live: !!live.USDILS },
    { id: "jod", title: "الدينار الأردني", value: live.JODILS ?? settings.rateJOD ?? 5.14, sub: "JOD / ILS", icon: "bi bi-currency-exchange", live: !!live.JODILS },
    { id: "usdt", title: "USDT", value: live.USDTILS ?? settings.rateUSDT ?? 3.65, sub: "USDT / ILS", icon: "bi bi-cash-coin", live: !!live.USDTILS }
  ];
  if (settings.customCurrencyName && (settings.customCurrencyCode || settings.customCurrencyRate)) {
    const customCode = (settings.customCurrencyCode || "").toUpperCase();
    const customLive = customCode ? live[`${customCode}ILS`] : null;
    currencies.push({
      id: "custom",
      title: settings.customCurrencyName,
      value: customLive ?? settings.customCurrencyRate ?? 0,
      sub: (customCode || "—") + " / ILS",
      icon: settings.customCurrencyIcon || "bi bi-plus-circle",
      live: !!customLive
    });
  }
  return currencies;
}
async function refreshLiveRates(silent = false){
  try {
    const data = await api("/api/live-rates");
    state.liveRates = data.rates || null;
    if (data.settings) {
      state.settings = { ...state.settings, ...data.settings };
    }
    if (state.currentView === "overview") renderOverview();
  } catch (e) {
    if (!silent) console.warn(e);
  }
}
function startLiveRates(){
  stopLiveRates();
  refreshLiveRates(true);
  state.liveRatesTimer = setInterval(() => refreshLiveRates(true), 1000);
}
function stopLiveRates(){
  if (state.liveRatesTimer) clearInterval(state.liveRatesTimer);
  state.liveRatesTimer = null;
}


function isSidebarPinned(){
  return localStorage.getItem("sidebar-pinned") === "1";
}
function setSidebarOpen(open){
  const shouldOpen = window.innerWidth > 900 && !!open;
  document.body.classList.toggle("sidebar-open", shouldOpen);
}
function updateSidebarButton(){
  const btn = $("sidebarPinBtn");
  if (!btn) return;
  const pinned = isSidebarPinned();
  btn.classList.toggle("active", pinned);
  btn.setAttribute("aria-pressed", pinned ? "true" : "false");
  btn.title = pinned ? "إلغاء تثبيت القائمة" : "تثبيت القائمة";
}
function applySidebarState(forceOpen = null){
  const pinned = isSidebarPinned();
  document.body.classList.toggle("sidebar-pinned", pinned);
  if (window.innerWidth <= 900) {
    document.body.classList.remove("sidebar-open");
    document.body.classList.remove("sidebar-pinned");
  } else {
    setSidebarOpen(forceOpen === null ? pinned : forceOpen || pinned);
  }
  updateSidebarButton();
}
function toggleSidebarPin(event){
  event?.preventDefault?.();
  event?.stopPropagation?.();
  const pinned = !isSidebarPinned();
  localStorage.setItem("sidebar-pinned", pinned ? "1" : "0");
  applySidebarState(pinned);
}

function updateUserHeader(){
  $("userDisplay").textContent = state.user?.displayName || state.user?.username || "";
  const genderLabel = state.user?.role === "مدير نظام" ? "" : (state.user?.gender === "female" ? " • أنثى" : " • ذكر");
  document.body.classList.remove('theme-admin','theme-male','theme-female');
  document.body.classList.add(getUserThemeClass());
  $("userRole").textContent = `${state.user?.role || ""}${genderLabel}`;
  $("avatarText").textContent = initials(state.user?.displayName || state.user?.username);
  $("welcomeTitle").textContent = `مرحبًا، ${state.user?.displayName || state.user?.username}`;
}
function showSection(view){
  state.currentView = view;
  document.body.classList.add("route-animating");
  document.querySelectorAll(".view").forEach(el => el.classList.add("hidden"));
  $(`view-${view}`)?.classList.remove("hidden");
  animateViewEnter(view);
  setTimeout(() => document.body.classList.remove("route-animating"), 420);
  document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.toggle("active", btn.dataset.view === view));
}
function setupPermissionsUI(){
  $("navUsers").classList.toggle("hidden", !perm("canManageUsers"));
  $("navStats").classList.toggle("hidden", !perm("canViewStats"));
  $("navArchive").classList.toggle("hidden", !perm("canRestore"));
  $("navLogs").classList.toggle("hidden", !perm("canViewLogs"));
  $("navSettings").classList.toggle("hidden", !perm("canManageSettings"));
  $("addRecordBtn").classList.toggle("hidden", !perm("canAdd"));
  $("exportExcelBtn").classList.toggle("hidden", !perm("canExport"));
}
function getCardPrefs(){
  try {
    state.cardPrefs = JSON.parse(localStorage.getItem(userStorageKey("cardPrefs"))) || state.cardPrefs;
  } catch (e) {}
}
function saveCardPrefs(){
  localStorage.setItem(userStorageKey("cardPrefs"), JSON.stringify(state.cardPrefs));
}

async function bootstrap(){
  const sess = await api("/api/session");
  const publicInfo = await api("/api/public-info");
  state.settings = publicInfo.settings || {};
  state.availableRoles = publicInfo.availableRoles || [];
  applySettings();

  if (!sess.authenticated) {
    $("loginScreen").classList.remove("hidden");
    $("dashboardWrap").classList.add("hidden");
    animateEntrance();
    return;
  }

  state.user = sess.user;
  getCardPrefs();

  const data = await api("/api/bootstrap");
  state.sheets = data.sheets || [];
  state.settings = data.settings || state.settings;
  applySettings();
  updateUserHeader();
  setupPermissionsUI();
  $("loginScreen").classList.add("hidden");
  $("dashboardWrap").classList.remove("hidden");

  await loadSheetsMeta();
  renderOverview();
  applySidebarState();
  startLiveRates();
  animateAppReveal();
  if (perm("canViewStats")) await loadStats();
}

async function login(){
  try{
    $("loginNotice").classList.add("hidden");
    sessionStorage.setItem("manual-login", "1");
    const data = await api("/api/login", { method: "POST", body: { username: $("loginUsername").value.trim(), password: $("loginPassword").value } });
    state.user = data.user;
    state.settings = data.settings || state.settings;
    $("loginPassword").value = "";
    $("loginUsername").value = "";
    await bootstrap();
    if (state.user.mustChangePassword) openModal("passwordModal");
    toast("تم تسجيل الدخول بنجاح", "success");
  }catch(e){
    sessionStorage.removeItem("manual-login");
    $("loginNotice").classList.remove("hidden");
    $("loginNotice").textContent = e.message;
    toast(e.message, "error");
  }
}
async function logout(){
  try{
    stopLiveRates();
    sessionStorage.removeItem("manual-login");
    await api("/api/logout", { method: "POST" });
    location.reload();
  }catch(e){ toast(e.message, "error"); }
}

async function loadSheetsMeta(){
  const data = await api("/api/sheets/meta");
  state.sheetsMeta = data.sheets || [];
  $("searchSheets").innerHTML = state.sheetsMeta.map(s => `<option selected value="${escapeAttr(s.sheetName)}">${escapeHtml(s.sheetName)}</option>`).join("");
  $("statsSheetFilter").innerHTML = `<option value="all">كل الشيتات</option>` + state.sheetsMeta.map(s => `<option value="${escapeAttr(s.sheetName)}">${escapeHtml(s.sheetName)}</option>`).join("");
  const union = [];
  state.sheetsMeta.forEach(s => s.headers.forEach(h => { if (!union.includes(h)) union.push(h); }));
  $("sortField").innerHTML = `<option value="">بدون ترتيب</option>` + union.map(h => `<option value="${escapeAttr(h)}">${escapeHtml(displayFieldName(h))}</option>`).join("");

  const preferred = ["الطفل","اسم الطفل","الكفيل ","اسم الكفيل","الوصي عليه","اسم الوصي","حالة اليتيم","مكان السكن","رقم الملف","رقم الهوية","رقم الجوال"];
  const filters = preferred.filter(h => union.includes(h)).slice(0,8);
  $("advancedFilters").innerHTML = filters.map(h => `
    <label class="field"><span>${escapeHtml(displayFieldName(h))}</span><input class="input adv-filter" data-field="${escapeAttr(h)}" placeholder="${escapeAttr(h)}" /></label>
  `).join("");

  if (!state.cardPrefs.highlightFields?.length) {
    state.cardPrefs.highlightFields = union.slice(0, 4);
    saveCardPrefs();
  }
  bindSearchFieldEffects();
}
function selectedSheets(){
  return Array.from($("searchSheets").selectedOptions).map(o => o.value);
}


function renderOverview(){
  const currencies = getCurrencySnapshot();

  const widgets = [
    { key:"sheets", span:"span-3", title:"الشيتات المتاحة", value: state.sheets.length, sub:"جميع الشيتات داخل ملف Excel", kind:"metric" },
    { key:"search", span:"span-3", title:"صلاحية البحث", value: perm("canSearch") ? "مفعلة" : "مقيدة", sub:"البيانات لا تظهر إلا بعد البحث", kind:"metric" },
    { key:"sensitive", span:"span-3", title:"الحقول الحساسة", value: perm("canViewSensitive") ? "مرئية" : "مخفية", sub:"يتحكم بها المدير لكل مستخدم", kind:"metric" },
    { key:"archive", span:"span-3", title:"الأرشفة والاسترجاع", value: perm("canRestore") ? "مفتوح" : "حسب الصلاحية", sub:"حذف منطقي مع سجل نشاط", kind:"metric" },
    { key:"currencies", span:"span-6", title:"العملات مقابل الشيكل", list: currencies, kind:"currencies" },
    { key:"cta", span:"span-6", title:"إجراءات سريعة", list:[
      "سحب وإفلات البطاقات لإعادة ترتيب لوحة البيانات",
      "تغيير الثيم تلقائيًا حسب نوع المستخدم",
      "إظهار بطاقات أكثر ذكاءً وأقل ازدحامًا",
      "حفظ ترتيب اللوحة لكل مستخدم"
    ], kind:"notes" }
  ];

  state.dragOrder = loadDashboardOrder(widgets.map(w => w.key), widgets);
  const ordered = state.dragOrder.map(key => widgets.find(w => w.key === key)).filter(Boolean);
  $("overviewCards").innerHTML = ordered.map(w => renderWidget(w)).join("");
}

function renderWidget(w){
  if (w.kind === "currencies") {
    const canManage = perm("canManageSettings");
    const hasCustom = !!(state.settings?.customCurrencyName && Number(state.settings?.customCurrencyRate || 0) > 0);
    return `
      <div class="widget ${w.span} currencies-widget" draggable="true" data-widget="${w.key}">
        <div class="widget-handle widget-title-row">
          <div class="widget-title">${escapeHtml(w.title)}</div>
          ${canManage ? `<button class="btn ghost" onclick="openCurrencyModal()">${hasCustom ? "تعديل العملة الإضافية" : "إضافة عملة جديدة"}</button>` : ``}
        </div>
        <div class="currency-grid">
          ${w.list.map(item => `
            <div class="currency-card">
              <div class="currency-head">
                <div class="currency-icon"><i class="${escapeAttr(item.icon || "bi bi-currency-exchange")}"></i></div>
                <div class="badge good">${escapeHtml(item.sub)}</div>
              </div>
              <div>
                <div class="currency-name">${escapeHtml(item.title)}</div>
                <div class="currency-sub">مقابل الشيكل</div>
              </div>
              <div class="currency-value-wrap">
                <div class="currency-value">${formatRateValue(item.value || 0)}</div>
                <div class="currency-live-note">
                  <span class="currency-pulse">${item.live ? "مباشر" : "محفوظ"}</span>
                </div>
              </div>
              ${item.id === "custom" && canManage ? `<button class="btn ghost" onclick="openCurrencyModal()">تعديل</button>` : `<div class="currency-sub">${escapeHtml(item.sub)}</div>`}
            </div>
          `).join("")}
          ${canManage && !hasCustom ? `
            <button class="currency-card add-currency btn" type="button" onclick="openCurrencyModal()">
              <div class="currency-icon"><i class="bi bi-plus-lg"></i></div>
              <div class="currency-name">إضافة عملة</div>
              <div class="currency-sub">خصص الاسم والرمز والأيقونة والقيمة</div>
            </button>
          ` : ``}
        </div>
      </div>`;
  }
  if (w.kind === "notes") {
    return `
      <div class="widget ${w.span}" draggable="true" data-widget="${w.key}">
        <div class="widget-handle widget-title">${escapeHtml(w.title)}</div>
        <div class="widget-list">${w.list.map(x => `<div class="widget-line"><div style="font-weight:700">${escapeHtml(x)}</div></div>`).join("")}</div>
      </div>`;
  }
  return `
    <div class="widget ${w.span}" draggable="true" data-widget="${w.key}">
      <div class="widget-handle widget-title">${escapeHtml(w.title)}</div>
      <div class="widget-value">${escapeHtml(w.value)}</div>
      <div class="widget-sub">${escapeHtml(w.sub)}</div>
    </div>`;
}
function loadDashboardOrder(defaultOrder, widgets){
  try {
    const saved = JSON.parse(localStorage.getItem(userStorageKey("dash-order"))) || [];
    const valid = saved.filter(k => widgets.some(w => w.key === k));
    return [...valid, ...defaultOrder.filter(k => !valid.includes(k))];
  } catch (e) {
    return defaultOrder;
  }
}
function saveDashboardOrder(){
  localStorage.setItem(userStorageKey("dash-order"), JSON.stringify(state.dragOrder));
  toast("تم حفظ ترتيب لوحة البيانات", "success");
}
function initDashboardDrag(){
  const container = $("overviewCards");
  let dragEl = null;
  container.querySelectorAll(".widget").forEach(card => {
    card.addEventListener("dragstart", () => { dragEl = card; card.classList.add("dragging"); });
    card.addEventListener("dragend", () => { card.classList.remove("dragging"); dragEl = null; state.dragOrder = Array.from(container.children).map(el => el.dataset.widget); });
    card.addEventListener("dragover", e => {
      e.preventDefault();
      if (!dragEl || dragEl === card) return;
      const rect = card.getBoundingClientRect();
      const insertAfter = (e.clientY - rect.top) > rect.height / 2;
      container.insertBefore(dragEl, insertAfter ? card.nextSibling : card);
    });
  });
}

async function runSearch(page = 1){
  if (!perm("canSearch")) return toast("لا تملك صلاحية البحث", "error");
  const filters = {};
  document.querySelectorAll(".adv-filter").forEach(i => filters[i.dataset.field] = i.value.trim());
  const payload = {
    sheetNames: selectedSheets(),
    query: $("globalQuery").value.trim(),
    filters,
    sortField: $("sortField").value,
    sortDirection: $("sortDirection").value,
    page,
    pageSize: Number($("pageSize").value)
  };
  state.lastSearchPayload = payload;
  const cacheKey = JSON.stringify(payload);
  try{
    const started = performance.now();
    const data = state.searchCache.has(cacheKey)
      ? state.searchCache.get(cacheKey)
      : await api("/api/search", { method:"POST", body:payload });
    if (!state.searchCache.has(cacheKey)) {
      if (state.searchCache.size > 24) state.searchCache.delete(state.searchCache.keys().next().value);
      state.searchCache.set(cacheKey, data);
    }
    const took = Math.round(performance.now() - started);
    state.allResults = data.items || [];
    state.renderedCount = 0;
    $("resultCount").textContent = data.total || 0;
    $("summaryMode").textContent = state.currentViewMode === "cards" ? "بطاقات" : "جدول";
    $("pagingText").textContent = data.total ? `الصفحة ${data.page} من ${Math.max(1, Math.ceil(data.total / data.pageSize))} — إجمالي ${data.total}` : "لا توجد نتائج";
    $("resultMeta").textContent = `زمن التنفيذ التقريبي ${took}ms${state.searchCache.has(cacheKey) ? " • محسّن" : ""}`;
    renderSearchSummary();
    resetLazyRender();
    showSection("search");
  }catch(e){ toast(e.message,"error"); }
}
function renderSearchSummary(){
  const important = state.allResults.filter(r => r.__statusFlag).length;
  const bySheet = new Set(state.allResults.map(r => r.sheetName)).size;
  $("summaryImportant").textContent = important;
  $("summarySheets").textContent = bySheet;
}
function displayFieldName(name){
  return state.settings?.fieldAliases?.[name] || name;
}
function getVisibleKeys(record){
  return Object.keys(record).filter(k => !k.startsWith("__") && k !== "sheetName");
}
function preferredKeys(record){
  const keys = getVisibleKeys(record);
  const chosen = state.cardPrefs.highlightFields.filter(k => keys.includes(k));
  if (chosen.length) return [...new Set([...chosen, ...keys.filter(k => !chosen.includes(k))])];
  return keys;
}
function renderRecordCard(record){
  const density = state.cardPrefs.density || "comfortable";
  const keys = preferredKeys(record);
  const mainKeys = density === "compact" ? keys.slice(0, 6) : density === "comfortable" ? keys.slice(0, 10) : keys;
  const extraKeys = density === "detailed" ? [] : keys.slice(mainKeys.length);
  const title = record["الطفل"] || record["اسم الطفل"] || record["الاسم"] || record["اسم اليتيم"] || "سجل";
  const statusBadge = record.__statusFlag ? `<span class="badge warn">يتطلب مراجعة</span>` : `<span class="badge good">${escapeHtml(record.sheetName || "سجل")}</span>`;
  return `
    <article class="record-card ${record.__statusFlag ? "important" : ""} ${density}">
      <div class="card-head">
        <div>
          <div class="card-title">${escapeHtml(title)}</div>
          <div class="muted">${escapeHtml(record.sheetName || "")}</div>
        </div>
        ${statusBadge}
      </div>
      <div class="kv-grid">
        ${mainKeys.map(k => `<div class="kv"><div class="k">${escapeHtml(displayFieldName(k))}</div><div class="v">${escapeHtml(record[k]) || "—"}</div></div>`).join("")}
      </div>
      ${extraKeys.length ? `<details><summary class="btn ghost">عرض باقي البيانات (${extraKeys.length})</summary><div class="kv-grid" style="margin-top:12px">${extraKeys.map(k => `<div class="kv"><div class="k">${escapeHtml(displayFieldName(k))}</div><div class="v">${escapeHtml(record[k]) || "—"}</div></div>`).join("")}</div></details>` : ""}
      <div class="card-actions">
        <button class="btn ghost" onclick="showDetails('${inlinePayload(record)}')">عرض كامل</button>
        ${(perm("canEdit") || perm("canEditOwnOnly")) ? `<button class="btn ghost" onclick="openEditRecord('${inlinePayload(record)}')">تعديل</button>` : ""}
        ${perm("canArchive") ? `<button class="btn ghost" onclick="archiveRecord('${inlinePayload({sheetName:record.sheetName, id:normalizeRecordId(record)})}')">أرشفة</button>` : ""}
      </div>
    </article>`;
}
function renderTable(rows){
  const union = [];
  rows.forEach(r => getVisibleKeys(r).forEach(k => { if (!union.includes(k)) union.push(k); }));
  const cols = union.slice(0, 10);
  return `<div class="table-wrap"><table><thead><tr><th>الشيت</th>${cols.map(c => `<th>${escapeHtml(displayFieldName(c))}</th>`).join("")}<th>إجراءات</th></tr></thead><tbody>
    ${rows.map(r => `<tr><td>${escapeHtml(r.sheetName)}</td>${cols.map(c => `<td>${escapeHtml(r[c] || "—")}</td>`).join("")}
      <td>
        <div class="card-actions">
          <button class="btn ghost" onclick="showDetails('${inlinePayload(r)}')">عرض</button>
          ${(perm("canEdit") || perm("canEditOwnOnly")) ? `<button class="btn ghost" onclick="openEditRecord('${inlinePayload(r)}')">تعديل</button>` : ""}
        </div>
      </td></tr>`).join("")}
  </tbody></table></div>`;
}
function resetLazyRender(){
  const area = $("resultsArea");
  area.innerHTML = "";
  $("resultsSentinel").classList.toggle("hidden", state.currentViewMode !== "cards");
  if (!state.allResults.length) {
    area.innerHTML = `<div class="empty">لا توجد نتائج مطابقة. البيانات لا تظهر إلا بعد تنفيذ بحث فعلي.</div>`;
    $("resultsSentinel").classList.add("hidden");
    return;
  }
  if (state.currentViewMode === "table") {
    area.innerHTML = renderTable(state.allResults);
    $("resultsSentinel").classList.add("hidden");
    return;
  }
  area.innerHTML = `<div class="cards-view" id="cardsContainer"></div>`;
  renderNextBatch();
  initLazyObserver();
}
function renderNextBatch(){
  const container = $("cardsContainer");
  if (!container) return;
  const next = state.allResults.slice(state.renderedCount, state.renderedCount + state.renderBatch);
  container.insertAdjacentHTML("beforeend", next.map(renderRecordCard).join(""));
  state.renderedCount += next.length;
  if (state.renderedCount >= state.allResults.length) $("resultsSentinel").classList.add("hidden");
}
function initLazyObserver(){
  if (state.observer) state.observer.disconnect();
  if (state.currentViewMode !== "cards" || state.renderedCount >= state.allResults.length) return;
  state.observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting && state.renderedCount < state.allResults.length) {
        renderNextBatch();
        if (state.renderedCount >= state.allResults.length) state.observer.disconnect();
      }
    });
  }, { rootMargin: "140px" });
  state.observer.observe($("resultsSentinel"));
}

function decodedJson(encoded){ return JSON.parse(decodeURIComponent(encoded)); }
window.showDetails = function(encoded){
  const record = decodedJson(encoded);
  const attachmentField = attachmentFieldName(record);
  const keys = getVisibleKeys(record).filter(k => k !== attachmentField);
  const attachments = attachmentField ? parseAttachments(record[attachmentField]) : [];
  $("detailsBody").innerHTML = `
    <div class="kv-grid">${keys.map(k => `<div class="kv"><div class="k">${escapeHtml(displayFieldName(k))}</div><div class="v">${escapeHtml(record[k]) || "—"}</div></div>`).join("")}</div>
    ${attachmentField ? `<div class="panel-head" style="margin-top:16px"><h4>مرفقات</h4></div><div class="attachments-wrap">${renderAttachmentPreview(attachments)}</div>` : ``}
  `;
  openModal("detailsModal");
};

function collectRecordFormValues(container){
  const out = {};
  container.querySelectorAll("[data-field]").forEach(el => out[el.dataset.field] = el.value);
  return out;
}
function bindAttachmentInputs(container){
  container.querySelectorAll(".attachment-picker").forEach(input => {
    if (input.dataset.bound === "1") return;
    input.dataset.bound = "1";
    input.addEventListener("change", async (event) => {
      const field = event.target.dataset.attachmentInput;
      const hidden = container.querySelector(`[data-field="${field}"]`);
      const preview = container.querySelector(`[data-attachment-preview="${field}"]`);
      const current = parseAttachments(hidden.value);
      const files = Array.from(event.target.files || []);
      const converted = await Promise.all(files.map(file => new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, type: file.type, dataUrl: reader.result });
        reader.readAsDataURL(file);
      })));
      const next = current.concat(converted);
      hidden.value = JSON.stringify(next);
      preview.innerHTML = renderAttachmentPreview(next);
      bindAttachmentRemoveButtons(container, field);
      event.target.value = "";
    });
    bindAttachmentRemoveButtons(container, input.dataset.attachmentInput);
  });
}
function bindAttachmentRemoveButtons(container, field){
  const hidden = container.querySelector(`[data-field="${field}"]`);
  const preview = container.querySelector(`[data-attachment-preview="${field}"]`);
  preview?.querySelectorAll("[data-remove-attachment]").forEach(btn => {
    btn.onclick = () => {
      const items = parseAttachments(hidden.value);
      items.splice(Number(btn.dataset.removeAttachment), 1);
      hidden.value = JSON.stringify(items);
      preview.innerHTML = renderAttachmentPreview(items);
      bindAttachmentRemoveButtons(container, field);
    };
  });
}
function recordFormHtml(sheetName, values = {}, title = "إضافة سجل"){
  const meta = state.sheetsMeta.find(s => s.sheetName === sheetName);
  const headers = meta?.headers || [];
  return `
    <div class="form-grid">
      <label class="field"><span>الشيت</span>
        <select id="recordSheetName" class="select" ${values.__record_id ? "disabled" : ""}>
          ${state.sheets.map(s => `<option value="${escapeAttr(s)}" ${s===sheetName ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}
        </select>
      </label>
      <div class="settings-grid">
        ${headers.map(h => {
          const isAttachment = ["الأوراق الثبوتيه","الأوراق الثبوتية","الاوراق الثبوتيه","الاوراق الثبوتية","مرفقات"].includes(String(h).trim());
          if (isAttachment) {
            const attachments = parseAttachments(values[h]);
            return `<div class="field field-attachments">
              <span>مرفقات</span>
              <input type="hidden" data-field="${escapeAttr(h)}" value="${escapeAttr(JSON.stringify(attachments))}" />
              <input class="input attachment-picker" type="file" data-attachment-input="${escapeAttr(h)}" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx,.txt" />
              <div class="attachments-wrap" data-attachment-preview="${escapeAttr(h)}">${renderAttachmentPreview(attachments)}</div>
            </div>`;
          }
          return `<label class="field"><span>${escapeHtml(displayFieldName(h))}</span><input class="input" data-field="${escapeAttr(h)}" value="${escapeAttr(values[h] || "")}" /></label>`;
        }).join("")}
      </div>
      <div class="toolbar-row"><button id="saveRecordActionBtn" class="btn primary">${escapeHtml(title)}</button></div>
    </div>`;
}
function openAddRecordModal(){
  const firstSheet = selectedSheets()[0] || state.sheets[0];
  $("recordModalTitle").textContent = "إضافة سجل";
  $("recordFormBody").innerHTML = recordFormHtml(firstSheet, {}, "حفظ السجل");
  $("recordSheetName").addEventListener("change", e => {
    $("recordFormBody").innerHTML = recordFormHtml(e.target.value, {}, "حفظ السجل");
    attachAddSaveHandler();
    bindAttachmentInputs($("recordFormBody"));
  });
  attachAddSaveHandler();
  bindAttachmentInputs($("recordFormBody"));
  openModal("recordModal");
}
function attachAddSaveHandler(){
  $("saveRecordActionBtn").onclick = async () => {
    try{
      const sheetName = $("recordSheetName").value;
      const record = collectRecordFormValues($("recordFormBody"));
      await api("/api/records", { method:"POST", body:{ sheetName, record } });
      closeModal("recordModal");
      toast("تمت إضافة السجل", "success");
      runSearch(1);
    }catch(e){ toast(e.message, "error"); }
  };
}
window.openEditRecord = function(encoded){
  const rec = decodedJson(encoded);
  $("recordModalTitle").textContent = "تعديل سجل";
  $("recordFormBody").innerHTML = recordFormHtml(rec.sheetName, rec, "حفظ التعديل");
  bindAttachmentInputs($("recordFormBody"));
  $("saveRecordActionBtn").onclick = async () => {
    try{
      const record = collectRecordFormValues($("recordFormBody"));
      await api(`/api/records/${encodeURIComponent(rec.sheetName)}/${encodeURIComponent(normalizeRecordId(rec))}`, { method:"PUT", body:{ record } });
      closeModal("recordModal");
      toast("تم تعديل السجل", "success");
      runSearch(1);
    }catch(e){ toast(e.message, "error"); }
  };
  openModal("recordModal");
};
window.archiveRecord = async function(encoded){
  const data = decodedJson(encoded);
  const reason = prompt("سبب الأرشفة", "أرشفة من الواجهة");
  if (reason === null) return;
  try{
    await api(`/api/records/${encodeURIComponent(data.sheetName)}/${encodeURIComponent(data.id)}`, { method:"DELETE", body:{ reason } });
    toast("تمت الأرشفة", "success");
    runSearch(1);
  }catch(e){ toast(e.message, "error"); }
};

async function loadUsers(){
  if (!perm("canManageUsers")) return;
  const data = await api("/api/users");
  state.users = data.users || [];
  $("usersArea").innerHTML = `<div class="user-grid">${state.users.map(u => `
    <article class="user-card">
      <div class="card-head">
        <div>
          <div class="card-title" style="font-size:22px">${escapeHtml(u.displayName || u.username)}</div>
          <div class="muted">${escapeHtml(u.username)}${u.email ? " • " + escapeHtml(u.email) : ""} • ${escapeHtml(u.role)}</div>
        </div>
        <span class="badge ${u.active ? "good" : "warn"}">${u.active ? "مفعل" : "معطل"}</span>
      </div>
      <div class="kv-grid">
        <div class="kv"><div class="k">الجنس</div><div class="v">${u.gender === "female" ? "أنثى" : "ذكر"}</div></div>
        <div class="kv"><div class="k">الشيتات</div><div class="v">${Array.isArray(u.sheetAccess) ? u.sheetAccess.join("، ") : "كل الشيتات"}</div></div>
      </div>
      <div class="card-actions">
        <button class="btn ghost" onclick="openUserModal('${inlinePayload(u)}')">تعديل</button>
        ${u.username !== "admin" ? `<button class="btn ghost" onclick="deleteUser('${inlinePayload({id:u.id})}')">حذف</button>` : ""}
      </div>
    </article>`).join("")}</div>`;
}
function permissionOptions(user){
  const keys = [
    "canSearch","canViewResults","canViewFullDetails","canAdd","canEdit","canEditOwnOnly","canArchive",
    "canRestore","canExport","canImport","canManageUsers","canManagePermissions","canViewStats",
    "canViewSensitive","canEditSensitive","canViewLogs","canManageSettings"
  ];
  const labels = {
    canSearch:"البحث", canViewResults:"عرض النتائج", canViewFullDetails:"عرض التفاصيل الكاملة", canAdd:"إضافة",
    canEdit:"تعديل", canEditOwnOnly:"تعديل ما أضافه فقط", canArchive:"أرشفة", canRestore:"استرجاع",
    canExport:"تصدير", canImport:"استيراد", canManageUsers:"إدارة المستخدمين", canManagePermissions:"تعديل الصلاحيات",
    canViewStats:"الإحصائيات", canViewSensitive:"رؤية الحقول الحساسة", canEditSensitive:"تعديل الحقول الحساسة",
    canViewLogs:"سجل النشاط", canManageSettings:"الإعدادات"
  };
  return `<div class="checkbox-grid">${keys.map(k => `
    <label class="check"><input class="perm-box" data-key="${k}" type="checkbox" ${user?.permissions?.[k] ? "checked" : ""} /> <span>${labels[k]}</span></label>
  `).join("")}</div>`;
}
window.openUserModal = function(encoded){
  const user = encoded ? decodedJson(encoded) : null;
  $("userModalTitle").textContent = user ? "تعديل مستخدم" : "إضافة مستخدم";
  $("userFormBody").innerHTML = `
    <div class="form-grid">
      <div class="settings-grid">
        <label class="field"><span>اسم المستخدم</span><input id="uUsername" class="input" value="${escapeAttr(user?.username || "")}" ${user ? "disabled" : ""} /></label>
        <label class="field"><span>البريد الإلكتروني (Firebase)</span><input id="uEmail" class="input" type="email" value="${escapeAttr(user?.email || "")}" placeholder="user@example.com" /></label>
        <label class="field"><span>الاسم المعروض</span><input id="uDisplayName" class="input" value="${escapeAttr(user?.displayName || "")}" /></label>
        <label class="field"><span>كلمة المرور الجديدة</span><input id="uPassword" class="input" type="password" placeholder="${user ? "اتركها فارغة دون تغيير" : ""}" /></label>
        <label class="field"><span>الدور</span>
          <select id="uRole" class="select">
            ${state.availableRoles.map(r => `<option value="${escapeAttr(r)}" ${r===user?.role ? "selected" : ""}>${escapeHtml(r)}</option>`).join("")}
          </select>
        </label>
        <label class="field"><span>الجنس</span>
          <select id="uGender" class="select">
            <option value="male" ${(user?.gender || "male")==="male" ? "selected" : ""}>ذكر</option>
            <option value="female" ${user?.gender==="female" ? "selected" : ""}>أنثى</option>
          </select>
        </label>
        <label class="check"><input id="uActive" type="checkbox" ${user?.active !== false ? "checked" : ""} /> <span>الحساب مفعل</span></label>
        <label class="field"><span>الشيتات المسموح بها</span>
          <select id="uSheets" class="select" multiple size="6">
            <option value="*" ${user?.sheetAccess==="*" ? "selected" : ""}>كل الشيتات</option>
            ${state.sheets.map(s => `<option value="${escapeAttr(s)}" ${user?.sheetAccess!=="*" && (user?.sheetAccess || []).includes(s) ? "selected" : ""}>${escapeHtml(s)}</option>`).join("")}
          </select>
        </label>
        <label class="check"><input id="uHideSensitive" type="checkbox" ${user?.fieldRules?.hideSensitive !== false ? "checked" : ""} /> <span>إخفاء الحقول الحساسة</span></label>
        <label class="field"><span>حقول مخفية إضافية (مفصولة بفواصل)</span><input id="uHiddenFields" class="input" value="${escapeAttr((user?.fieldRules?.hiddenFields || []).join(","))}" /></label>
      </div>
      <div><div class="muted" style="margin-bottom:10px">الصلاحيات</div>${permissionOptions(user || {})}</div>
      <div class="toolbar-row"><button id="saveUserBtn" class="btn primary">حفظ المستخدم</button></div>
    </div>`;
  $("saveUserBtn").onclick = async () => {
    const permissions = {};
    document.querySelectorAll(".perm-box").forEach(box => permissions[box.dataset.key] = box.checked);
    const selected = Array.from($("uSheets").selectedOptions).map(o => o.value);
    const body = {
      username: $("uUsername").value.trim(),
      email: $("uEmail").value.trim(),
      displayName: $("uDisplayName").value.trim(),
      password: $("uPassword").value,
      role: $("uRole").value,
      gender: $("uGender").value,
      active: $("uActive").checked,
      sheetAccess: selected.includes("*") ? "*" : selected,
      fieldRules: {
        hideSensitive: $("uHideSensitive").checked,
        hiddenFields: $("uHiddenFields").value.split(",").map(s => s.trim()).filter(Boolean)
      },
      permissions
    };
    try{
      if (user) await api(`/api/users/${encodeURIComponent(user.id)}`, { method:"PUT", body });
      else await api("/api/users", { method:"POST", body });
      closeModal("userModal");
      toast("تم حفظ المستخدم", "success");
      loadUsers();
    }catch(e){ toast(e.message, "error"); }
  };
  openModal("userModal");
};
window.deleteUser = async function(encoded){
  const { id } = decodedJson(encoded);
  if (!confirm("حذف المستخدم؟")) return;
  try{
    await api(`/api/users/${encodeURIComponent(id)}`, { method:"DELETE" });
    toast("تم حذف المستخدم", "success");
    loadUsers();
  }catch(e){ toast(e.message, "error"); }
};

async function loadArchive(){
  if (!perm("canRestore")) return;
  const data = await api("/api/archive");
  state.archive = data.archive || [];
  $("archiveArea").innerHTML = state.archive.length ? `<div class="cards-view">${state.archive.map(item => `
    <article class="record-card">
      <div class="card-head">
        <div><div class="card-title">${escapeHtml(item.record["الطفل"] || item.record["اسم الطفل"] || item.record.__record_id)}</div><div class="muted">${escapeHtml(item.originalSheet)}</div></div>
        <span class="badge">${escapeHtml(item.archivedBy)}</span>
      </div>
      <div class="kv-grid">
        <div class="kv"><div class="k">سبب الأرشفة</div><div class="v">${escapeHtml(item.reason || "—")}</div></div>
        <div class="kv"><div class="k">التاريخ</div><div class="v">${new Date(item.archivedAt).toLocaleString("ar-EG")}</div></div>
      </div>
      <div class="card-actions"><button class="btn success" onclick='restoreArchive(${encodeURIComponent(JSON.stringify({id:item.archiveId}))})'>استرجاع</button></div>
    </article>`).join("")}</div>` : `<div class="empty">لا توجد عناصر مؤرشفة</div>`;
}
window.restoreArchive = async function(encoded){
  const { id } = decodedJson(encoded);
  try{
    await api(`/api/archive/${encodeURIComponent(id)}/restore`, { method:"POST" });
    toast("تم الاسترجاع", "success");
    loadArchive();
  }catch(e){ toast(e.message, "error"); }
};

async function loadStats(){
  if (!perm("canViewStats")) return;
  const data = await api("/api/stats");
  state.stats = data;
  renderStats();
}
function renderStats(){
  const filter = $("statsSheetFilter").value || "all";
  const bySheet = [...(state.stats?.charts?.bySheet || [])];
  const rows = filter === "all" ? bySheet : bySheet.filter(x => x.label === filter);
  const total = rows.reduce((a,b) => a + Number(b.value || 0), 0);
  const missing = rows.reduce((a,b) => a + Number(b.missing || 0), 0);
  const max = Math.max(1, ...rows.map(x => Number(x.value || 0)));
  $("statsCards").innerHTML = [
    statBox("عدد الشيتات المختارة", rows.length),
    statBox("عدد السجلات", total),
    statBox("السجلات الناقصة", missing),
    statBox("معدل النقص", total ? Math.round((missing/total)*100) + "%" : "0%")
  ].join("");
  $("statsChartArea").innerHTML = rows.length ? rows.map(row => `
    <div class="chart-row">
      <div class="card-head">
        <div style="font-weight:800">${escapeHtml(row.label)}</div>
        <div class="muted">${row.value} سجل</div>
      </div>
      <div class="bar"><span style="width:${(Number(row.value || 0)/max)*100}%"></span></div>
      <div class="muted">سجلات ناقصة: ${row.missing || 0}</div>
    </div>
  `).join("") : `<div class="empty">لا توجد بيانات لهذا الفلتر</div>`;
}
function statBox(label, value){
  return `<div class="stat-box"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}
function normalizeForDup(value){
  return String(value || "").trim().toLowerCase().replace(/[\u064B-\u065F\u0670]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ؤ/g, "و").replace(/ئ/g, "ي").replace(/ة/g, "ه").replace(/\s+/g, " ");
}
async function fetchAllSearchRowsForReview(){
  const rows = [];
  for (const sheet of state.sheets) {
    let page = 1;
    while (true) {
      const data = await api("/api/search", { method:"POST", body:{ sheetNames:[sheet], query:"", filters:{}, page, pageSize:200 } });
      const items = data.items || [];
      rows.push(...items);
      if (items.length < 200) break;
      page += 1;
      if (page > 100) break;
    }
  }
  return rows;
}
function buildDuplicateGroups(rows){
  const buckets = new Map();
  rows.forEach(row => {
    const name = normalizeForDup(row["الطفل"] || row["اسم الطفل"] || row["الاسم"] || row["اسم اليتيم"] || "");
    const idNo = normalizeForDup(row["رقم الهوية"] || row["رقم الهويه"] || "");
    const mobile = normalizeForDup(row["رقم الجوال"] || row["الجوال"] || row["الهاتف"] || "");
    const keys = [];
    if (name) keys.push(`name:${name}`);
    if (idNo) keys.push(`id:${idNo}`);
    if (mobile) keys.push(`mobile:${mobile}`);
    keys.forEach(key => {
      const arr = buckets.get(key) || [];
      arr.push(row);
      buckets.set(key, arr);
    });
  });
  return [...buckets.entries()]
    .filter(([,items]) => items.length > 1)
    .sort((a,b) => b[1].length - a[1].length)
    .slice(0, 50);
}
async function reviewDuplicates(){
  try{
    $("duplicatesArea").innerHTML = `<div class="empty">جارٍ فحص التكرار...</div>`;
    const rows = await fetchAllSearchRowsForReview();
    const groups = buildDuplicateGroups(rows);
    $("duplicatesArea").innerHTML = groups.length ? groups.map(([key, items]) => `
      <div class="duplicate-group">
        <div class="card-head">
          <div class="card-title">مجموعة مشتبه بتكرارها</div>
          <span class="badge warn">${items.length} سجلات</span>
        </div>
        <div class="muted" style="margin-bottom:10px">${escapeHtml(key)}</div>
        <div class="kv-grid">
          ${items.map(item => `<div class="kv"><div class="k">${escapeHtml(item["الطفل"] || item["اسم الطفل"] || item["الاسم"] || "سجل")}</div><div class="v">${escapeHtml(item.sheetName || "")}${item["رقم الهوية"] ? ` • ${escapeHtml(item["رقم الهوية"])}` : ""}<div class=\"card-actions inline-actions\" style=\"margin-top:8px\"><button class=\"btn ghost\" onclick=\"showDetails('${inlinePayload(item)}')\">عرض</button>${perm('canArchive') ? `<button class=\"btn ghost danger\" onclick=\"archiveRecord('${inlinePayload({sheetName:item.sheetName, id:normalizeRecordId(item)})}')\">حذف/أرشفة</button>` : ''}</div></div></div>`).join("")}
        </div>
      </div>
    `).join("") : `<div class="empty">لم يتم العثور على بيانات مكررة وفق معايير الاسم/الهوية/الجوال.</div>`;
  }catch(e){ $("duplicatesArea").innerHTML = `<div class="empty">${escapeHtml(e.message)}</div>`; }
}

async function loadLogs(){
  if (!perm("canViewLogs")) return;
  const data = await api("/api/logs");
  state.logs = data.logs || [];
  $("logsArea").innerHTML = state.logs.length ? `<div class="table-wrap"><table><thead><tr><th>الوقت</th><th>المستخدم</th><th>الإجراء</th><th>التفاصيل</th></tr></thead><tbody>
    ${state.logs.map(log => `<tr><td>${new Date(log.at).toLocaleString("ar-EG")}</td><td>${escapeHtml(log.username || "—")}</td><td>${escapeHtml(log.action || "—")}</td><td>${escapeHtml(JSON.stringify(log.details || {}))}</td></tr>`).join("")}
  </tbody></table></div>` : `<div class="empty">لا يوجد سجل نشاط</div>`;
}

function loadSettingsToForm(){
  const s = state.settings || {};
  $("settingSystemName").value = s.systemName || "نظام إدارة بيانات الأيتام";
  $("settingBrand").value = s.brand || "نظام إدارة بيانات الأيتام";
  $("settingSessionMinutes").value = s.sessionMinutes || 60;
  $("settingMaxAttempts").value = s.maxFailedAttempts || 5;
  $("settingLockMinutes").value = s.lockMinutes || 20;
  $("settingTheme").value = s.themeDefault || "dark";
  $("settingRateUSD").value = s.rateUSD ?? 3.65;
  $("settingRateJOD").value = s.rateJOD ?? 5.14;
  $("settingRateUSDT").value = s.rateUSDT ?? 3.65;
  $("settingCustomCurrencyName").value = s.customCurrencyName || "";
  $("settingCustomCurrencyCode").value = s.customCurrencyCode || "";
  $("settingCustomCurrencyIcon").value = s.customCurrencyIcon || "bi bi-currency-exchange";
  $("settingCustomCurrencyRate").value = s.customCurrencyRate ?? "";
  renderFieldAliasesEditor();
}
async function saveSettings(){
  try{
    const body = {
      systemName: $("settingSystemName").value.trim() || "نظام إدارة بيانات الأيتام",
      brand: $("settingBrand").value.trim() || "نظام إدارة بيانات الأيتام",
      sessionMinutes: Number($("settingSessionMinutes").value),
      maxFailedAttempts: Number($("settingMaxAttempts").value),
      lockMinutes: Number($("settingLockMinutes").value),
      themeDefault: $("settingTheme").value,
      rateUSD: Number($("settingRateUSD").value || 0),
      rateJOD: Number($("settingRateJOD").value || 0),
      rateUSDT: Number($("settingRateUSDT").value || 0),
      customCurrencyName: $("settingCustomCurrencyName").value.trim(),
      customCurrencyCode: $("settingCustomCurrencyCode").value.trim(),
      customCurrencyIcon: $("settingCustomCurrencyIcon").value.trim() || "bi bi-currency-exchange",
      customCurrencyRate: Number($("settingCustomCurrencyRate").value || 0)
    };
    const data = await api("/api/settings", { method:"PUT", body });
    state.settings = data.settings;
    applySettings();
    renderOverview();
    toast("تم حفظ الإعدادات", "success");
  }catch(e){ toast(e.message, "error"); }
}



function renderFieldAliasesEditor(){
  const union = [];
  state.sheetsMeta.forEach(s => s.headers.forEach(h => { if (!union.includes(h)) union.push(h); }));
  const aliases = state.settings?.fieldAliases || {};
  const area = $("fieldAliasesArea");
  if (!area) return;
  area.innerHTML = union.length ? `<div class="field-alias-grid">${union.map(h => `
    <label class="field">
      <span>${escapeHtml(h)}</span>
      <input class="input field-alias-input" data-original-field="${escapeAttr(h)}" value="${escapeAttr(aliases[h] || '')}" placeholder="اسم العرض البديل" />
    </label>`).join('')}</div>` : `<div class="empty">لا توجد أعمدة متاحة حاليًا.</div>`;
}
async function saveFieldAliases(){
  try{
    const aliases = {};
    document.querySelectorAll('.field-alias-input').forEach(input => {
      const value = input.value.trim();
      if (value) aliases[input.dataset.originalField] = value;
    });
    const data = await api('/api/settings', { method:'PUT', body:{ ...state.settings, fieldAliases: aliases } });
    state.settings = data.settings;
    renderFieldAliasesEditor();
    if (state.currentView === 'search') resetLazyRender();
    if (state.currentView === 'stats') renderStats();
    toast('تم حفظ أسماء العرض للحقول', 'success');
  }catch(e){ toast(e.message, 'error'); }
}

window.openCurrencyModal = function(){
  if (!perm("canManageSettings")) return toast("لا تملك صلاحية تعديل العملات", "error");
  const s = state.settings || {};
  $("modalCurrencyName").value = s.customCurrencyName || "";
  $("modalCurrencyCode").value = s.customCurrencyCode || "";
  $("modalCurrencyRate").value = s.customCurrencyRate ?? "";
  $("modalCurrencyIcon").value = s.customCurrencyIcon || "bi bi-currency-exchange";
  openModal("currencyModal");
};

async function saveCurrencySettings(){
  try{
    if (!perm("canManageSettings")) return toast("لا تملك صلاحية تعديل العملات", "error");
    const body = {
      ...state.settings,
      customCurrencyName: $("modalCurrencyName").value.trim(),
      customCurrencyCode: $("modalCurrencyCode").value.trim().toUpperCase(),
      customCurrencyRate: Number($("modalCurrencyRate").value || 0),
      customCurrencyIcon: $("modalCurrencyIcon").value.trim() || "bi bi-currency-exchange"
    };
    const data = await api("/api/settings", { method:"PUT", body });
    state.settings = data.settings;
    loadSettingsToForm();
    renderOverview();
    closeModal("currencyModal");
    toast("تم تحديث العملة الإضافية", "success");
  }catch(e){ toast(e.message, "error"); }
}

async function clearCurrencySettings(){
  try{
    if (!perm("canManageSettings")) return toast("لا تملك صلاحية تعديل العملات", "error");
    const body = {
      ...state.settings,
      customCurrencyName: "",
      customCurrencyCode: "",
      customCurrencyRate: 0,
      customCurrencyIcon: "bi bi-currency-exchange"
    };
    const data = await api("/api/settings", { method:"PUT", body });
    state.settings = data.settings;
    loadSettingsToForm();
    renderOverview();
    closeModal("currencyModal");
    toast("تمت إزالة العملة الإضافية", "success");
  }catch(e){ toast(e.message, "error"); }
}

async function exportExcel(){
  const q = encodeURIComponent($("globalQuery").value.trim());
  window.location = `/api/export/search?q=${q}`;
}
function exportPdfReport(){
  const rows = state.allResults || [];
  const title = state.settings?.systemName || "نظام إدارة بيانات الأيتام";
  const query = $("globalQuery").value.trim() || "—";
  const html = `
    <html dir="rtl" lang="ar">
      <head>
        <meta charset="utf-8" />
        <title>${title}</title>
        <style>
          body{font-family:Arial,sans-serif;padding:24px;color:#111}
          h1,h2{margin:0 0 10px}
          .meta{margin-bottom:16px;color:#555}
          .box{border:1px solid #ddd;border-radius:10px;padding:12px;margin-bottom:12px}
          .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
          .kv{border:1px solid #eee;border-radius:8px;padding:8px}
          .kv b{display:block;color:#555;margin-bottom:4px}
        </style>
      </head>
      <body class="report-window">
        <h1>${title}</h1>
        <div class="meta">تقرير PDF — ${new Date().toLocaleString("ar-EG")} — البحث: ${query} — عدد النتائج: ${rows.length}</div>
        ${rows.map((row, idx) => {
          const keys = getVisibleKeys(row);
          return `<div class="box"><h2>سجل ${idx + 1}: ${escapeHtml(row["الطفل"] || row["اسم الطفل"] || row["الاسم"] || "—")}</h2><div class="grid">${keys.map(k => `<div class="kv"><b>${escapeHtml(k)}</b>${escapeHtml(row[k] || "—")}</div>`).join("")}</div></div>`;
        }).join("")}
      </body>
    </html>`;
  const w = window.open("", "_blank");
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => w.print(), 350);
}
async function savePassword(){
  try{
    await api("/api/change-password", { method:"POST", body:{ currentPassword: $("currentPassword").value, newPassword: $("newPassword").value } });
    $("currentPassword").value = "";
    $("newPassword").value = "";
    closeModal("passwordModal");
    toast("تم تغيير كلمة المرور", "success");
  }catch(e){ toast(e.message, "error"); }
}

function openCardPrefsModal(){
  const union = [];
  state.sheetsMeta.forEach(s => s.headers.forEach(h => { if (!union.includes(h)) union.push(h); }));
  $("cardDensity").value = state.cardPrefs.density || "comfortable";
  $("cardFieldsPrefs").innerHTML = union.map(h => `
    <label class="check"><input type="checkbox" class="card-pref-box" value="${escapeAttr(h)}" ${state.cardPrefs.highlightFields.includes(h) ? "checked" : ""}/> <span>${escapeHtml(h)}</span></label>
  `).join("");
  openModal("cardPrefsModal");
}
function saveCardPrefsAction(){
  state.cardPrefs.density = $("cardDensity").value;
  state.cardPrefs.highlightFields = Array.from(document.querySelectorAll(".card-pref-box:checked")).map(x => x.value).slice(0, 8);
  saveCardPrefs();
  closeModal("cardPrefsModal");
  if (state.currentView === "search") resetLazyRender();
  toast("تم حفظ تخصيص الكروت", "success");
}

function bindSearchFieldEffects(){
  document.querySelectorAll(".search-grid .field, .advanced-grid .field").forEach(block => {
    if (block.dataset.bound === "1") return;
    block.dataset.bound = "1";
    block.addEventListener("focusin", (e) => {
      const field = e.target.closest(".field");
      if (field) field.classList.add("search-focus");
    });
    block.addEventListener("focusout", (e) => {
      const field = e.target.closest(".field");
      if (field) field.classList.remove("search-focus");
    });
  });
}

function initSidebarInteractions(){
  const sidebar = $("sidebar");
  if (!sidebar) return;

  const handleEnter = () => {
    if (!isSidebarPinned()) applySidebarState(true);
  };
  const handleLeave = () => {
    if (!isSidebarPinned()) applySidebarState(false);
  };

  sidebar.addEventListener("mouseenter", handleEnter);
  sidebar.addEventListener("mouseleave", handleLeave);
  sidebar.addEventListener("focusin", handleEnter);
  sidebar.addEventListener("focusout", (event) => {
    if (isSidebarPinned()) return;
    if (!sidebar.contains(event.relatedTarget)) handleLeave();
  });

  window.addEventListener("resize", () => applySidebarState());
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const sess = await api("/api/session");
    if (sess.authenticated && sessionStorage.getItem("manual-login") !== "1") {
      await api("/api/logout", { method: "POST" }).catch(() => {});
    }
  } catch (e) {}
  animateEntrance();
  $("loginBtn").addEventListener("click", login);
  $("loginPassword").addEventListener("keydown", e => { if (e.key === "Enter") login(); });
  $("logoutBtn").addEventListener("click", logout);
  $("themeToggle").addEventListener("click", () => setTheme(document.body.classList.contains("light") ? "dark" : "light"));
  $("changePasswordBtn").addEventListener("click", () => openModal("passwordModal"));
  $("sidebarPinBtn")?.addEventListener("click", toggleSidebarPin);
  initSidebarInteractions();
  $("savePasswordBtn").addEventListener("click", savePassword);
  $("runSearchBtn").addEventListener("click", () => runSearch(1));
  $("globalQuery").addEventListener("keydown", e => { if (e.key === "Enter") runSearch(1); });
  $("globalQuery").addEventListener("input", (() => {
    let t;
    return () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if ($("globalQuery").value.trim().length >= 3 && perm("canSearch")) runSearch(1);
      }, 450);
    };
  })());
  $("clearFiltersBtn").addEventListener("click", () => {
    $("globalQuery").value = "";
    document.querySelectorAll(".adv-filter").forEach(i => i.value = "");
    state.allResults = [];
    resetLazyRender();
  });
  $("viewCardsBtn").addEventListener("click", () => {
    state.currentViewMode = "cards";
    $("viewCardsBtn").classList.add("active");
    $("viewTableBtn").classList.remove("active");
    resetLazyRender();
    $("summaryMode").textContent = "بطاقات";
  });
  $("viewTableBtn").addEventListener("click", () => {
    state.currentViewMode = "table";
    $("viewTableBtn").classList.add("active");
    $("viewCardsBtn").classList.remove("active");
    resetLazyRender();
    $("summaryMode").textContent = "جدول";
  });
  $("addRecordBtn").addEventListener("click", openAddRecordModal);
  $("newUserBtn").addEventListener("click", () => openUserModal(null));
  $("statsSheetFilter").addEventListener("change", renderStats);
  $("reviewDuplicatesBtn")?.addEventListener("click", reviewDuplicates);
  $("saveSettingsBtn").addEventListener("click", saveSettings);
  $("saveFieldAliasesBtn")?.addEventListener("click", saveFieldAliases);
  $("saveCurrencyBtn").addEventListener("click", saveCurrencySettings);
  $("clearCurrencyBtn").addEventListener("click", clearCurrencySettings);
  $("exportExcelBtn").addEventListener("click", exportExcel);
  $("exportPdfBtn").addEventListener("click", exportPdfReport);
  $("customizeCardsBtn").addEventListener("click", openCardPrefsModal);
  $("saveCardPrefsBtn").addEventListener("click", saveCardPrefsAction);
  $("saveLayoutBtn").addEventListener("click", saveDashboardOrder);
  $("resetLayoutBtn").addEventListener("click", () => { localStorage.removeItem(userStorageKey("dash-order")); renderOverview(); toast("تمت إعادة الترتيب الافتراضي", "success"); });

  document.querySelectorAll(".nav-btn").forEach(btn => btn.addEventListener("click", async () => {
    const view = btn.dataset.view;
    showSection(view);
    if (view === "users") await loadUsers();
    if (view === "archive") await loadArchive();
    if (view === "logs") await loadLogs();
    if (view === "stats") await loadStats();
    if (view === "settings") loadSettingsToForm();
  }));


  document.querySelectorAll(".search-grid .field, .advanced-grid .field").forEach(block => {
    block.addEventListener("focusin", (e) => {
      const field = e.target.closest(".field");
      if (field) field.classList.add("search-focus");
    });
    block.addEventListener("focusout", (e) => {
      const field = e.target.closest(".field");
      if (field) field.classList.remove("search-focus");
    });
  });

  applySidebarState();
});
