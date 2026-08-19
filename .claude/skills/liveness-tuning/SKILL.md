---
name: liveness-tuning
description: Diagnose and tune why eKYC liveness sessions fail (server flow on Railway/laptop or the 100% on-device flow) — always from measured session data, never by hand-editing thresholds. Use when pass rates are low or inconsistent, before changing any gate.
---

# Liveness tuning — measure first, then move a threshold

Every threshold in this repo has a documented origin (`server/app/config.py`,
`packages/react-native-ekyc/src/liveness/challenges.ts` → `CHALLENGE_DEFAULTS`).
Do not edit one without a number from a real session that says why.

## 0. Work in a worktree
```
git worktree add -b tuning/<topic> ../ekyc-<topic> master
cd ../ekyc-<topic>
cmd /c "mklink /J node_modules C:\tokintech\EKYC\ekyc\node_modules"     # Windows
cmd /c "mklink /J server\.venv  C:\tokintech\EKYC\ekyc\server\.venv"
```
Tests run there unchanged: `npm test`, `cd server && .venv/Scripts/python -m pytest -q`.

## 1. Get the failure data
**Server flow** (Railway or laptop) — every decision is in the audit table:
```
curl -H "X-API-Key: $KEY" https://ekyc-api-production-1c11.up.railway.app/v1/audit?limit=200
# or offline: cd server && py scripts/audit_report.py --limit 500
```
Read: `summary.reasons` (which gate), `summary.scores.<gate>` percentiles (how far
from the threshold), then individual `recent[]` rows. Phone-side telemetry
lands in the same server log as `client` lines (`step … best/needed`,
`liveness failed …`).

**Local flow** — the app writes `ekyc-local-sessions.jsonl` (numbers only) and
has a "แชร์ log" button. Then:
```
python packages/react-native-ekyc-local/scripts/local_calibrate.py <log.jsonl>
```
Read: per-challenge "best reached vs needed", identity star-min distribution,
pulse distribution, failure histogram.

## 2. Decide by gate, not by feel
| symptom | look at | change |
|---|---|---|
| `LOCAL_timeout` / `POSE_INSUFFICIENT_TURN` | `stepMetrics` best vs needed | client margin (`tuningFromPolicy`) or server `turn_yaw_min_deg` — only with data on both sides |
| `IDENTITY_INCONSISTENT` (local) | `consistency.min` p5 of genuine sessions | `consistencyMin` (star topology already; keep ≥ LFW impostor tail) |
| `PAD_LOW` | `scores.pad` p10 of genuine | re-measure MiniFASNet on this camera/lighting before moving `pad_min` |
| `FLASH_SPOOF` / low `flash` | `scores.flash` distribution | keep `flash_rule=advisory` until genuine p10 > flash_min |
| pulse never ≥ 0.5 | `pulse.samplingHz`, `prominenceDb` | burst too slow/dark; do not enforce |

Rules: (a) a gate stays **advisory** until real sessions clear it; (b) client
thresholds derive from server policy + margin, never a second copy; (c) every
change ships with a test and a line in `docs/liveness-hardening.md`.

## 3. Verify before merge
- `npm test` (core + local packages) and server fast suite green
- typecheck all three (`packages/*`, `apps/*`)
- rebuild APK for the flow you touched, run the emulator smoke (`/run`), then
  `gh release create/upload`
- redeploy server: `cd server && railway up --service ekyc-api --detach`
