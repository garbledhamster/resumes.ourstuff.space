const { onRequest } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const crypto = require("node:crypto");
const express = require("express");
const fs = require("node:fs");
const path = require("node:path");
const JSZip = require("jszip");
const sharp = require("sharp");
const pdfParse = require("pdf-parse");
const { DOMParser, XMLSerializer } = require("@xmldom/xmldom");

admin.initializeApp();

const WORKER_INTERNAL_TOKEN_SECRET = defineSecret("WORKER_INTERNAL_TOKEN");
const AI_BRAIN_API_TOKEN_SECRET = defineSecret("AI_BRAIN_API_TOKEN");

const TEMPLATE_PATH = path.join(__dirname, "assets", "interview-packet-template.docx");
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PROMPT_VERSION = "2026-05-26-resumedoc-full-packet";
const RESUMEDOC_APP_ID = "resumedoc";
const JOBEL_NOTE_MARKER = "ai:jobel-note";
const AI_BRAIN_DEFAULT_BASE = "https://api.ourstuff.space/v1";
const SOURCE_ACCENT_HEX = "E97132";
const DEFAULT_ACCENT_HEX = "2563EB";
const SKILL_ITEM_COUNT = 9;
const EXPERIENCE_BULLET_COUNT = 7;
const ABOUT_ME_COUNT = 6;
const STORY_COUNT = 7;
const QUESTION_COUNT = 6;
const COMPANY_FACT_COUNT = 3;
const ROLE_MISSION_COUNT = 2;
const RESPONSIBILITY_COUNT = 7;
const REQUIREMENT_COUNT = 7;
const WHY_JOIN_COUNT = 4;
const REFERENCE_COUNT = 3;
const MAX_TEXT = 70000;
const MAX_FILE_BYTES = 7 * 1024 * 1024;
const LEFTOVER_TERMS = [
  "Joseph",
  "Joe Rice",
  "Computers Nationwide",
  "Gateway Technical College",
  "Gradient Financial",
  "Michael Johnson",
  "System Administrator",
  "IT Generalist",
  "ESXi",
  "Jamf",
  "Rachel [Last Name]",
  "Harbor Freight",
  "Kunes",
];

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "8mb" }));
app.use(corsMiddleware);

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "resumedoc-api",
    promptVersion: PROMPT_VERSION,
  });
});

app.get("/api/me/access", requireActor, asyncHandler(async (req, res) => {
  const result = await workerInternal(req, "/users/self/access");
  res.json({ ok: true, access: result.access });
}));

app.post("/api/packages", requireActor, asyncHandler(async (req, res) => {
  const actor = req.actor;
  const input = normalizeInput(req.body?.input || req.body || {});
  const id = crypto.randomUUID();
  const now = nowIso();
  const inputStoragePath = inputPath(actor.uid, id);
  await saveJson(inputStoragePath, input);
  const pkg = withoutUndefined({
    id,
    ownerUid: actor.uid,
    title: titleFromInput(input),
    status: "draft",
    paymentStatus: "unpaid",
    stripeSessionId: null,
    editsTotal: 5,
    editsUsed: 0,
    latestGenerationId: null,
    inputStoragePath,
    outputStoragePath: null,
    outputJsonPath: null,
    trackerStoragePath: null,
    createdAt: now,
    updatedAt: now,
  });
  await packageRef(id).set(pkg);
  res.status(201).json({ ok: true, package: publicPackage(pkg) });
}));

app.get("/api/packages", requireActor, asyncHandler(async (req, res) => {
  const snap = await db()
    .collection("resume_packages")
    .where("ownerUid", "==", req.actor.uid)
    .limit(60)
    .get();
  const packages = snap.docs
    .map((doc) => publicPackage({ id: doc.id, ...doc.data() }))
    .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
    .slice(0, 30);
  res.json({ ok: true, packages });
}));

app.get("/api/packages/:id", requireActor, asyncHandler(async (req, res) => {
  const pkg = await getOwnedPackage(req.params.id, req.actor.uid);
  const synced = await syncPackageAccess(req, pkg);
  const input = await loadJson(pkg.inputStoragePath, {});
  res.json({ ok: true, package: publicPackage(synced), input });
}));

app.patch("/api/packages/:id", requireActor, asyncHandler(async (req, res) => {
  const actor = req.actor;
  const pkg = await getOwnedPackage(req.params.id, actor.uid);
  const input = normalizeInput(req.body?.input || {});
  const inputStoragePath = pkg.inputStoragePath || inputPath(actor.uid, pkg.id);
  await saveJson(inputStoragePath, input);
  const patch = withoutUndefined({
    title: titleFromInput(input),
    inputStoragePath,
    updatedAt: nowIso(),
  });
  await packageRef(pkg.id).set(patch, { merge: true });
  const updated = { ...pkg, ...patch };
  res.json({ ok: true, package: publicPackage(updated) });
}));

app.get("/api/packages/:id/access", requireActor, asyncHandler(async (req, res) => {
  const pkg = await getOwnedPackage(req.params.id, req.actor.uid);
  const updated = await syncPackageAccess(req, pkg);
  res.json({ ok: true, package: publicPackage(updated), access: accessFromPackage(updated) });
}));

app.post("/api/packages/:id/claim-free", requireActor, asyncHandler(async (req, res) => {
  const pkg = await getOwnedPackage(req.params.id, req.actor.uid);
  const result = await workerInternal(req, `/packages/${encodeURIComponent(pkg.id)}/claim-free`, {
    method: "POST",
    body: {},
  });
  const updated = await applyAccessToPackage(pkg, result.access);
  res.json({ ok: true, package: publicPackage(updated), access: result.access });
}));

app.post("/api/packages/:id/redeem-code", requireActor, asyncHandler(async (req, res) => {
  const pkg = await getOwnedPackage(req.params.id, req.actor.uid);
  const code = cleanBoundedString(req.body?.code, 80);
  if (!code) {
    throw httpError(400, "Code is required.", "missing_code");
  }
  const result = await workerInternal(req, `/packages/${encodeURIComponent(pkg.id)}/redeem-code`, {
    method: "POST",
    body: { code },
  });
  const updated = await applyAccessToPackage(pkg, result.access);
  res.json({ ok: true, package: publicPackage(updated), access: result.access });
}));

app.post("/api/packages/:id/checkout", requireActor, asyncHandler(async (req, res) => {
  const pkg = await getOwnedPackage(req.params.id, req.actor.uid);
  const returnUrl = cleanBoundedString(req.body?.returnUrl, 1200);
  const discountCode = cleanBoundedString(req.body?.discountCode, 80);
  if (!returnUrl) {
    throw httpError(400, "returnUrl is required.", "missing_return_url");
  }
  const checkout = await workerPublic(req, "/api/resume-packages/checkout", {
    method: "POST",
    body: withoutUndefined({
      packageId: pkg.id,
      returnUrl,
      discountCode: discountCode || undefined,
    }),
  });
  if (checkout.access) {
    const updated = await applyAccessToPackage(pkg, checkout.access);
    checkout.package = publicPackage(updated);
  }
  res.status(checkout.checkoutSkipped ? 200 : 201).json({ ok: true, checkout });
}));

app.post("/api/packages/:id/confirm-payment", requireActor, asyncHandler(async (req, res) => {
  const pkg = await getOwnedPackage(req.params.id, req.actor.uid);
  const stripeSessionId = cleanBoundedString(req.body?.stripeSessionId, 160);
  if (!stripeSessionId) {
    throw httpError(400, "stripeSessionId is required", "missing_session");
  }
  const payment = await verifyPaymentWithWorker(req, pkg, stripeSessionId);
  if (!payment.paid) {
    throw httpError(402, "Stripe payment has not completed yet.", "payment_required");
  }
  const accessPatch = accessPatchFromWorker(payment.access, pkg);
  const patch = withoutUndefined({
    ...accessPatch,
    paymentStatus: "paid",
    stripeSessionId,
    paymentConfirmedAt: nowIso(),
    invoiceLabel: payment.invoiceLabel || pkg.invoiceLabel || null,
    updatedAt: nowIso(),
  });
  await packageRef(pkg.id).set(patch, { merge: true });
  res.json({ ok: true, package: publicPackage({ ...pkg, ...patch }), payment });
}));

app.post("/api/packages/:id/generate", requireActor, asyncHandler(async (req, res) => {
  const pkg = await getOwnedPackage(req.params.id, req.actor.uid);
  const unlockedPkg = await requireUnlockedPackage(req, pkg);
  const input = normalizeInput(await loadJson(pkg.inputStoragePath, {}));
  const result = await generateAndStore({
    actor: req.actor,
    pkg: unlockedPkg,
    input,
    revisionInstruction: cleanBoundedString(req.body?.instruction, 2000),
    countRevision: false,
  });
  res.json(result);
}));

app.post("/api/packages/:id/revisions", requireActor, asyncHandler(async (req, res) => {
  const pkg = await getOwnedPackage(req.params.id, req.actor.uid);
  const unlockedPkg = await requireUnlockedPackage(req, pkg);
  if (!pkg.latestGenerationId) {
    throw httpError(409, "Generate the first DOCX before requesting revisions.", "generation_required");
  }
  const editsLeft = Math.max(0, (pkg.editsTotal || 5) - (pkg.editsUsed || 0));
  if (editsLeft <= 0) {
    throw httpError(402, "No included edits remain for this package.", "edits_exhausted");
  }
  const instruction = cleanBoundedString(req.body?.instruction, 2000);
  if (!instruction) {
    throw httpError(400, "Revision instruction is required.", "missing_instruction");
  }
  const input = normalizeInput(await loadJson(pkg.inputStoragePath, {}));
  const result = await generateAndStore({
    actor: req.actor,
    pkg: unlockedPkg,
    input,
    revisionInstruction: instruction,
    countRevision: true,
  });
  res.json(result);
}));

app.get("/api/admin/summary", requireActor, asyncHandler(async (req, res) => {
  const result = await workerInternal(req, "/admin/summary");
  res.json(result);
}));

app.get("/api/admin/users", requireActor, asyncHandler(async (req, res) => {
  const query = cleanBoundedString(req.query?.q, 120);
  const suffix = query ? `?q=${encodeURIComponent(query)}` : "";
  const result = await workerInternal(req, `/admin/users${suffix}`);
  res.json(result);
}));

app.patch("/api/admin/users/:uidHash", requireActor, asyncHandler(async (req, res) => {
  const result = await workerInternal(req, `/admin/users/${encodeURIComponent(req.params.uidHash)}`, {
    method: "PATCH",
    body: {
      freeQuota: optionalNumber(req.body?.freeQuota),
      freeUsed: optionalNumber(req.body?.freeUsed),
      creditBalance: optionalNumber(req.body?.creditBalance),
      userStatus: cleanBoundedString(req.body?.userStatus, 20) || undefined,
      email: cleanBoundedString(req.body?.email, 320) || undefined,
    },
  });
  res.json(result);
}));

app.post("/api/admin/users/:uidHash/reset-free", requireActor, asyncHandler(async (req, res) => {
  const result = await workerInternal(req, `/admin/users/${encodeURIComponent(req.params.uidHash)}/reset-free`, {
    method: "POST",
    body: {},
  });
  res.json(result);
}));

app.get("/api/admin/codes", requireActor, asyncHandler(async (req, res) => {
  const result = await workerInternal(req, "/admin/codes");
  res.json(result);
}));

app.post("/api/admin/codes", requireActor, asyncHandler(async (req, res) => {
  const result = await workerInternal(req, "/admin/codes", {
    method: "POST",
    body: withoutUndefined({
      code: cleanBoundedString(req.body?.code, 80),
      kind: cleanBoundedString(req.body?.kind, 20),
      description: cleanBoundedString(req.body?.description, 180),
      creditAmount: optionalNumber(req.body?.creditAmount),
      maxRedemptions: req.body?.maxRedemptions === null ? null : optionalNumber(req.body?.maxRedemptions),
      percentOff: optionalNumber(req.body?.percentOff),
      amountOff: optionalNumber(req.body?.amountOff),
      currency: cleanBoundedString(req.body?.currency, 10),
    }),
  });
  res.status(201).json(result);
}));

app.patch("/api/admin/codes/:codeId", requireActor, asyncHandler(async (req, res) => {
  const result = await workerInternal(req, `/admin/codes/${encodeURIComponent(req.params.codeId)}`, {
    method: "PATCH",
    body: withoutUndefined({
      status: cleanBoundedString(req.body?.status, 20),
      description: cleanBoundedString(req.body?.description, 180),
    }),
  });
  res.json(result);
}));

app.get("/api/admin/events", requireActor, asyncHandler(async (req, res) => {
  const result = await workerInternal(req, "/admin/events");
  res.json(result);
}));

app.get("/api/packages/:id/download/docx", requireActor, asyncHandler(async (req, res) => {
  const pkg = await getOwnedPackage(req.params.id, req.actor.uid);
  if (!pkg.outputStoragePath) {
    throw httpError(404, "No DOCX has been generated for this package yet.", "docx_not_found");
  }
  const [buffer] = await bucket().file(pkg.outputStoragePath).download();
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  res.setHeader("Content-Disposition", `attachment; filename="${safeFileName(pkg.title || "ResumeDoc packet")}.docx"`);
  res.send(buffer);
}));

app.post("/api/extract", requireActor, asyncHandler(async (req, res) => {
  const fileName = cleanBoundedString(req.body?.fileName, 240);
  const base64 = String(req.body?.base64 || "");
  if (!fileName || !base64) {
    throw httpError(400, "fileName and base64 are required.", "missing_file");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_FILE_BYTES) {
    throw httpError(413, "File is too large for extraction.", "file_too_large");
  }
  const text = await extractTextFromFile(fileName, String(req.body?.contentType || ""), bytes);
  res.json({ ok: true, text: clipText(text, MAX_TEXT) });
}));

app.post("/api/notes/:noteId/sync-brain", requireActor, asyncHandler(async (req, res) => {
  const noteId = cleanBoundedString(req.params.noteId, 160);
  const note = await getOwnedResumeNote(req.actor.uid, noteId);
  if (!note.body && !note.title) {
    throw httpError(400, "Write note content before syncing.", "empty_note");
  }
  const sourceHash = noteSourceHash(note);
  if (shouldSkipBrainSync(note, sourceHash)) {
    res.json({ ok: true, skipped: true, memoryId: note.brainSync.memoryId, sourceHash });
    return;
  }

  const noteRef = resumeNoteRef(req.actor.uid, noteId);
  await noteRef.set({
    brainSync: withoutUndefined({
      ...(note.brainSync || {}),
      status: "pending",
      sourceHash,
      lastAttemptAt: nowIso(),
      errorCode: null,
    }),
  }, { merge: true });

  try {
    const created = await rememberNoteInBrain(note, { sourceHash });
    const patch = {
      brainSync: withoutUndefined({
        status: "synced",
        sourceHash,
        memoryId: created.memoryId || created.memory?.id || null,
        lastAttemptAt: nowIso(),
        syncedAt: nowIso(),
        errorCode: null,
      }),
    };
    await noteRef.set(patch, { merge: true });
    res.json({ ok: true, skipped: false, memoryId: patch.brainSync.memoryId, sourceHash });
  } catch (error) {
    await noteRef.set({
      brainSync: withoutUndefined({
        ...(note.brainSync || {}),
        status: "failed",
        sourceHash,
        lastAttemptAt: nowIso(),
        syncedAt: null,
        errorCode: error.code || "brain_sync_failed",
      }),
    }, { merge: true });
    throw error;
  }
}));

app.post("/api/jobel/chat", requireActor, asyncHandler(async (req, res) => {
  const message = cleanBoundedString(req.body?.message, 900);
  if (!message) {
    throw httpError(400, "Message Jobel before sending.", "missing_message");
  }
  assertNoBlockedSecrets(message);
  const packageId = cleanBoundedString(req.body?.packageId, 160);
  const noteIds = Array.isArray(req.body?.noteIds)
    ? req.body.noteIds.map((id) => cleanBoundedString(id, 160)).filter(Boolean).slice(0, 12)
    : [];
  const pkg = packageId ? await getOwnedPackage(packageId, req.actor.uid).catch(() => null) : null;
  const input = pkg?.inputStoragePath ? normalizeInput(await loadJson(pkg.inputStoragePath, {})) : {};
  const notes = await loadResumeNotesForJobel(req.actor.uid, noteIds);
  const prompt = await buildJobelPrompt({
    message,
    input,
    packageInfo: pkg ? publicPackage(pkg) : null,
    notes,
  });
  const reply = await generateJobelReply(prompt);
  res.json({ ok: true, reply });
}));

app.use((req, res) => {
  res.status(404).json({ ok: false, error: { code: "not_found", message: `Route not found: ${req.path}` } });
});

app.use((error, _req, res, _next) => {
  const status = error.statusCode || 500;
  const code = error.code || "internal";
  const message = status >= 500 ? "ResumeDoc could not finish that request." : error.message;
  if (status >= 500) {
    console.error(error);
  }
  res.status(status).json({ ok: false, error: { code, message } });
});

exports.resumeApi = onRequest(
  {
    cors: false,
    timeoutSeconds: 540,
    memory: "1GiB",
    maxInstances: 10,
    secrets: [WORKER_INTERNAL_TOKEN_SECRET, AI_BRAIN_API_TOKEN_SECRET],
  },
  app,
);

exports._test = {
  buildDocx,
  buildBrainNoteText,
  buildJobelPrompt,
  rememberNoteInBrain,
  localResponseFromInput,
  normalizeInput,
  normalizeResumeNote,
  noteSourceHash,
  shouldSkipBrainSync,
  validateResponse,
  extractDocxText,
};

function corsMiddleware(req, res, next) {
  const origin = req.headers.origin || "";
  if (isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }
  next();
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return (
    /^https:\/\/([a-z0-9-]+\.)?ourstuff\.space$/i.test(origin) ||
    /^http:\/\/localhost:\d+$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1:\d+$/i.test(origin)
  );
}

function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

async function requireActor(req, _res, next) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
    if (!token) {
      throw httpError(401, "Sign in with Firebase to continue.", "auth_required");
    }
    if (token === "dev-local-token" && isDevAuthAllowed()) {
      req.actor = {
        uid: "dev-local-user",
        email: "dev-local@example.com",
        emailVerified: true,
        token,
      };
      next();
      return;
    }
    const decoded = await admin.auth().verifyIdToken(token);
    req.actor = {
      uid: decoded.uid,
      email: decoded.email || null,
      emailVerified: decoded.email_verified === true,
      token,
    };
    next();
  } catch (error) {
    next(error.code ? error : httpError(401, error.message || "Firebase token is invalid.", "invalid_token"));
  }
}

function isDevAuthAllowed() {
  return process.env.FUNCTIONS_EMULATOR === "true" || process.env.RESUME_DEV_AUTH === "true";
}

function db() {
  return admin.firestore();
}

function bucket() {
  return admin.storage().bucket();
}

function packageRef(id) {
  return db().collection("resume_packages").doc(id);
}

function resumeNoteRef(uid, noteId) {
  return db().collection("users").doc(uid).collection("apps").doc(RESUMEDOC_APP_ID).collection("notes").doc(noteId);
}

async function getOwnedPackage(id, ownerUid) {
  const snap = await packageRef(id).get();
  if (!snap.exists) {
    throw httpError(404, "Resume package was not found.", "package_not_found");
  }
  const pkg = snap.data();
  if (pkg.ownerUid !== ownerUid) {
    throw httpError(404, "Resume package was not found.", "package_not_found");
  }
  return { ...pkg, id: snap.id };
}

async function getOwnedResumeNote(uid, noteId) {
  const snap = await resumeNoteRef(uid, noteId).get();
  if (!snap.exists) {
    throw httpError(404, "Resume note was not found.", "note_not_found");
  }
  const note = normalizeResumeNote({ id: snap.id, ...snap.data() });
  if (note.owner !== uid) {
    throw httpError(404, "Resume note was not found.", "note_not_found");
  }
  return note;
}

async function loadResumeNotesForJobel(uid, noteIds) {
  const notes = [];
  if (noteIds.length) {
    for (const noteId of noteIds) {
      try {
        notes.push(await getOwnedResumeNote(uid, noteId));
      } catch {}
    }
    return notes.slice(0, 12);
  }
  const snap = await db()
    .collection("users")
    .doc(uid)
    .collection("apps")
    .doc(RESUMEDOC_APP_ID)
    .collection("notes")
    .orderBy("updatedAt", "desc")
    .limit(12)
    .get();
  return snap.docs.map((docSnap) => normalizeResumeNote({ id: docSnap.id, ...docSnap.data() }));
}

function normalizeResumeNote(raw = {}) {
  const metadata = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {};
  const isJobel = metadata.source === "jobel" || metadata.marker === JOBEL_NOTE_MARKER;
  const brainSync = raw.brainSync && typeof raw.brainSync === "object" ? raw.brainSync : {};
  return {
    id: cleanBoundedString(raw.id, 160),
    owner: cleanBoundedString(raw.owner, 160),
    appId: cleanBoundedString(raw.appId, 80) || RESUMEDOC_APP_ID,
    packageId: cleanBoundedString(raw.packageId, 160),
    title: cleanBoundedString(raw.title, 120),
    body: clipText(asText(raw.body), 12000),
    createdAt: cleanBoundedString(raw.createdAt, 80),
    updatedAt: cleanBoundedString(raw.updatedAt, 80),
    metadata: {
      source: isJobel ? "jobel" : "user",
      marker: isJobel ? JOBEL_NOTE_MARKER : metadata.marker || null,
      readOnly: isJobel || metadata.readOnly === true,
      contentFormat: metadata.contentFormat === "markdown" ? "markdown" : "plain",
    },
    syncToBrain: raw.syncToBrain === true,
    brainSync: {
      status: ["not_synced", "pending", "synced", "failed"].includes(brainSync.status) ? brainSync.status : "not_synced",
      sourceHash: brainSync.sourceHash || null,
      memoryId: brainSync.memoryId || null,
      lastAttemptAt: brainSync.lastAttemptAt || null,
      syncedAt: brainSync.syncedAt || null,
      errorCode: brainSync.errorCode || null,
    },
  };
}

async function requireUnlockedPackage(req, pkg) {
  if (localPaymentBypass()) {
    return { ...pkg, paymentStatus: "paid", accessStatus: "active", accessSource: "local" };
  }
  const updated = await syncPackageAccess(req, pkg);
  if (updated.accessStatus !== "active") {
    throw httpError(402, "Unlock this resume package before generating the DOCX.", "access_required");
  }
  return updated;
}

function localPaymentBypass() {
  return process.env.RESUME_LOCAL_PAYMENT_BYPASS === "true" && isDevAuthAllowed();
}

async function verifyPaymentWithWorker(req, pkg, stripeSessionId) {
  if (localPaymentBypass() && stripeSessionId === "dev-paid") {
    return { paid: true, packageId: pkg.id, invoiceLabel: "DEV-000001" };
  }
  const base = paymentsWorkerBase();
  const url = `${base}/api/resume-packages/${encodeURIComponent(pkg.id)}/payment?session_id=${encodeURIComponent(stripeSessionId)}`;
  const response = await fetch(url, {
    headers: {
      Authorization: req.headers.authorization || "",
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw httpError(response.status, data?.error?.message || "Could not verify Stripe payment.", data?.error?.code || "payment_verify_failed");
  }
  return data;
}

async function syncPackageAccess(req, pkg) {
  if (localPaymentBypass()) {
    return pkg;
  }
  const result = await workerInternal(req, `/packages/${encodeURIComponent(pkg.id)}/access`);
  return applyAccessToPackage(pkg, result.access);
}

async function applyAccessToPackage(pkg, access) {
  const patch = accessPatchFromWorker(access, pkg);
  if (!Object.keys(patch).length) {
    return pkg;
  }
  await packageRef(pkg.id).set(patch, { merge: true });
  return { ...pkg, ...patch };
}

function accessPatchFromWorker(access, pkg = {}) {
  const packageAccess = access?.package;
  if (!packageAccess) return {};
  const unlocked = packageAccess.unlocked === true || packageAccess.accessStatus === "active";
  const source = packageAccess.accessSource || null;
  return withoutUndefined({
    accessStatus: unlocked ? "active" : "locked",
    accessSource: source,
    entitlementId: packageAccess.entitlementId || null,
    checkoutSessionId: packageAccess.checkoutSessionId || pkg.checkoutSessionId || null,
    invoiceLabel: packageAccess.invoiceLabel || pkg.invoiceLabel || null,
    paymentStatus: unlocked ? (source && source.startsWith("stripe") ? "paid" : "unlocked") : pkg.paymentStatus || "unpaid",
    updatedAt: nowIso(),
  });
}

function accessFromPackage(pkg) {
  return {
    package: {
      packageId: pkg.id,
      unlocked: pkg.accessStatus === "active" || pkg.paymentStatus === "paid",
      accessStatus: pkg.accessStatus || (pkg.paymentStatus === "paid" ? "active" : "locked"),
      accessSource: pkg.accessSource || null,
      entitlementId: pkg.entitlementId || null,
      invoiceLabel: pkg.invoiceLabel || null,
      checkoutSessionId: pkg.checkoutSessionId || pkg.stripeSessionId || null,
    },
  };
}

async function workerInternal(req, path, options = {}) {
  const token = process.env.WORKER_INTERNAL_TOKEN || process.env.RESUMEDOC_WORKER_INTERNAL_TOKEN;
  if (!token) {
    throw httpError(500, "WORKER_INTERNAL_TOKEN is not configured for ResumeDoc.", "missing_worker_internal_token");
  }
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "x-resumedoc-uid": req.actor.uid,
    "x-resumedoc-email": req.actor.email || "",
    "x-resumedoc-email-verified": req.actor.emailVerified ? "true" : "false",
  };
  return workerFetch(`/api/internal/resumedoc${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function workerPublic(req, path, options = {}) {
  return workerFetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: req.headers.authorization || "",
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function workerFetch(path, options = {}) {
  const base = paymentsWorkerBase();
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw httpError(
      response.status,
      data?.error?.message || data?.message || data?.raw || "Worker request failed.",
      data?.error?.code || "worker_request_failed",
    );
  }
  return data;
}

function paymentsWorkerBase() {
  return (process.env.PAYMENTS_WORKER_BASE || "https://stripe-worker-api.jrice.workers.dev").replace(/\/$/, "");
}

async function saveJson(storagePath, value) {
  await bucket().file(storagePath).save(JSON.stringify(value, null, 2), {
    resumable: false,
    metadata: {
      contentType: "application/json; charset=utf-8",
      cacheControl: "private, no-store",
    },
  });
}

async function loadJson(storagePath, fallback) {
  if (!storagePath) return fallback;
  try {
    const [buffer] = await bucket().file(storagePath).download();
    return JSON.parse(buffer.toString("utf8"));
  } catch (error) {
    if (fallback !== undefined) return fallback;
    throw error;
  }
}

function inputPath(uid, packageId) {
  return `resume-packages/${uid}/${packageId}/input.json`;
}

function outputPath(uid, packageId, generationId, ext) {
  return `resume-packages/${uid}/${packageId}/generations/${generationId}/packet.${ext}`;
}

async function generateAndStore({ actor, pkg, input, revisionInstruction, countRevision }) {
  const generationId = crypto.randomUUID();
  const response = await buildPacketResponse(input, revisionInstruction);
  const { docx, trackerPng } = await buildDocx(response, input);
  const docxPath = outputPath(actor.uid, pkg.id, generationId, "docx");
  const jsonPath = outputPath(actor.uid, pkg.id, generationId, "json");
  const trackerPath = outputPath(actor.uid, pkg.id, generationId, "png");
  await bucket().file(docxPath).save(docx, {
    resumable: false,
    metadata: {
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      cacheControl: "private, no-store",
    },
  });
  await saveJson(jsonPath, response);
  await bucket().file(trackerPath).save(trackerPng, {
    resumable: false,
    metadata: { contentType: "image/png", cacheControl: "private, no-store" },
  });
  const now = nowIso();
  const patch = withoutUndefined({
    status: "generated",
    latestGenerationId: generationId,
    outputStoragePath: docxPath,
    outputJsonPath: jsonPath,
    trackerStoragePath: trackerPath,
    editsUsed: countRevision ? (pkg.editsUsed || 0) + 1 : pkg.editsUsed || 0,
    updatedAt: now,
    generatedAt: now,
    generatorVersion: PROMPT_VERSION,
    lastError: null,
  });
  await packageRef(pkg.id).set(patch, { merge: true });
  await packageRef(pkg.id).collection("generations").doc(generationId).set(withoutUndefined({
    id: generationId,
    ownerUid: actor.uid,
    packageId: pkg.id,
    docxPath,
    jsonPath,
    trackerPath,
    revisionInstruction: revisionInstruction || null,
    promptVersion: PROMPT_VERSION,
    createdAt: now,
  }));
  return { ok: true, package: publicPackage({ ...pkg, ...patch }), generationId };
}

async function buildPacketResponse(input, revisionInstruction) {
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const [systemPrompt, userPrompt] = buildPrompt(input, revisionInstruction);
      const response = await callOpenRouter(systemPrompt, userPrompt);
      return validateResponse(response, input);
    } catch (error) {
      console.warn("openrouter_generation_failed", error.message);
      if (process.env.RESUME_REQUIRE_OPENROUTER === "true") {
        throw error;
      }
    }
  }
  return validateResponse(localResponseFromInput(input, revisionInstruction), input);
}

function noteSourceHash(note) {
  return sha256Json({
    title: note.title || "",
    body: note.body || "",
    packageId: note.packageId || "",
    source: note.metadata?.source || "user",
  });
}

function shouldSkipBrainSync(note, sourceHash = noteSourceHash(note)) {
  return Boolean(note.brainSync?.status === "synced" && note.brainSync?.sourceHash === sourceHash && note.brainSync?.memoryId);
}

function sha256Json(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function buildBrainNoteText(note) {
  return [
    "ResumeDoc note",
    note.title ? `Title: ${note.title}` : "",
    note.packageId ? `Package: ${note.packageId}` : "",
    note.metadata?.source ? `Source: ${note.metadata.source}` : "",
    "",
    note.body || "",
  ].filter((line) => line !== "").join("\n");
}

async function rememberNoteInBrain(note, { sourceHash }) {
  assertNoBlockedSecrets(`${note.title}\n${note.body}`);
  const scrubbed = await scrubWithAiBrain(buildBrainNoteText(note));
  if (scrubbed.blocked) {
    throw httpError(422, "This note contains content that cannot be synced to AI Brain.", "blocked_sensitive_note");
  }
  return aiBrainFetch("/remember", {
    projectSlug: "resumes.ourstuff.space",
    sourceApp: "browser",
    sourceUrl: "https://resumes.ourstuff.space",
    text: scrubbed.scrubbedText || scrubbed.text || "",
    userSuggestedCategory: "01 Projects",
    userSuggestedTags: ["resumedoc", "resume-note", sourceHash.slice(0, 12)],
    allowRawStorage: false,
    allowedConsumers: ["chatgpt", "codex", "mort", "mcp"],
  });
}

async function scrubWithAiBrain(text) {
  const result = await aiBrainFetch("/scrub", { text });
  return {
    ...result,
    scrubbedText: result.scrubbedText || result.text || "",
    blocked: result.blocked === true,
  };
}

async function aiBrainFetch(pathSuffix, body) {
  const token = process.env.AI_BRAIN_API_TOKEN || process.env.AIBRAIN_API_TOKEN;
  if (!token) {
    throw httpError(503, "AI Brain token is not configured.", "missing_ai_brain_token");
  }
  const response = await fetch(`${aiBrainBase()}${pathSuffix}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    throw httpError(
      response.status,
      data?.error?.message || data?.message || data?.raw || "AI Brain request failed.",
      data?.error?.code || "ai_brain_request_failed",
    );
  }
  return data;
}

function aiBrainBase() {
  return (process.env.AI_BRAIN_API_BASE || AI_BRAIN_DEFAULT_BASE).replace(/\/$/, "");
}

async function buildJobelPrompt({ message, input, packageInfo, notes }) {
  assertNoBlockedSecrets(message);
  const scrubbedMessage = await scrubWithAiBrain(message);
  if (scrubbedMessage.blocked) {
    throw httpError(422, "This message contains content that cannot be sent to Jobel.", "blocked_sensitive_message");
  }
  const scrubbedNotes = [];
  for (const note of notes.slice(0, 12)) {
    assertNoBlockedSecrets(`${note.title}\n${note.body}`);
    const scrubbed = await scrubWithAiBrain([note.title, note.body].filter(Boolean).join("\n"));
    if (!scrubbed.blocked) {
      scrubbedNotes.push({
        id: note.id,
        source: note.metadata?.source || "user",
        title: note.title || "",
        text: scrubbed.scrubbedText,
        updatedAt: note.updatedAt || note.createdAt || "",
      });
    }
  }
  const resumeContext = await scrubWithAiBrain(compactJobelResumeContext(input));
  const payload = {
    userMessage: scrubbedMessage.scrubbedText,
    resumePackage: packageInfo ? {
      id: packageInfo.id,
      status: packageInfo.status,
      generatedAt: packageInfo.generatedAt || null,
    } : null,
    resumeContext: resumeContext.blocked ? "" : resumeContext.scrubbedText,
    notes: scrubbedNotes,
  };
  return [
    "You are Jobel, a practical resume-development assistant for ResumeDoc.",
    "Use only the scrubbed user message, scrubbed notes, and scrubbed resume context provided.",
    "Do not invent work history, employers, degrees, dates, certifications, metrics, or claims.",
    "If a needed fact is missing, ask for it directly.",
    "Be concise, specific, and action-oriented. Return markdown only.",
    "Do not mention privacy scrubbing unless the user asks.",
    "",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function compactJobelResumeContext(input = {}) {
  return JSON.stringify({
    targetRole: input.targetRole || "",
    jobPost: clipText(input.jobPost || "", 6000),
    workHistory: clipText(input.workHistory || "", 8000),
    notes: clipText(input.notes || "", 2000),
  });
}

async function generateJobelReply(prompt) {
  if (!process.env.OPENROUTER_API_KEY) {
    return localJobelReply(prompt);
  }
  const content = await callOpenRouterText(
    [
      "You are Jobel, a resume-development coach inside ResumeDoc.",
      "Never invent candidate facts.",
      "Use short markdown paragraphs or bullets.",
    ].join(" "),
    prompt,
  );
  return clipText(content, 3000, "Jobel could not produce a reply.");
}

async function callOpenRouterText(systemPrompt, userPrompt) {
  const payload = {
    model: process.env.OPENROUTER_MODEL || "openrouter/auto",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.25,
    max_tokens: 1200,
  };
  const raw = await postOpenRouter(payload);
  const data = JSON.parse(raw);
  const content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === "object" ? part.text || "" : String(part))).join("\n").trim();
  }
  return String(content || "").trim();
}

function localJobelReply(prompt) {
  let payload = {};
  try {
    const start = prompt.indexOf("{");
    payload = start >= 0 ? JSON.parse(prompt.slice(start)) : {};
  } catch {}
  const message = String(payload.userMessage || "").slice(0, 180);
  const hasNotes = Array.isArray(payload.notes) && payload.notes.length > 0;
  return [
    "### Jobel note",
    message ? `I would start by tightening the resume around this request: ${message}` : "I would start by tightening the resume around the target role.",
    hasNotes
      ? "- I can use the saved notes as supporting evidence, but I will not turn them into claims unless the note gives a concrete fact."
      : "- Add one or two notes with specific wins, tools, dates, or constraints so I can help shape stronger resume bullets.",
    "- Next best step: add measurable outcomes where you know them, and mark unknowns as questions instead of guessing.",
  ].join("\n");
}

function assertNoBlockedSecrets(text) {
  const value = String(text || "");
  const patterns = [
    /\b(?:\d[ -]*?){13,19}\b/,
    /\b(?:cvv|cvc|security code)\b/i,
    /\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_.-]{16,}/i,
  ];
  if (patterns.some((pattern) => pattern.test(value))) {
    throw httpError(422, "This request contains content that cannot be sent to AI.", "blocked_secret_detected");
  }
}

function buildPrompt(input, revisionInstruction) {
  const systemPrompt = [
    "You generate a complete Word resume and interview-prep packet from a candidate profile and one job posting.",
    "Return strict JSON only. Do not use markdown fences.",
    "Use public web research only for company/job context.",
    "Do not invent candidate facts, degrees, dates, certifications, or employers.",
    "Keep output concise enough to fit the existing packet template.",
  ].join(" ");
  const userPrompt = {
    prompt_version: PROMPT_VERSION,
    task: "Fill every dynamic section of the ResumeDoc Word packet for this candidate and job posting.",
    candidate_input: {
      fullName: input.fullName,
      email: input.email,
      phone: input.phone,
      location: input.location,
      targetRole: input.targetRole,
      workHistory: input.workHistory,
      notes: input.notes,
    },
    job_description_or_posting: input.jobPost,
    revision_instruction: revisionInstruction || "",
    output_schema: outputSchema(),
    required_counts: requiredCounts(),
    hard_rules: [
      "Return one JSON object with keys: company, role, output_file_label, page_1, skill_tracker, interview_prep, company_role_brief, profile_cards, references, match_rationale, research_sources.",
      "Use the candidate's actual name and contact fields only in document fields where appropriate.",
      "Use placeholders for unknown private details.",
      "Do not invent degrees, certifications, exact dates, software systems, employers, or metrics.",
      "If a candidate field is unclear, write a conservative placeholder instead of guessing.",
      "If public web research finds no named interviewer, use Hiring Team.",
      "Keep story and question text short enough for a one-page interview prep sheet.",
      "Use ASCII hyphens instead of long dash characters.",
    ],
  };
  return [systemPrompt, JSON.stringify(userPrompt, null, 2)];
}

async function callOpenRouter(systemPrompt, userPrompt) {
  const payload = {
    model: process.env.OPENROUTER_MODEL || "openrouter/auto",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.3,
    max_tokens: 7000,
    response_format: { type: "json_object" },
    tools: [
      {
        type: "openrouter:web_search",
        parameters: {
          max_results: 5,
          max_total_results: 10,
          search_context_size: "low",
        },
      },
    ],
  };
  const raw = await postOpenRouter(payload).catch(async (error) => {
    const message = String(error.message || "");
    const fallback = JSON.parse(JSON.stringify(payload));
    if (message.includes("response_format")) {
      delete fallback.response_format;
      return postOpenRouter(fallback);
    }
    if (message.includes("openrouter:web_search") || message.includes("tools")) {
      delete fallback.tools;
      fallback.plugins = [{ id: "web", max_results: 5 }];
      return postOpenRouter(fallback);
    }
    throw error;
  });
  const data = JSON.parse(raw);
  let content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    content = content.map((part) => (typeof part === "object" ? part.text || "" : String(part))).join("");
  }
  return parseJsonObject(String(content || ""));
}

async function postOpenRouter(payload) {
  const response = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://resumes.ourstuff.space",
      "X-Title": "ResumeDoc",
    },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`OpenRouter request failed: HTTP ${response.status} ${text.slice(0, 700)}`);
  }
  return text;
}

function parseJsonObject(text) {
  let cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (!cleaned.startsWith("{")) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) cleaned = cleaned.slice(start, end + 1);
  }
  const parsed = JSON.parse(cleaned);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Model JSON response was not an object.");
  }
  return parsed;
}

function localResponseFromInput(input, revisionInstruction) {
  const job = extractJobContext(input.jobPost, input.targetRole);
  const role = input.targetRole || job.role || "Target Role";
  const company = job.company || "Target Company";
  const skills = inferSkills(input, job);
  const refs = defaultReferences();
  const revisionNote = revisionInstruction ? ` Revision focus: ${revisionInstruction}` : "";
  return {
    company,
    role,
    output_file_label: `${company} ${role}`,
    page_1: {
      role_title: role.toUpperCase(),
      role_subtitle: "Role-Focused Resume Packet",
      skills_section_title: "TARGET ROLE SKILLS",
      experience_section_title: "RELEVANT EXPERIENCE",
      summary: clipText(
        `${input.fullName || "The candidate"} is targeting a ${role} role with experience and strengths drawn from the provided work history. This packet emphasizes practical fit for ${company}, including ${skills.slice(0, 4).join(", ")}, reliable follow-through, and readiness to contribute with clear communication and careful execution.${revisionNote}`,
        620,
      ),
      skill_items: skills.slice(0, SKILL_ITEM_COUNT).map((skill) => ({
        label: skill,
        value: skillValue(skill, job),
      })),
      experience_bullets: buildExperienceBullets(input, role, company),
    },
    skill_tracker: {
      headline: `${role} Match Tracker`,
      match_summary: `${input.fullName || "The candidate"} matches ${company}'s ${role} needs through transferable experience, role-specific keywords, and practical examples from the supplied history.`,
      strongest_skills: skills.slice(0, 5),
      transferable_evidence: [
        "Experience and achievements supplied in the resume history.",
        "Job-specific language drawn from the target posting.",
        "Documented responsibilities, tools, projects, or outcomes from the candidate input.",
        "Clear direction and constraints captured in the package brief.",
      ],
      growth_areas: [
        "Confirm exact dates and metrics before submitting.",
        "Tune examples for the specific hiring manager.",
        "Prepare concise stories for the role's top requirements.",
      ],
      talking_points: [
        `I am interested in this ${role} role because it fits my experience and goals.`,
        "I can connect my prior work to the responsibilities in this posting.",
        "I am careful about accuracy and clear communication.",
        "I am ready to discuss concrete examples from my background.",
      ],
    },
    interview_prep: {
      title: "Interview Reference Sheet",
      about_heading: "About Me:",
      about_me: [
        `${input.fullName || "Candidate"} is targeting ${role} opportunities.`,
        `Location/contact: ${input.location || "[location]"} | ${input.email || "[email]"} | ${input.phone || "[phone]"}.`,
        `Strongest fit themes: ${skills.slice(0, 4).join(", ")}.`,
        "Work history and achievements should be discussed using the examples supplied in the resume brief.",
        "Focus on honest, specific examples rather than invented metrics or dates.",
        "Bring the final DOCX packet and confirm any placeholders before applying.",
      ],
      why_heading: `Why ${company}:`,
      why_company: `${company}'s ${role} posting lines up with the candidate's provided experience and target direction. The strongest pitch is practical fit: relevant skills, clear examples, and a thoughtful understanding of the role's responsibilities.`,
      stories_heading: "Stories:",
      stories: buildStories(input, role),
      questions_heading: "Questions:",
      questions: [
        "What would success look like in the first 30 to 60 days?",
        "Which responsibilities are most important for this role right away?",
        "What tools, systems, or processes should a new hire learn first?",
        "How does the team communicate when priorities change?",
        "What qualities make someone especially successful here?",
        "Are there growth paths or additional responsibilities over time?",
      ],
      footer: `${company}     |     ${role} Role`,
    },
    company_role_brief: {
      header: `${company}     |     ${role} Role`,
      about_heading: `About ${company}`,
      about_company: [
        `Hiring for a ${role} role.`,
        "The job posting identifies the responsibilities and requirements used for this packet.",
        `The candidate should verify current company details before the interview.`,
      ],
      role_mission_heading: "Role Mission",
      role_mission: [
        `Contribute effectively in the ${role} role using the candidate's documented skills and experience.`,
        "Learn the team's processes, communicate clearly, and deliver reliable work.",
      ],
      responsibilities_heading: "Key Responsibilities",
      key_responsibilities: padList(job.responsibilities, RESPONSIBILITY_COUNT, [
        "Communicate clearly with customers, coworkers, or stakeholders.",
        "Follow procedures and keep work organized.",
        "Use role-specific tools, systems, or documentation carefully.",
        "Solve practical problems and ask good questions.",
        "Maintain accuracy in daily tasks and records.",
        "Support team priorities during busy periods.",
        "Finish assigned work with dependable follow-through.",
      ]),
      requirements_heading: "What They Are Looking For",
      what_they_are_looking_for: padList(job.requirements, REQUIREMENT_COUNT, [
        "Relevant experience connected to the role.",
        "Dependable communication and follow-through.",
        "Ability to learn employer-specific systems.",
        "Careful attention to detail.",
        "Professional judgment and problem solving.",
        "Customer or stakeholder awareness.",
        "Readiness to grow into the position.",
      ]),
      why_join_heading: "Why Join?",
      why_join: [
        "Opportunity to use relevant experience in a targeted role.",
        "Chance to build momentum with a company-specific resume.",
        "Practical work tied to clear responsibilities.",
        "Room to prepare stronger interview stories from real examples.",
      ],
    },
    profile_cards: {
      interviewer: {
        section_title: "Interviewer",
        name: "Hiring Team",
        title: `${company} | ${role}`,
        summary: `Prepare for a practical conversation about fit, examples, strengths, constraints, and how the candidate would approach the ${role} responsibilities.`,
      },
      interviewee: {
        section_title: "Interviewee",
        name: input.fullName || "[Full Name]",
        title: `${role} Candidate`,
        summary: `${input.fullName || "The candidate"} is applying for ${company}'s ${role} role with a packet tailored from the supplied resume history, job posting, and direction.`,
      },
    },
    references: { heading: "References", items: refs },
    match_rationale: [
      "Local fallback packet generated directly from the submitted resume details and job posting.",
      "No unavailable degrees, dates, employers, metrics, or certifications were invented.",
    ],
    research_sources: [],
  };
}

function validateResponse(data, input) {
  for (const key of ["company", "role", "output_file_label"]) {
    if (!asText(data[key])) throw new Error(`Response missing required value: ${key}`);
  }
  const page = requireObject(data, "page_1");
  const tracker = requireObject(data, "skill_tracker");
  const prep = requireObject(data, "interview_prep");
  const brief = requireObject(data, "company_role_brief");
  const cards = requireObject(data, "profile_cards");
  if (!data.references || typeof data.references !== "object") {
    data.references = { heading: "References", items: defaultReferences() };
  }
  requireExactList(page.skill_items, SKILL_ITEM_COUNT, "page_1.skill_items");
  requireExactList(page.experience_bullets, EXPERIENCE_BULLET_COUNT, "page_1.experience_bullets");
  requireMaxList(tracker.strongest_skills, 5, "skill_tracker.strongest_skills");
  requireMaxList(tracker.transferable_evidence, 4, "skill_tracker.transferable_evidence");
  requireMaxList(tracker.growth_areas, 3, "skill_tracker.growth_areas");
  requireMaxList(tracker.talking_points, 4, "skill_tracker.talking_points");
  requireExactList(prep.about_me, ABOUT_ME_COUNT, "interview_prep.about_me");
  requireExactList(prep.stories, STORY_COUNT, "interview_prep.stories");
  requireExactList(prep.questions, QUESTION_COUNT, "interview_prep.questions");
  requireExactList(brief.about_company, COMPANY_FACT_COUNT, "company_role_brief.about_company");
  requireExactList(brief.role_mission, ROLE_MISSION_COUNT, "company_role_brief.role_mission");
  requireExactList(brief.key_responsibilities, RESPONSIBILITY_COUNT, "company_role_brief.key_responsibilities");
  requireExactList(brief.what_they_are_looking_for, REQUIREMENT_COUNT, "company_role_brief.what_they_are_looking_for");
  requireExactList(brief.why_join, WHY_JOIN_COUNT, "company_role_brief.why_join");
  for (const key of ["interviewer", "interviewee"]) {
    if (!cards[key] || !asText(cards[key].name) || !asText(cards[key].summary)) {
      throw new Error(`profile_cards.${key} must include name and summary.`);
    }
  }
  if (!Array.isArray(data.references.items) || data.references.items.length === 0) {
    data.references.items = defaultReferences();
  }
  if (data.references.items.length > REFERENCE_COUNT) {
    data.references.items = data.references.items.slice(0, REFERENCE_COUNT);
  }
  while (data.references.items.length < REFERENCE_COUNT) {
    data.references.items.push(defaultReferences()[data.references.items.length]);
  }
  data.profile_cards.interviewee.name = data.profile_cards.interviewee.name || input.fullName || "[Full Name]";
  return data;
}

async function buildDocx(response, input) {
  const template = fs.readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(template);
  const xmlPath = "word/document.xml";
  const relsPath = "word/_rels/document.xml.rels";
  const xml = await zip.file(xmlPath).async("string");
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  const body = firstByLocalName(dom, "body");
  const topParagraphs = directChildren(body, "p");
  const firstTable = directChildren(body, "tbl")[0];
  if (!firstTable) throw new Error("Template first-page table was not found.");

  applyPageOne(firstTable, topParagraphs, response, input);
  applyInterviewPrep(topParagraphs, response);
  applyCompanyRoleBrief(topParagraphs, response);
  applyProfileCards(topParagraphs, response, input);
  applyReferences(topParagraphs, response);
  removeEmbeddedTrackerParagraph(body);
  ensureSectionPageBreaks(dom, body, response);
  updateImageAltText(dom, response, input);

  let updatedXml = new XMLSerializer().serializeToString(dom);
  updatedXml = replaceAccent(updatedXml, SOURCE_ACCENT_HEX, sanitizeHex(input.accentHex || DEFAULT_ACCENT_HEX));
  updatedXml = scrubSourceTemplateTermsXml(updatedXml, response, input);
  scanLeftoversXml(updatedXml, response, input);
  zip.file(xmlPath, updatedXml);

  const modifiedDom = new DOMParser().parseFromString(updatedXml, "application/xml");
  const relTargets = await imageTargetsFromDocument(zip, relsPath, modifiedDom);
  const accent = sanitizeHex(input.accentHex || DEFAULT_ACCENT_HEX);
  const interviewer = response.profile_cards.interviewer || {};
  const interviewee = response.profile_cards.interviewee || {};
  const replacementImages = [
    await renderProfileImage(interviewer.name || "Hiring Team", interviewer.title || response.company, accent, false),
    await renderProfileImage(interviewee.name || input.fullName || "Candidate", interviewee.title || response.role, accent, true),
  ];
  for (let index = 0; index < Math.min(relTargets.length, replacementImages.length); index += 1) {
    zip.file(relTargets[index], replacementImages[index]);
  }
  const docx = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const trackerPng = await renderTrackerImage(response, accent);
  return { docx, trackerPng };
}

function applyPageOne(table, topParagraphs, response, input) {
  const rows = directChildren(table, "tr");
  const headerCell = firstCell(rows[0]);
  const bodyCell = firstCell(rows[1]);
  const experienceCell = firstCell(rows[2]);
  const headerParas = directChildren(headerCell, "p");
  const bodyParas = directChildren(bodyCell, "p");
  const experienceParas = directChildren(experienceCell, "p");
  const page = response.page_1;

  setParagraphText(headerParas[0], clipText(page.role_title, 45).toUpperCase());
  setParagraphText(headerParas[1], clipText(page.role_subtitle, 60));
  setParagraphText(bodyParas[1], clipText(page.summary, 640));
  setParagraphText(bodyParas[3], clipText(page.skills_section_title || "TARGET ROLE SKILLS", 60).toUpperCase());
  page.skill_items.forEach((item, offset) => {
    setParagraphText(bodyParas[5 + offset], `${clipText(item.label, 26)}: ${clipText(item.value, 120)}`);
  });

  setParagraphText(experienceParas[1], clipText(page.experience_section_title || "RELEVANT EXPERIENCE", 60).toUpperCase());
  setParagraphText(experienceParas[3], input.targetRole || "Target Role");
  setParagraphText(experienceParas[4], asText(response.company, "Target Company"));
  setParagraphText(experienceParas[5], "Candidate-provided work history");
  page.experience_bullets.forEach((bullet, offset) => {
    setParagraphText(experienceParas[7 + offset], `${clipText(bullet.lead, 95)} ${clipText(bullet.detail, 160)}`);
  });
  setParagraphText(experienceParas[15], "ADDITIONAL CONTEXT");
  setParagraphText(experienceParas[17], "Targeted Resume Brief");
  setParagraphText(experienceParas[18], clipText(input.notes || "Role-specific packet generated from the submitted resume history and job posting.", 180));

  const documentFields = [
    input.fullName || "[Full Name]",
    `${input.location || "[location]"} | ${input.phone || "[phone]"}`,
    `${input.email || "[email]"} | [LinkedIn/portfolio if available]`,
  ];
  for (let i = 0; i < Math.min(3, topParagraphs.length); i += 1) {
    setParagraphText(topParagraphs[i], documentFields[i]);
  }
}

function applyInterviewPrep(paragraphs, response) {
  const prep = response.interview_prep;
  const company = clipText(response.company, 70, "Company");
  const role = clipText(response.role, 70, "Role");
  setParagraphText(paragraphs[5], prep.title || "Interview Reference Sheet");
  setParagraphText(paragraphs[7], prep.about_heading || "About Me:");
  setFixedParagraphList(paragraphs, 8, prep.about_me, 82);
  setParagraphText(paragraphs[14], prep.why_heading || `Why ${company}:`);
  setParagraphText(paragraphs[15], clipText(prep.why_company, 245));
  setParagraphText(paragraphs[16], prep.stories_heading || "Stories:");
  prep.stories.forEach((story, offset) => {
    setParagraphText(paragraphs[17 + offset], `${clipText(story.title, 32)} - ${clipText(story.summary, 58)}`);
  });
  setParagraphText(paragraphs[24], prep.questions_heading || "Questions:");
  setFixedParagraphList(paragraphs, 25, prep.questions, 58);
  setParagraphText(paragraphs[31], prep.footer || `${company}     |     ${role} Role`);
}

function applyCompanyRoleBrief(paragraphs, response) {
  const brief = response.company_role_brief;
  setParagraphText(paragraphs[33], brief.about_heading || `About ${response.company || "Company"}`);
  setFixedParagraphList(paragraphs, 34, brief.about_company, 48);
  setParagraphText(paragraphs[37], brief.role_mission_heading || "Role Mission");
  setFixedParagraphList(paragraphs, 38, brief.role_mission, 44);
  setParagraphText(paragraphs[40], brief.responsibilities_heading || "Key Responsibilities");
  setFixedParagraphList(paragraphs, 41, brief.key_responsibilities, 52);
  setParagraphText(paragraphs[48], brief.requirements_heading || "What They Are Looking For");
  setFixedParagraphList(paragraphs, 49, brief.what_they_are_looking_for, 44);
  setParagraphText(paragraphs[56], brief.why_join_heading || "Why Join?");
  setFixedParagraphList(paragraphs, 57, brief.why_join, 38);
}

function applyProfileCards(paragraphs, response, input) {
  const interviewer = response.profile_cards.interviewer;
  const interviewee = response.profile_cards.interviewee;
  setParagraphText(paragraphs[61], interviewer.section_title || "Interviewer");
  setParagraphText(paragraphs[63], clipText(interviewer.name, 70, "Hiring Team"));
  setParagraphText(paragraphs[64], clipText(interviewer.title, 120, response.company || "Company"));
  setParagraphText(paragraphs[65], clipText(interviewer.summary, 330));
  setParagraphText(paragraphs[67], interviewee.section_title || "Interviewee");
  setParagraphText(paragraphs[69], clipText(interviewee.name, 70, input.fullName || "[Full Name]"));
  setParagraphText(paragraphs[70], clipText(interviewee.title, 120, `${response.role || "Target Role"} Candidate`));
  setParagraphText(paragraphs[71], clipText(interviewee.summary, 360));
}

function applyReferences(paragraphs, response) {
  const refs = response.references || { heading: "References", items: defaultReferences() };
  const items = refs.items || defaultReferences();
  setParagraphText(paragraphs[73], refs.heading || "References");
  [75, 77, 79].forEach((paragraphIndex, index) => {
    const ref = items[index] || defaultReferences()[index];
    setParagraphText(
      paragraphs[paragraphIndex],
      [
        asText(ref.name, "[Reference Name]"),
        `${asText(ref.type, "Reference")} | ${asText(ref.title, "[Title / Company]")}`,
        asText(ref.relationship, "[Relationship]"),
        asText(ref.notes, "[Notes]"),
        `${asText(ref.email, "[email]")} | ${asText(ref.phone, "[phone]")}`,
      ].join("\n"),
    );
  });
}

function setFixedParagraphList(paragraphs, startIndex, items, limit) {
  items.forEach((value, offset) => setParagraphText(paragraphs[startIndex + offset], clipText(value, limit)));
}

function firstCell(row) {
  return row ? directChildren(row, "tc")[0] : null;
}

function firstByLocalName(node, localName) {
  if (!node) return null;
  const all = node.getElementsByTagName("*");
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].localName === localName) return all[i];
  }
  return null;
}

function directChildren(node, localName) {
  if (!node) return [];
  const items = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1 && child.localName === localName) {
      items.push(child);
    }
  }
  return items;
}

function textNodes(paragraph) {
  if (!paragraph) return [];
  const nodes = [];
  const all = paragraph.getElementsByTagName("*");
  for (let i = 0; i < all.length; i += 1) {
    if (all[i].localName === "t") nodes.push(all[i]);
  }
  return nodes;
}

function paragraphText(paragraph) {
  return textNodes(paragraph).map((node) => node.textContent || "").join("");
}

function setParagraphText(paragraph, value) {
  if (!paragraph) return;
  const text = asText(value);
  let nodes = textNodes(paragraph);
  if (nodes.length === 0) {
    const doc = paragraph.ownerDocument;
    const run = doc.createElementNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w:r");
    const textNode = doc.createElementNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w:t");
    run.appendChild(textNode);
    paragraph.appendChild(run);
    nodes = [textNode];
  }
  nodes[0].setAttribute("xml:space", "preserve");
  nodes[0].textContent = text;
  for (let i = 1; i < nodes.length; i += 1) {
    nodes[i].textContent = "";
  }
}

function removeEmbeddedTrackerParagraph(body) {
  for (const paragraph of directChildren(body, "p")) {
    const hasDrawing = Boolean(firstByLocalName(paragraph, "drawing") || firstByLocalName(paragraph, "object"));
    if (hasDrawing && !paragraphText(paragraph).trim()) {
      body.removeChild(paragraph);
      return;
    }
  }
}

function ensureSectionPageBreaks(dom, body, response) {
  const targets = new Set([
    asText(response.interview_prep?.footer),
    asText(response.references?.heading, "References"),
  ]);
  for (const paragraph of directChildren(body, "p")) {
    const text = paragraphText(paragraph).trim();
    if (targets.has(text)) {
      const breakParagraph = dom.createElementNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w:p");
      const run = dom.createElementNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w:r");
      const br = dom.createElementNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w:br");
      br.setAttribute("w:type", "page");
      run.appendChild(br);
      breakParagraph.appendChild(run);
      body.insertBefore(breakParagraph, paragraph);
      targets.delete(text);
    }
  }
}

function updateImageAltText(dom, response, input) {
  const docPrs = [];
  const nodes = dom.getElementsByTagName("*");
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].localName === "docPr") docPrs.push(nodes[i]);
  }
  const cards = response.profile_cards || {};
  const replacements = [
    cards.interviewer?.name || "Hiring Team",
    cards.interviewee?.name || input.fullName || "Candidate",
  ];
  for (let i = 0; i < Math.min(docPrs.length, replacements.length); i += 1) {
    docPrs[i].setAttribute("descr", replacements[i]);
    docPrs[i].setAttribute("title", replacements[i]);
  }
}

function replaceAccent(xml, oldHex, newHex) {
  const oldValue = sanitizeHex(oldHex);
  const newValue = sanitizeHex(newHex);
  return xml.replace(new RegExp(`w:fill="${oldValue}"`, "gi"), `w:fill="${newValue}"`);
}

function scrubSourceTemplateTermsXml(xml, response, input) {
  const candidate = input.fullName || response.profile_cards?.interviewee?.name || "Candidate";
  const role = response.role || input.targetRole || "Target Role";
  const company = response.company || "Target Company";
  const allowed = allowedLeftoverText(response, input);
  const replacements = new Map([
    ["Joseph (Joe) Rice", candidate],
    ["Joseph", candidate],
    ["Joe Rice", candidate],
    ["Michael Johnson", response.profile_cards?.interviewer?.name || "Hiring Team"],
    ["Rachel [Last Name]", candidate],
    ["Computers Nationwide", company],
    ["Gateway Technical College", "Candidate-provided education"],
    ["Gradient Financial", company],
    ["System Administrator", role],
    ["IT Generalist", role],
    ["ESXi", "role-specific tools"],
    ["Jamf", "role-specific tools"],
    ["Harbor Freight", "candidate-provided employer"],
    ["Kunes", "candidate-provided employer"],
  ]);
  let output = xml;
  for (const [source, target] of replacements.entries()) {
    if (allowed.includes(source.toLowerCase())) continue;
    output = output.replace(new RegExp(escapeRegExp(source), "gi"), escapeXml(target));
  }
  return output;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function imageTargetsFromDocument(zip, relsPath, documentDom) {
  const relXml = await zip.file(relsPath).async("string");
  const relDom = new DOMParser().parseFromString(relXml, "application/xml");
  const rels = {};
  const relNodes = relDom.getElementsByTagName("Relationship");
  for (let i = 0; i < relNodes.length; i += 1) {
    const id = relNodes[i].getAttribute("Id");
    const target = relNodes[i].getAttribute("Target");
    if (id && target && target.startsWith("media/")) {
      rels[id] = `word/${target}`;
    }
  }
  const targets = [];
  const nodes = documentDom.getElementsByTagName("*");
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].localName === "blip") {
      const rid = nodes[i].getAttribute("r:embed") || nodes[i].getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed");
      if (rid && rels[rid]) targets.push(rels[rid]);
    }
  }
  return targets;
}

async function renderProfileImage(name, title, accentHex, wide) {
  const width = wide ? 900 : 900;
  const height = wide ? 816 : 900;
  const accent = `#${sanitizeHex(accentHex)}`;
  const initials = initialsFromName(name);
  const titleLines = svgLines(title, 54, 3);
  const nameLines = svgLines(name, 42, 2);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="${width}" height="${height}" fill="#f8fafc"/>
      <circle cx="${width / 2}" cy="${height / 2 - 85}" r="${Math.min(width, height) / 4}" fill="${accent}"/>
      <text x="${width / 2}" y="${height / 2 - 62}" text-anchor="middle" font-family="Arial, sans-serif" font-size="120" font-weight="700" fill="#fff">${escapeXml(initials)}</text>
      ${svgTextBlock(nameLines, 54, height / 2 + 190, 44, "#172033", 700, width)}
      ${svgTextBlock(titleLines, 54, height / 2 + 300, 30, "#647084", 400, width)}
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function renderTrackerImage(response, accentHex) {
  const accent = `#${sanitizeHex(accentHex)}`;
  const tracker = response.skill_tracker || {};
  const skills = (tracker.strongest_skills || []).slice(0, 5);
  const evidence = (tracker.transferable_evidence || []).slice(0, 4);
  const points = (tracker.talking_points || []).slice(0, 4);
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1802" height="2592" viewBox="0 0 1802 2592">
      <rect width="1802" height="2592" fill="#ffffff"/>
      <rect width="1802" height="290" fill="${accent}"/>
      ${svgTextBlock(svgLines(tracker.headline || "Role Match Tracker", 48, 2), 92, 94, 66, "#ffffff", 800, 1600)}
      ${svgTextBlock(svgLines(tracker.match_summary || "", 92, 3), 92, 190, 34, "#ffffff", 400, 1600)}
      ${trackerSection("Strongest Match Skills", 92, 380, accent)}
      ${skills.map((skill, i) => chip(skill, 92 + (i % 2) * 800, 500 + Math.floor(i / 2) * 86, accent)).join("")}
      ${trackerSection("Transferable Evidence", 92, 820, accent)}
      ${evidence.map((item, i) => bullet(item, 120, 930 + i * 115, 700)).join("")}
      ${trackerSection("Interview Talking Points", 92, 1420, accent)}
      ${points.map((item, i) => cardText(item, 120, 1530 + i * 190, 1500)).join("")}
      <line x1="92" y1="2440" x2="1710" y2="2440" stroke="#d9e0ea" stroke-width="4"/>
      ${svgTextBlock(svgLines(`${response.company || "Company"} | ${response.role || "Role"}`, 90, 1), 92, 2495, 30, "#647084", 400, 1600)}
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

function trackerSection(title, x, y, accent) {
  return `<rect x="${x}" y="${y}" width="1618" height="64" rx="14" fill="${accent}"/><text x="${x + 26}" y="${y + 42}" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#fff">${escapeXml(title.toUpperCase())}</text>`;
}

function chip(text, x, y, accent) {
  return `<rect x="${x}" y="${y}" width="720" height="58" rx="29" fill="#f5f7fb" stroke="${accent}" stroke-width="3"/><text x="${x + 28}" y="${y + 38}" font-family="Arial, sans-serif" font-size="28" font-weight="700" fill="#172033">${escapeXml(clipText(text, 38))}</text>`;
}

function bullet(text, x, y, maxWidth) {
  return `<circle cx="${x}" cy="${y + 16}" r="9" fill="#2563eb"/>${svgTextBlock(svgLines(text, 70, 3), x + 30, y, 30, "#172033", 400, maxWidth)}`;
}

function cardText(text, x, y, maxWidth) {
  return `<rect x="${x - 28}" y="${y - 28}" width="1560" height="145" rx="18" fill="#f8fafc" stroke="#d9e0ea" stroke-width="2"/>${svgTextBlock(svgLines(text, 95, 2), x, y, 30, "#172033", 400, maxWidth)}`;
}

function svgTextBlock(lines, x, y, fontSize, fill, weight, maxWidth) {
  return lines.map((line, index) => {
    const widthAttr = line.length > 28 ? ` textLength="${Math.min(maxWidth, line.length * fontSize * 0.58)}"` : "";
    return `<text x="${x}" y="${y + index * (fontSize + 12)}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="${weight}" fill="${fill}"${widthAttr}>${escapeXml(line)}</text>`;
  }).join("");
}

function svgLines(value, maxChars, maxLines) {
  const words = asText(value).split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = `${current} ${word}`.trim();
    if (candidate.length <= maxChars || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length >= maxLines) break;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  return lines.length ? lines : [""];
}

function initialsFromName(name) {
  const parts = asText(name, "Candidate").match(/[A-Za-z]+/g) || ["C"];
  return parts.slice(0, 2).map((part) => part[0].toUpperCase()).join("");
}

function scanLeftoversXml(xml, response, input = {}) {
  const allowed = allowedLeftoverText(response, input);
  const haystack = xml.toLowerCase();
  const found = LEFTOVER_TERMS.filter((term) => !allowed.includes(term.toLowerCase()) && haystack.includes(term.toLowerCase()));
  if (found.length) {
    throw new Error(`Generated document still contains source-template terms: ${found.join(", ")}`);
  }
}

function allowedLeftoverText(response, input = {}) {
  const cards = response.profile_cards || {};
  return [
    response.company,
    response.role,
    input.fullName,
    input.targetRole,
    input.jobPost,
    input.workHistory,
    input.notes,
    cards.interviewer?.name,
    cards.interviewer?.title,
    cards.interviewee?.name,
    cards.interviewee?.title,
  ].join(" ").toLowerCase();
}

async function extractTextFromFile(fileName, contentType, bytes) {
  const lower = fileName.toLowerCase();
  if (contentType.startsWith("text/") || lower.endsWith(".txt")) {
    return bytes.toString("utf8");
  }
  if (lower.endsWith(".docx")) {
    return extractDocxText(bytes);
  }
  if (lower.endsWith(".pdf")) {
    const result = await pdfParse(bytes);
    return result.text || "";
  }
  throw httpError(415, "Only TXT, DOCX, and PDF uploads can be extracted.", "unsupported_file");
}

async function extractDocxText(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file("word/document.xml");
  if (!file) return "";
  const xml = await file.async("string");
  const dom = new DOMParser().parseFromString(xml, "application/xml");
  const paragraphs = dom.getElementsByTagName("*");
  const lines = [];
  for (let i = 0; i < paragraphs.length; i += 1) {
    if (paragraphs[i].localName === "p") {
      const text = paragraphText(paragraphs[i]).trim();
      if (text) lines.push(text);
    }
  }
  return lines.join("\n");
}

function normalizeInput(value) {
  const input = {
    fullName: cleanBoundedString(value.fullName, 160),
    email: cleanBoundedString(value.email, 180),
    phone: cleanBoundedString(value.phone, 80),
    location: cleanBoundedString(value.location, 180),
    targetRole: cleanBoundedString(value.targetRole, 180),
    jobPost: clipText(asText(value.jobPost), MAX_TEXT),
    workHistory: clipText(asText(value.workHistory), MAX_TEXT),
    notes: clipText(asText(value.notes), 6000),
    accentHex: value.accentHex ? sanitizeHex(value.accentHex) : DEFAULT_ACCENT_HEX,
  };
  return input;
}

function titleFromInput(input) {
  const role = input.targetRole || "Resume package";
  const name = input.fullName ? `${input.fullName} - ` : "";
  return clipText(`${name}${role}`, 120);
}

function publicPackage(pkg) {
  return withoutUndefined({
    id: pkg.id,
    title: pkg.title,
    status: pkg.status,
    paymentStatus: pkg.paymentStatus,
    accessStatus: pkg.accessStatus,
    accessSource: pkg.accessSource,
    entitlementId: pkg.entitlementId,
    stripeSessionId: pkg.stripeSessionId,
    checkoutSessionId: pkg.checkoutSessionId,
    editsTotal: pkg.editsTotal,
    editsUsed: pkg.editsUsed,
    latestGenerationId: pkg.latestGenerationId,
    invoiceLabel: pkg.invoiceLabel,
    createdAt: pkg.createdAt,
    updatedAt: pkg.updatedAt,
    generatedAt: pkg.generatedAt,
  });
}

function extractJobContext(jobText, targetRole) {
  const lines = cleanJobLines(jobText);
  const role = targetRole || lines[0] || "Target Role";
  let company = "Target Company";
  for (const candidate of lines.slice(1, 7)) {
    if (!/\$|\b\d{5}\b|, [A-Z]{2}\b|remote|full-time|part-time/i.test(candidate) && candidate.length <= 90) {
      company = candidate;
      break;
    }
  }
  const responsibilities = lines.filter((line) => /responsib|duties|manage|support|coordinate|develop|maintain|create|communicat|assist|lead|analy/i.test(line)).slice(0, RESPONSIBILITY_COUNT);
  const requirements = lines.filter((line) => /require|qualification|experience|skill|ability|preferred|must|knowledge|proficien/i.test(line)).slice(0, REQUIREMENT_COUNT);
  return { role, company, responsibilities, requirements, lines };
}

function cleanJobLines(text) {
  return asText(text)
    .replace(/&nbsp;/gi, " ")
    .split(/\r?\n+/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !["profile insights", "job details", "full job description"].includes(line.toLowerCase()));
}

function inferSkills(input, job) {
  const source = `${input.targetRole} ${input.workHistory} ${input.jobPost}`.toLowerCase();
  const candidates = [
    ["Customer Service", /customer|client|guest|support/],
    ["Communication", /communicat|present|write|document/],
    ["Operations", /operation|process|workflow|procedure/],
    ["Project Coordination", /project|coordinate|schedule|timeline/],
    ["Leadership", /lead|manager|supervis|mentor|train/],
    ["Accuracy", /accur|detail|record|quality|compliance/],
    ["Technical Tools", /software|system|platform|excel|sql|cloud|ticket|crm/],
    ["Problem Solving", /solve|troubleshoot|analy|improve|resolve/],
    ["Organization", /organize|priorit|track|plan/],
    ["Data & Reporting", /data|report|metric|dashboard|analysis/],
    ["Sales & Outreach", /sales|outreach|pipeline|revenue/],
    ["Administrative Support", /admin|office|paperwork|calendar/],
  ];
  const matched = candidates.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
  const extras = job.requirements.concat(job.responsibilities).flatMap((line) => {
    const match = line.match(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\b/);
    return match ? [match[1]] : [];
  });
  return padList([...matched, ...extras], SKILL_ITEM_COUNT, [
    "Communication",
    "Problem Solving",
    "Organization",
    "Accuracy",
    "Team Collaboration",
    "Customer Awareness",
    "Adaptability",
    "Process Follow-Through",
    "Learning Mindset",
  ]).slice(0, SKILL_ITEM_COUNT);
}

function skillValue(skill, job) {
  const roleTerms = job.lines.slice(0, 12).join(" ");
  const phrase = roleTerms ? `role-specific application, practical examples, ${clipText(roleTerms, 52)}` : "practical examples, role-specific application, reliable follow-through";
  return clipText(`${phrase}`, 120);
}

function buildExperienceBullets(input, role, company) {
  const lines = asText(input.workHistory).split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
  const seeds = [
    `Tailored background toward ${role}`,
    `Connected experience to ${company}'s needs`,
    "Communicated clearly across responsibilities",
    "Handled practical details and follow-through",
    "Learned tools, systems, and procedures as needed",
    "Solved problems using the supplied work history examples",
    "Prepared interview-ready examples from real experience",
  ];
  return seeds.map((lead, index) => ({
    lead,
    detail: clipText(lines[index] || "using the candidate-provided resume details without adding unsupported claims.", 180),
  }));
}

function buildStories(input, role) {
  const themes = [
    "Role fit",
    "Relevant responsibility",
    "Problem solving",
    "Communication",
    "Accuracy",
    "Learning curve",
    "Follow-through",
  ];
  const lines = asText(input.workHistory).split(/\r?\n+/).map((line) => line.trim()).filter(Boolean);
  return themes.map((title, index) => ({
    title,
    summary: clipText(lines[index] || `Prepare a concise example connected to the ${role} posting.`, 70),
  }));
}

function defaultReferences() {
  return [
    {
      name: "[Reference Name]",
      type: "Professional Reference",
      title: "[Title / Company]",
      relationship: "Former manager, team lead, coworker, client, or collaborator.",
      notes: "Add a short note about reliability, communication, and work quality.",
      email: "[email]",
      phone: "[phone]",
    },
    {
      name: "[Reference Name]",
      type: "Professional / Character Reference",
      title: "[Title / Company]",
      relationship: "Person who can speak to strengths, trust, and follow-through.",
      notes: "Add a short note about accuracy, ownership, and teamwork.",
      email: "[email]",
      phone: "[phone]",
    },
    {
      name: "[Reference Name]",
      type: "Professional Reference",
      title: "[Title / Relationship]",
      relationship: "Person who can speak to character and practical work habits.",
      notes: "Add a short note about communication, growth, and quality of work.",
      email: "[email]",
      phone: "[phone]",
    },
  ];
}

function outputSchema() {
  return {
    company: "Company name if known, otherwise a short descriptive label.",
    role: "Role title if known.",
    output_file_label: "Safe short label for the generated file name.",
    page_1: {
      role_title: "Uppercase target role title, 2 to 6 words.",
      role_subtitle: "Short specialization subtitle, 3 to 8 words.",
      skills_section_title: "Uppercase section heading.",
      experience_section_title: "Uppercase section heading.",
      summary: "One compact paragraph, 60 to 95 words.",
      skill_items: [{ label: "Short skill label.", value: "Comma-separated skill text only." }],
      experience_bullets: [{ lead: "Opening phrase.", detail: "Normal detail continuing the same sentence." }],
    },
    skill_tracker: {
      headline: "Short title for the full-page visual.",
      match_summary: "One compact role-match summary.",
      strongest_skills: ["Five short skill chips."],
      transferable_evidence: ["Four short proof points."],
      growth_areas: ["Three honest growth areas."],
      talking_points: ["Four first-person interview talking points."],
    },
    interview_prep: {
      title: "Interview Reference Sheet",
      about_heading: "About Me:",
      about_me: ["Six short bullets."],
      why_heading: "Why Company:",
      why_company: "One compact paragraph.",
      stories_heading: "Stories:",
      stories: [{ title: "Story title", summary: "One-sentence story prompt." }],
      questions_heading: "Questions:",
      questions: ["Six interviewer questions."],
      footer: "Company | Role",
    },
    company_role_brief: {
      about_heading: "About Company",
      about_company: ["Three concise public/company facts or job-derived facts."],
      role_mission_heading: "Role Mission",
      role_mission: ["Two concise mission points."],
      responsibilities_heading: "Key Responsibilities",
      key_responsibilities: ["Seven concise role responsibilities."],
      requirements_heading: "What They Are Looking For",
      what_they_are_looking_for: ["Seven concise requirements/preferences."],
      why_join_heading: "Why Join?",
      why_join: ["Four concise reasons."],
    },
    profile_cards: {
      interviewer: { section_title: "Interviewer", name: "Hiring Team", title: "Title or company label.", summary: "Short prep summary." },
      interviewee: { section_title: "Interviewee", name: "Candidate name.", title: "Short candidate positioning line.", summary: "Short candidate profile." },
    },
    references: { heading: "References", items: defaultReferences() },
    match_rationale: ["One to three private notes explaining choices."],
    research_sources: ["Public URLs used, if any."],
  };
}

function requiredCounts() {
  return {
    "page_1.skill_items": SKILL_ITEM_COUNT,
    "page_1.experience_bullets": EXPERIENCE_BULLET_COUNT,
    "interview_prep.about_me": ABOUT_ME_COUNT,
    "interview_prep.stories": STORY_COUNT,
    "interview_prep.questions": QUESTION_COUNT,
    "company_role_brief.about_company": COMPANY_FACT_COUNT,
    "company_role_brief.role_mission": ROLE_MISSION_COUNT,
    "company_role_brief.key_responsibilities": RESPONSIBILITY_COUNT,
    "company_role_brief.what_they_are_looking_for": REQUIREMENT_COUNT,
    "company_role_brief.why_join": WHY_JOIN_COUNT,
    "references.items": REFERENCE_COUNT,
  };
}

function requireObject(data, key) {
  if (!data[key] || typeof data[key] !== "object" || Array.isArray(data[key])) {
    throw new Error(`Response missing required object: ${key}`);
  }
  return data[key];
}

function requireExactList(value, count, label) {
  if (!Array.isArray(value) || value.length !== count) {
    throw new Error(`${label} must contain exactly ${count} items.`);
  }
}

function requireMaxList(value, count, label) {
  if (!Array.isArray(value) || value.length > count) {
    throw new Error(`${label} must be a list with at most ${count} items.`);
  }
}

function padList(items, count, fallbacks) {
  const seen = new Set();
  const result = [];
  for (const item of [...items, ...fallbacks]) {
    const value = clipText(item, 120);
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
    if (result.length >= count) break;
  }
  return result;
}

function asText(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();
  return text || fallback;
}

function cleanBoundedString(value, max) {
  return clipText(asText(value).replace(/\s+/g, " "), max);
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clipText(value, limit, fallback = "") {
  const text = asText(value, fallback).replace(/\s+/g, " ").trim();
  if (!limit || text.length <= limit) return text;
  const shortened = text.slice(0, Math.max(1, limit - 1)).replace(/\s+\S*$/, "").replace(/[ ,;:]+$/, "");
  return `${shortened}.`;
}

function sanitizeHex(value) {
  const cleaned = asText(value, DEFAULT_ACCENT_HEX).replace(/^#/, "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(cleaned)) {
    return DEFAULT_ACCENT_HEX;
  }
  return cleaned;
}

function safeFileName(value) {
  return asText(value, "ResumeDoc packet").replace(/[^\w .-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "ResumeDoc packet";
}

function escapeXml(value) {
  return asText(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function withoutUndefined(value) {
  if (Array.isArray(value)) return value.map(withoutUndefined).filter((item) => item !== undefined);
  if (value && typeof value === "object" && !(value instanceof Date) && !Buffer.isBuffer(value)) {
    const result = {};
    for (const [key, entry] of Object.entries(value)) {
      const cleaned = withoutUndefined(entry);
      if (cleaned !== undefined) result[key] = cleaned;
    }
    return result;
  }
  return value === undefined ? undefined : value;
}

function nowIso() {
  return new Date().toISOString();
}

function httpError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}
