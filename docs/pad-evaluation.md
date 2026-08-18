# PAD evaluation — measuring this system the way ISO/IEC 30107-3 does

**Purpose.** Before anyone claims this system resists masks, someone has to
put masks in front of it and count. This document is the protocol for doing
that in-house, in the vocabulary a certification lab (iBeta, Fime, TÜV) uses,
so the numbers are comparable and the gaps are visible *before* the lab finds
them. It is not a certification and cannot become one — certification is the
lab running *its* artefacts under *its* protocol.

## 1. What the standard measures

ISO/IEC 30107-3 defines the metrics; a lab's "Level" programme (iBeta Level 1
/ Level 2, aligned to the standard) defines *which* presentation-attack
instruments (PAIs) are used.

| metric | meaning | reported as |
|---|---|---|
| **APCER** (attack presentation classification error rate) | attack presentations wrongly accepted as bona fide | one value **per PAI species**; when a single number is quoted it is the **worst species** |
| **BPCER** (bona fide presentation classification error rate) | genuine presentations wrongly rejected | one value |
| **ACER** | (APCER<sub>max</sub> + BPCER) / 2 | informational |
| **APNRR / BPNRR** | presentations the system could not classify at all (no face acquired, protocol failure) | separately, never folded into APCER/BPCER |

Every rate carries a confidence interval; a 0 / 30 result is "≤ ~11 % at
95 %", not "0 %".

`server/scripts/pad_eval.py` computes exactly these from retained sessions.

## 2. PAI species to present

Name every session with the label below (`CreateSessionRequest.label` /
`<EKYCCamera evaluationLabel="…">`). Bona fide sessions are `bona_fide`.

| level | label | what | which layer is *supposed* to catch it |
|---|---|---|---|
| — | `bona_fide` | the real subject, cooperating | — |
| 1 | `print_a4_matte` | A4 photo of the subject, matte paper | MiniFASNet PAD, active flash, blink/turn/mouth impossible |
| 1 | `print_a4_glossy` | same, glossy | as above |
| 1 | `print_cutout` | print with the eyes / mouth cut out, worn | PAD, flash, `openMouth` (paper does not articulate), rPPG |
| 1 | `replay_phone` | subject's video on a phone screen | PAD (screen border/moiré), flash (cannot follow a random sequence), random challenge order |
| 1 | `replay_tablet` | same on a tablet / laptop | as above |
| 1 | `replay_challenge` | a video of the subject *doing* the challenges, replayed | flash, challenge order, timing plausibility |
| 2 | `mask_paper` | paper mask with eye/mouth holes, worn | PAD, `openMouth`, rPPG |
| 2 | `mask_3dprint` | rigid 3-D-printed mask, painted | **`openMouth`** (a rigid jaw cannot open), rPPG, planarity is *not* expected to help |
| 2 | `mask_latex` | flexible latex mask, worn | `openMouth` (limited articulation), **rPPG** (no perfusion) |
| 2 | `mask_silicone` | high-quality silicone mask, worn | **rPPG** — the only layer designed for it; `openMouth` partial |
| 2 | `mask_resin` | resin / half-mask | `openMouth`, rPPG |
| inj | `inject_virtual_cam` | pre-recorded / deepfake stream via a virtual camera on a rooted device | frame-hash duplication, flash-binding, **attestation** (only when required and cryptographically verified — not yet) |

Present each species by **several subjects** and under **at least two lighting
conditions** (office ~300 lx, dim ~50 lx). Attack presentations must be made
by someone *trying* to pass — hold the print at the distance that fills the
oval, angle it to kill glare, wear the mask properly. A half-hearted attack
that fails tells you nothing.

## 3. Sample sizes

The harness warns below 30 presentations per species. Treat 30 as the floor
for a first look and 100+ per species before quoting a rate; the interval
printed next to each number is the honest statement of what you know.

## 4. Recording

On a **dedicated evaluation deployment** (never production):

```
EKYC_RETAIN_FRAMES=all
EKYC_FRAMES_DIR=/data/eval            # a disk you will wipe afterwards
EKYC_FLASH_FRAMES=4                    # every layer on
EKYC_PULSE_FRAMES=90 EKYC_PULSE_DURATION_MS=8000
EKYC_PULSE_RULE=advisory               # measure first, enforce later (see §6)
EKYC_EXPRESSION_RULE=enforce
EKYC_API_KEYS=<eval-key>
```

Each session lands at `<FRAMES_DIR>/<label>/<session_id>/` with every frame,
the manifest and the decision. Retention writes real faces to disk: get
consent from every bona fide subject, keep the disk encrypted, wipe it when
the run is over.

## 5. Scoring

```
py -3.12 scripts/pad_eval.py /data/eval --json eval.json --markdown eval.md
```

Output, per species: n, classified, accepted, APCER with 95 % CI, APNRR, and
**which reason codes caught the rejections** (`PAD_LOW×12, FLASH_SPOOF×9,
MOUTH_NOT_OPEN×30 …`) plus the scores of every attack that got through. Bona
fide: BPCER, its CI, and the false-reject reasons.

To evaluate a threshold change without re-presenting anything:

```
EKYC_PULSE_RULE=enforce EKYC_PULSE_MIN=0.6 py -3.12 scripts/pad_eval.py /data/eval --rescore
```

`--rescore` re-runs the full pipeline on the retained frames with the current
backend and thresholds.

## 6. How to read the result against the layers

| you see | it means | do |
|---|---|---|
| `mask_silicone` APCER high, all accepted sessions have `pulse.score` < 0.5 | rPPG *sees* the mask but the rule is advisory | set `EKYC_PULSE_RULE=enforce` after checking bona fide `pulse.score` distribution stays above `pulse_min` (else BPCER explodes) |
| bona fide `pulse.score` widely spread / low | burst too short, too dark, too much motion, JPEG noise | raise `pulse_frames`/`duration`, demand better light in the UI, or accept the layer stays advisory — and *say so* |
| `mask_3dprint` accepted with `openMouth.value` high | the mask has a hinged jaw or the wearer's mouth is visible through a hole | raise `mouth_open_min`, and rely on rPPG |
| `print_*` accepted | PAD threshold or flash calibration | inspect `pad`/`flash` scores of the accepted; the flash gate should already be catching these — check `EKYC_FLASH_FRAMES` was on |
| BPCER > ~3 % | a layer is too strict for real users | look at the false-reject reason histogram, tune *that* gate only |

## 7. What passing means, and what it does not

- Internally: APCER 0 with a tight interval on every Level 1 species, and a
  low APCER on Level 2 with rPPG enforced, at a BPCER users will tolerate.
- Publicly: **nothing** until an accredited lab has run its own protocol. Do
  not describe the system as "ISO 30107-3 compliant" on the strength of this
  document; describe it as "evaluated internally using ISO/IEC 30107-3
  metrics", with the table attached.

## 8. Known limits going in

Stated so nobody discovers them at the lab:

- rPPG is calibrated on synthetic traces only (`server/tests/test_pulse.py`).
  It separates cleanly when the pulse amplitude is ≥ ~2× the per-frame colour
  noise; at ≈1× it overlaps. Phone JPEG snapshots at 8–15 fps over 7–8 s are
  at the marginal end. **Advisory until measured.**
- `openMouth` defeats rigid masks by construction; a flexible silicone mask
  driven by the wearer's jaw may open enough. rPPG is the answer there, not
  the mouth.
- Attestation is presence-only; a rooted device with an injected stream is
  not stopped until Play Integrity / App Attest tokens are verified.
- Every threshold except the flash/pulse gates was calibrated on Western
  datasets and one vendor's selfies; the bona fide side needs the target
  population.
