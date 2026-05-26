import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSZip from "jszip";
import functions from "./index.js";

const api = functions._test;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const referenceDir = path.join(repoRoot, "reference files");
const originalFetch = globalThis.fetch;
const originalAiBrainToken = process.env.AI_BRAIN_API_TOKEN;
const originalOpenRouterKey = process.env.OPENROUTER_API_KEY;
const originalOpenRouterModel = process.env.OPENROUTER_MODEL;
const originalOpenRouterPacketModel = process.env.OPENROUTER_PACKET_MODEL;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalAiBrainToken === undefined) delete process.env.AI_BRAIN_API_TOKEN;
  else process.env.AI_BRAIN_API_TOKEN = originalAiBrainToken;
  if (originalOpenRouterKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalOpenRouterKey;
  if (originalOpenRouterModel === undefined) delete process.env.OPENROUTER_MODEL;
  else process.env.OPENROUTER_MODEL = originalOpenRouterModel;
  if (originalOpenRouterPacketModel === undefined) delete process.env.OPENROUTER_PACKET_MODEL;
  else process.env.OPENROUTER_PACKET_MODEL = originalOpenRouterPacketModel;
  vi.restoreAllMocks();
});

function sampleInput() {
  return api.normalizeInput({
    fullName: "Jane Applicant",
    email: "jane@example.com",
    phone: "555-555-5555",
    location: "Minneapolis, MN",
    targetRole: "Operations Coordinator",
    jobPost: [
      "Operations Coordinator",
      "Acme Company",
      "Responsibilities include scheduling, customer communication, reporting, and process improvement.",
      "Requirements include Excel, organization, and detail orientation.",
    ].join("\n"),
    workHistory: [
      "Office Assistant at Example Co. Coordinated schedules and customer emails.",
      "Created weekly reports for leadership.",
      "Improved a filing process and reduced rework.",
    ].join("\n"),
    notes: "Keep it practical and role-specific.",
  });
}

async function docxText(relativePath) {
  return api.extractDocxText(fs.readFileSync(path.join(repoRoot, relativePath)));
}

describe("ResumeDoc generator", () => {
  it("builds a schema-valid local packet", () => {
    const input = sampleInput();
    const response = api.validateResponse(api.localResponseFromInput(input), input);
    expect(response.page_1.skill_items).toHaveLength(9);
    expect(response.page_1.experience_bullets).toHaveLength(7);
    expect(response.interview_prep.questions).toHaveLength(6);
  });

  it("fills the DOCX template without source-template names", async () => {
    const input = sampleInput();
    const response = api.validateResponse(api.localResponseFromInput(input), input);
    const output = await api.buildDocx(response, input);
    const text = await api.extractDocxText(output.docx);
    expect(text).toContain("Jane Applicant");
    expect(text).toContain("OPERATIONS COORDINATOR");
    expect(text).not.toContain("Joe Rice");
    expect(text).not.toContain("Joseph");
    expect(text).not.toContain("System Administrator");
    expect(text).not.toContain("Michael Johnson");
    expect(output.trackerPng.length).toBeGreaterThan(5000);
  });

  it("scrubs source-template terms from document XML metadata", async () => {
    const input = sampleInput();
    const response = api.validateResponse(api.localResponseFromInput(input), input);
    const output = await api.buildDocx(response, input);
    const zip = await JSZip.loadAsync(output.docx);
    const xml = await zip.file("word/document.xml").async("string");

    expect(xml).not.toMatch(/Joseph|Joe Rice|System Administrator|IT Generalist|Michael Johnson/i);
  });

  it("keeps template orange and enforces major section page breaks", async () => {
    const input = sampleInput();
    const response = api.validateResponse(api.localResponseFromInput(input), input);
    const output = await api.buildDocx(response, input);
    const zip = await JSZip.loadAsync(output.docx);
    const xml = await zip.file("word/document.xml").async("string");

    expect(xml).toContain('w:fill="E97132"');
    expect(xml).not.toContain('w:fill="2563EB"');
    expect((xml.match(/w:type="page"/g) || [])).toHaveLength(4);
  });

  it("keeps the template visual slots inside the DOCX", async () => {
    const input = sampleInput();
    const response = api.validateResponse(api.localResponseFromInput(input), input);
    const output = await api.buildDocx(response, input);
    const zip = await JSZip.loadAsync(output.docx);
    const rels = await zip.file("word/_rels/document.xml.rels").async("string");
    const mediaTargets = [...rels.matchAll(/Target="([^"]*media\/[^"]+)"/g)].map((match) => match[1]);

    expect(mediaTargets).toContain("media/image1.png");
    expect(mediaTargets).toContain("media/image2.png");
    expect(mediaTargets).toContain("media/image3.png");
    for (const mediaPath of ["word/media/image1.png", "word/media/image2.png", "word/media/image3.png"]) {
      const bytes = await zip.file(mediaPath).async("nodebuffer");
      expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
      expect(bytes.length).toBeGreaterThan(5000);
    }
  });

  it("does not reuse resume headers or noisy role labels in fallback text", () => {
    const input = api.normalizeInput({
      ...sampleInput(),
      targetRole: "Senior IT Systems Engineer - job post SJE 3.4",
      workHistory: [
        "Jane Applicant Minneapolis, MN 555-555-5555 jane@example.com linkedin.com/in/jane",
        "Managed ticket queues and customer communication for a support team.",
        "Improved weekly reporting for leadership.",
      ].join("\n"),
    });
    const response = api.validateResponse(api.localResponseFromInput(input), input);
    const text = JSON.stringify(response);

    expect(response.role).toBe("Senior IT Systems Engineer");
    expect(text).not.toContain("SJE 3.4");
    expect(text).not.toContain("jane@example.com linkedin.com");
    expect(response.page_1.experience_bullets[0].detail).toContain("Managed ticket queues");
  });

  it("cleans noisy pasted fields before they reach packet prompts", () => {
    const input = api.normalizeInput({
      ...sampleInput(),
      jobPost: [
        "Profile insights",
        "&lt;ul&gt;&lt;li&gt;Coordinate&nbsp;records\u2014daily&lt;/li&gt;&lt;li&gt;Requirements include Excel&amp; reporting&lt;/li&gt;&lt;/ul&gt;",
      ].join("\n"),
      workHistory: "Jane Applicant jane@example.com\n\u2022 Managed&nbsp;queues\u2014without missing follow-up\n\u2022 Improved reports",
    });
    const baseline = api.localResponseFromInput(input);
    const context = api.packetPromptContext(input, "", baseline);

    expect(input.jobPost).not.toContain("&lt;");
    expect(input.jobPost).not.toContain("&nbsp;");
    expect(input.jobPost).toContain("- Coordinate records - daily");
    expect(context.source_chunks.map((chunk) => chunk.type)).toContain("work_history");
    expect(context.source_chunks.filter((chunk) => chunk.type === "work_history").map((chunk) => chunk.text).join("\n")).not.toContain("jane@example.com");
  });

  it("normalizes the Joseph fixture before it reaches packet prompts", async () => {
    const text = await docxText("reference files/Joseph Rice - Systems Administrator.docx");
    const source = api.normalizeCandidateSource(text, {
      fullName: "Joseph Rice",
      email: "jmjrice94@gmail.com",
      phone: "2623487425",
      location: "Saint Paul, Minnesota",
    });
    const evidenceText = source.workEvidence.join("\n");
    const discardedReasons = source.discarded.map((entry) => entry.reason);

    expect(discardedReasons).toContain("generated_packet_boilerplate");
    expect(evidenceText).not.toMatch(/Role-Focused Resume Packet|Candidate-provided work history|Target Company/i);
    expect(evidenceText).not.toMatch(/using the candidate-provided resume details|Senior IT Systems Engineer.*job post|SJE/i);
    expect(evidenceText).not.toMatch(/jmjrice94@gmail\.com|2623487425|linkedin\.com/i);
  });

  it("keeps fallback output source-backed or explicitly conservative for the Joseph fixture", async () => {
    const text = await docxText("reference files/Joseph Rice - Systems Administrator.docx");
    const input = api.normalizeInput({
      fullName: "Joseph Rice",
      email: "jmjrice94@gmail.com",
      phone: "2623487425",
      location: "Saint Paul, Minnesota",
      targetRole: "Systems Administrator",
      jobPost: [
        "Senior IT Systems Engineer",
        "SJE",
        "Plymouth or New Hope, MN",
        "Hybrid | Full-Time | Monday - Friday, 8:00 AM - 5:00 PM",
      ].join("\n"),
      workHistory: text,
    });
    const source = api.normalizeCandidateSource(input.workHistory, input);
    const response = api.validateResponse(api.localResponseFromInput(input), input);
    const outputText = JSON.stringify(response);
    const bulletDetails = response.page_1.experience_bullets.map((bullet) => bullet.detail);

    expect(outputText).not.toMatch(/Role-Focused Resume Packet|Candidate-provided work history|Target Company/i);
    expect(outputText).not.toMatch(/using the candidate-provided resume details|Senior IT Systems Engineer.*job post|SJE\s*\d/i);
    expect(response.page_1.skill_items.map((item) => item.value).join("\n")).not.toMatch(/Plymouth|New Hope|Hybrid|Monday|8:00 AM/i);
    expect(bulletDetails.every((detail) => detail.includes("Confirm") || source.workEvidence.includes(detail))).toBe(true);
  });

  it("keeps PII and job-post headers out of generated packet body content", async () => {
    const text = await docxText("reference files/Joseph Rice - Systems Administrator.docx");
    const input = api.normalizeInput({
      fullName: "Joseph Rice",
      email: "jmjrice94@gmail.com",
      phone: "2623487425",
      location: "Saint Paul, Minnesota",
      targetRole: "Systems Administrator",
      jobPost: [
        "SENIOR IT SYSTEMS ENGINEER SJE - Plymouth or New Hope, MN Hybrid | Full-Time | Monday - Friday, 8:00 AM - 5:00 PM",
        "Responsibilities include administering systems, troubleshooting issues, supporting users, and documenting procedures.",
        "Requirements include systems administration experience, communication, and problem solving.",
      ].join("\n"),
      workHistory: text,
    });
    const response = api.validateResponse(api.localResponseFromInput(input), input);
    const bodyText = JSON.stringify({
      page_1: response.page_1,
      skill_tracker: response.skill_tracker,
      interview_prep: response.interview_prep,
      company_role_brief: response.company_role_brief,
      match_rationale: response.match_rationale,
    });

    expect(response.company).toBe("SJE");
    expect(bodyText).not.toMatch(/Joseph Rice|jmjrice94@gmail\.com|2623487425|Saint Paul/i);
    expect(bodyText).not.toMatch(/Plymouth|New Hope|Hybrid|Monday|8:00 AM|Candidate-provided work history|Targeted Resume Brief|Target Company/i);
    expect(response.page_1.skill_items.map((item) => item.value).join("\n")).not.toMatch(/SENIOR IT SYSTEMS ENGINEER/i);
  });

  it("appends a minute timestamp to generated output titles", () => {
    expect(api.outputTitleWithTimestamp("SJE Systems Administrator", "2026-05-26T17:04:30.000Z")).toBe("SJE Systems Administrator - 2026-05-26 1204 CT");
    expect(api.outputTitleWithTimestamp("SJE Systems Administrator - 2026-05-26 1204 CT", "2026-05-26T17:05:01.000Z")).toBe("SJE Systems Administrator - 2026-05-26 1205 CT");
  });

  it("flags the bad-output documents as generated packet source issues", async () => {
    const badDir = path.join(referenceDir, "Bad Outputs");
    const files = fs.readdirSync(badDir).filter((file) => file.endsWith(".docx"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const text = await api.extractDocxText(fs.readFileSync(path.join(badDir, file)));
      const issues = api.detectSourceQualityIssues(text);
      expect(issues).toContain("generated_packet_scaffolding");
      expect(issues.some((issue) => [
        "generic_candidate_detail_filler",
        "copied_job_post_header_or_noise",
        "contact_header_used_as_candidate_evidence",
      ].includes(issue))).toBe(true);
    }
  });

  it("sends targeted chunks and carries compact memory between OpenRouter section prompts", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    process.env.OPENROUTER_MODEL = "openrouter/auto";
    process.env.OPENROUTER_PACKET_MODEL = "anthropic/claude-sonnet-4";
    const prompts = [];
    const payloads = [];
    globalThis.fetch = vi.fn(async (_url, options) => {
      const payload = JSON.parse(options.body);
      const prompt = JSON.parse(payload.messages[1].content);
      payloads.push(payload);
      prompts.push(prompt);
      return responseJson({
        choices: [{
          message: {
            content: JSON.stringify({
              [prompt.section]: prompt.current_safe_draft,
              memory: {
                summary: `${prompt.section} memory`,
                facts_used: [`fact for ${prompt.section}`],
                style_notes: [`style for ${prompt.section}`],
              },
            }),
          },
        }],
      });
    });

    const input = api.normalizeInput({
      ...sampleInput(),
      workHistory: Array.from({ length: 30 }, (_, index) => `Work evidence line ${index + 1} with useful detail.`).join("\n"),
      jobPost: [
        "Operations Coordinator",
        "Acme Company",
        ...Array.from({ length: 25 }, (_, index) => `Requirement ${index + 1}: coordinate records, reports, and customer follow-up.`),
      ].join("\n"),
    });
    const response = await api.buildPacketResponseWithOpenRouter(input, "");

    expect(prompts).toHaveLength(6);
    expect(payloads.every((payload) => payload.model === "~openai/gpt-latest")).toBe(true);
    expect(payloads.map((payload) => payload.max_tokens)).toEqual([2600, 2380, 2600, 2600, 940, 1150]);
    expect(payloads.every((payload) => payload.reasoning?.effort === "low")).toBe(true);
    expect(payloads.every((payload) => payload.reasoning?.exclude === true)).toBe(true);
    expect(payloads.every((payload) => !payload.tools && !payload.plugins)).toBe(true);
    expect(prompts[0].input_context.source_chunks.map((chunk) => chunk.type)).toContain("work_history");
    expect(prompts[3].input_context.source_chunks.some((chunk) => chunk.type === "work_history")).toBe(false);
    expect(prompts[0].instructions.join(" ")).toContain("Faithfully reformulate");
    expect(prompts[0].negative_examples_to_avoid.join(" ")).toContain("Contact/header text");
    expect(prompts[0].input_context.strict_document_rules.join(" ")).toContain("job-post text into candidate history");
    expect(prompts[1].input_context.working_memory.section_summaries).toContain("page_1: page_1 memory");
    expect(response.generation_memory.section_summaries).toContain("references: references memory");
  });

  it("finishes the packet with a section fallback when OpenRouter returns empty JSON", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const input = sampleInput();
    const baseline = api.localResponseFromInput(input);
    const calls = [];
    globalThis.fetch = vi.fn(async (_url, options) => {
      const payload = JSON.parse(options.body);
      const prompt = JSON.parse(payload.messages[1].content);
      calls.push(prompt.section);
      if (prompt.section === "profile_cards") {
        return responseText("");
      }
      return responseJson({
        choices: [{
          message: {
            content: JSON.stringify({
              [prompt.section]: prompt.current_safe_draft,
              memory: { summary: `${prompt.section} memory` },
            }),
          },
        }],
      });
    });

    const response = await api.buildPacketResponseWithOpenRouter(input, "");

    expect(calls).toEqual([
      "page_1",
      "skill_tracker",
      "interview_prep",
      "company_role_brief",
      "profile_cards",
      "profile_cards",
      "references",
    ]);
    expect(response.profile_cards).toEqual(baseline.profile_cards);
    expect(response.generation_memory.section_summaries).toContain("profile_cards: Used source-checked fallback for profile cards.");
    const output = await api.buildDocx(api.validateResponse(response, input), input);
    const text = await api.extractDocxText(output.docx);
    expect(text).toContain("Jane Applicant");
    expect(text).toContain("OPERATIONS COORDINATOR");
  });
});

describe("ResumeDoc notes and Jobel safety helpers", () => {
  it("organizes job postings and work history with deterministic fallbacks", () => {
    const job = api.localOrganizedSource("job_posting", {
      targetRole: "Operations Coordinator",
      text: [
        "Operations Coordinator",
        "Acme Company",
        "Responsibilities include scheduling and customer follow-up.",
        "Requirements include Excel and detail orientation.",
      ].join("\n"),
    });
    const history = api.localOrganizedSource("work_history", {
      existingText: "Managed a ticket queue for internal users.",
      text: "Managed a ticket queue for internal users.\nCreated weekly reports for leadership.",
    });

    expect(job.body).toContain("# Job posting reference");
    expect(job.body).toContain("Acme Company");
    expect(history.body).toContain("# Work history reference");
    expect(history.body.match(/Managed a ticket queue/g)).toHaveLength(1);
    expect(history.body).toContain("Created weekly reports");
  });

  it("preserves job-posting note metadata", () => {
    const note = api.normalizeResumeNote({
      id: "job-note-1",
      owner: "user-1",
      title: "Posting",
      body: "A useful job posting.",
      metadata: {
        source: "user",
        kind: "job_posting",
        marker: "resumedoc:job-posting",
        contentFormat: "markdown",
      },
    });

    expect(api.isJobPostingNote(note)).toBe(true);
    expect(note.metadata.kind).toBe("job_posting");
    expect(note.metadata.marker).toBe("resumedoc:job-posting");
    expect(note.metadata.readOnly).toBe(false);
  });

  it("normalizes the durable work history profile", () => {
    const profile = api.normalizeWorkHistoryProfile({
      id: "workHistory",
      owner: "user-1",
      body: "Created weekly reports.",
      sourceHash: "abc123",
      metadata: { source: "resumedoc", organizedAt: "2026-05-26T00:00:00.000Z" },
    });

    expect(profile.id).toBe("workHistory");
    expect(profile.metadata.kind).toBe("work_history");
    expect(profile.body).toContain("Created weekly reports");
  });

  it("stores only identity and source references in package input", () => {
    const input = api.normalizePackageInput({
      ...sampleInput(),
      jobPostNoteId: "note-123",
      workHistoryProfileId: "workHistory",
      notes: "Do not save this.",
      extraDirection: "Do not save this either.",
    });

    expect(input).toEqual({
      fullName: "Jane Applicant",
      email: "jane@example.com",
      phone: "555-555-5555",
      location: "Minneapolis, MN",
      targetRole: "Operations Coordinator",
      jobPostNoteId: "note-123",
      workHistoryProfileId: "workHistory",
    });
    expect(input).not.toHaveProperty("jobPost");
    expect(input).not.toHaveProperty("workHistory");
    expect(input).not.toHaveProperty("notes");
    expect(input).not.toHaveProperty("extraDirection");
  });

  it("builds generation context from saved source references", () => {
    const saved = api.normalizePackageInput({
      fullName: "Jane Applicant",
      email: "jane@example.com",
      phone: "555-555-5555",
      location: "Minneapolis, MN",
      targetRole: "Operations Coordinator",
      jobPostNoteId: "note-123",
      workHistoryProfileId: "workHistory",
    });
    const input = api.composeInputWithReferences(saved, {
      jobPost: "Operations Coordinator\nAcme Company\nRequirements include Excel.",
      workHistory: "Created weekly reports for leadership.",
    });
    const baseline = api.localResponseFromInput(input);
    const context = api.packetPromptContext(input, "", baseline);

    expect(context.source_chunks.some((chunk) => chunk.type === "job_requirements")).toBe(true);
    expect(context.source_chunks.some((chunk) => chunk.type === "work_history" && chunk.text.includes("Created weekly reports"))).toBe(true);
    expect(JSON.stringify(context)).not.toContain("note-123");
  });

  it("uses stable note hashes and detects changed note bodies", () => {
    const note = api.normalizeResumeNote({
      id: "note-1",
      owner: "user-1",
      title: "Target role",
      body: "I managed scheduling for a team.",
      metadata: { source: "user" },
    });
    const same = { ...note, updatedAt: new Date().toISOString() };
    const changed = { ...note, body: "I managed scheduling and reporting for a team." };
    const hash = api.noteSourceHash(note);

    expect(api.noteSourceHash(same)).toBe(hash);
    expect(api.noteSourceHash(changed)).not.toBe(hash);
  });

  it("skips AI Brain sync when the synced source hash already matches", () => {
    const note = api.normalizeResumeNote({
      id: "note-1",
      owner: "user-1",
      title: "Synced",
      body: "Already stored.",
      brainSync: {
        status: "synced",
        sourceHash: "abc123",
        memoryId: "mem_123",
      },
    });

    expect(api.shouldSkipBrainSync(note, "abc123")).toBe(true);
    expect(api.shouldSkipBrainSync(note, "changed")).toBe(false);
  });

  it("scrubs before remembering and keeps allowRawStorage false", async () => {
    process.env.AI_BRAIN_API_TOKEN = "test-token";
    const calls = [];
    globalThis.fetch = vi.fn(async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body) });
      if (String(url).endsWith("/scrub")) {
        return responseJson({ ok: true, scrubbedText: "ResumeDoc note\nTitle: Safe\n[EMAIL_1]", blocked: false });
      }
      if (String(url).endsWith("/remember")) {
        return responseJson({ ok: true, memoryId: "mem_safe", status: "draft" }, 201);
      }
      return responseJson({ ok: false }, 404);
    });

    const note = api.normalizeResumeNote({
      id: "note-1",
      owner: "user-1",
      title: "Safe",
      body: "Email jane@example.com about the role.",
    });
    const result = await api.rememberNoteInBrain(note, { sourceHash: api.noteSourceHash(note) });

    expect(result.memoryId).toBe("mem_safe");
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/v1/scrub", "/v1/remember"]);
    expect(calls[1].body.allowRawStorage).toBe(false);
    expect(calls[1].body.text).toContain("[EMAIL_1]");
  });

  it("builds Jobel prompts from scrubbed context only", async () => {
    process.env.AI_BRAIN_API_TOKEN = "test-token";
    globalThis.fetch = vi.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      return responseJson({
        ok: true,
        scrubbedText: String(body.text || "")
          .replace(/jane@example\.com/g, "[EMAIL_1]")
          .replace(/555-555-1212/g, "[PHONE_1]"),
        blocked: false,
      });
    });

    const prompt = await api.buildJobelPrompt({
      message: "How do I use jane@example.com?",
      input: api.normalizeInput({
        targetRole: "Operations",
        workHistory: "Call me at 555-555-1212.",
      }),
      packageInfo: { id: "pkg-1", status: "draft" },
      notes: [
        api.normalizeResumeNote({
          id: "note-1",
          owner: "user-1",
          title: "Contact",
          body: "Email jane@example.com.",
        }),
      ],
    });

    expect(prompt).toContain("[EMAIL_1]");
    expect(prompt).toContain("[PHONE_1]");
    expect(prompt).not.toContain("jane@example.com");
    expect(prompt).not.toContain("555-555-1212");
  });
});

function responseJson(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

function responseText(text, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    text: async () => text,
    json: async () => JSON.parse(text),
  };
}
