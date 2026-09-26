# Nansen API usage

How EXPOSURE spent its Nansen credits during the buildathon, and how to check it from the repository
alone. The README has the endpoint list and the cost formula; this page has the per-scan detail.

## Where the calls came from

| Step | Script | Endpoints | Paid calls | Credits |
|---|---|---|---:|---:|
| Find candidates | `npm run trending` | `token-screener` | 5 | 5 |
| GO/NO-GO data test on one token (BNB Chain), 20 buyers + 20 holders | `npm run smoke` | a full deep scan | 52 | 56 |
| Record the 7 gallery patients, 90 buyers + 70 holders each | `npm run warm` | a full deep scan per token | 1,012 (+14 cache hits) | 1,040 |
| **Total** | | | **1,069** | **1,101** |

Every script prints its estimate and asks before spending. Responses are cached on disk with snapshot
semantics, so a wallet already traced for one token is not paid for again by the next (the 14 cache
hits). The free `account` endpoint was read before and after each run to check the balance.

## Ledger summary

`npm run ledger` reads the local, append-only `.ledger/calls.ndjson` (one line per HTTP attempt or
cache hit: time, endpoint, status, credits, latency, cache flag) and prints this table. It never calls
the network. The ledger file is not committed.

| Endpoint | Network calls (2xx) | Errors / retries | Cache hits | Credits |
|---|---:|---:|---:|---:|
| `profiler/address/pnl` | 510 | 0 | 0 | 510 |
| `profiler/address/first-funder` | 456 | 0 | 14 | 456 |
| `tgm/flows` | 32 | 4 | 0 | 32 |
| `tgm/who-bought-sold` | 26 | 0 | 0 | 26 |
| `account` | 8 | 1 | 0 | 0 |
| `tgm/dex-trades` | 8 | 0 | 1 | 8 |
| `tgm/flow-intelligence` | 8 | 0 | 0 | 8 |
| `tgm/holders` | 8 | 0 | 0 | 40 |
| `tgm/token-information` | 8 | 0 | 1 | 8 |
| `tgm/token-ohlcv` | 8 | 0 | 1 | 8 |
| `token-screener` | 5 | 0 | 0 | 5 |
| **Total** | **1,077** | **5** | **17** | **1,101** |

Successful paid Nansen API calls (excluding the free `account` and `search/general`): **1,069**.
Ledger window: 2026-09-25 19:36 to 2026-09-26 10:43 UTC.

## Per gallery scan

Each file in `public/scans/` carries its full call list (`calls[]`: endpoint, status, credits, latency,
cache flag, and which finding it served). A cache hit keeps the credits and latency of the call that
originally fetched it, which is why the files add up to 1,054 credits while the ledger counts 1,040
for the same run.

| Patient | Chain | Calls | Credits | Time | Breakdown |
|---|---|---:|---:|---:|---|
| GSTOCK | bnb | 172 | 176 | 36 s | 3 context · 90 first-funder · 3 who-bought-sold · 4 flows + 1 flow-intelligence · 1 holders + 70 pnl |
| FP | ethereum | 172 | 176 | 37 s | same shape |
| NOCK | base | 172 | 176 | 53 s | same shape |
| 龙虾 | bnb | 172 | 176 | 43 s | same shape |
| BREW | bnb | 172 | 176 | 36 s | same shape |
| STONK | solana | 83 | 87 | 27 s | 3 context · 4 who-bought-sold · 4 flows + 1 flow-intelligence · 1 holders + 70 pnl (no funder tracing on Solana) |
| ZCAT | solana | 83 | 87 | 43 s | same shape |
| **Total** | | **1,026** | **1,054** | | |

`tgm/holders` costs 5 credits, which is why each scan's credits are 4 above its call count.

Check it yourself (no key, no network):

```bash
node -e 'const i=require("./public/scans/index.json");let n=0,c=0;for(const e of i){const s=require("./public/scans/"+e.file);n+=s.calls.length;c+=s.calls.reduce((a,x)=>a+x.credits,0)}console.log(n+" calls, "+c+" credits in "+i.length+" gallery scans")'
# 1026 calls, 1054 credits in 7 gallery scans
```

In the app, the Evidence tab of LAB RESULTS draws the same list as a waffle, one square per call.
