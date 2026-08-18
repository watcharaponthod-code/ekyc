# เอกสารส่งมอบ — งานวันที่ 18 ส.ค. 2026

สรุปสิ่งที่เพิ่มเข้ามาในระบบ eKYC ในรอบนี้ 3 เรื่อง: **(1)** ชั้นป้องกันหน้ากาก 3D/ซิลิโคน + เครื่องมือวัดตาม ISO/IEC 30107-3, **(2)** เซิร์ฟเวอร์จดจำใบหน้าบน Railway พร้อม API key สำหรับทดสอบ, **(3)** แอปแยก **local 100 %** (ไม่ใช้เซิร์ฟเวอร์) พร้อม APK บน GitHub Releases

Repo: <https://github.com/watcharaponthod-code/ekyc>

---

## 1. ป้องกันหน้ากาก 3D / ซิลิโคน

### 1.1 ปัญหาเดิม
ทุกชั้นเดิม (MiniFASNet, หันซ้าย/ขวา, กระพริบตา, flash สี, planarity) ออกแบบมาจับ **รูปถ่าย / จอ / วิดีโอ replay** เท่านั้น คนที่ **สวมหน้ากากซิลิโคน** หันหัวได้ กระพริบตาได้ (ตาจริงอยู่หลังรู) สะท้อนแสง flash ได้เหมือนผิวหนัง → ผ่านทุกชั้น (spec เดิมก็ระบุว่า "NOT handled")

### 1.2 สิ่งที่เพิ่ม

| ชั้นใหม่ | ทำอะไร | จับอะไร | สถานะ |
|---|---|---|---|
| **`openMouth` / `smile` challenge** (server ตรวจได้จริง) | เซิร์ฟเวอร์วัด `jawOpen` / `mouthSmile*` จาก MediaPipe blendshapes บนเฟรม challenge เทียบกับเฟรม neutral ของคนเดียวกัน (ต้องผ่านทั้งค่าสัมบูรณ์และ delta) | **หน้ากากแข็ง** (3D-print, resin, กระดาษ, latex) — ขากรรไกรอ้าไม่ได้; ซิลิโคนแบบยืดหยุ่นจับได้บางส่วน | ✅ enforce โดย default; full tier **บังคับมี `openMouth` ทุกครั้ง** สุ่มตำแหน่ง |
| **rPPG pulse liveness** | หลังจบ challenge ให้ผู้ใช้อยู่นิ่ง ~7–8 วิ แอปถ่ายภาพต่อเนื่อง (~60–90 เฟรม) เซิร์ฟเวอร์อ่านสีผิวบริเวณหน้าผาก+แก้มสองข้าง (MediaPipe landmarks) แล้วหา **สัญญาณชีพจร** ในช่วง 0.7–3 Hz ด้วยวิธี POS + เฉลี่ย spectrum 3 จุด | **หน้ากากซิลิโคน / latex** — ไม่มีเลือดไหลเวียน จึงไม่มีชีพจร | ✅ สร้างเสร็จ + ทดสอบบนสัญญาณสังเคราะห์; **`pulse_rule=advisory` โดย default** (บันทึกคะแนน ไม่ตัดสิน) จนกว่าจะวัดบนมือถือจริง |
| identity anchor ของ pulse burst | เฟรมแรก/สุดท้ายของ burst ถูก embed แล้วรวมเข้า identity-consistency check | คนจริงมาถ่ายช่วง pulse แทนคนใส่หน้ากาก | ✅ |
| PAD scope fix | `pad_min` คิดเฉพาะเฟรม challenge (เดิมรวมเฟรม flash สีจัดจนคนจริงอาจโดน PAD_LOW) | false reject | ✅ |
| API key | `EKYC_API_KEYS` → ทุก route ยกเว้น `/v1/health` ต้องส่ง `X-API-Key` | ป้องกัน API เปิดสาธารณะ | ✅ |
| attestation hook | `<EKYCCamera attestation={…}>` ส่ง token Play Integrity / App Attest ในกล่องหลักฐาน | เตรียมสำหรับ injection defence | ✅ (ยังตรวจแค่ "มี token" — ยังไม่ verify กับ Google/Apple) |

reason code ใหม่ที่ client แปลเป็นข้อความไทย/อังกฤษแล้ว: `MOUTH_NOT_OPEN`, `SMILE_ABSENT`, `EXPRESSION_UNVERIFIABLE`, `PULSE_ABSENT`, `PULSE_FRAME_MISSING`

### 1.3 เปิดใช้อย่างไร (server env)
```
EKYC_FLASH_FRAMES=4                # flash สี (เปิดแล้วบน Railway)
EKYC_PULSE_FRAMES=90               # rPPG burst (0 = ปิด)
EKYC_PULSE_DURATION_MS=8000
EKYC_PULSE_RULE=advisory|enforce   # เริ่มที่ advisory วัดก่อน
EKYC_EXPRESSION_RULE=enforce
EKYC_API_KEYS=key1,key2
```
**ข้อจำกัดสำคัญ:** `openMouth/smile` ต้องใช้ backend `deepface` (MediaPipe blendshapes) — backend `onnx` ที่อยู่บน Railway ตอนนี้ **ตรวจไม่ได้** เซิร์ฟเวอร์จะไม่สั่ง challenge นี้เองอัตโนมัติ

### 1.4 ISO/IEC 30107-3 — ทำได้แค่ไหน
- **มาตรฐานนี้ "ผ่าน" ในโค้ดไม่ได้** ต้องให้แล็บที่ได้รับการรับรอง (iBeta, Fime) เอาหน้ากาก/รูป/จอจริงมาโจมตีแล้วนับ
- สิ่งที่ทำให้: **harness วัดแบบเดียวกับแล็บ** — เปิด `EKYC_RETAIN_FRAMES=all` บนเครื่อง evaluation, ติดป้าย session ด้วย `label` (`bona_fide`, `print_a4`, `replay_phone`, `mask_3dprint`, `mask_silicone`, …) แล้วรัน
  ```
  py -3.12 scripts/pad_eval.py <retained_dir> --json eval.json --markdown eval.md
  ```
  ได้ **APCER ต่อ species, BPCER, ACER, APNRR/BPNRR, ช่วงความเชื่อมั่น 95 %** และ "ชั้นไหนจับอะไร" + `--rescore` เพื่อลอง threshold ใหม่โดยไม่ต้องถ่ายซ้ำ
- โปรโตคอลเต็ม (species ที่ต้องเตรียม, จำนวนตัวอย่าง, วิธีอ่านผล, ข้อจำกัด): **`docs/pad-evaluation.md`**
- **ห้ามอ้างว่า "ISO 30107-3 compliant"** ให้ใช้คำว่า "evaluated internally using ISO/IEC 30107-3 metrics" พร้อมแนบตาราง

### 1.5 สิ่งที่ต้องทำต่อ (ลำดับความสำคัญ)
1. **วัด rPPG บนมือถือจริง**: ถ่าย `bona_fide` ≥ 30 คน + `mask_*` แล้วดูการกระจายของ `pulse.score` → ตัดสินใจ `pulse_min` และเปลี่ยนเป็น `enforce`
2. deploy backend `deepface` (หรือเครื่องที่รัน MediaPipe) เพื่อให้ `openMouth` ทำงานจริงบน server ทดสอบ
3. verify attestation token กับ Google/Apple จริง แล้วเปิด `EKYC_REQUIRE_ATTESTATION=true`
4. ทดสอบ print/cut-out/mask จริงตาม `docs/pad-evaluation.md` แล้วค่อยติดต่อแล็บ

ทดสอบอัตโนมัติ: server fast suite **151** (เดิม 84), module **105** (เดิม 96), local package **16**

---

## 2. เซิร์ฟเวอร์จดจำใบหน้าบน Railway (สำหรับทดสอบ)

| | |
|---|---|
| URL | `https://ekyc-api-production-1c11.up.railway.app` |
| Health | `GET /v1/health` (ไม่ต้องใช้ key) |
| Auth | header `X-API-Key: <key>` หรือ `Authorization: Bearer <key>` |
| Key | อยู่ใน Railway → project `ekyc-server` → service `ekyc-api` → Variables → `EKYC_API_KEYS` (**ไม่ได้ commit ลง repo**; ผมแจ้ง key ให้ในแชท) |
| DB | Postgres ของ Railway (`DATABASE_URL` เชื่อมอัตโนมัติ) — ข้อมูลลงทะเบียนคงอยู่ข้าม deploy |
| Backend | `onnx` (SCRFD + ArcFace + MiniFASNet) image ~1 GB; ดึงโมเดลตอน build |
| เปิดใช้ | flash สี 4 เฟรม; pulse ปิด; `EKYC_NEUTRAL_YAW_MAX_DEG=45` (จำเป็นสำหรับ onnx) |

Flow ทดสอบด้วยแอป `apps/example` (build 16): กรอก URL + API key บนหน้าแรกครั้งเดียว (เก็บใน SecureStore) → enroll → identify/verify

deploy ใหม่: `cd server && railway up --service ekyc-api --detach`
บันทึกปัญหาที่เจอ: รอบแรก healthcheck fail เพราะ `startCommand` ใน `railway.json` ใช้ `$PORT` โดยไม่ผ่าน shell → ลบออก ใช้ `CMD` ใน Dockerfile แทน (แก้แล้ว)

รายละเอียด: `server/DEPLOY.md`

---

## 3. แอปแยก local 100 % (`apps/local` + `packages/react-native-ekyc-local`)

### 3.1 ทำอะไร
- **ML Kit** (Google) ทำ coaching + challenge: `center` → สุ่มลำดับ **หันซ้าย · หันขวา · อ้าปาก · พยักหน้า** (ใช้ engine/UI เดิมของ `@ekyc/react-native-ekyc`)
- ถ่ายภาพนิ่ง 1 ภาพต่อท่า → ML Kit ตรวจใบหน้าบนภาพนั้นอีกครั้ง (ได้กรอบ+มุมเอียงแม่นยำ) → crop/หมุนให้ตาอยู่ระดับ/ย่อ 112×112 → **MobileFaceNet (TFLite 5 MB, 192 มิติ)** ฝังอยู่ในแอป → เทียบทุกคู่ภาพ
- **ผ่าน = คู่ที่แย่ที่สุดยังเป็นคนเดียวกัน** (`consistencyMin` 0.45) → รูปที่สลับเข้ามาในบางท่า หรือคนละคนมาทำท่าแทน จะไม่ผ่าน
- ทางเลือก **บันทึกใบหน้าในเครื่อง / ยืนยันกับที่บันทึกไว้** (`matchMin` 0.55) เก็บเป็นตัวเลข 192 ค่าใน storage ส่วนตัวของแอป ไม่ใช่รูป
- ไม่มี network เลย ไม่มีข้อมูลออกจากเครื่อง

### 3.2 ตัวเลขที่ปรับเทียบไว้
MobileFaceNet บน LFW (40 คน, crop จากกรอบใบหน้าไม่ align): genuine median 0.59 / p10 0.30, impostor median 0.21 / p95 0.47 / p99 0.56 → ภาพในเซสชันเดียวกันจะคล้ายกันกว่านี้มาก หน้าจอผลลัพธ์ในแอปพิมพ์คะแนนทุกคู่ให้ดูเพื่อปรับ threshold กับผู้ใช้จริง

### 3.3 ข้อจำกัด (ต้องบอกผู้ใช้งาน)
บนเครื่อง **ไม่มี PAD** — วิดีโอคนจริงบนจอที่หัน/อ้าปาก/พยักหน้าตามจะผ่านได้ ตัวนี้เหมาะกับ step-up ความเสี่ยงต่ำ ("ยังเป็นคนเดิมอยู่ไหม") ไม่ใช่ onboarding; งานที่ต้องกันการปลอมให้ใช้ตัว server

### 3.4 APK
- build จาก `apps/local`: `expo prebuild --platform android` → `./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a` (proguard + shrinkResources เปิด, arm64 อย่างเดียวเพื่อให้ไฟล์เล็ก)
- เผยแพร่บน **GitHub Releases** ของ repo (ดูลิงก์ในแชท/README) — ติดตั้งแล้วเปิดแอป จะเห็นสถานะโมเดล และปุ่ม "เริ่มสแกน", "บันทึกใบหน้าฉัน", "ยืนยันว่าเป็นคนที่บันทึกไว้"
- เซ็นด้วย debug keystore (สำหรับทดสอบ) — ก่อนแจกจริงต้องสร้าง keystore ของทีม

---

## 4. ไฟล์สำคัญ

| ไฟล์ | คืออะไร |
|---|---|
| `server/app/decision.py` | กฎตัดสินทั้งหมด รวม `_check_expression`, `_check_pulse` |
| `server/app/pulse.py` | rPPG scorer (POS + multi-patch prominence) |
| `server/app/services/retention.py` | เก็บหลักฐานสำหรับ evaluation |
| `server/scripts/pad_eval.py` | คำนวณ APCER/BPCER/ACER |
| `docs/pad-evaluation.md` | โปรโตคอลประเมินตาม ISO/IEC 30107-3 |
| `packages/react-native-ekyc/src/liveness/mouth.ts` | วัดการอ้าปากจาก ML Kit contours |
| `packages/react-native-ekyc-local/` | แพ็กเกจ local (identity.ts, embedder.ts, LocalLivenessCamera.tsx) |
| `apps/local/` | แอป APK local |
| `server/DEPLOY.md` | Railway |
