// 共有フォルダ同期の検証（偽 GitHub ＋ 偽 Vault）/ shared-folder sync tests on a fake GitHub and fake vault
import { TFile, TFolder } from "./obsidian-stub.mjs";
import { safeRel, toRel, toVaultPath, planSync, gitBlobSha, conflictName, GitHubRepo } from "./share-core.mjs";
import { syncOnce, cleanLegacyCopies } from "./share-sync.mjs";
import { fakeGitHub } from "./fake-github.mjs";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ok  -", name); }
  else { fail++; console.error("FAIL  -", name); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const enc = new TextEncoder();
const dec = new TextDecoder();

// ── 偽 Vault（読み書き・ゴミ箱つき）/ fake vault with read/write/trash ──
function fakeVault(initial) {
  const files = new Map(); // path -> {file, text}
  const folders = new Set();
  const trashed = [];
  const mk = (path) => Object.assign(new TFile(), { path, extension: "md", basename: path.split("/").pop().replace(/\.md$/, "") });
  for (const [p, text] of Object.entries(initial)) files.set(p, { file: mk(p), text });
  const app = {
    vault: {
      getMarkdownFiles: () => [...files.values()].map((x) => x.file),
      read: async (f) => files.get(f.path).text,
      modify: async (f, text) => { files.get(f.path).text = text; },
      create: async (path, text) => { files.set(path, { file: mk(path), text }); },
      createFolder: async (p) => { folders.add(p); },
      getAbstractFileByPath: (p) => files.get(p)?.file ?? (folders.has(p) ? Object.assign(new TFolder(), { path: p }) : null),
    },
    fileManager: { trashFile: async (f) => { trashed.push(f.path); files.delete(f.path); } },
  };
  return { app, text: (p) => files.get(p)?.text, paths: () => [...files.keys()].sort(), trashed, set: (p, t) => files.has(p) ? (files.get(p).text = t) : files.set(p, { file: mk(p), text: t }), del: (p) => files.delete(p) };
}

const share = (extra = {}) => ({ enabled: true, folder: "TaskNotes/Tasks/Dermaglow", repo: "me/dermaglow-tasks", branch: "main", intervalMin: 2, base: {}, lastSync: 0, lastError: "", ...extra });
const NOW = () => new Date(2026, 10, 14, 15, 32);

// ── スコープ / scope ──
check("safeRel: plain note", safeRel("CAD v1.md"));
check("safeRel: nested note", safeRel("Sprint 1/CAD v1.md"));
check("safeRel: rejects ..", !safeRel("../Journal.md"));
check("safeRel: rejects dot folder", !safeRel(".obsidian/app.md"));
check("safeRel: rejects non-markdown", !safeRel("secret.json"));
check("safeRel: rejects absolute", !safeRel("/etc/passwd.md"));
check("safeRel: rejects backslash", !safeRel("..\\Journal.md"));
check("safeRel: skips repo README", !safeRel("README.md") && safeRel("Sprint/README.md"));
check("toRel: inside folder", toRel("TaskNotes/Tasks/Dermaglow", "TaskNotes/Tasks/Dermaglow/CAD v1.md") === "CAD v1.md");
check("toRel: sibling folder with same prefix is out", toRel("TaskNotes/Tasks/Dermaglow", "TaskNotes/Tasks/Dermaglow Personal/x.md") === null);
check("toRel: parent folder is out", toRel("TaskNotes/Tasks/Dermaglow", "TaskNotes/Tasks/Journal.md") === null);
check("toRel: empty folder setting shares nothing", toRel("", "Journal.md") === null && toRel("/", "Journal.md") === null);
check("toVaultPath: refuses traversal", toVaultPath("TaskNotes/Tasks/Dermaglow", "../../Journal.md") === null);

// ── 三方比較 / three-way plan ──
const M = (o) => new Map(Object.entries(o));
const p = planSync(
  M({ same: "1", localEdit: "L", remoteEdit: "1", both: "L", newLocal: "N", delRemote: "1", localDel_remoteEdit: undefined, remoteDel_localEdit: "L" }),
  M({ same: "1", localEdit: "1", remoteEdit: "R", both: "R", newRemote: "N", delLocal: "1", localDel_remoteEdit: "R" }),
  M({ same: "1", localEdit: "1", remoteEdit: "1", both: "1", delRemote: "1", delLocal: "1", localDel_remoteEdit: "1", remoteDel_localEdit: "1" })
);
const fix = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.map((x) => x.replace(/\.md$/, ""))]));
// names above lack .md → safeRel filters them; re-run with .md names
const md = (o) => new Map(Object.entries(o).filter(([, v]) => v !== undefined).map(([k, v]) => [`${k}.md`, v]));
const plan = planSync(
  md({ same: "1", localEdit: "L", remoteEdit: "1", both: "L", newLocal: "N", delRemote: undefined, remoteDel_localEdit: "L", delLocal: "1" }),
  md({ same: "1", localEdit: "1", remoteEdit: "R", both: "R", newRemote: "N", delRemote: "1", localDel_remoteEdit: "R" }),
  md({ same: "1", localEdit: "1", remoteEdit: "1", both: "1", delRemote: "1", delLocal: "1", localDel_remoteEdit: "1", remoteDel_localEdit: "1" })
);
check("plan: unsafe names ignored", p.same.length === 0 && p.push.length === 0);
const f = fix(plan);
check("plan: identical files", same(f.same, ["same"]));
check("plan: pull remote edits + new remote + delete-vs-edit keeps edit", same(f.pull.sort(), ["localDel_remoteEdit", "newRemote", "remoteEdit"]));
check("plan: push local edits + new local + edit-vs-delete keeps edit", same(f.push.sort(), ["localEdit", "newLocal", "remoteDel_localEdit"]));
check("plan: local delete propagates", same(f.deleteRemote, ["delRemote"]));
check("plan: remote delete propagates", same(f.deleteLocal, ["delLocal"]));
check("plan: both edited = conflict", same(f.conflict, ["both"]));
check("conflictName: stamped and unique", conflictName("Sprint/CAD.md", NOW(), (r) => r === "Sprint/CAD (conflict 2026-11-14 1532).md") === "Sprint/CAD (conflict 2026-11-14 1532 2).md");
check("gitBlobSha matches git", (await gitBlobSha(enc.encode("hello\n"))) === "ce013625030ba8dba906f756967f9e9ca394464a");

// ── 実際の同期 / real sync passes ──
const F = "TaskNotes/Tasks/Dermaglow/";
const gh = fakeGitHub();
const v = fakeVault({
  [F + "CAD v1.md"]: "---\nstatus: open\n---\n",
  [F + "Sprint 1/Prelim BOM.md"]: "---\nstatus: in-progress\n---\n",
  [F + "notes.json"]: "{}",
  "TaskNotes/Tasks/Journal.md": "private",
  "TaskNotes/Tasks/Dermaglow Personal/Diary.md": "private too",
});
const s1 = share();
let r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("first sync: initializes empty repo with README", gh.files().has("README.md"));
check("first sync: uploads only the folder's notes", same([...gh.files().keys()].sort(), ["CAD v1.md", "README.md", "Sprint 1/Prelim BOM.md"]));
check("first sync: nothing private reached GitHub", ![...gh.files().values()].some((t) => t.includes("private")));
check("first sync: README not pulled into vault", !v.paths().some((p) => p.endsWith("README.md")));
check("first sync: base recorded", Object.keys(s1.base).length === 2);
check("first sync: single commit after README", gh.commits() === 2);

r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("no-op sync makes no commit", gh.commits() === 2 && r.plan.push.length === 0 && r.plan.pull.length === 0);

await gh.commitAs({ "CAD v1.md": "---\nstatus: done\n---\n", "New from web.md": "---\nstatus: open\n---\n" });
v.set(F + "Sprint 1/Prelim BOM.md", "---\nstatus: done\n---\n");
r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("pulls web edits", v.text(F + "CAD v1.md").includes("done") && v.text(F + "New from web.md") !== undefined);
check("pushes local edit in same pass", gh.files().get("Sprint 1/Prelim BOM.md").includes("done"));

// ── 競合：フィールド単位の三方マージ / conflicts: field-level three-way merge ──
const note = (status, start, extra = "") => `---\nstatus: ${status}\nstartDate: ${start}\ntags:\n  - task\n${extra}---\n\nBody.\n`;
v.set(F + "CAD v1.md", note("open", "2026-11-10"));
await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("setup: CAD pushed", gh.files().get("CAD v1.md") === note("open", "2026-11-10"));
await gh.commitAs({ "CAD v1.md": note("done", "2026-11-10") }); // David: status
v.set(F + "CAD v1.md", note("open", "2026-11-12")); // Rohith: moved the bar
const before = gh.commits();
r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("different fields merge cleanly", v.text(F + "CAD v1.md") === note("done", "2026-11-12") && gh.files().get("CAD v1.md") === note("done", "2026-11-12"));
check("clean merge makes no conflict copy", r.conflicts.length === 0 && r.merged.includes("CAD v1.md") && !v.paths().some((p) => p.includes("Sync conflicts")));
check("merge is one commit", gh.commits() === before + 1);

await gh.commitAs({ "CAD v1.md": note("done", "2026-11-20") });
v.set(F + "CAD v1.md", note("done", "2026-11-15"));
r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
const copy = F + "Sync conflicts/CAD v1 (conflict 2026-11-14 1532).md";
check("same field: Obsidian's value kept on both sides", v.text(F + "CAD v1.md").includes("2026-11-15") && gh.files().get("CAD v1.md").includes("2026-11-15"));
check("same field: repo version kept in Sync conflicts", v.text(copy)?.includes("startDate: 2026-11-20"));
check("conflict copy is flagged and untagged (never a task)", /^---\nsyncConflict: true\n/.test(v.text(copy)) && !v.text(copy).includes("tags:"));
check("conflict copy uploaded in the same commit", gh.files().has("Sync conflicts/CAD v1 (conflict 2026-11-14 1532).md"));
await gh.commitAs({ "CAD v1.md": note("done", "2026-11-20") });
v.set(F + "CAD v1.md", note("done", "2026-11-15"));
r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("identical conflict never copied twice", r.conflicts.length === 0 && v.paths().filter((p) => p.includes("Sync conflicts")).length === 1);

// ── GitHub の古い読み取り（今回の不具合の再現）/ stale GitHub reads: the bug that caused the duplicates ──
const ownTip = gh.tip();
v.set(F + "CAD v1.md", note("done", "2026-11-16"));
await syncOnce(v.app, s1, "tok", gh.http, NOW); // our own commit
const afterOwn = gh.tip();
gh.serveStale(ownTip, 3); // GitHub now hands back the tip from BEFORE our commit, three times
const snapshot = v.paths().join("|") + v.text(F + "CAD v1.md");
let staleErr = null;
try { await syncOnce(v.app, s1, "tok", gh.http, NOW); } catch (e) { staleErr = e; }
check("stale read after our own push is detected", staleErr?.message?.includes("caught up"));
check("stale read changes nothing locally", snapshot === v.paths().join("|") + v.text(F + "CAD v1.md"));
check("stale read commits nothing", gh.tip() === afterOwn);
gh.serveStale(ownTip, 0);
const stale2 = []; for (let i = 0; i < 2; i++) { try { await syncOnce(v.app, s1, "tok", gh.http, NOW); stale2.push("ok"); } catch (e) { stale2.push("stale"); } }
r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("after GitHub catches up: no copies, no reverts", !v.paths().some((p) => / \(conflict .*\)\.md$/.test(p) && !p.includes("Sync conflicts/")) && v.text(F + "CAD v1.md").includes("2026-11-16") && r.plan.pull.length === 0);
check("every GET bypasses caches", gh.calls.filter((c) => c.startsWith("GET")).every((c) => /[?&]_=/.test(c)));

// ── コミット失敗時はローカルを一切変えない / a failed commit leaves the vault untouched ──
await gh.commitAs({ "Assess.md": note("open", "2026-11-21") });
v.set(F + "CAD v1.md", note("done", "2026-11-17"));
const failing = async (method, url, token, body) => method === "PATCH" ? { status: 422, json: { message: "Update is not a fast forward" } } : gh.http(method, url, token, body);
const snap2 = v.paths().join("|");
let failErr = null;
try { await syncOnce(v.app, s1, "tok", failing, NOW); } catch (e) { failErr = e; }
check("failed commit: error surfaces for retry", failErr?.status === 422);
check("failed commit: remote edit NOT pulled yet, no copies", snap2 === v.paths().join("|") && v.text(F + "Assess.md") === undefined);
r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("retry applies everything once", v.text(F + "Assess.md") !== undefined && gh.files().get("CAD v1.md").includes("2026-11-17"));

// ── 同期中に編集されたファイルは上書きしない / a file edited mid-pass is not overwritten ──
await gh.commitAs({ "Assess.md": note("done", "2026-11-21") });
const sneaky = async (method, url, token, body) => {
  if (method === "GET" && url.includes("/git/blobs/")) v.set(F + "Assess.md", note("open", "2026-11-23")); // user edits during the pass
  return gh.http(method, url, token, body);
};
r = await syncOnce(v.app, s1, "tok", sneaky, NOW);
check("mid-pass edit is kept, not clobbered", r.skipped.includes("Assess.md") && v.text(F + "Assess.md").includes("2026-11-23"));
r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("next pass merges it without a copy", v.text(F + "Assess.md") === note("done", "2026-11-23") && gh.files().get("Assess.md") === note("done", "2026-11-23") && r.conflicts.length === 0);

v.del(copy);
await gh.commitAs({ "New from web.md": null });
r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("local delete removes from repo", !gh.files().has("Sync conflicts/CAD v1 (conflict 2026-11-14 1532).md"));
check("remote delete trashes locally (recoverable)", v.trashed.includes(F + "New from web.md"));

// 他クライアントが割り込んだら 422 / a concurrent commit makes the ref update fail with 422
const racy = async (method, url, token, body) => {
  if (method === "POST" && url.endsWith("/git/commits")) await gh.commitAs({ "Race.md": "x" });
  return gh.http(method, url, token, body);
};
v.set(F + "CAD v1.md", "---\nstatus: open\n# again\n---\n");
let err = null;
try { await syncOnce(v.app, s1, "tok", racy, NOW); } catch (e) { err = e; }
check("concurrent commit surfaces 422 (syncer retries)", err?.status === 422);
r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("retry after race keeps both changes", gh.files().has("Race.md") && gh.files().get("CAD v1.md").includes("again"));

// 安全装置 / guards
const vEmpty = fakeVault({ "TaskNotes/Tasks/Journal.md": "private" });
err = null;
try { await syncOnce(vEmpty.app, share({ base: { ...s1.base } }), "tok", gh.http, NOW); } catch (e) { err = e; }
check("guard: missing local folder never wipes the repo", /refusing to delete/.test(err?.message ?? "") && gh.files().has("CAD v1.md"));
err = null;
try { await syncOnce(v.app, s1, "bad", gh.http, NOW); } catch (e) { err = e; }
check("bad token reports GitHub's message", /Bad credentials/.test(err?.message ?? ""));
err = null;
try { await syncOnce(v.app, share({ folder: "" }), "tok", gh.http, NOW); } catch (e) { err = e; }
check("guard: empty folder setting refuses to run", /Choose a folder/.test(err?.message ?? ""));

// putFile の楽観ロック（Web アプリ用）/ putFile optimistic lock (web app)
const repo = new GitHubRepo(gh.http, { owner: "me", repo: "dermaglow-tasks", branch: "main", token: "tok" });
let lockErr = null;
try { await repo.putFile("CAD v1.md", enc.encode("stale"), "0000000", "stale write"); } catch (e) { lockErr = e; }
check("putFile with stale sha is rejected", lockErr?.status === 409);
let unsafe = null;
try { await repo.putFile("../Journal.md", enc.encode("x"), undefined, "x"); } catch (e) { unsafe = e; }
check("putFile refuses unsafe paths", /unsafe/.test(unsafe?.message ?? ""));

// ── 旧形式コピーの一度きりの片付け / one-time cleanup of old-style copies ──
const legacy = fakeVault({
  [F + "CAD v1.md"]: "---\ndateModified: 2026-11-14T19:06:10.127-05:00\n---\n",
  [F + "CAD v1 (conflict 2026-11-14 1906).md"]: "---\ndateModified: 2026-11-14T19:05:07.924-05:00\n---\n",
  [F + "CAD v1 (conflict 2026-11-14 1906 6).md"]: "---\ndateModified: 2026-11-14T19:05:07.924-05:00\n---\n",
  [F + "Newer (conflict 2026-11-14 1906).md"]: "---\nstatus: done\ndateModified: 2026-11-14T20:00:00-05:00\n---\n",
  [F + "CAD v1 (conflict 2026-11-14 1906 2).md"]: "---\ndateModified: 2026-11-14T19:06:10.147-05:00\n---\n",
  [F + "Newer.md"]: "---\ndateModified: 2026-11-14T19:00:00-05:00\n---\n",
  [F + "Orphan (conflict 2026-11-14 1906).md"]: "---\n---\n",
  [F + "Notes (conflict with David).md"]: "---\n---\n",
  ["TaskNotes/Tasks/Elsewhere (conflict 2026-11-14 1906).md"]: "---\n---\n",
});
const cleaned = await cleanLegacyCopies(legacy.app, "TaskNotes/Tasks/Dermaglow");
check("cleanup: removes older copies of existing tasks", JSON.stringify(cleaned.sort()) === JSON.stringify(["CAD v1 (conflict 2026-11-14 1906 2).md", "CAD v1 (conflict 2026-11-14 1906 6).md", "CAD v1 (conflict 2026-11-14 1906).md"]));
check("cleanup: same content but later dateModified also removed", cleaned.includes("CAD v1 (conflict 2026-11-14 1906 2).md"));
check("cleanup: keeps newer different copies, orphans, other names, other folders", legacy.paths().length === 6 && legacy.trashed.length === 3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
