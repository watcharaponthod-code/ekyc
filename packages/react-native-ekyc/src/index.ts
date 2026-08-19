/**
 * `@ekyc/react-native-ekyc`
 *
 * On-device liveness capture with a server-verified decision.
 *
 * ```tsx
 * const client = new EKYCClient({ baseUrl: 'https://ekyc.example.com' })
 *
 * <EKYCCamera
 *   client={client}
 *   purpose="enroll"
 *   onResult={(d) => (d.decision === 'pass' ? next(d.personId) : retry(d.reasons))}
 *   onCancel={() => navigation.goBack()}
 * />
 * ```
 *
 * The phone never decides whether someone is real, and never stores biometric
 * data. It collects evidence and shows a good interface while doing it.
 */

export { EKYCClient, buildEvidenceParts } from './client/EKYCClient'
export type {
  CreateSessionRequest,
  EKYCClientOptions,
  EvidencePart,
} from './client/EKYCClient'

export { EKYCCamera, toSignal } from './ui/EKYCCamera'
export type { EKYCCameraProps } from './ui/EKYCCamera'

export { IntroView } from './ui/IntroView'
export type { IntroViewProps } from './ui/IntroView'
export { ResultView } from './ui/ResultView'
export type { ResultViewProps } from './ui/ResultView'
export { DirectionHint } from './ui/DirectionHint'
export { hasVisualHint, hintSide } from './ui/hints'
export type { DirectionHintProps } from './ui/DirectionHint'
export { FrameOverlay } from './ui/FrameOverlay'
export { StepDots } from './ui/StepDots'
export { InstructionBanner } from './ui/InstructionBanner'

export {
  defaultTheme,
  ellipsePerimeter,
  frameGeometry,
  holdRingDash,
} from './ui/theme'
export type { EKYCTheme, FrameGeometry } from './ui/theme'

export { explainReasons, instructionFor, strings } from './ui/copy'
export type { Locale } from './ui/copy'

export { LivenessSession } from './liveness/LivenessSession'
export { Challenge } from './liveness/Challenge'
export type { ChallengeMetric } from './liveness/Challenge'
export {
  CHALLENGE_DEFAULTS,
  CenterChallenge,
  CloseEyesChallenge,
  DEFAULT_YAW_SIGN,
  NodChallenge,
  OpenMouthChallenge,
  SmileChallenge,
  TurnLeftChallenge,
  TurnRightChallenge,
  buildChallenges,
  tuningFromPolicy,
} from './liveness/challenges'
export type {
  CenterOptions,
  ChallengeTuning,
  CloseEyesOptions,
  NodOptions,
  OpenMouthOptions,
  SmileOptions,
  TurnOptions,
} from './liveness/challenges'
export { mouthOpenness } from './liveness/mouth'
export type { MouthGeometry } from './liveness/mouth'

export { DEFAULT_SESSION_OPTIONS, EKYCError } from './types'
export type {
  Attestation,
  ChallengeName,
  CreatedSession,
  Decision,
  EKYCErrorCode,
  EvidenceBundle,
  EvidenceFrame,
  EvidenceManifest,
  FaceSignal,
  FailureReason,
  Framing,
  LivenessPhase,
  LivenessState,
  Person,
  Purpose,
  Rect,
  SessionEvent,
  SessionOptions,
  SessionPolicy,
  StepMetric,
  StepObservation,
} from './types'
