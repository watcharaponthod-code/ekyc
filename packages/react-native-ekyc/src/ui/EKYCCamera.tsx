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
  useCameraDevice,
  useCameraPermission,
  type CameraRef,
} from 'react-native-vision-camera'
import {
  createFaceDetectorOutput,
  type Face,
} from 'react-native-vision-camera-face-detector'

import type { EKYCClient } from '../client/EKYCClient'
import { LivenessSession } from '../liveness/LivenessSession'
import { mouthOpenness } from '../liveness/mouth'
import { buildChallenges, tuningFromPolicy, type ChallengeTuning } from '../liveness/challenges'
import {
  DEFAULT_SESSION_OPTIONS,
  type Attestation,
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
import { flashHex } from './flashColors'
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
  /**
   * Device-integrity provider. Called once per session, right before upload;
   * the token it returns travels in the manifest and the server can require
   * it (`EKYC_REQUIRE_ATTESTATION`). Wire it to Play Integrity / App Attest
   * through whatever native module the host app already uses — the module
   * itself stays free of that dependency. Errors are swallowed and reported
   * as `{ type: 'none' }`.
   */
  attestation?: (() => Promise<Attestation | undefined>) | undefined
  /**
   * PAD-evaluation label (`bona_fide`, `mask_silicone`, ...). Only meaningful
   * against an evaluation server with retention on. Never set in production.
   */
  evaluationLabel?: string | undefined
}

/** Prefer 60 fps; harmless where unavailable. Module-level so its identity is stable. */
const CAMERA_CONSTRAINTS = [{ fps: 60 }]

/** How long each flash colour is held on screen before its snapshot — enough
 * for the screen to paint and the camera to expose the lit face. */
const FLASH_HOLD_MS = 350

/** Floor between two pulse-burst snapshots. The burst wants the highest rate
 * the device can give (rPPG resolves better at 15 fps than at 8), but a
 * back-to-back loop would starve the face detector and the JS thread. */
const PULSE_MIN_INTERVAL_MS = 40

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
  | { kind: 'pulsing' }
  | { kind: 'flashing'; color: string }
  | { kind: 'result'; passed: boolean; reasons: string[]; detail?: string }
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
  attestation,
  evaluationLabel,
}: EKYCCameraProps) {
  const { width, height } = useWindowDimensions()
  const device = useCameraDevice('front')
  const { hasPermission, requestPermission } = useCameraPermission()

  const [screen, setScreen] = useState<Screen>({ kind: 'starting' })
  const cameraRef = useRef<CameraRef>(null)
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
  const attestationRef = useRef(attestation)
  attestationRef.current = attestation

  const handleEventRef = useRef<(event: SessionEvent) => void>(() => {})
  const remote = useRef<CreatedSession | null>(null)
  const session = useRef<LivenessSession | null>(null)
  const frames = useRef<Map<string, string>>(new Map())
  const observations = useRef<StepObservation[]>([])
  /** Device time of each pulse-burst snapshot, in key order (`pulse_0..`). */
  const pulseTimes = useRef<number[]>([])
  const stepStartedAt = useRef(0)
  const startedAt = useRef(0)
  const latest = useRef<FaceSignal | null>(null)
  const submitted = useRef(false)
  // Detections per second, measured — the one number that decides how fast a
  // turn or a blink can register. Reported with the submission so it lands in
  // the server log next to the decision.
  const detections = useRef({ count: 0, since: 0 })


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

  // Every capture is tracked, none is dropped. The session keeps moving the
  // instant a pose is confirmed — it never waits on the shutter or the JPEG
  // write — and `submit` awaits the whole set before uploading. Measured on a
  // real phone: a guard that skipped a capture while the previous one was
  // still writing silently lost the next step's frame, and the flow crawled
  // because each hold effectively waited for disk I/O.
  const pendingCaptures = useRef<Promise<void>[]>([])

  // Stills come from the preview surface (`takeSnapshot`), never from an
  // ImageCapture stream. Three reasons, each sufficient on its own:
  //  - no shutter lag: the pixels are grabbed the instant the pose is
  //    confirmed, so a blink is actually in the frame (a photo capture
  //    lands 150–400 ms later, after the eyes have reopened);
  //  - no third stream: LIMITED/LEGACY front cameras (seen on a real Android
  //    35 phone) refuse preview + analysis + capture with "Failed to apply
  //    the stream configuration"; preview + analysis works everywhere;
  //  - no 12-MP JPEG encode on the critical path — a preview-sized frame
  //    encodes in tens of milliseconds, a full sensor frame in seconds.
  // Preview resolution (screen-sized) is far more than the server's models
  // consume (ArcFace 112 px, MiniFASNet 80 px), so nothing is lost.
  const snapshot = useCallback(async (key: string, quality: number = 85) => {
    const startedAt = Date.now()
    try {
      const camera = cameraRef.current
      if (!camera) throw new Error('camera not mounted')
      // Grab the pixels NOW (fast, in memory); encode off the critical path.
      const image = await camera.takeSnapshot()
      const path = await image.saveToTemporaryFileAsync('jpg', quality)
      frames.current.set(key, path)
      log('captured', `${key} ${Date.now() - startedAt}ms`)
    } catch (error) {
      log('capture failed', `${key}: ${(error as Error).message}`)
      session.current?.abort('captureFailed')
    }
  }, [])

  /**
   * Burst variant: grab now, encode later. Returns the grab time, or null if
   * the grab failed (a single dropped burst frame is not fatal — the server
   * counts what arrived). The encode promise is tracked so `submit` waits.
   */
  const snapshotTimed = useCallback(async (key: string): Promise<number | null> => {
    const camera = cameraRef.current
    if (!camera) return null
    const t = Date.now()
    try {
      const image = await camera.takeSnapshot()
      pendingCaptures.current.push(
        image
          .saveToTemporaryFileAsync('jpg', 85)
          .then((path) => {
            frames.current.set(key, path)
          })
          .catch((error: Error) => log('burst encode failed', `${key}: ${error.message}`)),
      )
      return t
    } catch (error) {
      log('burst grab failed', `${key}: ${(error as Error).message}`)
      return null
    }
  }, [])

  const capture = useCallback((key: string) => {
    pendingCaptures.current.push(snapshot(key))
  }, [snapshot])

  // ---- upload ------------------------------------------------------------

  const submit = useCallback(async () => {
    const created = remote.current
    if (!created || submitted.current) return
    submitted.current = true
    await Promise.all(pendingCaptures.current)
    pendingCaptures.current = []
    // A capture that failed has already aborted the session; do not upload a
    // bundle the server can only reject as FRAME_MISSING.
    if (session.current?.state.phase === 'failed') return
    const { count, since } = detections.current
    const fps = since ? Math.round((count * 1000) / Math.max(1, Date.now() - since)) : 0
    log('submitting', `${frames.current.size} frames, detector ${fps} fps`)

    const evidence: EvidenceFrame[] = [...frames.current].map(([key, uri]) => ({ key, uri }))
    let attested: Attestation | undefined
    if (attestationRef.current) {
      try {
        attested = await attestationRef.current()
      } catch (error) {
        log('attestation failed', error)
        attested = { type: 'none' }
      }
    }
    try {
      const decision = await client.submit(created.sessionId, {
        manifest: {
          nonce: created.nonce,
          startedAt: startedAt.current,
          finishedAt: Date.now(),
          steps: observations.current,
          capture: { frameWidth: width, frameHeight: height, fps, mirrored: true },
          ...(attested ? { attestation: attested } : {}),
          ...(pulseTimes.current.length > 0 ? { pulse: { times: pulseTimes.current } } : {}),
        },
        frames: evidence,
      })
      log('decision', `${decision.decision} ${decision.reasons.join(',')}`)
      session.current?.notifyResult(decision.decision === 'pass')
      if (decision.decision === 'pass') hapticSuccess()
      else hapticFailure()
      const who = decision.displayName
        ? `${strings(locale).recognisedAs(decision.displayName)}${decision.match ? ` (${(decision.match.score * 100).toFixed(0)}%)` : ''}`
        : undefined
      setScreen({ kind: 'result', passed: decision.decision === 'pass', reasons: decision.reasons, ...(who ? { detail: who } : {}) })
      onResultRef.current(decision)
    } catch (error) {
      hapticFailure()
      const code = (error as { code?: string }).code ?? 'NETWORK'
      log('submit failed', `${code}: ${(error as Error).message}`)
      setScreen({ kind: 'result', passed: false, reasons: [code] })
    }
  }, [client, width, height])

  // After the liveness steps, the active-flash phase (when the session issued
  // one): show each server-chosen colour full-screen so it lights the face,
  // snapshot the lit face as flash_i, then submit. A real face reflects the
  // random sequence; a photo/replay/injected stream cannot — the server checks
  // the correlation. Sequential and awaited so each snapshot lands under its
  // own colour.
  const runFlash = useCallback(async () => {
    const colors = remote.current?.flash ?? []
    for (let i = 0; i < colors.length; i++) {
      setScreen({ kind: 'flashing', color: colors[i]! })
      await new Promise((resolve) => setTimeout(resolve, FLASH_HOLD_MS))
      // The flash frames only need their mean face colour on the server:
      // a smaller JPEG uploads faster and changes nothing about the score.
      await snapshot(`flash_${i}`, 60)
    }
    await submit()
  }, [snapshot, submit])

  // The rPPG pulse burst (when the session issued one): the user holds still
  // and looks at the camera while we snapshot the face as fast as the device
  // allows for ~durationMs — capped at the requested frame count. The server
  // reads the heartbeat out of the skin colour across the burst; a silicone
  // mask has none. Runs before the flash so the face is under ambient light,
  // then hands over to the flash phase (or straight to submit).
  const runPulse = useCallback(async () => {
    const plan = remote.current?.pulse
    pulseTimes.current = []
    if (plan && plan.frames > 0) {
      setScreen({ kind: 'pulsing' })
      const started = Date.now()
      let index = 0
      while (index < plan.frames && Date.now() - started < plan.durationMs) {
        const tick = Date.now()
        const t = await snapshotTimed(`pulse_${index}`)
        if (t !== null) {
          pulseTimes.current.push(t)
          index += 1
        }
        const elapsed = Date.now() - tick
        if (elapsed < PULSE_MIN_INTERVAL_MS) {
          await new Promise((resolve) => setTimeout(resolve, PULSE_MIN_INTERVAL_MS - elapsed))
        }
      }
      const span = Date.now() - started
      log('pulse burst', `${index} frames in ${span}ms (${span ? Math.round((index * 1000) / span) : 0} fps)`)
    }
    if ((remote.current?.flash?.length ?? 0) > 0) await runFlash()
    else await submit()
  }, [snapshotTimed, runFlash, submit])

  // ---- session lifecycle -------------------------------------------------

  const begin = useCallback(async () => {
    frames.current.clear()
    observations.current = []
    pulseTimes.current = []
    pendingCaptures.current = []
    submitted.current = false
    setScreen({ kind: 'starting' })

    try {
      const created = await client.createSession({
        purpose,
        ...(personId ? { personId } : {}),
        ...(displayName ? { displayName } : {}),
        tier,
        ...(evaluationLabel ? { label: evaluationLabel } : {}),
      })
      remote.current = created
      log('session', `${created.sessionId.slice(0, 10)} ${created.challenges.join(',')}`)
      log(
        'camera',
        device
          ? `${device.position} ${device.id} ${device.manufacturer} ${device.modelID} formats=${device.supportedPixelFormats.join('/')}`
          : 'NO DEVICE',
      )
      log('permission', String(hasPermission))

      // Server thresholds + margin drive the client predicates, so the phone
      // never confirms a pose the server will then reject.
      const challenges = buildChallenges(created.challenges as ChallengeName[], tuningFromPolicy(created.policy, tuning))
      const now = Date.now()
      startedAt.current = now
      stepStartedAt.current = now
      detections.current = { count: 0, since: 0 }

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
  }, [client, purpose, personId, displayName, tier, tuning, evaluationLabel])

  const handleEvent = useCallback(
    (event: SessionEvent) => {
      if (event.type === 'capture') {
        void capture(event.stepIndex === 0 ? 'neutral' : event.challenge)
        return
      }
      if (event.type === 'stepComplete') {
        hapticStep()
        const metric = session.current?.state.stepMetrics[`${event.stepIndex}:${event.challenge}`]
        if (metric) log('step', `${event.challenge} best ${metric.best.toFixed(2)} needed ${metric.needed.toFixed(2)}`)
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
            mouthOpen: signal?.mouthOpen ?? 0,
          },
        })
        stepStartedAt.current = Date.now()
        return
      }
      if (event.type === 'complete') {
        void runPulse()
        return
      }
      log(
        'liveness failed',
        `${event.reason} at step ${event.stepIndex} (${event.challenge ?? '-'}) ` +
          Object.values(event.stepMetrics)
            .map((m) => `${m.challenge}:${m.best.toFixed(2)}/${m.needed.toFixed(2)}`)
            .join(' '),
      )
      hapticFailure()
      setScreen({ kind: 'result', passed: false, reasons: [`LOCAL_${event.reason}`] })
    },
    [capture, runPulse],
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
      const now = Date.now()
      if (detections.current.since === 0) detections.current.since = now
      detections.current.count += 1
      const signal = toSignal(faces)
      latest.current = signal
      if (debug) setLive(signal)
      const next = current.feed(signal)
      onProgressRef.current?.(next)
      // Re-render only when something visible moved. Most frames while the
      // user is getting into position change nothing, and a full re-render per
      // detection competes with the detector's own callbacks for the JS thread.
      setState((prev) =>
        prev.phase === next.phase &&
        prev.stepIndex === next.stepIndex &&
        prev.framing === next.framing &&
        prev.holdProgress === next.holdProgress
          ? prev
          : next,
      )
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
        // Landmarks + contours give the lip gap for the open-mouth challenge.
        // ML Kit computes contours for the most prominent face only, which is
        // the one we track anyway.
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
        detail={screen.detail}
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
    screen.kind === 'pulsing'
      ? t.pulseHold
      : state.phase === 'uploading'
        ? t.uploading
        : instructionFor(locale, state.framing, state.awaitingRecenter ? 'center' : state.challenge, holding, state.awaitingRecenter ? 0 : state.stepPhase)

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={styles.fill} accessible accessibilityLabel={t.a11y.preview}>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          // Stay on through `uploading`: the last step's snapshot may still be
          // in flight when the session completes, and deactivating the camera
          // under it fails the capture (seen: "Camera is closed" on the final
          // frame of an otherwise perfect run). Off again once there is a verdict.
          isActive={
            screen.kind === 'flashing' ||
            screen.kind === 'pulsing' ||
            (screen.kind === 'capturing' && (state.phase === 'running' || state.phase === 'uploading'))
          }
          outputs={outputs}
          // Ask the pipeline for 60 fps where the sensor supports it. VisionCamera
          // treats this as a preference and falls back gracefully, so it costs
          // nothing on a 30 fps front camera and halves frame latency on a 60.
          constraints={CAMERA_CONSTRAINTS}
          onSessionConfigSelected={(config) => log('camera config', `${config.selectedFPS ?? '?'} fps`)}
          ref={cameraRef}
          // `PreviewView.bitmap` — what takeSnapshot() reads — needs a
          // TextureView; a SurfaceView returns null. The GPU cost is nothing
          // we notice, and it makes the snapshot path work on every device.
          implementationMode="compatible"
          onError={(error) => {
            log('camera error', error)
            // A camera that will not start is not a liveness failure; show the
            // real message so a device-specific problem can be diagnosed from
            // a screenshot or the server log.
            session.current?.abort('captureFailed')
            setScreen({ kind: 'error', message: `${error.name}: ${error.message}` })
          }}
        />
      </View>

      {screen.kind === 'flashing' ? (
        <View
          pointerEvents="none"
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: flashHex(screen.color), alignItems: 'center', justifyContent: 'center', zIndex: 30 },
          ]}
        >
          <Text style={{ color: '#00000099', fontSize: 18, fontWeight: '700' }}>{t.flashHold}</Text>
        </View>
      ) : null}

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
          <Text style={[styles.noticeButtonText, { color: theme.colors.onAccent ?? '#0A0E1A' }]}>{action}</Text>
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
    mouthOpen: 0,
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
    mouthOpen: mouthOpenness(face),
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
