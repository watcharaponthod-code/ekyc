import type { ChallengeName } from '../types'

/**
 * Which side of the screen the turn arrows belong on.
 *
 * A mirrored front-camera preview behaves like a mirror, so the user's left is
 * the screen's left, always. The detector's sign convention (`yawSign`) decides
 * how a turn is *recognised*; it must never move the arrow.
 *
 * Kept in its own react-native-free module so it is unit-tested rather than
 * eyeballed on a device, which is exactly where direction bugs hide.
 */
export function hintSide(challenge: ChallengeName | null): 'left' | 'right' | null {
  // The preview is a mirror: the user's left is the screen's left. Which sign
  // the detector reports for that motion is `yawSign`'s business, not the
  // arrow's — the arrow always points where the *user* should turn.
  if (challenge === 'turnLeft') return 'left'
  if (challenge === 'turnRight') return 'right'
  return null
}

/** Steps that get a moving visual rather than words alone. */
export function hasVisualHint(challenge: ChallengeName | null): boolean {
  return challenge === 'turnLeft' || challenge === 'turnRight' || challenge === 'closeEyes'
}
