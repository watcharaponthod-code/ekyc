import type { ChallengeName } from '@ekyc/react-native-ekyc'

/** The four actions the local flow can ask for. `center` is always implied first. */
export const LOCAL_CHALLENGES: readonly ChallengeName[] = ['turnLeft', 'turnRight', 'openMouth', 'nod']

/**
 * A random order of the local challenges — all of them by default, so every
 * run exercises two head axes plus the mouth. Random order matters as much as
 * on the server: a recording only replays if it happens to match the order.
 */
export function pickLocalChallenges(
  count: number = LOCAL_CHALLENGES.length,
  random: () => number = Math.random,
): ChallengeName[] {
  const pool = [...LOCAL_CHALLENGES]
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pool[i], pool[j]] = [pool[j]!, pool[i]!]
  }
  return pool.slice(0, Math.max(1, Math.min(count, pool.length)))
}
