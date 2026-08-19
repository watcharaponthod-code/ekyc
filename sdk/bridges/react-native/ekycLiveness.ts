// JS side of the native bridge (pairs with EkycLivenessModule.kt).
import { NativeModules } from 'react-native'

export type LivenessResult = {
  passed: boolean
  reasons: string[]
  challenges: string[]
  steps: { challenge: string; phase: number; best: number; needed: number; direction: 'above' | 'below'; reached: boolean }[]
  durationMs: number
  flashScore: number | null
  flashOk: boolean | null
  continuityOk: boolean | null
  log: string[]
}

export async function startLiveness(config: Record<string, unknown> = {}): Promise<LivenessResult> {
  const json: string = await NativeModules.EkycLiveness.start(JSON.stringify(config))
  return JSON.parse(json) as LivenessResult
}

// Usage:  const r = await startLiveness({ locale: 'th' }); if (r.passed) { … }
