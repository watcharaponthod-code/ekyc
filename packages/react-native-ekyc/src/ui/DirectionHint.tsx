import { useEffect, useRef } from 'react'
import { Animated, Easing, StyleSheet, View } from 'react-native'
import Svg, { Circle, Path } from 'react-native-svg'

import type { ChallengeName } from '../types'
import { hasVisualHint, hintSide } from './hints'
import { defaultTheme, frameGeometry, type EKYCTheme } from './theme'

export type DirectionHintProps = {
  challenge: ChallengeName | null
  width: number
  height: number
  theme?: EKYCTheme
  reduceMotion?: boolean
}

/** How far outside the oval the arrows sit. */
const OUTSET = 34
const CHEVRONS = 3
const CYCLE_MS = 900

/**
 * The visual that tells you *which way* to turn.
 *
 * Text alone does not carry direction well: people read "turn left" and turn
 * the wrong way, or do not read it at all. Every vendor pairs the instruction
 * with a directional graphic for this reason — Persona animates a direction
 * hint, Regula highlights a sector, Sumsub animates a head.
 *
 * Three chevrons animate outward in sequence on the side you should turn
 * toward, and a matching arc lights up on that edge of the oval. For the
 * eyes-closed step the same slot shows a closing eye instead, because that
 * step also has no obvious visual.
 */
export function DirectionHint({
  challenge,
  width,
  height,
  theme = defaultTheme,
  reduceMotion = false,
}: DirectionHintProps) {
  const progress = useRef(new Animated.Value(0)).current

  const animating = hasVisualHint(challenge)

  useEffect(() => {
    progress.setValue(0)
    if (!animating || reduceMotion) return
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: 1,
        duration: CYCLE_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    )
    loop.start()
    return () => loop.stop()
  }, [animating, reduceMotion, progress, challenge])

  if (!animating) return null

  const geometry = frameGeometry(width, height, theme.frame)

  if (challenge === 'closeEyes') {
    return (
      <View style={StyleSheet.absoluteFill} pointerEvents="none">
        <ClosingEye
          x={geometry.cx}
          y={geometry.cy + geometry.ry + OUTSET + 18}
          progress={progress}
          color={theme.colors.accent}
          reduceMotion={reduceMotion}
        />
      </View>
    )
  }

  const towardsLeft = hintSide(challenge) === 'left'
  const edgeX = towardsLeft ? geometry.cx - geometry.rx - OUTSET : geometry.cx + geometry.rx + OUTSET

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {Array.from({ length: CHEVRONS }, (_, index) => (
        <Chevron
          key={index}
          index={index}
          x={edgeX}
          y={geometry.cy}
          towardsLeft={towardsLeft}
          progress={progress}
          color={theme.colors.accent}
          reduceMotion={reduceMotion}
        />
      ))}
    </View>
  )
}

function Chevron({
  index,
  x,
  y,
  towardsLeft,
  progress,
  color,
  reduceMotion,
}: {
  index: number
  x: number
  y: number
  towardsLeft: boolean
  progress: Animated.Value
  color: string
  reduceMotion: boolean
}) {
  // Each chevron leads the one behind it by a third of the cycle, so the group
  // reads as motion in one direction rather than three things blinking.
  const phase = index / CHEVRONS
  const shift = (towardsLeft ? -1 : 1) * 18

  // Never fully fades: a chevron that disappears reads as "nothing there",
  // which is the complaint that got this component written in the first place.
  const opacity = reduceMotion
    ? 0.7
    : progress.interpolate({
        inputRange: [0, phase, Math.min(1, phase + 0.34), 1],
        outputRange: [0.45, 1, 0.45, 0.45],
        extrapolate: 'clamp',
      })
  const translateX = reduceMotion
    ? 0
    : progress.interpolate({
        inputRange: [0, phase, Math.min(1, phase + 0.34), 1],
        outputRange: [0, shift, shift * 1.8, 0],
        extrapolate: 'clamp',
      })

  // Stacked vertically, not horizontally. The oval takes 74 % of the screen
  // width, so there is only ~13 % of margin on each side — three chevrons in a
  // row run off the edge, while the sides have plenty of vertical room. The
  // outward translation still carries the direction.
  const size = 44
  const step = (index - 1) * 46

  return (
    <Animated.View
      style={[
        styles.floating,
        { left: x - size / 2, top: y + step - size / 2, opacity, transform: [{ translateX }] },
      ]}
    >
      <Svg width={size} height={size} viewBox="0 0 24 24">
        <Path
          d={towardsLeft ? 'M15 4 L7 12 L15 20' : 'M9 4 L17 12 L9 20'}
          stroke={color}
          strokeWidth={3.2}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </Svg>
    </Animated.View>
  )
}

function ClosingEye({
  x,
  y,
  progress,
  color,
  reduceMotion,
}: {
  x: number
  y: number
  progress: Animated.Value
  color: string
  reduceMotion: boolean
}) {
  const size = 48
  // The pupil shrinks as the lid closes, which reads as an eye shutting rather
  // than a circle fading.
  const scale = reduceMotion
    ? 1
    : progress.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 0.05, 1] })

  return (
    <Animated.View style={[styles.floating, { left: x - size / 2, top: y - size / 2 }]}>
      <Svg width={size} height={size} viewBox="0 0 48 48">
        <Path
          d="M6 24 C14 12, 34 12, 42 24 C34 36, 14 36, 6 24 Z"
          stroke={color}
          strokeWidth={2.5}
          strokeLinejoin="round"
          fill="none"
        />
        <AnimatedCircle cx={24} cy={24} r={7} fill={color} scale={scale} />
      </Svg>
    </Animated.View>
  )
}

const RawAnimatedCircle = Animated.createAnimatedComponent(Circle)

function AnimatedCircle({
  cx,
  cy,
  r,
  fill,
  scale,
}: {
  cx: number
  cy: number
  r: number
  fill: string
  scale: Animated.AnimatedInterpolation<number> | number
}) {
  // `r` is animated rather than a transform: scaling an SVG child would move
  // it away from the eye's centre.
  const radius = typeof scale === 'number' ? r * scale : Animated.multiply(scale, r)
  return <RawAnimatedCircle cx={cx} cy={cy} r={radius as never} fill={fill} />
}

const styles = StyleSheet.create({
  floating: { position: 'absolute' },
})
