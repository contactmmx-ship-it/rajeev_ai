import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildEmbedInstructions,
  cleanPageContext,
  createRateLimiter,
  findProject,
  isOriginAllowed,
  isOriginKnown,
  MAX_PAGE_CONTEXT_CHARS,
  parseExtraOrigins,
} from "../lib/embed.ts";
import { EMBED_PROJECTS } from "../lib/embedProjects.ts";

const ebill = findProject(EMBED_PROJECTS, "ebill2tally")!;

test("every project has a unique key, an https origin and a brief", () => {
  const keys = new Set<string>();
  for (const p of EMBED_PROJECTS) {
    assert.ok(!keys.has(p.key), `duplicate key ${p.key}`);
    keys.add(p.key);
    assert.ok(p.origins.length > 0);
    for (const o of p.origins) assert.equal(new URL(o).protocol, "https:");
    assert.ok(p.brief.length > 40);
  }
});

test("unknown or non-string project keys are refused", () => {
  assert.equal(findProject(EMBED_PROJECTS, "nope"), null);
  assert.equal(findProject(EMBED_PROJECTS, 42), null);
  assert.equal(findProject(EMBED_PROJECTS, undefined), null);
});

test("only the project's own origins may use it", () => {
  assert.ok(isOriginAllowed(ebill, "https://aura-tech-ebill-scan-app.vercel.app", {}));
  assert.ok(!isOriginAllowed(ebill, "https://syros-opd-console.vercel.app", {}));
  assert.ok(!isOriginAllowed(ebill, "https://evil.example.com", {}));
  assert.ok(!isOriginAllowed(ebill, "https://aura-tech-ebill-scan-app.vercel.app.evil.com", {}));
  assert.ok(!isOriginAllowed(ebill, null, {}));
  assert.ok(!isOriginAllowed(ebill, "null", {}));
});

test("the Rajeev AI host itself may use any project (demo page)", () => {
  assert.ok(isOriginAllowed(ebill, "https://rajeev.example.app", {}, "https://rajeev.example.app"));
});

test("extra origins come from the env setting, per project", () => {
  const extra = parseExtraOrigins("ebill2tally=http://localhost:3000, https://preview.vercel.app;bad;=x;dr-teeth=notaurl");
  assert.deepEqual(extra, { ebill2tally: ["http://localhost:3000", "https://preview.vercel.app"] });
  assert.ok(isOriginAllowed(ebill, "http://localhost:3000", extra));
  assert.ok(isOriginKnown(EMBED_PROJECTS, "https://preview.vercel.app", extra));
  assert.ok(!isOriginKnown(EMBED_PROJECTS, "https://evil.example.com", extra));
});

test("instructions carry the project brief and fence the page context", () => {
  const s = buildEmbedInstructions({ project: ebill, methodology: "METHOD", pageContext: "Bill 12 open" });
  assert.match(s, /eBill2Tally/);
  assert.match(s, /Do not give tax or legal rulings/);
  assert.match(s, /METHOD/);
  assert.match(s, /not instructions/);
  assert.match(s, /<<<\nBill 12 open\n>>>/);
  const none = buildEmbedInstructions({ project: ebill, pageContext: 123 });
  assert.doesNotMatch(none, /Page context/);
});

test("SYROS brief forbids clinical advice", () => {
  const syros = findProject(EMBED_PROJECTS, "syros-opd")!;
  assert.match(buildEmbedInstructions({ project: syros }), /Never suggest a medicine, dose, diagnosis or treatment/);
});

test("page context is capped and stripped of control characters", () => {
  assert.equal(cleanPageContext("a\u0000b\nc"), "ab\nc");
  const long = cleanPageContext("x".repeat(MAX_PAGE_CONTEXT_CHARS + 500));
  assert.ok(long.length <= MAX_PAGE_CONTEXT_CHARS + 2);
});

test("rate limiter allows N per window, then resets", () => {
  const allow = createRateLimiter(2, 1000);
  assert.ok(allow("a", 0));
  assert.ok(allow("a", 10));
  assert.ok(!allow("a", 20));
  assert.ok(allow("b", 20));
  assert.ok(allow("a", 1000));
});

test("widget never ships the server key and talks only to its own host and OpenAI", () => {
  const js = readFileSync(new URL("../public/rajeev-widget.js", import.meta.url), "utf8");
  assert.doesNotMatch(js, /OPENAI_API_KEY|sk-[A-Za-z0-9]/);
  assert.match(js, /apiBase \+ "\/api\/embed\/session"/);
  const urls = js.match(/https:\/\/[a-z0-9.\-]+/gi) || [];
  for (const u of urls) assert.equal(u, "https://api.openai.com");
});
