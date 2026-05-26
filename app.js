const config = window.RESUMEDOC_CONFIG || {};
const requiredFields = [
  "fullName",
  "email",
  "phone",
  "location",
  "targetRole",
  "jobPost",
  "workHistory",
];
const APP_ID = config.appId || "resumedoc";
const JOBEL_NOTE_MARKER = "ai:jobel-note";
const JOB_POSTING_NOTE_MARKER = "resumedoc:job-posting";
const WORK_HISTORY_PROFILE_ID = "workHistory";
const NOTE_SYNC_STATUSES = {
  not_synced: ["Not synced", "neutral"],
  pending: ["Pending", "warn"],
  synced: ["Synced", "good"],
  failed: ["Failed", "bad"],
};

const state = {
  auth: null,
  authModule: null,
  firestore: null,
  firestoreModule: null,
  notesUnsubscribe: null,
  user: null,
  idToken: "",
  firebaseReady: false,
  activePackage: null,
  packages: [],
  packagesLoaded: false,
  packageRefreshTimer: null,
  access: null,
  apiBaseOverride: "",
  notes: [],
  notesLoaded: false,
  activeNoteId: null,
  sourceRefs: {
    jobPostNoteId: "",
    workHistoryProfileId: WORK_HISTORY_PROFILE_ID,
  },
  notesPanel: "notes",
  noteFilter: "all",
  drawerOpen: false,
  jobelMessages: [],
  syncingNoteIds: new Set(),
  admin: {
    summary: null,
    users: [],
    codes: [],
    events: [],
  },
  busy: false,
};

const els = {
  connectionState: document.querySelector("#connectionState"),
  authState: document.querySelector("#authState"),
  signOutBtn: document.querySelector("#signOutBtn"),
  packageTitle: document.querySelector("#packageTitle"),
  packageSubtitle: document.querySelector("#packageSubtitle"),
  completionBar: document.querySelector("#completionBar"),
  completionLabel: document.querySelector("#completionLabel"),
  paymentLabel: document.querySelector("#paymentLabel"),
  editsLabel: document.querySelector("#editsLabel"),
  accountBadge: document.querySelector("#accountBadge"),
  detailBadge: document.querySelector("#detailBadge"),
  docxBadge: document.querySelector("#docxBadge"),
  revisionBadge: document.querySelector("#revisionBadge"),
  accountPanel: document.querySelector("#accountPanel"),
  authForm: document.querySelector("#authForm"),
  emailInput: document.querySelector("#emailInput"),
  passwordInput: document.querySelector("#passwordInput"),
  createAccountBtn: document.querySelector("#createAccountBtn"),
  googleBtn: document.querySelector("#googleBtn"),
  packageForm: document.querySelector("#packageForm"),
  fullName: document.querySelector("#fullName"),
  resumeEmail: document.querySelector("#resumeEmail"),
  phone: document.querySelector("#phone"),
  location: document.querySelector("#location"),
  targetRole: document.querySelector("#targetRole"),
  jobPost: document.querySelector("#jobPost"),
  workHistory: document.querySelector("#workHistory"),
  notes: document.querySelector("#notes"),
  resumeFile: document.querySelector("#resumeFile"),
  fileLabel: document.querySelector("#fileLabel"),
  savePackageBtn: document.querySelector("#savePackageBtn"),
  accessTitle: document.querySelector("#accessTitle"),
  accessText: document.querySelector("#accessText"),
  discountCode: document.querySelector("#discountCode"),
  claimFreeBtn: document.querySelector("#claimFreeBtn"),
  redeemCodeBtn: document.querySelector("#redeemCodeBtn"),
  checkoutBtn: document.querySelector("#checkoutBtn"),
  generateBtn: document.querySelector("#generateBtn"),
  downloadText: document.querySelector("#downloadText"),
  downloadBtn: document.querySelector("#downloadBtn"),
  resumeManagerEmpty: document.querySelector("#resumeManagerEmpty"),
  resumeManagerList: document.querySelector("#resumeManagerList"),
  refreshPackagesBtn: document.querySelector("#refreshPackagesBtn"),
  revisionText: document.querySelector("#revisionText"),
  revisionBtn: document.querySelector("#revisionBtn"),
  activityLog: document.querySelector("#activityLog"),
  adminPanel: document.querySelector("#adminPanel"),
  adminBadge: document.querySelector("#adminBadge"),
  adminStats: document.querySelector("#adminStats"),
  adminUsers: document.querySelector("#adminUsers"),
  adminUserSearch: document.querySelector("#adminUserSearch"),
  adminUserSearchBtn: document.querySelector("#adminUserSearchBtn"),
  adminCodeForm: document.querySelector("#adminCodeForm"),
  adminCodeValue: document.querySelector("#adminCodeValue"),
  adminCodeKind: document.querySelector("#adminCodeKind"),
  adminCodeUses: document.querySelector("#adminCodeUses"),
  adminCodeCreditAmount: document.querySelector("#adminCodeCreditAmount"),
  adminCodePercent: document.querySelector("#adminCodePercent"),
  adminCodeAmount: document.querySelector("#adminCodeAmount"),
  adminCodes: document.querySelector("#adminCodes"),
  adminEvents: document.querySelector("#adminEvents"),
  notesLauncherBtn: document.querySelector("#notesLauncherBtn"),
  jobelLauncherBtn: document.querySelector("#jobelLauncherBtn"),
  notesDrawer: document.querySelector("#notesDrawer"),
  notesDrawerBackdrop: document.querySelector("#notesDrawerBackdrop"),
  closeNotesDrawerBtn: document.querySelector("#closeNotesDrawerBtn"),
  notesPanelTab: document.querySelector("#notesPanelTab"),
  jobelPanelTab: document.querySelector("#jobelPanelTab"),
  notesPanel: document.querySelector("#notesPanel"),
  jobelPanel: document.querySelector("#jobelPanel"),
  noteFilter: document.querySelector("#noteFilter"),
  newNoteBtn: document.querySelector("#newNoteBtn"),
  notesEmpty: document.querySelector("#notesEmpty"),
  notesList: document.querySelector("#notesList"),
  noteEditorForm: document.querySelector("#noteEditorForm"),
  noteEditorHeading: document.querySelector("#noteEditorHeading"),
  noteSyncStatus: document.querySelector("#noteSyncStatus"),
  noteTitle: document.querySelector("#noteTitle"),
  noteBody: document.querySelector("#noteBody"),
  noteSyncCheckbox: document.querySelector("#noteSyncCheckbox"),
  saveNoteBtn: document.querySelector("#saveNoteBtn"),
  deleteNoteBtn: document.querySelector("#deleteNoteBtn"),
  jobelMessages: document.querySelector("#jobelMessages"),
  jobelForm: document.querySelector("#jobelForm"),
  jobelInput: document.querySelector("#jobelInput"),
  sendJobelBtn: document.querySelector("#sendJobelBtn"),
};

function isLocalPage() {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function apiBase() {
  if (state.apiBaseOverride) return state.apiBaseOverride;
  return (
    isLocalPage()
      ? config.localApiBase || config.productionApiBase
      : config.productionApiBase || config.localApiBase
  ).replace(/\/$/, "");
}

function workerBase() {
  return (config.paymentsWorkerBase || "").replace(/\/$/, "");
}

function setPill(el, text, tone = "neutral") {
  if (!el) return;
  el.textContent = text;
  el.className = `pill ${tone}`;
}

function log(message) {
  const stamp = new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  els.activityLog.textContent = `${stamp}  ${message}\n${els.activityLog.textContent}`;
}

function activePackageKey() {
  return state.user ? `resumedoc.activePackage.${state.user.uid}` : "";
}

function setActivePackage(pkg) {
  state.activePackage = pkg;
  if (pkg?.id && activePackageKey()) {
    localStorage.setItem(activePackageKey(), pkg.id);
  }
  upsertPackage(pkg);
  render();
}

function upsertPackage(pkg) {
  if (!pkg?.id) return;
  const existing = state.packages.filter((item) => item.id !== pkg.id);
  state.packages = [pkg, ...existing].sort((a, b) =>
    String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")),
  );
}

function packageInput() {
  return {
    fullName: els.fullName.value.trim(),
    email: els.resumeEmail.value.trim(),
    phone: els.phone.value.trim(),
    location: els.location.value.trim(),
    targetRole: els.targetRole.value.trim(),
    jobPost: els.jobPost.value.trim(),
    workHistory: els.workHistory.value.trim(),
    notes: els.notes.value.trim(),
  };
}

function packageSaveInput(formInput = packageInput(), sourceRefs = state.sourceRefs) {
  return {
    fullName: formInput.fullName || "",
    email: formInput.email || "",
    phone: formInput.phone || "",
    location: formInput.location || "",
    targetRole: formInput.targetRole || "",
    jobPostNoteId: sourceRefs?.jobPostNoteId || "",
    workHistoryProfileId: sourceRefs?.workHistoryProfileId || WORK_HISTORY_PROFILE_ID,
  };
}

function setPackageInput(input = {}) {
  els.fullName.value = input.fullName || "";
  els.resumeEmail.value = input.email || "";
  els.phone.value = input.phone || "";
  els.location.value = input.location || "";
  els.targetRole.value = input.targetRole || "";
  els.jobPost.value = input.jobPost || "";
  els.workHistory.value = input.workHistory || "";
  els.notes.value = "";
  state.sourceRefs = {
    jobPostNoteId: input.jobPostNoteId || "",
    workHistoryProfileId: input.workHistoryProfileId || WORK_HISTORY_PROFILE_ID,
  };
}

function completionPercent() {
  const input = packageInput();
  const filled = requiredFields.filter((field) => input[field]).length;
  return Math.round((filled / requiredFields.length) * 100);
}

function packageUnlocked(pkg = state.activePackage) {
  return Boolean(pkg && (pkg.accessStatus === "active" || pkg.paymentStatus === "paid" || pkg.paymentStatus === "unlocked"));
}

function userAccess() {
  return state.access?.user || null;
}

function freeOrCreditAvailable() {
  const access = userAccess();
  return (access?.freeRemaining || 0) > 0 || (access?.creditBalance || 0) > 0;
}

function canGenerate() {
  const pkg = state.activePackage;
  return Boolean(
    state.user &&
      pkg &&
      packageUnlocked(pkg) &&
      completionPercent() === 100 &&
      !state.busy,
  );
}

function canRevise() {
  const pkg = state.activePackage;
  return Boolean(
      state.user &&
      pkg &&
      packageUnlocked(pkg) &&
      pkg.latestGenerationId &&
      (pkg.editsTotal || 5) - (pkg.editsUsed || 0) > 0 &&
      !state.busy,
  );
}

function setBusy(busy) {
  state.busy = busy;
  render();
}

function render() {
  const completion = completionPercent();
  const pkg = state.activePackage;
  const editsTotal = pkg?.editsTotal ?? config.editsTotal ?? 5;
  const editsUsed = pkg?.editsUsed ?? 0;
  const editsLeft = Math.max(0, editsTotal - editsUsed);
  const access = userAccess();
  const unlocked = packageUnlocked(pkg);
  const freeRemaining = access?.freeRemaining ?? 0;
  const creditBalance = access?.creditBalance ?? 0;

  els.completionBar.style.width = `${completion}%`;
  els.completionLabel.textContent = `${completion}%`;
  els.paymentLabel.textContent = unlocked
    ? "Unlocked"
    : freeRemaining > 0
      ? "Free"
      : creditBalance > 0
        ? "Credit"
        : pkg?.paymentStatus === "pending"
          ? "Pending"
          : "Locked";
  els.editsLabel.textContent = String(editsLeft);

  setPill(
    els.authState,
    state.user ? state.user.email || "Signed in" : "Signed out",
    state.user ? "good" : "neutral",
  );
  setPill(els.accountBadge, state.user ? "Ready" : "Required", state.user ? "good" : "warn");
  setPill(
    els.detailBadge,
    completion === 100 ? "Ready" : "Needs details",
    completion === 100 ? "good" : "warn",
  );
  setPill(
    els.docxBadge,
    pkg?.latestGenerationId ? "Ready" : "Not ready",
    pkg?.latestGenerationId ? "good" : "neutral",
  );
  setPill(
    els.revisionBadge,
    canRevise() ? `${editsLeft} left` : pkg?.latestGenerationId ? "Used" : "Locked",
    canRevise() ? "good" : "neutral",
  );

  els.signOutBtn.classList.toggle("hidden", !state.user);
  els.accountPanel.classList.toggle("hidden", Boolean(state.user));
  els.packageTitle.textContent = pkg
    ? pkg.title || packageInput().targetRole || "Resume package"
    : "No package yet";
  els.packageSubtitle.textContent = pkg
    ? `Package ${pkg.id} - ${pkg.status || "draft"}`
    : "Create or load a package to begin.";
  els.downloadText.textContent = pkg?.latestGenerationId
    ? "The latest completed Word packet is ready."
    : "The completed packet will appear here after generation.";
  if (els.accessTitle) {
    els.accessTitle.textContent = unlocked
      ? `Unlocked by ${pkg.accessSource || "access"}`
      : state.user
        ? `${freeRemaining} free, ${creditBalance} credit`
        : "Package access";
  }
  if (els.accessText) {
    els.accessText.textContent = unlocked
      ? "D1 has an active entitlement for this package."
      : state.user
        ? "Use a free package credit, apply a code, or continue to Stripe Checkout."
        : "Sign in to load free package credits and codes.";
  }

  els.savePackageBtn.disabled = !state.user || state.busy;
  els.claimFreeBtn.disabled = !state.user || !pkg || unlocked || !freeOrCreditAvailable() || state.busy;
  els.claimFreeBtn.textContent = freeRemaining > 0 ? "Use free resume" : creditBalance > 0 ? "Use credit" : "No credits";
  els.redeemCodeBtn.disabled = !state.user || !pkg || unlocked || !els.discountCode.value.trim() || state.busy;
  els.checkoutBtn.disabled = !state.user || !pkg || unlocked || state.busy;
  els.generateBtn.disabled = !canGenerate();
  els.downloadBtn.disabled = !state.user || !pkg?.latestGenerationId || state.busy;
  els.refreshPackagesBtn.disabled = !state.user || state.busy;
  els.revisionBtn.disabled = !canRevise() || !els.revisionText.value.trim();
  renderPackageManager();
  renderNotesDrawer();
  renderAdmin();

  document.querySelectorAll(".steps article").forEach((step) => {
    step.classList.remove("active", "done");
  });
  markSteps(pkg, completion);
}

function markSteps(pkg, completion) {
  const done = [];
  let active = "account";
  if (state.user) {
    done.push("account");
    active = "checkout";
  }
  if (packageUnlocked(pkg)) {
    done.push("checkout");
    active = "details";
  }
  if (completion === 100) {
    done.push("details");
    active = "generate";
  }
  if (pkg?.latestGenerationId) {
    done.push("generate");
    active = "download";
  }
  for (const id of done) {
    document.querySelector(`[data-step="${id}"]`)?.classList.add("done");
  }
  document.querySelector(`[data-step="${active}"]`)?.classList.add("active");
}

async function activeToken(forceRefresh = false) {
  if (!state.user) return "";
  state.idToken = await state.user.getIdToken(forceRefresh);
  return state.idToken;
}

async function requestHeaders(forceRefresh = false) {
  const headers = { "Content-Type": "application/json" };
  const token = await activeToken(forceRefresh);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

async function api(path, options = {}) {
  const { noAuth = false, blob = false, forceRefresh = false, ...fetchOptions } = options;
  const headers = noAuth
    ? { "Content-Type": "application/json", ...(fetchOptions.headers || {}) }
    : { ...(await requestHeaders(forceRefresh)), ...(fetchOptions.headers || {}) };
  const response = await fetch(`${apiBase()}${path}`, {
    ...fetchOptions,
    headers,
  });
  if (blob && response.ok) return response.blob();
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message =
      data?.error?.message || data?.message || data?.raw || response.statusText || "Request failed";
    const error = new Error(`${response.status} at ${path}: ${message}`);
    error.status = response.status;
    error.code = data?.error?.code || "";
    throw error;
  }
  return data;
}

async function workerApi(path, options = {}) {
  if (!workerBase()) throw new Error("paymentsWorkerBase is not configured");
  const response = await fetch(`${workerBase()}${path}`, {
    ...options,
    headers: {
      ...(await requestHeaders()),
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const message = data?.error?.message || data?.message || data?.raw || response.statusText;
    throw new Error(`${response.status} at Worker ${path}: ${message}`);
  }
  return data;
}

async function checkHealth() {
  const localBase = (config.localApiBase || "").replace(/\/$/, "");
  const productionBase = (config.productionApiBase || "").replace(/\/$/, "");
  const candidates = [
    isLocalPage() ? localBase : productionBase || localBase,
    ...(isLocalPage() && productionBase && productionBase !== localBase ? [productionBase] : []),
  ].filter(Boolean);

  for (const base of candidates) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2200);
    try {
      const response = await fetch(`${base}/health`, {
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      state.apiBaseOverride = base;
      setPill(els.connectionState, base === productionBase && isLocalPage() ? "API ready: live" : "API ready", "good");
      return;
    } catch (error) {
      log(`API check failed at ${base}: ${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
  }
  setPill(els.connectionState, "API offline", "bad");
}

async function loadAccess() {
  if (!state.user) return;
  try {
    const result = await api("/me/access");
    state.access = result.access || null;
  } catch (error) {
    log(error.message);
  } finally {
    render();
  }
}

async function initializeFirebase() {
  const firebase = config.firebase || {};
  if (!firebase.apiKey || !firebase.projectId || !firebase.appId) {
    throw new Error("Firebase config is missing");
  }
  const version = config.firebaseSdkVersion || "11.10.0";
  const [{ initializeApp }, authModule, firestoreModule] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-auth.js`),
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-firestore.js`),
  ]);
  const app = initializeApp(firebase);
  state.auth = authModule.getAuth(app);
  await authModule.setPersistence(state.auth, authModule.browserLocalPersistence);
  state.authModule = authModule;
  state.firestore = firestoreModule.getFirestore(app);
  state.firestoreModule = firestoreModule;
  state.firebaseReady = true;

  authModule.onAuthStateChanged(state.auth, async (user) => {
    state.user = user;
    state.idToken = user ? await user.getIdToken() : "";
    if (user && !els.resumeEmail.value) {
      els.resumeEmail.value = user.email || "";
    }
    render();
    if (user) {
      log("Signed in.");
      await loadAccess();
      await loadPackages();
      await loadActivePackage();
      startPackageLiveRefresh();
      startNotesListener(user.uid);
      await handlePaymentReturn();
      if (state.access?.admin) await loadAdminData();
    } else {
      stopPackageLiveRefresh();
      stopNotesListener();
      state.notes = [];
      state.notesLoaded = false;
      state.packages = [];
      state.packagesLoaded = false;
      state.activeNoteId = null;
      state.sourceRefs = { jobPostNoteId: "", workHistoryProfileId: WORK_HISTORY_PROFILE_ID };
      state.jobelMessages = [];
      state.access = null;
      state.admin = { summary: null, users: [], codes: [], events: [] };
      setActivePackage(null);
      renderNotesDrawer();
    }
  });
}

async function signIn(event) {
  event.preventDefault();
  setBusy(true);
  try {
    await state.authModule.signInWithEmailAndPassword(
      state.auth,
      els.emailInput.value.trim(),
      els.passwordInput.value,
    );
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

async function createAccount() {
  setBusy(true);
  try {
    await state.authModule.createUserWithEmailAndPassword(
      state.auth,
      els.emailInput.value.trim(),
      els.passwordInput.value,
    );
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

async function signInWithGoogle() {
  setBusy(true);
  try {
    const provider = new state.authModule.GoogleAuthProvider();
    provider.setCustomParameters({ prompt: "select_account" });
    await state.authModule.signInWithPopup(state.auth, provider);
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

async function signOut() {
  await state.authModule.signOut(state.auth);
  log("Signed out.");
}

async function prepareSourcesForSave(formInput = packageInput()) {
  const result = await api("/sources/prepare", {
    method: "POST",
    body: JSON.stringify({
      packageId: state.activePackage?.id || "",
      jobPostNoteId: state.sourceRefs.jobPostNoteId || "",
      input: {
        targetRole: formInput.targetRole,
        jobPost: formInput.jobPost,
        workHistory: formInput.workHistory,
      },
    }),
  });
  state.sourceRefs = {
    jobPostNoteId: result.sources?.jobPostNoteId || state.sourceRefs.jobPostNoteId || "",
    workHistoryProfileId: result.sources?.workHistoryProfileId || WORK_HISTORY_PROFILE_ID,
  };
  if (typeof result.jobPost === "string") els.jobPost.value = result.jobPost;
  if (typeof result.workHistory === "string") els.workHistory.value = result.workHistory;
  return result;
}

async function savePackage() {
  setBusy(true);
  try {
    const formInput = packageInput();
    await prepareSourcesForSave(formInput);
    const input = packageSaveInput({ ...formInput, jobPost: els.jobPost.value.trim(), workHistory: els.workHistory.value.trim() });
    const pkg = state.activePackage;
    const result = pkg?.id
      ? await api(`/packages/${encodeURIComponent(pkg.id)}`, {
          method: "PATCH",
          body: JSON.stringify({ input }),
        })
      : await api("/packages", {
          method: "POST",
          body: JSON.stringify({ input }),
        });
    setActivePackage(result.package);
    await loadPackages();
    log("Sources organized and package saved.");
    return result.package;
  } catch (error) {
    log(error.message);
    return null;
  } finally {
    setBusy(false);
  }
}

async function loadActivePackage() {
  const id = new URLSearchParams(window.location.search).get("package_id") || localStorage.getItem(activePackageKey());
  if (!id) return;
  await loadPackageById(id);
}

async function loadPackageById(id) {
  try {
    const result = await api(`/packages/${encodeURIComponent(id)}`);
    setActivePackage(result.package);
    if (result.input) setPackageInput(result.input);
    log("Package loaded.");
  } catch (error) {
    log(error.message);
  }
}

async function loadPackages() {
  if (!state.user) return;
  try {
    const result = await api("/packages");
    state.packages = Array.isArray(result.packages) ? result.packages : [];
    state.packagesLoaded = true;
    syncActivePackageFromList();
  } catch (error) {
    state.packagesLoaded = true;
    log(error.message);
  } finally {
    if (els.resumeFile) els.resumeFile.value = "";
    render();
  }
}

async function refreshPackagesLive() {
  if (!state.user || state.busy) return;
  try {
    const result = await api("/packages");
    state.packages = Array.isArray(result.packages) ? result.packages : [];
    state.packagesLoaded = true;
    syncActivePackageFromList();
    render();
  } catch {
    // Keep live refresh quiet; explicit actions still log errors.
  }
}

function syncActivePackageFromList() {
  if (!state.activePackage?.id) return;
  const fresh = state.packages.find((item) => item.id === state.activePackage.id);
  if (fresh) {
    state.activePackage = { ...state.activePackage, ...fresh };
  }
}

function startPackageLiveRefresh() {
  stopPackageLiveRefresh();
  state.packageRefreshTimer = window.setInterval(refreshPackagesLive, 30000);
}

function stopPackageLiveRefresh() {
  if (state.packageRefreshTimer) {
    window.clearInterval(state.packageRefreshTimer);
    state.packageRefreshTimer = null;
  }
}

function returnUrl(packageId) {
  const url = new URL(window.location.href);
  url.searchParams.set("package_id", packageId);
  url.searchParams.delete("session_id");
  url.searchParams.delete("resume_payment");
  return url.toString();
}

async function startCheckout() {
  const pkg = state.activePackage || (await savePackage());
  if (!pkg) return;
  setBusy(true);
  try {
    const data = await api(`/packages/${encodeURIComponent(pkg.id)}/checkout`, {
      method: "POST",
      body: JSON.stringify({
        returnUrl: returnUrl(pkg.id),
        discountCode: els.discountCode.value.trim() || undefined,
      }),
    });
    if (data.checkout?.checkoutSkipped) {
      setActivePackage(data.checkout.package || pkg);
      await loadAccess();
      await loadPackages();
      log("Package already unlocked.");
      return;
    }
    log("Opening Stripe Checkout.");
    window.location.href = data.checkout.url;
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

async function claimFreePackage() {
  const pkg = state.activePackage || (await savePackage());
  if (!pkg) return;
  setBusy(true);
  try {
    const result = await api(`/packages/${encodeURIComponent(pkg.id)}/claim-free`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setActivePackage(result.package);
    state.access = result.access;
    await loadPackages();
    log("Package unlocked.");
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

async function redeemCode() {
  const pkg = state.activePackage || (await savePackage());
  const code = els.discountCode.value.trim();
  if (!pkg || !code) return;
  setBusy(true);
  try {
    const result = await api(`/packages/${encodeURIComponent(pkg.id)}/redeem-code`, {
      method: "POST",
      body: JSON.stringify({ code }),
    });
    setActivePackage(result.package);
    state.access = result.access;
    await loadPackages();
    log("Code applied.");
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

async function handlePaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const stateParam = params.get("resume_payment");
  const packageId = params.get("package_id");
  const sessionId = params.get("session_id");
  if (stateParam !== "success" || !packageId || !sessionId) return;

  setBusy(true);
  try {
    const result = await api(`/packages/${encodeURIComponent(packageId)}/confirm-payment`, {
      method: "POST",
      body: JSON.stringify({ stripeSessionId: sessionId }),
    });
    setActivePackage(result.package);
    await loadAccess();
    await loadPackages();
    log("Payment confirmed.");
    params.delete("resume_payment");
    params.delete("session_id");
    const cleanUrl = `${window.location.pathname}?${params.toString()}`;
    history.replaceState({}, "", cleanUrl.endsWith("?") ? window.location.pathname : cleanUrl);
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

async function generateDocx() {
  const saved = await savePackage();
  if (!saved) return;
  const extraDirection = els.notes.value.trim();
  setBusy(true);
  try {
    const result = await api(`/packages/${encodeURIComponent(saved.id)}/generate`, {
      method: "POST",
      body: JSON.stringify({ extraDirection }),
    });
    setActivePackage(result.package);
    await loadPackages();
    log("DOCX generated.");
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

async function submitRevision() {
  const pkg = state.activePackage;
  const instruction = els.revisionText.value.trim();
  if (!pkg || !instruction) return;
  setBusy(true);
  try {
    const result = await api(`/packages/${encodeURIComponent(pkg.id)}/revisions`, {
      method: "POST",
      body: JSON.stringify({ instruction }),
    });
    els.revisionText.value = "";
    setActivePackage(result.package);
    await loadPackages();
    log("Revision generated.");
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

async function downloadDocx() {
  const pkg = state.activePackage;
  if (!pkg?.id) return;
  if (!pkg.latestGenerationId) {
    await refreshPackagesLive();
  }
  const fresh = state.activePackage;
  if (!fresh?.latestGenerationId) return;
  await downloadPackageDocx(fresh.id, fresh.title);
}

async function downloadPackageDocx(packageId, title) {
  if (!packageId) return;
  setBusy(true);
  try {
    const blob = await api(`/packages/${encodeURIComponent(packageId)}/download/docx`, {
      method: "GET",
      blob: true,
      headers: {},
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName(title || "ResumeDoc packet")}.docx`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    log("DOCX download started.");
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

function safeFileName(value) {
  return value.replace(/[^\w .-]+/g, "").replace(/\s+/g, " ").trim() || "ResumeDoc packet";
}

async function extractFileText(file) {
  if (!file) return;
  els.fileLabel.textContent = "Reading upload...";
  try {
    if (/\.txt$/i.test(file.name) || file.type.startsWith("text/")) {
      const text = await file.text();
      appendWorkHistory(text);
      els.fileLabel.textContent = "Upload extracted into work history.";
      return;
    }
    const base64 = await fileToBase64(file);
    const result = await api("/extract", {
      method: "POST",
      body: JSON.stringify({
        fileName: file.name,
        contentType: file.type || "application/octet-stream",
        base64,
      }),
    });
    appendWorkHistory(result.text || "");
    els.fileLabel.textContent = "Upload extracted into work history.";
  } catch (error) {
    els.fileLabel.textContent = "Upload could not be extracted.";
    log(error.message);
  } finally {
    render();
  }
}

function appendWorkHistory(text) {
  const cleaned = text.replace(/\s+\n/g, "\n").trim();
  if (!cleaned) return;
  els.workHistory.value = `${els.workHistory.value.trim()}\n\n${cleaned}`.trim();
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.onload = () => {
      const value = String(reader.result || "");
      resolve(value.includes(",") ? value.split(",").pop() : value);
    };
    reader.readAsDataURL(file);
  });
}

function notesCacheKey() {
  return state.user ? `resumedoc.notes.${state.user.uid}` : "";
}

function cacheNotes() {
  const key = notesCacheKey();
  if (!key) return;
  try {
    localStorage.setItem(key, JSON.stringify(state.notes.slice(0, 100)));
  } catch {}
}

function loadCachedNotes() {
  const key = notesCacheKey();
  if (!key) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(parsed) ? parsed.map(normalizeNoteDoc).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function notesCollectionRef() {
  const f = state.firestoreModule;
  if (!state.user || !state.firestore || !f) return null;
  return f.collection(state.firestore, "users", state.user.uid, "apps", APP_ID, "notes");
}

function noteDocRef(noteId) {
  const f = state.firestoreModule;
  if (!state.user || !state.firestore || !f || !noteId) return null;
  return f.doc(state.firestore, "users", state.user.uid, "apps", APP_ID, "notes", noteId);
}

function normalizeNoteDoc(docLike) {
  const id = docLike?.id || "";
  const data = typeof docLike?.data === "function" ? docLike.data() : docLike || {};
  if (!id && !data.id) return null;
  const metadata = data.metadata && typeof data.metadata === "object" ? data.metadata : {};
  const brainSync = data.brainSync && typeof data.brainSync === "object" ? data.brainSync : {};
  return {
    id: id || data.id,
    owner: data.owner || "",
    appId: data.appId || APP_ID,
    packageId: data.packageId || "",
    title: cleanClientString(data.title, 120),
    body: String(data.body || ""),
    createdAt: data.createdAt || "",
    updatedAt: data.updatedAt || "",
    metadata: normalizeNoteMetadata(metadata),
    syncToBrain: data.syncToBrain === true,
    brainSync: normalizeBrainSync(brainSync),
  };
}

function normalizeNoteMetadata(metadata = {}) {
  const source = metadata.source === "jobel" ? "jobel" : "user";
  const isJobel = source === "jobel" || metadata.marker === JOBEL_NOTE_MARKER;
  const isJobPosting = metadata.kind === "job_posting" || metadata.marker === JOB_POSTING_NOTE_MARKER;
  return {
    source: isJobel ? "jobel" : "user",
    kind: isJobPosting ? "job_posting" : cleanClientString(metadata.kind || "note", 80),
    marker: isJobel ? JOBEL_NOTE_MARKER : isJobPosting ? JOB_POSTING_NOTE_MARKER : metadata.marker || null,
    readOnly: isJobel || metadata.readOnly === true,
    contentFormat: metadata.contentFormat === "markdown" ? "markdown" : "plain",
  };
}

function normalizeBrainSync(value = {}) {
  const status = NOTE_SYNC_STATUSES[value.status] ? value.status : "not_synced";
  return {
    status,
    sourceHash: value.sourceHash || null,
    memoryId: value.memoryId || null,
    lastAttemptAt: value.lastAttemptAt || null,
    syncedAt: value.syncedAt || null,
    errorCode: value.errorCode || null,
  };
}

function cleanClientString(value, max) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max).trim() : text;
}

function noteTitle(note) {
  return note?.title || (isJobelNote(note) ? "Jobel note" : isJobPostingNote(note) ? "Job posting reference" : "Untitled note");
}

function isJobelNote(note) {
  return normalizeNoteMetadata(note?.metadata).source === "jobel";
}

function isJobPostingNote(note) {
  const metadata = normalizeNoteMetadata(note?.metadata);
  return metadata.kind === "job_posting" || metadata.marker === JOB_POSTING_NOTE_MARKER;
}

function noteStatus(note) {
  return note?.brainSync?.status || "not_synced";
}

function noteTypeLabel(note) {
  if (isJobelNote(note)) return "Jobel";
  if (isJobPostingNote(note)) return "Job posting";
  return "Your note";
}

function activeNote() {
  return state.notes.find((note) => note.id === state.activeNoteId) || null;
}

function noteMatchesFilter(note) {
  const filter = state.noteFilter;
  if (filter === "user") return !isJobelNote(note);
  if (filter === "jobel") return isJobelNote(note);
  if (filter === "job_posting") return isJobPostingNote(note);
  if (filter === "synced") return noteStatus(note) === "synced";
  if (filter === "pending") return noteStatus(note) === "pending";
  if (filter === "failed") return noteStatus(note) === "failed";
  return true;
}

function startNotesListener(uid) {
  stopNotesListener();
  state.notesLoaded = false;
  state.notes = loadCachedNotes();
  renderNotesDrawer();
  const f = state.firestoreModule;
  const collectionRef = notesCollectionRef();
  if (!uid || !f || !collectionRef) return;
  state.notesUnsubscribe = f.onSnapshot(
    collectionRef,
    (snap) => {
      state.notesLoaded = true;
      state.notes = snap.docs
        .map(normalizeNoteDoc)
        .filter(Boolean)
        .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
      if (state.activeNoteId && !state.notes.some((note) => note.id === state.activeNoteId)) {
        state.activeNoteId = state.notes[0]?.id || null;
        fillNoteEditor(activeNote());
      }
      cacheNotes();
      renderNotesDrawer();
      retryPendingBrainSync();
    },
    (error) => {
      state.notesLoaded = true;
      log(`Notes failed to load: ${error.code || error.message}`);
      renderNotesDrawer();
    },
  );
}

function stopNotesListener() {
  if (typeof state.notesUnsubscribe === "function") {
    state.notesUnsubscribe();
  }
  state.notesUnsubscribe = null;
}

function openNotesDrawer(panel = "notes") {
  state.drawerOpen = true;
  setNotesPanel(panel);
  els.notesDrawer?.classList.remove("hidden");
  els.notesDrawer?.setAttribute("aria-hidden", "false");
  renderNotesDrawer();
}

function closeNotesDrawer() {
  state.drawerOpen = false;
  els.notesDrawer?.classList.add("hidden");
  els.notesDrawer?.setAttribute("aria-hidden", "true");
}

function setNotesPanel(panel) {
  state.notesPanel = panel === "jobel" ? "jobel" : "notes";
  renderNotesDrawer();
}

function newNote() {
  state.activeNoteId = null;
  fillNoteEditor(null);
  openNotesDrawer("notes");
}

function fillNoteEditor(note) {
  const isReadOnly = note?.metadata?.readOnly === true;
  els.noteEditorHeading.textContent = note ? (isReadOnly ? "Jobel note" : "Edit note") : "New note";
  els.noteTitle.value = note?.title || "";
  els.noteBody.value = note?.body || "";
  els.noteSyncCheckbox.checked = note?.syncToBrain === true;
  els.noteTitle.disabled = isReadOnly;
  els.noteBody.disabled = isReadOnly;
  els.noteSyncCheckbox.disabled = isReadOnly;
  els.deleteNoteBtn.disabled = !state.user || !note || state.busy;
  els.saveNoteBtn.disabled = !state.user || isReadOnly || state.busy;
  setSyncPill(note);
}

function setSyncPill(note = activeNote()) {
  const [label, tone] = NOTE_SYNC_STATUSES[noteStatus(note)] || NOTE_SYNC_STATUSES.not_synced;
  setPill(els.noteSyncStatus, label, tone);
}

function renderNotesDrawer() {
  if (!els.notesDrawer) return;
  const panel = state.notesPanel;
  els.notesPanel.classList.toggle("active", panel === "notes");
  els.jobelPanel.classList.toggle("active", panel === "jobel");
  els.notesPanelTab.classList.toggle("active", panel === "notes");
  els.jobelPanelTab.classList.toggle("active", panel === "jobel");
  els.noteFilter.value = state.noteFilter;

  const visibleNotes = state.notes.filter(noteMatchesFilter);
  els.notesEmpty.classList.toggle("hidden", Boolean(visibleNotes.length));
  els.notesEmpty.textContent = state.user
    ? state.notesLoaded
      ? "No notes match this view yet."
      : "Loading notes..."
    : "Sign in and start a note to build resume context over time.";
  els.notesList.innerHTML = visibleNotes.map(noteCardHtml).join("");
  setSyncPill();
  renderJobelMessages();
  if (!state.activeNoteId && !els.noteTitle.value && !els.noteBody.value) {
    fillNoteEditor(null);
  } else {
    const note = activeNote();
    if (note) {
      els.noteEditorHeading.textContent = note.metadata.readOnly ? "Jobel note" : "Edit note";
      els.deleteNoteBtn.disabled = !state.user || state.busy;
      els.saveNoteBtn.disabled = !state.user || note.metadata.readOnly || state.busy;
      setSyncPill(note);
    }
  }
  els.newNoteBtn.disabled = !state.user || state.busy;
  els.sendJobelBtn.disabled = !state.user || state.busy || !els.jobelInput.value.trim();
}

function renderPackageManager() {
  if (!els.resumeManagerList || !els.resumeManagerEmpty) return;
  const packages = state.packages || [];
  els.resumeManagerEmpty.classList.toggle("hidden", Boolean(packages.length));
  els.resumeManagerEmpty.textContent = state.user
    ? state.packagesLoaded
      ? "No saved ResumeDoc packages yet."
      : "Loading saved packages..."
    : "Sign in to see packages saved to your ResumeDoc account.";
  els.resumeManagerList.innerHTML = packages.map(packageCardHtml).join("");
}

function packageCardHtml(pkg) {
  const isActive = pkg.id === state.activePackage?.id;
  const ready = Boolean(pkg.latestGenerationId);
  const date = pkg.generatedAt || pkg.updatedAt || pkg.createdAt;
  return `
    <article class="resume-package-card ${isActive ? "active" : ""}" data-package-id="${escapeHtml(pkg.id)}">
      <div class="resume-package-head">
        <strong>${escapeHtml(pkg.title || "Resume package")}</strong>
        <span class="pill ${ready ? "good" : "neutral"}">${ready ? "DOCX ready" : "Draft"}</span>
      </div>
      <small>${escapeHtml(date ? shortDate(date) : "Saved package")}</small>
      <div class="resume-package-actions">
        <button class="button" type="button" data-package-action="load">Load</button>
        <button class="button primary" type="button" data-package-action="download" ${ready ? "" : "disabled"}>Download</button>
      </div>
    </article>
  `;
}

function noteCardHtml(note) {
  const status = NOTE_SYNC_STATUSES[noteStatus(note)] || NOTE_SYNC_STATUSES.not_synced;
  const date = note.updatedAt ? shortDate(note.updatedAt) : "";
  const preview = note.body || "Empty note";
  return `
    <button class="note-card ${isJobelNote(note) ? "jobel" : ""} ${isJobPostingNote(note) ? "job-posting" : ""} ${note.id === state.activeNoteId ? "active" : ""}" type="button" data-note-id="${escapeHtml(note.id)}">
      <span class="note-card-head">
        <strong>${escapeHtml(noteTitle(note))}</strong>
        <span class="pill ${escapeHtml(status[1])}">${escapeHtml(status[0])}</span>
      </span>
      <p>${escapeHtml(clipClientText(preview, 220))}</p>
      <span class="note-card-meta">
        <span>${escapeHtml(noteTypeLabel(note))}</span>
        ${date ? `<span>${escapeHtml(date)}</span>` : ""}
        ${note.syncToBrain ? "<span>AI Brain sync on</span>" : ""}
      </span>
    </button>
  `;
}

function clipClientText(value, max) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(1, max - 1)).trim()}...`;
}

async function saveNote(event) {
  event?.preventDefault();
  if (!state.user) {
    log("Sign in before saving notes.");
    return;
  }
  const current = activeNote();
  if (current?.metadata?.readOnly) {
    log("Jobel notes are read-only.");
    return;
  }
  const title = cleanClientString(els.noteTitle.value, 120);
  const body = String(els.noteBody.value || "").trim();
  if (!title && !body) {
    log("Write a note before saving.");
    return;
  }
  const now = new Date().toISOString();
  const syncToBrain = els.noteSyncCheckbox.checked;
  const payload = withoutClientUndefined({
    owner: state.user.uid,
    appId: APP_ID,
    packageId: state.activePackage?.id || "",
    title,
    body,
    updatedAt: now,
    createdAt: current?.createdAt || now,
    metadata: isJobPostingNote(current)
      ? { source: "user", kind: "job_posting", marker: JOB_POSTING_NOTE_MARKER, readOnly: false, contentFormat: "markdown" }
      : { source: "user", kind: "note", readOnly: false, contentFormat: "plain" },
    syncToBrain,
    brainSync: noteBrainSyncForSave(current, syncToBrain),
  });
  setBusy(true);
  try {
    const f = state.firestoreModule;
    if (current?.id) {
      await f.setDoc(noteDocRef(current.id), payload, { merge: true });
      state.activeNoteId = current.id;
    } else {
      const docRef = await f.addDoc(notesCollectionRef(), payload);
      state.activeNoteId = docRef.id;
    }
    log("Note saved.");
    if (syncToBrain) await syncNoteToBrain(state.activeNoteId);
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

function noteBrainSyncForSave(current, syncToBrain) {
  if (!syncToBrain) return { status: "not_synced", sourceHash: null, memoryId: null, syncedAt: null, errorCode: null };
  if (current?.brainSync?.status === "synced") {
    return {
      ...current.brainSync,
      status: "not_synced",
      sourceHash: null,
      syncedAt: null,
      errorCode: null,
    };
  }
  return current?.brainSync || { status: "not_synced", sourceHash: null, memoryId: null, syncedAt: null, errorCode: null };
}

async function deleteActiveNote() {
  const current = activeNote();
  if (!state.user || !current) return;
  setBusy(true);
  try {
    await state.firestoreModule.deleteDoc(noteDocRef(current.id));
    state.activeNoteId = null;
    fillNoteEditor(null);
    log("Note deleted.");
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

async function syncNoteToBrain(noteId) {
  if (!state.user || !noteId) return;
  if (state.syncingNoteIds.has(noteId)) return;
  state.syncingNoteIds.add(noteId);
  try {
    await state.firestoreModule.setDoc(noteDocRef(noteId), {
      brainSync: {
        ...(activeNote()?.brainSync || {}),
        status: "pending",
        lastAttemptAt: new Date().toISOString(),
        errorCode: null,
      },
    }, { merge: true });
    const result = await api(`/notes/${encodeURIComponent(noteId)}/sync-brain`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    log(result.skipped ? "Note already synced." : "Note synced to AI Brain.");
  } catch (error) {
    log(error.message);
  } finally {
    state.syncingNoteIds.delete(noteId);
  }
}

function retryPendingBrainSync() {
  if (!state.user || !navigator.onLine) return;
  const pending = state.notes.filter((note) => note.syncToBrain && ["pending", "failed"].includes(noteStatus(note))).slice(0, 3);
  for (const note of pending) {
    void syncNoteToBrain(note.id);
  }
}

function renderJobelMessages() {
  const stored = state.notes
    .filter(isJobelNote)
    .slice(0, 6)
    .reverse()
    .map((note) => ({ role: "jobel", content: note.body, createdAt: note.createdAt }));
  const messages = [...stored, ...state.jobelMessages].slice(-12);
  els.jobelMessages.innerHTML = messages.length
    ? messages.map((message) => `
      <div class="jobel-message ${message.role === "user" ? "user" : "jobel"}">
        <strong>${message.role === "user" ? "You" : "Jobel"}</strong>
        <p>${escapeHtml(message.content)}</p>
      </div>
    `).join("")
    : `<div class="notes-empty">Ask Jobel what your resume still needs.</div>`;
}

async function sendJobelMessage(event) {
  event.preventDefault();
  if (!state.user) {
    log("Sign in before chatting with Jobel.");
    return;
  }
  const message = String(els.jobelInput.value || "").trim();
  if (!message) return;
  state.jobelMessages.push({ role: "user", content: message, createdAt: new Date().toISOString() });
  els.jobelInput.value = "";
  renderNotesDrawer();
  setBusy(true);
  try {
    const result = await api("/jobel/chat", {
      method: "POST",
      body: JSON.stringify({
        message,
        packageId: state.activePackage?.id || "",
        noteIds: state.notes.slice(0, 12).map((note) => note.id),
      }),
    });
    const reply = String(result.reply || "").trim();
    if (reply) {
      state.jobelMessages.push({ role: "jobel", content: reply, createdAt: new Date().toISOString() });
      await createJobelNote(reply);
      log("Jobel replied.");
    }
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
    renderNotesDrawer();
  }
}

async function createJobelNote(reply) {
  const f = state.firestoreModule;
  const now = new Date().toISOString();
  const docRef = await f.addDoc(notesCollectionRef(), {
    owner: state.user.uid,
    appId: APP_ID,
    packageId: state.activePackage?.id || "",
    title: "Jobel reply",
    body: reply,
    createdAt: now,
    updatedAt: now,
    metadata: {
      source: "jobel",
      marker: JOBEL_NOTE_MARKER,
      readOnly: true,
      contentFormat: "markdown",
    },
    syncToBrain: false,
    brainSync: { status: "not_synced", sourceHash: null, memoryId: null, syncedAt: null, errorCode: null },
  });
  state.activeNoteId = docRef.id;
}

function withoutClientUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutClientUndefined).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = withoutClientUndefined(entry);
      if (cleaned !== undefined) result[key] = cleaned;
    }
    return result;
  }
  return value === undefined ? undefined : value;
}

async function loadAdminData() {
  if (!state.access?.admin) return;
  try {
    const [summary, users, codes, events] = await Promise.all([
      api("/admin/summary"),
      api(`/admin/users?q=${encodeURIComponent(els.adminUserSearch.value.trim())}`),
      api("/admin/codes"),
      api("/admin/events"),
    ]);
    state.admin.summary = summary.summary || null;
    state.admin.users = users.users || [];
    state.admin.codes = codes.codes || [];
    state.admin.events = events.events || [];
  } catch (error) {
    log(error.message);
  } finally {
    renderAdmin();
  }
}

function renderAdmin() {
  if (!els.adminPanel) return;
  const isAdmin = state.access?.admin === true;
  els.adminPanel.classList.toggle("hidden", !isAdmin);
  if (!isAdmin) return;
  setPill(els.adminBadge, "Owner", "good");
  const summary = state.admin.summary || {};
  els.adminStats.innerHTML = [
    ["Users", summary.users ?? 0],
    ["Unlocked", summary.unlockedPackages ?? 0],
    ["Active codes", summary.activeCodes ?? 0],
    ["Paid orders", summary.paidOrders ?? 0],
  ].map(([label, value]) => `<div class="admin-stat"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(label)}</span></div>`).join("");

  els.adminUsers.innerHTML = state.admin.users.length
    ? state.admin.users.map(adminUserRow).join("")
    : `<div class="admin-row"><small>No users found yet.</small></div>`;
  els.adminCodes.innerHTML = state.admin.codes.length
    ? state.admin.codes.map(adminCodeRow).join("")
    : `<div class="admin-row"><small>No codes created yet.</small></div>`;
  els.adminEvents.innerHTML = state.admin.events.length
    ? state.admin.events.map((event) => `
      <div class="admin-row">
        <small>${escapeHtml(shortDate(event.createdAt))}</small>
        <div>
          <strong>${escapeHtml(event.eventType || "event")}</strong>
          <small>${escapeHtml(JSON.stringify(event.metadata || {}))}</small>
        </div>
      </div>
    `).join("")
    : `<div class="admin-row"><small>No events yet.</small></div>`;
}

function adminUserRow(user) {
  return `
    <div class="admin-row" data-user="${escapeHtml(user.uidHash)}">
      <div class="admin-row-head">
        <div>
          <strong>${escapeHtml(user.email || "Unknown email")}</strong>
          <small>${escapeHtml(user.uidHash.slice(0, 12))}... ${escapeHtml(user.status)}</small>
        </div>
        <span class="pill ${user.freeRemaining > 0 || user.creditBalance > 0 ? "good" : "neutral"}">${escapeHtml(String(user.freeRemaining))} free</span>
      </div>
      <div class="admin-row-controls">
        <input data-admin-field="freeQuota" type="number" min="0" value="${escapeHtml(String(user.freeQuota || 0))}" />
        <input data-admin-field="freeUsed" type="number" min="0" value="${escapeHtml(String(user.freeUsed || 0))}" />
        <input data-admin-field="creditBalance" type="number" min="0" value="${escapeHtml(String(user.creditBalance || 0))}" />
        <button class="button" data-admin-action="save-user" type="button">Save</button>
        <button class="button" data-admin-action="reset-free" type="button">Reset</button>
      </div>
    </div>
  `;
}

function adminCodeRow(code) {
  const uses = code.maxRedemptions === null ? "infinite" : `${code.redeemedCount}/${code.maxRedemptions}`;
  const value = code.kind === "stripe"
    ? code.percentOff
      ? `${code.percentOff}% off`
      : `${(code.amountOff || 0) / 100} ${code.currency || "usd"}`
    : `${code.creditAmount} credit`;
  return `
    <div class="admin-row" data-code="${escapeHtml(code.id)}">
      <div class="admin-row-head">
        <div>
          <strong>${escapeHtml(code.code)}</strong>
          <small>${escapeHtml(code.kind)} - ${escapeHtml(value)} - ${escapeHtml(uses)}</small>
        </div>
        <span class="pill ${code.status === "active" ? "good" : "bad"}">${escapeHtml(code.status)}</span>
      </div>
      <div class="button-row">
        <button class="button" data-admin-action="revoke-code" type="button" ${code.status !== "active" ? "disabled" : ""}>Revoke</button>
      </div>
    </div>
  `;
}

async function searchAdminUsers() {
  await loadAdminData();
}

async function submitAdminCode(event) {
  event.preventDefault();
  setBusy(true);
  try {
    const maxRedemptions = els.adminCodeUses.value ? Number(els.adminCodeUses.value) : null;
    const body = {
      code: els.adminCodeValue.value.trim(),
      kind: els.adminCodeKind.value,
      maxRedemptions,
      creditAmount: els.adminCodeCreditAmount.value ? Number(els.adminCodeCreditAmount.value) : undefined,
      percentOff: els.adminCodePercent.value ? Number(els.adminCodePercent.value) : undefined,
      amountOff: els.adminCodeAmount.value ? Number(els.adminCodeAmount.value) : undefined,
      currency: "usd",
    };
    await api("/admin/codes", {
      method: "POST",
      body: JSON.stringify(body),
    });
    els.adminCodeForm.reset();
    els.adminCodeCreditAmount.value = "1";
    await loadAdminData();
    log("Admin code created.");
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

async function handleAdminClick(event) {
  const button = event.target.closest("[data-admin-action]");
  if (!button) return;
  const action = button.dataset.adminAction;
  const userRow = button.closest("[data-user]");
  const codeRow = button.closest("[data-code]");
  setBusy(true);
  try {
    if (action === "save-user" && userRow) {
      const uidHash = userRow.dataset.user;
      const field = (name) => Number(userRow.querySelector(`[data-admin-field="${name}"]`)?.value || 0);
      await api(`/admin/users/${encodeURIComponent(uidHash)}`, {
        method: "PATCH",
        body: JSON.stringify({
          freeQuota: field("freeQuota"),
          freeUsed: field("freeUsed"),
          creditBalance: field("creditBalance"),
          userStatus: "active",
        }),
      });
      log("User credits updated.");
    }
    if (action === "reset-free" && userRow) {
      await api(`/admin/users/${encodeURIComponent(userRow.dataset.user)}/reset-free`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      log("Free usage reset.");
    }
    if (action === "revoke-code" && codeRow) {
      await api(`/admin/codes/${encodeURIComponent(codeRow.dataset.code)}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "revoked" }),
      });
      log("Code revoked.");
    }
    await loadAdminData();
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], { dateStyle: "short", timeStyle: "short" });
}

for (const field of [
  els.fullName,
  els.resumeEmail,
  els.phone,
  els.location,
  els.targetRole,
  els.jobPost,
  els.workHistory,
  els.notes,
  els.discountCode,
  els.revisionText,
]) {
  field.addEventListener("input", render);
}

els.authForm.addEventListener("submit", signIn);
els.createAccountBtn.addEventListener("click", createAccount);
els.googleBtn.addEventListener("click", signInWithGoogle);
els.signOutBtn.addEventListener("click", signOut);
els.savePackageBtn.addEventListener("click", savePackage);
els.claimFreeBtn.addEventListener("click", claimFreePackage);
els.redeemCodeBtn.addEventListener("click", redeemCode);
els.checkoutBtn.addEventListener("click", startCheckout);
els.generateBtn.addEventListener("click", generateDocx);
els.downloadBtn.addEventListener("click", downloadDocx);
els.refreshPackagesBtn.addEventListener("click", loadPackages);
els.resumeManagerList.addEventListener("click", async (event) => {
  const action = event.target.closest("[data-package-action]")?.dataset.packageAction;
  const card = event.target.closest("[data-package-id]");
  if (!action || !card) return;
  const id = card.dataset.packageId;
  const pkg = state.packages.find((item) => item.id === id);
  if (action === "load") {
    await loadPackageById(id);
  }
  if (action === "download" && pkg?.latestGenerationId) {
    await downloadPackageDocx(id, pkg.title);
  }
});
els.revisionBtn.addEventListener("click", submitRevision);
els.resumeFile.addEventListener("change", () => extractFileText(els.resumeFile.files?.[0]));
els.notesLauncherBtn.addEventListener("click", () => openNotesDrawer("notes"));
els.jobelLauncherBtn.addEventListener("click", () => openNotesDrawer("jobel"));
els.notesDrawerBackdrop.addEventListener("click", closeNotesDrawer);
els.closeNotesDrawerBtn.addEventListener("click", closeNotesDrawer);
els.notesPanelTab.addEventListener("click", () => setNotesPanel("notes"));
els.jobelPanelTab.addEventListener("click", () => setNotesPanel("jobel"));
els.noteFilter.addEventListener("change", (event) => {
  state.noteFilter = event.target.value;
  renderNotesDrawer();
});
els.newNoteBtn.addEventListener("click", newNote);
els.notesList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-note-id]");
  if (!card) return;
  state.activeNoteId = card.dataset.noteId;
  fillNoteEditor(activeNote());
  renderNotesDrawer();
});
els.noteEditorForm.addEventListener("submit", saveNote);
els.deleteNoteBtn.addEventListener("click", deleteActiveNote);
els.jobelInput.addEventListener("input", renderNotesDrawer);
els.jobelForm.addEventListener("submit", sendJobelMessage);
window.addEventListener("online", () => {
  retryPendingBrainSync();
  refreshPackagesLive();
});
window.addEventListener("focus", refreshPackagesLive);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshPackagesLive();
});
els.adminUserSearchBtn.addEventListener("click", searchAdminUsers);
els.adminCodeForm.addEventListener("submit", submitAdminCode);
els.adminPanel.addEventListener("click", handleAdminClick);

render();
checkHealth();
initializeFirebase().catch((error) => {
  log(error.message);
  setPill(els.authState, "Auth failed", "bad");
});
