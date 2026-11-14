// 共有フォルダ同期の検証（偽 GitHub ＋ 偽 Vault）/ shared-folder sync tests on a fake GitHub and fake vault
import { TFile, TFolder } from "./obsidian-stub.mjs";
import { safeRel, toRel, toVaultPath, planSync, gitBlobSha, conflictName, GitHubRepo } from "./share-core.mjs";
import { syncOnce } from "./share-sync.mjs";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ok  -", name); }
  else { fail++; console.error("FAIL  -", name); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const enc = new TextEncoder();
const dec = new TextDecoder();

// ── 偽 GitHub（Git Data API の必要部分）/ fake GitHub: just the Git Data API we use ──
function fakeGitHub() {
  const objects = new Map(); // sha -> {type, ...}
  let refSha = null;
  let n = 0;
  const id = (p) => `${p}${(++n).toString(16).padStart(8, "0")}`;
  const calls = [];
  const putBlob = async (bytes) => {
    const sha = await gitBlobSha(bytes);
    objects.set(sha, { type: "blob", bytes });
    return sha;
  };
  const treeOf = (commitSha) => objects.get(objects.get(commitSha).tree).entries; // Map path->sha
  const makeCommit = (entries, parents, message) => {
    const tree = id("t");
    objects.set(tree, { type: "tree", entries });
    const c = id("c");
    objects.set(c, { type: "commit", tree, parents, message });
    return c;
  };
  const b64 = (bytes) => Buffer.from(bytes).toString("base64");
  const unb64 = (s) => new Uint8Array(Buffer.from(s, "base64"));
  const http = async (method, url, token, body) => {
    const path = url.replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, "");
    calls.push(`${method} ${path}`);
    if (token !== "tok") return { status: 401, json: { message: "Bad credentials" } };
    let m;
    if (method === "GET" && /^\/git\/ref\/heads\//.test(path)) {
      return refSha ? { status: 200, json: { object: { sha: refSha } } } : { status: 409, json: { message: "Git Repository is empty." } };
    }
    if (method === "GET" && (m = path.match(/^\/git\/commits\/(\w+)/))) return { status: 200, json: { tree: { sha: objects.get(m[1]).tree } } };
    if (method === "GET" && (m = path.match(/^\/git\/trees\/(\w+)/))) {
      const entries = objects.get(m[1]).entries;
      return { status: 200, json: { tree: [...entries].map(([p, sha]) => ({ path: p, type: "blob", sha })) } };
    }
    if (method === "GET" && (m = path.match(/^\/git\/blobs\/(\w+)/))) return { status: 200, json: { content: b64(objects.get(m[1]).bytes), encoding: "base64" } };
    if (method === "PUT" && (m = path.match(/^\/contents\/(.+)$/))) {
      if (!refSha && /README/.test(m[1]) === false) return { status: 409, json: { message: "empty" } };
      const rel = decodeURIComponent(m[1]);
      const entries = refSha ? new Map(treeOf(refSha)) : new Map();
      if (entries.has(rel) && body.sha !== entries.get(rel)) return { status: 409, json: { message: "sha mismatch" } };
      const sha = await putBlob(unb64(body.content));
      entries.set(rel, sha);
      refSha = makeCommit(entries, refSha ? [refSha] : [], body.message);
      return { status: 200, json: { content: { sha } } };
    }
    if (!refSha) return { status: 409, json: { message: "Git Repository is empty." } };
    if (method === "POST" && path === "/git/blobs") return { status: 201, json: { sha: await putBlob(unb64(body.content)) } };
    if (method === "POST" && path === "/git/trees") {
      const baseTree = objects.get(body.base_tree);
      const entries = new Map(baseTree.entries);
      for (const e of body.tree) e.sha === null ? entries.delete(e.path) : entries.set(e.path, e.sha);
      const t = id("t");
      objects.set(t, { type: "tree", entries });
      return { status: 201, json: { sha: t } };
    }
    if (method === "POST" && path === "/git/commits") {
      const c = id("c");
      objects.set(c, { type: "commit", tree: body.tree, parents: body.parents, message: body.message });
      return { status: 201, json: { sha: c } };
    }
    if (method === "PATCH" && /^\/git\/refs\/heads\//.test(path)) {
      if (objects.get(body.sha).parents[0] !== refSha) return { status: 422, json: { message: "Update is not a fast forward" } };
      refSha = body.sha;
      return { status: 200, json: {} };
    }
    return { status: 404, json: { message: `no route ${method} ${path}` } };
  };
  return {
    http,
    calls,
    files: () => (refSha ? new Map([...treeOf(refSha)].map(([p, sha]) => [p, dec.decode(objects.get(sha).bytes)])) : new Map()),
    // 他人（Web アプリ）のコミットを模擬 / simulate another client's commit
    async commitAs(changes) {
      const entries = new Map(treeOf(refSha));
      for (const [p, text] of Object.entries(changes)) text === null ? entries.delete(p) : entries.set(p, await putBlob(enc.encode(text)));
      refSha = makeCommit(entries, [refSha], "web edit");
    },
    commits: () => {
      let c = refSha, k = 0;
      while (c) { k++; c = objects.get(c).parents[0]; }
      return k;
    },
  };
}

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

await gh.commitAs({ "CAD v1.md": "---\nstatus: open\n# web\n---\n" });
v.set(F + "CAD v1.md", "---\nstatus: in-progress\n# obsidian\n---\n");
r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
const copy = F + "CAD v1 (conflict 2026-11-14 1532).md";
check("conflict: local version kept and pushed", gh.files().get("CAD v1.md").includes("obsidian") && v.text(F + "CAD v1.md").includes("obsidian"));
check("conflict: remote version saved beside it", v.text(copy)?.includes("web"));
await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("conflict: copy uploaded on next pass so both people see it", gh.files().has("CAD v1 (conflict 2026-11-14 1532).md"));

v.del(copy);
await gh.commitAs({ "New from web.md": null });
r = await syncOnce(v.app, s1, "tok", gh.http, NOW);
check("local delete removes from repo", !gh.files().has("CAD v1 (conflict 2026-11-14 1532).md"));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
