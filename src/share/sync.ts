// 共有フォルダ同期（Obsidian 側）/ shared-folder sync, Obsidian side
import { App, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import {
  GitHubRepo, Http, GitHubError, FileChange, SyncPlan, planSync, gitBlobSha, toRel, toVaultPath,
  conflictName, normFolder, SHARED_README,
} from "./core";

export interface ShareSettings {
  enabled: boolean;
  folder: string; // 共有する Vault フォルダ / vault folder to share
  repo: string; // "owner/name"
  branch: string;
  intervalMin: number; // 定期同期の間隔（分）/ periodic sync interval
  base: Record<string, string>; // 前回同期時の rel → blob sha / rel → sha at last sync
  lastSync: number;
  lastError: string;
}

export const DEFAULT_SHARE: ShareSettings = {
  enabled: false,
  folder: "",
  repo: "",
  branch: "main",
  intervalMin: 2,
  base: {},
  lastSync: 0,
  lastError: "",
};

// トークンは Vault 外（端末のローカルストレージ）に置く：data.json は Vault の Git に入るため
// the token lives outside the vault (device local storage): data.json is committed with the vault
const TOKEN_KEY = "task-gantt-share-token";
type LocalStore = { loadLocalStorage(k: string): unknown; saveLocalStorage(k: string, v: unknown): void };
export function loadToken(app: App): string {
  const v = (app as unknown as LocalStore).loadLocalStorage(TOKEN_KEY);
  return typeof v === "string" ? v : "";
}
export function saveToken(app: App, token: string): void {
  (app as unknown as LocalStore).saveLocalStorage(TOKEN_KEY, token || null);
}

// Obsidian の requestUrl（CORS 無関係・モバイル可）/ Obsidian's requestUrl: no CORS issues, works on mobile
export const obsidianHttp: Http = async (method, url, token, body) => {
  const res = await requestUrl({
    url,
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    throw: false,
  });
  let json: unknown = null;
  try {
    json = res.json;
  } catch {
    json = null;
  }
  return { status: res.status, json };
};

export interface SyncResult {
  plan: SyncPlan;
  conflicts: string[]; // 作った競合コピー / conflict copies written
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// 共有フォルダ内の .md を列挙（範囲外は絶対に含めない）/ list .md files in the shared folder (never anything outside)
function localFiles(app: App, folder: string): Map<string, TFile> {
  const out = new Map<string, TFile>();
  for (const f of app.vault.getMarkdownFiles()) {
    const rel = toRel(folder, f.path);
    if (rel) out.set(rel, f);
  }
  return out;
}

async function ensureFolder(app: App, path: string): Promise<void> {
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (!dir || app.vault.getAbstractFileByPath(dir) instanceof TFolder) return;
  await ensureFolder(app, dir);
  await app.vault.createFolder(dir);
}

async function writeLocal(app: App, folder: string, rel: string, text: string): Promise<void> {
  const vp = toVaultPath(folder, rel);
  if (!vp) throw new Error(`Refusing unsafe path ${rel}`);
  const path = normalizePath(vp);
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) await app.vault.modify(existing, text);
  else {
    await ensureFolder(app, path);
    await app.vault.create(path, text);
  }
}

// 1 回の同期。http/now はテスト用に注入可 / one sync pass; http/now injectable for tests
export async function syncOnce(
  app: App,
  share: ShareSettings,
  token: string,
  http: Http = obsidianHttp,
  now: () => Date = () => new Date()
): Promise<SyncResult> {
  const folder = normFolder(share.folder);
  if (!folder) throw new Error("Choose a folder to share first");
  const [owner, repoName] = share.repo.split("/").map((s) => s.trim());
  if (!owner || !repoName) throw new Error('Repository must look like "owner/name"');
  if (!token) throw new Error("Add a GitHub token first");
  const repo = new GitHubRepo(http, { owner, repo: repoName, branch: share.branch || "main", token });

  let head = await repo.head();
  if (!head) {
    await repo.initialize(SHARED_README);
    head = await repo.head();
    if (!head) throw new Error("Could not initialize the repository");
  }

  // 三方の状態を集める / gather the three sides
  const files = localFiles(app, folder);
  const texts = new Map<string, string>();
  const local = new Map<string, string>();
  for (const [rel, f] of files) {
    const text = await app.vault.read(f);
    texts.set(rel, text);
    local.set(rel, await gitBlobSha(enc.encode(text)));
  }
  const remote = await repo.files(head.tree);
  const base = new Map(Object.entries(share.base ?? {}));
  const plan = planSync(local, remote, base);
  // 片側が丸ごと空になったのに相手側を全削除しようとしている＝フォルダの改名・別リポジトリ等の事故。止める
  // one side is suddenly empty and the plan would wipe the other: almost always a renamed folder or a
  // swapped repo, not a real mass delete. Refuse instead of propagating it.
  if (local.size === 0 && plan.deleteRemote.length > 0)
    throw new Error(`The shared folder "${folder}" is empty or missing here; refusing to delete ${plan.deleteRemote.length} file(s) from the repo. Fix the folder setting, or clear the repo yourself if you really mean it.`);
  if (remote.size === 0 && plan.deleteLocal.length > 0)
    throw new Error(`The repo has no task files; refusing to delete ${plan.deleteLocal.length} local file(s). Check the repository setting.`);
  const newBase = new Map<string, string>();
  for (const rel of plan.same) newBase.set(rel, local.get(rel)!);

  // リモート → ローカル / remote → local
  for (const rel of plan.pull) {
    const bytes = await repo.blob(remote.get(rel)!);
    await writeLocal(app, folder, rel, dec.decode(bytes));
    newBase.set(rel, remote.get(rel)!);
  }
  for (const rel of plan.deleteLocal) {
    const f = files.get(rel);
    if (f && toRel(folder, f.path) === rel) await app.fileManager.trashFile(f);
  }

  // 競合：ローカルを正とし、リモート版は隣にコピーとして残す（次回ローカルが送られる）
  // conflicts: local wins the original name, the remote version is kept beside it as a copy
  // (base is set to the remote sha so the local version is pushed on this pass)
  const conflicts: string[] = [];
  const taken = (r: string) => files.has(r) || remote.has(r) || conflicts.includes(r);
  for (const rel of plan.conflict) {
    const bytes = await repo.blob(remote.get(rel)!);
    const copy = conflictName(rel, now(), taken);
    await writeLocal(app, folder, copy, dec.decode(bytes));
    conflicts.push(copy);
  }

  // ローカル → リモート（1 コミット）。競合コピーは次回の走査でローカル新規として送られる
  // local → remote in a single commit; conflict copies go up on the next pass as new local files
  const changes: FileChange[] = [
    ...plan.push.map((rel) => ({ rel, content: enc.encode(texts.get(rel)!) })),
    ...plan.conflict.map((rel) => ({ rel, content: enc.encode(texts.get(rel)!) })),
    ...plan.deleteRemote.map((rel) => ({ rel, content: null as Uint8Array | null })),
  ];
  if (changes.length) {
    const n = changes.length;
    await repo.commit(head, changes, `Obsidian sync: ${n} file${n === 1 ? "" : "s"}`);
    for (const rel of [...plan.push, ...plan.conflict]) newBase.set(rel, local.get(rel)!);
  }
  share.base = Object.fromEntries(newBase);
  share.lastSync = now().getTime();
  share.lastError = "";
  return { plan, conflicts };
}

// 同期の実行管理（多重実行防止・デバウンス・定期実行）/ run control: no overlap, debounce, interval
export class ShareSyncer {
  private running = false;
  private again = false;
  private timer: number | null = null;
  private interval: number | null = null;
  onStatus: (text: string) => void = () => {};

  constructor(
    private app: App,
    private getShare: () => ShareSettings,
    private save: () => Promise<void>,
    private notify: (msg: string) => void
  ) {}

  start(): void {
    this.stop();
    const s = this.getShare();
    if (!s.enabled) {
      this.onStatus("");
      return;
    }
    const min = Math.max(1, Number(s.intervalMin) || 2);
    this.interval = window.setInterval(() => void this.run(), min * 60_000);
    this.schedule(2_000);
  }

  stop(): void {
    if (this.interval !== null) window.clearInterval(this.interval);
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.interval = this.timer = null;
  }

  // 共有フォルダ内の変更なら数秒後に同期 / schedule a sync shortly after a change inside the folder
  touched(path: string): void {
    const s = this.getShare();
    if (s.enabled && toRel(s.folder, path)) this.schedule(8_000);
  }

  schedule(ms: number): void {
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.run();
    }, ms);
  }

  async run(manual = false): Promise<void> {
    const s = this.getShare();
    if (!s.enabled && !manual) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.onStatus("Syncing…");
    try {
      let attempt = 0;
      for (;;) {
        try {
          const res = await syncOnce(this.app, s, loadToken(this.app));
          const p = res.plan;
          const moved = p.pull.length + p.push.length + p.deleteLocal.length + p.deleteRemote.length;
          if (res.conflicts.length)
            this.notify(`Shared tasks: ${res.conflicts.length} conflict copy saved (${res.conflicts.join(", ")}). Merge it into the original, then delete the copy.`);
          else if (manual) this.notify(moved ? `Shared tasks synced (${moved} change${moved === 1 ? "" : "s"})` : "Shared tasks already up to date");
          break;
        } catch (e) {
          // 他者のコミットと競合（fast-forward 不可）→ 取り直して 1 回だけ再試行
          // someone else committed in between (not fast-forward): re-read and retry once
          if (e instanceof GitHubError && e.status === 422 && attempt++ < 1) continue;
          throw e;
        }
      }
    } catch (e) {
      s.lastError = e instanceof Error ? e.message : String(e);
      this.onStatus("Sync error");
      if (manual) this.notify(`Shared tasks sync failed: ${s.lastError}`);
    } finally {
      await this.save();
      this.running = false;
      if (s.lastError === "") this.onStatus(`Synced ${new Date(s.lastSync).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`);
      if (this.again) {
        this.again = false;
        this.schedule(1_000);
      }
    }
  }
}
