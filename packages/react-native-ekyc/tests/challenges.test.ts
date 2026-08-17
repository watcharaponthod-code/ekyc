import {
  buildChallenges,
  CenterChallenge,
  CloseEyesChallenge,
  SmileChallenge,
  TurnLeftChallenge,
  TurnRightChallenge,
} from '../src/liveness/challenges'
import { signal } from './helpers'

describe('CenterChallenge', () => {
  const challenge = new CenterChallenge()

  it('accepts a straight-on face', () => {
    expect(challenge.isSatisfied(signal())).toBe(true)
  })

  it('rejects a turned head', () => {
    expect(challenge.isSatisfied(signal({ yaw: 20 }))).toBe(false)
    expect(challenge.isSatisfied(signal({ yaw: -20 }))).toBe(false)
  })

  it('rejects a tilted-up head', () => {
    expect(challenge.isSatisfied(signal({ pitch: -25 }))).toBe(false)
  })

  it('honours custom tolerances', () => {
    expect(new CenterChallenge({ maxYaw: 30 }).isSatisfied(signal({ yaw: 25 }))).toBe(true)
  })
})

describe('CloseEyesChallenge', () => {
  const challenge = new CloseEyesChallenge()

  it('needs both eyes closed', () => {
    expect(challenge.isSatisfied(signal({ leftEye: 0.1, rightEye: 0.1 }))).toBe(true)
    expect(challenge.isSatisfied(signal({ leftEye: 0.1, rightEye: 0.9 }))).toBe(false)
    expect(challenge.isSatisfied(signal({ leftEye: 0.9, rightEye: 0.1 }))).toBe(false)
  })

  it('rejects open eyes', () => {
    expect(challenge.isSatisfied(signal())).toBe(false)
  })
})

describe('turn challenges', () => {
  it('are mirror images of each other under the default sign', () => {
    // Default sign is calibrated on a real Android phone: ML Kit reports
    // POSITIVE yaw when the user turns to their own left.
    const left = new TurnLeftChallenge()
    const right = new TurnRightChallenge()

    expect(left.isSatisfied(signal({ yaw: 30 }))).toBe(true)
    expect(right.isSatisfied(signal({ yaw: 30 }))).toBe(false)

    expect(right.isSatisfied(signal({ yaw: -30 }))).toBe(true)
    expect(left.isSatisfied(signal({ yaw: -30 }))).toBe(false)
  })

  it('reject a head that has not turned far enough', () => {
    expect(new TurnLeftChallenge().isSatisfied(signal({ yaw: -10 }))).toBe(false)
    expect(new TurnRightChallenge().isSatisfied(signal({ yaw: 10 }))).toBe(false)
  })

  it('flip with yawSign, so a device with the opposite convention is one config change', () => {
    const left = new TurnLeftChallenge({ yawSign: 1 })
    expect(left.isSatisfied(signal({ yaw: -30 }))).toBe(true)
    expect(left.isSatisfied(signal({ yaw: 30 }))).toBe(false)
  })
})

describe('SmileChallenge', () => {
  it('needs a clear smile', () => {
    expect(new SmileChallenge().isSatisfied(signal({ smile: 0.8 }))).toBe(true)
    expect(new SmileChallenge().isSatisfied(signal({ smile: 0.5 }))).toBe(false)
  })
})

describe('buildChallenges', () => {
  it('always puts center first', () => {
    const built = buildChallenges(['turnLeft', 'closeEyes'])
    expect(built.map((c) => c.name)).toEqual(['center', 'turnLeft', 'closeEyes'])
  })

  it('does not duplicate center when the server sends it', () => {
    const built = buildChallenges(['center', 'turnRight'])
    expect(built.map((c) => c.name)).toEqual(['center', 'turnRight'])
  })

  it('preserves the server-issued order of the rest', () => {
    const built = buildChallenges(['turnRight', 'closeEyes', 'turnLeft'])
    expect(built.map((c) => c.name)).toEqual(['center', 'turnRight', 'closeEyes', 'turnLeft'])
  })

  it('passes tuning through to the built challenges', () => {
    const [, turn] = buildChallenges(['turnLeft'], { turn: { minYaw: 5 } })
    expect(turn!.isSatisfied(signal({ yaw: 6 }))).toBe(true)
  })
})
