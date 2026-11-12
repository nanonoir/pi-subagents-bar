// NO-MODEL headless interoperability smoke. No network / LLM / child agents / credentials.
// Scope: real Pi SDK loader + ExtensionRunner, real public event bus, real pi-subagents provider,
// real Atelier sidebar registry/validator (src/sidebar-panels.ts). NOT Atelier UI rendering:
// Atelier's own extension is not loaded; the registry is an observer on the public channel.
// Paths via env or flags (no machine paths hard-coded):
//   PI_SDK_DIR (--sdk=)  ATELIER_DIR (--atelier=)  SUBAGENTS_DIR (--subagents=)  required
//   CYCLER_DIR / SUBPANEL_DIR  optional coexistence (registration only; subscription lifecycle skipped)
//   BAR_DIR (--bar=) defaults to repo root of this script
//   --order=provider-first|bar-first  (default provider-first). Run once per order, separate processes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (n, e) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? process.env[e];
const SDK = arg("sdk", "PI_SDK_DIR"), ATELIER = arg("atelier", "ATELIER_DIR"), SUBAGENTS = arg("subagents", "SUBAGENTS_DIR");
const CYCLER = arg("cycler", "CYCLER_DIR"), SUBPANEL = arg("subpanel", "SUBPANEL_DIR");
const BAR = arg("bar", "BAR_DIR") ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ORDER = arg("order", "SMOKE_ORDER") ?? "provider-first";
if (!SDK || !ATELIER || !SUBAGENTS) { console.error("need PI_SDK_DIR, ATELIER_DIR, SUBAGENTS_DIR"); process.exit(2); }

// Isolate BEFORE any dynamic import. Scrub inherited Pi/subagent env (PI_SUBAGENT_CHILD=1 disables providers).
for (const k of Object.keys(process.env)) if (/^(PI_|HERDR)/.test(k)) delete process.env[k];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-smoke-"));
const agentDir = path.join(tmp, "agent"), cwd = path.join(tmp, "cwd");
fs.mkdirSync(agentDir, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_OFFLINE = "1";
const netCalls = [];
globalThis.fetch = async (u) => { netCalls.push(String(u)); throw new Error("network blocked by smoke"); };

// pi-subagents writes last-seen-version.json asynchronously into the isolated dir; remove again at exit.
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
let failed = 0, total = 0;
const check = (name, ok, detail = "") => { total++; if (!ok) failed++; console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " :: " + detail : ""}`); };
const under = (p, d) => path.resolve(p).toLowerCase().startsWith(path.resolve(d).toLowerCase());
const PANEL_ID = "subagents-bar:subagents", SOURCE = "subagents-bar", TITLE = "Subagents";

let runner, reg, loaded, subpanelExt;
try {
  console.log(`order=${ORDER}`);
  const sdk = await import(pathToFileURL(path.join(SDK, "dist/index.js")).href);
  const { createEventBus, discoverAndLoadExtensions, ExtensionRunner, SessionManager } = sdk;
  // Node refuses type stripping under node_modules; use the SDK's own jiti dependency.
  const sdkRequire = createRequire(path.join(SDK, "package.json"));
  const { createJiti } = await import(pathToFileURL(sdkRequire.resolve("jiti")).href);
  // Independent Pi packages rely on the host's imports, not nested peer installs.
  const sp = await createJiti(import.meta.url, {
    moduleCache: false,
    alias: { "@earendil-works/pi-tui": sdkRequire.resolve("@earendil-works/pi-tui") },
  }).import(path.join(ATELIER, "src/sidebar-panels.ts"));
  check("atelier registry exports", typeof sp.createSidebarPanelRegistry === "function" && sp.SIDEBAR_PANEL_EVENT_CHANNEL === "pi-atelier:sidebar-panels");

  const events = createEventBus();
  const rpc = []; // {method, requestId, replyOk}
  events.on("subagents:rpc:v1:request", (r) => {
    const entry = { method: r?.method, requestId: r?.requestId, replyOk: undefined };
    rpc.push(entry);
    events.on("subagents:rpc:v1:reply:" + r?.requestId, (rep) => { entry.replyOk = rep?.success === true; });
  });
  const channel = [];
  events.on(sp.SIDEBAR_PANEL_EVENT_CHANNEL, (d) => channel.push(d));

  const dirs = ORDER === "bar-first"
    ? { bar: BAR, subagents: SUBAGENTS }
    : { subagents: SUBAGENTS, bar: BAR };
  if (CYCLER) dirs.cycler = CYCLER;
  if (SUBPANEL) dirs.subpanel = SUBPANEL;
  const keys = Object.keys(dirs);
  loaded = await discoverAndLoadExtensions(Object.values(dirs), cwd, agentDir, events);
  check("real SDK loader: no errors/warnings", loaded.errors.length === 0 && !(loaded.warnings?.length), JSON.stringify({ e: loaded.errors, w: loaded.warnings }));
  const idx = keys.map((k) => loaded.extensions.findIndex((e) => under(e.path, dirs[k])));
  check("load order as requested", idx.every((i, j) => i === j), `${keys.join(">")} idx=${idx}`);
  const barExt = loaded.extensions[idx[keys.indexOf("bar")]];
  check("bar registers no tools", barExt && barExt.tools.size === 0, `tools=${barExt?.tools.size}`);
  const providerExt = loaded.extensions[idx[keys.indexOf("subagents")]];
  check("provider registered tools (control)", providerExt.tools.size > 0);

  const sm = SessionManager.inMemory(cwd);
  const fakeRegistry = new Proxy({}, { get: (_t, p) => (p === "then" ? undefined : () => undefined) }); // no auth/models
  runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, sm, fakeRegistry);
  const noop = () => undefined, nop = async () => undefined;
  runner.bindCore(
    { sendMessage: noop, sendUserMessage: noop, appendEntry: noop, setSessionName: noop, getSessionName: noop, setLabel: noop,
      getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools: noop, refreshTools: noop,
      getCommands: () => [], setModel: async () => false, getThinkingLevel: () => "off", setThinkingLevel: noop },
    { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined,
      abort: noop, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => "" },
  );
  const notes = [];
  const ui = { theme: undefined, notify: (m, t) => notes.push([t ?? "info", String(m)]), getAllThemes: () => [], getEditorText: () => "", onTerminalInput: () => noop,
    select: nop, confirm: nop, input: nop, editor: nop, custom: nop };
  for (const m of ["setStatus","setWorkingMessage","setWorkingVisible","setWorkingIndicator","setHiddenThinkingLabel","setWidget","setFooter","setHeader","setTitle","pasteToEditor","setEditorText","setEditorComponent","getEditorComponent","addAutocompleteProvider","setTheme","getTheme","setToolsExpanded","getToolsExpanded"]) ui[m] = noop;
  runner.setUIContext(ui, "tui");
  runner.bindCommandContext({ waitForIdle: nop, newSession: async () => ({ cancelled: true }), fork: async () => ({ cancelled: true }),
    navigateTree: async () => ({ cancelled: true }), switchSession: async () => ({ cancelled: true }), reload: nop });
  const runnerErrors = [];
  runner.onError((e) => runnerErrors.push(`${e.extensionPath}: ${e.event}: ${e.error}`));

  const cmds = runner.getRegisteredCommands().map((c) => c.invocationName ?? c.name);
  const has = (...n) => n.every((x) => cmds.includes(x));
  check("commands registered", has("subagents-bar", "subagents", "run") && (!CYCLER || has("hprofile")) && (!SUBPANEL || has("subscriptions")), cmds.join(","));
  check("no command diagnostics", runner.getCommandDiagnostics().length === 0, JSON.stringify(runner.getCommandDiagnostics()));

  // Subscription-panel lifecycle (TUI polling/credentials) is never invoked.
  if (SUBPANEL) for (const e of loaded.extensions) if (under(e.path, SUBPANEL)) for (const k of ["session_start", "session_shutdown"]) e.handlers.set(k, []);

  // Real Atelier registry; own ID/source filtering done in assertions below.
  let waiters = [];
  reg = sp.createSidebarPanelRegistry({ events, instanceId: "smoke", onChange: () => waiters.slice().forEach((w) => w()) });
  const mine = () => reg.getAvailable().filter((p) => p.id === PANEL_ID);
  const waitFor = (pred, ms = 5000) => new Promise((resolve) => {
    if (pred()) return resolve(true);
    const t = setTimeout(() => { waiters = waiters.filter((w) => w !== h); resolve(false); }, ms);
    const h = () => { if (pred()) { clearTimeout(t); waiters = waiters.filter((w) => w !== h); resolve(true); } };
    waiters.push(h);
  });
  const rowsText = () => (mine()[0]?.rows ?? []).map((r) => (typeof r === "string" ? r : r.text));
  const registers = () => channel.filter((m) => m.type === "register" && m.panel?.id === PANEL_ID);

  await runner.emit({ type: "session_start", reason: "startup" });
  check("bar panel accepted by real registry (id/source/title)", await waitFor(() => mine().length === 1), JSON.stringify(reg.getAvailable().map((p) => [p.id, p.source, p.title])));
  const p = mine()[0];
  check("panel identity exact", p?.id === PANEL_ID && p?.source === SOURCE && p?.title === TITLE, JSON.stringify([p?.id, p?.source, p?.title]));
  check("only the bar contributed panels", reg.getAvailable().every((x) => x.source === SOURCE));
  const readyOk = await waitFor(() => rowsText().some((t) => /^Provider: 0 active/.test(t)) && rowsText().some((t) => /No known subagents/.test(t)));
  check("ready display (provider status read, empty fleet)", readyOk, JSON.stringify(rowsText()));
  const ping = rpc.filter((r) => r.method === "ping"), status = rpc.filter((r) => r.method === "status");
  check("provider ping and status requested and answered success", ping.length >= 1 && status.length >= 1 && [...ping, ...status].every((r) => r.replyOk === true),
    JSON.stringify(rpc.map((r) => [r.method, r.replyOk])));
  const sigs = registers().map((m) => JSON.stringify(m.panel)); const revs = registers().map((m) => m.revision);
  check("registers are distinct updates with increasing revisions (no duplicate publish)", sigs.length >= 1 && new Set(sigs).size === sigs.length && revs.every((r, i) => i === 0 || r > revs[i - 1]), JSON.stringify({ n: sigs.length, revs, ping: ping.length }));

  // Commands: exact notification + panel state; never counts unrelated panels.
  const cmd = runner.getCommand("subagents-bar");
  const run = async (a) => { const n = notes.length; await cmd.handler(a, runner.createCommandContext()); return notes.slice(n); };
  const collapsed = /^Subagents content collapsed to summary only\./, expanded = /^Subagents content expanded\./;
  let n = await run("hide"); check("hide -> collapsed info", n.length === 1 && n[0][0] === "info" && collapsed.test(n[0][1]), JSON.stringify(n));
  n = await run("show"); check("show -> expanded info", n.length === 1 && n[0][0] === "info" && expanded.test(n[0][1]), JSON.stringify(n));
  n = await run(""); check("bare toggles to collapsed", n.length === 1 && collapsed.test(n[0][1]), JSON.stringify(n));
  n = await run("toggle"); check("toggle back to expanded", n.length === 1 && expanded.test(n[0][1]), JSON.stringify(n));
  n = await run("bogus"); check("unknown arg -> usage warning only", n.length === 1 && n[0][0] === "warning" && /^Usage: \/subagents-bar/.test(n[0][1]), JSON.stringify(n));
  n = await run("show hide"); check("multiple args -> usage warning only", n.length === 1 && n[0][0] === "warning", JSON.stringify(n));
  check("panel still single and exact after commands", mine().length === 1 && mine()[0].source === SOURCE, JSON.stringify(rowsText()));

  // Teardown event-based.
  await runner.emit({ type: "session_shutdown", reason: "quit" });
  check("shutdown unregisters bar panel", await waitFor(() => mine().length === 0, 3000), `remaining=${mine().length}`);
  check("unregister sent for exact id", channel.some((m) => m.type === "unregister" && m.id === PANEL_ID), JSON.stringify(channel.filter((m) => m.type === "unregister")));

  const bad = notes.filter(([t]) => t === "error" || t === "warning" && false);
  check("no error-level notes", bad.length === 0, JSON.stringify(bad));
  check("no runner errors", runnerErrors.length === 0, JSON.stringify(runnerErrors));
  console.log("notes:", JSON.stringify(notes.map(([t, m]) => [t, m.slice(0, 80)])));
  check("no network attempts", netCalls.length === 0, netCalls.join(","));
} catch (e) {
  check("script completed without exception", false, e?.stack ?? String(e));
} finally {
  try { await runner?.emit({ type: "session_shutdown", reason: "quit" }); } catch { /* already shut down or failed; reported above */ }
  try { reg?.dispose(); } catch {}
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${total - failed}/${total} passed`);
  process.exitCode = failed ? 1 : 0;
}
