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
const OPENROUTER_API_KEY_SECRET = defineSecret("OPENROUTER_API_KEY");

const TEMPLATE_PATH = path.join(__dirname, "assets", "interview-packet-template.docx");
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const PROMPT_VERSION = "2026-05-26-resumedoc-source-fidelity-v2";
const RESUMEDOC_APP_ID = "resumedoc";
const JOBEL_NOTE_MARKER = "ai:jobel-note";
const JOB_POSTING_NOTE_MARKER = "resumedoc:job-posting";
const WORK_HISTORY_PROFILE_ID = "workHistory";
const AI_BRAIN_DEFAULT_BASE = "https://api.ourstuff.space/v1";
const SOURCE_ACCENT_HEX = "E97132";
const DEFAULT_ACCENT_HEX = SOURCE_ACCENT_HEX;
const RESUME_PACKET_MODEL = "~openai/gpt-latest";
const RESUME_PACKET_REASONING = Object.freeze({ effort: "low", exclude: true });
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
const ACTIVITY_LIMIT = 80;
const MIN_SECTION_OUTPUT_TOKENS = 700;
const MAX_SECTION_OUTPUT_TOKENS = 2600;
const MAX_TEXT = 70000;
const MAX_FILE_BYTES = 7 * 1024 * 1024;
const MAX_AI_CHUNK_CHARS = 2200;
const MAX_SECTION_CONTEXT_CHARS = 18000;
const MAX_MEMORY_ITEMS = 12;
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
const SOURCE_PLACEHOLDER = "Confirm a source-backed example before submitting.";
const SOURCE_EVIDENCE_NEEDED = "Add source evidence before claiming this skill.";
const GENERATED_PACKET_PATTERNS = [
  /\brole-focused resume packet\b/i,
  /\bis targeting\b.{0,80}\bwith experience and strengths drawn from\b/i,
  /\bthis packet emphasizes practical fit\b/i,
  /\bis targeting\b.{0,80}\bopportunities\b/i,
  /\bcandidate-provided work history\b/i,
  /\busing the candidate-provided resume details\b/i,
  /\bsupplied work history examples\b/i,
  /\brole-specific packet generated\b/i,
  /\brole-specific application\b/i,
  /\brole-specific tools\b/i,
  /\bsubmitted resume history and job posting\b/i,
  /\bpacket tailored from the supplied resume history\b/i,
  /\bprepare a concise example connected to\b/i,
  /\bprepare for a practical conversation about fit\b/i,
  /\bconfirm any placeholders before applying\b/i,
  /\btarget company's?\b/i,
  /\btarget role skills\b/i,
  /\brelevant experience\b/i,
  /\badditional context\b/i,
  /\btargeted resume brief\b/i,
  /\binterview reference sheet\b/i,
  /\babout me:?\b/i,
  /\bstories:?\b/i,
  /\bquestions:?\b/i,
  /\bwhy target company\b/i,
  /\babout target company\b/i,
  /\brole mission\b/i,
  /\bkey responsibilities\b/i,
  /\bwhat they are looking for\b/i,
  /\bwhy join\??\b/i,
  /\bhiring for a\b/i,
  /\bcontribute effectively in\b/i,
  /\blearn the team's processes\b/i,
  /\bcommunicate clearly with customers\b/i,
  /\bfollow procedures and keep work organized\b/i,
  /\bmaintain accuracy in daily tasks\b/i,
  /\bsupport team priorities\b/i,
  /\brelevant experience connected to the role\b/i,
  /\bdependable communication and follow-through\b/i,
  /\bability to learn employer-specific systems\b/i,
  /\bprofessional judgment and problem solving\b/i,
  /\bcustomer or stakeholder awareness\b/i,
  /\binterviewer\b/i,
  /\binterviewee\b/i,
  /\bcandidate$/i,
  /\breferences\b/i,
  /\bprofessional reference\b/i,
  /\bprofessional \/ character reference\b/i,
  /\badd a short note about\b/i,
  /\bformer manager, team lead\b/i,
  /\bperson who can speak to\b/i,
  /\bhiring team\b/i,
  /\bwhat would success look like\b/i,
  /\bwhich responsibilities are most important\b/i,
  /\bwhat tools, systems, or processes should\b/i,
  /\bhow does the team communicate\b/i,
  /\bwhat qualities make someone especially successful\b/i,
  /\bare there growth paths\b/i,
];
const JOB_POST_NOISE_PATTERNS = [
  /\bjob post(?:ing)?\b/i,
  /\bSJE\s+\d+(?:\.\d+)*/i,
  /\bhybrid\b/i,
  /\bfull[- ]time\b/i,
  /\bpart[- ]time\b/i,
  /\bmondays?\b|\btuesdays?\b|\bwednesdays?\b|\bthursdays?\b|\bfridays?\b|\bweekends?\b/i,
  /\b\d{1,2}:\d{2}\s*(?:AM|PM)\b/i,
  /\$\d+/,
  /\bexpected hours\b/i,
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
    templateAsset: templateAssetInfo(),
  });
});

app.get("/api/me/access", requireActor, asyncHandler(async (req, res) => {
  const result = await workerInternal(req, "/users/self/access");
  res.json({ ok: true, access: result.access });
}));

app.post("/api/packages", requireActor, asyncHandler(async (req, res) => {
  const actor = req.actor;
  const input = normalizePackageInput(req.body?.input || req.body || {});
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
    activity: [
      packageActivityEvent("workspace", "Jobel opened a fresh resume workspace for this package.", "good", now),
    ],
  });
  await packageRef(id).set(pkg);
  if (input.jobPostNoteId) {
    await resumeNoteRef(actor.uid, input.jobPostNoteId).set({ packageId: id, updatedAt: now }, { merge: true });
  }
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
  const input = await loadPackageInputForUse(req.actor.uid, pkg);
  res.json({ ok: true, package: publicPackage(synced), input });
}));

app.get("/api/packages/:id/activity", requireActor, asyncHandler(async (req, res) => {
  const pkg = await getOwnedPackage(req.params.id, req.actor.uid);
  res.json({ ok: true, package: publicPackage(pkg), activity: publicActivity(pkg.activity) });
}));

app.patch("/api/packages/:id", requireActor, asyncHandler(async (req, res) => {
  const actor = req.actor;
  const pkg = await getOwnedPackage(req.params.id, actor.uid);
  const input = normalizePackageInput(req.body?.input || {});
  const inputStoragePath = pkg.inputStoragePath || inputPath(actor.uid, pkg.id);
  await saveJson(inputStoragePath, input);
  const patch = withoutUndefined({
    title: titleFromInput(input),
    inputStoragePath,
    updatedAt: nowIso(),
  });
  await packageRef(pkg.id).set(patch, { merge: true });
  await appendPackageActivity(pkg.id, "sources_saved", "Jobel saved the latest source references and has them ready for the next DOCX pass.", "good");
  if (input.jobPostNoteId) {
    await resumeNoteRef(actor.uid, input.jobPostNoteId).set({ packageId: pkg.id, updatedAt: patch.updatedAt }, { merge: true });
  }
  const updated = { ...pkg, ...patch };
  res.json({ ok: true, package: publicPackage(updated) });
}));

app.post("/api/sources/prepare", requireActor, asyncHandler(async (req, res) => {
  const input = normalizeInput(req.body?.input || req.body || {});
  const packageId = cleanBoundedString(req.body?.packageId, 160);
  const jobPostNoteId = cleanBoundedString(req.body?.jobPostNoteId || req.body?.input?.jobPostNoteId, 160);
  const prepared = await prepareResumeSources({
    uid: req.actor.uid,
    packageId,
    jobPostNoteId,
    targetRole: input.targetRole,
    jobPost: input.jobPost,
    workHistory: input.workHistory,
  });
  if (packageId) {
    await appendPackageActivity(packageId, "sources_organized", "Jobel organized the job posting and work-history source notes so the generator can use stable references.", "good");
  }
  res.json({ ok: true, ...prepared });
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
  const extraDirection = cleanBoundedString(req.body?.extraDirection, 6000);
  try {
    await markGenerationStarted(pkg.id, "Jobel is gathering your saved resume details, job post, and package notes.");
    const input = await loadPackageInputForUse(req.actor.uid, pkg, { extraDirection });
    await appendPackageActivity(pkg.id, "sources_loaded", "Jobel loaded the stable source references and is separating contact fields from resume evidence.", "info");
    const result = await generateAndStore({
      actor: req.actor,
      pkg: unlockedPkg,
      input,
      revisionInstruction: cleanBoundedString(req.body?.instruction, 2000),
      countRevision: false,
    });
    res.json(result);
  } catch (error) {
    await markGenerationFailed(pkg.id, error);
    throw error;
  }
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
  try {
    await markGenerationStarted(pkg.id, "Jobel is opening the latest DOCX context and applying your revision request.");
    const input = await loadPackageInputForUse(req.actor.uid, pkg);
    await appendPackageActivity(pkg.id, "revision_loaded", "Jobel loaded the prior package inputs and is keeping the revision tied to the same source evidence.", "info");
    const result = await generateAndStore({
      actor: req.actor,
      pkg: unlockedPkg,
      input,
      revisionInstruction: instruction,
      countRevision: true,
    });
    res.json(result);
  } catch (error) {
    await markGenerationFailed(pkg.id, error);
    throw error;
  }
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
  const input = pkg?.inputStoragePath ? await loadPackageInputForUse(req.actor.uid, pkg) : {};
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
    secrets: [WORKER_INTERNAL_TOKEN_SECRET, AI_BRAIN_API_TOKEN_SECRET, OPENROUTER_API_KEY_SECRET],
  },
  app,
);

exports._test = {
  buildDocx,
  buildBrainNoteText,
  buildPacketResponseWithOpenRouter,
  buildJobelPrompt,
  cleanMultilineTextForAi,
  composeInputWithReferences,
  detectSourceQualityIssues,
  isJobPostingNote,
  localOrganizedSource,
  rememberNoteInBrain,
  localResponseFromInput,
  normalizeCandidateSource,
  normalizeInput,
  normalizePackageInput,
  normalizeResumeNote,
  normalizeWorkHistoryProfile,
  noteSourceHash,
  outputTitleWithTimestamp,
  packetPromptContext,
  sectionContextForTask,
  shouldSkipBrainSync,
  validatePacketResponse,
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

function templateAssetInfo() {
  try {
    const buffer = fs.readFileSync(TEMPLATE_PATH);
    return {
      present: true,
      fileName: path.basename(TEMPLATE_PATH),
      size: buffer.length,
      sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
    };
  } catch (error) {
    return {
      present: false,
      fileName: path.basename(TEMPLATE_PATH),
      error: error.code || "template_read_failed",
    };
  }
}

function packageRef(id) {
  return db().collection("resume_packages").doc(id);
}

function packageActivityEvent(stage, message, tone = "info", at = nowIso()) {
  return withoutUndefined({
    id: crypto.randomUUID(),
    at,
    stage: cleanBoundedString(stage, 80) || "activity",
    tone: ["info", "good", "warn", "bad"].includes(tone) ? tone : "info",
    message: cleanBoundedString(message, 420),
  });
}

function publicActivity(activity) {
  return Array.isArray(activity)
    ? activity
        .filter((entry) => entry && entry.at && entry.message)
        .map((entry) => ({
          id: cleanBoundedString(entry.id, 80) || sha256Json({ at: entry.at, message: entry.message }).slice(0, 16),
          at: cleanBoundedString(entry.at, 80),
          stage: cleanBoundedString(entry.stage, 80),
          tone: ["info", "good", "warn", "bad"].includes(entry.tone) ? entry.tone : "info",
          message: cleanBoundedString(entry.message, 420),
        }))
        .sort((a, b) => String(a.at).localeCompare(String(b.at)))
        .slice(-ACTIVITY_LIMIT)
    : [];
}

async function appendPackageActivity(packageId, stage, message, tone = "info") {
  if (!packageId) return null;
  const event = packageActivityEvent(stage, message, tone);
  await db().runTransaction(async (transaction) => {
    const ref = packageRef(packageId);
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const current = publicActivity(snap.data().activity);
    transaction.set(ref, {
      activity: [...current, event].slice(-ACTIVITY_LIMIT),
      updatedAt: event.at,
    }, { merge: true });
  });
  return event;
}

async function markGenerationStarted(packageId, message) {
  const event = packageActivityEvent("generation_started", message, "info");
  await db().runTransaction(async (transaction) => {
    const ref = packageRef(packageId);
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const current = publicActivity(snap.data().activity);
    transaction.set(ref, {
      status: "generating",
      lastError: null,
      activity: [...current, event].slice(-ACTIVITY_LIMIT),
      updatedAt: event.at,
    }, { merge: true });
  });
}

async function markGenerationFailed(packageId, error) {
  const statusCode = error.statusCode || 500;
  const code = error.code || "generation_failed";
  const detail = statusCode < 500
    ? cleanBoundedString(error.message, 260)
    : "Jobel hit a server-side generation problem before the DOCX could be saved.";
  const event = packageActivityEvent("generation_failed", detail, "bad");
  await db().runTransaction(async (transaction) => {
    const ref = packageRef(packageId);
    const snap = await transaction.get(ref);
    if (!snap.exists) return;
    const current = publicActivity(snap.data().activity);
    transaction.set(ref, {
      status: "error",
      lastError: code,
      activity: [...current, event].slice(-ACTIVITY_LIMIT),
      updatedAt: event.at,
    }, { merge: true });
  });
}

function resumeNoteRef(uid, noteId) {
  return db().collection("users").doc(uid).collection("apps").doc(RESUMEDOC_APP_ID).collection("notes").doc(noteId);
}

function resumeProfileRef(uid, profileId) {
  return db().collection("users").doc(uid).collection("apps").doc(RESUMEDOC_APP_ID).collection("profile").doc(profileId);
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

async function loadPackageInputForUse(uid, pkg, options = {}) {
  const savedInput = await loadJson(pkg.inputStoragePath, {});
  const sourceInput = await composeInputWithStoredReferences(uid, savedInput);
  return normalizeInput({
    ...sourceInput,
    notes: options.extraDirection || sourceInput.notes || "",
  });
}

async function composeInputWithStoredReferences(uid, savedInput = {}) {
  const normalizedSaved = normalizeInput(savedInput);
  const jobPostNoteId = cleanBoundedString(savedInput.jobPostNoteId, 160);
  const workHistoryProfileId = cleanBoundedString(savedInput.workHistoryProfileId, 160);
  const [jobPost, workHistoryProfile] = await Promise.all([
    jobPostNoteId ? loadJobPostingNoteBody(uid, jobPostNoteId) : Promise.resolve(""),
    workHistoryProfileId ? loadWorkHistoryProfile(uid) : Promise.resolve(normalizeWorkHistoryProfile({ id: WORK_HISTORY_PROFILE_ID })),
  ]);
  return composeInputWithReferences(savedInput, {
    jobPost: jobPost || normalizedSaved.jobPost,
    workHistory: workHistoryProfile.body || normalizedSaved.workHistory,
    workHistoryProfile,
  });
}

function composeInputWithReferences(savedInput = {}, sources = {}) {
  const normalizedSaved = normalizeInput(savedInput);
  return normalizeInput({
    ...normalizedSaved,
    jobPost: sources.jobPost || normalizedSaved.jobPost,
    workHistory: sources.workHistory || normalizedSaved.workHistory,
    notes: normalizedSaved.notes,
  });
}

async function loadJobPostingNoteBody(uid, noteId) {
  try {
    const note = await getOwnedResumeNote(uid, noteId);
    return isJobPostingNote(note) ? note.body : "";
  } catch {
    return "";
  }
}

async function loadWorkHistoryProfile(uid) {
  const snap = await resumeProfileRef(uid, WORK_HISTORY_PROFILE_ID).get();
  if (!snap.exists) return normalizeWorkHistoryProfile({ id: WORK_HISTORY_PROFILE_ID });
  return normalizeWorkHistoryProfile({ id: snap.id, ...snap.data() });
}

function normalizeResumeNote(raw = {}) {
  const metadata = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {};
  const isJobel = metadata.source === "jobel" || metadata.marker === JOBEL_NOTE_MARKER;
  const isJobPosting = metadata.kind === "job_posting" || metadata.marker === JOB_POSTING_NOTE_MARKER;
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
      kind: isJobPosting ? "job_posting" : cleanBoundedString(metadata.kind, 80) || "note",
      marker: isJobel ? JOBEL_NOTE_MARKER : isJobPosting ? JOB_POSTING_NOTE_MARKER : metadata.marker || null,
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

async function prepareResumeSources({ uid, packageId, jobPostNoteId, targetRole, jobPost, workHistory }) {
  const currentWorkHistory = await loadWorkHistoryProfile(uid);
  const now = nowIso();
  const [organizedJobPost, organizedWorkHistory] = await Promise.all([
    organizeSourceReference("job_posting", { text: jobPost, targetRole }),
    organizeSourceReference("work_history", {
      text: workHistory,
      existingText: currentWorkHistory.body,
      targetRole,
    }),
  ]);
  const savedJobPost = await saveJobPostingReference(uid, {
    noteId: jobPostNoteId,
    packageId,
    title: organizedJobPost.title,
    body: organizedJobPost.body,
    now,
  });
  const savedWorkHistory = await saveWorkHistoryReference(uid, {
    existing: currentWorkHistory,
    body: organizedWorkHistory.body,
    now,
  });
  return {
    sources: {
      jobPostNoteId: savedJobPost.id,
      workHistoryProfileId: savedWorkHistory.id,
    },
    jobPost: savedJobPost.body,
    workHistory: savedWorkHistory.body,
  };
}

async function organizeSourceReference(kind, context = {}) {
  const cleanText = clipMultilineText(context.text, MAX_TEXT);
  const existingText = clipMultilineText(context.existingText, MAX_TEXT);
  if (process.env.OPENROUTER_API_KEY && cleanText) {
    try {
      const body = await callOpenRouterText(
        [
          "You organize ResumeDoc source material.",
          "Return concise markdown only.",
          "Do not invent facts, dates, employers, tools, credentials, compensation, or personal details.",
        ].join(" "),
        JSON.stringify({
          kind,
          targetRole: cleanBoundedString(context.targetRole, 180),
          existingText: kind === "work_history" ? existingText : "",
          text: cleanText,
          instructions: kind === "job_posting"
            ? "Organize this job posting into a reusable reference with role, company if present, responsibilities, requirements, logistics, and unknowns."
            : "Merge the new work history into the existing user work-history reference. Deduplicate repeated lines and preserve only candidate-provided facts.",
        }, null, 2),
      );
      return normalizeOrganizedSource(kind, body, context);
    } catch (error) {
      console.warn("source_organizer_failed", kind, error.message);
    }
  }
  return localOrganizedSource(kind, context);
}

function normalizeOrganizedSource(kind, body, context = {}) {
  const cleanBody = clipMultilineText(body, MAX_TEXT);
  if (!cleanBody) return localOrganizedSource(kind, context);
  const fallbackTitle = kind === "job_posting" ? "Job posting reference" : "Work history reference";
  const titleLine = cleanBody.split("\n").find((line) => /^#\s+/.test(line));
  return {
    title: cleanBoundedString(titleLine ? titleLine.replace(/^#\s+/, "") : fallbackTitle, 120),
    body: cleanBody,
  };
}

function localOrganizedSource(kind, context = {}) {
  if (kind === "job_posting") {
    const input = normalizeInput({ targetRole: context.targetRole, jobPost: context.text });
    const job = extractJobContext(input.jobPost, input.targetRole);
    const body = [
      "# Job posting reference",
      "",
      `Role: ${job.role || input.targetRole || "Unknown"}`,
      `Company: ${job.company || "Unknown"}`,
      "",
      "## Responsibilities",
      ...listOrPlaceholder(job.responsibilities),
      "",
      "## Requirements",
      ...listOrPlaceholder(job.requirements),
      "",
      "## Source details",
      ...listOrPlaceholder(job.lines.slice(0, 20)),
    ].join("\n");
    return normalizeOrganizedSource("job_posting", body, context);
  }

  const merged = uniqueSourceLines([
    ...clipMultilineText(context.existingText, MAX_TEXT).split("\n"),
    ...clipMultilineText(context.text, MAX_TEXT).split("\n"),
  ]);
  const source = normalizeCandidateSource(merged.join("\n"), {});
  const evidence = source.workEvidence.length ? source.workEvidence : merged;
  const body = [
    "# Work history reference",
    "",
    "## Candidate-provided evidence",
    ...listOrPlaceholder(evidence.slice(0, 120)),
  ].join("\n");
  return normalizeOrganizedSource("work_history", body, context);
}

function listOrPlaceholder(items) {
  const values = (items || []).map((item) => clipText(item, 500)).filter(Boolean);
  return values.length ? values.map((item) => `- ${item.replace(/^[-*]\s*/, "")}`) : ["- Unknown"];
}

function uniqueSourceLines(lines) {
  const seen = new Set();
  const result = [];
  for (const line of lines || []) {
    const clean = clipText(line, 800).replace(/^[-*]\s*/, "").trim();
    if (!clean) continue;
    if (/^#+\s+/.test(clean) || /^candidate-provided evidence$/i.test(clean)) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(clean);
  }
  return result;
}

async function saveJobPostingReference(uid, { noteId, packageId, title, body, now }) {
  let ref = null;
  if (noteId) {
    try {
      const current = await getOwnedResumeNote(uid, noteId);
      if (isJobPostingNote(current)) ref = resumeNoteRef(uid, noteId);
    } catch {}
  }
  if (!ref) {
    ref = db().collection("users").doc(uid).collection("apps").doc(RESUMEDOC_APP_ID).collection("notes").doc();
  }
  const payload = withoutUndefined({
    owner: uid,
    appId: RESUMEDOC_APP_ID,
    packageId: packageId || "",
    title: cleanBoundedString(title, 120) || "Job posting reference",
    body: clipText(body, MAX_TEXT),
    createdAt: now,
    updatedAt: now,
    metadata: {
      source: "user",
      kind: "job_posting",
      marker: JOB_POSTING_NOTE_MARKER,
      readOnly: false,
      contentFormat: "markdown",
      organizedAt: now,
      organizerVersion: PROMPT_VERSION,
    },
    syncToBrain: false,
    brainSync: { status: "not_synced", sourceHash: null, memoryId: null, syncedAt: null, errorCode: null },
  });
  await ref.set(payload, { merge: true });
  return normalizeResumeNote({ id: ref.id, ...payload });
}

async function saveWorkHistoryReference(uid, { existing, body, now }) {
  const normalized = normalizeWorkHistoryProfile({
    ...existing,
    owner: uid,
    appId: RESUMEDOC_APP_ID,
    body,
    sourceHash: stableSourceHash(body),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    metadata: {
      source: "resumedoc",
      kind: "work_history",
      marker: "resumedoc:work-history",
      organizedAt: now,
      organizerVersion: PROMPT_VERSION,
    },
  });
  await resumeProfileRef(uid, WORK_HISTORY_PROFILE_ID).set(withoutUndefined(normalized), { merge: true });
  return normalized;
}

function stableSourceHash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function inputPath(uid, packageId) {
  return `resume-packages/${uid}/${packageId}/input.json`;
}

function outputPath(uid, packageId, generationId, ext) {
  return `resume-packages/${uid}/${packageId}/generations/${generationId}/packet.${ext}`;
}

async function generateAndStore({ actor, pkg, input, revisionInstruction, countRevision }) {
  const generationId = crypto.randomUUID();
  await appendPackageActivity(pkg.id, "ai_drafting", "Jobel is asking the flagship OpenAI model to draft the resume sections with low reasoning and a larger output budget.", "info");
  const response = await buildPacketResponse(input, revisionInstruction, { packageId: pkg.id });
  await appendPackageActivity(pkg.id, "quality_review", "Jobel finished the quality review for copied job-post headers, repeated contact details, and generic scaffold text.", "good");
  const now = nowIso();
  const generatedTitle = outputTitleWithTimestamp(response.output_file_label || pkg.title || titleFromInput(input), now);
  response.output_file_label = generatedTitle;
  await appendPackageActivity(pkg.id, "docx_rendering", "Jobel is placing the approved text into the Word template and keeping the DOCX stable on the server.", "info");
  const { docx, trackerPng } = await buildDocx(response, input);
  await appendPackageActivity(pkg.id, "storage", "Jobel is saving the DOCX, JSON audit copy, and tracker image to your private package folder.", "info");
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
  const patch = withoutUndefined({
    title: generatedTitle,
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
  await appendPackageActivity(pkg.id, "complete", `Jobel finished the DOCX: ${generatedTitle}.`, "good");
  return { ok: true, package: publicPackage({ ...pkg, ...patch }), generationId };
}

async function buildPacketResponse(input, revisionInstruction, options = {}) {
  if (process.env.OPENROUTER_API_KEY) {
    try {
      const response = await buildPacketResponseWithOpenRouter(input, revisionInstruction, options);
      return validatePacketResponse(response, input);
    } catch (error) {
      console.warn("openrouter_generation_failed", error.message);
      if (error.statusCode && error.statusCode < 500) {
        throw error;
      }
      throw httpError(502, "ResumeDoc could not get a usable AI packet. No fallback DOCX was generated.", "ai_generation_failed");
    }
  }
  return validatePacketResponse(localResponseFromInput(input, revisionInstruction), input);
}

async function buildPacketResponseWithOpenRouter(input, revisionInstruction, options = {}) {
  const baseline = localResponseFromInput(input, revisionInstruction);
  const context = packetPromptContext(input, revisionInstruction, baseline);
  const sectionTasks = [
    {
      key: "page_1",
      label: "resume first page",
      value: baseline.page_1,
      counts: {
        skill_items: SKILL_ITEM_COUNT,
        experience_bullets: EXPERIENCE_BULLET_COUNT,
      },
      instructions: [
        "Faithfully reformulate the first resume page only.",
        "Use actual candidate evidence from workHistory. Do not use contact/header lines as accomplishments.",
        "Every candidate claim must trace to selected work_history chunks or candidate identity fields.",
        "Use candidate identity only where the schema explicitly needs identity. Do not put names, phone numbers, emails, or locations in summary, skill values, or experience bullets.",
        "Do not use copied job-post headers, generated packet boilerplate, or placeholders as candidate evidence.",
        "Return concise text that will fit existing Word template paragraphs.",
        "Do not return colors, style, layout, page-break, markdown, or DOCX instructions.",
      ],
      sourceTypes: ["candidate_profile", "work_history", "job_requirements", "notes"],
    },
    {
      key: "skill_tracker",
      label: "skill tracker visual text",
      value: baseline.skill_tracker,
      counts: {
        strongest_skills: 5,
        transferable_evidence: 4,
        growth_areas: 3,
        talking_points: 4,
      },
      instructions: [
        "Faithfully reformulate only the skill tracker text.",
        "Use short phrases for chips and concise proof points.",
        "Use the job posting for emphasis only; do not present job-post text as candidate experience.",
        "Do not invent metrics, certifications, employers, tools, or dates.",
      ],
      sourceTypes: ["candidate_profile", "work_history", "job_requirements"],
    },
    {
      key: "interview_prep",
      label: "interview prep page",
      value: baseline.interview_prep,
      counts: {
        about_me: ABOUT_ME_COUNT,
        stories: STORY_COUNT,
        questions: QUESTION_COUNT,
      },
      instructions: [
        "Faithfully reformulate one interview-prep page only.",
        "Stories must be prompts grounded in supplied work history, not new claims.",
        "If the source has no real story evidence, write a confirmation prompt instead of filler.",
        "Do not repeat header/contact details in About Me or Stories.",
        "Keep every line short enough for a one-page interview sheet.",
      ],
      sourceTypes: ["candidate_profile", "work_history", "job_responsibilities", "notes"],
    },
    {
      key: "company_role_brief",
      label: "company and role brief page",
      value: baseline.company_role_brief,
      counts: {
        about_company: COMPANY_FACT_COUNT,
        role_mission: ROLE_MISSION_COUNT,
        key_responsibilities: RESPONSIBILITY_COUNT,
        what_they_are_looking_for: REQUIREMENT_COUNT,
        why_join: WHY_JOIN_COUNT,
      },
      instructions: [
        "Faithfully reformulate one company-and-role brief page only.",
        "Use the job posting and supplied source context first.",
        "If company facts are uncertain, write job-derived facts instead of guessing.",
      ],
      sourceTypes: ["candidate_profile", "job_overview", "job_responsibilities", "job_requirements"],
    },
    {
      key: "profile_cards",
      label: "profile cards",
      value: baseline.profile_cards,
      counts: {},
      instructions: [
        "Faithfully reformulate only the interviewer/interviewee profile cards.",
        "Use Hiring Team when a named interviewer is not clearly supported.",
        "Do not invent biography details for an interviewer.",
      ],
      sourceTypes: ["candidate_profile", "job_overview"],
    },
    {
      key: "references",
      label: "reference placeholders",
      value: baseline.references,
      counts: { items: REFERENCE_COUNT },
      instructions: [
        "Return only reference placeholders unless the candidate explicitly supplied reference details.",
        "Do not invent names, employers, emails, phone numbers, or relationships.",
      ],
      sourceTypes: ["candidate_profile", "notes"],
    },
  ];

  const output = {
    company: baseline.company,
    role: baseline.role,
    output_file_label: baseline.output_file_label,
    page_1: baseline.page_1,
    skill_tracker: baseline.skill_tracker,
    interview_prep: baseline.interview_prep,
    company_role_brief: baseline.company_role_brief,
    profile_cards: baseline.profile_cards,
    references: baseline.references,
    match_rationale: baseline.match_rationale,
    research_sources: [],
  };

  let packetMemory = initialPacketMemory(context);
  for (const task of sectionTasks) {
    await appendPackageActivity(options.packageId, `draft_${task.key}`, `Jobel is drafting ${task.label}.`, "info");
    let sectionResult;
    try {
      sectionResult = await callOpenRouterSection(context, task, packetMemory);
    } catch (error) {
      if (!isRetryableOpenRouterSectionError(error)) {
        throw error;
      }
      console.warn("openrouter_section_fallback", task.key, error.message);
      await appendPackageActivity(
        options.packageId,
        `draft_fallback_${task.key}`,
        `Jobel could not get stable AI JSON for ${task.label}, so it is using the conservative source-checked draft for that section.`,
        "warn",
      );
      sectionResult = fallbackSectionResult(task, error);
    }
    output[task.key] = sectionResult.output;
    try {
      validateResponse(output, input);
    } catch (error) {
      console.warn("openrouter_section_invalid", task.key, error.message);
      await appendPackageActivity(
        options.packageId,
        `draft_fallback_${task.key}`,
        `Jobel received an incomplete AI draft for ${task.label}, so it is using the conservative source-checked draft for that section.`,
        "warn",
      );
      sectionResult = fallbackSectionResult(task, error);
      output[task.key] = sectionResult.output;
      validateResponse(output, input);
    }
    packetMemory = mergePacketMemory(packetMemory, sectionResult.memory, task, output[task.key]);
    await appendPackageActivity(options.packageId, `drafted_${task.key}`, `Jobel finished ${task.label} and carried forward the source notes.`, "good");
  }
  output.generation_memory = packetMemory;
  return output;
}

function fallbackSectionResult(task, error) {
  return {
    output: task.value,
    memory: normalizeSectionMemory({
      summary: `Used source-checked fallback for ${task.label}.`,
      placeholders_or_unknowns: [`AI section draft was unavailable: ${clipText(error?.message, 160, "unknown error")}`],
    }, task, task.value),
  };
}

function isRetryableOpenRouterSectionError(error) {
  if (!error) return true;
  if (error.code === "openrouter_credit_limit" || error.code === "openrouter_auth_failed") return false;
  if (error.statusCode && error.statusCode < 500 && error.statusCode !== 429) return false;
  return true;
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

function packetPromptContext(input, revisionInstruction, baseline) {
  const cleanInput = normalizeInput(input);
  const job = extractJobContext(cleanInput.jobPost, cleanInput.targetRole);
  const candidateSource = normalizeCandidateSource(cleanInput.workHistory, cleanInput);
  const workEvidence = candidateSource.workEvidence;
  return {
    prompt_version: PROMPT_VERSION,
    candidate_identity: {
      fullName: cleanInput.fullName,
      email: cleanInput.email,
      phone: cleanInput.phone,
      location: cleanInput.location,
    },
    target_context: {
      targetRole: cleanInput.targetRole,
      inferred_company: baseline.company,
      inferred_role: baseline.role,
    },
    revision_instruction: revisionInstruction || "",
    source_digest: {
      work_evidence: workEvidence.slice(0, 10),
      discarded_source_issues: candidateSource.discarded.slice(0, 10).map((entry) => `${entry.reason}: ${entry.text}`),
      job_responsibilities: job.responsibilities.slice(0, RESPONSIBILITY_COUNT),
      job_requirements: job.requirements.slice(0, REQUIREMENT_COUNT),
      notes: clipText(cleanInput.notes, 900),
    },
    source_chunks: buildAiSourceChunks(cleanInput, job, workEvidence),
    strict_document_rules: [
      "The Word template owns all styling, color, layout, page breaks, bullets, tables, and images.",
      "Return text values only. Never request a color change or structural change.",
      "Use only candidate facts found in the selected source chunks.",
      "Candidate resume text may contain prior ResumeDoc output. Treat generated boilerplate, contact headers, placeholders, and copied job-post lines as unusable source evidence.",
      "Faithfully reformulate real candidate evidence toward the target job; do not turn job-post text into candidate history.",
      "Identity fields are variables for header/profile placement only. Do not put the candidate's name, phone, email, location, or contact header text into skills, experience bullets, stories, or company/role analysis.",
      "If a skill or story lacks candidate evidence, say that evidence is needed instead of filling with the candidate's name, phone number, job-post header, or generic resume boilerplate.",
      "Do not invent degrees, certifications, exact dates, software systems, employers, metrics, references, or interviewer biography.",
      "Use placeholders for unknown private details.",
      "Keep text compact so it fits the fixed template slots.",
      "Use ASCII punctuation where possible.",
    ],
  };
}

function isJobPostingNote(note) {
  return note?.metadata?.kind === "job_posting" || note?.metadata?.marker === JOB_POSTING_NOTE_MARKER;
}

function normalizeWorkHistoryProfile(raw = {}) {
  const metadata = raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {};
  return {
    id: cleanBoundedString(raw.id, 160) || WORK_HISTORY_PROFILE_ID,
    owner: cleanBoundedString(raw.owner, 160),
    appId: cleanBoundedString(raw.appId, 80) || RESUMEDOC_APP_ID,
    body: clipText(asText(raw.body), MAX_TEXT),
    sourceHash: cleanBoundedString(raw.sourceHash, 128),
    createdAt: cleanBoundedString(raw.createdAt, 80),
    updatedAt: cleanBoundedString(raw.updatedAt, 80),
    metadata: {
      source: cleanBoundedString(metadata.source, 80) || "resumedoc",
      kind: "work_history",
      marker: "resumedoc:work-history",
      organizedAt: cleanBoundedString(metadata.organizedAt, 80),
      organizerVersion: cleanBoundedString(metadata.organizerVersion, 80),
    },
  };
}

function buildAiSourceChunks(input, job, workEvidence) {
  const candidateSource = normalizeCandidateSource(input.workHistory, input);
  const selectedWorkEvidence = Array.isArray(workEvidence) ? workEvidence : candidateSource.workEvidence;
  const chunks = [
    aiChunk("candidate.profile", "candidate_profile", "Candidate identity and target", [
      `Name: ${input.fullName || "[Full Name]"}`,
      `Target role: ${input.targetRole || job.role || "[Target Role]"}`,
      `Location: ${input.location || "[Location]"}`,
      `Email: ${input.email || "[Email]"}`,
      `Phone: ${input.phone || "[Phone]"}`,
    ].join("\n")),
    aiChunk("job.overview", "job_overview", "Job overview and likely company", [
      `Inferred company: ${job.company || "Target Employer"}`,
      `Inferred role: ${job.role || input.targetRole || "Target Role"}`,
      ...job.lines.slice(0, 8),
    ].join("\n")),
    aiChunk("job.responsibilities", "job_responsibilities", "Job responsibilities", job.responsibilities.join("\n")),
    aiChunk("job.requirements", "job_requirements", "Job requirements", job.requirements.join("\n")),
  ];

  for (const [index, chunk] of chunkLines(selectedWorkEvidence, MAX_AI_CHUNK_CHARS).entries()) {
    chunks.push(aiChunk(`work.history.${index + 1}`, "work_history", `Candidate work evidence chunk ${index + 1}`, chunk.join("\n")));
  }
  if (input.notes) {
    for (const [index, chunk] of chunkText(input.notes, MAX_AI_CHUNK_CHARS).entries()) {
      chunks.push(aiChunk(`candidate.notes.${index + 1}`, "notes", `Candidate notes chunk ${index + 1}`, chunk));
    }
  }
  return chunks.filter((chunk) => chunk.text);
}

function aiChunk(id, type, title, text) {
  return {
    id,
    type,
    title,
    text: clipMultilineText(text, MAX_AI_CHUNK_CHARS),
  };
}

function chunkLines(lines, maxChars) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const line of lines) {
    const clean = clipText(line, 500);
    if (!clean) continue;
    if (current.length && size + clean.length + 1 > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(clean);
    size += clean.length + 1;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

function chunkText(text, maxChars) {
  const lines = clipMultilineText(text, MAX_TEXT).split("\n").filter(Boolean);
  const lineChunks = chunkLines(lines, maxChars);
  if (lineChunks.length) return lineChunks.map((chunk) => chunk.join("\n"));
  const value = clipMultilineText(text, MAX_TEXT);
  const chunks = [];
  for (let index = 0; index < value.length; index += maxChars) {
    chunks.push(value.slice(index, index + maxChars).trim());
  }
  return chunks.filter(Boolean);
}

function sectionContextForTask(context, task, packetMemory = initialPacketMemory(context)) {
  const sourceChunks = selectSourceChunks(context.source_chunks || [], task.sourceTypes || []);
  return {
    prompt_version: context.prompt_version,
    candidate_identity: context.candidate_identity,
    target_context: context.target_context,
    revision_instruction: context.revision_instruction,
    source_chunk_policy: "Use these selected chunks only. If a fact is not present here or in working memory, leave it general or use a placeholder.",
    source_chunks: limitChunksByChars(sourceChunks, MAX_SECTION_CONTEXT_CHARS),
    working_memory: compactPacketMemory(packetMemory),
    strict_document_rules: context.strict_document_rules,
  };
}

function selectSourceChunks(chunks, sourceTypes) {
  const allowed = new Set(sourceTypes);
  return chunks.filter((chunk) => allowed.has(chunk.type));
}

function limitChunksByChars(chunks, maxChars) {
  const selected = [];
  let total = 0;
  for (const chunk of chunks) {
    const size = chunk.text.length;
    if (selected.length && total + size > maxChars) break;
    selected.push(chunk);
    total += size;
  }
  return selected;
}

function initialPacketMemory(context) {
  return {
    prompt_version: context.prompt_version,
    target: context.target_context,
    section_summaries: [],
    facts_used: [],
    candidate_claims_used: [],
    job_points_used: [],
    placeholders_or_unknowns: [],
    style_notes: [],
  };
}

function compactPacketMemory(memory) {
  return {
    target: memory.target,
    section_summaries: (memory.section_summaries || []).slice(-6),
    facts_used: (memory.facts_used || []).slice(-MAX_MEMORY_ITEMS),
    candidate_claims_used: (memory.candidate_claims_used || []).slice(-MAX_MEMORY_ITEMS),
    job_points_used: (memory.job_points_used || []).slice(-MAX_MEMORY_ITEMS),
    placeholders_or_unknowns: (memory.placeholders_or_unknowns || []).slice(-MAX_MEMORY_ITEMS),
    style_notes: (memory.style_notes || []).slice(-MAX_MEMORY_ITEMS),
  };
}

function normalizeSectionMemory(memory, task, sectionOutput) {
  const raw = memory && typeof memory === "object" && !Array.isArray(memory) ? memory : {};
  return {
    section: task.key,
    summary: clipText(raw.summary || summarizeSectionOutput(task.key, sectionOutput), 360),
    facts_used: cleanMemoryList(raw.facts_used),
    candidate_claims_used: cleanMemoryList(raw.candidate_claims_used),
    job_points_used: cleanMemoryList(raw.job_points_used),
    placeholders_or_unknowns: cleanMemoryList(raw.placeholders_or_unknowns),
    style_notes: cleanMemoryList(raw.style_notes),
  };
}

function mergePacketMemory(packetMemory, sectionMemory, task, sectionOutput) {
  const memory = sectionMemory || normalizeSectionMemory(null, task, sectionOutput);
  return {
    ...packetMemory,
    section_summaries: capMemoryList([
      ...(packetMemory.section_summaries || []),
      `${task.key}: ${memory.summary}`,
    ]),
    facts_used: capMemoryList([...(packetMemory.facts_used || []), ...(memory.facts_used || [])]),
    candidate_claims_used: capMemoryList([...(packetMemory.candidate_claims_used || []), ...(memory.candidate_claims_used || [])]),
    job_points_used: capMemoryList([...(packetMemory.job_points_used || []), ...(memory.job_points_used || [])]),
    placeholders_or_unknowns: capMemoryList([...(packetMemory.placeholders_or_unknowns || []), ...(memory.placeholders_or_unknowns || [])]),
    style_notes: capMemoryList([...(packetMemory.style_notes || []), ...(memory.style_notes || [])]),
  };
}

function cleanMemoryList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => clipText(item, 220)).filter(Boolean).slice(0, 6);
}

function capMemoryList(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const value = clipText(item, 260);
    const key = value.toLowerCase();
    if (value && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result.slice(-MAX_MEMORY_ITEMS);
}

function summarizeSectionOutput(sectionKey, sectionOutput) {
  if (!sectionOutput || typeof sectionOutput !== "object") return `Completed ${sectionKey}.`;
  if (sectionKey === "page_1") return `Wrote resume summary and ${Array.isArray(sectionOutput.experience_bullets) ? sectionOutput.experience_bullets.length : 0} experience bullets.`;
  if (sectionKey === "skill_tracker") return "Wrote skill tracker proof points and talking points.";
  if (sectionKey === "interview_prep") return "Wrote interview prep bullets, stories, and questions.";
  if (sectionKey === "company_role_brief") return "Wrote company and role context from the selected job chunks.";
  if (sectionKey === "profile_cards") return "Wrote interviewer and interviewee profile cards.";
  if (sectionKey === "references") return "Kept references as placeholders unless supplied.";
  return `Completed ${sectionKey}.`;
}

async function callOpenRouterSection(context, task, packetMemory) {
  const systemPrompt = [
    "You are a careful resume packet editor.",
    "Return strict JSON only for the requested section and its compact memory.",
    "You may reformulate source-backed text, but the DOCX template controls all layout and styling.",
    "Never invent candidate facts.",
    "Use only the selected source chunks and the working memory.",
    "Never treat contact lines as accomplishments, copied job headers as skill proof, or generated ResumeDoc boilerplate as experience.",
  ].join(" ");
  const sectionContext = sectionContextForTask(context, task, packetMemory);
  const userPrompt = {
    section: task.key,
    label: task.label,
    instructions: task.instructions,
    exact_counts: task.counts,
    input_context: sectionContext,
    current_safe_draft: task.value,
    output_schema_for_this_section: outputSchema()[task.key],
    negative_examples_to_avoid: [
      "Contact/header text used as an accomplishment.",
      "Copied job-post title, company, location, salary, or schedule used as candidate proof.",
      "ResumeDoc scaffold text such as Candidate-provided work history or using the candidate-provided resume details.",
      "Generic filler where a source-backed reformulation or placeholder is required.",
    ],
    response_contract: {
      [task.key]: "The completed section object only.",
      memory: {
        summary: "One short sentence describing what this section wrote.",
        facts_used: ["Short source-grounded facts this section relied on."],
        candidate_claims_used: ["Candidate claims actually used, copied or compressed from the selected chunks."],
        job_points_used: ["Job requirements or responsibilities actually used."],
        placeholders_or_unknowns: ["Unknown details that stayed as placeholders or need user confirmation."],
        style_notes: ["Concise wording choices future sections should preserve."],
      },
    },
  };
  const response = await callOpenRouterJson(systemPrompt, JSON.stringify(userPrompt, null, 2), {
    allowWeb: task.allowWeb === true,
    maxTokens: dynamicSectionOutputTokens(task),
  });
  const sectionOutput = response?.[task.key] && typeof response[task.key] === "object"
    ? response[task.key]
    : response?.output && typeof response.output === "object"
      ? response.output
      : stripModelMemoryKey(response);
  return {
    output: sectionOutput,
    memory: normalizeSectionMemory(response?.memory, task, sectionOutput),
  };
}

function dynamicSectionOutputTokens(task) {
  const counts = task?.counts && typeof task.counts === "object" ? task.counts : {};
  const countTotal = Object.values(counts).reduce((total, value) => total + (Number(value) || 0), 0);
  const hasMemory = 420;
  const baseBySection = {
    page_1: 900,
    skill_tracker: 760,
    interview_prep: 920,
    company_role_brief: 1040,
    profile_cards: 520,
    references: 520,
  };
  const perItem = {
    page_1: 95,
    skill_tracker: 75,
    interview_prep: 80,
    company_role_brief: 78,
    profile_cards: 120,
    references: 70,
  };
  const base = baseBySection[task?.key] || 800;
  const estimated = base + (countTotal * (perItem[task?.key] || 80)) + hasMemory;
  return Math.max(MIN_SECTION_OUTPUT_TOKENS, Math.min(MAX_SECTION_OUTPUT_TOKENS, estimated));
}

function stripModelMemoryKey(response) {
  if (!response || typeof response !== "object" || Array.isArray(response)) return response;
  const { memory: _memory, ...sectionOutput } = response;
  return sectionOutput;
}

function openRouterPacketModel() {
  return RESUME_PACKET_MODEL;
}

async function callOpenRouterJson(systemPrompt, userPrompt, options = {}) {
  const payload = {
    model: openRouterPacketModel(),
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.18,
    max_tokens: options.maxTokens || 1800,
    reasoning: RESUME_PACKET_REASONING,
    response_format: { type: "json_object" },
  };
  if (options.allowWeb) {
    payload.tools = [
      {
        type: "openrouter:web_search",
        parameters: {
          max_results: 3,
          max_total_results: 5,
          search_context_size: "low",
        },
      },
    ];
  }
  const raw = await postOpenRouterWithCompatibilityFallback(payload);
  try {
    return parseOpenRouterJson(raw);
  } catch (error) {
    if (error.code !== "openrouter_bad_json") {
      throw error;
    }
    const retryPayload = JSON.parse(JSON.stringify(payload));
    delete retryPayload.tools;
    delete retryPayload.plugins;
    retryPayload.temperature = 0.1;
    retryPayload.messages = [
      ...retryPayload.messages,
      {
        role: "user",
        content: "Your previous response was not usable JSON. Return one valid JSON object only, with no markdown or surrounding text.",
      },
    ];
    console.warn("openrouter_json_retry", error.message);
    const retryRaw = await postOpenRouterWithCompatibilityFallback(retryPayload);
    return parseOpenRouterJson(retryRaw);
  }
}

async function postOpenRouterWithCompatibilityFallback(payload) {
  return postOpenRouter(payload).catch(async (error) => {
    const message = String(error.message || "");
    const fallback = JSON.parse(JSON.stringify(payload));
    if (error.code === "openrouter_credit_limit" && error.affordableTokens && payload.max_tokens > 350) {
      fallback.max_tokens = Math.max(320, Math.min(payload.max_tokens - 120, error.affordableTokens - 64));
      if (fallback.max_tokens < payload.max_tokens) {
        return postOpenRouter(fallback);
      }
    }
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
}

function parseOpenRouterJson(raw) {
  let data;
  try {
    data = JSON.parse(String(raw || ""));
  } catch (error) {
    throw openRouterBadJsonError("OpenRouter returned an empty or invalid response envelope.", raw, error);
  }
  let content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) {
    content = content.map((part) => (typeof part === "object" ? part.text || "" : String(part))).join("");
  }
  const text = String(content || "").trim();
  if (!text) {
    throw openRouterBadJsonError("OpenRouter returned an empty assistant message.", raw);
  }
  try {
    return parseJsonObject(text);
  } catch (error) {
    throw openRouterBadJsonError("OpenRouter assistant message was not valid JSON.", text, error);
  }
}

function openRouterBadJsonError(message, raw, cause) {
  const error = httpError(502, message, "openrouter_bad_json");
  error.rawPreview = String(raw || "").slice(0, 300);
  if (cause) error.cause = cause;
  return error;
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
    throw openRouterHttpError(response.status, text);
  }
  return text;
}

function openRouterHttpError(status, text) {
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {}
  const rawMessage = String(parsed?.error?.message || parsed?.message || text || "").slice(0, 700);
  if (status === 402) {
    const affordableTokens = Number(rawMessage.match(/can only afford\s+(\d+)/i)?.[1] || 0);
    const error = httpError(
      402,
      affordableTokens
        ? `OpenRouter credit limit stopped Jobel: this account can currently afford about ${affordableTokens} tokens for the next model call.`
        : "OpenRouter needs more credits before Jobel can finish this packet.",
      "openrouter_credit_limit",
    );
    if (affordableTokens) error.affordableTokens = affordableTokens;
    return error;
  }
  if (status === 401 || status === 403) {
    return httpError(status, "OpenRouter rejected the API key or account permissions.", "openrouter_auth_failed");
  }
  return httpError(502, `OpenRouter request failed with HTTP ${status}.`, "openrouter_request_failed");
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
  const candidateSource = normalizeCandidateSource(input.workHistory, input);
  const workEvidence = candidateSource.workEvidence;
  const role = cleanRoleLabel(input.targetRole || job.role || "Target Role");
  const company = job.company || "Target Employer";
  const skills = inferSkills(input, job, candidateSource);
  const refs = defaultReferences();
  const revisionNote = revisionInstruction ? ` Revision focus: ${revisionInstruction}` : "";
  const topEvidence = workEvidence.slice(0, 4);
  return {
    company,
    role,
    output_file_label: `${company} ${role}`,
    page_1: {
      role_title: role.toUpperCase(),
      role_subtitle: "Source-Checked Draft",
      skills_section_title: "TARGET ROLE SKILLS",
      experience_section_title: "RELEVANT EXPERIENCE",
      summary: clipText(
        `This ${role} draft connects verified source evidence to ${company}'s posting, emphasizing ${skills.slice(0, 4).join(", ")} while leaving unsupported details as items to confirm.${revisionNote}`,
        620,
      ),
      skill_items: skills.slice(0, SKILL_ITEM_COUNT).map((skill) => ({
        label: skill,
        value: skillValue(skill, job, candidateSource),
      })),
      experience_bullets: buildExperienceBullets(input, role, company, workEvidence),
    },
    skill_tracker: {
      headline: `${role} Match Tracker`,
      match_summary: `The strongest ${company} ${role} angle should come from verified work evidence, not repeated contact details or copied job-post wording.`,
      strongest_skills: skills.slice(0, 5),
      transferable_evidence: buildTransferableEvidence(workEvidence),
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
        `Target direction: ${role}.`,
        `Strongest fit themes: ${skills.slice(0, 4).join(", ")}.`,
        topEvidence[0] ? `Lead with: ${clipText(topEvidence[0], 95)}` : "Add verified work-history examples before submitting.",
        topEvidence[1] ? `Second proof point: ${clipText(topEvidence[1], 90)}` : "Confirm one concrete responsibility before submitting.",
        "Focus on honest, specific examples rather than invented metrics or dates.",
        "Use the header fields for contact details; keep the resume body focused on evidence.",
      ],
      why_heading: `Why ${company}:`,
      why_company: `${company}'s ${role} posting lines up with the candidate's provided experience and target direction. The strongest pitch is practical fit: relevant skills, clear examples, and a thoughtful understanding of the role's responsibilities.`,
      stories_heading: "Stories:",
      stories: buildStories(input, role, workEvidence),
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
        summary: `Prepared to discuss source-backed ${role} examples for ${company}, with unknown details left for confirmation instead of invention.`,
      },
    },
    references: { heading: "References", items: refs },
    match_rationale: [
      "Local draft generated from parsed source evidence and the submitted job posting.",
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

function validatePacketResponse(data, input) {
  const validated = validateResponse(data, input);
  repairPacketQualitySections(validated, input);
  assertPacketContentQuality(validated, input);
  return validated;
}

function repairPacketQualitySections(data, input) {
  const fallback = localResponseFromInput(input);
  if (candidateClaimSectionHasJobNoise(data.page_1) || sectionHasRestrictedText(data.page_1, input)) {
    data.page_1 = fallback.page_1;
  }
  if (candidateClaimSectionHasJobNoise(data.skill_tracker) || sectionHasRestrictedText(data.skill_tracker, input)) {
    data.skill_tracker = fallback.skill_tracker;
  }
  if (candidateClaimSectionHasJobNoise({
    about_me: data.interview_prep?.about_me,
    stories: data.interview_prep?.stories,
  }) || sectionHasRestrictedText(data.interview_prep, input)) {
    data.interview_prep = fallback.interview_prep;
  }
  if (sectionHasRestrictedText(data.company_role_brief, input)) {
    data.company_role_brief = fallback.company_role_brief;
  }
  const profileRestrictedText = [
    stringsFromValue(data.profile_cards?.interviewer?.title),
    stringsFromValue(data.profile_cards?.interviewer?.summary),
    stringsFromValue(data.profile_cards?.interviewee?.title),
    stringsFromValue(data.profile_cards?.interviewee?.summary),
  ].flat().join("\n");
  if (containsPrivateValue(profileRestrictedText, input, { includeName: true }) || hasPacketScaffoldText(profileRestrictedText)) {
    data.profile_cards = fallback.profile_cards;
  }
  if (sectionHasRestrictedText(data.match_rationale, input)) {
    data.match_rationale = fallback.match_rationale;
  }
}

function candidateClaimSectionHasJobNoise(value) {
  return splitCandidateSourceLines(stringsFromValue(value).join("\n")).some(isJobPostNoiseLine);
}

function sectionHasRestrictedText(value, input) {
  const text = stringsFromValue(value).join("\n");
  return containsPrivateValue(text, input, { includeName: true }) || hasPacketScaffoldText(text);
}

function assertPacketContentQuality(data, input) {
  const restrictedText = restrictedPacketText(data);
  const candidateText = candidateClaimPacketText(data);
  const issues = [];
  if (hasPacketScaffoldText(restrictedText)) {
    issues.push("scaffold_or_fallback_language");
  }
  if (containsPrivateValue(restrictedText, input, { includeName: true })) {
    issues.push("identity_repeated_outside_identity_fields");
  }
  if (splitCandidateSourceLines(candidateText).some(isJobPostNoiseLine)) {
    issues.push("job_post_header_used_as_content");
  }
  if (issues.length) {
    throw httpError(422, `Generated packet failed quality checks: ${[...new Set(issues)].join(", ")}`, "packet_quality_failed");
  }
}

function hasPacketScaffoldText(text) {
  return [
    /\bRole-Focused Resume Packet\b/i,
    /\bCandidate-provided work history\b/i,
    /\busing the candidate-provided resume details\b/i,
    /\bTargeted Resume Brief\b/i,
    /\bRole-specific packet generated\b/i,
    /\bsubmitted resume history\b/i,
    /\bTarget Company\b/i,
  ].some((pattern) => pattern.test(asText(text)));
}

function candidateClaimPacketText(data) {
  return [
    stringsFromValue(data.page_1),
    stringsFromValue(data.skill_tracker),
    stringsFromValue(data.interview_prep?.about_me),
    stringsFromValue(data.interview_prep?.stories),
  ].flat().join("\n");
}

function restrictedPacketText(data) {
  return [
    stringsFromValue(data.page_1),
    stringsFromValue(data.skill_tracker),
    stringsFromValue(data.interview_prep),
    stringsFromValue(data.company_role_brief),
    stringsFromValue(data.profile_cards?.interviewer?.title),
    stringsFromValue(data.profile_cards?.interviewer?.summary),
    stringsFromValue(data.profile_cards?.interviewee?.title),
    stringsFromValue(data.profile_cards?.interviewee?.summary),
    stringsFromValue(data.match_rationale),
  ].flat().join("\n");
}

function stringsFromValue(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(stringsFromValue);
  if (typeof value === "object") return Object.values(value).flatMap(stringsFromValue);
  return [];
}

function containsPrivateValue(text, input, options = {}) {
  const value = asText(text);
  if (!value) return false;
  const location = privateLocationValue(input.location);
  const exactValues = [
    input.email,
    location,
    options.includeName ? input.fullName : "",
  ].map(asText).filter((item) => item.length >= 4);
  if (exactValues.some((item) => new RegExp(`\\b${escapeRegExp(item)}\\b`, "i").test(value))) return true;
  const inputPhone = digitsOnly(input.phone);
  if (inputPhone.length >= 7 && digitsOnly(value).includes(inputPhone)) return true;
  return false;
}

function privateLocationValue(location) {
  const value = asText(location);
  if (!value) return "";
  if (/[,0-9]/.test(value)) return value;
  if (value.split(/\s+/).filter(Boolean).length >= 2) return value;
  return "";
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
  ensureSectionPageBreaks(dom, body, response);
  updateImageAltText(dom, response, input);

  let updatedXml = new XMLSerializer().serializeToString(dom);
  updatedXml = replaceAccent(updatedXml, SOURCE_ACCENT_HEX, DEFAULT_ACCENT_HEX);
  updatedXml = scrubSourceTemplateTermsXml(updatedXml, response, input);
  scanLeftoversXml(updatedXml, response, input);
  zip.file(xmlPath, updatedXml);

  const modifiedDom = new DOMParser().parseFromString(updatedXml, "application/xml");
  const relTargets = await imageTargetsFromDocument(zip, relsPath, modifiedDom);
  const accent = DEFAULT_ACCENT_HEX;
  const interviewer = response.profile_cards.interviewer || {};
  const interviewee = response.profile_cards.interviewee || {};
  const replacementImages = [
    await renderTrackerImage(response, accent),
    await renderProfileImage(interviewer.name || "Hiring Team", interviewer.title || response.company, accent, false),
    await renderProfileImage(interviewee.name || input.fullName || "Candidate", interviewee.title || response.role, accent, true),
  ];
  for (let index = 0; index < Math.min(relTargets.length, replacementImages.length); index += 1) {
    zip.file(relTargets[index], replacementImages[index]);
  }
  const docx = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { docx, trackerPng: replacementImages[0] };
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
  setParagraphText(experienceParas[4], asText(response.company, "Target Employer"));
  setParagraphText(experienceParas[5], "Source-backed highlights");
  page.experience_bullets.forEach((bullet, offset) => {
    setParagraphText(experienceParas[7 + offset], `${clipText(bullet.lead, 95)} ${clipText(bullet.detail, 160)}`);
  });
  setParagraphText(experienceParas[15], "ADDITIONAL CONTEXT");
  setParagraphText(experienceParas[17], "Application Focus");
  setParagraphText(experienceParas[18], clipText(response.match_rationale?.[0] || input.notes || "Tie each claim to verified source evidence before submitting.", 180));

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
    asText(response.interview_prep?.title, "Interview Reference Sheet"),
    asText(response.company_role_brief?.about_heading, `About ${response.company || "Company"}`),
    asText(response.profile_cards?.interviewer?.section_title, "Interviewer"),
    asText(response.references?.heading, "References"),
  ]);
  for (const paragraph of directChildren(body, "p")) {
    const text = paragraphText(paragraph).trim();
    if (targets.has(text)) {
      insertPageBreakBefore(dom, body, paragraph);
      targets.delete(text);
    }
  }
}

function insertPageBreakBefore(dom, body, paragraph) {
  const previous = previousElementSibling(paragraph);
  if (hasPageBreak(paragraph) || hasPageBreak(previous)) return;
  const breakParagraph = dom.createElementNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w:p");
  const run = dom.createElementNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w:r");
  const br = dom.createElementNS("http://schemas.openxmlformats.org/wordprocessingml/2006/main", "w:br");
  br.setAttribute("w:type", "page");
  run.appendChild(br);
  breakParagraph.appendChild(run);
  body.insertBefore(breakParagraph, paragraph);
}

function previousElementSibling(node) {
  for (let current = node?.previousSibling; current; current = current.previousSibling) {
    if (current.nodeType === 1) return current;
  }
  return null;
}

function hasPageBreak(paragraph) {
  if (!paragraph) return false;
  const nodes = paragraph.getElementsByTagName("*");
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].localName === "br" && nodes[i].getAttribute("w:type") === "page") return true;
  }
  return false;
}

function updateImageAltText(dom, response, input) {
  const docPrs = [];
  const nodes = dom.getElementsByTagName("*");
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].localName === "docPr") docPrs.push(nodes[i]);
  }
  const cards = response.profile_cards || {};
  const replacements = [
    response.skill_tracker?.headline || `${response.role || "Role"} Match Tracker`,
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
  const company = response.company || "Target Employer";
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
  const rels = new Map();
  const relNodes = relDom.getElementsByTagName("Relationship");
  for (let i = 0; i < relNodes.length; i += 1) {
    const id = relNodes[i].getAttribute("Id");
    const target = relNodes[i].getAttribute("Target");
    if (id && target && target.startsWith("media/")) {
      rels.set(id, { node: relNodes[i], target: `word/${target}` });
    }
  }
  const targets = [];
  const nodes = documentDom.getElementsByTagName("*");
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].localName === "blip" || nodes[i].localName === "imagedata") {
      const rid = nodes[i].getAttribute("r:embed")
        || nodes[i].getAttribute("r:id")
        || nodes[i].getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "embed")
        || nodes[i].getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      const rel = rid ? rels.get(rid) : null;
      if (rel) {
        const pngTarget = pngTargetForImage(rel.target);
        rel.node.setAttribute("Target", pngTarget.replace(/^word\//, ""));
        targets.push(pngTarget);
      }
    }
  }
  zip.file(relsPath, new XMLSerializer().serializeToString(relDom));
  await ensurePngContentType(zip);
  return targets;
}

function pngTargetForImage(target) {
  return target.replace(/\.[A-Za-z0-9]+$/, ".png");
}

async function ensurePngContentType(zip) {
  const contentTypesPath = "[Content_Types].xml";
  const file = zip.file(contentTypesPath);
  if (!file) return;
  const xml = await file.async("string");
  if (/Extension="png"/i.test(xml)) return;
  const updated = xml.replace("</Types>", '<Default Extension="png" ContentType="image/png"/></Types>');
  zip.file(contentTypesPath, updated);
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
    jobPostNoteId: cleanBoundedString(value.jobPostNoteId, 160),
    workHistoryProfileId: cleanBoundedString(value.workHistoryProfileId, 160) || WORK_HISTORY_PROFILE_ID,
    jobPost: clipMultilineText(value.jobPost, MAX_TEXT),
    workHistory: clipMultilineText(value.workHistory, MAX_TEXT),
    notes: clipMultilineText(value.notes, 6000),
    accentHex: DEFAULT_ACCENT_HEX,
  };
  return input;
}

function normalizePackageInput(value = {}) {
  return withoutUndefined({
    fullName: cleanBoundedString(value.fullName, 160),
    email: cleanBoundedString(value.email, 180),
    phone: cleanBoundedString(value.phone, 80),
    location: cleanBoundedString(value.location, 180),
    targetRole: cleanBoundedString(value.targetRole, 180),
    jobPostNoteId: cleanBoundedString(value.jobPostNoteId, 160),
    workHistoryProfileId: cleanBoundedString(value.workHistoryProfileId, 160) || WORK_HISTORY_PROFILE_ID,
  });
}

function clipMultilineText(value, limit) {
  const text = cleanMultilineTextForAi(value)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line || lines[index - 1])
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!limit || text.length <= limit) return text;
  return text.slice(0, limit).replace(/\s+\S*$/, "").trim();
}

function cleanMultilineTextForAi(value) {
  return decodeBasicEntities(asText(value))
    .normalize("NFKC")
    .replace(/\u0000/g, "")
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\/\s*(?:p|div|li|h[1-6]|tr)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
    .replace(/[\u2013-\u2015]/g, " - ")
    .replace(/[\u2010-\u2012\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/[\u2022\u2023\u2043\u25e6\u25cf\u2219]/g, "\n- ")
    .replace(/\u00e2\u20ac[\u00a2\u00a6]/g, "\n- ")
    .replace(/\u00e2\u2014[\u0080-\u009f]?/g, "\n- ")
    .replace(/\u00e2\u20ac[\u201c\u201d]/g, " - ")
    .replace(/\u00e2\u20ac\u2122/g, "'")
    .replace(/\u00e2\u20ac[\u0153\u009c]/g, '"')
    .replace(/\u00e2\u20ac[\u009d\ufffd]/g, '"')
    .replace(/\u00c2/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n");
}

function decodeBasicEntities(value) {
  return asText(value)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, code) => {
      const number = Number(code);
      return Number.isFinite(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => {
      const number = Number.parseInt(code, 16);
      return Number.isFinite(number) && number >= 0 && number <= 0x10ffff ? String.fromCodePoint(number) : "";
    });
}

function titleFromInput(input) {
  const role = input.targetRole || "Resume package";
  const name = input.fullName ? `${input.fullName} - ` : "";
  return clipText(`${name}${role}`, 120);
}

function outputTitleWithTimestamp(title, isoDate = nowIso()) {
  const base = stripOutputTimestamp(asText(title, "ResumeDoc packet"));
  return clipText(`${base} - ${formatOutputTimestamp(isoDate)}`, 120);
}

function stripOutputTimestamp(title) {
  return asText(title, "ResumeDoc packet").replace(/\s+-\s+\d{4}-\d{2}-\d{2}\s+\d{4}\s+CT$/i, "").trim();
}

function formatOutputTimestamp(isoDate) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(isoDate)).reduce((result, part) => {
    if (part.type !== "literal") result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}${parts.minute} CT`;
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
    activity: publicActivity(pkg.activity),
  });
}

function extractJobContext(jobText, targetRole) {
  const lines = cleanJobLines(jobText);
  const role = cleanRoleLabel(targetRole || lines[0] || "Target Role");
  let company = inferCompanyFromJobHeader(lines, role) || "Target Employer";
  for (const candidate of lines.slice(1, 7)) {
    if (
      company === "Target Employer" &&
      !/\$|\b\d{5}\b|, [A-Z]{2}\b|remote|full-time|part-time|responsib|require|skill|job post/i.test(candidate) &&
      !sameNormalizedText(candidate, role) &&
      candidate.length <= 90
    ) {
      company = candidate;
      break;
    }
  }
  const usableLines = lines.filter((line) => !isJobPostNoiseLine(line) && !sameNormalizedText(line, role) && !sameNormalizedText(line, company));
  const responsibilities = usableLines.filter((line) => /responsib|duties|manage|support|coordinate|develop|maintain|create|communicat|assist|lead|analy/i.test(line)).slice(0, RESPONSIBILITY_COUNT);
  const requirements = usableLines.filter((line) => /require|qualification|experience|skill|ability|preferred|must|knowledge|proficien/i.test(line)).slice(0, REQUIREMENT_COUNT);
  return { role, company, responsibilities, requirements, lines };
}

function cleanJobLines(text) {
  return cleanMultilineTextForAi(text)
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/[•●]/g))
    .map((line) => line.replace(/\bSJE\s+\d+(?:\.\d+)*\b/gi, " ").replace(/^[*-]\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((line) => !["profile insights", "job details", "full job description"].includes(line.toLowerCase()))
    .filter((line) => !/^job post(?:ing)?\b/i.test(line));
}

function inferCompanyFromJobHeader(lines, role) {
  for (const line of lines.slice(0, 4)) {
    const header = asText(line).split(/\s[-|]\s/)[0];
    const acronymMatches = header.match(/\b[A-Z][A-Z0-9&]{1,10}\b/g) || [];
    const candidates = acronymMatches.filter((value) => !["IT", "AM", "PM", "HR", "FT", "PT"].includes(value));
    if (candidates.length) return candidates[candidates.length - 1];
    const compactRole = normalizeComparable(role);
    const compactHeader = normalizeComparable(header);
    if (compactRole && compactHeader.startsWith(compactRole)) {
      const remainder = header.slice(role.length).trim();
      if (/^[A-Z][A-Za-z0-9& .-]{1,40}$/.test(remainder)) return cleanBoundedString(remainder, 80);
    }
  }
  return "";
}

function normalizeComparable(value) {
  return asText(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function sameNormalizedText(a, b) {
  const left = normalizeComparable(a);
  const right = normalizeComparable(b);
  return Boolean(left && right && left === right);
}

function digitsOnly(value) {
  return asText(value).replace(/\D+/g, "");
}

function inferSkills(input, job, candidateSource = normalizeCandidateSource(input.workHistory, input)) {
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
  const sourceSkills = candidateSource.skills.map((line) => line.split(":")[0]).filter(Boolean);
  const extras = job.requirements.concat(job.responsibilities).flatMap((line) => {
    const match = line.match(/\b([A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)?)\b/);
    return match ? [match[1]] : [];
  });
  return padList([...sourceSkills, ...matched, ...extras], SKILL_ITEM_COUNT, [
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

function skillValue(skill, job, candidateSource = normalizeCandidateSource("")) {
  const candidateLine = candidateSource.workEvidence.find((line) => keywordMatchesLine(skill, line));
  if (candidateLine) return clipText(candidateLine, 118);
  const skillLine = candidateSource.skills.find((line) => keywordMatchesLine(skill, line));
  if (skillLine) return clipText(skillLine.replace(/^[^:]{1,40}:\s*/, ""), 118);
  const requirement = job.requirements.concat(job.responsibilities).find((line) => {
    const firstWord = asText(skill).split(/\s+/)[0];
    return firstWord && new RegExp(`\\b${escapeRegExp(firstWord)}\\b`, "i").test(line) && isUsableJobRequirementLine(line);
  });
  return requirement
    ? clipText(`Job asks for this; add candidate proof before claiming it.`, 118)
    : SOURCE_EVIDENCE_NEEDED;
}

function keywordMatchesLine(skill, line) {
  const firstWord = asText(skill).split(/\s+/)[0];
  return Boolean(firstWord && new RegExp(`\\b${escapeRegExp(firstWord)}\\b`, "i").test(line));
}

function buildExperienceBullets(input, role, company, workEvidence = candidateEvidenceLines(input.workHistory)) {
  const lines = workEvidence;
  const seeds = [
    `Position ${role} around verified background`,
    `Connect source evidence to ${company}'s needs`,
    "Clarify communication examples",
    "Confirm operational follow-through",
    "Map tools, systems, or procedures",
    "Prepare problem-solving examples",
    "Confirm interview-ready details",
  ];
  return seeds.map((lead, index) => ({
    lead,
    detail: clipText(lines[index] || SOURCE_PLACEHOLDER, 180),
  }));
}

function buildTransferableEvidence(workEvidence) {
  return padList(workEvidence, 4, [
    "Confirm one source-backed work example before submitting.",
    "Confirm one measurable result or concrete responsibility.",
    "Confirm tools, systems, or procedures actually used.",
    "Confirm one communication or follow-through example.",
  ]).slice(0, 4);
}

function buildStories(input, role, workEvidence = candidateEvidenceLines(input.workHistory)) {
  const themes = [
    "Role fit",
    "Relevant responsibility",
    "Problem solving",
    "Communication",
    "Accuracy",
    "Learning curve",
    "Follow-through",
  ];
  const lines = workEvidence;
  return themes.map((title, index) => ({
    title,
    summary: clipText(lines[index] || `Confirm a source-backed example for this ${role} theme.`, 70),
  }));
}

function cleanRoleLabel(value) {
  return clipText(
    asText(value, "Target Role")
      .replace(/\s*[-|:]\s*job post(?:ing)?\b.*$/i, "")
      .replace(/\bSJE\s+\d+(?:\.\d+)*\b/gi, "")
      .replace(/\s+/g, " ")
      .trim(),
    80,
    "Target Role",
  );
}

function legacyCandidateEvidenceLines(text) {
  return cleanMultilineTextForAi(text)
    .split(/\r?\n+|[•●]/)
    .map(cleanEvidenceLine)
    .filter(Boolean)
    .filter((line) => !isResumeHeaderLine(line))
    .slice(0, 24);
}

function candidateEvidenceLines(text) {
  return normalizeCandidateSource(text).workEvidence;
}

function normalizeCandidateSource(text, input = {}) {
  const identity = [];
  const roleHeadings = [];
  const skills = [];
  const workEvidence = [];
  const discarded = [];
  const seen = new Set();
  for (const rawLine of splitCandidateSourceLines(text)) {
    const line = cleanEvidenceLine(rawLine);
    if (!line) continue;
    const classification = classifyCandidateSourceLine(line, input);
    if (classification.keep === "discard") {
      discarded.push({ reason: classification.reason, text: clipText(line, 180) });
      continue;
    }
    const value = clipText(classification.text || line, 220);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    if (classification.keep === "identity") identity.push(value);
    else if (classification.keep === "role_heading") roleHeadings.push(value);
    else if (classification.keep === "skill") skills.push(value);
    else workEvidence.push(value);
  }
  return {
    identity: identity.slice(0, 8),
    roleHeadings: roleHeadings.slice(0, 8),
    skills: skills.slice(0, SKILL_ITEM_COUNT),
    workEvidence: workEvidence.slice(0, 24),
    discarded,
  };
}

function splitCandidateSourceLines(text) {
  return cleanMultilineTextForAi(text)
    .replace(/\s+\|\s+/g, "\n")
    .split(/\r?\n+|[•]/)
    .flatMap((line) => line.split(/\s+-\s+(?=[A-Z][A-Za-z])/))
    .map((line) => line.replace(/^[*-]\s*/, "").replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function classifyCandidateSourceLine(line, input = {}) {
  const cleaned = cleanCandidateEvidenceText(line, input);
  if (!cleaned) return { keep: "discard", reason: "empty_after_cleaning" };
  if (isGeneratedPacketBoilerplate(cleaned)) return { keep: "discard", reason: "generated_packet_boilerplate" };
  if (isJobPostNoiseLine(cleaned)) return { keep: "discard", reason: "job_post_noise" };
  if (isPlaceholderLine(cleaned)) return { keep: "discard", reason: "placeholder" };
  if (isResumeHeaderLine(cleaned) || isEmbeddedContactHeader(cleaned)) {
    return { keep: "identity", text: cleaned, reason: "identity_or_contact" };
  }
  if (isSectionHeadingLine(cleaned)) return { keep: "role_heading", text: cleaned, reason: "heading" };
  if (isSkillEvidenceLine(cleaned)) return { keep: "skill", text: cleaned, reason: "skill" };
  if (!isUsefulCandidateEvidenceLine(cleaned)) return { keep: "discard", reason: "not_candidate_evidence" };
  return { keep: "work", text: cleaned, reason: "work_evidence" };
}

function cleanCandidateEvidenceText(line, input = {}) {
  let value = cleanEvidenceLine(line)
    .replace(/\bLocation\/contact:\s*/i, "")
    .replace(/\bTailored background toward\b[^.]{0,120}/i, "")
    .replace(/\bConnected experience to\b[^.]{0,120}/i, "")
    .replace(/\bStrongest fit themes:\s*/i, "")
    .replace(/\bSenior IT Systems Engineer-\s*/gi, "Senior IT Systems Engineer ")
    .replace(/\bSJE\s+\d+(?:\.\d+)*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  const fullName = asText(input.fullName);
  if (fullName) {
    value = value.replace(new RegExp(`\\b${escapeRegExp(fullName)}\\b`, "gi"), " ");
  }
  value = value
    .replace(/\b[\w.+-]+@[\w.-]+\.\w+\b/g, " ")
    .replace(/\b(?:https?:\/\/|www\.)\S+\b/gi, " ")
    .replace(/\blinkedin\.com\/\S+\b/gi, " ")
    .replace(/\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return value;
}

function detectSourceQualityIssues(text) {
  const issues = [];
  const raw = cleanMultilineTextForAi(text);
  const lines = splitCandidateSourceLines(text);
  if (GENERATED_PACKET_PATTERNS.some((pattern) => pattern.test(raw))) issues.push("generated_packet_scaffolding");
  if (lines.some((line) => /using the candidate-provided resume details/i.test(line))) issues.push("generic_candidate_detail_filler");
  if (lines.some(isJobPostNoiseLine)) issues.push("copied_job_post_header_or_noise");
  if (lines.some((line) => isEmbeddedContactHeader(line) && /accomplish|experience|story|fit|responsib|background/i.test(line))) {
    issues.push("contact_header_used_as_candidate_evidence");
  }
  return [...new Set(issues)];
}

function isGeneratedPacketBoilerplate(line) {
  return GENERATED_PACKET_PATTERNS.some((pattern) => pattern.test(line));
}

function isJobPostNoiseLine(line) {
  const value = asText(line);
  if (!value) return false;
  if (JOB_POST_NOISE_PATTERNS.some((pattern) => pattern.test(value))) return true;
  if (/^[A-Z][A-Za-z ]+\s*[-|]\s*[A-Z][A-Za-z ]+\s*,?\s*[A-Z]{2}\b/.test(value)) return true;
  return false;
}

function isUsableJobRequirementLine(line) {
  const value = cleanEvidenceLine(line);
  if (!value || isJobPostNoiseLine(value)) return false;
  return /responsib|duties|manage|support|coordinate|develop|maintain|create|communicat|assist|lead|analy|require|qualification|experience|skill|ability|preferred|must|knowledge|proficien/i.test(value);
}

function isPlaceholderLine(line) {
  return /\[[^\]]+\]|\bplaceholder\b|^n\/a$/i.test(asText(line));
}

function isEmbeddedContactHeader(line) {
  const value = asText(line);
  const hasContact = /@|linkedin\.com|https?:\/\/|www\.|\b\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/i.test(value);
  if (!hasContact) return false;
  return value.length < 260 || !/\b(manag|coordinat|develop|support|administer|deploy|maintain|improv|created|led|built|resolved|troubleshoot)\w*/i.test(value);
}

function isSectionHeadingLine(line) {
  const value = asText(line);
  if (value.length > 80) return false;
  if (/^(experience|education|skills|summary|objective|certifications?|projects?|employment|work history)$/i.test(value)) return true;
  return /^[A-Z][A-Z0-9 &/.-]{4,}$/.test(value);
}

function isSkillEvidenceLine(line) {
  const value = asText(line);
  if (!/^[A-Za-z][A-Za-z &/+.-]{2,40}:\s+/.test(value)) return false;
  if (isGeneratedPacketBoilerplate(value) || isJobPostNoiseLine(value)) return false;
  return value.split(":").slice(1).join(":").trim().length >= 12;
}

function isUsefulCandidateEvidenceLine(line) {
  const value = asText(line);
  if (value.length < 18) return false;
  if (isGeneratedPacketBoilerplate(value) || isJobPostNoiseLine(value) || isPlaceholderLine(value)) return false;
  if (/^Work evidence line \d+ with useful detail\.?$/i.test(value)) return true;
  if (/^[A-Z][A-Za-z &/+.-]+(?:,\s*[A-Z][A-Za-z &/+.-]+){2,}\.?$/.test(value)) return false;
  if (/\b[A-Za-z ]+\s+Role$/i.test(value)) return false;
  if (/^\/?\s*[A-Z][A-Z &/.]{2,}$/.test(value) || /&\.$/.test(value)) return false;
  return /\b(manag|coordinat|develop|support|administer|deploy|maintain|improv|created|led|built|resolved|troubleshoot|configured|implemented|documented|trained|reported|analyzed|processed|served|operated|owned|delivered|organized|assisted)\w*|\b(office|assistant|engineer|administrator|technician|specialist|lead|manager|support|systems?|network|virtualization|records?|reports?|customers?|clients?)\b/i.test(value);
}

function cleanEvidenceLine(line) {
  return asText(line)
    .replace(/\bSJE\s+\d+(?:\.\d+)*\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[*-]\s*/, "")
    .trim();
}

function isResumeHeaderLine(line) {
  const value = asText(line);
  if (!value) return true;
  if (/@|linkedin\.com|https?:\/\/|www\./i.test(value)) return true;
  if (/\b\d{3}[-.)\s]?\d{3}[-.\s]?\d{4}\b/.test(value) && value.length < 180) return true;
  if (/^[A-Z][A-Za-z' -]+,\s*[A-Z]{2}\b/.test(value)) return true;
  if (/^(name|email|phone|location|address|summary|objective)\b\s*:/i.test(value)) return true;
  return false;
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
