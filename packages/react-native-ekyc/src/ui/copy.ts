/**
 * Every string the user sees, in Thai and English.
 *
 * Two rules taken from measuring shipped SDKs:
 *
 * 1. **One short imperative clause.** ZOLOZ caps its face-scan instruction at
 *    60 characters, Tencent at 17 for the short tip. Everything here fits.
 * 2. **Say what to do, not what went wrong.** "Move closer" beats "Face too
 *    far". The only place we explain a failure is the result screen, where
 *    there is room and the user has stopped moving.
 *
 * Phrasing follows real vendor copy (Regula, Sumsub, iProov, FaceTec) rather
 * than the widely-copied "Position your face in the oval", which appears in no
 * shipped SDK.
 */

import type { ChallengeName, FailureReason, Framing } from '../types'

export type Locale = 'th' | 'en'

type Strings = {
  framing: Record<Exclude<Framing, 'ok'>, string>
  challenge: Record<ChallengeName, string>
  holdOn: string
  uploading: string
  intro: { title: string; body: string; steps: string[]; start: string; consent: string }
  result: {
    successTitle: string
    successBody: string
    failTitle: string
    retry: string
    cancel: string
    done: string
  }
  /** Advice per server reason code — the "what to do differently" screen. */
  reason: Record<string, string>
  localFailure: Record<FailureReason, string>
  a11y: { preview: string; progress: (step: number, total: number) => string }
}

const th: Strings = {
  framing: {
    noFace: 'ไม่พบใบหน้าในกรอบ',
    multipleFaces: 'ให้มีใบหน้าเดียวในกรอบ',
    tooFar: 'ขยับเข้าใกล้อีกนิด',
    tooClose: 'ถอยออกมาเล็กน้อย',
    offCentre: 'เลื่อนใบหน้ามาตรงกลาง',
  },
  challenge: {
    center: 'มองตรงมาที่กล้อง',
    closeEyes: 'หลับตาค้างไว้',
    turnLeft: 'หันหน้าไปทางซ้ายช้าๆ',
    turnRight: 'หันหน้าไปทางขวาช้าๆ',
    smile: 'ยิ้มค้างไว้',
  },
  holdOn: 'ค้างไว้',
  uploading: 'กำลังตรวจสอบ…',
  intro: {
    title: 'ยืนยันว่าเป็นคุณ',
    body: 'ใช้เวลาประมาณ 15 วินาที ทำตามคำสั่งบนหน้าจอทีละขั้น',
    steps: [
      'อยู่ในที่ที่มีแสงพอ และถอดแว่นกันแดด',
      'จัดใบหน้าให้อยู่ในกรอบวงรี',
      'ทำตามคำสั่ง แล้วค้างท่าไว้จนวงแหวนเต็ม',
    ],
    start: 'เริ่มสแกน',
    consent: 'ภาพใบหน้าจะถูกส่งไปตรวจสอบและลบทิ้งทันทีหลังตรวจเสร็จ ระบบเก็บเฉพาะข้อมูลเชิงตัวเลขที่ย้อนกลับเป็นภาพไม่ได้',
  },
  result: {
    successTitle: 'ยืนยันตัวตนสำเร็จ',
    successBody: 'ระบบยืนยันแล้วว่าเป็นคุณ',
    failTitle: 'ยังยืนยันไม่สำเร็จ',
    retry: 'ลองอีกครั้ง',
    cancel: 'ยกเลิก',
    done: 'เสร็จสิ้น',
  },
  reason: {
    PAD_LOW: 'ระบบตรวจพบว่าอาจเป็นภาพถ่ายหรือภาพจากหน้าจอ กรุณาสแกนจากใบหน้าจริง',
    QUALITY_SHARPNESS: 'ภาพเบลอ ถือเครื่องให้นิ่งขึ้นอีกนิด',
    QUALITY_BRIGHTNESS: 'แสงไม่เหมาะสม ลองย้ายไปที่ที่แสงสม่ำเสมอ',
    QUALITY_FACE_TOO_SMALL: 'ใบหน้าเล็กเกินไป ขยับเข้าใกล้กล้องมากขึ้น',
    NO_FACE: 'ไม่พบใบหน้าในบางภาพ จัดใบหน้าให้อยู่ในกรอบตลอดการสแกน',
    MULTIPLE_FACES: 'มีมากกว่าหนึ่งใบหน้าในภาพ หาที่ส่วนตัวแล้วลองใหม่',
    POSE_NOT_FRONTAL: 'ตอนเริ่มต้นให้มองตรงมาที่กล้อง',
    POSE_INSUFFICIENT_TURN: 'หันหน้าให้มากขึ้นอีกนิด แล้วค้างไว้จนวงแหวนเต็ม',
    POSE_SAME_DIRECTION: 'ต้องหันทั้งซ้ายและขวา ไม่ใช่ทางเดียว',
    EYES_NOT_CLOSED: 'ยังตรวจไม่พบการหลับตา ลองหลับตาสนิทแล้วค้างไว้',
    IDENTITY_INCONSISTENT: 'ภาพในแต่ละขั้นดูไม่ใช่คนเดียวกัน กรุณาสแกนใหม่ทั้งหมด',
    TIMING_IMPLAUSIBLE: 'จังหวะการสแกนผิดปกติ กรุณาเริ่มใหม่',
    CHALLENGE_MISMATCH: 'ขั้นตอนไม่ตรงกับที่ระบบกำหนด กรุณาเริ่มใหม่',
    FRAME_MISSING: 'ภาพไม่ครบทุกขั้นตอน กรุณาสแกนใหม่',
    FRAME_UNREADABLE: 'ภาพเสียหาย กรุณาสแกนใหม่',
    NO_MATCH: 'ใบหน้าไม่ตรงกับข้อมูลที่ลงทะเบียนไว้',
    PERSON_NOT_FOUND: 'ไม่พบข้อมูลผู้ใช้ที่ลงทะเบียนไว้',
    SESSION_EXPIRED: 'หมดเวลา กรุณาเริ่มใหม่',
    SESSION_CONSUMED: 'รอบการยืนยันนี้ถูกใช้ไปแล้ว กรุณาเริ่มใหม่',
  },
  localFailure: {
    timeout: 'ใช้เวลานานเกินไป ลองใหม่อีกครั้ง',
    faceLost: 'ใบหน้าหลุดจากกรอบ ลองใหม่อีกครั้ง',
    multipleFaces: 'มีมากกว่าหนึ่งใบหน้าในกรอบ',
    captureFailed: 'ถ่ายภาพไม่สำเร็จ ลองใหม่อีกครั้ง',
    cancelled: 'ยกเลิกการสแกน',
  },
  a11y: {
    preview: 'ภาพจากกล้องหน้า สำหรับยืนยันตัวตน',
    progress: (step, total) => `ขั้นที่ ${step} จาก ${total}`,
  },
}

const en: Strings = {
  framing: {
    noFace: "We can't see your face",
    multipleFaces: 'Only one face in the frame',
    tooFar: 'Move closer',
    tooClose: 'Move back',
    offCentre: 'Center your face',
  },
  challenge: {
    center: 'Look straight at the camera',
    closeEyes: 'Close your eyes and hold',
    turnLeft: 'Turn your head left',
    turnRight: 'Turn your head right',
    smile: 'Smile and hold',
  },
  holdOn: 'Hold steady',
  uploading: 'Checking…',
  intro: {
    title: "Let's check it's you",
    body: 'Takes about 15 seconds. Follow one instruction at a time.',
    steps: [
      'Find even light and take off sunglasses',
      'Fit your face inside the oval',
      'Follow each prompt and hold until the ring closes',
    ],
    start: 'Start scan',
    consent:
      'Your photos are sent for checking and deleted straight after. Only a numeric template is kept, and it cannot be turned back into an image.',
  },
  result: {
    successTitle: "You're verified",
    successBody: 'We confirmed it was you.',
    failTitle: "That didn't work",
    retry: 'Try again',
    cancel: 'Cancel',
    done: 'Done',
  },
  reason: {
    PAD_LOW: 'That looked like a photo or a screen. Please scan your real face.',
    QUALITY_SHARPNESS: 'The photo was blurry. Hold the phone a little steadier.',
    QUALITY_BRIGHTNESS: 'The lighting was off. Move somewhere more evenly lit.',
    QUALITY_FACE_TOO_SMALL: 'Your face was too small. Move closer to the camera.',
    NO_FACE: 'We lost your face in one of the shots. Stay in the oval throughout.',
    MULTIPLE_FACES: 'More than one face was in shot. Find a private space and retry.',
    POSE_NOT_FRONTAL: 'Look straight at the camera at the start.',
    POSE_INSUFFICIENT_TURN: 'Turn your head a little further and hold until the ring closes.',
    POSE_SAME_DIRECTION: 'You need to turn both ways, not just one.',
    EYES_NOT_CLOSED: "We couldn't see your eyes close. Close them fully and hold.",
    IDENTITY_INCONSISTENT: "The shots don't look like the same person. Please scan again.",
    TIMING_IMPLAUSIBLE: 'The timing looked wrong. Please start again.',
    CHALLENGE_MISMATCH: "The steps didn't match what we asked for. Please start again.",
    FRAME_MISSING: 'Some steps were missing. Please scan again.',
    FRAME_UNREADABLE: 'A photo was corrupted. Please scan again.',
    NO_MATCH: "That doesn't match the enrolled face.",
    PERSON_NOT_FOUND: 'No enrolled record was found.',
    SESSION_EXPIRED: 'This took too long. Please start again.',
    SESSION_CONSUMED: 'This check was already used. Please start again.',
  },
  localFailure: {
    timeout: 'That took too long. Try again.',
    faceLost: 'Your face left the frame. Try again.',
    multipleFaces: 'More than one face in the frame.',
    captureFailed: "We couldn't take the photo. Try again.",
    cancelled: 'Scan cancelled',
  },
  a11y: {
    preview: 'Front camera preview for identity verification',
    progress: (step, total) => `Step ${step} of ${total}`,
  },
}

const DICTIONARIES: Record<Locale, Strings> = { th, en }

export function strings(locale: Locale): Strings {
  return DICTIONARIES[locale] ?? en
}

/**
 * The one line the user should read right now.
 *
 * Framing beats the challenge: never ask someone to turn their head while they
 * are out of frame.
 */
export function instructionFor(
  locale: Locale,
  framing: Framing,
  challenge: ChallengeName | null,
  holding: boolean,
): string {
  const dict = strings(locale)
  if (framing !== 'ok') return dict.framing[framing]
  if (!challenge) return dict.uploading
  return holding ? dict.holdOn : dict.challenge[challenge]
}

/** Turn server reason codes into advice, deduplicated, most useful first. */
export function explainReasons(locale: Locale, reasons: string[]): string[] {
  const dict = strings(locale)
  const seen = new Set<string>()
  const out: string[] = []
  for (const code of reasons) {
    const text = dict.reason[code]
    if (text && !seen.has(text)) {
      seen.add(text)
      out.push(text)
    }
  }
  return out.length > 0 ? out : [dict.result.failTitle]
}
