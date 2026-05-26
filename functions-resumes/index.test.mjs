import { describe, expect, it } from "vitest";
import functions from "./index.js";

const api = functions._test;

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
    expect(text).not.toContain("Michael Johnson");
    expect(output.trackerPng.length).toBeGreaterThan(5000);
  });
});
