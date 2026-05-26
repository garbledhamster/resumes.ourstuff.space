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

const state = {
  auth: null,
  authModule: null,
  user: null,
  idToken: "",
  firebaseReady: false,
  activePackage: null,
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
  checkoutBtn: document.querySelector("#checkoutBtn"),
  generateBtn: document.querySelector("#generateBtn"),
  downloadText: document.querySelector("#downloadText"),
  downloadBtn: document.querySelector("#downloadBtn"),
  revisionText: document.querySelector("#revisionText"),
  revisionBtn: document.querySelector("#revisionBtn"),
  activityLog: document.querySelector("#activityLog"),
};

function isLocalPage() {
  return ["localhost", "127.0.0.1", "::1"].includes(window.location.hostname);
}

function apiBase() {
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
  render();
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

function setPackageInput(input = {}) {
  els.fullName.value = input.fullName || "";
  els.resumeEmail.value = input.email || "";
  els.phone.value = input.phone || "";
  els.location.value = input.location || "";
  els.targetRole.value = input.targetRole || "";
  els.jobPost.value = input.jobPost || "";
  els.workHistory.value = input.workHistory || "";
  els.notes.value = input.notes || "";
}

function completionPercent() {
  const input = packageInput();
  const filled = requiredFields.filter((field) => input[field]).length;
  return Math.round((filled / requiredFields.length) * 100);
}

function canGenerate() {
  const pkg = state.activePackage;
  return Boolean(
    state.user &&
      pkg &&
      pkg.paymentStatus === "paid" &&
      completionPercent() === 100 &&
      !state.busy,
  );
}

function canRevise() {
  const pkg = state.activePackage;
  return Boolean(
    state.user &&
      pkg &&
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

  els.completionBar.style.width = `${completion}%`;
  els.completionLabel.textContent = `${completion}%`;
  els.paymentLabel.textContent =
    pkg?.paymentStatus === "paid"
      ? "Paid"
      : pkg?.paymentStatus === "pending"
        ? "Pending"
        : "Unpaid";
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

  els.savePackageBtn.disabled = !state.user || state.busy;
  els.checkoutBtn.disabled = !state.user || !pkg || pkg.paymentStatus === "paid" || state.busy;
  els.generateBtn.disabled = !canGenerate();
  els.downloadBtn.disabled = !state.user || !pkg?.latestGenerationId || state.busy;
  els.revisionBtn.disabled = !canRevise() || !els.revisionText.value.trim();

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
  if (pkg?.paymentStatus === "paid") {
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
  try {
    await api("/health", { noAuth: true });
    setPill(els.connectionState, "API ready", "good");
  } catch (error) {
    setPill(els.connectionState, "API offline", "bad");
    log(error.message);
  }
}

async function initializeFirebase() {
  const firebase = config.firebase || {};
  if (!firebase.apiKey || !firebase.projectId || !firebase.appId) {
    throw new Error("Firebase config is missing");
  }
  const version = config.firebaseSdkVersion || "11.10.0";
  const [{ initializeApp }, authModule] = await Promise.all([
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-app.js`),
    import(`https://www.gstatic.com/firebasejs/${version}/firebase-auth.js`),
  ]);
  const app = initializeApp(firebase);
  state.auth = authModule.getAuth(app);
  await authModule.setPersistence(state.auth, authModule.browserLocalPersistence);
  state.authModule = authModule;
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
      await loadActivePackage();
      await handlePaymentReturn();
    } else {
      setActivePackage(null);
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

async function savePackage() {
  setBusy(true);
  try {
    const input = packageInput();
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
    log("Package saved.");
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
  try {
    const result = await api(`/packages/${encodeURIComponent(id)}`);
    setActivePackage(result.package);
    if (result.input) setPackageInput(result.input);
  } catch (error) {
    log(error.message);
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
    const data = await workerApi("/api/resume-packages/checkout", {
      method: "POST",
      body: JSON.stringify({
        packageId: pkg.id,
        returnUrl: returnUrl(pkg.id),
      }),
    });
    log("Opening Stripe Checkout.");
    window.location.href = data.url;
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
  setBusy(true);
  try {
    const result = await api(`/packages/${encodeURIComponent(saved.id)}/generate`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    setActivePackage(result.package);
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
    log("Revision generated.");
  } catch (error) {
    log(error.message);
  } finally {
    setBusy(false);
  }
}

async function downloadDocx() {
  const pkg = state.activePackage;
  if (!pkg?.latestGenerationId) return;
  setBusy(true);
  try {
    const blob = await api(`/packages/${encodeURIComponent(pkg.id)}/download/docx`, {
      method: "GET",
      blob: true,
      headers: {},
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeFileName(pkg.title || "ResumeDoc packet")}.docx`;
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
  els.fileLabel.textContent = `Reading ${file.name}...`;
  try {
    if (/\.txt$/i.test(file.name) || file.type.startsWith("text/")) {
      const text = await file.text();
      appendWorkHistory(text);
      els.fileLabel.textContent = `${file.name} extracted.`;
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
    els.fileLabel.textContent = `${file.name} extracted.`;
  } catch (error) {
    els.fileLabel.textContent = `${file.name} could not be extracted.`;
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

for (const field of [
  els.fullName,
  els.resumeEmail,
  els.phone,
  els.location,
  els.targetRole,
  els.jobPost,
  els.workHistory,
  els.notes,
  els.revisionText,
]) {
  field.addEventListener("input", render);
}

els.authForm.addEventListener("submit", signIn);
els.createAccountBtn.addEventListener("click", createAccount);
els.googleBtn.addEventListener("click", signInWithGoogle);
els.signOutBtn.addEventListener("click", signOut);
els.savePackageBtn.addEventListener("click", savePackage);
els.checkoutBtn.addEventListener("click", startCheckout);
els.generateBtn.addEventListener("click", generateDocx);
els.downloadBtn.addEventListener("click", downloadDocx);
els.revisionBtn.addEventListener("click", submitRevision);
els.resumeFile.addEventListener("change", () => extractFileText(els.resumeFile.files?.[0]));

render();
checkHealth();
initializeFirebase().catch((error) => {
  log(error.message);
  setPill(els.authState, "Auth failed", "bad");
});
