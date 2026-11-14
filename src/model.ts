import { App, TFile, TFolder, getAllTags, normalizePath } from "obsidian";
import { GanttSettings } from "./settings";
import { Task, Row, Dep, DepType, StatusDef, StatusGroup } from "./types";

// ── ステータスグループ / status groups ──
// 移行用の推測に使うキーワード（id・ラベルを小文字化して部分一致）。上から順に評価し、
// どれにも当たらなければ active。日英に加えて日常的に使う和語も見る。
// keywords for the migration guess (substring match on lowercased id + label), evaluated in
// order; anything unmatched lands in active. Japanese wording is included alongside English.
const GROUP_HINTS: [StatusGroup, string[]][] = [
  ["completed", ["done", "complete", "closed", "finish", "resolved", "完了", "済", "終了"]],
  ["cancelled", ["cancel", "reject", "dropped", "abandon", "中止", "キャンセル", "却下", "取り消", "取消"]],
  ["deferred", ["defer", "hold", "pending", "paused", "block", "waiting", "保留", "延期", "待ち", "中断"]],
];

// 既存設定（group を持たない）から所属グループを推測する / guess a group for a pre-upgrade status
export function inferStatusGroup(id: string, label: string): StatusGroup {
  const hay = `${id} ${label}`.toLowerCase();
  for (const [group, words] of GROUP_HINTS) {
    if (words.some((w) => hay.includes(w))) return group;
  }
  return "active";
}

// タスクのステータスが属するグループ。未設定・設定に無い id は undefined（＝分類不能）で、
// 完了扱いにはしない：分類できないものを完了に寄せると完了フィルタが嘘をつく
// the group a task's status belongs to; unset or unknown ids yield undefined rather than being
// folded into "completed" — guessing there would make the completed filter lie
export function statusGroupOf(statuses: StatusDef[], status?: string): StatusGroup | undefined {
  if (!status) return undefined;
  return statuses.find((s) => s.id === status)?.group;
}

// ── TaskNotes 互換 / TaskNotes compatibility ──
// TaskNotes は依存を {uid, reltype, gap?} オブジェクトで、時刻をオフセット無しで保存し、
// 書き込みごとに dateModified・完了時に completedDate を更新する。互換モードではそれに合わせる
// TaskNotes stores dependencies as {uid, reltype, gap?} objects, times without an offset, and
// bumps dateModified on every write (completedDate on completion). Compat mode follows suit.
let compat = false;
let compatStatuses: StatusDef[] = [];
let compatStatusKey = "status";
export function configureCompat(on: boolean, statuses: StatusDef[], statusKey = "status"): void {
  compat = on;
  compatStatuses = statuses;
  compatStatusKey = statusKey;
}
export function isCompat(): boolean {
  return compat;
}
// 書き込み用タイムゾーン。互換モードは "floating"＝オフセット無し / tz used when writing; compat = floating (no offset)
export function writeTz(tz: string): string {
  return compat ? "floating" : tz;
}

const RELTYPE_TO_DEP: Record<string, DepType> = { FINISHTOSTART: "FS", STARTTOSTART: "SS", FINISHTOFINISH: "FF" };
const DEP_TO_RELTYPE: Record<DepType, string> = { FS: "FINISHTOSTART", SS: "STARTTOSTART", FF: "FINISHTOFINISH" };

// 依存エントリ（"FS:[[x]]" 文字列 or TaskNotes オブジェクト）を型＋リンクへ / parse a dependency entry
// (a "FS:[[x]]" string or a TaskNotes object) into type + link; unparseable → null
export function parseDepEntry(raw: unknown): { type: DepType; link: string } | null {
  if (raw == null) return null;
  if (typeof raw === "object") {
    const o = raw as { uid?: unknown; reltype?: unknown };
    const uid = typeof o.uid === "string" ? o.uid.trim() : "";
    if (!uid) return null;
    const rt = typeof o.reltype === "string" ? o.reltype.trim().toUpperCase() : "";
    // STARTTOFINISH は未対応 → FS として描く（元の値は書き換えない）/ SF unsupported: drawn as FS, stored value untouched
    return { type: RELTYPE_TO_DEP[rt] ?? "FS", link: uid };
  }
  const str = String(raw).trim();
  if (!str) return null;
  const m = str.match(/^(FS|SS|FF)\s*:\s*(.*)$/i);
  if (m) return { type: m[1].toUpperCase() as DepType, link: m[2].trim() };
  return { type: "FS", link: str };
}

// 依存エントリを保存形へ / build a stored dependency entry
export function makeDepEntry(link: string, type: DepType, asObject: boolean, gap?: string): unknown {
  if (asObject) return gap ? { uid: link, reltype: DEP_TO_RELTYPE[type], gap } : { uid: link, reltype: DEP_TO_RELTYPE[type] };
  return type === "FS" ? link : `${type}:${link}`; // FS はプレフィックス無しで後方互換 / FS unprefixed for back-compat
}

// ローカル日付 YYYY-MM-DD / local calendar date
function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
// TaskNotes と同じ形式のローカル ISO（ミリ秒＋オフセット）/ local ISO with ms + offset, as TaskNotes writes it
function localIsoWithOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${localDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${ms}${offsetSuffix(off)}`;
}

// 互換モードの書き込み後処理：完了日と更新日時 / compat post-write: completedDate + dateModified
export function applyTaskNotesTouch(
  fm: Record<string, unknown>,
  statusKey: string,
  before: unknown,
  statuses: StatusDef[] = compatStatuses,
  now: Date = new Date()
): void {
  const after = fm[statusKey];
  // 繰り返しタスクは TaskNotes が complete_instances で管理するので触らない / recurring tasks are TaskNotes' business
  if (after !== before && fm.recurrence == null) {
    const gAfter = statusGroupOf(statuses, after == null ? undefined : String(after));
    const gBefore = statusGroupOf(statuses, before == null ? undefined : String(before));
    if (gAfter === "completed") {
      if (!fm.completedDate) fm.completedDate = localDate(now);
    } else if (gBefore === "completed") delete fm.completedDate;
  }
  fm.dateModified = localIsoWithOffset(now);
}

// すべてのフロントマター書き込みの入口 / single entry point for frontmatter writes
async function editFm(
  app: App,
  file: TFile,
  statusKey: string,
  fn: (fm: Record<string, unknown>) => void
): Promise<void> {
  await app.fileManager.processFrontMatter(file, (fm: Record<string, unknown>) => {
    const before = fm[statusKey];
    fn(fm);
    if (compat) applyTaskNotesTouch(fm, statusKey, before);
  });
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

// 設定タイムゾーンのオフセット（分）。"system" は端末のその時点のオフセット（DST考慮）
// configured timezone offset in minutes; "system" = device offset at that instant (DST-aware)
function offsetMinutes(tz: string, instantMs: number): number {
  const m = tz.match(/^([+-])(\d{2}):(\d{2})$/);
  if (m) return (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]);
  return -new Date(instantMs).getTimezoneOffset();
}

// 分オフセットを "+09:00" 形式へ / minutes to a "+09:00" suffix
function offsetSuffix(min: number): string {
  const a = Math.abs(min);
  return `${min < 0 ? "-" : "+"}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

// 保存値を表示用の日付＋時刻へ。オフセット付き（+09:00 / Z）は設定タイムゾーンへ換算、
// naive（オフセット無し）はそのまま、日付として読めない値（例: "未定"）は undefined
// parse a stored value into display date + time: zoned values convert to the configured tz,
// naive values pass through, non-date values (e.g. "未定") become undefined
export function parseStored(v: unknown, tz: string): { date: string; time?: string } | undefined {
  if (v == null || v === "") return undefined;
  if (v instanceof Date) v = v.toISOString();
  const m = String(v)
    .trim()
    .match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?)?/);
  if (!m) return undefined;
  const [, date, h, mi, zone] = m;
  if (h == null) return { date };
  const hh = +h;
  const mm = +mi;
  if (hh > 23 || mm > 59) return { date }; // 不正な時刻は日付のみ扱い / invalid time → date only
  if (!zone) return { date, time: `${pad2(hh)}:${pad2(mm)}` };
  const zu = zone.toUpperCase();
  const zMin = zu === "Z" ? 0 : (zu[0] === "-" ? -1 : 1) * (+zu.slice(1, 3) * 60 + +zu.replace(":", "").slice(-2));
  const [y, mo, d] = date.split("-").map(Number);
  const instant = Date.UTC(y, mo - 1, d, hh, mm) - zMin * 60000;
  const disp = new Date(instant + offsetMinutes(tz, instant) * 60000).toISOString();
  return { date: disp.slice(0, 10), time: disp.slice(11, 16) };
}

// 設定タイムゾーンの壁時計（日付＋時刻）を絶対時刻(ms)へ。通知トリガーの計算に使う
// wall-clock date + time in the configured tz → absolute epoch ms (used for notification triggers)
export function toInstant(date: string, time: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const m = tz.match(/^([+-])(\d{2}):(\d{2})$/);
  const off = m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : -new Date(`${date}T${time}`).getTimezoneOffset();
  return naive - off * 60000;
}

// 表示用の日付＋時刻を保存形式へ（時刻があれば設定タイムゾーンのオフセットを付与）
// combine display date + time into the stored value (a time gets the configured tz offset appended)
export function combineDateTime(date: string | undefined, time: string | undefined, tz: string): string | undefined {
  if (!date) return undefined;
  if (!time) return date;
  if (tz === "floating") return `${date}T${time}`; // TaskNotes 形式（オフセット無し）/ TaskNotes style, no offset
  // "system" はその日時のローカルオフセット（DST考慮）/ "system" = device offset at that wall time (DST-aware)
  const m = tz.match(/^([+-])(\d{2}):(\d{2})$/);
  const min = m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : -new Date(`${date}T${time}`).getTimezoneOffset();
  return `${date}T${time}${offsetSuffix(min)}`;
}

// after を文字列配列へ正規化 / normalize `after` into a string array
function toArray(v: unknown): unknown[] {
  if (v == null || v === "") return [];
  if (Array.isArray(v)) return v as unknown[];
  return [v];
}

// フロントマターの tags 値を文字列配列へ正規化（配列/カンマ/空白区切り・# 抜き）
// normalize a frontmatter `tags` value into a string array (array / comma / space separated, # stripped)
function normalizeTags(v: unknown): string[] {
  if (v == null) return [];
  const raw = Array.isArray(v) ? v.map((x) => String(x)) : String(v).split(/[,\s]+/);
  return raw.map((x) => x.replace(/^#/, "").trim()).filter(Boolean);
}

// wikilink / Markdown リンク / 生パスから実ファイルを解決 / resolve a wikilink, markdown link, or raw path
function resolveLink(app: App, raw: string, sourcePath: string): TFile | null {
  let inner = raw.trim();
  const md = inner.match(/\]\(([^)]+)\)/); // [text](path)
  if (md) inner = decodeURIComponent(md[1]);
  else inner = inner.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
  inner = inner.split("#")[0].trim();
  return app.metadataCache.getFirstLinkpathDest(inner, sourcePath);
}

// パスが表示スコープ（フォルダ）内か。"" や "/" は Vault 全体 / is a path inside the scoped folder ("" or "/" = whole vault)
export function inScope(folder: string, path: string): boolean {
  const f = (folder || "").replace(/^\/+|\/+$/g, "");
  if (!f) return true;
  return path === f || path.startsWith(f + "/");
}

// 指定フォルダ配下のタスクを収集（folderPath="" は Vault ルート）/ collect tasks under a scoped folder
export function collectTasks(app: App, settings: GanttSettings, folderPath: string): Task[] {
  const rootPath = normalizePath(folderPath || "/");
  const root =
    rootPath === "/" ? app.vault.getRoot() : app.vault.getAbstractFileByPath(rootPath);
  if (!(root instanceof TFolder)) return [];
  const isVaultRoot = root === app.vault.getRoot();

  const files: TFile[] = [];
  const walk = (folder: TFolder) => {
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension === "md") files.push(child);
      else if (child instanceof TFolder && settings.recurse) walk(child);
    }
  };
  walk(root);

  const k = settings.keys;
  const rawAfter = new Map<string, unknown[]>(); // path -> 生の after / raw after entries
  const rawParent = new Map<string, string[]>(); // path -> 親候補リンク / candidate parent links
  const tasks: Task[] = files.map((file) => {
    const cache = app.metadataCache.getFileCache(file);
    const fm = cache?.frontmatter ?? {};
    // タグはフロントマター＋本文 #tag を統合し # を外す（重複排除）/ merge frontmatter + inline tags, strip #, dedupe
    const tags = cache ? [...new Set((getAllTags(cache) ?? []).map((x) => x.replace(/^#/, "")))] : [];
    // スコープから見たフォルダ階層（ファイル名は除く）/ folder chain relative to the scope (without filename)
    const rel = isVaultRoot ? file.path : file.path.slice(rootPath.length + 1);
    const segs = rel.split("/");
    const groups = segs.slice(0, -1);

    const ps = parseStored(fm[k.start], settings.tz);
    const pe = parseStored(fm[k.end], settings.tz);
    let start = ps?.date;
    let startTime = ps?.time;
    let end = pe?.date;
    // マイルストーン＝期限(end)のみ入力、または明示フラグ。TaskNotes では期限のみは普通のタスクなので明示フラグのみ
    // milestone = only the due date, or explicit flag. In TaskNotes a due-only task is ordinary: flag only
    const milestone = fm[k.milestone] === true || (!compat && !!end && !start);
    // 互換モードの期限のみタスクは期限日に置く / compat: a due-only task sits on its due date
    if (compat && end && !start && !milestone) {
      start = end;
      startTime = pe?.time;
    }
    // 「開始のみ・終了なし」は無効ルール → 終了=開始（1日タスク扱い）/ "start only" isn't valid: mirror end = start
    if (start && !end) end = start;

    rawAfter.set(file.path, toArray(fm[k.after]));
    // parent は any を直接受けず unknown 経由で安全に文字列化 / coerce parent via unknown (avoid unsafe any)
    const pv: unknown = fm[k.parent];
    if (pv != null && pv !== "") {
      // TaskNotes の projects は複数可：スコープ内で解決できる最初のタスクを親とする
      // TaskNotes' projects is a list: the first entry resolving to an in-scope task is the parent
      const list = Array.isArray(pv) ? (pv as unknown[]) : [pv];
      rawParent.set(file.path, compat ? list.map((x) => String(x)) : [String(list[0])]);
    }
    return {
      path: file.path,
      name: file.basename,
      groups,
      start,
      end,
      startTime,
      endTime: pe?.time,
      // 0 以下や数値でない見積りは「未設定」として既定長へ倒す / non-numeric or non-positive estimates fall back to the default length
      estimateMin: Number.isFinite(Number(fm[k.estimate])) && Number(fm[k.estimate]) > 0 ? Number(fm[k.estimate]) : undefined,
      status: fm[k.status] != null ? String(fm[k.status]) : undefined,
      assignee: fm[k.assignee] != null ? String(fm[k.assignee]) : undefined,
      deps: [] as Dep[],
      progress: fm[k.progress] != null ? Number(fm[k.progress]) : undefined,
      milestone,
      parent: undefined,
      tags,
    };
  });

  // 依存（after）を型付きでパスへ解決 / resolve typed dependencies to paths
  const byPath = new Map(tasks.map((t) => [t.path, t]));
  for (const t of tasks) {
    for (const raw of rawAfter.get(t.path) ?? []) {
      const dep = parseDepEntry(raw);
      if (!dep) continue;
      const dest = resolveLink(app, dep.link, t.path);
      if (dest && dest.path !== t.path && byPath.has(dest.path) && !t.deps.some((d) => d.path === dest.path))
        t.deps.push({ path: dest.path, type: dep.type });
    }
    // 親リンクを解決（解決できない＝宙ぶらりんはトップレベル扱い）/ resolve parent (unresolved = treated as top-level)
    for (const rp of rawParent.get(t.path) ?? []) {
      const dest = resolveLink(app, rp, t.path);
      if (dest && dest.path !== t.path && byPath.has(dest.path)) {
        t.parent = dest.path;
        break;
      }
    }
  }
  return tasks;
}

// スコープ配下の全サブフォルダを「相対セグメント配列」で収集（空フォルダ表示用）
// collect all subfolders under the scope as relative segment arrays (used to show empty folders)
export function collectFolders(app: App, settings: GanttSettings, folderPath: string): string[][] {
  if (!settings.recurse) return []; // 非再帰ならサブフォルダはグループ化されない / no grouping when not recursing
  const rootPath = normalizePath(folderPath || "/");
  const root =
    rootPath === "/" ? app.vault.getRoot() : app.vault.getAbstractFileByPath(rootPath);
  if (!(root instanceof TFolder)) return [];
  const isVaultRoot = root === app.vault.getRoot();
  const out: string[][] = [];
  const walk = (folder: TFolder) => {
    for (const child of folder.children) {
      if (!(child instanceof TFolder)) continue;
      const rel = isVaultRoot ? child.path : child.path.slice(rootPath.length + 1);
      out.push(rel.split("/"));
      walk(child);
    }
  };
  walk(root);
  return out;
}

// タスクの開始・終了アンカー（マイルストーンは期限日に集約）/ task anchor dates (milestone collapses to its due date)
export function anchorStart(t: Task): string | undefined {
  return t.milestone ? t.end ?? t.start : t.start;
}
export function anchorEnd(t: Task): string | undefined {
  return t.milestone ? t.end ?? t.start : t.end ?? t.start;
}

// フォルダのツリーノード / folder tree node
interface TreeNode {
  name: string;
  folders: Map<string, TreeNode>;
  tasks: Task[];
}

// 配下（子孫含む）の全タスク / all descendant tasks
function descendantTasks(node: TreeNode): Task[] {
  const out = [...node.tasks];
  for (const c of node.folders.values()) out.push(...descendantTasks(c));
  return out;
}

// タスク群からまとめバー範囲を求める / compute the rolled-up span
function spanOf(tasks: Task[]): { start: string; end: string } | undefined {
  const starts = tasks.map(anchorStart).filter((d): d is string => !!d).sort();
  const ends = tasks.map(anchorEnd).filter((d): d is string => !!d).sort();
  return starts.length && ends.length ? { start: starts[0], end: ends[ends.length - 1] } : undefined;
}

// フォルダ階層を入れ子の表示行へ展開（collapsed のフォルダは子を省く）
// flatten the folder tree into nested rows (collapsed folders hide their children)
// 既定のタスク比較＝開始日昇順（呼び出し側が指定しなければこれ）/ default task order = start ascending
// ── 並び順（Obsidian と Web で共通）/ sort order shared by Obsidian and the web app ──
export type SortBy = "name" | "start" | "end" | "progress" | "assignee" | "status" | "tags";
export interface Sortable {
  name: string;
  path?: string;
  rel?: string;
  start?: string;
  end?: string;
  milestone: boolean;
  status?: string;
  progress?: number;
  assignee?: string;
  tags?: string[];
}
const NO_DATE = "9999-99-99"; // 日付なしは昇順で末尾 / undated sorts last ascending
const startOf = (t: Sortable) => (t.milestone ? t.end ?? t.start : t.start);
const endOf = (t: Sortable) => (t.milestone ? t.end ?? t.start : t.end ?? t.start);
// 選んだ列で比較し、同値は名前→パスで必ず決着させる（ファイル列挙順に依存しない）
// compare by the chosen column; ties always fall back to name then path, never to file listing order
export function makeTaskCompare(
  by: string,
  dir: "asc" | "desc",
  statuses: { id: string }[] = []
): (a: Sortable, b: Sortable) => number {
  const sign = dir === "desc" ? -1 : 1;
  const statusOrder = new Map(statuses.map((s, i) => [s.id, i]));
  const key = (t: Sortable): string | number => {
    switch (by as SortBy) {
      case "name": return t.name.toLowerCase();
      case "end": return endOf(t) ?? NO_DATE;
      case "progress": return t.progress ?? -1;
      case "assignee": return (t.assignee ?? "").toLowerCase();
      case "status": return t.status != null ? statusOrder.get(t.status) ?? 999 : 999;
      case "tags": return (t.tags ?? []).join(",").toLowerCase();
      default: return startOf(t) ?? NO_DATE;
    }
  };
  return (a, b) => {
    const ka = key(a);
    const kb = key(b);
    const c = typeof ka === "number" && typeof kb === "number" ? ka - kb : String(ka).localeCompare(String(kb));
    if (c) return c * sign;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase()) || (a.path ?? a.rel ?? "").localeCompare(b.path ?? b.rel ?? "");
  };
}

const defaultTaskCompare = makeTaskCompare("start", "asc");

export function buildRows(
  tasks: Task[],
  collapsed: Set<string> = new Set(),
  folders: string[][] = [],
  taskCompare: (a: Task, b: Task) => number = defaultTaskCompare,
  nest = false // 親子（parent）でネストするか（フォルダグループ化時のみ）/ nest by parent (folder grouping only)
): Row[] {
  const root: TreeNode = { name: "", folders: new Map(), tasks: [] };
  // 先に（空かもしれない）フォルダのノードを作る＝タスクが無くても行が出る
  // seed nodes for (possibly empty) folders first, so a folder shows even with no tasks
  for (const chain of folders) {
    let node = root;
    for (const g of chain) {
      if (!g) continue;
      if (!node.folders.has(g)) node.folders.set(g, { name: g, folders: new Map(), tasks: [] });
      node = node.folders.get(g)!;
    }
  }
  for (const t of tasks) {
    let node = root;
    for (const g of t.groups) {
      if (!node.folders.has(g)) node.folders.set(g, { name: g, folders: new Map(), tasks: [] });
      node = node.folders.get(g)!;
    }
    node.tasks.push(t);
  }

  const rows: Row[] = [];
  const walk = (node: TreeNode, depth: number, prefix: string) => {
    // フォルダを名前順に / folders first, sorted by name
    for (const name of [...node.folders.keys()].sort((a, b) => a.localeCompare(b))) {
      const child = node.folders.get(name)!;
      const key = prefix ? `${prefix}/${name}` : name;
      rows.push({ kind: "group", group: name, depth, key, span: spanOf(descendantTasks(child)) });
      if (!collapsed.has(key)) walk(child, depth + 1, key);
    }
    // 直下タスクを並べる（nest 時は parent でツリー化）/ place direct tasks (a parent forest when nesting)
    if (!nest) {
      const list = node.tasks.slice().sort(taskCompare);
      for (const task of list) rows.push({ kind: "task", group: node.name, depth, task });
      return;
    }
    // ── 親子ネスト：同一フォルダ内のタスクを parent でフォレスト化 / nest by parent within this folder ──
    const paths = new Set(node.tasks.map((t) => t.path));
    const childrenOf = (p: string): Task[] =>
      node.tasks.filter((t) => t.parent === p).sort(taskCompare);
    // 自分＋子孫の集約（ロールアップ用）/ self + descendants span (for rollup)
    const subtree = (t: Task, seen: Set<string>): Task[] => {
      if (seen.has(t.path)) return [];
      seen.add(t.path);
      const out = [t];
      for (const c of childrenOf(t.path)) out.push(...subtree(c, seen));
      return out;
    };
    // ルート＝親が無い or 親が同フォルダに居ない（宙ぶらりん→トップレベル昇格）/ roots = no parent or parent not in this folder
    const roots = node.tasks.filter((t) => !t.parent || !paths.has(t.parent)).sort(taskCompare);
    // フォレストに属するタスク（折りたたみは無視して算出）/ tasks that belong to the forest (ignoring collapse)
    const reachable = new Set<string>();
    const mark = (p: string) => {
      if (reachable.has(p)) return;
      reachable.add(p);
      for (const c of childrenOf(p)) mark(c.path);
    };
    for (const r of roots) mark(r.path);

    const emitted = new Set<string>();
    const emit = (task: Task, d: number) => {
      if (emitted.has(task.path)) return; // 重複ガード / dup guard
      emitted.add(task.path);
      const kids = childrenOf(task.path);
      const has = kids.length > 0;
      const span = has ? spanOf(subtree(task, new Set())) : undefined;
      rows.push({ kind: "task", group: node.name, depth: d, task, key: has ? task.path : undefined, span, hasChildren: has });
      // 折りたたみ中は子を出さない / hide children while collapsed
      if (has && !collapsed.has(task.path)) for (const c of kids) emit(c, d + 1);
    };
    for (const r of roots) emit(r, depth);
    // フォレストに到達できない＝循環で孤立したタスクだけトップレベルで出す / surface only cycle-orphaned tasks
    for (const t of node.tasks.slice().sort(taskCompare)) if (!reachable.has(t.path)) emit(t, depth);
  };
  walk(root, 0, "");
  return rows;
}

// フロントマターの開始/終了を書き戻す / write back start/end into frontmatter
// `times` を渡すとその時刻で上書きする（undefined の辺は時刻を落とす）。省略時は
// 既存の時刻を引き継ぐ従来動作
// passing `times` overrides the time on each edge (an undefined edge clears its time);
// omitting it keeps the previous behaviour of carrying the existing times over
export async function writeDates(
  app: App,
  settings: GanttSettings,
  path: string,
  start: string,
  end: string,
  milestone: boolean,
  times?: { start?: string; end?: string },
  // estimate モードでは期限は締切であってバー終端ではないので触らない
  // in estimate mode the due date is a deadline, not the bar's end, so leave it alone
  opts?: { keepEnd?: boolean }
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  const k = settings.keys;
  const wtz = writeTz(settings.tz);
  await editFm(app, file, k.status, (fm: Record<string, unknown>) => {
    // 既存値に時刻が付いていたら表示時刻を新しい日付へ引き継ぐ（オフセットは設定タイムゾーンへ正規化）
    // carry the displayed time-of-day over to the new date (re-normalizing the offset to the configured tz)
    const ts = times ? times.start : parseStored(fm[k.start], settings.tz)?.time;
    const te = times ? times.end : parseStored(fm[k.end], settings.tz)?.time;
    if (milestone) {
      // マイルストーンは期限(end)のみ / milestone keeps only the due date
      fm[k.end] = combineDateTime(end, te, wtz);
      delete fm[k.start];
    } else {
      fm[k.start] = combineDateTime(start, ts, wtz);
      if (!opts?.keepEnd) fm[k.end] = combineDateTime(end, te, wtz);
    }
  });
}

// 任意のフロントマター値を書き戻す / write back an arbitrary frontmatter value
export async function writeField(
  app: App,
  path: string,
  key: string,
  value: unknown,
  statusKey = compatStatusKey
): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await editFm(app, file, statusKey, (fm: Record<string, unknown>) => {
    if (value == null || value === "") delete fm[key];
    else fm[key] = value;
  });
}

// 本文（フロントマターを除く）を取得 / read the body (without frontmatter)
export async function readBody(app: App, path: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return "";
  const text = await app.vault.read(file);
  // 先頭の --- ... --- を除去 / strip leading frontmatter block
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

// 本文を書き戻す（フロントマターは保持）/ write back the body (keeping frontmatter)
export async function writeBody(app: App, path: string, body: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  await app.vault.process(file, (text) => {
    const m = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
    const fm = m ? m[0].replace(/\n*$/, "\n") : "";
    const trimmed = body.replace(/\s+$/, "");
    return (fm ? fm + "\n" : "") + (trimmed ? trimmed + "\n" : "");
  });
}

// 新規タスク（空フロントマター .md）をフォルダ直下に作成。名前が衝突したら連番を付ける
// create a new task (.md with empty frontmatter) in the folder; de-duplicate the name with a counter
export async function createTask(app: App, folderPath: string, baseName: string): Promise<TFile | null> {
  const dir = normalizePath(folderPath || "/");
  const prefix = dir === "/" ? "" : dir + "/";
  let name = baseName;
  let i = 1;
  while (app.vault.getAbstractFileByPath(`${prefix}${name}.md`)) name = `${baseName} ${++i}`;
  // 開始/終了は呼び出し側（view）が今日で埋める / caller fills start/end
  const file = await app.vault.create(`${prefix}${name}.md`, "---\n---\n");
  return file instanceof TFile ? file : null;
}

// タスク（ファイル）をリネーム。リンクも更新される / rename the task file (updates links)
export async function renameTask(app: App, path: string, newName: string): Promise<string | null> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return null;
  const safe = newName.replace(/[\\/:*?"<>|]/g, "").trim();
  if (!safe) return null;
  const dir = file.parent && file.parent.path !== "/" ? file.parent.path + "/" : "";
  const newPath = `${dir}${safe}.md`;
  if (newPath === path) return path;
  await app.fileManager.renameFile(file, newPath);
  return newPath;
}

// タスクを削除（ユーザー設定のゴミ箱へ・OSゴミ箱 or .trash・復元可）/ delete a task to the user's trash (recoverable)
export async function deleteTask(app: App, path: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;
  await app.fileManager.trashFile(file);
  return true;
}

// Vault 内に存在する全タグ（# 抜き・使用数の多い順）。入力候補に使う。
// Obsidian の非公開 metadataCache.getTags() は使わず、公開 API の getAllTags で集計する。
// every tag present in the vault (without #, most-used first), for input suggestions;
// built with the public getAllTags rather than the undocumented metadataCache.getTags()
export function collectAllTags(app: App): string[] {
  const count = new Map<string, number>();
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    for (const raw of getAllTags(cache) ?? []) {
      const tag = raw.replace(/^#/, "");
      if (tag) count.set(tag, (count.get(tag) ?? 0) + 1);
    }
  }
  // よく使うタグを上に（同数は名前順）/ most-used first, ties broken by name
  return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
}

// タグを追加（フロントマター tags へ・重複排除）/ add a tag to frontmatter `tags` (deduped)
export async function addTag(app: App, path: string, tag: string): Promise<boolean> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return false;
  const clean = tag.replace(/^#/, "").trim();
  if (!clean) return false;
  let changed = false;
  await editFm(app, file, compatStatusKey, (fm: Record<string, unknown>) => {
    const cur = normalizeTags(fm.tags);
    if (!cur.includes(clean)) {
      cur.push(clean);
      fm.tags = cur;
      changed = true;
    }
  });
  return changed;
}

// タグを削除（フロントマター tags のみ・本文 #tag は対象外）/ remove a tag from frontmatter `tags` (inline #tags are not touched)
export async function removeTag(app: App, path: string, tag: string): Promise<void> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return;
  const clean = tag.replace(/^#/, "").trim();
  await editFm(app, file, compatStatusKey, (fm: Record<string, unknown>) => {
    const cur = normalizeTags(fm.tags).filter((x) => x !== clean);
    if (cur.length) fm.tags = cur;
    else delete fm.tags;
  });
}

// 指定タスクのサブツリー（自分＋子孫）のパス一覧 / paths of a task's subtree (self + descendants)
export function subtreePaths(tasks: Task[], rootPath: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (p: string) => {
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
    for (const c of tasks) if (c.parent === p) visit(c.path);
  };
  visit(rootPath);
  return out;
}

// タスクの親を設定/解除し、サブツリーごと destFolder へ移動する（D&D の本体）
// set/clear a task's parent and move its whole subtree into destFolder (the D&D core)
// 戻り値：移動履歴（from→to）と src の旧内容（Undo 用）/ returns moves and the src's old content (for undo)
export async function reparentTask(
  app: App,
  settings: GanttSettings,
  tasks: Task[],
  srcPath: string,
  destFolder: string,
  parentFile: TFile | null
): Promise<{ moves: { from: string; to: string }[]; oldContent: string } | null> {
  const src = app.vault.getAbstractFileByPath(srcPath);
  if (!(src instanceof TFile)) return null;
  const k = settings.keys;
  const oldContent = await app.vault.read(src); // 変更前スナップショット / pre-op snapshot
  // 親リンクを設定（または解除）/ set (or clear) the parent link
  const oldParent = tasks.find((t) => t.path === srcPath)?.parent;
  await editFm(app, src, k.status, (fm: Record<string, unknown>) => {
    const link = parentFile ? app.fileManager.generateMarkdownLink(parentFile, srcPath) : undefined;
    if (!compat) {
      if (link) fm[k.parent] = link;
      else delete fm[k.parent];
      return;
    }
    // 互換モード：projects リストの他の項目は残し、旧親だけ差し替える
    // compat: keep every other projects entry, swap out only the old parent
    const cur = fm[k.parent];
    const list: unknown[] = cur == null || cur === "" ? [] : Array.isArray(cur) ? [...(cur as unknown[])] : [cur];
    const kept = list.filter((raw) => {
      const p = resolveLink(app, String(raw), srcPath)?.path;
      return p !== oldParent && (!parentFile || p !== parentFile.path);
    });
    if (link) kept.unshift(link);
    if (kept.length) fm[k.parent] = kept;
    else delete fm[k.parent];
  });
  // TaskNotes はタスクを 1 フォルダで管理するのでファイルは動かさない / TaskNotes keeps tasks in one folder: don't move files
  if (compat) return { moves: [], oldContent };
  // サブツリー（自分＋子孫）は同一フォルダに同居しているので、全部 destFolder へ移す
  // the subtree co-locates in one folder, so move all of it into destFolder
  const dir = normalizePath(destFolder || "/");
  const prefix = dir === "/" ? "" : dir + "/";
  const moves: { from: string; to: string }[] = [];
  for (const p of subtreePaths(tasks, srcPath)) {
    const f = app.vault.getAbstractFileByPath(p);
    if (!(f instanceof TFile)) continue;
    if (normalizePath(f.parent?.path ?? "/") === dir) continue; // 既に dest / already there
    let name = f.basename;
    let i = 1;
    while (app.vault.getAbstractFileByPath(`${prefix}${name}.md`)) name = `${f.basename} ${++i}`;
    const np = `${prefix}${name}.md`;
    await app.fileManager.renameFile(f, np); // リンクは Obsidian が更新 / Obsidian updates links
    moves.push({ from: p, to: np });
  }
  return { moves, oldContent };
}

// 依存を追加（型付き）: successor.after に predecessor を足す。既存の同 pred は置き換える
// add a typed dependency; replaces any existing dependency to the same predecessor
export async function addDependency(
  app: App,
  settings: GanttSettings,
  successorPath: string,
  predPath: string,
  type: DepType
): Promise<boolean> {
  if (successorPath === predPath) return false;
  const succ = app.vault.getAbstractFileByPath(successorPath);
  const pred = app.vault.getAbstractFileByPath(predPath);
  if (!(succ instanceof TFile) || !(pred instanceof TFile)) return false;
  const k = settings.keys;
  await editFm(app, succ, k.status, (fm: Record<string, unknown>) => {
    const existing = fm[k.after];
    const arr: unknown[] = existing == null ? [] : Array.isArray(existing) ? existing : [existing];
    const pointsAtPred = (raw: unknown): boolean => {
      const dep = parseDepEntry(raw);
      return !!dep && resolveLink(app, dep.link, successorPath)?.path === predPath;
    };
    // 置き換え時は TaskNotes の gap を引き継ぐ / keep a TaskNotes gap when replacing
    const prev = arr.find(pointsAtPred) as { gap?: unknown } | undefined;
    const gap = prev && typeof prev === "object" && typeof prev.gap === "string" ? prev.gap : undefined;
    // 既存の同 pred を除去 / drop any existing entry to the same predecessor
    const kept = arr.filter((raw) => !pointsAtPred(raw));
    const link = app.fileManager.generateMarkdownLink(pred, successorPath);
    // 既存エントリがオブジェクト形式なら互換モード外でもそれに合わせる / match existing object entries even outside compat
    const asObject = compat || arr.some((x) => x != null && typeof x === "object");
    kept.push(makeDepEntry(link, type, asObject, gap));
    fm[k.after] = kept;
  });
  return true;
}

// 依存を削除: successor.after から predecessor を外す / remove a dependency
export async function removeDependency(
  app: App,
  settings: GanttSettings,
  successorPath: string,
  predPath: string
): Promise<void> {
  const succ = app.vault.getAbstractFileByPath(successorPath);
  if (!(succ instanceof TFile)) return;
  const k = settings.keys;
  await editFm(app, succ, k.status, (fm: Record<string, unknown>) => {
    const existing = fm[k.after];
    if (existing == null) return;
    const list: unknown[] = Array.isArray(existing) ? existing : [existing];
    const filtered = list.filter((raw) => {
      const dep = parseDepEntry(raw);
      return !dep || resolveLink(app, dep.link, successorPath)?.path !== predPath;
    });
    if (filtered.length) fm[k.after] = filtered;
    else delete fm[k.after];
  });
}
