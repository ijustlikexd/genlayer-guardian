// Records the Guardian demo scene by scene with Playwright (Edge channel).
// Every keeper command is executed for real against Studionet while recording;
// out/clips.json holds, per scene, the raw webm path and the [start,end] segments
// to keep (idle waiting is cut in build.py).
import { chromium } from "playwright";
import { spawn } from "child_process";
import fs from "fs";

const STAGE = "http://localhost:4173/stage/stage.html";
const SITE = "http://localhost:4173/";
const GUARDIAN_DIR = "D:/project/GenLayer/guardian";
const ONLY = process.argv.slice(2); // optional scene names to (re)record

fs.mkdirSync("out/raw", { recursive: true });
const clipsPath = "out/clips.json";
const clips = fs.existsSync(clipsPath) ? JSON.parse(fs.readFileSync(clipsPath, "utf-8")) : [];
const browser = await chromium.launch({ channel: "msedge" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function scene(name, fn) {
  if (ONLY.length && !ONLY.includes(name)) return;
  console.log(`\n=== scene ${name} ${new Date().toISOString()}`);
  const ctx = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: { dir: "out/raw", size: { width: 1920, height: 1080 } },
  });
  const page = await ctx.newPage();
  await page.goto(STAGE);
  const t0 = Date.now();
  const T = () => (Date.now() - t0) / 1000;
  const keep = [];
  let segStart = 0, cutting = false;
  const cut = () => { if (!cutting) { keep.push([segStart, T()]); cutting = true; } };
  const resume = () => { if (cutting) { segStart = T(); cutting = false; } };
  const marks = {};
  const mark = (k) => { marks[k] = T(); console.log(`  [${T().toFixed(1)}s] ${k}`); };
  const st = (js, ...args) => page.evaluate(js, ...args);
  const term = {
    type: (cmd) => st((c) => stage.typeCmd(c), cmd),
    out: (line) => st((l) => stage.out(l), line),
    clear: () => st(() => stage.clearTerm()),
  };
  const caption = (html) => st((h) => stage.caption(h), html);
  const show = (id) => st((i) => stage.show(i), id);
  // Runs a keeper command; streams stdout lines into the terminal panel.
  // onLine(line, T) may be used to react to JSON events.
  const keeper = (args, onLine) => new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "keeper/cli.ts", ...args], {
      cwd: GUARDIAN_DIR, shell: true, env: { ...process.env, PYTHONUTF8: "1" },
    });
    let buf = "";
    const handle = async (chunk) => {
      buf += chunk.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        if (onLine) await onLine(line);
        await term.out(line);
      }
    };
    child.stdout.on("data", handle);
    child.stderr.on("data", handle);
    child.on("close", async (code) => { if (buf.trim()) await term.out(buf); resolve(code); });
  });
  // Site helpers (same-origin iframe).
  const loadSite = async (zoom = 0.9) => st(async (a) => { await stage.loadSite(a.u, a.z); }, { u: SITE, z: zoom });
  const waitCards = () => st(() => stage.waitFor((d) => d.querySelectorAll(".target-card .mode-badge").length >= 4 && ![...d.querySelectorAll(".mode-badge")].some(b => b.textContent === "UNKNOWN"), 90000));
  const badge = (id) => st((i) => { const c = stage.siteDoc().querySelector(`.target-card[data-target-id="${i}"] .mode-badge`); return c ? c.textContent : null; }, id);
  const scrollTo = (sel, block = "start") => st((a) => { const e = stage.siteDoc().querySelector(a.s); if (e) e.scrollIntoView({ block: a.b }); }, { s: sel, b: block });
  const clickCard = (id) => st((i) => stage.siteDoc().querySelector(`.target-card[data-target-id="${i}"]`).click(), id);
  const waitIncidentRow = (incident, timeout = 90000) => st((a) => stage.waitFor((d) => [...d.querySelectorAll("#incidents-panel tr, #incidents-panel li, #incidents-panel div")].some((r) => r.textContent.includes(a.i) && !r.textContent.includes("not adjudicated")), a.t), { i: incident, t: timeout });
  // Reload the site until the badge of target `id` is one of `want`; cuts idle time.
  const reloadUntil = async (id, want, timeout = 240000, zoom = 0.9) => {
    const t = Date.now();
    while (Date.now() - t < timeout) {
      await loadSite(zoom); await waitCards();
      const b = await badge(id);
      if (want.includes(b)) { resume(); return b; }
      cut(); await sleep(6000);
    }
    return await badge(id);
  };

  let error = null;
  try {
    await fn({ page, T, cut, resume, mark, marks, term, caption, show, keeper, loadSite, waitCards, badge, scrollTo, clickCard, waitIncidentRow, reloadUntil, st });
  } catch (e) { error = String(e && e.message || e); console.log(`  !! scene ${name} failed: ${error}`); }
  keep.push([segStart, T()]);
  const video = page.video();
  await ctx.close();
  const file = await video.path();
  const entry = { name, file, keep, marks, error, recordedAt: new Date().toISOString() };
  const idx = clips.findIndex((c) => c.name === name);
  if (idx >= 0) clips[idx] = entry; else clips.push(entry);
  fs.writeFileSync(clipsPath, JSON.stringify(clips, null, 2));
  console.log(`  saved ${file} keep=${JSON.stringify(keep.map(([a, b]) => [a.toFixed(1), b.toFixed(1)]))}`);
}

// A live `check`: type the command, run it, show RESTRICTED at acceptance, then the verdict.
async function liveCheck(s, { target, source, incident, flags = [], expectFinal }) {
  const { term, caption, keeper, mark, cut, resume, loadSite, waitCards, badge, scrollTo, clickCard, waitIncidentRow, reloadUntil } = s;
  await term.type(`npm run keeper -- check ${target} ${source} ${incident}${flags.length ? " " + flags.join(" ") : ""}`);
  await s.st(() => stage.sleep(800));
  cut();
  let submitted = false, finalized = false;
  await keeper(["check", target, source, incident, ...flags], async (line) => {
    if (!submitted && line.includes('"event":"check_submitted"')) {
      submitted = true; resume(); mark("submitted");
    }
    if (!finalized && line.includes('"event":"check_finalized"')) { finalized = true; resume(); mark("finalized"); }
  });
  resume(); mark("verdict_printed");
  return { submitted, finalized };
}

// ------------------------------------------------------------------ scenes

await scene("problem", async (s) => { await s.show("s-problem"); await sleep(4000); });
await scene("judge", async (s) => { await s.show("s-judge"); await sleep(4000); });

await scene("vault-a", async (s) => {
  await s.show("s-split"); await s.loadSite(); await s.waitCards(); await s.scrollTo("#targets-heading");
  await s.caption("<b>vault-a</b> runs lodash 4.17.15 and merges untrusted JSON with <b>set</b> / <b>zipObjectDeep</b>.");
  await sleep(2500);
  await liveCheck(s, { target: "vault-a", source: "osv", incident: "GHSA-p6mc-m468-83gw" });
  // acceptance stage: RESTRICTED
  const b1 = await s.reloadUntil("vault-a", ["RESTRICTED", "PAUSED"]);
  await s.scrollTo("#targets-heading"); s.mark(`badge_after_accept_${b1}`);
  await s.caption(`<b>RESTRICT</b> landed the moment consensus accepted. Vault mode: <b>${b1}</b>.`);
  await sleep(4500);
  if (b1 !== "PAUSED") {
    s.cut();
    const b2 = await s.reloadUntil("vault-a", ["PAUSED"]);
    await s.scrollTo("#targets-heading"); s.mark(`badge_after_final_${b2}`);
  }
  await s.caption("<b>PAUSE</b> landed only after finality. Optimistic finality became risk escalation.");
  await sleep(2000);
  await s.clickCard("vault-a"); await s.scrollTo("#incidents-heading"); await s.waitIncidentRow("GHSA-p6mc-m468-83gw");
  await sleep(4500);
});

await scene("vault-c", async (s) => {
  await s.show("s-split"); await s.loadSite(); await s.waitCards(); await s.scrollTo("#targets-heading");
  await s.caption("<b>vault-c</b>: same lodash 4.17.15, but only <b>chunk</b> / <b>uniq</b> on internal constants.");
  await sleep(2000);
  await liveCheck(s, { target: "vault-c", source: "osv", incident: "GHSA-p6mc-m468-83gw" });
  const b = await s.reloadUntil("vault-c", ["RESTRICTED", "PAUSED"]);
  await s.scrollTo("#targets-heading"); s.mark(`badge_${b}`);
  await s.caption("Prerequisite <b>not met</b>: high severity clamped to <b>RESTRICT</b>. Same advisory, different outcome.");
  await sleep(5000);
});

await scene("vault-b", async (s) => {
  await s.show("s-split"); await s.loadSite(); await s.waitCards(); await s.scrollTo("#targets-heading");
  await s.caption("<b>vault-b</b> is patched: lodash 4.18.1.");
  await sleep(2000);
  await liveCheck(s, { target: "vault-b", source: "osv", incident: "GHSA-p6mc-m468-83gw" });
  await s.loadSite(); await s.waitCards(); await s.scrollTo("#targets-heading"); s.mark(`badge_${await s.badge("vault-b")}`);
  await s.caption("Version outside the affected range: <b>NONE</b>. No LLM was asked.");
  await sleep(5000);
});

await scene("demo-repo", async (s) => {
  await s.show("s-split");
  await s.st(() => stage.showShot("gh-advisory.png"));
  await s.caption("A human published this advisory on <b>github.com/ijustlikexd/guardian-demo-target</b>. Guardian reads the GitHub API.");
  await sleep(5000);
  await s.st(() => stage.showSite()); await s.loadSite(); await s.waitCards(); await s.scrollTo("#targets-heading");
  await s.caption("<b>demo-repo</b> runs guardian-demo-target 1.2.0, affected range &lt; 1.3.0.");
  await sleep(1500);
  await liveCheck(s, { target: "demo-repo", source: "github_repo_advisory", incident: "GHSA-m9f4-gp45-2v27", flags: ["--wait-final"] });
  const b = await s.reloadUntil("demo-repo", ["PAUSED"]);
  await s.scrollTo("#targets-heading"); s.mark(`badge_${b}`);
  await s.caption("Publish to <b>PAUSE</b> in minutes. Anyone can reproduce this on their own repository.");
  await sleep(5000);
});

await scene("recovery", async (s) => {
  await s.show("s-split"); await s.loadSite(); await s.waitCards(); await s.scrollTo("#targets-heading");
  await s.caption("Upgrade the dependency to <b>1.3.0</b>, then ask for resume.");
  await sleep(1500);
  await s.term.type("npm run keeper -- update-manifest demo-repo docs/examples/manifest-demo-repo-fixed.json");
  s.cut();
  await s.keeper(["update-manifest", "demo-repo", "docs/examples/manifest-demo-repo-fixed.json"], async (l) => { if (l.includes("manifest_updated")) { s.resume(); s.mark("manifest_updated"); } });
  s.resume(); await sleep(1500);
  await s.term.type("npm run keeper -- resume-all demo-repo");
  s.cut();
  await s.keeper(["resume-all", "demo-repo"], async (l) => { if (l.includes("resume_all_requested")) { s.resume(); s.mark("resume_requested"); } });
  s.resume();
  const b = await s.reloadUntil("demo-repo", ["NORMAL"]);
  await s.scrollTo("#targets-heading"); s.mark(`badge_${b}`);
  await s.caption("Validators re-checked the evidence: <b>NO_LONGER_AFFECTED</b>. Vault back to <b>NORMAL</b>.");
  await sleep(5000);
});

await scene("numbers", async (s) => {
  await s.show("s-full"); await s.loadSite(1.0); await s.waitCards();
  await s.scrollTo("#consistency-heading"); await sleep(6000);
  await s.show("s-numbers"); await sleep(4000);
});

await scene("bradbury", async (s) => {
  await s.show("s-full"); await s.loadSite(1.0); await s.waitCards();
  await s.st(() => stage.siteDoc().getElementById("network-btn-testnet-bradbury").click());
  s.mark("switch_clicked");
  await s.st(() => stage.waitFor((d) => d.getElementById("network-value").textContent.includes("bradbury"), 30000));
  s.cut();
  await s.st(() => stage.waitFor((d) => d.querySelectorAll(".target-card .mode-badge").length >= 1 && ![...d.querySelectorAll(".mode-badge")].some(b => b.textContent === "UNKNOWN"), 120000));
  s.resume(); s.mark("bradbury_cards");
  await s.scrollTo("#targets-heading"); await sleep(3000);
  await s.clickCard("vault-a"); await s.scrollTo("#incidents-heading");
  s.cut();
  await s.waitIncidentRow("GHSA-p6mc-m468-83gw", 180000);
  s.resume(); s.mark("bradbury_incidents");
  await sleep(6000);
});

await scene("close", async (s) => { await s.show("s-close"); await sleep(4000); });

// Smoke test (read-only): exercises split layout, terminal streaming, iframe driving.
await scene("smoke", async (s) => {
  await s.show("s-split"); await s.loadSite(); await s.waitCards(); await s.scrollTo("#targets-heading");
  await s.caption("smoke: <b>caption</b> test"); await sleep(1000);
  await s.term.type("npm run keeper -- vault 0x26430F4d68Fa90eD43BAE770b1969fD9ea159331");
  s.cut();
  await s.keeper(["vault", "0x26430F4d68Fa90eD43BAE770b1969fD9ea159331"], async (l) => { if (l.includes("mode")) { s.resume(); s.mark("vault_out"); } });
  s.resume();
  await s.clickCard("vault-a"); await s.scrollTo("#incidents-heading");
  await s.st(() => stage.waitFor((d) => d.querySelectorAll("#incidents-panel tr").length > 2, 60000));
  s.mark("rows_" + await s.st(() => stage.siteDoc().querySelectorAll("#incidents-panel tr").length));
  await sleep(3000);
});

await browser.close();
console.log("\nall scenes recorded");

