// TaskNotes 互換の検証（偽 Vault 上で collectTasks / 依存 / 親付け替え / 書き込みを通す）
// TaskNotes compatibility tests: collectTasks, dependencies, re-parenting and writes on a fake vault
import { TFile, TFolder } from "./obsidian-stub.mjs";
import {
  configureCompat, parseDepEntry, makeDepEntry, combineDateTime, writeTz, applyTaskNotesTouch,
  collectTasks, addDependency, removeDependency, reparentTask, writeField, writeDates, inScope,
} from "./model.mjs";

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) { pass++; console.log("  ok  -", name); }
  else { fail++; console.error("FAIL  -", name); }
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const statuses = [
  { id: "open", label: "Open", color: "", group: "active" },
  { id: "in-progress", label: "In progress", color: "", group: "active" },
  { id: "done", label: "Done", color: "", group: "completed" },
];

// ── 偽 Vault / fake vault ──
function makeApp(files) {
  const root = Object.assign(new TFolder(), { path: "/", children: [] });
  const byPath = new Map();
  const folders = new Map([["/", root]]);
  const folderFor = (dir) => {
    if (folders.has(dir)) return folders.get(dir);
    const parentDir = dir.includes("/") ? dir.slice(0, dir.lastIndexOf("/")) : "/";
    const parent = folderFor(parentDir);
    const f = Object.assign(new TFolder(), { path: dir, children: [], parent });
    parent.children.push(f);
    folders.set(dir, f);
    return f;
  };
  const add = (path, fm) => {
    const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "/";
    const parent = folderFor(dir);
    const name = path.split("/").pop();
    const f = Object.assign(new TFile(), { path, extension: "md", basename: name.replace(/\.md$/, ""), parent, fm });
    parent.children.push(f);
    byPath.set(path, f);
  };
  for (const [p, fm] of Object.entries(files)) add(p, structuredClone(fm));
  const moved = [];
  const app = {
    vault: {
      getRoot: () => root,
      getAbstractFileByPath: (p) => byPath.get(p) ?? folders.get(p) ?? null,
      read: async (f) => JSON.stringify(f.fm),
    },
    metadataCache: {
      getFileCache: (f) => ({ frontmatter: f.fm }),
      getFirstLinkpathDest: (link) => [...byPath.values()].find((f) => f.basename === link || f.path === link) ?? null,
    },
    fileManager: {
      processFrontMatter: async (f, fn) => fn(f.fm),
      generateMarkdownLink: (f) => `[[${f.basename}]]`,
      renameFile: async (f, np) => moved.push([f.path, np]),
    },
  };
  return { app, fm: (p) => byPath.get(p).fm, moved };
}

const settings = {
  recurse: true,
  tz: "system",
  keys: {
    start: "scheduled", end: "due", status: "status", assignee: "assignee", after: "blockedBy",
    progress: "progress", milestone: "milestone", parent: "projects", estimate: "timeEstimate",
    gcalId: "gcalId", gcal: "gcal",
  },
};

// ── 純関数 / pure helpers ──
check("inScope: inside folder", inScope("TaskNotes/Tasks/Dermaglow", "TaskNotes/Tasks/Dermaglow/CAD.md"));
check("inScope: sibling with same prefix is out", !inScope("TaskNotes/Tasks/Dermaglow", "TaskNotes/Tasks/Dermaglow Personal/x.md"));
check("inScope: parent folder note is out", !inScope("TaskNotes/Tasks/Dermaglow", "TaskNotes/Tasks/Journal.md"));
check("inScope: vault root sees everything", inScope("", "a/b.md") && inScope("/", "x.md"));
check("parseDepEntry: TaskNotes object", same(parseDepEntry({ uid: "[[A]]", reltype: "FINISHTOSTART" }), { type: "FS", link: "[[A]]" }));
check("parseDepEntry: STARTTOSTART -> SS", parseDepEntry({ uid: "[[A]]", reltype: "starttostart" }).type === "SS");
check("parseDepEntry: STARTTOFINISH falls back to FS", parseDepEntry({ uid: "[[A]]", reltype: "STARTTOFINISH" }).type === "FS");
check("parseDepEntry: object without uid is null", parseDepEntry({ reltype: "FINISHTOSTART" }) === null);
check("parseDepEntry: prefixed string", same(parseDepEntry("FF: [[B]]"), { type: "FF", link: "[[B]]" }));
check("parseDepEntry: plain string", same(parseDepEntry("[[B]]"), { type: "FS", link: "[[B]]" }));
check("makeDepEntry: object form keeps gap", same(makeDepEntry("[[A]]", "SS", true, "1d"), { uid: "[[A]]", reltype: "STARTTOSTART", gap: "1d" }));
check("makeDepEntry: string form", makeDepEntry("[[A]]", "FF", false) === "FF:[[A]]");
check("combineDateTime: floating has no offset", combineDateTime("2026-11-13", "14:00", "floating") === "2026-11-13T14:00");
configureCompat(false, statuses);
check("writeTz: off passes tz through", writeTz("+09:00") === "+09:00");
configureCompat(true, statuses);
check("writeTz: compat is floating", writeTz("+09:00") === "floating");

const now = new Date(2026, 10, 14, 9, 5, 7, 42);
let fm = { status: "done" };
applyTaskNotesTouch(fm, "status", "open", statuses, now);
check("touch: completing sets completedDate", fm.completedDate === "2026-11-14");
check("touch: sets dateModified with offset", /^2026-11-14T09:05:07\.042[+-]\d{2}:\d{2}$/.test(fm.dateModified));
fm = { status: "open", completedDate: "2026-11-01" };
applyTaskNotesTouch(fm, "status", "done", statuses, now);
check("touch: reopening clears completedDate", !("completedDate" in fm));
fm = { status: "done", completedDate: "2026-11-01" };
applyTaskNotesTouch(fm, "status", "done", statuses, now);
check("touch: unchanged status keeps completedDate", fm.completedDate === "2026-11-01");
fm = { status: "done", recurrence: "FREQ=DAILY" };
applyTaskNotesTouch(fm, "status", "open", statuses, now);
check("touch: recurring task gets no completedDate", !("completedDate" in fm));

// ── collectTasks（実際の TaskNotes ノート形）/ collectTasks on real TaskNotes-shaped notes ──
const vaultFiles = {
  "Tasks/Startup Management.md": { status: "in-progress", scheduled: "2026-10-03", tags: ["task"] },
  "Tasks/Draft model.md": { status: "done", scheduled: "2026-11-10T16:00", timeEstimate: 120, projects: ["[[Startup Management]]"] },
  "Tasks/Prelim BOM.md": {
    status: "in-progress", scheduled: "2026-11-13T22:00",
    projects: ["[[Some reference note]]", "[[Startup Management]]"],
    blockedBy: [{ uid: "[[Draft model]]", reltype: "FINISHTOSTART" }, { uid: "[[Missing task]]", reltype: "FINISHTOSTART" }],
  },
  "Tasks/CAD v1.md": {
    status: "open", due: "2026-11-20",
    projects: ["[[Startup Management]]"],
    blockedBy: [{ uid: "[[Prelim BOM]]", reltype: "STARTTOSTART" }, "FF:[[Draft model]]"],
  },
  "Tasks/Demo day.md": { status: "open", due: "2026-12-01", milestone: true },
  "Some reference note.md": { tags: ["note"] },
};

let v = makeApp(vaultFiles);
let tasks = collectTasks(v.app, settings, "Tasks");
const T = (n) => tasks.find((t) => t.name === n);
check("collect: only files in scope", tasks.length === 5);
check("collect: object blockedBy resolves", same(T("Prelim BOM").deps, [{ path: "Tasks/Draft model.md", type: "FS" }]));
check("collect: unresolvable dependency dropped", T("Prelim BOM").deps.length === 1);
check("collect: mixed object/string deps", same(T("CAD v1").deps.map((d) => d.type), ["SS", "FF"]));
check("collect: parent skips non-task project link", T("Prelim BOM").parent === "Tasks/Startup Management.md");
check("collect: due-only task is not a milestone", T("CAD v1").milestone === false);
check("collect: due-only task sits on its due date", T("CAD v1").start === "2026-11-20" && T("CAD v1").end === "2026-11-20");
check("collect: explicit milestone stays a milestone", T("Demo day").milestone === true);
check("collect: naive time kept", T("Draft model").startTime === "16:00");

configureCompat(false, statuses);
tasks = collectTasks(v.app, settings, "Tasks");
check("collect (compat off): due-only is a milestone (legacy)", T("CAD v1").milestone === true);
check("collect (compat off): object deps still read", T("Prelim BOM").deps.length === 1);
configureCompat(true, statuses);

// ── 依存の追加・削除 / adding and removing dependencies ──
v = makeApp(vaultFiles);
await addDependency(v.app, settings, "Tasks/CAD v1.md", "Tasks/Draft model.md", "FS");
let bb = v.fm("Tasks/CAD v1.md").blockedBy;
check("addDependency: replaces entry to the same predecessor", bb.length === 2);
check("addDependency: writes TaskNotes object", same(bb[1], { uid: "[[Draft model]]", reltype: "FINISHTOSTART" }));
check("addDependency: keeps the other entry untouched", same(bb[0], { uid: "[[Prelim BOM]]", reltype: "STARTTOSTART" }));
check("addDependency: bumps dateModified", typeof v.fm("Tasks/CAD v1.md").dateModified === "string");
v.fm("Tasks/Prelim BOM.md").blockedBy[0].gap = "2d";
await addDependency(v.app, settings, "Tasks/Prelim BOM.md", "Tasks/Draft model.md", "SS");
check("addDependency: keeps gap when changing type", same(v.fm("Tasks/Prelim BOM.md").blockedBy.at(-1), { uid: "[[Draft model]]", reltype: "STARTTOSTART", gap: "2d" }));
await removeDependency(v.app, settings, "Tasks/CAD v1.md", "Tasks/Prelim BOM.md");
check("removeDependency: removes object entry", same(v.fm("Tasks/CAD v1.md").blockedBy, [{ uid: "[[Draft model]]", reltype: "FINISHTOSTART" }]));
await removeDependency(v.app, settings, "Tasks/CAD v1.md", "Tasks/Draft model.md");
check("removeDependency: last entry deletes the key", !("blockedBy" in v.fm("Tasks/CAD v1.md")));

// ── 親の付け替え / re-parenting ──
v = makeApp(vaultFiles);
tasks = collectTasks(v.app, settings, "Tasks");
let res = await reparentTask(v.app, settings, tasks, "Tasks/Prelim BOM.md", "Tasks", v.app.vault.getAbstractFileByPath("Tasks/Draft model.md"));
check("reparent: other projects kept, new parent first", same(v.fm("Tasks/Prelim BOM.md").projects, ["[[Draft model]]", "[[Some reference note]]"]));
check("reparent: no files moved in compat", res.moves.length === 0 && v.moved.length === 0);
tasks = collectTasks(v.app, settings, "Tasks");
await reparentTask(v.app, settings, tasks, "Tasks/Prelim BOM.md", "", null);
check("reparent: clearing parent keeps other projects", same(v.fm("Tasks/Prelim BOM.md").projects, ["[[Some reference note]]"]));
tasks = collectTasks(v.app, settings, "Tasks");
await reparentTask(v.app, settings, tasks, "Tasks/Draft model.md", "", null);
check("reparent: clearing only project deletes the key", !("projects" in v.fm("Tasks/Draft model.md")));

// ── 書き込み / writes ──
v = makeApp(vaultFiles);
await writeField(v.app, "Tasks/Prelim BOM.md", "status", "done");
check("writeField: completing via status sets completedDate", typeof v.fm("Tasks/Prelim BOM.md").completedDate === "string");
await writeDates(v.app, settings, "Tasks/Prelim BOM.md", "2026-11-15", "2026-11-16", false);
check("writeDates: keeps time, no offset", v.fm("Tasks/Prelim BOM.md").scheduled === "2026-11-15T22:00");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
