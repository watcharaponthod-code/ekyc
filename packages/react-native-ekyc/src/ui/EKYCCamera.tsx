import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import {
  Camera,
  CommonResolutions,
  useCameraDevice,
  useCameraPermission,
  usePhotoOutput,
} from 'react-native-vision-camera'
import {
  createFaceDetectorOutput,
  type Face,
} from 'react-native-vision-camera-face-detector'

import type { EKYCClient } from '../client/EKYCClient'
import { LivenessSession } from '../liveness/LivenessSession'
import { buildChallenges, type ChallengeTuning } from '../liveness/challenges'
import {
  DEFAULT_SESSION_OPTIONS,
  type ChallengeName,
  type CreatedSession,
  type Decision,
  type EvidenceFrame,
  type FaceSignal,
  type LivenessState,
  type Purpose,
  type SessionEvent,
  type StepObservation,
} from '../types'
import { DirectionHint } from './DirectionHint'
import { FrameOverlay } from './FrameOverlay'
import { InstructionBanner } from './InstructionBanner'
import { ResultView } from './ResultView'
import { StepDots } from './StepDots'
import { instructionFor, strings, type Locale } from './copy'
import { hapticFailure, hapticStep, hapticSuccess } from './haptics'
import { defaultTheme, type EKYCTheme } from './theme'

export type EKYCCameraProps = {
  client: EKYCClient
  purpose: Purpose
  /** Required when `purpose` is `verify`. */
  personId?: string
  displayName?: string
  /** `reduced` asks for a single challenge — step-up auth on a known person. */
  tier?: 'full' | 'reduced'
  locale?: Locale
  theme?: EKYCTheme
  tuning?: ChallengeTuning
  onResult: (decision: Decision) => void
  onCancel?: (() => void) | undefined
  onProgress?: ((state: LivenessState) => void) | undefined
  /** Shows live yaw/pitch/eye numbers — use it once to calibrate `yawSign`. */
  debug?: boolean
}

/** Last few diagnostic lines, kept so a phone with no cable can still show why. */
const RECENT_LOG: string[] = []
/** Set by the mounted EKYCCamera so module-level `log` can reach the server. */
let remoteSink: ((message: string, detail?: string) => void) | null = null
function log(message: string, detail?: unknown): void {
  const text = detail === undefined ? undefined : detail instanceof Error ? `${detail.name}: ${detail.message}` : String(detail)
  const line = `${new Date().toISOString().slice(11, 19)} ${message}${text ? ` ${text}` : ''}`
  RECENT_LOG.push(line)
  if (RECENT_LOG.length > 12) RECENT_LOG.shift()
  if (__DEV__) console.warn(`[ekyc] ${line}`)
  remoteSink?.(message, text)
}

type Screen =
  | { kind: 'starting' }
  | { kind: 'capturing' }
  | { kind: 'result'; passed: boolean; reasons: string[] }
  | { kind: 'error'; message: string }

/**
 * The capture screen: camera, coaching, challenge flow, upload.
 *
 * It owns everything stateful and nothing decisional. The rules about *when* a
 * step is satisfied live in `LivenessSession` (pure, unit-tested); the rules
 * about whether the person is real live on the server. This component's job is
 * to keep the two supplied — frames in, photos out — and to make the wait
 * pleasant.
 *
 * There are no worklets here, deliberately. The face detector delivers to the
 * JS thread and photos are taken with the normal capture API, which keeps the
 * whole flow inspectable with ordinary debugging tools.
 */
export function EKYCCamera({
  client,
  purpose,
  personId,
  displayName,
  tier = 'full',
  locale = 'th',
  theme = defaultTheme,
  tuning,
  onResult,
  onCancel,
  onProgress,
  debug = false,
}: EKYCCameraProps) {
  const { width, height } = useWindowDimensions()
  const device = useCameraDevice('front')
  const { hasPermission, requestPermission } = useCameraPermission()

  const [screen, setScreen] = useState<Screen>({ kind: 'starting' })
  const [state, setState] = useState<LivenessState>(idleState)
  const [reduceMotion, setReduceMotion] = useState(false)
  const [live, setLive] = useState<FaceSignal | null>(null)

  // Host callbacks through refs: apps pass inline arrows, whose identity
  // changes every render. Nothing internal may depend on them directly, or the
  // session — created once — ends up talking to stale closures.
  const onResultRef = useRef(onResult)
  onResultRef.current = onResult
  const onProgressRef = useRef(onProgress)
  onProgressRef.current = onProgress

  const handleEventRef = useRef<(event: SessionEvent) => void>(() => {})
  const remote = useRef<CreatedSession | null>(null)
  const session = useRef<LivenessSession | null>(null)
  const frames = useRef<Map<string, string>>(new Map())
  const observations = useRef<StepObservation[]>([])
  const stepStartedAt = useRef(0)
  const startedAt = useRef(0)
  const latest = useRef<FaceSignal | null>(null)
  const capturing = useRef(false)
  const submitted = useRef(false)

  const photoOutput = usePhotoOutput({
    targetResolution: CommonResolutions.HD_4_3,
    quality: 0.9,
    // Speed matters more than the last few percent of detail: the shutter
    // fires mid-hold, and a slow one lets the pose lapse before it lands.
    qualityPrioritization: 'speed',
  })

  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduceMotion).catch(() => {})
  }, [])

  // Every diagnostic line the screen produces is also sent to the server, so a
  // phone in someone's hand and the server it talks to share one log.
  useEffect(() => {
    const device = `${Platform.OS} ${Platform.Version}`
    remoteSink = (message, detail) =>
      client.clientLog({
        device,
        level: 'info',
        message,
        ...(detail ? { detail } : {}),
        ...(remote.current ? { session: remote.current.sessionId } : {}),
      })
    log('mounted', `${purpose} tier=${tier}`)
    return () => {
      remoteSink = null
    }
  }, [client, purpose, tier])

  // ---- capture -----------------------------------------------------------

  const capture = useCallback(
    async (key: string) => {
      if (capturing.current) return
      capturing.current = true
      try {
        const photo = await photoOutput.capturePhotoToFile(
          // No shutter sound: not one surveyed identity SDK plays audio here.
          { enableShutterSound: false, flashMode: 'off' },
          {},
        )
        frames.current.set(key, photo.filePath)
        log('captured', key)
      } catch (error) {
        log('capture failed', (error as Error).message)
        session.current?.abort('captureFailed')
      } finally {
        capturing.current = false
      }
    },
    [photoOutput],
  )

  // ---- upload ------------------------------------------------------------

  const submit = useCallback(async () => {
    const created = remote.current
    if (!created || submitted.current) return
    submitted.current = true

    const evidence: EvidenceFrame[] = [...frames.current].map(([key, uri]) => ({ key, uri }))
    try {
      const decision = await client.submit(created.sessionId, {
        manifest: {
          nonce: created.nonce,
          startedAt: startedAt.current,
          finishedAt: Date.now(),
          steps: observations.current,
          capture: { frameWidth: width, frameHeight: height, fps: 30, mirrored: true },
        },
        frames: evidence,
      })
      session.current?.notifyResult(decision.decision === 'pass')
      if (decision.decision === 'pass') hapticSuccess()
      else hapticFailure()
      setScreen({ kind: 'result', passed: decision.decision === 'pass', reasons: decision.reasons })
      onResultRef.current(decision)
    } catch (error) {
      hapticFailure()
      const code = (error as { code?: string }).code ?? 'NETWORK'
      setScreen({ kind: 'result', passed: false, reasons: [code] })
    }
  }, [client, width, height])

  // ---- session lifecycle -------------------------------------------------

  const begin = useCallback(async () => {
    frames.current.clear()
    observations.current = []
    submitted.current = false
    setScreen({ kind: 'starting' })

    try {
      const created = await client.createSession({
        purpose,
        ...(personId ? { personId } : {}),
        ...(displayName ? { displayName } : {}),
        tier,
      } as never)
      remote.current = created
      log('session', `${created.sessionId.slice(0, 10)} ${created.challenges.join(',')}`)
      log('camera', device ? `${device.position} ${device.id}` : 'NO DEVICE')
      log('permission', String(hasPermission))

      const challenges = buildChallenges(created.challenges as ChallengeName[], tuning)
      const now = Date.now()
      startedAt.current = now
      stepStartedAt.current = now

      const next = new LivenessSession(
        challenges,
        {
          holdMs: created.policy.holdMs || DEFAULT_SESSION_OPTIONS.holdMs,
          perStepTimeoutMs: created.policy.perStepTimeoutMs,
          totalTimeoutMs: created.policy.totalTimeoutMs,
        },
        (event) => handleEventRef.current(event),
      )
      session.current = next
      setState(next.start(now))
      setScreen({ kind: 'capturing' })
    } catch (error) {
      log('createSession failed', (error as Error).message)
      setScreen({ kind: 'error', message: (error as Error).message })
    }
  }, [client, purpose, personId, displayName, tier, tuning])

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      if (event.type === 'capture') {
        void capture(event.stepIndex === 0 ? 'neutral' : event.challenge)
        return
      }
      if (event.type === 'stepComplete') {
        hapticStep()
        const signal = latest.current
        observations.current.push({
          name: event.challenge,
          tStart: stepStartedAt.current,
          tEnd: Date.now(),
          observed: {
            yaw: signal?.yaw ?? 0,
            pitch: signal?.pitch ?? 0,
            roll: signal?.roll ?? 0,
            leftEye: signal?.leftEye ?? 1,
            rightEye: signal?.rightEye ?? 1,
            smile: signal?.smile ?? 0,
          },
        })
        stepStartedAt.current = Date.now()
        return
      }
      if (event.type === 'complete') {
        void submit()
        return
      }
      log('liveness failed', event.reason)
      hapticFailure()
      setScreen({ kind: 'result', passed: false, reasons: [`LOCAL_${event.reason}`] })
    },
    [capture, submit],
  )

  // Start once permission is granted — and only then. This effect must not
  // depend on `begin`: `begin` closes over props like `tuning`, which host apps
  // routinely pass as fresh object literals, so its identity changes on every
  // parent render. With `begin` in the deps the cleanup aborted the running
  // session and restarted it each time the host re-rendered, which on a phone
  // (busier than an emulator) surfaced as an immediate "error" screen.
  const beginRef = useRef(begin)
  beginRef.current = begin
  handleEventRef.current = handleEvent
  const started = useRef(false)
  useEffect(() => {
    if (!hasPermission) {
      started.current = false
      void requestPermission()
      return
    }
    if (started.current) return
    started.current = true
    void beginRef.current()
    return () => {
      session.current?.abort('cancelled')
    }
  }, [hasPermission, requestPermission])

  // ---- per-frame ---------------------------------------------------------

  const onFacesDetected = useCallback(
    (faces: Face[]) => {
      const current = session.current
      if (!current) return
      const signal = toSignal(faces)
      latest.current = signal
      if (debug) setLive(signal)
      const next = current.feed(signal)
      setState(next)
      onProgressRef.current?.(next)
    },
    [debug],
  )

  // Created exactly once, via the factory rather than `useFaceDetectorOutput`.
  //
  // Measured on device: the hook rebuilt the output on *every* render — its
  // `useMemo` depends on a rest-object (`...options`) that is a fresh identity
  // per call regardless of what you pass in — so the camera session
  // reconfigured itself ~30 times a second, the preview never delivered a
  // frame (black screen) and the session eventually errored out. Callbacks go
  // through refs so the one output can reach the latest closure.
  const facesRef = useRef(onFacesDetected)
  facesRef.current = onFacesDetected
  const detectorOutput = useMemo(
    () =>
      createFaceDetectorOutput({
        performanceMode: 'fast',
        runClassifications: true,
        runLandmarks: false,
        runContours: false,
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

  const outputs = useMemo(() => [detectorOutput, photoOutput], [detectorOutput, photoOutput])


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
        onRetry={() => void begin()}
        onDone={onCancel}
      />
    )
  }

  if (!hasPermission) {
    return (
      <Notice
        theme={theme}
        text={t.errors.cameraPermission}
        action={t.result.retry}
        onPress={() => void requestPermission()}
      />
    )
  }
  if (!device) {
    return <Notice theme={theme} text={t.errors.noCamera} action={t.result.cancel} onPress={onCancel} />
  }
  if (screen.kind === 'error') {
    return (
      <Notice
        theme={theme}
        text={[t.errors.generic, screen.message, RECENT_LOG.join(String.fromCharCode(10))].join(String.fromCharCode(10) + String.fromCharCode(10))}
        action={t.result.retry}
        onPress={() => {
          started.current = false
          void beginRef.current()
        }}
      />
    )
  }

  const holding = state.holdProgress > 0.05
  const instruction =
    state.phase === 'uploading'
      ? t.uploading
      : instructionFor(locale, state.framing, state.challenge, holding)

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={styles.fill} accessible accessibilityLabel={t.a11y.preview}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          isActive={screen.kind === 'capturing' && state.phase === 'running'}
          outputs={outputs}
          onError={(error) => {
            // A camera that will not start is not a liveness failure; show
            // the real message so a device-specific problem can be diagnosed
            // from a screenshot instead of a generic "something went wrong".
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

      {/* Only while the framing is good: pointing somewhere is noise when the
          user still has to get their face into the oval. */}
      {state.framing === 'ok' && state.phase === 'running' ? (
        <DirectionHint
          challenge={state.challenge}
          width={width}
          height={height}
          theme={theme}
          reduceMotion={reduceMotion}
          yawSign={tuning?.turn?.yawSign ?? 1}
        />
      ) : null}

      <View style={styles.hud} pointerEvents="box-none">
        <View style={styles.top} pointerEvents="box-none">
          {onCancel ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.result.cancel}
              onPress={onCancel}
              style={[styles.close, { backgroundColor: theme.colors.surface }]}
            >
              <Text style={{ color: theme.colors.text, fontSize: 18, lineHeight: 20 }}>×</Text>
            </Pressable>
          ) : null}
        </View>

        <View style={styles.bottom} pointerEvents="box-none">
          <InstructionBanner
            text={instruction}
            theme={theme}
            reduceMotion={reduceMotion}
            tone={state.framing === 'multipleFaces' ? 'warning' : 'normal'}
          />

          <View style={styles.dots}>
            {state.phase === 'uploading' ? (
              <ActivityIndicator color={theme.colors.accent} />
            ) : (
              <StepDots
                count={state.stepCount}
                current={state.stepIndex}
                theme={theme}
                label={t.a11y.progress(Math.min(state.stepIndex + 1, state.stepCount), state.stepCount)}
              />
            )}
          </View>

          {debug ? (
            <Text style={[styles.debug, { color: theme.colors.textDim }]}>
              {(live
                ? `yaw ${live.yaw.toFixed(1)}  pitch ${live.pitch.toFixed(1)}  eyes ${live.leftEye.toFixed(2)}/${live.rightEye.toFixed(2)}  w ${live.box.w.toFixed(2)}  n=${live.count}`
                : 'no frames yet') + String.fromCharCode(10) + RECENT_LOG.slice(-4).join(String.fromCharCode(10))}
            </Text>
          ) : null}
        </View>
      </View>
    </View>
  )
}

function Notice({
  theme,
  text,
  action,
  onPress,
}: {
  theme: EKYCTheme
  text: string
  action: string
  onPress?: (() => void) | undefined
}) {
  return (
    <View style={[styles.notice, { backgroundColor: theme.colors.background }]}>
      <Text style={[theme.typography.body, { color: theme.colors.text, textAlign: 'center' }]}>
        {text}
      </Text>
      {onPress ? (
        <Pressable
          accessibilityRole="button"
          onPress={onPress}
          style={[styles.noticeButton, { backgroundColor: theme.colors.accent }]}
        >
          <Text style={styles.noticeButtonText}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  )
}

/**
 * ML Kit faces → our one-frame vocabulary.
 *
 * Bounds arrive in frame pixels, so they are normalised here; every threshold
 * downstream is then resolution-independent.
 */
export function toSignal(faces: Face[], now: number = Date.now()): FaceSignal {
  const empty: FaceSignal = {
    count: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    leftEye: 1,
    rightEye: 1,
    smile: 0,
    box: { x: 0, y: 0, w: 0, h: 0 },
    t: now,
  }
  if (faces.length === 0) return empty

  const face = faces.reduce((biggest, candidate) =>
    candidate.bounds.width > biggest.bounds.width ? candidate : biggest,
  )
  const fw = face.frameWidth || 1
  const fh = face.frameHeight || 1

  return {
    count: faces.length,
    yaw: face.yawAngle,
    pitch: face.pitchAngle,
    roll: face.rollAngle,
    leftEye: face.leftEyeOpenProbability ?? 1,
    rightEye: face.rightEyeOpenProbability ?? 1,
    smile: face.smilingProbability ?? 0,
    box: {
      x: face.bounds.x / fw,
      y: face.bounds.y / fh,
      w: face.bounds.width / fw,
      h: face.bounds.height / fh,
    },
    t: now,
  }
}

const idleState: LivenessState = {
  phase: 'idle',
  stepIndex: 0,
  stepCount: 1,
  challenge: null,
  holdProgress: 0,
  framing: 'noFace',
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  fill: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  hud: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'space-between' },
  top: { paddingTop: 56, paddingHorizontal: 20, alignItems: 'flex-start' },
  close: {
    width: 36,
    height: 36,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bottom: { paddingBottom: 48, gap: 20 },
  dots: { alignItems: 'center' },
  debug: {
    textAlign: 'center',
    fontSize: 11,
    fontVariant: ['tabular-nums'],
    paddingHorizontal: 16,
  },
  notice: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 20 },
  noticeButton: { paddingHorizontal: 24, height: 48, borderRadius: 14, justifyContent: 'center' },
  noticeButtonText: { color: '#0A0E1A', fontSize: 16, fontWeight: '700' },
})
