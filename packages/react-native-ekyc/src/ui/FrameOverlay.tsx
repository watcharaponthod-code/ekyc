import { useEffect, useMemo, useRef } from 'react'
import { Animated, StyleSheet, View, type LayoutRectangle } from 'react-native'
import Svg, { Defs, Ellipse, Mask, Rect } from 'react-native-svg'

import type { Framing, LivenessPhase } from '../types'
import {
  defaultTheme,
  ellipsePerimeter,
  frameGeometry,
  holdRingDash,
  type EKYCTheme,
} from './theme'

const AnimatedEllipse = Animated.createAnimatedComponent(Ellipse)

export type FrameOverlayProps = {
  size: LayoutRectangle
  theme?: EKYCTheme
  phase: LivenessPhase
  framing: Framing
  /** 0..1 hold progress for the current step. */
  progress: number
  /** Skip animation for users who asked the OS for reduced motion. */
  reduceMotion?: boolean
}

/**
 * The oval cut-out, its border, and the hold ring around it.
 *
 * Three visual jobs, deliberately kept in one component because they share one
 * geometry:
 *
 * 1. **Mask** — a near-opaque scrim with an oval punched out of it. Opaque
 *    because every shipped native SDK is: a translucent backdrop lets
 *    background clutter fight the instruction text.
 * 2. **Border** — carries state through *colour*, which is the mechanic almost
 *    every vendor actually uses (idle → active → success → error).
 * 3. **Hold ring** — four corner brackets that seal into a closed ring as the
 *    pose is held. Because the progress is genuinely continuous here, a meter
 *    earns its place; the brackets make "keep holding" legible at a glance.
 */
export function FrameOverlay({
  size,
  theme = defaultTheme,
  phase,
  framing,
  progress,
  reduceMotion = false,
}: FrameOverlayProps) {
  const geometry = useMemo(
    () => frameGeometry(size.width, size.height, theme.frame),
    [size.width, size.height, theme.frame],
  )
  const perimeter = useMemo(
    () => ellipsePerimeter(geometry.ringRx, geometry.ringRy),
    [geometry.ringRx, geometry.ringRy],
  )

  const animated = useRef(new Animated.Value(0)).current
  useEffect(() => {
    if (reduceMotion) {
      animated.setValue(progress)
      return
    }
    Animated.timing(animated, {
      toValue: progress,
      duration: theme.motion.ringMs,
      useNativeDriver: false,
    }).start()
  }, [progress, reduceMotion, animated, theme.motion.ringMs])

  const borderColor = strokeColor(theme, phase, framing)
  const [filled, gap] = holdRingDash(perimeter, progress)

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <Svg width={size.width} height={size.height}>
        <Defs>
          <Mask id="ekyc-oval-mask">
            <Rect x={0} y={0} width={size.width} height={size.height} fill="white" />
            <Ellipse
              cx={geometry.cx}
              cy={geometry.cy}
              rx={geometry.rx}
              ry={geometry.ry}
              fill="black"
            />
          </Mask>
        </Defs>

        <Rect
          x={0}
          y={0}
          width={size.width}
          height={size.height}
          fill={theme.colors.scrim}
          mask="url(#ekyc-oval-mask)"
        />

        <Ellipse
          cx={geometry.cx}
          cy={geometry.cy}
          rx={geometry.rx}
          ry={geometry.ry}
          stroke={borderColor}
          strokeWidth={theme.frame.strokeWidth}
          fill="none"
        />

        <AnimatedEllipse
          cx={geometry.cx}
          cy={geometry.cy}
          rx={geometry.ringRx}
          ry={geometry.ringRy}
          stroke={phase === 'failed' ? theme.colors.danger : theme.colors.accent}
          strokeWidth={theme.frame.ringWidth}
          strokeLinecap="round"
          strokeDasharray={[filled, gap]}
          // Start the brackets at the quadrant midpoints, so they close
          // symmetrically rather than sweeping round like a clock.
          strokeDashoffset={filled / 2}
          fill="none"
          opacity={phase === 'running' ? 1 : 0.35}
        />
      </Svg>
    </View>
  )
}

function strokeColor(theme: EKYCTheme, phase: LivenessPhase, framing: Framing): string {
  if (phase === 'passed') return theme.colors.success
  if (phase === 'failed') return theme.colors.danger
  if (framing !== 'ok') return theme.colors.ovalIdle
  return theme.colors.accent
}
