/**
 * `@ekyc/react-native-ekyc-local`
 *
 * 100 % on-device liveness + identity: ML Kit drives turn-left / turn-right /
 * open-mouth / nod, MobileFaceNet (TFLite, 5 MB) embeds every captured pose
 * and the frames are compared pairwise. No network, no server, no biometric
 * data leaves the phone.
 *
 * ```tsx
 * <LocalLivenessCamera
 *   reference={savedEmbedding}          // optional: verify against an enrolled face
 *   onResult={(r) => r.passed ? next(r.embedding) : retry(r.reasons)}
 * />
 * ```
 */
export { LocalLivenessCamera } from './LocalLivenessCamera'
export type { LocalLivenessCameraProps, LocalResult } from './LocalLivenessCamera'
export { FaceEmbedder, cropFace } from './embedder'
export type { FaceCrop } from './embedder'
export {
  DEFAULT_CONSISTENCY_MIN,
  DEFAULT_MATCH_MIN,
  EMBEDDING_DIM,
  EMBEDDING_INPUT,
  base64ToBytes,
  consistency,
  cosine,
  decodeJpeg,
  embeddingFromJson,
  embeddingToJson,
  judge,
  l2normalize,
  preprocessRgba,
} from './identity'
export type { ConsistencyReport, DecodedImage, FrameEmbedding, LocalVerdict } from './identity'
export { LOCAL_CHALLENGES, pickLocalChallenges } from './challenges'
