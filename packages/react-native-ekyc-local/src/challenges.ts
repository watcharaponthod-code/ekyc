import type { ChallengeName } from '@ekyc/react-native-ekyc'

/**
 * The pool the light local flow draws from. `center` is always implied first.
 * Every entry is a movement relative to the neutral frame (turn; blink =
 * closed then open; mouth open then closed; closer/farther then back).
 */
export const LOCAL_CHALLENGES: readonly ChallengeName[] = ['closeEyes', 'turnLeft', 'turnRight', 'openMouth', 'moveCloser', 'moveFarther']

/** Always in a full run — the challenge a rigid mask cannot answer. Mirrors the server's `always_open_mouth`. */
export const LOCAL_ALWAYS = 'openMouth' as const

/**
 * The same policy the server uses for a full-tier session: `openMouth`
 * always, the remaining slots drawn at random from the pool, the whole list
 * shuffled — so a local run asks the same *kind* of thing as a server run.
 * Random order matters as much as on the server: a recording only replays if
 * it happens to match.
 */
export function pickLocalChallenges(count: number = 4, random: () => number = Math.random): ChallengeName[] {
  const shuffle = (list: ChallengeName[]) => {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1))
      ;[list[i], list[j]] = [list[j]!, list[i]!]
    }
    return list
  }
  const n = Math.max(1, Math.min(count, LOCAL_CHALLENGES.length))
  const rest = shuffle(LOCAL_CHALLENGES.filter((c) => c !== LOCAL_ALWAYS)).slice(0, n - 1)
  return shuffle([LOCAL_ALWAYS, ...rest])
}
