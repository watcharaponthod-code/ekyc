# eKYC Module (React Native) — Liveness + Face Recognition, on-device — Design Spec

- Date: 2026-08-17
- Status: **DRAFT — รอ review ก่อนเขียน implementation plan**
- Scope: โมดูล RN ที่ (1) ตรวจว่าเป็นมนุษย์จริงด้วย active liveness (กะพริบตา / หันซ้าย / หันขวา / ยิ้ม), (2) สร้าง face embedding แล้วบันทึกไว้ในเครื่อง, (3) ยืนยันตัวตนภายหลังด้วยการเทียบ embedding — ทั้งหมดรันบนมือถือ ไม่มี server

---

## 0. คำตัดสินต่อฟีเจอร์ (ตอบตารางที่ให้มา)

| ฟีเจอร์ | ใช้อะไร | ทำไม (blunt) |
|---|---|---|
| เทียบหน้าจริงกับหน้าบนบัตร | **FaceNet-512 (TFLite) ผ่าน `react-native-fast-tflite`** + MLKit image detector หา bbox บนรูปบัตร | DeepFace = Python library, **รันบนมือถือใน RN ไม่ได้เลย** ไม่ใช่แค่ "ทำได้ยาก" — ตัดทิ้ง MediaPipe ไม่มี face embedder — ตัดทิ้ง ต้องใช้ TFLite model เอง ตัวเดียวกับข้อ recognition |
| Face Mesh 3D (468 จุด) | **ไม่ใช้** | Liveness ต้องการแค่ yaw / pitch / roll + ค่า eye-open / smile probability ซึ่ง MLKit ให้ตรงๆ อยู่แล้ว mesh 468 จุดคือของเกินความจำเป็น และ `react-native-mediapipe` release ล่าสุด v0.6.0 (ธ.ค. 2024) ไม่รองรับ VisionCamera v5 — เอามาใช้คือแบก dependency ตาย |
| Liveness Check | **MLKit Face Detection** ผ่าน `react-native-vision-camera-face-detector` v2 (active challenges) | ได้ `yawAngle/pitchAngle/rollAngle`, `leftEyeOpenProbability/rightEyeOpenProbability`, `smilingProbability`, `bounds` ทุกเฟรม โดยไม่ต้องเขียน worklet เอง (`onFacesDetected` callback บน JS thread) เบา เร็ว maintained (v2.0.6 ก.ค. 2026) |
| ประมวลผลฝั่ง Client | **ทั้งหมด on-device**: MLKit + TFLite + MMKV (encrypted) | ตรงโจทย์ "ทำได้ใน local มือถือ" ไม่มี network dependency ข้อมูลใบหน้าไม่ออกจากเครื่อง |

สรุป: **MediaPipe (concept) → ในโลก RN ใช้ MLKit ตัวพี่น้องของ Google แทน** สำหรับ detection/liveness และ **TFLite FaceNet** สำหรับ recognition DeepFace ไม่อยู่ในสมการ

---

## 1. Goals / Non-goals

**Goals**
1. Enroll: ผ่าน liveness → ถ่ายภาพ → embedding → บันทึก `{id, name, embedding}` ในเครื่อง
2. Verify (1:1): ผ่าน liveness → embedding → เทียบกับ person ที่ระบุ → `{ok, score}`
3. Identify (1:N): ผ่าน liveness → embedding → หาคนที่ใกล้สุดใน store → `{person, score} | null`
4. ห่อเป็นโมดูล public API เล็กๆ ให้ทีมเรียกใช้ได้ใน 10 บรรทัด โค้ดสั้น อ่านง่าย OOP
5. Logic (liveness state machine, similarity, store) เป็น pure TS ทดสอบด้วย jest ได้โดยไม่ต้องมี device

**Non-goals (รอบนี้)**
- OCR อ่านข้อมูลบนบัตร / NFC chip
- Server-side verification, sync, audit log
- Passive anti-spoofing (deepfake/video replay) — เป็น Phase เสริม (ดู §12)
- Face mesh / AR overlay

---

## 2. Stack (verify กับ npm registry วันที่ 2026-08-17)

| Layer | Package | Version | บทบาท |
|---|---|---|---|
| App framework | `expo` (development build, **ไม่ใช่ Expo Go**) | 57.0.13 | prebuild + EAS; New Architecture default (Nitro ต้องการ) |
| Camera | `react-native-vision-camera` (+ `react-native-nitro-modules`, `react-native-nitro-image`) | 5.2.2 | preview, photo output (in-memory `Photo`) |
| Face detection | `react-native-vision-camera-face-detector` | 2.0.6 | MLKit: frame detector (`useFaceDetectorOutput` / wrapper `<Camera onFacesDetected>`) + `useImageFaceDetector` สำหรับไฟล์ภาพ |
| Embedding runtime | `react-native-fast-tflite` | 3.0.1 | โหลด `.tflite`, `model.run([buffer])` (Nitro, GPU delegate optional) |
| Image ops | `react-native-nitro-image` (มากับ VisionCamera v5 อยู่แล้ว) | 0.15.1 | `Images.loadFromFile` → `.crop()` → `.resize(160,160)` → `.toRawPixelData()` — ไม่ต้องเพิ่ม dep |
| Storage | `react-native-mmkv` (encryption key เก็บใน `expo-secure-store`) | 4.3.2 | key-value เข้ารหัส เก็บ embedding + metadata |
| Model | `facenet_512.tflite` (Apache-2.0, ~24 MB, input 160×160×3 float32, output 512-d) จาก repo `shubham0204/FaceRecognition_With_FaceNet_Android` | — | preprocessing = per-image standardize `(x-mean)/std` |

ทำไมไม่ใช้ MobileFaceNet (5 MB): ความแม่นยำสำคัญกว่าขนาดในงาน eKYC และ embed ทำครั้งเดียวต่อ session (~200-500 ms ไม่สำคัญ) ถ้าขนาด app เป็นปัญหาจริง สลับได้ที่ `FaceEmbedder` จุดเดียว (input size + normalize) — flip condition: app-size budget < 30 MB

Frame processor / worklet: **โค้ดเราไม่มี worklet เลย** face-detector ส่ง `Face[]` มาที่ JS thread ผ่าน callback ส่วน embedding ทำจากไฟล์ภาพแบบ async บน JS thread หลัง liveness ผ่าน (ครั้งเดียว) → เข้าใจง่าย debug ง่าย และเป็น code path เดียวกับรูปบัตร/รูปจาก gallery

---

## 3. Architecture (OOP, แยก unit ชัด)

```
src/ekyc/
  index.ts                  # public API เท่านั้น
  types.ts                  # FaceSignal, Person, MatchResult, LivenessState, EKYCConfig
  liveness/
    Challenge.ts            # abstract class Challenge
    challenges.ts           # HoldStill, Blink, TurnLeft, TurnRight, Smile  (คลาสละ ~8 บรรทัด)
    LivenessSession.ts      # state machine: feed(faces) → LivenessState  (pure TS)
  face/
    FaceFinder.ts           # wrap createImageFaceDetector(): findLargestFace(uri) → Bounds
    FaceEmbedder.ts         # TFLite FaceNet: embed(uri, bounds) → Float32Array; static cosine()
  store/
    FaceStore.ts            # interface FaceStore
    MmkvFaceStore.ts        # encrypted MMKV impl (default)
  EKYC.ts                   # facade: enroll / verify / identify (compose Finder+Embedder+Store)
  ui/
    EKYCCamera.tsx          # Camera + overlay + LivenessSession → onPassed(photoUri)
    Overlay.tsx             # วงรี + ข้อความคำสั่ง + progress dots (dumb component)
```

| Unit | ทำอะไร | ใช้ยังไง | พึ่งอะไร |
|---|---|---|---|
| `Challenge` (abstract) | นิยาม 1 ด่าน: `label`, `check(signal): boolean`, `reset()` | subclass ทับ `check` | ไม่พึ่งอะไร |
| `LivenessSession` | รับ `Face[]` ทีละเฟรม เดินด่านตามลำดับ (สุ่มลำดับได้) จับ timeout ต่อด่าน/รวม คืน `LivenessState` | `new LivenessSession(challenges, opts).feed(faces)` | `Challenge`, `types` |
| `FaceFinder` | หา bbox หน้าที่ใหญ่สุดในไฟล์ภาพ (ใช้ทั้ง selfie และรูปบัตร) | `await finder.findLargestFace(uri)` | face-detector (image mode) |
| `FaceEmbedder` | crop → resize 160 → standardize → run TFLite → L2-normalize | `await embedder.embed(uri, bounds)`; `FaceEmbedder.cosine(a,b)` | nitro-image, fast-tflite |
| `FaceStore` / `MmkvFaceStore` | `save(person)`, `get(id)`, `all()`, `remove(id)` | inject เข้า `EKYC` | mmkv, secure-store |
| `EKYC` (facade) | รวม flow enroll/verify/identify + threshold | `new EKYC({ store, threshold })` | Finder, Embedder, Store |
| `EKYCCamera` | UI เดียวของโมดูล: กล้องหน้า + overlay + session; liveness ผ่าน → `takePhoto()` → `onPassed(photoUri)` | `<EKYCCamera onPassed onFailed onProgress />` | vision-camera, face-detector, `LivenessSession` |

กติกา: `liveness/`, `store/FaceStore.ts`, `FaceEmbedder.cosine` = pure TS ไม่ import react-native → jest ธรรมดา ส่วนที่แตะ native (`FaceFinder`, `FaceEmbedder.embed`, `MmkvFaceStore`, `ui/`) บางที่สุด

---

## 4. Flows

### 4.1 Enroll
```
<EKYCCamera onPassed={uri => ekyc.enroll(uri, { name })} />
  EKYCCamera: onFacesDetected(faces) → session.feed(faces) → state.status === 'passed'
            → photoOutput.takePhoto() → photo.saveToTemporaryFileAsync() → onPassed(uri)
  EKYC.enroll(uri, meta):
     bounds = finder.findLargestFace(uri)          // throw NO_FACE / MULTIPLE_FACES
     emb    = embedder.embed(uri, bounds)
     person = { id: uuid, name, embedding: Array.from(emb), createdAt }
     store.save(person) → return person
```

### 4.2 Verify (1:1)
```
EKYC.verify(uri, personId):
     emb   = embed(uri)                              // finder + embedder เหมือนข้างบน
     score = cosine(emb, store.get(personId).embedding)
     return { ok: score >= threshold, score }
```

### 4.3 Identify (1:N)
```
EKYC.identify(uri):
     emb  = embed(uri)
     best = argmax over store.all() of cosine        // linear scan; พอสำหรับ < ~2,000 คน
     return best.score >= threshold ? { person, score } : null
```

### 4.4 (Phase 5, optional) เทียบกับหน้าบนบัตร
```
EKYC.compare(selfieUri, idCardUri): score = cosine(embed(selfieUri), embed(idCardUri))
```
ใช้ `FaceFinder` ตัวเดิม แต่ตั้ง `minFaceSize: 0.05` เพราะหน้าบนบัตรเล็กในเฟรม — ไม่มีโค้ดใหม่นอกจาก 1 method

---

## 5. Liveness design

### 5.1 Signal (map จาก MLKit `Face` ทุกเฟรม, ≤ ~15 fps)
```ts
type FaceSignal = {
  count: number            // จำนวนหน้าในเฟรม
  yaw: number; pitch: number; roll: number     // องศา
  leftEye: number; rightEye: number; smile: number   // 0..1
  box: { x: number; y: number; w: number; h: number }  // สัดส่วน 0..1 ของเฟรม
  t: number                // timestamp ms
}
```
Detector options: `performanceMode: 'fast'`, `runClassifications: true`, `runLandmarks: false`, `runContours: false`, `trackingEnabled: false`, `cameraFacing: 'front'`

### 5.2 Gate ก่อนทุกด่าน (`HoldStillChallenge`)
`count === 1` และ `box` อยู่ในวงรีกลางจอ (w ระหว่าง 0.35–0.75 ของเฟรม) และ `|yaw| < 10`, `|pitch| < 10` ค้างครบ 500 ms → ผ่าน ถ้าระหว่างด่านใดๆ `count !== 1` นาน > 1 s → session fail (`reason: 'lost_face' | 'multiple_faces'`)

### 5.3 ด่าน (default set)
| Challenge | ผ่านเมื่อ | หมายเหตุ |
|---|---|---|
| `Blink` | ทั้งสองตา `< 0.3` แล้วกลับมา `> 0.7` ภายใน 1 s (state 2 ขั้น: `sawClosed`) | กันภาพนิ่ง |
| `TurnLeft` | `yaw * SIGN >= 25°` แล้วกลับมา `\|yaw\| < 10` | `SIGN` (+1/-1) เป็น config เพราะกล้องหน้า mirror; calibrate บนเครื่องจริงใน Phase 1 |
| `TurnRight` | ตรงข้าม `TurnLeft` | |
| `Smile` | `smile > 0.7` | optional, เปิดผ่าน config |

- ลำดับ: `HoldStill` เสมอก่อน จากนั้น **shuffle** `[Blink, TurnLeft, TurnRight]` (+ `Smile` ถ้าเปิด) — กัน replay video ที่อัดตามลำดับตายตัว
- Timeout: 8 s ต่อด่าน, 45 s รวม → `failed` พร้อม `reason: 'timeout'`
- Debounce: ตัดสินจากเฟรมติดกัน ≥ 3 เฟรม ไม่ใช่เฟรมเดียว (กัน noise ของ MLKit)
- Threshold ทั้งหมดอยู่ใน `LivenessOptions` object เดียว (default ตามข้างบน) ไม่ hard-code กระจาย

### 5.4 State machine
```
idle → running(HoldStill) → running(ch[0]) → ... → passed
                 └──── timeout / lost_face / multiple_faces ────→ failed
```
`LivenessState = { status: 'idle'|'running'|'passed'|'failed', step: number, total: number, label: string, reason?: string }` — UI แค่ render state นี้

---

## 6. Face embedding

1. `FaceFinder.findLargestFace(uri)` → MLKit image detector (`performanceMode: 'accurate'`) → เอาหน้าที่ `bounds` ใหญ่สุด; ถ้าไม่มี → `EKYCError('NO_FACE')`; ถ้าโหมด strict และ > 1 หน้า → `EKYCError('MULTIPLE_FACES')`
2. ขยาย bbox 20% ทุกด้าน (clamp กับขอบภาพ) → `Images.loadFromFile(uri).crop(x1,y1,x2,y2).resize(160,160).toRawPixelData()`
3. แปลง RGBA/RGB uint8 → `Float32Array(160*160*3)` แล้ว standardize ต่อภาพ: `(x - mean) / max(std, 1/sqrt(n))` (ตาม FaceNet reference)
4. `model.run([input])` → `Float32Array(512)` → L2-normalize
5. Similarity = cosine (embedding normalized แล้ว = dot product)

**Threshold**: เริ่มที่ **0.60** และ **ต้อง calibrate** ใน Phase 4 ด้วยชุดภายใน ≥ 20 คน × 3 ภาพ (แสงต่างกัน / แว่น / ไม่แว่น) — เลือกจุดที่ FAR ≈ 0.1% แล้วดู FRR ที่ได้ ตัวเลข 0.60 เป็นจุดตั้งต้นจากลักษณะ FaceNet-512 ไม่ใช่ค่าที่พิสูจน์แล้ว

**Model file**: bundle ใน app (`assets/models/facenet_512.tflite`, เพิ่ม `tflite` ใน `metro.config.js assetExts`) โหลดครั้งเดียวตอน `EKYC` สร้าง (`loadTensorflowModel(require(...))`) ไม่ต้อง GPU delegate ก่อน — CPU ที่ 160×160 ครั้งเดียวเร็วพออยู่แล้ว เปิด `core-ml`/`android-gpu` เฉพาะถ้าวัดแล้ว > 1 s

---

## 7. Storage

```ts
type Person = { id: string; name: string; embedding: number[]; createdAt: number }
interface FaceStore {
  save(p: Person): Promise<void>
  get(id: string): Promise<Person | undefined>
  all(): Promise<Person[]>
  remove(id: string): Promise<void>
}
```
- `MmkvFaceStore`: MMKV instance `id: 'ekyc'`, `encryptionKey` = random 16-byte สร้างครั้งแรกแล้วเก็บใน `expo-secure-store` (Keychain / Keystore) key `person:<id>` = JSON, key `ids` = string[]
- Embedding 512 float ≈ 4 KB/คน — 1,000 คน = 4 MB — MMKV รับได้สบาย
- **ไม่เก็บรูปถ่าย** เก็บแค่ embedding (ลด PDPA surface) รูป temp ลบหลัง embed เสร็จ
- ทีมสลับเป็น SQLite/server ได้โดย implement `FaceStore` อีกตัว ไม่แตะที่อื่น

---

## 8. Public API (สิ่งเดียวที่ทีมเห็น)

```ts
// index.ts
export { EKYC } from './EKYC'
export { EKYCCamera } from './ui/EKYCCamera'
export { MmkvFaceStore } from './store/MmkvFaceStore'
export type { Person, MatchResult, LivenessState, FaceStore, EKYCConfig } from './types'

// การใช้งานฝั่งทีม (ทั้งหมดที่ต้องรู้)
const ekyc = new EKYC({ store: new MmkvFaceStore(), threshold: 0.6 })

// หน้าจอ enroll
<EKYCCamera
  onPassed={async uri => setPerson(await ekyc.enroll(uri, { name }))}
  onFailed={reason => alert(reason)}
/>

// หน้าจอ verify
<EKYCCamera onPassed={async uri => setResult(await ekyc.verify(uri, person.id))} />
```
`EKYCCamera` props: `onPassed(uri)`, `onFailed(reason)`, `onProgress?(state)`, `challenges?: ChallengeName[]`, `options?: Partial<LivenessOptions>` — จบ

---

## 9. Error handling

- ทุก error จาก facade เป็น `EKYCError { code: 'NO_FACE'|'MULTIPLE_FACES'|'MODEL_NOT_LOADED'|'PERSON_NOT_FOUND'|'CAMERA_PERMISSION'|'STORE_IO', message }` — ทีม `switch(code)` ได้
- Liveness fail ไม่ throw — ส่งผ่าน `onFailed(reason)` แล้ว `EKYCCamera` reset session ให้กด "ลองใหม่"
- Camera permission: `EKYCCamera` ขอเองตอน mount ถ้าถูกปฏิเสธ → `onFailed('CAMERA_PERMISSION')`
- Model โหลดไม่ขึ้น (ไฟล์หาย/เครื่องไม่รองรับ) → `EKYC` constructor reject ตั้งแต่ต้น ไม่ให้ไปตายกลางทาง

---

## 10. Testing

| ระดับ | อะไร | เครื่องมือ |
|---|---|---|
| Unit (jest, ไม่ต้องมี device) | `Challenge` ทุกตัว, `LivenessSession` (feed สตรีม `FaceSignal` สังเคราะห์: ผ่านปกติ / timeout / lost face / multiple faces / shuffle), `FaceEmbedder.cosine`, `EKYC.identify` argmax + threshold ด้วย mock Store/Embedder | jest + ts |
| Device (manual checklist ใน `docs/qa-checklist.md`) | iPhone 1 เครื่อง + Android กลางๆ 1 เครื่อง: FPS detection ≥ 15, embed < 1 s, enroll→verify same person ผ่าน, different person ไม่ผ่าน | เครื่องจริง (MLKit ไม่มี arm64 iOS simulator) |
| Attack test (Phase 4) | ภาพพิมพ์ / ภาพบนจอมือถืออีกเครื่อง / วิดีโอ replay ที่กะพริบตา — บันทึกผลตรงๆ ว่าอันไหนหลุด | เครื่องจริง |
| Calibration (Phase 4) | ≥ 20 คน × 3 ภาพ → ตาราง same/different score → เลือก threshold | script เล็กในแอป dev |

---

## 11. Phases (แต่ละ phase จบด้วยของที่รันได้)

| Phase | ส่งมอบ | เกณฑ์เสร็จ |
|---|---|---|
| **0 Scaffold** | Expo 57 app (dev build), ติดตั้ง VisionCamera 5 + face-detector 2 + fast-tflite 3 + mmkv + secure-store, permissions ใน `app.json`, กล้องหน้าขึ้น + log จำนวนหน้า | build ผ่านทั้ง iOS/Android, เห็น `faces.length` ใน console |
| **1 Liveness** | `Challenge` + `LivenessSession` + unit tests, `EKYCCamera` + `Overlay` ทำงานจริง, calibrate `SIGN` ของ yaw | ผ่านด่าน blink/ซ้าย/ขวา บนเครื่องจริง, ภาพพิมพ์ไม่ผ่าน blink, jest เขียว |
| **2 Embedding + Store** | `FaceFinder`, `FaceEmbedder`, `MmkvFaceStore`, `EKYC` facade | enroll → verify (คนเดิม) score สูง, คนอื่น score ต่ำ ในแอป dev |
| **3 Module packaging** | ย้าย `src/ekyc/` → `packages/react-native-ekyc/` (yarn workspace, peerDeps), README การใช้ 10 บรรทัด, example app ใช้ผ่าน package | ทีมลาก package ไปใส่แอปอื่นได้โดยไม่แก้โค้ดโมดูล |
| **4 Calibration + attack tests** | ตาราง threshold, `qa-checklist.md`, ปรับ default | threshold มีที่มาจากข้อมูล ไม่ใช่เดา; ผล attack test เขียนไว้ตรงๆ |
| **5 Optional** | (a) `EKYC.compare(selfie, idCard)`; (b) passive anti-spoof `MiniFASNet` (`spoof_model_scale_2_7.tflite`, 6 MB, Apache-2.0) เป็น `Challenge` เพิ่ม | เปิดเมื่อ business ต้องการ |

Phase 0–3 คือ scope หลัก Phase 4 ต้องทำก่อน production Phase 5 ตามความต้องการ

---

## 12. ข้อจำกัดที่ต้องรู้ (ไม่แต่งสวย)

1. **Active liveness (blink/turn) กันได้แค่ภาพนิ่ง/ภาพพิมพ์/ภาพบนจอที่ไม่ขยับ** — วิดีโอ replay ที่อัดคนกะพริบ+หัน หรือ deepfake แบบ real-time **ผ่านได้** การสุ่มลำดับ + timeout สั้นทำให้ยากขึ้นแต่ไม่ปิดช่อง ถ้าต้องการระดับ bank-grade ต้องมี passive anti-spoof model (Phase 5b) หรือ vendor SDK ที่มี certification (iBeta) — ตัดสินใจเรื่องนี้ก่อน production
2. MLKit `pitchAngle` ไม่นิ่งเท่า yaw → ไม่ใช้ "พยักหน้า" เป็นด่าน default
3. FaceNet-512 ไม่ได้ train บนใบหน้าเอเชียเป็นหลัก → threshold ต้อง calibrate กับกลุ่มผู้ใช้จริง (Phase 4) ห้ามเอา 0.60 ไป production เฉยๆ
4. Embedding = ข้อมูลชีวมิติ ตาม PDPA — เก็บเข้ารหัสในเครื่องอย่างเดียว, มี `remove(id)`, ไม่เก็บภาพ; ถ้าอนาคต sync ขึ้น server ต้องทำ consent flow แยก
5. MLKit iOS ไม่มี arm64 simulator → ทดสอบบนเครื่องจริงเท่านั้น
6. `react-native-vision-camera-face-detector` เป็น single-maintainer project — ความเสี่ยงคือถ้าเลิกดูแล ทางหนีคือ `react-native-vision-camera-mlkit` (pedrol2b, roadmap มี face) หรือเขียน Nitro plugin ครอบ MLKit เอง (~200 บรรทัด Kotlin/Swift) — `FaceSignal` type คือ seam ที่ทำให้สลับได้โดย liveness logic ไม่เปลี่ยน

---

## 13. Assumptions ที่ตัดสินใจแทน (และอะไรจะทำให้เปลี่ยน)

| ตัดสินใจ | เปลี่ยนถ้า |
|---|---|
| Expo dev build (ไม่ใช่ RN CLI) | ทีมมี RN CLI app อยู่แล้ว → โมดูลใช้ได้เหมือนกัน (Nitro autolink) แค่ scaffold ต่าง |
| VisionCamera **v5** (Nitro) ไม่ใช่ v4 | ทีมมีแอปที่ล็อก v4 อยู่ → ต้องใช้ face-detector v1.x + `vision-camera-resize-plugin` — plan นี้ยังใช้ได้ 90% แต่ pin version ต่างกัน |
| FaceNet-512 (24 MB) | app-size budget บังคับ → MobileFaceNet 112×112 (5 MB) แก้ที่ `FaceEmbedder` จุดเดียว |
| Embedding จากไฟล์ภาพหลัง liveness (ไม่ใช่จาก frame ใน worklet) | ต้องการ embed หลายเฟรมแบบ real-time (เช่น continuous auth) → ค่อยเพิ่ม path worklet + `react-native-vision-camera-resizer` |
| MMKV encrypted เป็น store default | ต้อง query ซับซ้อน / หลายหมื่นคน → SQLite ผ่าน `FaceStore` interface |
| ภาษาโค้ด TypeScript strict, ไม่มี native code ของเราเอง | จำเป็นต้องเขียน Nitro plugin ครอบ MLKit เอง (ข้อ 12.6) |

---

## Sources (verified 2026-08-17)
- npm registry: `react-native-vision-camera@5.2.2`, `react-native-vision-camera-resizer@5.2.2`, `react-native-vision-camera-face-detector@2.0.6` (peer VisionCamera ≥ 5.0), `react-native-fast-tflite@3.0.1`, `react-native-mmkv@4.3.2`, `react-native-nitro-image@0.15.1`, `expo@57.0.13`
- face-detector README/releases: https://github.com/luicfrr/react-native-vision-camera-face-detector (v2.0.0 = VisionCamera v5 support; `useImageFaceDetector`; `Face` มี yaw/pitch/roll, eye/smile probability, bounds, frameWidth/Height)
- VisionCamera v5: https://blog.margelo.com/whats-new-in-visioncamera-v5 ; source `Photo.toImage()`, `Frame`, `usePhotoOutput`
- nitro-image `Image.crop/resize/toRawPixelData`: package source 0.15.1
- fast-tflite: https://github.com/mrousavy/react-native-fast-tflite
- react-native-mediapipe releases (ล่าสุด v0.6.0, 2024-12): https://github.com/cdiddy77/react-native-mediapipe/releases
- FaceNet TFLite (Apache-2.0, 160×160, standardize): https://github.com/shubham0204/FaceRecognition_With_FaceNet_Android ; MiniFASNet spoof tflite: https://github.com/shubham0204/OnDevice-Face-Recognition-Android
