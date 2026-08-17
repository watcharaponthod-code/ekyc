import type { ChallengeName } from '../types'

/**
 * Which side of the screen the turn arrows belong on.
 *
 * A mirrored front-camera preview behaves like a mirror, so the user's left is
 * the screen's left. `yawSign` flips that for devices that do not mirror — the
 * same knob that flips the instruction text, so the arrow and the words can
 * never disagree.
 *
 * Kept in its own react-native-free module so it is unit-tested rather than
 * eyeballed on a device, which is exactly where direction bugs hide.
 */
export function hintSide(
  challenge: ChallengeName | null,
  yawSign: 1 | -1 = 1,
): 'left' | 'right' | null {
  if (challenge !== 'turnLeft' && challenge !== 'turnRight') return null
  const towardsLeft = (challenge === 'turnLeft') === (yawSign === 1)
  return towardsLeft ? 'left' : 'right'
}

/** Steps that get a moving visual rather than words alone. */
export function hasVisualHint(challenge: ChallengeName | null): boolean {
  return challenge === 'turnLeft' || challenge === 'turnRight' || challenge === 'closeEyes'
}
