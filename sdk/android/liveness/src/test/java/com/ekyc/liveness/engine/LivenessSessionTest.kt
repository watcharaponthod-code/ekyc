package com.ekyc.liveness.engine

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Mirrors the key cases of the TypeScript suites (`LivenessSession.test.ts`,
 * `motion.test.ts`): the mechanism is identical, so the same scripted
 * sessions must produce the same transitions.
 */
class LivenessSessionTest {
    private val opts = SessionOptions(holdMs = 700, captureAtProgress = 0.5f, minStepMs = 0)

    private fun signal(
        t: Long, yaw: Float = 0f, pitch: Float = 0f, eyes: Float = 0.95f, mouth: Float = 0.04f,
        w: Float = 0.4f, count: Int = 1,
    ) = FaceSignal(count, yaw, pitch, 0f, eyes, eyes, 0f, mouth, Rect(0.5f - w / 2, 0.5f - w * 1.3f / 2, w, w * 1.3f), t)

    /** Feed frames every 50 ms for [ms] milliseconds; returns the next t. */
    private fun feed(s: LivenessSession, from: Long, ms: Long, make: (Long) -> FaceSignal): Long {
        var t = from
        val end = from + ms
        while (t < end) { s.update(make(t)); t += 50 }
        return t
    }

    private fun session(vararg names: ChallengeName, events: MutableList<SessionEvent> = ArrayList()): LivenessSession {
        val s = LivenessSession(Challenges.build(names.toList()), opts) { events.add(it) }
        s.start(0)
        return s
    }

    @Test fun `walks centre, blink (closed then open), turn and completes`() {
        val events = ArrayList<SessionEvent>()
        val s = session(ChallengeName.CLOSE_EYES, ChallengeName.TURN_LEFT, events = events)
        var t = feed(s, 0, 800) { signal(it) }
        assertEquals(1, s.state.stepIndex)
        t = feed(s, t, 800) { signal(it, eyes = 0.05f) }
        assertEquals(1, s.state.stepIndex); assertEquals(1, s.state.stepPhase) // shut alone is not a blink
        t = feed(s, t, 100) { signal(it, eyes = 0.95f) }
        assertEquals(2, s.state.stepIndex)
        feed(s, t, 800) { signal(it, yaw = 30f) } // positive yaw = user's left (yawSign -1)
        assertEquals(Phase.COMPLETED, s.state.phase)
        assertTrue(events.last() is SessionEvent.Complete)
        assertEquals(listOf("center", "closeEyes", "turnLeft"), events.filterIsInstance<SessionEvent.Capture>().map { it.challenge.wire })
    }

    @Test fun `a held pose never completes a two-phase step`() {
        val s = session(ChallengeName.OPEN_MOUTH)
        var t = feed(s, 0, 800) { signal(it) }
        t = feed(s, t, 5000) { signal(it, mouth = 0.45f) } // mouth held open (a gaping mask)
        assertEquals(1, s.state.stepIndex); assertEquals(1, s.state.stepPhase)
        feed(s, t, 100) { signal(it, mouth = 0.05f) }
        assertEquals(Phase.COMPLETED, s.state.phase)
    }

    @Test fun `move closer then back, and a held close-up never passes`() {
        val s = session(ChallengeName.MOVE_CLOSER)
        var t = feed(s, 0, 800) { signal(it) }
        t = feed(s, t, 3000) { signal(it, w = 0.55f) }
        assertEquals(1, s.state.stepPhase)
        feed(s, t, 100) { signal(it, w = 0.41f) }
        assertEquals(Phase.COMPLETED, s.state.phase)
    }

    @Test fun `left then right needs a pass through the centre`() {
        val s = session(ChallengeName.TURN_LEFT, ChallengeName.TURN_RIGHT)
        var t = feed(s, 0, 800) { signal(it) }
        t = feed(s, t, 800) { signal(it, yaw = 30f) }
        assertEquals(2, s.state.stepIndex)
        assertTrue(s.state.awaitingRecenter)
        t = feed(s, t, 800) { signal(it, yaw = -30f) } // swung straight across: does not count yet
        assertEquals(2, s.state.stepIndex)
        assertTrue(s.state.awaitingRecenter)
        t = feed(s, t, 100) { signal(it, yaw = 0f) }
        assertFalse(s.state.awaitingRecenter)
        feed(s, t, 800) { signal(it, yaw = -30f) }
        assertEquals(Phase.COMPLETED, s.state.phase)
    }

    @Test fun `turn is judged relative to the person's own neutral yaw`() {
        val s = session(ChallengeName.TURN_LEFT)
        var t = feed(s, 0, 800) { signal(it, yaw = 10f) } // rests slightly turned
        t = feed(s, t, 800) { signal(it, yaw = 30f) } // only +20 from rest: not enough
        assertEquals(1, s.state.stepIndex)
        feed(s, t, 800) { signal(it, yaw = 37f) } // +27
        assertEquals(Phase.COMPLETED, s.state.phase)
    }

    @Test fun `step metrics record best vs needed`() {
        val s = session(ChallengeName.TURN_LEFT)
        var t = feed(s, 0, 800) { signal(it) }
        feed(s, t, 400) { signal(it, yaw = 18f) }
        val m = s.state.stepMetrics["1:turnLeft"]!!
        assertEquals(18f, m.best, 0.01f); assertEquals(25f, m.needed, 0.01f)
    }

    @Test fun `face lost beyond the grace period fails, short loss does not`() {
        val s = session(ChallengeName.TURN_LEFT)
        var t = feed(s, 0, 800) { signal(it) }
        t = feed(s, t, 1000) { FaceSignal.empty(it) }
        assertEquals(Phase.RUNNING, s.state.phase)
        feed(s, t, 4000) { FaceSignal.empty(it) }
        assertEquals(Phase.FAILED, s.state.phase); assertEquals(FailureReason.FACE_LOST, s.state.reason)
    }

    @Test fun `per-step timeout`() {
        val s = session(ChallengeName.TURN_LEFT)
        var t = feed(s, 0, 800) { signal(it) }
        feed(s, t, 13_000) { signal(it) } // never turns
        assertEquals(FailureReason.TIMEOUT, s.state.reason)
    }

    @Test fun `framing too far, too close, off centre`() {
        val s = session(ChallengeName.TURN_LEFT)
        s.update(signal(0, w = 0.15f)); assertEquals(Framing.TOO_FAR, s.state.framing)
        s.update(signal(50, w = 0.8f)); assertEquals(Framing.TOO_CLOSE, s.state.framing)
        s.update(FaceSignal(1, 0f, 0f, 0f, 1f, 1f, 0f, 0f, Rect(0.0f, 0.0f, 0.4f, 0.5f), 100)); assertEquals(Framing.OFF_CENTRE, s.state.framing)
        s.update(signal(150)); assertEquals(Framing.OK, s.state.framing)
    }

    @Test fun `local policy always includes openMouth and shuffles`() {
        repeat(20) {
            val picked = Challenges.pickLocal(4)
            assertEquals(4, picked.size)
            assertTrue(picked.contains(ChallengeName.OPEN_MOUTH))
            assertEquals(picked.size, picked.toSet().size)
        }
        assertEquals(listOf(ChallengeName.OPEN_MOUTH), Challenges.pickLocal(1))
    }

    @Test fun `continuity smooth run ok, long gap and jump flagged`() {
        val c = ContinuityTracker()
        for (i in 0 until 40) c.feed(signal(i * 50L, yaw = i.toFloat()))
        assertTrue(c.report().ok)
        val c2 = ContinuityTracker()
        c2.feed(signal(0)); c2.feed(FaceSignal.empty(50)); c2.feed(signal(2000))
        assertFalse(c2.report().ok); assertEquals(1950, c2.report().maxGapMs)
        val c3 = ContinuityTracker()
        c3.feed(signal(0)); c3.feed(FaceSignal(1, 0f, 0f, 0f, 1f, 1f, 0f, 0f, Rect(0.0f, 0.0f, 0.2f, 0.2f), 50))
        assertEquals(1, c3.report().jumps)
    }

    @Test fun `flash - a reflecting face scores high, a constant photo scores 0`() {
        val seq = listOf("red", "green", "blue", "white").map { Flash.PALETTE.getValue(it) }
        val face = seq.map { c -> floatArrayOf(0.3f + 0.2f * c[0], 0.25f + 0.2f * c[1], 0.2f + 0.2f * c[2]) }
        assertTrue(Flash.score(seq, face) > 0.9f)
        val photo = seq.map { floatArrayOf(0.4f, 0.35f, 0.3f) }
        assertEquals(0f, Flash.score(seq, photo), 1e-6f)
        assertEquals(0f, Flash.score(seq.take(2), face.take(2)), 1e-6f)
    }

    @Test fun `mouth openness from contours`() {
        val shut = Mouth.openness(listOf(Pt(0f, 100f), Pt(40f, 100f)), listOf(Pt(0f, 101f), Pt(40f, 101f)), listOf(Pt(0f, 95f), Pt(40f, 95f)), null, null, null, null, null)
        val open = Mouth.openness(listOf(Pt(0f, 100f), Pt(40f, 100f)), listOf(Pt(0f, 116f), Pt(40f, 116f)), listOf(Pt(0f, 95f), Pt(40f, 95f)), null, null, null, null, null)
        assertTrue(shut < 0.05f); assertEquals(0.4f, open, 0.01f)
        assertNull(null)
    }
}
