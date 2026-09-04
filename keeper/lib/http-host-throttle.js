"use strict";

/**
 * 依 host 序列化的「主動節流閘」：同一 host 的請求排隊執行，並保證彼此間隔不小於設定值。
 * 來源：Altcoins（crypto-analyzer）app.js 的 queuedFetchJson / safeFetchJson / HOST_MIN_INTERVAL_MS；
 *       佇列作法originally參考 D:\project\Crypto\js\http.js 的 rlFetch。
 *
 * ⚠️ 本模組與既有兩支的分工（三者**互補**，不是替代關係，看清楚再選）：
 *
 *   | 模組 | 管什麼 | 時機 |
 *   |---|---|---|
 *   | **本模組** | 同 host **最小間隔**，主動不要打太快 | 送出**之前** |
 *   | `http-json-api.js` | 被拒絕後怎麼退避（429 長階梯、Retry-After） | 送出**之後** |
 *   | `promise-pool.js` | 同時在飛的請求**數量**上限 | 派工時 |
 *
 * 為什麼「併發上限」不能取代「最小間隔」：併發上限管的是同時幾個，但 N 個很快的請求依序跑完
 * 仍然可以在一秒內打出 N 次。有些 API（GoPlus、CoinGecko 免費層）限的是**頻率**而不是併發數，
 * 只有間隔閘擋得住。反過來也一樣——間隔閘不管併發，兩者要一起用。
 *
 * 而且限速幾乎都是按**來源 IP** 算的，不是按客戶端連線數。所以「開兩條通道各等一半時間」
 * 等於沒節流，對方看到的總頻率完全一樣。想更快只能換金鑰或換方案，不能靠併發繞。
 *
 * 需求：Node 18+（全域 fetch / AbortController），無外部套件。
 *
 * 使用範例（單獨用，附不丟例外的 JSON 取得）：
 *   const { throttledFetchJson, HOST_MIN_INTERVAL_MS } = require("./http-host-throttle");
 *   HOST_MIN_INTERVAL_MS["api.example.com"] = 1000;
 *   const r = await throttledFetchJson("https://api.example.com/x");
 *   if (!r.ok) console.error(r.error); else use(r.data);
 *
 * 使用範例（與既有重試模組組合，各司其職）：
 *   const { throttleByHost } = require("./http-host-throttle");
 *   const { fetchJsonWithRetry } = require("./http-json-api");
 *   const data = await throttleByHost(url, () => fetchJsonWithRetry(url, opts));
 */

/**
 * 各 host 的最小呼叫間隔（毫秒）。可在 require 之後直接增修。
 *
 * 這些數值都是**實測**得到的，不是文件抄的——改小之前請先有實測依據：
 *   - api.gopluslabs.io 2100：原本用 1200 會出現「回應 code=1 但 result 為空」的靜默失敗。
 *   - api.coingecko.com 8000：無金鑰層的實測安全值。
 *   - fapi.binance.com 300 / api.etherscan.io 250 / api.bybit.com 50：實測未遇限流。
 * 詳見 ../info/crypto-rate-limits.md。
 */
const HOST_MIN_INTERVAL_MS = {
  "api.gopluslabs.io": 2100,
  "api.coingecko.com": 8000,
  "fapi.binance.com": 300,
  "api.etherscan.io": 250,
  "api.bybit.com": 50,
};

const __hostQueues = new Map(); // host -> 佇列尾端 Promise
const __hostLastCallTs = new Map(); // host -> 上次實際發出請求的時間

/**
 * 等待指定毫秒。
 * @param {number} ms
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 核心閘門：把 `fn` 排進該 host 的佇列，執行前先補足最小間隔。
 *
 * 這是本模組唯一真正獨有的東西，其餘都是便利包裝。刻意接受任意 `fn` 而不綁 fetch，
 * 所以可以包住 `http-json-api.js` 的 `fetchJsonWithRetry`、也可以包住任何自訂請求。
 *
 * ⚠️ 佇列尾端一律 `.catch(() => {})`。若讓 rejection 留在鏈上，一次失敗會**永久卡住**
 * 該 host 後續所有請求——這是實作這種佇列最容易犯的錯。
 * 注意這只影響佇列內部；`fn` 自己的 rejection 仍會照原樣傳給呼叫端。
 *
 * @template T
 * @param {string} url 只用來取 host（解析失敗就不排隊，直接執行）
 * @param {() => Promise<T>} fn 實際要執行的請求
 * @param {number} [minIntervalMs] 覆寫該 host 的間隔；未給則查表，再無則 0
 * @returns {Promise<T>}
 */
function throttleByHost(url, fn, minIntervalMs) {
  let host = "";
  try {
    host = new URL(url).host;
  } catch (e) {
    /* 解析失敗就不分 host 排隊 */
  }
  const minInterval =
    minIntervalMs !== undefined ? minIntervalMs : HOST_MIN_INTERVAL_MS[host] || 0;

  const prevTail = __hostQueues.get(host) || Promise.resolve();
  const job = prevTail.then(async () => {
    const wait = (__hostLastCallTs.get(host) || 0) + minInterval - Date.now();
    if (wait > 0) await delay(wait);
    __hostLastCallTs.set(host, Date.now());
    return fn();
  });
  __hostQueues.set(host, job.catch(() => {}));
  return job;
}

/**
 * 單次 fetch + JSON 解析，任何錯誤都轉成**回傳值而非例外**。
 *
 * 與 `http-json-api.js` 的 `fetchJsonWithRetry` 契約相反（那支會 throw），兩者刻意並存：
 *   - 批次作業要「哪些筆失敗」的清單、或希望上層決定要不要中斷 → 用會 throw 的那支。
 *   - **多來源評分**這種「單一來源失敗只降級該模組、不讓整批炸掉」的場景 → 用這支。
 * 後者是 Altcoins 的既有慣例：任一資料源掛掉時該模組標記 unavailable、其餘照算。
 *
 * 回傳形狀讓呼叫端能分辨兩種失敗：
 *   - `status` 有數字：HTTP 有回應但非 2xx。
 *   - `status` 為 `undefined`：fetch 本身丟例外（網路／CORS／逾時／JSON 解析失敗），
 *     此時 `errorName` 帶 `e.name`——用來辨識下面說的 TypeError 陷阱。
 *
 * @param {string} url
 * @param {object} [opts] 轉交 fetch
 * @returns {Promise<{ok:boolean, data?:any, error?:string, status?:number, errorName?:string}>}
 */
async function safeFetchJson(url, opts) {
  try {
    const res = await fetch(url, opts || {});
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, status: res.status };
    const json = await res.json();
    return { ok: true, data: json };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e), errorName: e && e.name };
  }
}

/**
 * 便利包裝：`throttleByHost` + `safeFetchJson` + 逾時 + 輕量重試。
 *
 * 重試分兩級：
 *   - **疑似限流**（HTTP 429，或 `errorName === "TypeError"`）→ 20 秒 × 嘗試次數
 *   - 其他可重試（5xx、逾時、網路錯誤）→ 3 秒 × 嘗試次數
 *   - 其餘 4xx → 不重試
 *
 * ⚠️ TypeError 為什麼算限流：**CoinGecko 在 429 時不帶 CORS 標頭**，瀏覽器端 fetch 只會拋
 * `TypeError: Failed to fetch`，看不到 429 狀態碼本身。當成一般網路錯誤用短退避重試會越打越被封。
 * （Node 端沒有 CORS 限制，但同一個錯誤名稱在 Node 也代表底層連線失敗，保留同一分級無害。）
 *
 * 這裡的重試與 `http-json-api.js` 功能重疊，是為了讓本模組能單獨使用（尤其瀏覽器場景，
 * 那邊沒有 `Retry-After` 可讀也不需要 `onRaw` 落地）。**Node 端的批次抓取請優先用
 * `http-json-api.js` 的退避階梯**（它會讀 `Retry-After`，比這裡的固定階梯精確），
 * 用 `throttleByHost` 把它包起來即可。
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {number} [opts.minIntervalMs]
 * @param {number} [opts.retries=3]
 * @param {number} [opts.timeoutMs=25000]
 * @param {object} [opts.fetchOpts]
 * @param {(msg:string)=>void} [opts.onWait] 進入退避等待時的通知（可接進度列）
 * @returns {Promise<{ok:boolean, data?:any, error?:string, status?:number, errorName?:string}>}
 */
async function throttledFetchJson(url, opts) {
  opts = opts || {};
  const retries = opts.retries !== undefined ? opts.retries : 3;
  const timeoutMs = opts.timeoutMs !== undefined ? opts.timeoutMs : 25000;

  for (let attempt = 0; ; attempt++) {
    const r = await throttleByHost(
      url,
      () => {
        let timer = null;
        const fetchOpts = Object.assign({}, opts.fetchOpts);
        if (typeof AbortController !== "undefined") {
          const ctrl = new AbortController();
          fetchOpts.signal = ctrl.signal;
          timer = setTimeout(() => ctrl.abort(), timeoutMs);
        }
        return safeFetchJson(url, fetchOpts).then((res) => {
          if (timer) clearTimeout(timer);
          return res;
        });
      },
      opts.minIntervalMs
    );

    if (r.ok) return r;

    const status = r.status;
    const retryable = status === 429 || (typeof status === "number" && status >= 500) || status === undefined;
    if (!retryable || attempt >= retries) return r;

    const suspectRateLimit = status === 429 || r.errorName === "TypeError";
    const backoff = suspectRateLimit ? 20000 * (attempt + 1) : 3000 * (attempt + 1);
    if (opts.onWait) {
      let host = "";
      try {
        host = new URL(url).host;
      } catch (e) {}
      opts.onWait(`${host} 疑似限流或暫時錯誤，退避 ${Math.round(backoff / 1000)} 秒…`);
    }
    await delay(backoff);
  }
}

module.exports = { throttleByHost, throttledFetchJson, safeFetchJson, delay, HOST_MIN_INTERVAL_MS };
