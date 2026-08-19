import type { ChallengeName } from '@ekyc/react-native-ekyc'

/**
 * The actions the light local flow asks for. `center` is always implied
 * first. Every one is a movement relative to the neutral frame (turn, open
 * then close, closer/farther then back); `nod` and `closeEyes` remain
 * available to hosts that pass their own list.
 */
export const LOCAL_CHALLENGES: readonly ChallengeName[] = ['turnLeft', 'turnRight', 'openMouth', 'moveCloser', 'moveFarther']

/**
 * A random order of the local challenges — all of them by default, so every
 * run exercises both turns, the mouth and both distances. Random order matters
 * as much as on the server: a recording only replays if it happens to match.
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
