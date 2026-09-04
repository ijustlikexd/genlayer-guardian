"use strict";

/**
 * 帶重試的 JSON API fetch，429 走獨立、長得多的退避階梯。
 * 來源：Cyclical commodities `packages/connectors/src/usda/psd.ts` 的
 *       `fetchJson`，泛化為通用工具（拿掉 better-sqlite3 upsert 與
 *       raw_download 落地，改成可選的 `onRaw` callback）。
 *
 * 這支模組存在的理由是一個真實發生過、事後才被發現的資料遺失事故，
 * 不是預防性設計。原始 PSD 連接器一開始把 429（rate limit）當成普通的
 * 暫時性錯誤，套用同一條 1s/2s/4s 指數退避、重試 3 次。問題是：
 * api.data.gov 的節流窗口比這條階梯長得多，三次重試全部燒在**同一個**
 * 節流窗口裡，最後這個 (commodity, year) 組合永久失敗——而呼叫端的
 * per-item catch 只印一句 warning、不會讓整批跑失敗，於是「這個商品/
 * 年份被 429 擋掉」跟「USDA 這個商品/年份本來就沒資料」在輸出上長得
 * 一模一樣。整整好幾個行銷年度的資料就這樣悄悄消失，直到後來一次
 * 跟這次抓取完全無關的資料完整性抽查才被抓到。
 *
 * 修法，也是本模組的核心行為：
 *
 *   1. **429 用獨立的退避階梯**，且遠長於一般暫時性錯誤：優先看
 *      `Retry-After` header（伺服器最清楚自己什麼時候解鎖），沒有的話
 *      預設 20s / 40s / 60s（`rateLimitBaseDelayMs * (attempt+1)`），
 *      不是 1s/2s/4s。
 *   2. 一般暫時性錯誤（逾時、連線中斷、5xx）維持較短的指數退避
 *      （`transientBaseDelayMs * 2^attempt`，預設 1s/2s/4s）——這種
 *      錯誤通常幾秒內就會自己好，不需要也不該套用 429 的長階梯。
 *   3. 降併發：來源專案在確認 429 問題後把 PSD 連接器的併發從 4 降到 2；
 *      本模組不管併發（那是 `promise-pool.js` 的事），但呼叫端串接
 *      429 處理與併發／限流時，這個數字值得抄。
 *
 * 更一般的教訓，值得在任何「批次打 API」的程式碼上刻一遍：
 * **單筆失敗只印警告 + 短重試 = 看不見的資料遺失。** 短重試在真正的
 * 節流面前形同沒有重試，而单筆失敗不中斷整批，代表沒人會在跑的當下
 * 注意到。寧可讓失敗吵一點（丟出去讓上層決定要不要中斷），或至少
 * 回傳一份呼叫端可以拿去斷言（assert）的「哪些筆失敗了」清單，而不是
 * 只留一行會被捲走的 console.warn。
 *
 * 另外一個容易忽略的點：很多 API 把金鑰放在 query string 裡
 * （`?api_key=xxx`），任何要記錄或落地的 URL（log、`onRaw` 存檔）都要先
 * 把金鑰換成 `REDACTED`，否則金鑰就這樣被寫進日誌檔或原始下載檔案裡。
 * 見下方 `redact` 選項。
 *
 * 相依：Node 18+ 內建 fetch。無外部套件。
 *
 * 使用範例：
 *   const { fetchJsonWithRetry } = require("./http-json-api");
 *
 *   const json = await fetchJsonWithRetry(
 *     `https://api.example.gov/data?api_key=${apiKey}`,
 *     {
 *       redact: apiKey, // 記錄／onRaw 時把金鑰換成 REDACTED
 *       retries: 3,
 *       transientBaseDelayMs: 1000,   // 一般錯誤：1s/2s/4s
 *       rateLimitBaseDelayMs: 20000,  // 429：20s/40s/60s（或 Retry-After）
 *       onRaw: ({ url, text, fetchedAt }) => archiveRaw(url, text, fetchedAt),
 *     }
 *   );
 */

/**
 * @param {string} url
 * @param {object} [opts]
 * @param {object} [opts.headers] 額外的 request headers（例如 `X-Api-Key`）
 * @param {number} [opts.retries=3] 總重試次數（不含第一次嘗試）；429 與一般
 *        暫時性錯誤共用這個次數上限，但退避時間分開計算（見檔頭）
 * @param {number} [opts.transientBaseDelayMs=1000] 一般暫時性錯誤（逾時、
 *        連線錯誤、非 429 的失敗狀態碼）的指數退避基準：
 *        `transientBaseDelayMs * 2^attempt`
 * @param {number} [opts.rateLimitBaseDelayMs=20000] 429 的退避基準（線性）：
 *        `rateLimitBaseDelayMs * (attempt+1)`；若回應帶 `Retry-After`
 *        header，兩者取較大值
 * @param {number} [opts.timeoutMs] 單次嘗試逾時（毫秒）；未設定則不設逾時
 * @param {(info: {url: string, text: string, fetchedAt: string}) => void} [opts.onRaw]
 *        成功取得回應本文（尚未 JSON.parse）時呼叫，`url` 已依 `redact`
 *        處理過；呼叫端要不要落地存檔、要存去哪，完全由這裡決定——
 *        本模組本身不寫檔、不碰資料庫
 * @param {string | ((url: string) => string)} [opts.redact] 記錄／`onRaw`
 *        用的 URL 要怎麼去敏：傳字串＝該字串（例如 apiKey 本身）在 URL 中
 *        的所有出現都換成 `REDACTED`；傳函式＝自訂轉換；不傳則原樣記錄
 *        （小心金鑰外流）
 * @returns {Promise<any>} 已 `JSON.parse` 的回應內容
 * @throws 重試用盡（含 429 與一般錯誤）時 throw，訊息帶 url（已去敏）
 */
async function fetchJsonWithRetry(url, opts = {}) {
  const {
    headers = {},
    retries = 3,
    transientBaseDelayMs = 1000,
    rateLimitBaseDelayMs = 20_000,
    timeoutMs,
    onRaw,
    redact,
  } = opts;

  const redactedUrl = redactUrl(url, redact);
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = timeoutMs ? new AbortController() : undefined;
    const timer = timeoutMs ? setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
    try {
      const res = await fetch(url, { headers, signal: ctrl && ctrl.signal });
      if (timer) clearTimeout(timer);

      if (res.status === 429) {
        // 429 不是普通的暫時性錯誤：三次重試燒在同一個節流窗口裡等於沒重試。
        // 優先信任 Retry-After，否則用遠長於一般錯誤的獨立階梯（見檔頭）。
        const retryAfterSec = Number(res.headers.get("retry-after")) || 0;
        const backoffMs = Math.max(retryAfterSec * 1000, rateLimitBaseDelayMs * (attempt + 1));
        lastErr = new Error(`HTTP 429（rate limited）：${redactedUrl}`);
        if (attempt < retries) await sleep(backoffMs);
        continue;
      }

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}：${redactedUrl}`);
      }

      const text = await res.text();
      const fetchedAt = new Date().toISOString();
      if (onRaw) onRaw({ url: redactedUrl, text, fetchedAt });
      return JSON.parse(text);
    } catch (e) {
      if (timer) clearTimeout(timer);
      lastErr = e;
      if (attempt < retries) await sleep(transientBaseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`fetchJsonWithRetry 失敗：${redactedUrl}`);
}

function redactUrl(url, redact) {
  if (!redact) return url;
  if (typeof redact === "function") return redact(url);
  // redact 是字串（通常是 API key 本身）：把它在 URL 中的所有出現換成 REDACTED。
  return url.split(redact).join("REDACTED");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { fetchJsonWithRetry };
