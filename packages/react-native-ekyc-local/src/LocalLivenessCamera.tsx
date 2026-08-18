import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, ActivityIndicator, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native'
import { Camera, useCameraDevice, useCameraPermission, type CameraRef } from 'react-native-vision-camera'
import {
  createFaceDetectorOutput,
  createImageFaceDetector,
  type Face,
  type ImageFaceDetector,
} from 'react-native-vision-camera-face-detector'

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
} from '@ekyc/react-native-ekyc'

import { FaceEmbedder } from './embedder'
import { judge, type FrameEmbedding, type LocalVerdict } from './identity'
import { pickLocalChallenges } from './challenges'

export type LocalResult = LocalVerdict & {
  /** Embedding of the neutral frame — save it to enrol this person locally. */
  embedding: Float32Array | null
  /** Per-frame embeddings, for the debug screen. */
  frames: FrameEmbedding[]
  /** Wall-clock: challenge phase and embedding phase, ms. */
  timings: { captureMs: number; embedMs: number }
  /** Which challenges were asked, in order (excluding `center`). */
  challenges: ChallengeName[]
}

export type LocalLivenessCameraProps = {
  onResult: (result: LocalResult) => void
  onCancel?: (() => void) | undefined
  onProgress?: ((state: LivenessState) => void) | undefined
  /**
   * Challenges to ask, in order, `center` implied first. Default: a random
   * order of turnLeft / turnRight / openMouth / nod (`pickLocalChallenges`).
   */
  challenges?: ChallengeName[] | undefined
  /** A saved neutral embedding to verify against, or null to only check consistency. */
  reference?: ArrayLike<number> | null | undefined
  consistencyMin?: number | undefined
  matchMin?: number | undefined
  /** Share one embedder across screens so the model loads once. */
  embedder?: FaceEmbedder | undefined
  locale?: Locale
  theme?: EKYCTheme
  tuning?: ChallengeTuning
  debug?: boolean
}

const CAMERA_CONSTRAINTS = [{ fps: 60 }]

type Screen =
  | { kind: 'starting' }
  | { kind: 'capturing' }
  | { kind: 'judging' }
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
 * The 100 %-on-device flow.
 *
 * Same coaching, same challenge engine and same UI as `EKYCCamera`, but no
 * server: after the last challenge the captured stills are re-detected with
 * ML Kit (exact face box + roll in the JPEG), embedded with MobileFaceNet and
 * compared pairwise. Pass = every pair looks like the same person (and, when a
 * `reference` is given, the neutral frame matches it).
 *
 * What this proves: the person did the actions live and one face did all of
 * them. What it does not prove: that the face is not a screen, a print or a
 * mask — there is no PAD model on the phone in this build. See the README.
 */
export function LocalLivenessCamera({
  onResult,
  onCancel,
  onProgress,
  challenges,
  reference,
  consistencyMin,
  matchMin,
  embedder,
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
  const cameraRef = useRef<CameraRef>(null)

  const onResultRef = useRef(onResult)
  onResultRef.current = onResult
  const onProgressRef = useRef(onProgress)
  onProgressRef.current = onProgress
  const handleEventRef = useRef<(e: SessionEvent) => void>(() => {})

  const session = useRef<LivenessSession | null>(null)
  const issued = useRef<ChallengeName[]>([])
  const frames = useRef<Map<string, string>>(new Map())
  const pending = useRef<Promise<void>[]>([])
  const latest = useRef<FaceSignal | null>(null)
  const startedAt = useRef(0)
  const finished = useRef(false)

  const ownEmbedder = useMemo(() => embedder ?? new FaceEmbedder(), [embedder])
  const stillDetector = useRef<ImageFaceDetector | null>(null)

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {})
    // Warm the model while the user reads the first instruction.
    ownEmbedder.load().catch((error: Error) => log('model load failed', error))
  }, [ownEmbedder])

  // ---- capture -----------------------------------------------------------

  const snapshot = useCallback(async (key: string) => {
    const t0 = Date.now()
    try {
      const camera = cameraRef.current
      if (!camera) throw new Error('camera not mounted')
      const image = await camera.takeSnapshot()
      const path = await image.saveToTemporaryFileAsync('jpg', 90)
      frames.current.set(key, path)
      log('captured', `${key} ${Date.now() - t0}ms`)
    } catch (error) {
      log('capture failed', `${key}: ${(error as Error).message}`)
      session.current?.abort('captureFailed')
    }
  }, [])

  // ---- judge -------------------------------------------------------------

  const judgeAll = useCallback(async () => {
    if (finished.current) return
    finished.current = true
    setScreen({ kind: 'judging' })
    await Promise.all(pending.current)
    pending.current = []
    const captureMs = Date.now() - startedAt.current
    if (session.current?.state.phase === 'failed') return

    const t0 = Date.now()
    const embeddings: FrameEmbedding[] = []
    const reasons: string[] = []
    if (!stillDetector.current) {
      stillDetector.current = createImageFaceDetector({ performanceMode: 'accurate', minFaceSize: 0.15 })
    }
    for (const [key, uri] of frames.current) {
      try {
        const faces = stillDetector.current.detectFaces(uri)
        if (faces.length === 0) {
          log('no face in still', key)
          reasons.push('NO_FACE')
          continue
        }
        const face = faces.reduce((a, b) => (b.bounds.width > a.bounds.width ? b : a))
        const fw = face.frameWidth || 1
        const fh = face.frameHeight || 1
        const embedding = await ownEmbedder.embed({
          uri,
          box: { x: face.bounds.x / fw, y: face.bounds.y / fh, w: face.bounds.width / fw, h: face.bounds.height / fh },
          roll: face.rollAngle,
          mirrored: true,
        })
        embeddings.push({ key, embedding })
      } catch (error) {
        log('embed failed', `${key}: ${(error as Error).message}`)
        reasons.push('FRAME_UNREADABLE')
      }
    }
    const embedMs = Date.now() - t0
    const verdict = judge(embeddings, {
      ...(consistencyMin !== undefined ? { consistencyMin } : {}),
      ...(matchMin !== undefined ? { matchMin } : {}),
      reference: reference ?? null,
    })
    const expected = 1 + issued.current.length
    if (embeddings.length < expected && !reasons.includes('NO_FACE') && !reasons.includes('FRAME_UNREADABLE')) {
      reasons.push('FRAME_MISSING')
    }
    const allReasons = [...new Set([...reasons, ...verdict.reasons])]
    const passed = allReasons.length === 0
    const neutral = embeddings.find((f) => f.key === 'neutral')?.embedding ?? null
    log('verdict', `${passed ? 'pass' : 'fail'} ${allReasons.join(',') || '-'} min=${verdict.consistency.min.toFixed(3)} embed=${embedMs}ms`)
    session.current?.notifyResult(passed)
    setScreen({ kind: 'result', passed, reasons: allReasons })
    onResultRef.current({
      ...verdict,
      passed,
      reasons: allReasons,
      embedding: neutral,
      frames: embeddings,
      timings: { captureMs, embedMs },
      challenges: issued.current,
    })
  }, [ownEmbedder, consistencyMin, matchMin, reference])

  // ---- lifecycle ---------------------------------------------------------

  const begin = useCallback(() => {
    frames.current.clear()
    pending.current = []
    finished.current = false
    issued.current = challenges ?? pickLocalChallenges()
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
  }, [challenges, tuning])

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      if (event.type === 'capture') {
        pending.current.push(snapshot(event.stepIndex === 0 ? 'neutral' : event.challenge))
        return
      }
      if (event.type === 'stepComplete') return
      if (event.type === 'complete') {
        void judgeAll()
        return
      }
      log('liveness failed', event.reason)
      setScreen({ kind: 'result', passed: false, reasons: [`LOCAL_${event.reason}`] })
    },
    [snapshot, judgeAll],
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
      latest.current = signal
      if (debug) setLive(signal)
      const next = current.feed(signal)
      onProgressRef.current?.(next)
      setState((prev) =>
        prev.phase === next.phase && prev.stepIndex === next.stepIndex && prev.framing === next.framing && prev.holdProgress === next.holdProgress
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
    screen.kind === 'judging' || state.phase === 'uploading'
      ? t.uploading
      : instructionFor(locale, state.framing, state.challenge, holding)

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={styles.fill} accessible accessibilityLabel={t.a11y.preview}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={screen.kind === 'capturing' && (state.phase === 'running' || state.phase === 'uploading')}
          outputs={outputs}
          constraints={CAMERA_CONSTRAINTS}
          ref={cameraRef}
          implementationMode="compatible"
          onError={(error) => {
            log('camera error', error)
            session.current?.abort('captureFailed')
            setScreen({ kind: 'error', message: `${error.name}: ${error.message}` })
          }}
        />
      </View>

      <FrameOverlay
        size={{ x: 0, y: 0, width, height }}
        theme={theme}
        phase={state.phase}
        framing={state.framing}
        progress={state.holdProgress}
        reduceMotion={reduceMotion}
      />

      {state.framing === 'ok' && state.phase === 'running' ? (
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
            {screen.kind === 'judging' || state.phase === 'uploading' ? (
              <ActivityIndicator color={theme.colors.accent} />
            ) : (
              <StepDots count={state.stepCount} current={state.stepIndex} theme={theme} label={t.a11y.progress(Math.min(state.stepIndex + 1, state.stepCount), state.stepCount)} />
            )}
          </View>
          {debug ? (
            <Text style={[styles.debug, { color: theme.colors.textDim }]}>
              {(live
                ? `yaw ${live.yaw.toFixed(1)}  pitch ${live.pitch.toFixed(1)}  mouth ${live.mouthOpen.toFixed(2)}  eyes ${live.leftEye.toFixed(2)}/${live.rightEye.toFixed(2)}  w ${live.box.w.toFixed(2)}`
                : 'no frames yet') + '\n' + RECENT_LOG.slice(-4).join('\n')}
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
          <Text style={styles.noticeButtonText}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

const idleState: LivenessState = { phase: 'idle', stepIndex: 0, stepCount: 1, challenge: null, holdProgress: 0, framing: 'noFace' }

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
  noticeButtonText: { color: '#0A0E1A', fontSize: 16, fontWeight: '700' },
})
