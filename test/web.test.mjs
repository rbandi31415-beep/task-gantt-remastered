// Web app: note parsing/editing round trips and the Pages Function (auth + API) on a fake GitHub
import { parseTasks, buildWebRows, editNote, setDates, setParent, setDeps, makeResolver, newNote, splitNote, safeName } from "./web-tasks.mjs";
import { handle, caller, verifyAccessJwt } from "./web-fn.mjs";
import { fakeGitHub } from "./fake-github.mjs";
import { webcrypto } from "node:crypto";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ok  -", name); }
  else { fail++; console.error("FAIL  -", name); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// real notes as Obsidian/TaskNotes writes them
const BOM = `---
status: in-progress
priority: normal
startDate: 2026-11-13T22:00
projects:
  - "[[Some reference note]]"
  - "[[Sprint 1 TWL sensor]]"
dateCreated: 2026-11-09T21:33:43.131-05:00
dateModified: 2026-11-13T22:34:41.758-05:00
tags:
  - task
timeEstimate: 60
blockedBy:
  - uid: "[[Search for sensors]]"
    reltype: FINISHTOSTART
    gap: 1d
---

Body line one.
`;
const files = [
  { rel: "Preliminary BOM.md", sha: "a1", text: BOM },
  { rel: "Search for sensors.md", sha: "a2", text: "---\nstatus: open\nstartDate: 2026-11-11\ndue: 2026-11-12\nprojects:\n  - \"[[Sprint 1 TWL sensor]]\"\n---\n" },
  { rel: "Sprint 1 TWL sensor.md", sha: "a3", text: "---\nstatus: open\n---\n" },
  { rel: "CAD v1.md", sha: "a4", text: "---\nstatus: open\ndue: 2026-11-20\nprojects:\n  - \"[[Sprint 1 TWL sensor]]\"\nblockedBy:\n  - uid: \"[[Preliminary BOM]]\"\n    reltype: STARTTOSTART\n---\n" },
  { rel: "Demo.md", sha: "a5", text: "---\nstatus: done\ndue: 2026-12-01\nmilestone: true\n---\n" },
];
const tasks = parseTasks(files);
const T = (n) => tasks.find((t) => t.name === n);
check("parse: parent skips non-task project", T("Preliminary BOM").parent === "Sprint 1 TWL sensor.md");
check("parse: TaskNotes dependency object", same(T("Preliminary BOM").deps, [{ rel: "Search for sensors.md", type: "FS" }]));
check("parse: SS dependency", T("CAD v1").deps[0].type === "SS");
check("parse: naive time kept", T("Preliminary BOM").startTime === "22:00");
check("parse: due-only on its due date, not a milestone", T("CAD v1").dueOnly && T("CAD v1").start === "2026-11-20" && !T("CAD v1").milestone);
check("parse: explicit milestone", T("Demo").milestone);
check("parse: milestone drawn on its due date", T("Demo").start === "2026-12-01" && T("Demo").end === "2026-12-01");
check("parse: body preserved", T("Preliminary BOM").body === "\nBody line one.\n");

const rows = buildWebRows(tasks, new Set(), false);
check("rows: parent first, children indented", rows[0].task.name === "Demo" || rows.some((r) => r.task.name === "Sprint 1 TWL sensor" && r.depth === 0 && r.hasChildren));
const sprintRow = rows.find((r) => r.task.name === "Sprint 1 TWL sensor");
check("rows: parent rollup spans children", same(sprintRow.span, { start: "2026-11-11", end: "2026-11-20" }));
check("rows: collapse hides children", buildWebRows(tasks, new Set(["Sprint 1 TWL sensor.md"]), false).every((r) => r.task.parent !== "Sprint 1 TWL sensor.md"));
// same order as the plugin: start date, ties by name, undated last; desc flips
const order = buildWebRows(tasks, new Set(), false, { by: "start", dir: "asc" }).filter((r) => r.depth === 1).map((r) => r.task.name);
check("rows: children sorted by start then name", JSON.stringify(order) === JSON.stringify(["Search for sensors", "Preliminary BOM", "CAD v1"]));
const byName = buildWebRows(tasks, new Set(), false, { by: "name", dir: "desc" }).filter((r) => r.depth === 0).map((r) => r.task.name);
check("rows: name descending", JSON.stringify(byName) === JSON.stringify(["Sprint 1 TWL sensor", "Demo"]));
check("rows: hide done drops done tasks", !buildWebRows(tasks, new Set(), true).some((r) => r.task.name === "Demo"));

// editing keeps everything else byte-for-byte where possible
const resolve = makeResolver(files.map((f) => f.rel));
const bom = T("Preliminary BOM");
let out = editNote(BOM, (fm) => setDates(fm, bom, "2026-11-15", "2026-11-15"));
check("edit dates: time of day kept, no offset", out.includes("startDate: 2026-11-15T22:00\n"));
check("edit dates: one-day task gets no due date", !/\ndue:/.test(out));
check("edit: untouched keys keep order and formatting", splitNote(out).yaml.split("\n").slice(0, 7).join("\n") === splitNote(BOM).yaml.split("\n").slice(0, 7).join("\n").replace("2026-11-13T22:00", "2026-11-15T22:00"));
check("edit: dependency gap untouched", out.includes("gap: 1d"));
check("edit: body untouched", out.endsWith("\nBody line one.\n"));
check("edit: dateModified bumped", !out.includes("dateModified: 2026-11-13T22:34:41.758-05:00"));
out = editNote(BOM, (fm) => { fm.status = "done"; });
check("edit status done: completedDate set", /\ncompletedDate: \d{4}-\d{2}-\d{2}\n/.test(out));
out = editNote(out, (fm) => { fm.status = "open"; });
check("edit status reopen: completedDate cleared", !out.includes("completedDate"));
out = editNote(BOM, (fm) => setParent(fm, bom, "CAD v1.md", resolve));
check("set parent: swaps only the parent link", out.includes('projects:\n  - "[[CAD v1]]"\n  - "[[Some reference note]]"'));
out = editNote(BOM, (fm) => setDeps(fm, [{ rel: "Search for sensors.md", type: "SS" }, { rel: "CAD v1.md", type: "FS" }], resolve));
check("set deps: type change keeps gap", /uid: "\[\[Search for sensors\]\]"\n\s+reltype: STARTTOSTART\n\s+gap: 1d/.test(out));
check("set deps: new dep written as TaskNotes object", /uid: "\[\[CAD v1\]\]"\n\s+reltype: FINISHTOSTART/.test(out));
out = editNote(BOM, (fm) => setDeps(fm, [], resolve));
check("set deps: removing all deletes the key", !out.includes("blockedBy"));
const cad = T("CAD v1");
out = editNote(files[3].text, (fm) => setDates(fm, cad, "2026-11-22", "2026-11-22"));
const both = "---\nstatus: open\nstartDate: 2026-11-10\ndue: 2026-11-14\nscheduled: 2026-11-12T15:00\n---\n";
const bt = parseTasks([{ rel: "Both.md", sha: "x", text: both }])[0];
check("scheduled is shown but not the bar", bt.start === "2026-11-10" && bt.scheduled === "2026-11-12T15:00");
const moved = editNote(both, (fm) => setDates(fm, bt, "2026-11-11", "2026-11-15"));
check("moving a bar never touches scheduled", moved.includes("scheduled: 2026-11-12T15:00") && moved.includes("startDate: 2026-11-11") && moved.includes("due: 2026-11-15"));
const calOnly = parseTasks([{ rel: "Cal.md", sha: "x", text: "---\nstatus: open\nscheduled: 2026-11-12T15:00\n---\n" }])[0];
check("scheduled alone draws no bar", !calOnly.start && !calOnly.end);
check("due-only task stays due-only when dragged", out.includes("due: 2026-11-22") && !out.includes("startDate"));
const fresh = newNote("Sprint 1 TWL sensor.md", "2026-11-14", new Date(2026, 10, 14, 9, 0, 0));
const fp = parseTasks([{ rel: "Fresh.md", sha: "x", text: fresh }, files[2]])[0];
check("new note: TaskNotes shape", fresh.includes("status: open") && fresh.includes("tags:\n  - task") && fp.parent === "Sprint 1 TWL sensor.md" && fp.start === "2026-11-14");
check("safeName strips path and link characters", !/[\/:\[\]?]/.test(safeName("../a/b: [[x]]?")) && !safeName("../x").startsWith("."));

// ── Pages Function ──
// a real RS256 key pair standing in for Cloudflare Access
const kp = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pub = { ...(await webcrypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
async function jwt(payload, { kid = "k1", key = kp.privateKey } = {}) {
  const h = b64u(Buffer.from(JSON.stringify({ alg: "RS256", kid })));
  const p = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = await webcrypto.subtle.sign("RSASSA-PKCS1-v1_5", key, Buffer.from(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const env = { GITHUB_TOKEN: "tok", REPO: "me/dermaglow-tasks", BRANCH: "main", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com", ACCESS_AUD: "aud123", ALLOWED_EMAILS: "rohith@example.com, David@Example.com" };
const now = Math.floor(Date.now() / 1000);
const good = { aud: ["aud123"], email: "david@example.com", exp: now + 600, iss: "https://team.cloudflareaccess.com" };
const keys = async () => [pub];
const verify = (token, e) => verifyAccessJwt(token, e, keys);
const req = (path, { method = "GET", token, cookie, body } = {}) =>
  new Request(`https://gantt.example.com/api/${path}`, {
    method,
    headers: { ...(token ? { "Cf-Access-Jwt-Assertion": token } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const who = (r, e) => caller(r, e, verify);

check("auth: valid Access token, allowed email (case-insensitive)", (await who(req("me", { token: await jwt(good) }), env)) === "david@example.com");
check("auth: token in CF_Authorization cookie works", (await who(req("me", { cookie: `x=1; CF_Authorization=${await jwt(good)}` }), env)) === "david@example.com");
check("auth: no token = denied", (await who(req("me"), env)) === null);
check("auth: email not on allow-list = denied", (await who(req("me", { token: await jwt({ ...good, email: "eve@example.com" }) }), env)) === null);
check("auth: wrong audience = denied", (await who(req("me", { token: await jwt({ ...good, aud: ["other"] }) }), env)) === null);
check("auth: expired = denied", (await who(req("me", { token: await jwt({ ...good, exp: now - 5 }) }), env)) === null);
check("auth: wrong issuer = denied", (await who(req("me", { token: await jwt({ ...good, iss: "https://evil.cloudflareaccess.com" }) }), env)) === null);
const other = await webcrypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
check("auth: forged signature = denied", (await who(req("me", { token: await jwt(good, { key: other.privateKey }) }), env)) === null);
const tampered = (await jwt(good)).split(".");
tampered[1] = b64u(Buffer.from(JSON.stringify({ ...good, email: "rohith@example.com" })));
check("auth: edited payload = denied", (await who(req("me", { token: tampered.join(".") }), env)) === null);
check("auth: fails closed when Access isn't configured", (await who(req("me", { token: await jwt(good) }), { ...env, ACCESS_AUD: "" })) === null);

const gh = fakeGitHub();
const H = (r) => handle(r, env, gh.http, who);
const asDavid = async (path, opts = {}) => H(req(path, { ...opts, token: await jwt(good) }));
let res = await H(req("tasks"));
check("api: anonymous request gets 403", res.status === 403);
res = await asDavid("tasks");
check("api: empty repo lists no tasks", same(await res.json(), { files: [] }));
await gh.http("PUT", "https://api.github.com/repos/me/dermaglow-tasks/contents/README.md", "tok", { message: "init", content: Buffer.from("# x").toString("base64") });
res = await asDavid(`tasks?rel=${encodeURIComponent("CAD v1.md")}`, { method: "PUT", body: { text: files[3].text } });
const created = await res.json();
check("api: create task", res.status === 200 && typeof created.sha === "string");
check("api: commit message names the editor", gh.lastMessage() === "Web edit by david@example.com: CAD v1.md");
res = await asDavid("tasks");
const listed = (await res.json()).files;
check("api: list returns tasks but not README", listed.length === 1 && listed[0].rel === "CAD v1.md" && listed[0].text === files[3].text);
res = await asDavid(`tasks?rel=${encodeURIComponent("CAD v1.md")}`, { method: "PUT", body: { text: "stale", sha: "deadbeef" } });
check("api: stale sha returns 409 conflict", res.status === 409 && (await res.json()).conflict === true);
res = await asDavid(`tasks?rel=${encodeURIComponent("../Journal.md")}`, { method: "PUT", body: { text: "x" } });
check("api: path traversal rejected", res.status === 400);
res = await asDavid(`tasks?rel=${encodeURIComponent(".obsidian/app.md")}`, { method: "PUT", body: { text: "x" } });
check("api: dot-folder rejected", res.status === 400);
res = await asDavid(`tasks?rel=${encodeURIComponent("CAD v1.md")}&sha=${created.sha}`, { method: "DELETE" });
check("api: delete with current sha", res.status === 200 && gh.files().has("CAD v1.md") === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
