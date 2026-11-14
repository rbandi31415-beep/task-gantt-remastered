// 共有フォルダ同期の純ロジック（Obsidian 非依存・テスト可能）
// Pure logic for shared-folder sync (no Obsidian imports, unit-testable)
//
// One vault folder is mirrored to the root of one GitHub repo. Only Markdown files inside that
// folder ever leave the vault; every path is checked against the folder before it is read,
// written, uploaded or deleted.

// ── スコープ / scope ──

// フォルダパスの正規化（前後の / を除去、\ を / に）/ normalize a folder path
export function normFolder(folder: string): string {
  return folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").trim();
}

// 相対パス（共有ルートからの）として安全か / is this a safe path relative to the shared root?
// rejects absolute paths, "..", backslashes, empty segments, dot-files/dot-folders and non-.md files
export function safeRel(rel: string): boolean {
  if (!rel || rel.includes("\\") || rel.startsWith("/")) return false;
  const segs = rel.split("/");
  if (segs.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) return false;
  if (!rel.toLowerCase().endsWith(".md")) return false;
  // リポジトリ直下の README は説明用であってタスクではない / the repo-root README describes the repo, it isn't a task
  if (segs.length === 1 && segs[0].toLowerCase() === "readme.md") return false;
  return true;
}

// Vault パス → 共有ルート相対。範囲外なら null / vault path → shared-root relative, or null if out of scope
export function toRel(folder: string, vaultPath: string): string | null {
  const f = normFolder(folder);
  if (!f) return null; // Vault ルート全体の共有は許可しない / never share the whole vault
  const p = vaultPath.replace(/\\/g, "/");
  if (!p.startsWith(f + "/")) return null;
  const rel = p.slice(f.length + 1);
  return safeRel(rel) ? rel : null;
}

// 共有ルート相対 → Vault パス。危険なパスは null / shared-root relative → vault path, or null if unsafe
export function toVaultPath(folder: string, rel: string): string | null {
  const f = normFolder(folder);
  if (!f || !safeRel(rel)) return null;
  return `${f}/${rel}`;
}

// ── 内容ハッシュ（git の blob SHA と同じ）/ content hash identical to git's blob SHA ──
export async function gitBlobSha(bytes: Uint8Array): Promise<string> {
  const header = new TextEncoder().encode(`blob ${bytes.length}\0`);
  const buf = new Uint8Array(header.length + bytes.length);
  buf.set(header, 0);
  buf.set(bytes, header.length);
  const digest = await crypto.subtle.digest("SHA-1", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── 同期計画（三方比較）/ sync plan (three-way compare) ──
// local / remote / base: rel path → blob sha (absent = file doesn't exist there / wasn't synced)
export interface SyncPlan {
  pull: string[]; // リモート → ローカルへ書く / write remote content locally
  push: string[]; // ローカル → リモートへ送る / upload local content
  deleteLocal: string[]; // ローカルを削除（ゴミ箱へ）/ remove locally (to trash)
  deleteRemote: string[]; // リモートから削除 / remove from the repo
  conflict: string[]; // 両側で別々に変更 / changed differently on both sides
  same: string[]; // 一致（base 更新のみ）/ identical (only refresh base)
}

export function planSync(
  local: Map<string, string>,
  remote: Map<string, string>,
  base: Map<string, string>
): SyncPlan {
  const plan: SyncPlan = { pull: [], push: [], deleteLocal: [], deleteRemote: [], conflict: [], same: [] };
  const all = new Set([...local.keys(), ...remote.keys(), ...base.keys()]);
  for (const rel of [...all].sort()) {
    if (!safeRel(rel)) continue;
    const L = local.get(rel);
    const R = remote.get(rel);
    const B = base.get(rel);
    if (L === R) {
      if (L !== undefined) plan.same.push(rel);
      continue;
    }
    if (L === B) {
      // ローカル未変更 → リモートの変更を取り込む / local untouched: take the remote change
      (R === undefined ? plan.deleteLocal : plan.pull).push(rel);
    } else if (R === B) {
      // リモート未変更 → ローカルの変更を送る / remote untouched: send the local change
      (L === undefined ? plan.deleteRemote : plan.push).push(rel);
    } else if (L === undefined) {
      plan.pull.push(rel); // ローカル削除 vs リモート編集 → 編集を残す / local delete vs remote edit: keep the edit
    } else if (R === undefined) {
      plan.push.push(rel); // リモート削除 vs ローカル編集 → 編集を残す / remote delete vs local edit: keep the edit
    } else {
      plan.conflict.push(rel);
    }
  }
  return plan;
}

// 競合コピーの名前 / name for a conflict copy: "Task (conflict 2026-11-14 1532).md"
export function conflictName(rel: string, now: Date, exists: (rel: string) => boolean): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}${pad(now.getMinutes())}`;
  const stem = rel.replace(/\.md$/i, "");
  let name = `${stem} (conflict ${stamp}).md`;
  for (let i = 2; exists(name); i++) name = `${stem} (conflict ${stamp} ${i}).md`;
  return name;
}

// ── GitHub API（HTTP は注入）/ GitHub API with an injected HTTP function ──
export interface HttpResponse {
  status: number;
  json: unknown;
}
export type Http = (method: string, url: string, token: string, body?: unknown) => Promise<HttpResponse>;

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const b64encode = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const b64decode = (b64: string): Uint8Array => {
  const s = atob(b64.replace(/\s/g, ""));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

export interface RepoRef {
  owner: string;
  repo: string;
  branch: string;
  token: string;
}

export interface FileChange {
  rel: string;
  content: Uint8Array | null; // null = 削除 / delete
}

export class GitHubRepo {
  private api: string;
  constructor(private http: Http, private ref: RepoRef) {
    this.api = `https://api.github.com/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  }

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.http(method, this.api + path, this.ref.token, body);
    if (res.status >= 400) {
      const msg = (res.json as { message?: string } | null)?.message ?? `HTTP ${res.status}`;
      throw new GitHubError(res.status, msg);
    }
    return res.json;
  }

  // ブランチ先頭。空リポジトリは null / branch head, or null for an empty repo
  async head(): Promise<{ commit: string; tree: string } | null> {
    try {
      const ref = (await this.call("GET", `/git/ref/heads/${encodeURIComponent(this.ref.branch)}`)) as { object: { sha: string } };
      const commit = (await this.call("GET", `/git/commits/${ref.object.sha}`)) as { tree: { sha: string } };
      return { commit: ref.object.sha, tree: commit.tree.sha };
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 409)) return null;
      throw e;
    }
  }

  // ツリー内の安全な .md ファイル → blob sha / safe .md files in the tree → blob sha
  async files(tree: string): Promise<Map<string, string>> {
    const t = (await this.call("GET", `/git/trees/${tree}?recursive=1`)) as {
      tree: { path: string; type: string; sha: string }[];
      truncated?: boolean;
    };
    if (t.truncated) throw new GitHubError(0, "Repository tree too large to list");
    const out = new Map<string, string>();
    for (const e of t.tree) if (e.type === "blob" && safeRel(e.path)) out.set(e.path, e.sha);
    return out;
  }

  async blob(sha: string): Promise<Uint8Array> {
    const b = (await this.call("GET", `/git/blobs/${sha}`)) as { content: string; encoding: string };
    if (b.encoding !== "base64") throw new GitHubError(0, `Unexpected blob encoding ${b.encoding}`);
    return b64decode(b.content);
  }

  // 空リポジトリに README を置いて Git Data API を使える状態にする
  // seed an empty repo with a README so the Git Data API works (it refuses empty repos)
  async initialize(readme: string): Promise<void> {
    await this.call("PUT", `/contents/README.md`, {
      message: "Initialize shared task folder",
      content: b64encode(new TextEncoder().encode(readme)),
      branch: this.ref.branch,
    });
  }

  // 1 コミットで変更を反映。fast-forward できなければ GitHubError(422) / one commit; 422 if not fast-forward
  async commit(parent: { commit: string; tree: string }, changes: FileChange[], message: string): Promise<string> {
    const entries: { path: string; mode: string; type: string; sha: string | null }[] = [];
    for (const c of changes) {
      if (!safeRel(c.rel)) throw new GitHubError(0, `Refusing unsafe path ${c.rel}`);
      if (c.content === null) {
        entries.push({ path: c.rel, mode: "100644", type: "blob", sha: null });
      } else {
        const blob = (await this.call("POST", `/git/blobs`, { content: b64encode(c.content), encoding: "base64" })) as { sha: string };
        entries.push({ path: c.rel, mode: "100644", type: "blob", sha: blob.sha });
      }
    }
    const tree = (await this.call("POST", `/git/trees`, { base_tree: parent.tree, tree: entries })) as { sha: string };
    const commit = (await this.call("POST", `/git/commits`, { message, tree: tree.sha, parents: [parent.commit] })) as { sha: string };
    await this.call("PATCH", `/git/refs/heads/${encodeURIComponent(this.ref.branch)}`, { sha: commit.sha, force: false });
    return commit.sha;
  }

  // 1 ファイルを Contents API で書く（Web アプリ用、sha で楽観ロック）
  // write one file via the Contents API (web app; optimistic lock on sha)
  async putFile(rel: string, content: Uint8Array, prevSha: string | undefined, message: string): Promise<string> {
    if (!safeRel(rel)) throw new GitHubError(0, `Refusing unsafe path ${rel}`);
    const body: Record<string, unknown> = { message, content: b64encode(content), branch: this.ref.branch };
    if (prevSha) body.sha = prevSha;
    const res = (await this.call("PUT", `/contents/${rel.split("/").map(encodeURIComponent).join("/")}`, body)) as {
      content: { sha: string };
    };
    return res.content.sha;
  }

  async deleteFile(rel: string, prevSha: string, message: string): Promise<void> {
    if (!safeRel(rel)) throw new GitHubError(0, `Refusing unsafe path ${rel}`);
    await this.call("DELETE", `/contents/${rel.split("/").map(encodeURIComponent).join("/")}`, {
      message,
      sha: prevSha,
      branch: this.ref.branch,
    });
  }
}

export const SHARED_README = `# Shared task folder

This repository is mirrored into an Obsidian vault folder by the Task Gantt plugin.
Each Markdown file is one task in TaskNotes format (status, scheduled, due, projects, blockedBy).
Edit tasks in Obsidian or in the web Gantt; this README is not synced into the vault.
`;
