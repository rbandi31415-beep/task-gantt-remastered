// 偽 GitHub（Git Data API ＋ Contents API の必要部分）/ in-memory GitHub for tests
import { gitBlobSha } from "./share-core.mjs";
const enc = new TextEncoder();
const dec = new TextDecoder();

// ── 偽 GitHub（Git Data API の必要部分）/ fake GitHub: just the Git Data API we use ──
export function fakeGitHub() {
  const objects = new Map(); // sha -> {type, ...}
  let refSha = null;
  let n = 0;
  const id = (p) => `${p}${(++n).toString(16).padStart(8, "0")}`;
  const calls = [];
  let stale = []; // queued stale tips to hand out on the next GET ref calls (simulates GitHub's 60 s cache)
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
      if (stale.length) return { status: 200, json: { object: { sha: stale.shift() } } };
      return refSha ? { status: 200, json: { object: { sha: refSha } } } : { status: 409, json: { message: "Git Repository is empty." } };
    }
    if (method === "GET" && (m = path.match(/^\/compare\/(\w+)\.\.\.(\w+)/))) {
      const anc = (desc, a) => { for (let c = desc; c; c = objects.get(c)?.parents?.[0]) if (c === a) return true; return false; };
      const [, b, h] = m;
      if (!objects.has(b) || !objects.has(h)) return { status: 404, json: { message: "Not Found" } };
      const status = b === h ? "identical" : anc(h, b) ? "ahead" : anc(b, h) ? "behind" : "diverged";
      return { status: 200, json: { status } };
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
    if (method === "DELETE" && (m = path.match(/^\/contents\/(.+)$/))) {
      const rel = decodeURIComponent(m[1]);
      const entries = new Map(treeOf(refSha));
      if (entries.get(rel) !== body.sha) return { status: 409, json: { message: "sha mismatch" } };
      entries.delete(rel);
      refSha = makeCommit(entries, [refSha], body.message);
      return { status: 200, json: {} };
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
    lastMessage: () => objects.get(refSha).message,
    tip: () => refSha,
    serveStale: (sha, times = 1) => { for (let i = 0; i < times; i++) stale.push(sha); },
    commitsSince: (sha) => { let k = 0; for (let c = refSha; c && c !== sha; c = objects.get(c).parents[0]) k++; return k; },
    commits: () => {
      let c = refSha, k = 0;
      while (c) { k++; c = objects.get(c).parents[0]; }
      return k;
    },
  };
}

