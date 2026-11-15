// 共有フォルダ同期（Obsidian 側）/ shared-folder sync, Obsidian side
import { App, TFile, TFolder, normalizePath, requestUrl } from "obsidian";
import {
  GitHubRepo, Http, GitHubError, FileChange, SyncPlan, planSync, gitBlobSha, toRel, toVaultPath,
  normFolder, SHARED_README, mergeNotes, conflictCopy, conflictCopyRel, CONFLICT_DIR,
} from "./core";

export interface ShareSettings {
  enabled: boolean;
  folder: string; // 共有する Vault フォルダ / vault folder to share
  repo: string; // "owner/name"
  branch: string;
  intervalMin: number; // 定期同期の間隔（分）/ periodic sync interval
  base: Record<string, string>; // 前回同期時の rel → blob sha / rel → sha at last sync
  lastCommit: string; // 最後に確認/作成したコミット / last commit we saw or made (stale-read guard)
  legacyCopiesCleaned: boolean; // 旧形式の競合コピーを片付け済み / old-style conflict copies cleaned up
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
  lastCommit: "",
  legacyCopiesCleaned: false,
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
      "Cache-Control": "no-cache",
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
  merged: string[]; // 自動マージできたノート / notes merged field by field
  conflicts: string[]; // 作った競合コピー / conflict copies written
  skipped: string[]; // 同期中に編集されたので次回へ / edited during the pass, left for the next one
}

// GitHub の読み取りがまだ古い（自分の直前のコミットより前を返した）/ GitHub returned an older branch tip than one we already saw
export class StaleReadError extends Error {
  constructor() {
    super("GitHub hasn't caught up with the last sync yet");
  }
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
//
// Order matters for robustness: everything that goes to GitHub is decided and committed FIRST.
// Only after that commit succeeds are local files written, so a failed or retried pass never
// leaves half-applied changes or extra conflict copies behind.
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
  // 古い読み取りの検出：前回見た/作ったコミットより後ろを返されたら何もしない
  // stale-read guard: if GitHub hands back a tip that is behind one we already saw, do nothing
  if (share.lastCommit && head.commit !== share.lastCommit) {
    const status = await repo.compare(head.commit, share.lastCommit);
    if (status === "ahead") throw new StaleReadError();
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

  // ── 1. 送るものを決める（ローカルはまだ触らない）/ decide what goes up (nothing local is touched yet) ──
  const outgoing = new Map<string, string | null>(); // rel -> text, null = delete
  const localWrites = new Map<string, string>(); // rel -> text to write locally after the commit
  for (const rel of plan.push) outgoing.set(rel, texts.get(rel)!);
  for (const rel of plan.deleteRemote) outgoing.set(rel, null);
  for (const rel of plan.pull) localWrites.set(rel, dec.decode(await repo.blob(remote.get(rel)!)));

  const merged: string[] = [];
  const conflicts: string[] = [];
  // 既存の競合コピーの内容（同じコピーを二度作らない）/ existing copy contents, so an identical copy is never made twice
  const copyShas = new Set<string>();
  for (const [rel, sha] of [...local, ...remote]) if (rel.startsWith(`${CONFLICT_DIR}/`)) copyShas.add(sha);
  const taken = (r: string) => files.has(r) || remote.has(r) || outgoing.has(r);
  for (const rel of plan.conflict) {
    const remoteText = dec.decode(await repo.blob(remote.get(rel)!));
    const baseSha = base.get(rel);
    const baseBytes = baseSha ? await repo.blobOrNull(baseSha) : null;
    const m = mergeNotes(baseBytes ? dec.decode(baseBytes) : null, texts.get(rel)!, remoteText);
    outgoing.set(rel, m.text);
    if (m.text !== texts.get(rel)) localWrites.set(rel, m.text);
    if (m.clean) {
      merged.push(rel);
      continue;
    }
    const copy = conflictCopy(remoteText, m.conflicts);
    const copySha = await gitBlobSha(enc.encode(copy));
    if (copyShas.has(copySha)) continue; // 同一内容のコピーが既にある / an identical copy already exists
    const copyRel = conflictCopyRel(rel, now(), taken);
    copyShas.add(copySha);
    outgoing.set(copyRel, copy);
    localWrites.set(copyRel, copy);
    conflicts.push(copyRel);
  }

  // ── 2. コミット（失敗したらローカルは一切変えない）/ commit; on failure nothing local has changed ──
  const newBase = new Map<string, string>();
  for (const rel of plan.same) newBase.set(rel, local.get(rel)!);
  let tip = head.commit;
  if (outgoing.size) {
    const changes: FileChange[] = [...outgoing].map(([rel, text]) => ({ rel, content: text === null ? null : enc.encode(text) }));
    const n = changes.length;
    tip = await repo.commit(head, changes, `Obsidian sync: ${n} file${n === 1 ? "" : "s"}`);
    for (const [rel, text] of outgoing) if (text !== null) newBase.set(rel, await gitBlobSha(enc.encode(text)));
  }
  share.lastCommit = tip;

  // ── 3. ローカルへ反映。読んだ後に編集されたファイルは触らず次回へ ──
  // apply locally; a file edited since we read it is left alone and settled on the next pass
  const skipped: string[] = [];
  const unchangedSinceRead = async (rel: string): Promise<boolean> => {
    const vp = toVaultPath(folder, rel);
    const f = vp ? app.vault.getAbstractFileByPath(normalizePath(vp)) : null;
    if (!(f instanceof TFile)) return !texts.has(rel); // 読んだ時も無かった / it didn't exist when read either
    return (await app.vault.read(f)) === texts.get(rel);
  };
  const keepOldBase = (rel: string) => {
    // a merged note already went up: track the pre-merge remote blob (it exists on GitHub) so the
    // next pass merges the new local edit against it; otherwise keep whatever base we had
    if (plan.conflict.includes(rel)) newBase.set(rel, remote.get(rel)!);
    else if (base.has(rel)) newBase.set(rel, base.get(rel)!);
    else newBase.delete(rel);
  };
  for (const [rel, text] of localWrites) {
    if (!(await unchangedSinceRead(rel))) {
      skipped.push(rel);
      keepOldBase(rel);
      continue;
    }
    await writeLocal(app, folder, rel, text);
    if (!newBase.has(rel)) newBase.set(rel, remote.get(rel)!);
  }
  for (const rel of plan.deleteLocal) {
    const f = files.get(rel);
    if (!f || toRel(folder, f.path) !== rel) continue;
    if (!(await unchangedSinceRead(rel))) {
      skipped.push(rel);
      keepOldBase(rel); // edited after we read it: next pass sees "remote deleted, local edited" and restores it
      continue;
    }
    await app.fileManager.trashFile(f);
  }
  share.base = Object.fromEntries(newBase);
  share.lastSync = now().getTime();
  share.lastError = "";
  return { plan, merged, conflicts, skipped };
}

// 旧形式（フォルダ直下の "名前 (conflict YYYY-MM-DD HHMM[ N]).md"）の競合コピーを一度だけ片付ける。
// 元タスクが存在し、コピーの dateModified が元以下（＝古い途中版）のものだけをゴミ箱へ
// one-time cleanup of old-style copies ("Name (conflict YYYY-MM-DD HHMM[ N]).md" at the folder root):
// only copies whose original still exists and whose dateModified is not newer go to the trash
const LEGACY_COPY = /^(.+) \(conflict \d{4}-\d{2}-\d{2} \d{4}(?: \d+)?\)\.md$/;
export async function cleanLegacyCopies(app: App, folder: string): Promise<string[]> {
  const f = normFolder(folder);
  if (!f) return [];
  const files = localFiles(app, f);
  const modified = async (file: TFile): Promise<number> => {
    const m = (await app.vault.read(file)).match(/^dateModified:\s*["']?([^"'\n]+)/m);
    const t = m ? Date.parse(m[1]) : NaN;
    return Number.isFinite(t) ? t : 0;
  };
  const removed: string[] = [];
  for (const [rel, file] of files) {
    if (rel.includes("/")) continue;
    const m = rel.match(LEGACY_COPY);
    if (!m) continue;
    const original = files.get(`${m[1]}.md`);
    if (!original) continue;
    // older than the task, or the same content apart from dateModified: a stale duplicate
    const strip = (t: string) => t.replace(/^dateModified:.*$/m, "");
    const same = strip(await app.vault.read(file)) === strip(await app.vault.read(original));
    if (!same && (await modified(file)) > (await modified(original))) continue;
    await app.fileManager.trashFile(file);
    removed.push(rel);
  }
  return removed;
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
          if (!s.legacyCopiesCleaned) {
            const removed = await cleanLegacyCopies(this.app, s.folder);
            s.legacyCopiesCleaned = true;
            if (removed.length) this.notify(`Shared tasks: moved ${removed.length} old duplicate conflict copies to the trash.`);
          }
          const res = await syncOnce(this.app, s, loadToken(this.app));
          const p = res.plan;
          const moved = p.pull.length + p.push.length + p.deleteLocal.length + p.deleteRemote.length + res.merged.length;
          if (res.conflicts.length)
            this.notify(`Shared tasks: the same field was edited on both sides in ${res.conflicts.length} task(s). Obsidian's version was kept; the other version is in "${CONFLICT_DIR}" (not shown as a task). Copy anything you need, then delete it.`);
          else if (manual) this.notify(moved ? `Shared tasks synced (${moved} change${moved === 1 ? "" : "s"})` : "Shared tasks already up to date");
          if (res.skipped.length) this.schedule(3_000); // settle files edited mid-pass
          break;
        } catch (e) {
          // GitHub がまだ追いついていない／他者のコミットが割り込んだ → 少し待って取り直す（最大 3 回）
          // GitHub hasn't caught up yet, or someone committed in between: wait, re-read, retry (3 tries)
          const retriable = e instanceof StaleReadError || (e instanceof GitHubError && (e.status === 409 || e.status === 422));
          if (retriable && attempt < 3) {
            await new Promise((r) => window.setTimeout(r, 1500 * 2 ** attempt++));
            continue;
          }
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
