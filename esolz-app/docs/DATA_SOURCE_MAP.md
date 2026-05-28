# Data Source Map — Sociomonkey Amazon Intelligence
Last updated: 28 May 2026

Every dashboard route and the real data source it uses. Mock status reflects
the state after the Mock Data Removal audit completed 28 May 2026.

---

## Dashboard Routes

### `/dashboard`
| Item | Table / Source |
|---|---|
| Tracked ASIN count | `tracked_asins` |
| Recent snapshots | `asin_snapshots` |
| Plan / usage | `workspace_subscriptions`, `usage_counters` |
| **Mock status** | ✅ None |
| **Empty state** | Yes — "No ASINs tracked yet" |

---

### `/dashboard/asins`
| Item | Table / Source |
|---|---|
| ASIN list | `tracked_asins` |
| Add ASIN | POST `/api/asins/add` → `tracked_asins` insert |
| **Mock status** | ✅ None |
| **Empty state** | Yes — "No ASINs tracked yet. Add your first ASIN." |

---

### `/dashboard/asins/[asin]`
| Item | Table / Source |
|---|---|
| Product header, image, title, brand | `tracked_asins` via `getAsinDetail()` |
| BSR history chart | `asin_snapshots` (bsr column) |
| Price history chart | `asin_snapshots` (price column) |
| KPI cards (BSR, price, rating, reviews, availability) | `asin_snapshots` latest row |
| Buy Box 7-day timeline | `buybox_snapshots` |
| Buy Box checker (live run) | POST `/api/asins/[asin]/buybox` |
| Recent Alerts | `alerts` table, filtered by `tracked_asin_id` |
| Keyword Rank Snapshot | `tracked_keywords` + `keyword_rank_snapshots` |
| Add keyword to track | POST `/api/asins/[asin]/keywords/track` |
| Refresh keyword ranks | POST `/api/asins/[asin]/keywords/refresh` |
| Pincode availability history | `pincode_checks` table |
| Pincode live check | POST `/api/asins/[asin]/pincode` |
| **Mock status** | ✅ None — removed 28 May 2026 |
| **Empty states** | Yes — all sections show "No data yet" messages |

**Notes:**
- Types `BuyBoxPoint`, `KeywordRank`, `AsinAlert` are now defined locally in the page file.
- `mock-asin-detail.ts` is no longer imported anywhere.
- `PincodesTable` dead component was removed; pincode history renders inline.

---

### `/dashboard/bsr`
| Item | Table / Source |
|---|---|
| ASIN list + BSR snapshots | `tracked_asins`, `asin_snapshots` |
| **Mock status** | ✅ None |
| **Empty state** | Yes |

---

### `/dashboard/keywords`
| Item | Table / Source |
|---|---|
| KPI cards (tracked count, page 1, top 10, improved, declined, avg rank) | `tracked_keywords`, `keyword_rank_snapshots` |
| Keyword Research form | POST `/api/keywords/research` (real scraper) |
| Rank Tracking table | `tracked_keywords` + `keyword_rank_snapshots` |
| Rank history chart | `keyword_rank_snapshots` |
| **Mock status** | ✅ None — mock Keyword Groups + Keyword Alerts sections removed 28 May 2026 |
| **Empty state** | Yes — "No keywords tracked yet" |

**Notes:**
- `KEYWORD_GROUPS` (fake clusters with fake volumes) removed.
- `KEYWORD_ALERTS` (fake rank-drop notifications) removed.
- `TrackedKeyword` type still imported from `mock-keywords.ts` (type-only, no data).

---

### `/dashboard/buybox`
| Item | Table / Source |
|---|---|
| Buy Box entries | `buybox_snapshots` (latest per ASIN) |
| Competitor list | `buybox_snapshots` (buy_box_owner aggregation) |
| Alerts sidebar | `alerts` table |
| History chart | `buybox_snapshots` (30-day per ASIN) |
| Live check form | POST `/api/asins/[asin]/buybox` |
| **Mock status** | ✅ None |
| **Empty state** | Yes — "No Buy Box data yet" |

---

### `/dashboard/pincode`
| Item | Table / Source |
|---|---|
| Pincode check history | `pincode_checks` table |
| Run new check | POST `/api/asins/[asin]/pincode` |
| City presets (UI helper only) | `CITY_PRESETS` from `mock-pincode.ts` (static lookup, not data) |
| Utility functions | `parsePincodes`, `scoreToStatus` from `mock-pincode.ts` (pure functions) |
| **Mock status** | ✅ None — `MOCK_PINCODE_RESULTS` not imported |
| **Empty state** | Yes — "No pincode checks yet" |

---

### `/dashboard/alerts`
| Item | Table / Source |
|---|---|
| Alert list | `alerts` table |
| Alert stats (total, critical, warning, opportunity, resolved) | `getAlertStats()` from `mock-alerts.ts` — pure utility on real data |
| **Mock status** | ✅ None — `MOCK_ALERTS` array not imported by page |
| **Empty state** | Yes — "No alerts yet" |

---

### `/dashboard/competitors`
| Item | Table / Source |
|---|---|
| KPI cards | All zero (0) — no backend connected |
| Competitor table | Empty state panel |
| **Mock status** | ✅ None — full rewrite 28 May 2026 |
| **Empty state** | Yes — "Competitor Intelligence is not connected yet. Add competitor ASINs and connect Amazon / SP-API data to begin monitoring." |

**Notes:**
- All fake competitor data (Organic India, Amul, Tata Tea, etc.) removed.
- `mock-competitor-tracker.ts` no longer imported by any page.
- Backend competitor tracking is a future phase (requires SP-API or scraper).

---

### `/dashboard/reports`
| Item | Table / Source |
|---|---|
| Recent reports | `reports` table |
| Report templates (UI metadata — not performance data) | `REPORT_TEMPLATES` from `mock-reports.ts` |
| **Mock status** | ✅ None |
| **Empty state** | Yes — "No reports yet" |

---

### `/dashboard/billing`
| Item | Table / Source |
|---|---|
| Plan details | `subscription_plans` table |
| Current subscription | `workspace_subscriptions` table |
| Usage counters | `usage_counters` table |
| **Mock status** | ✅ None |
| **Empty state** | Yes |

---

### `/dashboard/settings`
| Item | Table / Source |
|---|---|
| Amazon connection status | GET `/api/amazon/connect/status` → `amazon_connections` |
| Connect Amazon | GET `/api/amazon/connect/start` → OAuth flow |
| Disconnect | DELETE `/api/amazon/connect/status` |
| **Mock status** | ✅ None |

---

## SP-API Tables (amazon_*)

| Table | Purpose | Written by |
|---|---|---|
| `amazon_connections` | One row per workspace. Encrypted tokens. | OAuth callback route (admin client) |
| `amazon_audit_logs` | Append-only event log (connect, disconnect, errors) | OAuth routes (admin client) |
| `amazon_marketplaces` | Static lookup (IN, US, GB) | Migration 006 seed |

Token columns `refresh_token_encrypted` and `access_token_encrypted` are **never** returned in any API response.

---

## Mock Library Files — Status After Audit

| File | Status | Used for |
|---|---|---|
| `src/lib/mock-asin-detail.ts` | ⛔ No longer imported anywhere | Was types only — now defined locally |
| `src/lib/mock-competitor-tracker.ts` | ⛔ No longer imported anywhere | Was full fake competitor data |
| `src/lib/mock-keywords.ts` | ⚠️ `TrackedKeyword` type only | Type used by keywords page state |
| `src/lib/mock-bsr-tracker.ts` | ❓ Check if imported | Unknown — grep before deleting |
| `src/lib/mock-buybox.ts` | ⛔ Not imported by buybox page | Buybox page uses real Supabase only |
| `src/lib/mock-data.ts` | ❓ Check if imported | Unknown — grep before deleting |
| `src/lib/mock-pincode.ts` | ✅ Utility only | `CITY_PRESETS`, `parsePincodes`, `scoreToStatus` — acceptable |
| `src/lib/mock-alerts.ts` | ✅ Utility only | `getAlertStats()` operates on real data |
| `src/lib/mock-reports.ts` | ✅ Metadata only | `REPORT_TEMPLATES` are static UI labels |
