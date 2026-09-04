# keeper/lib sources

`http-json-api.js` and `http-host-throttle.js` are copied verbatim from
`D:\project\Share Funcs\funcs\` (same copies already used by
`genlayer-resolver/client/lib`). Each is a self-contained Node CommonJS
module with no cross-file requires beyond Node builtins. `package.json` in
this directory sets `"type": "commonjs"` so these files load correctly under
the ESM-first `genlayer-guardian-keeper` package.

| File | Origin | How this project uses it |
|---|---|---|
| `http-json-api.js` | `Share Funcs/funcs/http-json-api.js` | Retrying JSON GET with dedicated 429 backoff, used for `getOsvVuln` in `keeper/osv.ts`. It has no POST support, so the OSV bulk `query` call in `keeper/osv.ts` is a small local POST-with-retry helper instead (see comment there). |
| `http-host-throttle.js` | `Share Funcs/funcs/http-host-throttle.js` | Per-host minimum-interval throttle, used in `keeper watch` to rate-limit repeated calls to api.osv.dev across the polling loop. |
