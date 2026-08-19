# eKYC Liveness SDK (local 100 %)

ตรวจความมีชีวิตบนเครื่อง: ML Kit + คำสั่งท่าทาง (อ้าปาก · หันซ้าย/ขวา · กระพริบ · ขยับเข้า/ออก) + แสงสีจากหน้าจอ — ไม่มีเซิร์ฟเวอร์ ไม่มีภาพออกจากเครื่อง ผลออกทันที

| แพ็กเกจ | ใช้กับ | ตำแหน่ง |
|---|---|---|
| **`com.ekyc:liveness-android`** (AAR) | Android native (Kotlin/Java), **Flutter**, **React Native**, **Capacitor/Ionic**, Unity, KMP — ทุกอย่างที่มี Activity | `sdk/android/` (ไลบรารี + แอปตัวอย่าง), `sdk/bridges/` (โค้ดสะพานต่อเฟรมเวิร์ก) |
| `@ekyc/react-native-ekyc-local` (npm, ในรีโปนี้) | React Native / Expo แบบ JS ล้วน (มี UI ของตัวเอง) | `packages/react-native-ekyc-local/` |
| iOS | ยังไม่มี — engine เป็น Kotlin ล้วน พอร์ตเป็น Swift + Vision/ML Kit iOS ได้ตรงตัว | — |

## ติดตั้ง (Android)

```kotlin
// settings.gradle.kts
dependencyResolutionManagement {
    repositories {
        google(); mavenCentral()
        maven { url = uri("https://raw.githubusercontent.com/watcharaponthod-code/ekyc/master/sdk/android/repo") }
    }
}
// app/build.gradle.kts
dependencies { implementation("com.ekyc:liveness-android:1.0.0") }
```
(หรือดาวน์โหลด `liveness-android-1.0.0.aar` จาก GitHub Releases ไปวางใน `app/libs` แล้วเพิ่ม dependency ML Kit/CameraX เองตาม `sdk/android/liveness/build.gradle.kts`)

minSdk 24 · ขอ permission กล้องให้อัตโนมัติ · ขนาดเพิ่ม ≈ 6–8 MB (โมเดล ML Kit ฝังในแอป ทำงาน offline)

## เรียกใช้ — 3 บรรทัด (Kotlin)

```kotlin
val liveness = registerForActivityResult(EkycLiveness.Contract()) { r -> if (r.passed) ok() else show(r.reasons) }
liveness.launch(LivenessConfig())                       // สุ่มท่าแบบเซิร์ฟเวอร์, ไทย, มีแสงจอ
liveness.launch(LivenessConfig(challenges = listOf("turnLeft", "openMouth", "moveCloser"), locale = "en"))
```

ทุกเฟรมเวิร์กใช้ **JSON เดียวกัน** ผ่าน `EkycLiveness.intentFromJson(context, json)` → `EkycLiveness.resultFrom(data).toJson()` — ดูไฟล์พร้อมใช้ใน `sdk/bridges/{flutter,react-native,capacitor,java}` (คัดลอกไฟล์เดียว แล้วเรียก `start({...})`)

### Config (ทุกค่าไม่บังคับ)
| key | ค่าเริ่มต้น | ความหมาย |
|---|---|---|
| `challenges` | `[]` = สุ่ม: อ้าปากทุกครั้ง + 3 ท่าสุ่ม | `turnLeft` `turnRight` `openMouth` `closeEyes` `moveCloser` `moveFarther` `nod` `smile` |
| `challengeCount` | 4 | จำนวนท่าเมื่อสุ่ม |
| `locale` | `th` | `th` / `en` |
| `flash` / `flashRule` | `true` / `advisory` | แสงจอ 4 สีตอนท้าย; `off` `advisory` `enforce` |
| `continuityRule` | `advisory` | ใบหน้าอยู่ต่อเนื่อง; `off` `advisory` `enforce` |
| `holdMs` | 400 | ค้างท่า (ms) |
| `showIntro` / `showResult` | `true` / `true` | หน้าแนะนำ / หน้าผลของ SDK (ปิดเพื่อใช้ UI ของคุณเอง) |
| `title` | null | หัวข้อหน้าแนะนำ |

### Result (JSON)
```json
{"passed": true, "reasons": [], "challenges": ["center","openMouth","turnLeft","closeEyes","moveFarther"],
 "steps": [{"challenge":"turnLeft","phase":0,"best":41.2,"needed":25.0,"direction":"above","reached":true}, …],
 "durationMs": 14820, "flashScore": 0.83, "flashOk": true, "continuityOk": true,
 "continuityMaxGapMs": 120, "continuityMaxJump": 0.04, "log": ["0 session challenges=…", …]}
```
`reasons` เมื่อไม่ผ่าน: `LOCAL_timeout` `LOCAL_faceLost` `LOCAL_multipleFaces` `LOCAL_cancelled` `CAMERA_PERMISSION` (+ `FLASH_SPOOF` / `FACE_DISCONTINUITY` เมื่อตั้ง enforce)

## สิ่งที่ SDK พิสูจน์ / ไม่พิสูจน์
พิสูจน์: **คนจริงกำลังทำท่าตามคำสั่งอยู่หน้ากล้องตอนนี้** (ทุกท่าเป็นการเคลื่อนไหวจากท่ามองตรงของคนคนนั้น + ท่ากลับ — รูปนิ่ง/ท่าค้างไม่ผ่าน; หน้ากากแข็งอ้าปากไม่ได้) และ (advisory) แสงสะท้อนตรงกับจอ (กันรูป/จอ), ใบหน้าไม่หลุด/สลับกลางรอบ
ไม่พิสูจน์: เป็นใคร (ไม่มี face recognition) · ไม่ใช่ PAD เต็มรูปแบบ · ไม่มีการรับรอง ISO/IEC 30107-3

## พัฒนา
```
cd sdk/android
./gradlew :liveness:testDebugUnitTest            # engine tests (13)
./gradlew :liveness:assembleRelease               # AAR → liveness/build/outputs/aar
./gradlew :sample:assembleRelease                 # แอปตัวอย่าง
./gradlew :liveness:publishReleasePublicationToLocalRepoRepository   # Maven layout → liveness/build/repo (คัดลอกไป sdk/android/repo)
```
engine (`liveness/src/main/java/com/ekyc/liveness/engine`) เป็น Kotlin ล้วน ไม่แตะ Android — เป็นพอร์ต 1:1 ของ `packages/react-native-ekyc/src/liveness` (เกณฑ์เดียวกัน เทสต์เดียวกัน)
