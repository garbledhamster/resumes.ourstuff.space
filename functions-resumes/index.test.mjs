import { afterEach, describe, expect, it, vi } from "vitest";
import JSZip from "jszip";
import functions from "./index.js";

const api = functions._test;
const originalFetch = globalThis.fetch;
const originalAiBrainToken = process.env.AI_BRAIN_API_TOKEN;

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
});

describe("ResumeDoc notes and Jobel safety helpers", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalAiBrainToken === undefined) delete process.env.AI_BRAIN_API_TOKEN;
    else process.env.AI_BRAIN_API_TOKEN = originalAiBrainToken;
    vi.restoreAllMocks();
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
