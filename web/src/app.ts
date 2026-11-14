// Web Gantt for the shared task folder. Talks only to /api (the Pages Function).
import {
  STATUSES, KEYS, RemoteFile, WebTask, WebRow, parseTasks, buildWebRows, editNote, setDates, setParent, setDeps,
  makeResolver, newNote, safeName, today,
} from "./tasks";
import type { DepType } from "../../src/types";

type Zoom = "day" | "week" | "month";
const PX: Record<Zoom, number> = { day: 34, week: 12, month: 4 };
const ROW = 34;
const HEAD = 44;
const DAY = 86_400_000;

const state = {
  files: [] as RemoteFile[],
  tasks: [] as WebTask[],
  rows: [] as WebRow[],
  zoom: (localStorage.getItem("zoom") as Zoom) || "day",
  hideDone: localStorage.getItem("hideDone") === "1",
  collapsed: new Set<string>(JSON.parse(localStorage.getItem("collapsed") || "[]") as string[]),
  selected: null as string | null,
  email: "",
  busy: false,
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, text?: string) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== undefined) e.textContent = text;
  return e;
};
const svg = (tag: string, attrs: Record<string, string | number>) => {
  const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  return e;
};
const dayNum = (iso: string) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY);
const isoOf = (n: number) => new Date(n * DAY).toISOString().slice(0, 10);
const statusOf = (id?: string) => STATUSES.find((s) => s.id === id) ?? STATUSES[0];

function toast(msg: string, bad = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = bad ? "show bad" : "show";
  window.clearTimeout((toast as unknown as { h?: number }).h);
  (toast as unknown as { h?: number }).h = window.setTimeout(() => (t.className = ""), 4000);
}

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

async function load(quiet = false) {
  try {
    const { files } = (await api("GET", "tasks")) as { files: RemoteFile[] };
    state.files = files;
    state.tasks = parseTasks(files);
    render();
    if (!quiet) $("#updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  } catch (e) {
    toast(`Couldn't load tasks: ${(e as Error).message}`, true);
  }
}

async function save(task: WebTask, fn: (fm: Record<string, unknown>) => void, body?: string) {
  if (state.busy) return;
  state.busy = true;
  try {
    const file = state.files.find((f) => f.rel === task.rel)!;
    const text = editNote(file.text, fn, body);
    if (text === file.text) return;
    const { sha } = (await api("PUT", `tasks?rel=${encodeURIComponent(task.rel)}`, { text, sha: file.sha })) as { sha: string };
    file.text = text;
    file.sha = sha;
    state.tasks = parseTasks(state.files);
    render();
    toast("Saved");
  } catch (e) {
    toast((e as Error).message, true);
    if ((e as { status?: number }).status === 409) await load(true);
  } finally {
    state.busy = false;
  }
}

// ── rendering ──
function range(rows: WebRow[]): { from: number; to: number } {
  const days = rows.flatMap((r) => [r.task.start, r.task.end, r.span?.start, r.span?.end]).filter(Boolean).map((d) => dayNum(d!));
  const t = dayNum(today());
  const from = Math.min(t, ...days) - 7;
  const to = Math.max(t, ...days) + 21;
  return { from, to };
}

function render() {
  state.rows = buildWebRows(state.tasks, state.collapsed, state.hideDone);
  const { from, to } = range(state.rows);
  const px = PX[state.zoom];
  const width = (to - from + 1) * px;
  const height = HEAD + state.rows.length * ROW;
  const x = (iso: string) => (dayNum(iso) - from) * px;

  // left table
  const table = $("#table");
  table.replaceChildren();
  const head = el("div", { class: "row head" });
  head.append(el("span", { class: "c-name" }, "Task"), el("span", { class: "c-status" }, "Status"), el("span", { class: "c-date" }, "Start"), el("span", { class: "c-date" }, "Due"));
  table.append(head);
  for (const r of state.rows) {
    const t = r.task;
    const row = el("div", { class: `row${state.selected === t.rel ? " sel" : ""}`, "data-rel": t.rel });
    const name = el("span", { class: "c-name" });
    name.style.paddingLeft = `${8 + r.depth * 16}px`;
    if (r.hasChildren) {
      const tog = el("button", { class: "tog", "aria-label": "Expand or collapse" }, state.collapsed.has(t.rel) ? "▸" : "▾");
      tog.onclick = (ev) => {
        ev.stopPropagation();
        state.collapsed.has(t.rel) ? state.collapsed.delete(t.rel) : state.collapsed.add(t.rel);
        localStorage.setItem("collapsed", JSON.stringify([...state.collapsed]));
        render();
      };
      name.append(tog);
    } else name.append(el("span", { class: "tog-sp" }));
    name.append(el("span", { class: "nm", title: t.name }, t.name));
    const st = statusOf(t.status);
    const pill = el("span", { class: "pill" }, st.label);
    pill.style.setProperty("--c", st.color);
    const sc = el("span", { class: "c-status" });
    sc.append(pill);
    row.append(name, sc, el("span", { class: "c-date" }, t.dueOnly ? "" : t.start ?? ""), el("span", { class: "c-date" }, t.fm[KEYS.end] ? t.end ?? "" : ""));
    row.onclick = () => select(t.rel);
    table.append(row);
  }

  // right timeline
  const s = svg("svg", { width, height, class: "chart" });
  const defs = svg("defs", {});
  const mk = svg("marker", { id: "ah", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
  mk.append(svg("path", { d: "M1 1L9 5L1 9z", class: "ah" }));
  defs.append(mk);
  s.append(defs);
  // grid + header labels
  for (let d = from; d <= to; d++) {
    const iso = isoOf(d);
    const date = new Date(d * DAY);
    const dow = date.getUTCDay();
    const gx = (d - from) * px;
    if (state.zoom === "day" && (dow === 0 || dow === 6)) s.append(svg("rect", { x: gx, y: HEAD, width: px, height: height - HEAD, class: "wknd" }));
    const major = state.zoom === "day" ? date.getUTCDate() === 1 || d === from : state.zoom === "week" ? date.getUTCDate() === 1 : date.getUTCMonth() % 3 === 0 && date.getUTCDate() === 1;
    const minor = state.zoom === "day" ? true : state.zoom === "week" ? dow === 1 : date.getUTCDate() === 1;
    if (minor) s.append(svg("line", { x1: gx, y1: HEAD - 16, x2: gx, y2: height, class: "grid" }));
    if (minor) {
      const lbl = svg("text", { x: gx + 3, y: HEAD - 5, class: "tick" });
      lbl.textContent = state.zoom === "month" ? date.toLocaleString([], { month: "short", timeZone: "UTC" }) : String(date.getUTCDate());
      s.append(lbl);
    }
    if (major || d === from) {
      const m = svg("text", { x: gx + 3, y: 15, class: "month" });
      m.textContent = date.toLocaleString([], { month: "long", year: "numeric", timeZone: "UTC" });
      s.append(m);
    }
    void iso;
  }
  const tx = x(today());
  s.append(svg("line", { x1: tx + px / 2, y1: HEAD - 16, x2: tx + px / 2, y2: height, class: "today" }));

  // bars
  const pos = new Map<string, { x1: number; x2: number; y: number }>();
  state.rows.forEach((r, i) => {
    const t = r.task;
    const y = HEAD + i * ROW;
    if (state.selected === t.rel) s.append(svg("rect", { x: 0, y, width, height: ROW, class: "selrow" }));
    if (r.span && r.hasChildren) {
      const sx = x(r.span.start);
      const sw = x(r.span.end) - sx + px;
      s.append(svg("rect", { x: sx, y: y + ROW - 9, width: sw, height: 4, rx: 2, class: "span" }));
    }
    if (!t.start || !t.end) return;
    const x1 = x(t.start);
    const x2 = x(t.end) + px;
    const color = statusOf(t.status).color;
    const g = svg("g", { class: "bar", "data-rel": t.rel }) as SVGGElement;
    if (t.milestone) {
      const cx = x1 + px / 2;
      const cy = y + ROW / 2;
      g.append(svg("path", { d: `M${cx} ${cy - 8}L${cx + 8} ${cy}L${cx} ${cy + 8}L${cx - 8} ${cy}z`, fill: color }));
      pos.set(t.rel, { x1: cx, x2: cx, y: cy });
    } else {
      g.append(svg("rect", { x: x1 + 1, y: y + 8, width: Math.max(4, x2 - x1 - 2), height: ROW - 16, rx: 4, fill: color }));
      pos.set(t.rel, { x1: x1 + 1, x2: x2 - 1, y: y + ROW / 2 });
      // label inside the bar when it fits, otherwise just after it
      const fits = t.name.length * 7 + 14 <= x2 - x1;
      if (state.zoom !== "month" || fits) {
        const lab = svg("text", { x: fits ? x1 + 7 : x2 + 6, y: y + ROW / 2 + 4, class: fits ? "barlbl" : "barlbl out" });
        lab.textContent = t.name;
        g.append(lab);
      }
    }
    g.addEventListener("pointerdown", (ev) => startDrag(ev as PointerEvent, t, g));
    s.append(g);
  });

  // dependency arrows
  for (const r of state.rows) {
    const to = pos.get(r.task.rel);
    if (!to) continue;
    for (const d of r.task.deps) {
      const fromP = pos.get(d.rel);
      if (!fromP) continue;
      const sx = d.type === "SS" ? fromP.x1 : fromP.x2;
      const ex = d.type === "FF" ? to.x2 : to.x1;
      const back = d.type === "FF" ? 10 : -10;
      const mid = d.type === "FF" ? Math.max(sx, ex) + 10 : Math.min(sx + 10, ex - 10);
      const path =
        d.type === "FF" || mid > sx
          ? `M${sx} ${fromP.y}H${mid}V${to.y}H${ex + (d.type === "FF" ? 0 : -1)}`
          : `M${sx} ${fromP.y}h10V${(fromP.y + to.y) / 2}H${ex + back}V${to.y}H${ex - 1}`;
      s.append(svg("path", { d: path, class: "dep", "marker-end": "url(#ah)" }));
    }
  }
  $("#chart").replaceChildren(s);
  renderPanel();
}

// ── dragging a bar moves the task (dates snap to days) ──
function startDrag(ev: PointerEvent, t: WebTask, g: SVGGElement) {
  if (ev.button !== 0) return;
  ev.preventDefault();
  const startX = ev.clientX;
  const px = PX[state.zoom];
  let moved = 0;
  g.setPointerCapture(ev.pointerId);
  const move = (e: PointerEvent) => {
    moved = Math.round((e.clientX - startX) / px);
    g.setAttribute("transform", `translate(${moved * px},0)`);
  };
  const up = () => {
    g.removeEventListener("pointermove", move);
    g.removeEventListener("pointerup", up);
    if (!moved) return select(t.rel);
    const ns = t.start ? isoOf(dayNum(t.start) + moved) : undefined;
    const ne = t.end ? isoOf(dayNum(t.end) + moved) : undefined;
    void save(t, (fm) => setDates(fm, t, ns, ne));
  };
  g.addEventListener("pointermove", move);
  g.addEventListener("pointerup", up);
}

// ── side panel ──
function select(rel: string | null) {
  state.selected = rel;
  render();
}

function renderPanel() {
  const panel = $("#panel");
  const t = state.tasks.find((x) => x.rel === state.selected);
  panel.classList.toggle("open", !!t);
  if (!t) return panel.replaceChildren();
  const resolve = makeResolver(state.tasks.map((x) => x.rel));
  const f = el("form");
  const head = el("div", { class: "ph" });
  const close = el("button", { type: "button", class: "x", "aria-label": "Close" }, "×");
  close.onclick = () => select(null);
  head.append(el("h2", {}, t.name), close);
  f.append(head);

  const field = (label: string, input: HTMLElement) => {
    const l = el("label");
    l.append(el("span", {}, label), input);
    f.append(l);
  };
  const status = el("select", { name: "status" });
  for (const st of STATUSES) status.append(Object.assign(el("option", { value: st.id }, st.label), { selected: st.id === (t.status ?? "none") }));
  field("Status", status);
  const start = el("input", { type: "date", name: "start" }) as HTMLInputElement;
  start.value = t.dueOnly || t.milestone ? "" : t.start ?? "";
  if (t.milestone) start.disabled = true;
  field(t.milestone ? "Start (milestone)" : "Start", start);
  const due = el("input", { type: "date", name: "due" }) as HTMLInputElement;
  due.value = t.fm[KEYS.end] ? t.end ?? "" : "";
  field("Due", due);
  if (t.scheduled) {
    const cal = el("p", { class: "cal" }, `On calendar (scheduled): ${t.scheduled.replace("T", " ")}`);
    f.append(cal);
  }
  const parent = el("select", { name: "parent" });
  parent.append(el("option", { value: "" }, "— none —"));
  const descendants = new Set<string>();
  const walk = (rel: string) => state.tasks.filter((x) => x.parent === rel).forEach((c) => { descendants.add(c.rel); walk(c.rel); });
  walk(t.rel);
  for (const o of state.tasks.filter((x) => x.rel !== t.rel && !descendants.has(x.rel)).sort((a, b) => a.name.localeCompare(b.name)))
    parent.append(Object.assign(el("option", { value: o.rel }, o.name), { selected: o.rel === t.parent }));
  field("Parent", parent);

  // dependencies
  let deps = t.deps.map((d) => ({ ...d }));
  const depBox = el("div", { class: "deps" });
  const drawDeps = () => {
    depBox.replaceChildren();
    for (const d of deps) {
      const line = el("div", { class: "dep-row" });
      const type = el("select");
      for (const [v, lbl] of [["FS", "after it finishes"], ["SS", "when it starts"], ["FF", "finishes with it"]])
        type.append(Object.assign(el("option", { value: v }, lbl), { selected: d.type === v }));
      type.onchange = () => (d.type = (type as HTMLSelectElement).value as DepType);
      const rm = el("button", { type: "button", class: "rm", "aria-label": "Remove dependency" }, "×");
      rm.onclick = () => { deps = deps.filter((x) => x !== d); drawDeps(); };
      line.append(el("span", { class: "dn" }, state.tasks.find((x) => x.rel === d.rel)?.name ?? d.rel), type, rm);
      depBox.append(line);
    }
    const add = el("select");
    add.append(el("option", { value: "" }, "+ Add task it waits on…"));
    for (const o of state.tasks.filter((x) => x.rel !== t.rel && !deps.some((d) => d.rel === x.rel)).sort((a, b) => a.name.localeCompare(b.name)))
      add.append(el("option", { value: o.rel }, o.name));
    add.onchange = () => {
      const v = (add as HTMLSelectElement).value;
      if (v) { deps.push({ rel: v, type: "FS" }); drawDeps(); }
    };
    depBox.append(add);
  };
  drawDeps();
  field("Waits on", depBox);

  const notes = el("textarea", { name: "notes", rows: "8" }) as HTMLTextAreaElement;
  notes.value = t.body.replace(/^\n/, "");
  field("Notes", notes);

  const actions = el("div", { class: "actions" });
  const del = el("button", { type: "button", class: "danger" }, "Delete");
  del.onclick = () => void removeTask(t);
  actions.append(el("button", { type: "submit", class: "primary" }, "Save"), del);
  f.append(actions);
  f.onsubmit = (ev) => {
    ev.preventDefault();
    const sv = (status as HTMLSelectElement).value;
    const nb = (t.body.startsWith("\n") ? "\n" : "") + notes.value;
    void save(
      t,
      (fm) => {
        fm[KEYS.status] = sv;
        if (t.milestone || t.dueOnly) setDates(fm, t, undefined, due.value || undefined);
        else setDates(fm, t, start.value || due.value || undefined, due.value || start.value || undefined);
        if (!due.value && !t.milestone && !t.dueOnly) delete fm[KEYS.end];
        if (!start.value && !t.milestone && !t.dueOnly) delete fm[KEYS.start];
        setParent(fm, t, (parent as HTMLSelectElement).value || undefined, resolve);
        setDeps(fm, deps, resolve);
      },
      nb
    );
  };
  panel.replaceChildren(f);
}

async function removeTask(t: WebTask) {
  if (!confirm(`Delete "${t.name}"? It goes to the repo history and Obsidian's trash, so it can be recovered.`)) return;
  try {
    await api("DELETE", `tasks?rel=${encodeURIComponent(t.rel)}&sha=${t.sha}`);
    state.selected = null;
    await load(true);
    toast("Deleted");
  } catch (e) {
    toast((e as Error).message, true);
  }
}

async function createTask() {
  const raw = prompt("New task name");
  if (!raw) return;
  const name = safeName(raw);
  if (!name) return toast("That name has no usable characters", true);
  const rel = `${name}.md`;
  if (state.tasks.some((t) => t.rel.toLowerCase() === rel.toLowerCase())) return toast("A task with that name already exists", true);
  const parentRel = state.selected ?? undefined;
  try {
    await api("PUT", `tasks?rel=${encodeURIComponent(rel)}`, { text: newNote(parentRel, today()) });
    state.selected = rel;
    await load(true);
    toast(parentRel ? `Created under ${state.tasks.find((t) => t.rel === parentRel)?.name}` : "Created");
  } catch (e) {
    toast((e as Error).message, true);
  }
}

function initControls() {
  for (const z of ["day", "week", "month"] as Zoom[]) {
    const b = $(`#z-${z}`);
    b.classList.toggle("on", state.zoom === z);
    b.onclick = () => {
      state.zoom = z;
      localStorage.setItem("zoom", z);
      document.querySelectorAll(".zoom button").forEach((x) => x.classList.toggle("on", x.id === `z-${z}`));
      render();
      scrollToToday();
    };
  }
  const hd = $<HTMLInputElement>("#hide-done");
  hd.checked = state.hideDone;
  hd.onchange = () => {
    state.hideDone = hd.checked;
    localStorage.setItem("hideDone", hd.checked ? "1" : "0");
    render();
  };
  $("#new").onclick = () => void createTask();
  $("#refresh").onclick = () => void load();
  $("#today").onclick = () => scrollToToday();
  // keep the table and chart rows aligned while scrolling
  const scroller = $("#scroller");
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") select(null); });
  void scroller;
}

function scrollToToday() {
  const { from } = range(state.rows);
  const sc = $("#chartwrap");
  sc.scrollLeft = Math.max(0, (dayNum(today()) - from - 5) * PX[state.zoom]);
}

async function main() {
  initControls();
  try {
    const me = (await api("GET", "me")) as { email: string };
    state.email = me.email;
    $("#me").textContent = me.email;
  } catch (e) {
    $("#main").replaceChildren(el("p", { class: "denied" }, (e as Error).message));
    return;
  }
  await load();
  scrollToToday();
  window.setInterval(() => { if (!state.busy && !document.hidden) void load(true); }, 60_000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void load(true); });
}

void main();
