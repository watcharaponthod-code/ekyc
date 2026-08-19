/**
 * UI preview — the capture screen, without a camera.
 *
 * The native camera modules cannot load in Expo Go, but everything *visual*
 * can: this screen drives the real `LivenessSession` with synthetic
 * `FaceSignal`s, so the oval, the sealing hold ring, the step dots, the
 * instruction copy and the result screens behave exactly as they do in
 * production. Only the pixels behind the oval are fake.
 *
 * Useful for judging the design on a real device, and for demoing the flow
 * without a development build.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'

// Imported from source paths rather than the package root: the root barrel
// pulls in EKYCCamera, and that pulls in the native camera modules.
import { DirectionHint } from '@ekyc/react-native-ekyc/src/ui/DirectionHint'
import { FrameOverlay } from '@ekyc/react-native-ekyc/src/ui/FrameOverlay'
import { InstructionBanner } from '@ekyc/react-native-ekyc/src/ui/InstructionBanner'
import { IntroView } from '@ekyc/react-native-ekyc/src/ui/IntroView'
import { ResultView } from '@ekyc/react-native-ekyc/src/ui/ResultView'
import { StepDots } from '@ekyc/react-native-ekyc/src/ui/StepDots'
import { instructionFor, strings, type Locale } from '@ekyc/react-native-ekyc/src/ui/copy'
import { defaultTheme, frameGeometry } from '@ekyc/react-native-ekyc/src/ui/theme'
import { LivenessSession } from '@ekyc/react-native-ekyc/src/liveness/LivenessSession'
import { buildChallenges } from '@ekyc/react-native-ekyc/src/liveness/challenges'
import type {
  ChallengeName,
  FaceSignal,
  Framing,
  LivenessState,
} from '@ekyc/react-native-ekyc/src/types'
import { FaceMesh } from './web/FaceMesh'
import { useWebcamFace } from './web/useWebcamFace'

const theme = defaultTheme
const FPS = 20

/**
 * Web-only shim, for this demo screen only.
 *
 * Browsers do not line-break Thai (it has no inter-word spaces), so long Thai
 * paragraphs push their container wider than the viewport under
 * react-native-web. Real iOS and Android both break Thai correctly, so this
 * belongs to the preview, not to the module.
 */
if (typeof document !== 'undefined' && !document.getElementById('ekyc-preview-shim')) {
  const style = document.createElement('style')
  style.id = 'ekyc-preview-shim'
  style.textContent =
    '*{word-break:break-word;overflow-wrap:anywhere}' +
    'html,body,#root{overflow-x:hidden;max-width:100vw}'
  document.head.appendChild(style)
}
const TICK_MS = Math.round(1000 / FPS)

/** Server-issued order, faked. */
const CHALLENGES: ChallengeName[] = ['closeEyes', 'turnLeft', 'turnRight']

type Mode = 'intro' | 'capture' | 'pass' | 'fail'

/** A frame in which the simulated user is doing exactly what was asked. */
function compliantSignal(challenge: ChallengeName | null, t: number): FaceSignal {
  const base: FaceSignal = {
    count: 1,
    yaw: 0,
    pitch: 0,
    roll: 0,
    leftEye: 0.95,
    rightEye: 0.95,
    smile: 0.05,
    mouthOpen: 0.02,
    box: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 },
    t,
  }
  switch (challenge) {
    case 'closeEyes':
      return { ...base, leftEye: 0.05, rightEye: 0.05 }
    case 'turnLeft':
      return { ...base, yaw: -30 }
    case 'turnRight':
      return { ...base, yaw: 30 }
    default:
      return base
  }
}

/** Framing problems the demo can inject, to show the coaching copy. */
const FRAMING_OVERRIDES: Record<string, Partial<FaceSignal>> = {
  ok: {},
  tooFar: { box: { x: 0.45, y: 0.45, w: 0.12, h: 0.12 } },
  tooClose: { box: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 } },
  offCentre: { box: { x: 0.02, y: 0.05, w: 0.4, h: 0.4 } },
  noFace: { count: 0 },
  multipleFaces: { count: 2 },
}

/**
 * On web, `?screen=capture&step=2&progress=0.6` jumps straight to one screen
 * with the animation frozen. Handy for reviewing a single state, and for
 * capturing deterministic screenshots.
 */
function urlParams(): { screen?: Mode; step?: number; progress?: number } {
  if (typeof window === 'undefined' || !window.location?.search) return {}
  const query = new URLSearchParams(window.location.search)
  const screen = query.get('screen') as Mode | null
  const step = query.get('step')
  const progress = query.get('progress')
  return {
    ...(screen ? { screen } : {}),
    ...(step != null ? { step: Number(step) } : {}),
    ...(progress != null ? { progress: Number(progress) } : {}),
  }
}

export default function UIPreview({ locale = 'th' }: { locale?: Locale }) {
  const { width, height } = useWindowDimensions()
  const params = useRef(urlParams()).current
  const frozen = params.step != null || params.progress != null

  const [mode, setMode] = useState<Mode>(params.screen ?? 'intro')
  const [state, setState] = useState<LivenessState | null>(null)
  const [framing, setFraming] = useState<keyof typeof FRAMING_OVERRIDES>('ok')
  const [paused, setPaused] = useState(false)
  // 'webcam' drives the real LivenessSession from MediaPipe on your webcam —
  // turn your head, close your eyes, and the same rules the phone uses decide.
  // 'simulated' feeds a compliant signal, for reviewing the UI without a camera.
  const [source, setSource] = useState<'webcam' | 'simulated'>(
    typeof navigator !== 'undefined' && !!navigator.mediaDevices ? 'webcam' : 'simulated',
  )
  const cam = useWebcamFace(source === 'webcam' && mode === 'capture')
  const camRef = useRef(cam)
  camRef.current = cam

  const session = useRef<LivenessSession | null>(null)
  const clock = useRef(0)
  const framingRef = useRef(framing)
  framingRef.current = framing
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  const start = useCallback(() => {
    clock.current = 0
    const next = new LivenessSession(buildChallenges(CHALLENGES), {}, (event) => {
      if (event.type === 'complete') setTimeout(() => setMode('pass'), 900)
      if (event.type === 'failed') setTimeout(() => setMode('fail'), 400)
    })
    session.current = next
    setState(next.start(source === 'webcam' ? Date.now() : 0))
    setMode('capture')
  }, [source])

  useEffect(() => {
    if (mode !== 'capture' || frozen) return
    const timer = setInterval(() => {
      const current = session.current
      if (!current || pausedRef.current) return
      if (source === 'webcam') {
        const live = camRef.current.signal
        if (!live) return
        setState(current.feed({ ...live, t: Date.now() }))
        return
      }
      clock.current += TICK_MS
      const challenge = current.state.challenge
      const signal = {
        ...compliantSignal(challenge, clock.current),
        ...FRAMING_OVERRIDES[framingRef.current],
        t: clock.current,
      } as FaceSignal
      setState(current.feed(signal))
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [mode, frozen, source])

  if (mode === 'intro') {
    return <IntroView locale={locale} theme={theme} onStart={start} />
  }

  if (mode === 'pass' || mode === 'fail') {
    return (
      <ResultView
        passed={mode === 'pass'}
        reasons={mode === 'fail' ? ['PAD_LOW', 'QUALITY_SHARPNESS'] : []}
        locale={locale}
        theme={theme}
        onRetry={start}
        onDone={() => setMode('intro')}
      />
    )
  }

  const stepIndex = params.step ?? state?.stepIndex ?? 0
  const current: LivenessState = frozen
    ? {
        phase: 'running',
        stepIndex,
        stepCount: CHALLENGES.length + 1,
        challenge: (['center', ...CHALLENGES][stepIndex] ?? null) as ChallengeName | null,
        holdProgress: params.progress ?? 0,
        framing: framing === 'ok' ? 'ok' : (framing as Framing),
        stepMetrics: {},
        stepPhase: 0,
        phaseCount: 1,
        awaitingRecenter: false,
        retakes: 0,
      }
    : (state ?? {
        phase: 'running',
        stepIndex: 0,
        stepCount: CHALLENGES.length + 1,
        challenge: 'center',
        holdProgress: 0,
        framing: 'ok',
        stepMetrics: {},
        stepPhase: 0,
        phaseCount: 1,
        awaitingRecenter: false,
        retakes: 0,
      })
  const t = strings(locale)
  const holding = current.holdProgress > 0.05
  const instruction = instructionFor(locale, current.framing, current.challenge, holding)
  const geometry = frameGeometry(width, height)

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />

      {source === 'webcam' && cam.video ? (
        <WebVideo video={cam.video} width={width} height={height} />
      ) : null}
      {source === 'webcam' ? (
        <FaceMesh points={cam.mesh} connections={cam.connections} width={width} height={height} />
      ) : null}
      {/* Stand-in for the camera preview, so the oval has something to cut out of. */}
      <View style={[styles.fakePreview, source === 'webcam' && { opacity: 0 }]}>
        <View
          style={[
            styles.silhouette,
            {
              left: geometry.cx - geometry.rx * 0.62,
              top: geometry.cy - geometry.ry * 0.5,
              width: geometry.rx * 1.24,
              height: geometry.ry * 1.0,
              borderRadius: geometry.rx,
            },
          ]}
        />
      </View>

      <FrameOverlay
        size={{ x: 0, y: 0, width, height }}
        theme={theme}
        phase={current.phase}
        framing={current.framing}
        progress={current.holdProgress}
      />

      {current.framing === 'ok' ? (
        <DirectionHint
          challenge={current.challenge}
          width={width}
          height={height}
          theme={theme}
        />
      ) : null}

      <View style={styles.hud} pointerEvents="box-none">
        <View style={styles.top} pointerEvents="box-none">
          <Text style={styles.badge}>
            {source === 'webcam'
              ? cam.status === 'running'
                ? `WEBCAM · MediaPipe · ${cam.signal ? `yaw ${cam.signal.yaw.toFixed(0)}° eyes ${cam.signal.leftEye.toFixed(2)}` : '…'}`
                : cam.status === 'error'
                  ? `กล้องเปิดไม่ได้: ${cam.error ?? ''}`
                  : 'กำลังโหลด MediaPipe…'
              : 'PREVIEW · สัญญาณจำลอง'}
          </Text>
        </View>

        <View style={styles.bottom} pointerEvents="box-none">
          <InstructionBanner text={instruction} theme={theme} />
          <View style={styles.dots}>
            <StepDots
              count={current.stepCount}
              current={current.stepIndex}
              theme={theme}
              label={t.a11y.progress(
                Math.min(current.stepIndex + 1, current.stepCount),
                current.stepCount,
              )}
            />
          </View>

          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.controls}
          >
            <Chip
              label={source === 'webcam' ? '📷 เว็บแคม' : '🤖 จำลอง'}
              active
              onPress={() => { setSource((s) => (s === 'webcam' ? 'simulated' : 'webcam')); start() }}
            />
            <Chip label={paused ? '▶ เล่นต่อ' : '⏸ หยุด'} onPress={() => setPaused((p) => !p)} />
            {(Object.keys(FRAMING_OVERRIDES) as (keyof typeof FRAMING_OVERRIDES)[]).map((key) => (
              <Chip
                key={key}
                label={key}
                active={framing === key}
                onPress={() => setFraming(key)}
              />
            ))}
            <Chip label="↻ เริ่มใหม่" onPress={start} />
          </ScrollView>
        </View>
      </View>
    </View>
  )
}

/** Mounts a live <video> element behind the RN tree. Web only. */
function WebVideo({ video, width, height }: { video: HTMLVideoElement; width: number; height: number }) {
  const host = useRef<View>(null)
  useEffect(() => {
    // react-native-web renders View as a div; attach the video element to it.
    const el = host.current as unknown as HTMLElement | null
    if (!el) return
    video.style.cssText =
      'position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transform:scaleX(-1);'
    el.appendChild(video)
    return () => { video.remove() }
  }, [video])
  return <View ref={host} style={{ position: 'absolute', left: 0, top: 0, width, height, overflow: 'hidden' }} />
}

function Chip({
  label,
  onPress,
  active = false,
}: {
  label: string
  onPress: () => void
  active?: boolean
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      style={[styles.chip, active && { backgroundColor: theme.colors.accent }]}
    >
      <Text style={[styles.chipText, active && { color: '#0A0E1A' }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#101828', overflow: 'hidden' },
  fakePreview: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: '#1B2436',
  },
  silhouette: { position: 'absolute', backgroundColor: '#2C3852' },
  hud: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'space-between',
  },
  top: { paddingTop: 60, alignItems: 'center' },
  badge: {
    color: theme.colors.textDim,
    fontSize: 11,
    letterSpacing: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    overflow: 'hidden',
  },
  bottom: { paddingBottom: 34, gap: 16, overflow: 'hidden' },
  dots: { alignItems: 'center' },
  controls: { paddingHorizontal: 16, gap: 8, alignItems: 'center' },
  chip: {
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 14,
    height: 34,
    borderRadius: 999,
    justifyContent: 'center',
  },
  chipText: { color: '#FFFFFF', fontSize: 13, fontWeight: '600' },
})
