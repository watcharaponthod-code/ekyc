import { useEffect, useRef } from 'react'
import { AccessibilityInfo, Animated, Platform, StyleSheet, View } from 'react-native'

import { defaultTheme, type EKYCTheme } from './theme'

export type InstructionBannerProps = {
  text: string
  theme?: EKYCTheme
  reduceMotion?: boolean
  tone?: 'normal' | 'warning'
}

/** Three lines of space, always. See the comment in the component. */
const RESERVED_LINES = 3

/**
 * The single line telling the user what to do.
 *
 * Two details that shipped SDKs get wrong often enough to be worth calling out:
 *
 * - **The height is reserved for three lines and the text is bottom-aligned.**
 *   Otherwise the oval jumps every time the copy wraps to a second line. One
 *   major SDK gets this right on iOS and truncates on Android at large font
 *   scales; we take the iOS approach and let it grow.
 * - **`accessibilityLiveRegion` plus an explicit announcement.** Without it a
 *   screen-reader user gets no feedback at all as the state changes — a real,
 *   shipped bug in at least one production identity SDK.
 */
export function InstructionBanner({
  text,
  theme = defaultTheme,
  reduceMotion = false,
  tone = 'normal',
}: InstructionBannerProps) {
  const opacity = useRef(new Animated.Value(1)).current
  const previous = useRef(text)

  useEffect(() => {
    if (previous.current === text) return
    previous.current = text

    AccessibilityInfo.announceForAccessibility?.(text)

    if (reduceMotion) return
    opacity.setValue(0)
    Animated.timing(opacity, {
      toValue: 1,
      duration: theme.motion.instructionMs,
      useNativeDriver: true,
    }).start()
  }, [text, opacity, reduceMotion, theme.motion.instructionMs])

  const minHeight = theme.typography.instruction.lineHeight * RESERVED_LINES

  return (
    <View
      style={[styles.container, { minHeight }]}
      accessibilityLiveRegion="polite"
      accessible
      accessibilityRole={Platform.OS === 'ios' ? 'text' : undefined}
    >
      <Animated.Text
        style={[
          styles.text,
          theme.typography.instruction,
          { color: tone === 'warning' ? theme.colors.danger : theme.colors.text, opacity },
        ]}
      >
        {text}
      </Animated.Text>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    justifyContent: 'flex-end',
    paddingHorizontal: 24,
  },
  text: {
    textAlign: 'center',
  },
})
