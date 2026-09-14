import { chromium } from "playwright";
const b = await chromium.launch({ channel: "msedge" }); const p = await b.newPage({ viewport: { width: 1500, height: 1000 } });
const rpc = [];
p.on("request", r => { if (r.method()==="POST" && /studio-dev|studio-next/.test(r.url())) { try { const j = JSON.parse(r.postData()||"{}"); rpc.push({m:j.method, p:JSON.stringify(j.params||[]).slice(0,240)}); } catch {} } });
await p.goto("https://studio-next.genlayer.com/contracts", { waitUntil: "networkidle", timeout: 90000 }).catch(()=>{});
await p.waitForTimeout(4000);
try { await p.getByText("Skip tutorial").first().click({ timeout: 3000 }); } catch {}
await p.getByText("storage.py", { exact: true }).first().click(); await p.waitForTimeout(4000);
await p.screenshot({ path: "out/studio-next-4.png" });
const btns = await p.evaluate(() => Array.from(document.querySelectorAll("button")).map(b => b.innerText.trim()).filter(Boolean));
console.log("buttons:", JSON.stringify(btns.slice(0,50)));
const dep = p.getByRole("button", { name: /^deploy/i }).first();
if (await dep.count()) { await dep.click(); console.log("clicked deploy"); await p.waitForTimeout(60000); }
await p.screenshot({ path: "out/studio-next-5.png" });
const body = await p.evaluate(() => document.body.innerText);
console.log("page:", JSON.stringify((body.match(/.{0,100}(malformed|eployed|rror|Contract address|0x[0-9a-fA-F]{40}).{0,120}/g)||[]).slice(0,8)));
console.log("rpc:", JSON.stringify(rpc.filter(x=>!/eth_getBalance|eth_blockNumber|eth_chainId/.test(x.m)).slice(0,25), null, 0));
await b.close();
