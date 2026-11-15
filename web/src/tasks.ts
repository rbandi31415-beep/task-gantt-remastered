// Task notes ⇄ Gantt rows, without a DOM. Edits keep every untouched frontmatter key, its order
// and formatting, and follow the same TaskNotes rules as the Obsidian plugin (shared code).
import { parseDocument, Document } from "yaml";
import { parseDepEntry, makeDepEntry, applyTaskNotesTouch, parseStored, configureCompat, makeTaskCompare } from "../../src/model";
import type { DepType, StatusDef } from "../../src/types";
import { CONFLICT_DIR } from "../../src/share/core";

export const STATUSES: StatusDef[] = [
  { id: "none", label: "None", color: "#9aa0a6", group: "active" },
  { id: "open", label: "Open", color: "#60a5fa", group: "active" },
  { id: "in-progress", label: "In progress", color: "#3b82f6", group: "active" },
  { id: "done", label: "Done", color: "#22c55e", group: "completed" },
];
configureCompat(true, STATUSES, "status");

// bars run startDate → due; TaskNotes' scheduled is a calendar slot and is only displayed
export const KEYS = { start: "startDate", scheduled: "scheduled", end: "due", status: "status", parent: "projects", after: "blockedBy", milestone: "milestone" };

export interface RemoteFile {
  rel: string;
  sha: string;
  text: string;
}

export interface WebTask {
  rel: string;
  sha: string;
  name: string;
  status?: string;
  start?: string; // YYYY-MM-DD
  startTime?: string;
  end?: string;
  endTime?: string;
  scheduled?: string; // TaskNotes calendar slot, shown but not used for the bar
  milestone: boolean;
  dueOnly: boolean; // only a due date (drawn on its due date, like the plugin)
  parent?: string; // rel of parent task
  deps: { rel: string; type: DepType }[];
  body: string;
  fm: Record<string, unknown>;
}

// ── frontmatter split / join ──
export function splitNote(text: string): { yaml: string; body: string } {
  const t = text.replace(/^﻿/, "");
  const m = t.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  if (!m) return { yaml: "", body: t };
  return { yaml: m[1], body: t.slice(m[0].length) };
}
export function joinNote(doc: Document, body: string): string {
  const y = doc.toString({ lineWidth: 0 }).replace(/\n+$/, "");
  return `---\n${y}\n---\n${body}`;
}

const basename = (rel: string) => rel.split("/").pop()!.replace(/\.md$/i, "");

// resolve "[[Name]]", "[[Name|alias]]", "[[folder/Name#h]]", "[x](Name.md)" to a rel path
export function makeResolver(rels: string[]): (link: string) => string | undefined {
  const byName = new Map<string, string>();
  const byPath = new Map<string, string>();
  for (const r of rels) {
    byPath.set(r.replace(/\.md$/i, "").toLowerCase(), r);
    if (!byName.has(basename(r).toLowerCase())) byName.set(basename(r).toLowerCase(), r);
  }
  return (link: string) => {
    let inner = String(link).trim();
    const md = inner.match(/\]\(([^)]+)\)/);
    if (md) inner = decodeURIComponent(md[1]);
    else inner = inner.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
    inner = inner.split("#")[0].trim().replace(/\.md$/i, "").toLowerCase();
    if (!inner) return undefined;
    return byPath.get(inner) ?? byName.get(inner.split("/").pop()!);
  };
}

export function parseTasks(all: RemoteFile[]): WebTask[] {
  // sync conflict copies live in their own folder and are never tasks
  const files = all.filter((f) => !f.rel.startsWith(`${CONFLICT_DIR}/`) && !/^syncConflict:\s*true\s*$/m.test(splitNote(f.text).yaml));
  const resolve = makeResolver(files.map((f) => f.rel));
  const tasks = files.map((f): WebTask => {
    const { yaml, body } = splitNote(f.text);
    let fm: Record<string, unknown> = {};
    try {
      fm = (parseDocument(yaml).toJS() as Record<string, unknown>) ?? {};
    } catch {
      fm = {};
    }
    const ps = parseStored(fm[KEYS.start], "system");
    const pe = parseStored(fm[KEYS.end], "system");
    const milestone = fm[KEYS.milestone] === true;
    let start = ps?.date;
    let startTime = ps?.time;
    let end = pe?.date;
    const dueOnly = !!end && !start && !milestone;
    // due-only tasks and milestones sit on their due date
    if ((dueOnly || milestone) && end && !start) {
      start = end;
      startTime = pe?.time;
    }
    if (start && !end) end = start;
    return {
      rel: f.rel, sha: f.sha, name: basename(f.rel),
      status: fm[KEYS.status] != null ? String(fm[KEYS.status]) : undefined,
      start, startTime, end, endTime: pe?.time, milestone, dueOnly,
      scheduled: fm[KEYS.scheduled] != null && fm[KEYS.scheduled] !== "" ? String(fm[KEYS.scheduled]) : undefined,
      deps: [], body, fm,
    };
  });
  for (const t of tasks) {
    const pv = t.fm[KEYS.parent];
    for (const raw of pv == null ? [] : Array.isArray(pv) ? pv : [pv]) {
      const r = resolve(String(raw));
      if (r && r !== t.rel) { t.parent = r; break; }
    }
    const av = t.fm[KEYS.after];
    for (const raw of av == null ? [] : Array.isArray(av) ? av : [av]) {
      const d = parseDepEntry(raw);
      const r = d && resolve(d.link);
      if (d && r && r !== t.rel && !t.deps.some((x) => x.rel === r)) t.deps.push({ rel: r, type: d.type });
    }
  }
  return tasks;
}

// ── rows (parent forest, sorted by start then name) ──
export interface WebRow {
  task: WebTask;
  depth: number;
  hasChildren: boolean;
  span?: { start: string; end: string };
}

export type SortState = { by: string; dir: "asc" | "desc" };
export const DEFAULT_SORT: SortState = { by: "start", dir: "asc" };

export function buildWebRows(tasks: WebTask[], collapsed: Set<string>, hideDone: boolean, sort: SortState = DEFAULT_SORT): WebRow[] {
  const byRel = new Map(tasks.map((t) => [t.rel, t]));
  const kids = new Map<string, WebTask[]>();
  for (const t of tasks) if (t.parent && byRel.has(t.parent)) (kids.get(t.parent) ?? kids.set(t.parent, []).get(t.parent)!).push(t);
  // same comparator as the Obsidian plugin, so both list tasks in the same order
  const cmp = makeTaskCompare(sort.by, sort.dir, STATUSES) as (a: WebTask, b: WebTask) => number;
  const isDone = (t: WebTask) => STATUSES.find((s) => s.id === t.status)?.group === "completed";
  const subtree = (t: WebTask, seen = new Set<string>()): WebTask[] => {
    if (seen.has(t.rel)) return [];
    seen.add(t.rel);
    return [t, ...(kids.get(t.rel) ?? []).flatMap((c) => subtree(c, seen))];
  };
  const visibleUnder = (t: WebTask): boolean => !hideDone || subtree(t).some((x) => !isDone(x));
  const rows: WebRow[] = [];
  const emitted = new Set<string>();
  const emit = (t: WebTask, depth: number) => {
    if (emitted.has(t.rel) || !visibleUnder(t)) return;
    emitted.add(t.rel);
    const children = (kids.get(t.rel) ?? []).sort(cmp);
    const dated = subtree(t).filter((x) => x.start && x.end);
    const span = children.length && dated.length
      ? { start: dated.map((x) => x.start!).sort()[0], end: dated.map((x) => x.end!).sort().at(-1)! }
      : undefined;
    rows.push({ task: t, depth, hasChildren: children.length > 0, span });
    if (!collapsed.has(t.rel)) for (const c of children) emit(c, depth + 1);
  };
  for (const t of tasks.filter((t) => !t.parent || !byRel.has(t.parent)).sort(cmp)) emit(t, 0);
  for (const t of tasks.sort(cmp)) if (!emitted.has(t.rel) && !collapsed.has(t.parent ?? "")) emit(t, 0); // cycles
  return rows;
}

// ── edits ──
// Apply fn to a plain copy of the frontmatter, then write back only the keys that changed, so the
// note keeps its key order and formatting. TaskNotes bookkeeping (dateModified, completedDate) applies.
export function editNote(text: string, fn: (fm: Record<string, unknown>) => void, body?: string): string {
  const { yaml, body: oldBody } = splitNote(text);
  const doc = parseDocument(yaml);
  const before = (doc.toJS() as Record<string, unknown>) ?? {};
  const fm = structuredClone(before);
  const prevStatus = fm[KEYS.status];
  fn(fm);
  applyTaskNotesTouch(fm, KEYS.status, prevStatus, STATUSES);
  for (const k of Object.keys(before)) if (!(k in fm)) doc.delete(k);
  for (const [k, v] of Object.entries(fm)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(v)) doc.set(k, doc.createNode(v));
  }
  return joinNote(doc, body ?? oldBody);
}

const wiki = (rel: string) => `[[${basename(rel)}]]`;

// keep the stored time-of-day when only the date changes
export function withDate(stored: unknown, date: string | undefined): string | undefined {
  if (!date) return undefined;
  const t = parseStored(stored, "system")?.time;
  return t ? `${date}T${t}` : date;
}

export function setDates(fm: Record<string, unknown>, task: WebTask, start: string | undefined, end: string | undefined): void {
  if (task.dueOnly || task.milestone) {
    // a due-only task / milestone moves its due date and stays due-only
    if (end) fm[KEYS.end] = withDate(fm[KEYS.end], end);
    return;
  }
  const s = withDate(fm[KEYS.start], start);
  if (s) fm[KEYS.start] = s;
  else delete fm[KEYS.start];
  // a one-day task without a due date stays without one; otherwise the due date follows
  if (end && (fm[KEYS.end] !== undefined || end !== start)) fm[KEYS.end] = withDate(fm[KEYS.end], end);
  else if (!end) delete fm[KEYS.end];
}

export function setParent(fm: Record<string, unknown>, task: WebTask, newParent: string | undefined, resolve: (l: string) => string | undefined): void {
  const cur = fm[KEYS.parent];
  const list: unknown[] = cur == null || cur === "" ? [] : Array.isArray(cur) ? [...cur] : [cur];
  const kept = list.filter((raw) => {
    const r = resolve(String(raw));
    return r !== task.parent && r !== newParent;
  });
  if (newParent) kept.unshift(wiki(newParent));
  if (kept.length) fm[KEYS.parent] = kept; else delete fm[KEYS.parent];
}

export function setDeps(fm: Record<string, unknown>, deps: { rel: string; type: DepType }[], resolve: (l: string) => string | undefined): void {
  const cur = fm[KEYS.after];
  const list: unknown[] = cur == null ? [] : Array.isArray(cur) ? cur : [cur];
  const wanted = new Map(deps.map((d) => [d.rel, d.type]));
  const out: unknown[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const d = parseDepEntry(raw);
    const r = d ? resolve(d.link) : undefined;
    if (!d || !r) { out.push(raw); continue; } // keep entries we can't resolve untouched
    if (!wanted.has(r) || seen.has(r)) continue;
    seen.add(r);
    const type = wanted.get(r)!;
    if (type === d.type) out.push(raw);
    else {
      const gap = typeof raw === "object" && raw && typeof (raw as { gap?: unknown }).gap === "string" ? (raw as { gap: string }).gap : undefined;
      out.push(makeDepEntry(d.link, type, true, gap));
    }
  }
  for (const [r, type] of wanted) if (!seen.has(r)) out.push(makeDepEntry(wiki(r), type, true));
  if (out.length) fm[KEYS.after] = out; else delete fm[KEYS.after];
}

const pad = (n: number) => String(n).padStart(2, "0");
export const today = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function newNote(parentRel: string | undefined, start: string, now = new Date()): string {
  const doc = new Document({});
  const off = -now.getTimezoneOffset();
  const iso = `${today(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${String(now.getMilliseconds()).padStart(3, "0")}${off < 0 ? "-" : "+"}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
  doc.set("status", "open");
  doc.set("priority", "normal");
  doc.set(KEYS.start, start);
  doc.set("tags", doc.createNode(["task"]));
  if (parentRel) doc.set("projects", doc.createNode([wiki(parentRel)]));
  doc.set("dateCreated", iso);
  doc.set("dateModified", iso);
  return joinNote(doc, "\n");
}

// a task file name that's safe on Windows/macOS and in the repo
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "");
}
