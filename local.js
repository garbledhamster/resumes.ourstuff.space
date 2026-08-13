"use strict";
const STORAGE_KEY = "resumedoc.local.workspace.v1";
const SCHEMA_VERSION = 1;
const questionNodes = [
    { id: "responsibility", prerequisites: [], question: "What responsibility did people depend on you to handle?", reason: "This can reveal dependable work that a job title may hide." },
    { id: "improvement", prerequisites: ["responsibility"], question: "What did you make faster, safer, clearer, or easier?", reason: "Specific changes help employers understand your contribution." },
    { id: "pressure", prerequisites: ["responsibility"], question: "Tell me about a difficult situation you helped stabilize.", reason: "This can show judgment, communication, and follow-through." },
    { id: "learning", prerequisites: [], question: "What did you learn quickly enough to use at work?", reason: "This can show adaptability without inventing an expertise claim." },
    { id: "recognition", prerequisites: ["pressure"], question: "What have coworkers or customers trusted you to help with?", reason: "Repeated requests can point to a real strength." }
];
const MINIMUM_APPROVED_EVIDENCE = 3;
const STOP = new Set(["and", "the", "with", "for", "that", "this", "from", "your", "you", "our", "are", "was", "were", "will", "job", "role", "work", "have", "has", "into", "must"]);
const now = () => new Date().toISOString();
const fresh = () => ({ schemaVersion: 1, createdAt: now(), updatedAt: now(), evidence: [], rejectedStatements: [], answers: [], target: { role: "", company: "", location: "", schedule: "", seniority: "", compensation: "", direction: "", exclusions: "", url: "", verification: "unverified", checkedAt: "", description: "" }, comparisons: [], resume: null });
let recoveryMessage = "";
let state = load();
const pendingProposals = { manual: null, interview: null };
const rejectedProposalFingerprints = new Set();
let pendingImport = null;
let pendingResumeWording = [];
let pendingResumeTarget = null;
function byId(id) { const node = document.getElementById(id); if (!node)
    throw new Error(`Missing interface element: ${id}`); return node; }
function value(id) { return byId(id).value.trim(); }
function setValue(id, next) { byId(id).value = next; }
function setText(id, next) { byId(id).textContent = next; }
function show(id, visible = true) { byId(id).hidden = !visible; }
function make(tag, text) { const node = document.createElement(tag); if (text !== undefined)
    node.textContent = text; return node; }
function canonicalUtcTimestamp(value) { if (typeof value !== "string" || value.length < 1 || value.length > 100 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))
    return false; const parsed = new Date(value); if (Number.isNaN(parsed.getTime()))
    return false; const normalized = /\.\d{3}Z$/.test(value) ? parsed.toISOString() : parsed.toISOString().replace(".000Z", "Z"); return normalized === value; }
function calendarDate(value) { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false; const [year, month, day] = value.split("-").map(Number); const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day)); return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day; }
function sentence(raw) { const cleaned = raw.replace(/\s+/g, " ").trim(); if (!cleaned)
    return ""; return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`; }
function resumeGrammarV1(statement, style) { const source = sentence(statement); if (style === "source")
    return source; const concise = source.replace(/^(?:I|we)\s+/i, ""); return sentence(`${concise.charAt(0).toUpperCase()}${concise.slice(1)}`); }
function terms(text) { return [...new Set((text.toLowerCase().match(/[a-z][a-z0-9+.#-]{2,}/g) || []).filter(word => !STOP.has(word)))].slice(0, 30); }
function targetRequirements(target) { return target.description.split(/\r?\n|(?<=[.!?])\s+/).map(line => line.trim()).filter(Boolean); }
function deriveComparisons(target, evidence) { const approved = evidence.filter(item => item.status === "approved"); const excluded = terms(target.exclusions); return targetRequirements(target).map(phrase => { const needed = terms(phrase); const hits = approved.filter(item => needed.some(term => `${item.statement} ${item.organization} ${item.result}`.toLowerCase().includes(term))); const overlap = new Set(hits.flatMap(item => needed.filter(term => `${item.statement} ${item.organization} ${item.result}`.toLowerCase().includes(term)))).size; let status = "unknown"; let basis = "No approved evidence currently supports or disproves this requirement."; if (needed.some(term => excluded.includes(term))) {
    status = "excluded";
    basis = "This overlaps a user-entered exclusion.";
}
else if (hits.length && overlap >= Math.max(1, Math.ceil(needed.length * .6))) {
    status = "matched";
    basis = "Deterministic inference from the approved Career Evidence shown.";
}
else if (hits.length) {
    status = "partial";
    basis = "Some approved Career Evidence overlaps; the full requirement is not supported.";
}
else if (/required|must|minimum/i.test(phrase)) {
    status = "gap";
    basis = "The supplied job description marks this as required. No approved Career Evidence supports it.";
} return { phrase, status, evidenceIds: hits.map(item => item.id), basis }; }); }
function orderedRelevantEvidenceIds(comparisons) { return [...new Set(comparisons.filter(item => item.status === "matched" || item.status === "partial").flatMap(item => item.evidenceIds))]; }
function validWorkspace(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
        return false;
    const x = input;
    const record = (value) => !!value && typeof value === "object" && !Array.isArray(value);
    const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
    const bounded = (value, limit, min = 0) => typeof value === "string" && value.length >= min && value.length <= limit;
    const identifier = (value) => bounded(value, 200, 1) && /^[a-z0-9][a-z0-9._:-]*$/i.test(value);
    const oneOf = (value, allowed) => typeof value === "string" && allowed.includes(value);
    if (!exact(input, ["schemaVersion", "createdAt", "updatedAt", "evidence", "rejectedStatements", "answers", "target", "comparisons", "resume"]) || x.schemaVersion !== SCHEMA_VERSION || !canonicalUtcTimestamp(x.createdAt) || !canonicalUtcTimestamp(x.updatedAt))
        return false;
    if (!Array.isArray(x.evidence) || x.evidence.length > 5000)
        return false;
    const evidenceIds = new Set();
    const approvedEvidenceIds = new Set();
    for (const item of x.evidence) {
        if (!exact(item, ["id", "raw", "statement", "organization", "date", "result", "confidence", "status", "source", "privacyBoundary", "createdAt", "supersedes"]) || !identifier(item.id) || !bounded(item.raw, 20_000) || !bounded(item.statement, 20_000) || !bounded(item.organization, 2_000) || !bounded(item.date, 200) || !bounded(item.result, 2_000) || !canonicalUtcTimestamp(item.createdAt))
            return false;
        if (!oneOf(item.confidence, ["confirmed", "estimated", "uncertain"]) || !oneOf(item.status, ["approved", "rejected"]) || !oneOf(item.source, ["manual", "interview"]) || item.privacyBoundary !== "local-browser")
            return false;
        if (item.supersedes !== null && !identifier(item.supersedes) || evidenceIds.has(item.id))
            return false;
        evidenceIds.add(item.id);
        if (item.status === "approved")
            approvedEvidenceIds.add(item.id);
    }
    for (const item of x.evidence) {
        if (item.supersedes !== null && (!evidenceIds.has(item.supersedes) || item.supersedes === item.id))
            return false;
        const seen = new Set([item.id]);
        let cursor = item.supersedes;
        while (cursor !== null) {
            if (seen.has(cursor))
                return false;
            seen.add(cursor);
            cursor = x.evidence.find(candidate => candidate.id === cursor)?.supersedes ?? null;
        }
    }
    if (!Array.isArray(x.rejectedStatements) || x.rejectedStatements.length > 5000 || !x.rejectedStatements.every(item => bounded(item, 20_000)))
        return false;
    const questionIds = new Set(questionNodes.map(question => question.id));
    const respondedQuestionIds = new Set();
    if (!Array.isArray(x.answers) || x.answers.length > questionNodes.length)
        return false;
    for (const item of x.answers) {
        if (!exact(item, ["questionId", "response", "state", "updatedAt"]) || !questionIds.has(item.questionId) || respondedQuestionIds.has(item.questionId) || !bounded(item.response, 20_000) || !oneOf(item.state, ["answered", "deferred", "unknown", "not-applicable", "private"]) || !canonicalUtcTimestamp(item.updatedAt))
            return false;
        respondedQuestionIds.add(item.questionId);
    }
    const validTarget = (target) => exact(target, ["role", "company", "location", "schedule", "seniority", "compensation", "direction", "exclusions", "url", "verification", "checkedAt", "description"]) && [target.role, target.company, target.location, target.schedule, target.seniority, target.compensation, target.direction, target.exclusions].every(field => bounded(field, 2_000)) && bounded(target.url, 2_000) && bounded(target.description, 50_000) && bounded(target.checkedAt, 10) && oneOf(target.verification, ["unverified", "verified"]) && safeHttpsUrl(target.url) === target.url && (target.checkedAt === "" || calendarDate(target.checkedAt)) && (target.checkedAt === "" || new Date(`${target.checkedAt}T00:00:00Z`).getTime() <= Date.now()) && (target.verification !== "verified" || (target.url !== "" && target.checkedAt !== ""));
    const target = x.target;
    if (!validTarget(target))
        return false;
    if (!Array.isArray(x.comparisons) || x.comparisons.length > 100 || !x.comparisons.every(item => exact(item, ["phrase", "status", "evidenceIds", "basis"]) && bounded(item.phrase, 50_000) && bounded(item.basis, 50_000) && oneOf(item.status, ["matched", "partial", "gap", "unknown", "excluded"]) && Array.isArray(item.evidenceIds) && item.evidenceIds.every(reference => identifier(reference) && approvedEvidenceIds.has(reference))) || JSON.stringify(x.comparisons) !== JSON.stringify(deriveComparisons(target, x.evidence)))
        return false;
    if (x.resume === null)
        return true;
    if (!exact(x.resume, ["id", "createdAt", "name", "target", "contact", "wording", "grammarVersion", "themeVersion"]) || !identifier(x.resume.id) || !canonicalUtcTimestamp(x.resume.createdAt) || !bounded(x.resume.name, 2_000) || !validTarget(x.resume.target) || !bounded(x.resume.target.role, 2_000, 1) || !bounded(x.resume.contact, 2_000) || x.resume.grammarVersion !== "resume-grammar-v1" || x.resume.themeVersion !== "restrained-single-column-v1" || !Array.isArray(x.resume.wording) || x.resume.wording.length < 1 || x.resume.wording.length > 100)
        return false;
    const relevantOrder = orderedRelevantEvidenceIds(deriveComparisons(x.resume.target, x.evidence));
    let lastRelevantIndex = -1;
    const wordingIds = new Set();
    const wordingEvidenceIds = new Set();
    for (const item of x.resume.wording) {
        if (!exact(item, ["id", "evidenceId", "text", "style"]) || !identifier(item.id) || !identifier(item.evidenceId) || !oneOf(item.style, ["source", "concise"]) || wordingIds.has(item.id) || wordingEvidenceIds.has(item.evidenceId) || !approvedEvidenceIds.has(item.evidenceId) || !bounded(item.text, 20_000, 1))
            return false;
        const evidence = x.evidence.find(candidate => candidate.id === item.evidenceId);
        if (!evidence || item.text !== resumeGrammarV1(evidence.statement, item.style))
            return false;
        const relevantIndex = relevantOrder.indexOf(item.evidenceId);
        if (relevantIndex < 0 || relevantIndex <= lastRelevantIndex)
            return false;
        lastRelevantIndex = relevantIndex;
        wordingIds.add(item.id);
        wordingEvidenceIds.add(item.evidenceId);
    }
    return true;
}
function load() { try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw)
        return fresh();
    const parsed = JSON.parse(raw);
    if (validWorkspace(parsed))
        return parsed;
    recoveryMessage = "The saved workspace used an unsupported format. A new local workspace was opened; the old value was not imported.";
    return fresh();
}
catch {
    recoveryMessage = "The saved workspace could not be read. A new local workspace was opened. Export a backup after adding information.";
    return fresh();
} }
function save() { state.updatedAt = now(); try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    setText("saveStatus", `Saved in this browser at ${new Date(state.updatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
}
catch {
    setText("saveStatus", "This browser could not save the workspace. Keep this page open and export a backup before leaving.");
} }
function id(prefix) { return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`; }
function proposalFingerprint(proposal) { return JSON.stringify([proposal.statement, proposal.organization, proposal.date, proposal.result, proposal.confidence, proposal.supersedes]); }
function safeHttpsUrl(raw) { if (!raw)
    return ""; try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" && !!parsed.hostname ? parsed.href : null;
}
catch {
    return null;
} }
function clearPendingResumeWording() { pendingResumeWording = []; pendingResumeTarget = null; show("resumeWordingProposals", false); setText("resumeWordingStatus", ""); }
function startWorkspace() {
    if (!byId("privacyAck").checked) {
        setText("startStatus", "Select the local storage confirmation. Then start the workspace.");
        byId("privacyAck").focus();
        return;
    }
    setText("startStatus", "");
    localStorage.setItem("resumedoc.local.started", "yes");
    show("start", false);
    show("workspace");
    hydrate();
    byId("evidenceRaw").focus();
}
function hydrate() {
    setValue("targetRole", state.target.role);
    setValue("targetCompany", state.target.company);
    setValue("targetLocation", state.target.location);
    setValue("targetSchedule", state.target.schedule);
    setValue("targetSeniority", state.target.seniority);
    setValue("targetCompensation", state.target.compensation);
    setValue("targetDirection", state.target.direction);
    setValue("targetExclusions", state.target.exclusions);
    setValue("targetUrl", state.target.url);
    byId("targetVerification").value = state.target.verification;
    setValue("targetChecked", state.target.checkedAt);
    setValue("jobDescription", state.target.description);
    if (state.resume) {
        setValue("candidateName", state.resume.name);
        setValue("candidateContact", state.resume.contact);
    }
    renderEvidence();
    renderInterview();
    renderComparison();
    renderResume();
    if (recoveryMessage)
        setText("saveStatus", recoveryMessage);
}
function proposeEvidence(raw, organization, date, source, supersedes = null, result = "", confidence = "confirmed") {
    if (!raw.trim()) {
        byId(source === "manual" ? "evidenceRaw" : "interviewAnswer").focus();
        return;
    }
    if (raw.length > 20_000 || organization.length > 2_000 || date.length > 200 || result.length > 2_000) {
        setText("saveStatus", "This evidence is too large to review safely. Shorten it and try again.");
        return;
    }
    const proposal = { raw, statement: sentence(raw), organization, date, result, confidence, source, privacyBoundary: "local-browser", createdAt: now(), supersedes };
    const host = byId(source === "manual" ? "proposal" : "interviewProposal");
    host.replaceChildren();
    if (rejectedProposalFingerprints.has(proposalFingerprint(proposal))) {
        pendingProposals[source] = null;
        host.hidden = true;
        setText("saveStatus", "You rejected this proposal in this session. Edit the source before you review it again.");
        return;
    }
    pendingProposals[source] = proposal;
    host.append(make("h3", "Change Proposal"), make("h4", "Raw source"), make("p", proposal.raw), make("h4", "Proposed career evidence"), make("p", proposal.statement));
    const meta = make("p", [organization, date, result ? `Result: ${result}` : "", `Confidence: ${confidence}`, "Privacy: this browser only"].filter(Boolean).join(" · "));
    meta.className = "muted";
    host.append(meta);
    const accept = make("button", "Accept as evidence");
    accept.type = "button";
    accept.addEventListener("click", () => decideProposal("approved", source));
    const reject = make("button", "Reject proposal");
    reject.type = "button";
    reject.className = "secondary";
    reject.addEventListener("click", () => decideProposal("rejected", source));
    const edit = make("button", "Edit source");
    edit.type = "button";
    edit.className = "secondary";
    edit.addEventListener("click", () => { host.hidden = true; byId(source === "manual" ? "evidenceRaw" : "interviewAnswer").focus(); });
    host.append(accept, edit, reject);
    host.hidden = false;
    accept.focus();
}
function decideProposal(status, source) {
    const proposal = pendingProposals[source];
    if (!proposal)
        return;
    let invalidatedResume = false;
    let invalidatedPending = false;
    if (status === "approved") {
        const evidence = { id: id("evidence"), ...proposal, status: "approved" };
        state.evidence.push(evidence);
        if (proposal.supersedes) {
            const prior = state.evidence.find(item => item.id === proposal.supersedes);
            if (prior)
                prior.status = "rejected";
            if (state.resume?.wording.some(item => item.evidenceId === proposal.supersedes)) {
                state.resume = null;
                invalidatedResume = true;
            }
            if (pendingResumeWording.some(item => item.evidenceId === proposal.supersedes)) {
                clearPendingResumeWording();
                invalidatedPending = true;
            }
        }
        state.comparisons = deriveComparisons(state.target, state.evidence);
        save();
        if (invalidatedResume || invalidatedPending) {
            setText("saveStatus", "The corrected Career Evidence changed a resume source. Compose a new Resume Version.");
            if (invalidatedResume)
                renderResume();
        }
        renderEvidence();
        renderInterview();
    }
    else {
        rejectedProposalFingerprints.add(proposalFingerprint(proposal));
        setText("saveStatus", "You rejected this proposal in this session. Edit the source before you review it again.");
    }
    pendingProposals[source] = null;
    show(source === "manual" ? "proposal" : "interviewProposal", false);
    if (source === "manual") {
        setValue("evidenceRaw", "");
        setValue("evidenceOrg", "");
        setValue("evidenceDate", "");
        setValue("evidenceResult", "");
        delete byId("evidenceRaw").dataset.supersedes;
        byId("evidenceRaw").focus();
    }
    else {
        setValue("interviewAnswer", "");
        if (status === "rejected")
            renderInterview();
        byId("interviewQuestion").focus();
    }
}
function renderEvidence() {
    const host = byId("evidenceList");
    host.replaceChildren();
    const approved = state.evidence.filter(item => item.status === "approved");
    if (!approved.length) {
        host.append(make("p", "No approved evidence yet."));
        return;
    }
    for (const item of approved) {
        const card = make("article");
        card.append(make("p", item.statement));
        const meta = make("p", [item.organization, item.date, item.result ? `Result: ${item.result}` : "", `Confidence: ${item.confidence}`, `Source: ${item.source}`, "Approved; local browser only"].filter(Boolean).join(" · "));
        meta.className = "muted";
        card.append(meta);
        const correct = make("button", "Correct this evidence");
        correct.type = "button";
        correct.className = "secondary";
        correct.addEventListener("click", () => { setValue("evidenceRaw", item.raw); setValue("evidenceOrg", item.organization); setValue("evidenceDate", item.date); setValue("evidenceResult", item.result); byId("evidenceConfidence").value = item.confidence; byId("evidenceRaw").dataset.supersedes = item.id; byId("evidenceRaw").focus(); });
        card.append(correct);
        host.append(card);
    }
}
function currentQuestionIndex() { const visited = new Set(state.answers.map(answer => answer.questionId)); const satisfied = new Set(state.answers.filter(answer => answer.state !== "deferred").map(answer => answer.questionId)); const index = questionNodes.findIndex(node => !visited.has(node.id) && node.prerequisites.every(prerequisite => satisfied.has(prerequisite))); return index < 0 ? questionNodes.length : index; }
function renderDeferredQuestionControls() { const host = byId("interviewDeferred"); host.replaceChildren(); const deferred = state.answers.filter(answer => answer.state === "deferred"); if (!deferred.length) {
    host.append(make("p", "No questions are saved for later."));
    return deferred;
} host.append(make("p", "Questions saved for later:")); for (const answer of deferred) {
    const node = questionNodes.find(item => item.id === answer.questionId);
    if (!node)
        continue;
    const returnButton = make("button", `Return to this question: ${node.question}`);
    returnButton.type = "button";
    returnButton.className = "secondary";
    returnButton.addEventListener("click", () => { state.answers = state.answers.filter(item => item !== answer); save(); renderInterview(); setValue("interviewAnswer", answer.response); byId("interviewQuestion").focus(); });
    host.append(returnButton);
} return deferred; }
function renderInterviewCompletion(deferred, approved) { const remaining = Math.max(0, MINIMUM_APPROVED_EVIDENCE - approved); setText("interviewProgress", remaining === 0 ? "You have enough approved evidence to make a first resume." : `You responded to every available question. Add ${remaining} more approved evidence record${remaining === 1 ? "" : "s"} before you make a first resume.`); setText("interviewQuestion", deferred.length ? "Return to a saved question when you are ready." : "You reached the end of this interview."); setText("interviewReason", "You control your approved evidence and your next action."); byId("saveAnswer").hidden = true; byId("deferAnswer").hidden = true; byId("interviewAnswer").hidden = true; }
function renderInterview() {
    const deferred = renderDeferredQuestionControls();
    const approved = state.evidence.filter(item => item.status === "approved").length;
    show("goToResume", approved >= MINIMUM_APPROVED_EVIDENCE);
    const index = currentQuestionIndex();
    if (index === questionNodes.length) {
        renderInterviewCompletion(deferred, approved);
        return;
    }
    const node = questionNodes[index];
    if (!node)
        return;
    setText("interviewProgress", `Response ${state.answers.length + 1} of ${questionNodes.length}`);
    setText("interviewQuestion", node.question);
    setText("interviewReason", node.reason);
    byId("saveAnswer").hidden = false;
    byId("deferAnswer").hidden = false;
    byId("interviewAnswer").hidden = false;
}
function answerQuestion(forceDeferred = false) { const index = currentQuestionIndex(); const node = questionNodes[index]; if (!node)
    return; const response = value("interviewAnswer"); const selected = byId("interviewState").value; const responseState = forceDeferred ? "deferred" : selected; if (responseState === "answered" && !response) {
    byId("interviewAnswer").focus();
    return;
} state.answers.push({ questionId: node.id, response: responseState === "private" ? "" : response, state: responseState, updatedAt: now() }); save(); setValue("interviewAnswer", ""); byId("interviewState").value = "answered"; if (responseState === "answered")
    proposeEvidence(response, "Guided interview", "", "interview");
else {
    renderInterview();
    byId("interviewQuestion").focus();
} }
function compare() {
    const url = safeHttpsUrl(value("targetUrl"));
    if (url === null) {
        setText("saveStatus", "Use an HTTPS employer URL or leave the URL blank. Nothing was changed.");
        byId("targetUrl").focus();
        return;
    }
    const description = value("jobDescription");
    if (description.length > 50_000) {
        setText("saveStatus", "The job description is too large to compare safely. Nothing was changed.");
        return;
    }
    const nextTarget = { role: value("targetRole"), company: value("targetCompany"), location: value("targetLocation"), schedule: value("targetSchedule"), seniority: value("targetSeniority"), compensation: value("targetCompensation"), direction: value("targetDirection"), exclusions: value("targetExclusions"), url, verification: byId("targetVerification").value, checkedAt: value("targetChecked"), description };
    if (!nextTarget.role) {
        setText("saveStatus", "Add a Target Role before you compare a Target Job. Nothing was changed.");
        byId("targetRole").focus();
        return;
    }
    if (!nextTarget.description && !nextTarget.url) {
        setText("saveStatus", "Paste a job description or add an HTTPS employer URL. Nothing was changed.");
        byId("jobDescription").focus();
        return;
    }
    if (nextTarget.verification === "verified" && (!nextTarget.url || !nextTarget.checkedAt)) {
        setText("saveStatus", "Verified status requires an HTTPS employer URL and a verification date. Nothing was changed.");
        byId(nextTarget.url ? "targetChecked" : "targetUrl").focus();
        return;
    }
    if (nextTarget.checkedAt && (!calendarDate(nextTarget.checkedAt) || new Date(`${nextTarget.checkedAt}T00:00:00Z`).getTime() > Date.now())) {
        setText("saveStatus", "Use a valid verification date that is not in the future. Nothing was changed.");
        byId("targetChecked").focus();
        return;
    }
    if (targetRequirements(nextTarget).length > 100) {
        setText("saveStatus", "This job description has more than 100 requirements. Shorten it before you compare. Nothing was changed.");
        byId("jobDescription").focus();
        return;
    }
    const discardedPending = pendingResumeWording.length > 0;
    clearPendingResumeWording();
    state.target = nextTarget;
    state.comparisons = deriveComparisons(nextTarget, state.evidence);
    save();
    if (discardedPending)
        setText("saveStatus", "The Target Job changed. Review new Resume Wording Proposals before you compose a Resume Version.");
    renderComparison();
}
function renderComparison() {
    const host = byId("comparisonSummary");
    host.replaceChildren();
    const target = state.target;
    if (!target.role && !target.url && !target.description) {
        host.append(make("p", "No comparison yet."));
        return;
    }
    const checkedAge = target.checkedAt ? (Date.now() - new Date(`${target.checkedAt}T00:00:00Z`).getTime()) / 86400000 : null;
    const verification = target.verification === "unverified" ? "Verification warning: This opportunity is user-supplied and not verified on an employer-controlled source. Verify it before tailoring." : checkedAge !== null && checkedAge > 7 ? `Stale opportunity warning: You recorded employer-source verification on ${target.checkedAt}. Check the employer source again before tailoring.` : `Employer-source verification: You recorded this HTTPS employer URL as verified on ${target.checkedAt}. ResumeDoc did not visit or verify the URL.`;
    host.append(make("p", verification));
    const requirements = targetRequirements(target);
    host.append(make("p", `User-supplied job source: Company: ${target.company || "not entered"}. Employer URL: ${target.url || "not entered"}. Job description: ${requirements.length ? `${requirements.length} supplied requirements` : "not pasted"}.`));
    host.append(make("p", `User facts: Target Role: ${target.role}. Location: ${target.location || "not entered"}. Schedule: ${target.schedule || "not entered"}. Seniority: ${target.seniority || "not entered"}. Compensation: ${target.compensation || "not entered"}. Direction: ${target.direction || "not entered"}. Exclusions: ${target.exclusions || "none"}.`));
    host.append(make("p", "Deterministic inferences: Match labels use only approved Career Evidence. They are not an ATS score, opening guarantee, application, or outreach action."));
    if (!requirements.length) {
        host.append(make("p", "No supplied requirements are available. Paste the job description to compare Career Evidence. ResumeDoc does not read the URL."));
        return;
    }
    for (const row of state.comparisons) {
        const item = make("article");
        item.dataset.requirement = row.phrase;
        item.append(make("strong", `${row.status}: ${row.phrase}`), document.createTextNode(` — ${row.basis}`));
        const sources = row.evidenceIds.flatMap(evidenceId => { const evidence = state.evidence.find(candidate => candidate.id === evidenceId && candidate.status === "approved"); return evidence ? [evidence] : []; });
        item.append(make("p", sources.length ? `Supporting Career Evidence: ${sources.map(evidence => evidence.statement).join(" ")}` : "Supporting Career Evidence: none."));
        host.append(item);
    }
}
function compose() {
    if (!state.target.role.trim()) {
        setText("saveStatus", "Add a Target Role. Then compare the job before you compose a Resume Version. Nothing was changed.");
        byId("targetRole").focus();
        return;
    }
    state.comparisons = deriveComparisons(state.target, state.evidence);
    const orderedRelevantIds = orderedRelevantEvidenceIds(state.comparisons);
    const approvedRelevant = orderedRelevantIds.flatMap(evidenceId => { const evidence = state.evidence.find(item => item.id === evidenceId && item.status === "approved"); return evidence ? [evidence] : []; });
    if (!approvedRelevant.length) {
        setText("saveStatus", "Compare a Target Job and approve relevant Career Evidence before you compose a Resume Version. Nothing was changed.");
        return;
    }
    pendingResumeWording = approvedRelevant.map(evidence => ({ id: id("wording"), evidenceId: evidence.id, text: resumeGrammarV1(evidence.statement, "source"), style: "source", decision: "pending" }));
    pendingResumeTarget = structuredClone(state.target);
    renderResumeWordingProposals();
    show("resumeWordingProposals");
    byId("resumeWordingProposals").focus();
}
function decideResumeWording(proposalId, decision) { const proposal = pendingResumeWording.find(item => item.id === proposalId); if (!proposal)
    return; proposal.decision = decision; const next = pendingResumeWording.find(item => item.decision === "pending"); renderResumeWordingProposals(next?.id); }
function useConciseResumeWording(proposalId) { const proposal = pendingResumeWording.find(item => item.id === proposalId); if (!proposal)
    return; const evidence = state.evidence.find(item => item.id === proposal.evidenceId && item.status === "approved"); if (!evidence)
    return; proposal.style = "concise"; proposal.text = resumeGrammarV1(evidence.statement, "concise"); proposal.decision = "pending"; renderResumeWordingProposals(proposal.id); }
function renderResumeWordingProposals(focusProposalId) {
    const host = byId("resumeWordingProposals");
    host.replaceChildren(make("h3", "Resume Wording Proposals"), make("p", `Target Role: ${pendingResumeTarget?.role || "Not selected"}. The job comparison selected each source. The grammar rule only removes a first-person subject and normalizes spacing and punctuation.`));
    for (const proposal of pendingResumeWording) {
        const evidence = state.evidence.find(item => item.id === proposal.evidenceId);
        if (!evidence)
            continue;
        const card = make("article");
        card.dataset.wordingProposal = proposal.id;
        card.dataset.evidenceId = proposal.evidenceId;
        card.append(make("h4", "Proposed resume wording"), make("p", proposal.text), make("h4", "Source Career Evidence"), make("p", evidence.statement), make("p", `Decision: ${proposal.decision}.`));
        const concise = make("button", "Use concise wording");
        concise.type = "button";
        concise.className = "secondary";
        concise.disabled = proposal.style === "concise";
        concise.addEventListener("click", () => useConciseResumeWording(proposal.id));
        const accept = make("button", "Accept wording");
        accept.type = "button";
        accept.addEventListener("click", () => decideResumeWording(proposal.id, "accepted"));
        const reject = make("button", "Reject wording");
        reject.type = "button";
        reject.className = "secondary";
        reject.addEventListener("click", () => decideResumeWording(proposal.id, "rejected"));
        card.append(concise, accept, reject);
        host.append(card);
    }
    const pending = pendingResumeWording.filter(item => item.decision === "pending").length;
    const accepted = pendingResumeWording.filter(item => item.decision === "accepted").length;
    const composeApproved = make("button", "Compose accepted wording");
    composeApproved.id = "composeApprovedResume";
    composeApproved.type = "button";
    composeApproved.disabled = pending > 0 || accepted === 0;
    composeApproved.addEventListener("click", approveResumeWording);
    host.append(composeApproved);
    setText("resumeWordingStatus", `${pendingResumeWording.length} wording proposals are ready. ${accepted} accepted. ${pending} need a decision.`);
    if (focusProposalId) {
        const card = [...host.querySelectorAll("[data-wording-proposal]")].find(item => item.dataset.wordingProposal === focusProposalId);
        card?.querySelector("button:not([disabled])")?.focus();
    }
    else if (pending === 0)
        composeApproved.focus();
}
function approveResumeWording() { const accepted = pendingResumeWording.filter(item => item.decision === "accepted").map(({ decision: _, ...wording }) => wording); if (!accepted.length || pendingResumeWording.some(item => item.decision === "pending") || !pendingResumeTarget)
    return; const candidateResume = { id: id("resume"), createdAt: now(), name: value("candidateName"), target: structuredClone(pendingResumeTarget), contact: value("candidateContact"), wording: structuredClone(accepted), grammarVersion: "resume-grammar-v1", themeVersion: "restrained-single-column-v1" }; const candidate = { ...state, resume: candidateResume }; if (!validWorkspace(candidate)) {
    clearPendingResumeWording();
    setText("saveStatus", "The target or Career Evidence changed. Compose new Resume Wording Proposals.");
    return;
} state.resume = candidateResume; clearPendingResumeWording(); save(); setText("resumeWordingStatus", "The Resume Version includes only the wording that you accepted."); renderResume(); byId("resumePreview").focus(); }
function renderResume() { const host = byId("resumePreview"); const trace = byId("resumeTraceability"); host.replaceChildren(); trace.replaceChildren(); const resume = state.resume; if (!resume) {
    host.append(make("p", "Compose a version when your evidence is ready."));
    return;
} host.append(make("h1", resume.name || "Your name"), make("p", resume.target.role), make("p", resume.contact), make("h2", "Professional evidence")); const list = make("ul"); for (const wording of resume.wording) {
    const item = make("li", wording.text);
    item.dataset.evidenceId = wording.evidenceId;
    item.dataset.wordingId = wording.id;
    list.append(item);
} host.append(list); trace.append(make("p", `Version ${resume.id}. Target: ${resume.target.role}. Grammar: ${resume.grammarVersion}. Theme: ${resume.themeVersion}. Evidence: ${resume.wording.map(item => item.evidenceId).join(", ")}.`)); }
function exportResumeText() { const resume = state.resume; if (!resume)
    return; const lines = [resume.name, resume.target.role, resume.contact, "", "PROFESSIONAL EVIDENCE", ...resume.wording.map(item => `- ${item.text}`)]; const blob = new Blob([lines.join("\r\n")], { type: "text/plain" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `resume-${new Date(resume.createdAt).toISOString().slice(0, 10)}.txt`; link.click(); URL.revokeObjectURL(link.href); }
function checksum(text) { let hash = 2166136261; for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
} return (hash >>> 0).toString(16).padStart(8, "0"); }
function evidenceCollisionKey(evidence) { return JSON.stringify([evidence.statement, evidence.organization, evidence.date]); }
function classifyImportedEvidence(current, incoming) { const currentKeys = new Set(current.map(evidenceCollisionKey)); const currentIds = new Set(current.map(item => item.id)); let additions = []; let contentDuplicates = 0; let idConflicts = 0; for (const item of incoming) {
    if (currentKeys.has(evidenceCollisionKey(item))) {
        contentDuplicates++;
        continue;
    }
    if (currentIds.has(item.id)) {
        idConflicts++;
        continue;
    }
    additions.push(item);
    currentKeys.add(evidenceCollisionKey(item));
    currentIds.add(item.id);
} let lineageConflicts = 0; let changed = true; while (changed) {
    changed = false;
    const availableIds = new Set([...current.map(item => item.id), ...additions.map(item => item.id)]);
    const retained = additions.filter(item => item.supersedes === null || availableIds.has(item.supersedes));
    lineageConflicts += additions.length - retained.length;
    if (retained.length !== additions.length) {
        additions = retained;
        changed = true;
    }
} return { additions, contentDuplicates, idConflicts, lineageConflicts }; }
function exportData() { const payload = { product: "ResumeDoc local workspace", exportedAt: now(), workspace: state }; const body = JSON.stringify(payload, null, 2); const wrapper = JSON.stringify({ ...payload, integrity: { algorithm: "fnv1a-32", value: checksum(body) } }, null, 2); const blob = new Blob([wrapper], { type: "application/json" }); const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `resumedoc-backup-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href); }
async function selectImport(file) { if (!file)
    return; try {
    if (file.size > 2_000_000)
        throw new Error("Backup too large");
    const parsed = JSON.parse(await file.text());
    if (!exactBackupEnvelope(parsed))
        throw new Error("Unsupported backup");
    const body = JSON.stringify({ product: parsed.product, exportedAt: parsed.exportedAt, workspace: parsed.workspace }, null, 2);
    if (checksum(body) !== parsed.integrity.value)
        throw new Error("Integrity mismatch");
    pendingImport = parsed.workspace;
    const incoming = pendingImport.evidence.filter(e => e.status === "approved");
    const classification = classifyImportedEvidence(state.evidence, incoming);
    show("importChoice");
    setText("importSummary", `Import preview: ${incoming.length} approved evidence records; ${classification.contentDuplicates} content duplicates; ${classification.idConflicts} ID conflicts; ${classification.lineageConflicts} lineage conflicts; ${classification.additions.length} safe additions. Replace uses the complete backup. Merge adds only the safe additions. Choose replace or merge. Nothing has changed yet.`);
    byId("importChoice").focus();
}
catch {
    pendingImport = null;
    show("importChoice", false);
    setText("importSummary", "ResumeDoc could not validate this backup. No data was changed. Choose a ResumeDoc backup smaller than 2 MB, and try again.");
} }
function exactBackupEnvelope(input) { if (!input || typeof input !== "object" || Array.isArray(input))
    return false; const envelope = input; if (Object.keys(envelope).length !== 4 || !["product", "exportedAt", "workspace", "integrity"].every(key => Object.hasOwn(envelope, key)) || envelope.product !== "ResumeDoc local workspace" || !canonicalUtcTimestamp(envelope.exportedAt) || !validWorkspace(envelope.workspace) || !envelope.integrity || typeof envelope.integrity !== "object" || Array.isArray(envelope.integrity))
    return false; const integrity = envelope.integrity; return Object.keys(integrity).length === 2 && integrity.algorithm === "fnv1a-32" && typeof integrity.value === "string" && /^[0-9a-f]{8}$/.test(integrity.value); }
function confirmImport() { if (!pendingImport)
    return; const mode = document.querySelector('input[name="collision"]:checked')?.value || "replace"; const candidate = structuredClone(mode === "replace" ? pendingImport : state); if (mode === "merge") {
    const classification = classifyImportedEvidence(candidate.evidence, pendingImport.evidence.filter(item => item.status === "approved"));
    candidate.evidence.push(...structuredClone(classification.additions));
    candidate.comparisons = deriveComparisons(candidate.target, candidate.evidence);
} candidate.updatedAt = now(); if (!validWorkspace(candidate)) {
    setText("importSummary", "This import cannot create a valid workspace. No data was changed. Review the backup and try again.");
    return;
} try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(candidate));
}
catch {
    setText("importSummary", "The browser could not save this import. No data was changed. Export your current workspace before you try again.");
    return;
} clearPendingResumeWording(); state = candidate; pendingImport = null; hydrate(); show("importChoice", false); setText("importSummary", "Import complete. Review the workspace before relying on it."); }
function deleteData() { if (value("deleteConfirm") !== "DELETE") {
    setText("importSummary", "Type DELETE exactly before removing the workspace.");
    byId("deleteConfirm").focus();
    return;
} localStorage.removeItem(STORAGE_KEY); localStorage.removeItem("resumedoc.local.started"); clearPendingResumeWording(); state = fresh(); setText("importSummary", "Local workspace deleted from this browser. A previously exported backup is not affected."); show("workspace", false); show("start"); byId("privacyAck").checked = false; setValue("deleteConfirm", ""); byId("privacyAck").focus(); }
byId("startButton").addEventListener("click", startWorkspace);
byId("proposeEvidence").addEventListener("click", () => proposeEvidence(value("evidenceRaw"), value("evidenceOrg"), value("evidenceDate"), "manual", byId("evidenceRaw").dataset.supersedes || null, value("evidenceResult"), byId("evidenceConfidence").value));
byId("saveAnswer").addEventListener("click", () => answerQuestion(false));
byId("deferAnswer").addEventListener("click", () => answerQuestion(true));
byId("compareTarget").addEventListener("click", compare);
byId("composeResume").addEventListener("click", compose);
byId("printResume").addEventListener("click", () => window.print());
byId("exportResumeText").addEventListener("click", exportResumeText);
byId("exportWorkspace").addEventListener("click", exportData);
byId("importWorkspace").addEventListener("change", event => void selectImport(event.currentTarget.files?.[0]));
byId("confirmImport").addEventListener("click", confirmImport);
byId("deleteWorkspace").addEventListener("click", deleteData);
try {
    if (localStorage.getItem("resumedoc.local.started") === "yes") {
        show("start", false);
        show("workspace");
        hydrate();
    }
}
catch {
    recoveryMessage = "Browser storage is unavailable. You may work while this page remains open, but reload recovery is unavailable.";
}
