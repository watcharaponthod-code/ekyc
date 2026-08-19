import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { Camera, useCameraDevice, useCameraPermission } from 'react-native-vision-camera'
import { createFaceDetectorOutput, type Face } from 'react-native-vision-camera-face-detector'

import {
  DEFAULT_SESSION_OPTIONS,
  DirectionHint,
  FrameOverlay,
  InstructionBanner,
  LivenessSession,
  ResultView,
  StepDots,
  buildChallenges,
  defaultTheme,
  instructionFor,
  strings,
  toSignal,
  type ChallengeName,
  type ChallengeTuning,
  type EKYCTheme,
  type FaceSignal,
  type LivenessState,
  type Locale,
  type SessionEvent,
  type StepMetric,
} from '@ekyc/react-native-ekyc'

import { pickLocalChallenges } from './challenges'
import { ContinuityTracker, DEFAULT_CONTINUITY, type ContinuityOptions, type ContinuityReport } from './continuity'

export type ContinuityRule = 'off' | 'advisory' | 'enforce'

/**
 * Everything a session measured, in one JSON-able record — what the app
 * appends to its session log and what `scripts/local_calibrate.py` reads.
 * Numbers only; no images.
 */
export type SessionReport = {
  at: string
  challenges: ChallengeName[]
  passed: boolean
  reasons: string[]
  /** Best value each step reached vs what it needed (from LivenessSession). */
  stepMetrics: Record<string, StepMetric>
  /** Face continuity across the whole run (see `continuity.ts`). */
  continuity: ContinuityReport | null
  thresholds: { continuityRule: ContinuityRule; continuity: ContinuityOptions }
  timings: { captureMs: number }
  /** The last diagnostic lines of this run, for remote debugging. */
  log: string[]
}

export type LocalResult = {
  passed: boolean
  reasons: string[]
  continuity: ContinuityReport | null
  report: SessionReport
  /** Which challenges were asked, in order (excluding `center`). */
  challenges: ChallengeName[]
  timings: { captureMs: number }
}

export type LocalLivenessCameraProps = {
  onResult: (result: LocalResult) => void
  onCancel?: (() => void) | undefined
  onProgress?: ((state: LivenessState) => void) | undefined
  /**
   * Challenges to ask, in order, `center` implied first. Default: a random
   * order of turnLeft / turnRight / openMouth / moveCloser / moveFarther
   * (`pickLocalChallenges`).
   */
  challenges?: ChallengeName[] | undefined
  /**
   * Face-continuity check ("one face all the way through"): 'advisory'
   * (default) reports it in the result without failing on it — its
   * thresholds are set from real phones first; 'enforce' adds
   * FACE_DISCONTINUITY; 'off' skips it.
   */
  continuityRule?: ContinuityRule | undefined
  continuity?: Partial<ContinuityOptions> | undefined
  locale?: Locale
  theme?: EKYCTheme
  tuning?: ChallengeTuning
  debug?: boolean
}

const CAMERA_CONSTRAINTS = [{ fps: 60 }]

type Screen =
  | { kind: 'starting' }
  | { kind: 'capturing' }
  | { kind: 'result'; passed: boolean; reasons: string[] }
  | { kind: 'error'; message: string }

const RECENT_LOG: string[] = []
function log(message: string, detail?: unknown): void {
  const text = detail === undefined ? '' : detail instanceof Error ? ` ${detail.name}: ${detail.message}` : ` ${String(detail)}`
  const line = `${new Date().toISOString().slice(11, 19)} ${message}${text}`
  RECENT_LOG.push(line)
  if (RECENT_LOG.length > 12) RECENT_LOG.shift()
  if (__DEV__) console.warn(`[ekyc-local] ${line}`)
}

/**
 * The 100 %-on-device flow, light edition.
 *
 * Same coaching, same challenge engine and same UI as `EKYCCamera`, but no
 * server and no model: the verdict is the challenge sequence itself. Every
 * step is a *movement* judged relative to the person's own neutral frame
 * (turn left/right, open-then-close the mouth, move closer/farther and back),
 * with the head returning to the middle between steps, plus a
 * face-continuity check across the whole run. Nothing is embedded, cropped
 * or uploaded; the result is ready the moment the last step completes.
 *
 * What this proves: a cooperating person, continuously present, performed
 * the requested movements live. What it does not prove: who they are, or
 * that the face is not a screen/print — the server flow carries those layers.
 * The MobileFaceNet/rPPG edition lives under `src/heavy/` for hosts that
 * want it and can carry the extra native modules.
 */
export function LocalLivenessCamera({
  onResult,
  onCancel,
  onProgress,
  challenges,
  continuityRule = 'advisory',
  continuity,
  locale = 'th',
  theme = defaultTheme,
  tuning,
  debug = false,
}: LocalLivenessCameraProps) {
  const { width, height } = useWindowDimensions()
  const device = useCameraDevice('front')
  const { hasPermission, requestPermission } = useCameraPermission()

  const [screen, setScreen] = useState<Screen>({ kind: 'starting' })
  const [state, setState] = useState<LivenessState>(idleState)
  const [reduceMotion, setReduceMotion] = useState(false)
  const [live, setLive] = useState<FaceSignal | null>(null)

  const onResultRef = useRef(onResult)
  onResultRef.current = onResult
  const onProgressRef = useRef(onProgress)
  onProgressRef.current = onProgress
  const handleEventRef = useRef<(e: SessionEvent) => void>(() => {})

  const session = useRef<LivenessSession | null>(null)
  const issued = useRef<ChallengeName[]>([])
  const tracker = useRef<ContinuityTracker>(new ContinuityTracker())
  const startedAt = useRef(0)
  const finished = useRef(false)

  const continuityOptions = useMemo<ContinuityOptions>(() => ({ ...DEFAULT_CONTINUITY, ...continuity }), [continuity])

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {})
  }, [])

  // ---- verdict -----------------------------------------------------------

  const finish = useCallback(
    (passedSteps: boolean, reasons: string[], now: number) => {
      if (finished.current) return
      finished.current = true
      const report = continuityRule === 'off' ? null : tracker.current.report(now)
      const allReasons = [...reasons]
      if (report && !report.ok && continuityRule === 'enforce') allReasons.push('FACE_DISCONTINUITY')
      const passed = passedSteps && allReasons.length === 0
      const sessionReport: SessionReport = {
        at: new Date().toISOString(),
        challenges: issued.current,
        passed,
        reasons: allReasons,
        stepMetrics: session.current?.state.stepMetrics ?? {},
        continuity: report,
        thresholds: { continuityRule, continuity: continuityOptions },
        timings: { captureMs: now - startedAt.current },
        log: [...RECENT_LOG],
      }
      log('verdict', `${passed ? 'pass' : 'fail'} ${allReasons.join(',') || '-'} continuity=${report ? `${report.ok} gap${report.maxGapMs}ms jump${report.maxJump.toFixed(2)}` : 'off'}`)
      session.current?.notifyResult(passed)
      setScreen({ kind: 'result', passed, reasons: allReasons })
      onResultRef.current({ passed, reasons: allReasons, continuity: report, report: sessionReport, challenges: issued.current, timings: sessionReport.timings })
    },
    [continuityRule, continuityOptions],
  )

  // ---- lifecycle ---------------------------------------------------------

  const begin = useCallback(() => {
    finished.current = false
    issued.current = challenges ?? pickLocalChallenges()
    tracker.current = new ContinuityTracker(continuityOptions)
    const now = Date.now()
    startedAt.current = now
    const next = new LivenessSession(
      buildChallenges(issued.current, tuning),
      { holdMs: DEFAULT_SESSION_OPTIONS.holdMs },
      (event) => handleEventRef.current(event),
    )
    session.current = next
    setState(next.start(now))
    setScreen({ kind: 'capturing' })
    log('session', issued.current.join(','))
  }, [challenges, tuning, continuityOptions])

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      if (event.type === 'capture' || event.type === 'stepComplete') return
      if (event.type === 'complete') {
        finish(true, [], Date.now())
        return
      }
      log(
        'liveness failed',
        `${event.reason} at step ${event.stepIndex} (${event.challenge ?? '-'}) ` +
          Object.values(event.stepMetrics).map((m) => `${m.challenge}${m.phase ? `#${m.phase}` : ''}:${m.best.toFixed(2)}/${m.needed.toFixed(2)}`).join(' '),
      )
      finish(false, [`LOCAL_${event.reason}`], Date.now())
    },
    [finish],
  )
  handleEventRef.current = handleEvent

  const beginRef = useRef(begin)
  beginRef.current = begin
  const started = useRef(false)
  useEffect(() => {
    if (!hasPermission) {
      started.current = false
      void requestPermission()
      return
    }
    if (started.current) return
    started.current = true
    beginRef.current()
    return () => {
      session.current?.abort('cancelled')
    }
  }, [hasPermission, requestPermission])

  // ---- per frame ---------------------------------------------------------

  const onFacesDetected = useCallback(
    (faces: Face[]) => {
      const current = session.current
      if (!current) return
      const signal = toSignal(faces)
      if (debug) setLive(signal)
      if (current.state.phase === 'running') tracker.current.feed(signal)
      const next = current.feed(signal)
      onProgressRef.current?.(next)
      setState((prev) =>
        prev.phase === next.phase &&
        prev.stepIndex === next.stepIndex &&
        prev.stepPhase === next.stepPhase &&
        prev.awaitingRecenter === next.awaitingRecenter &&
        prev.framing === next.framing &&
        prev.holdProgress === next.holdProgress
          ? prev
          : next,
      )
    },
    [debug],
  )
  const facesRef = useRef(onFacesDetected)
  facesRef.current = onFacesDetected
  const detectorOutput = useMemo(
    () =>
      createFaceDetectorOutput({
        performanceMode: 'fast',
        runClassifications: true,
        runLandmarks: true,
        runContours: true,
        trackingEnabled: false,
        cameraFacing: 'front',
        outputResolution: 'preview',
        onFacesDetected: (faces: Face[]) => facesRef.current(faces),
        onError: (error: Error) => {
          log('face detector error', error)
          session.current?.abort('captureFailed')
          setScreen({ kind: 'error', message: `FaceDetector: ${error.message}` })
        },
      }),
    [],
  )
  const outputs = useMemo(() => [detectorOutput], [detectorOutput])

  // ---- render ------------------------------------------------------------

  const t = strings(locale)

  if (screen.kind === 'result') {
    return (
      <ResultView
        passed={screen.passed}
        reasons={screen.reasons}
        locale={locale}
        theme={theme}
        reduceMotion={reduceMotion}
        onRetry={() => beginRef.current()}
        onDone={onCancel}
      />
    )
  }
  if (!hasPermission) {
    return <Notice theme={theme} text={t.errors.cameraPermission} action={t.result.retry} onPress={() => void requestPermission()} />
  }
  if (!device) {
    return <Notice theme={theme} text={t.errors.noCamera} action={t.result.cancel} onPress={onCancel} />
  }
  if (screen.kind === 'error') {
    return (
      <Notice
        theme={theme}
        text={[t.errors.generic, screen.message, RECENT_LOG.join('\n')].join('\n\n')}
        action={t.result.retry}
        onPress={() => {
          started.current = false
          beginRef.current()
        }}
      />
    )
  }

  const holding = state.holdProgress > 0.05
  const instruction =
    state.phase === 'uploading'
      ? t.uploading
      : instructionFor(locale, state.framing, state.awaitingRecenter ? 'center' : state.challenge, holding, state.awaitingRecenter ? 0 : state.stepPhase)

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={styles.fill} accessible accessibilityLabel={t.a11y.preview}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={screen.kind === 'capturing' && state.phase === 'running'}
          outputs={outputs}
          constraints={CAMERA_CONSTRAINTS}
          implementationMode="compatible"
          onError={(error) => {
            log('camera error', error)
            session.current?.abort('captureFailed')
            setScreen({ kind: 'error', message: `${error.name}: ${error.message}` })
          }}
        />
      </View>

      <FrameOverlay size={{ x: 0, y: 0, width, height }} theme={theme} phase={state.phase} framing={state.framing} progress={state.holdProgress} reduceMotion={reduceMotion} />

      {state.framing === 'ok' && state.phase === 'running' && !state.awaitingRecenter ? (
        <DirectionHint challenge={state.challenge} width={width} height={height} theme={theme} reduceMotion={reduceMotion} />
      ) : null}

      <View style={styles.hud} pointerEvents="box-none">
        <View style={styles.top} pointerEvents="box-none">
          {onCancel ? (
            <Pressable accessibilityRole="button" accessibilityLabel={t.result.cancel} onPress={onCancel} style={[styles.close, { backgroundColor: theme.colors.surface }]}>
              <Text style={{ color: theme.colors.text, fontSize: 18, lineHeight: 20 }}>×</Text>
            </Pressable>
          ) : null}
        </View>
        <View style={styles.bottom} pointerEvents="box-none">
          <InstructionBanner text={instruction} theme={theme} reduceMotion={reduceMotion} tone={state.framing === 'multipleFaces' ? 'warning' : 'normal'} />
          <View style={styles.dots}>
            {state.phase === 'uploading' ? (
              <ActivityIndicator color={theme.colors.accent} />
            ) : (
              <StepDots count={state.stepCount} current={state.stepIndex} theme={theme} label={t.a11y.progress(Math.min(state.stepIndex + 1, state.stepCount), state.stepCount)} />
            )}
          </View>
          {debug ? (
            <Text style={[styles.debug, { color: theme.colors.textDim }]}>
              {(live
                ? `yaw ${live.yaw.toFixed(1)}  pitch ${live.pitch.toFixed(1)}  mouth ${live.mouthOpen.toFixed(2)}  w ${live.box.w.toFixed(2)}  n=${live.count}  phase ${state.stepPhase + 1}/${state.phaseCount}${state.awaitingRecenter ? ' recenter' : ''}`
                : 'no frames yet') + '\n' + RECENT_LOG.slice(-3).join('\n')}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  )
}

function Notice({ theme, text, action, onPress }: { theme: EKYCTheme; text: string; action: string; onPress?: (() => void) | undefined }) {
  return (
    <View style={[styles.notice, { backgroundColor: theme.colors.background }]}>
      <Text style={[theme.typography.body, { color: theme.colors.text, textAlign: 'center' }]}>{text}</Text>
      {onPress ? (
        <Pressable accessibilityRole="button" onPress={onPress} style={[styles.noticeButton, { backgroundColor: theme.colors.accent }]}>
          <Text style={[styles.noticeButtonText, { color: theme.colors.onAccent ?? '#0A0E1A' }]}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const idleState: LivenessState = {
  phase: 'idle',
  stepIndex: 0,
  stepCount: 1,
  challenge: null,
  holdProgress: 0,
  framing: 'noFace',
  stepMetrics: {},
  stepPhase: 0,
  phaseCount: 1,
  awaitingRecenter: false,
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  hud: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'space-between' },
  top: { paddingTop: 56, paddingHorizontal: 20, alignItems: 'flex-start' },
  close: { width: 36, height: 36, borderRadius: 999, alignItems: 'center', justifyContent: 'center' },
  bottom: { paddingBottom: 48, gap: 20 },
  dots: { alignItems: 'center' },
  debug: { textAlign: 'center', fontSize: 11, fontVariant: ['tabular-nums'], paddingHorizontal: 16 },
  notice: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 20 },
  noticeButton: { paddingHorizontal: 24, height: 48, borderRadius: 14, justifyContent: 'center' },
  noticeButtonText: { fontSize: 16, fontWeight: '700' },
})
