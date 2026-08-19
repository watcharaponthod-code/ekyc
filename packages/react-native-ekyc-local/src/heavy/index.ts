/**
 * `@ekyc/react-native-ekyc-local/heavy` — the MobileFaceNet + rPPG edition.
 *
 * Needs `react-native-fast-tflite`, `expo-image-manipulator`, `expo-asset` and
 * `jpeg-js` in the host app. Kept out of the main entry so the light flow
 * carries none of it. Field logs (2026-08-19) showed the still-image path
 * failing on a real device; treat this entry as experimental until it has
 * been made to work end-to-end on a phone.
 */
export { LocalLivenessCameraHeavy } from './LocalLivenessCameraHeavy'
export type { LocalLivenessCameraProps as LocalLivenessCameraHeavyProps, LocalResult as LocalHeavyResult, PulseRule, SessionReport as HeavySessionReport } from './LocalLivenessCameraHeavy'
export { FaceEmbedder, cropFace, faceThumbnail } from './embedder'
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
  flipHorizontal,
  judge,
  l2normalize,
  preprocessRgba,
} from './identity'
export type { ConsistencyReport, DecodedImage, FrameEmbedding, LocalVerdict, Topology } from './identity'
export { DEFAULT_PULSE_MIN, PROMINENCE_CENTRE_DB, pulseLivenessScore } from './pulse'
export type { PulseResult, Rgb } from './pulse'
export { DEFAULT_PATCHES, FACE_THUMB, patchMean, samplePatches, stableFaceBox } from './skin'
export type { RelRect } from './skin'
