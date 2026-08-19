package com.ekyc.liveness.ui

import com.ekyc.liveness.engine.ChallengeName
import com.ekyc.liveness.engine.FailureReason
import com.ekyc.liveness.engine.Framing

/** Thai / English copy — the same wording as the React Native edition. */
internal class Copy(locale: String) {
    private val th = locale.lowercase().startsWith("th")

    val introTitle get() = if (th) "ยืนยันว่าเป็นคุณ" else "Verify it's you"
    val introBody get() = if (th) "ใช้เวลาไม่กี่วินาที ทำตามคำสั่งบนหน้าจอทีละขั้น" else "Takes a few seconds. Follow the prompts one step at a time."
    val introSteps get() = if (th) listOf("อยู่ในที่ที่มีแสงพอ และถอดแว่นกันแดด", "จัดใบหน้าให้อยู่ในกรอบวงรี", "ทำตามคำสั่ง: หันซ้าย หันขวา อ้าปาก กระพริบตา")
        else listOf("Find even lighting, remove sunglasses", "Keep your face inside the oval", "Follow the prompts: turn, open mouth, blink")
    val introPrivacy get() = if (th) "ประมวลผลบนเครื่องนี้ทั้งหมด ไม่มีการส่งภาพหรือข้อมูลใบหน้าออกจากเครื่อง" else "Everything runs on this device. No image or face data leaves the phone."
    val start get() = if (th) "เริ่มสแกน" else "Start"
    val holdOn get() = if (th) "ค้างไว้" else "Hold"
    val flashHold get() = if (th) "มองที่หน้าจอ ค้างไว้สักครู่" else "Look at the screen, hold still"
    val successTitle get() = if (th) "ยืนยันตัวตนสำเร็จ" else "Verified"
    val successBody get() = if (th) "ตรวจพบการเคลื่อนไหวของคนจริงครบทุกขั้น" else "Live movement confirmed on every step"
    val failTitle get() = if (th) "ยังยืนยันไม่สำเร็จ" else "Not verified"
    val done get() = if (th) "เสร็จสิ้น" else "Done"
    val cameraPermission get() = if (th) "ต้องอนุญาตให้ใช้กล้องก่อน จึงจะยืนยันตัวตนได้" else "Camera permission is required"

    fun framing(f: Framing): String = when (f) {
        Framing.NO_FACE -> if (th) "ไม่พบใบหน้าในกรอบ" else "No face in frame"
        Framing.MULTIPLE_FACES -> if (th) "ให้มีใบหน้าเดียวในกรอบ" else "Only one face in frame"
        Framing.TOO_FAR -> if (th) "ขยับเข้าใกล้อีกนิด" else "Move a little closer"
        Framing.TOO_CLOSE -> if (th) "ถอยออกมาเล็กน้อย" else "Move back a little"
        Framing.OFF_CENTRE -> if (th) "เลื่อนใบหน้ามาตรงกลาง" else "Centre your face"
        Framing.OK -> ""
    }

    fun challenge(c: ChallengeName): String = when (c) {
        ChallengeName.CENTER -> if (th) "มองตรงมาที่กล้อง" else "Look straight at the camera"
        ChallengeName.CLOSE_EYES -> if (th) "กระพริบตา" else "Blink"
        ChallengeName.TURN_LEFT -> if (th) "หันหน้าไปทางซ้าย" else "Turn your head left"
        ChallengeName.TURN_RIGHT -> if (th) "หันหน้าไปทางขวา" else "Turn your head right"
        ChallengeName.SMILE -> if (th) "ยิ้มค้างไว้" else "Smile and hold"
        ChallengeName.OPEN_MOUTH -> if (th) "อ้าปากกว้างๆ" else "Open your mouth wide"
        ChallengeName.NOD -> if (th) "เงยหน้าขึ้น แล้วก้มลง" else "Nod: up, then down"
        ChallengeName.MOVE_CLOSER -> if (th) "ขยับหน้าเข้าใกล้กล้อง" else "Move your face closer"
        ChallengeName.MOVE_FARTHER -> if (th) "ขยับหน้าออกห่างจากกล้อง" else "Move your face farther away"
    }

    fun phase2(c: ChallengeName): String = when (c) {
        ChallengeName.NOD -> if (th) "แล้วกลับมามองตรง" else "…and back to centre"
        ChallengeName.CLOSE_EYES -> if (th) "ลืมตา" else "Open your eyes"
        ChallengeName.OPEN_MOUTH -> if (th) "หุบปาก" else "Close your mouth"
        ChallengeName.SMILE -> if (th) "คลายยิ้ม" else "Relax"
        ChallengeName.MOVE_CLOSER -> if (th) "แล้วถอยกลับที่เดิม" else "…and back where you were"
        ChallengeName.MOVE_FARTHER -> if (th) "แล้วขยับกลับที่เดิม" else "…and back where you were"
        else -> challenge(c)
    }

    val recenter get() = if (th) "กลับมามองตรงก่อน" else "Back to centre first"

    fun failure(r: FailureReason): String = when (r) {
        FailureReason.TIMEOUT -> if (th) "ใช้เวลานานเกินไป ลองใหม่อีกครั้ง" else "Took too long — try again"
        FailureReason.FACE_LOST -> if (th) "ใบหน้าหลุดจากกรอบ ลองใหม่อีกครั้ง" else "Face left the frame — try again"
        FailureReason.MULTIPLE_FACES -> if (th) "มีมากกว่าหนึ่งใบหน้าในกรอบ" else "More than one face in frame"
        FailureReason.CANCELLED -> if (th) "ยกเลิกการสแกน" else "Cancelled"
    }

    fun reason(code: String): String = when (code) {
        "FLASH_SPOOF" -> if (th) "แสงสะท้อนบนใบหน้าไม่ตรงกับสีที่จอกะพริบ อาจเป็นภาพถ่ายหรือวิดีโอ" else "Face reflection did not follow the screen colours — possibly a photo or video"
        "FACE_DISCONTINUITY" -> if (th) "ใบหน้าหลุดหรือเปลี่ยนกลางรอบ กรุณาสแกนใหม่ทั้งหมด" else "The face dropped out or changed mid-run — scan again"
        "CAMERA_PERMISSION" -> cameraPermission
        "LOCAL_timeout" -> failure(FailureReason.TIMEOUT)
        "LOCAL_faceLost" -> failure(FailureReason.FACE_LOST)
        "LOCAL_multipleFaces" -> failure(FailureReason.MULTIPLE_FACES)
        "LOCAL_cancelled" -> failure(FailureReason.CANCELLED)
        else -> code
    }
}
