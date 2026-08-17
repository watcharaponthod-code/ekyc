import { useEffect, useRef } from 'react'
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native'

import { explainReasons, strings, type Locale } from './copy'
import { defaultTheme, type EKYCTheme } from './theme'

export type ResultViewProps = {
  passed: boolean
  /** Server reason codes, or a single local failure message. */
  reasons: string[]
  locale?: Locale
  theme?: EKYCTheme
  reduceMotion?: boolean
  onRetry?: (() => void) | undefined
  onDone?: (() => void) | undefined
}

/**
 * Success or failure, with advice.
 *
 * The failure screen lists what to do differently rather than restating the
 * error — the pattern Sumsub uses, and the one that actually changes the
 * outcome of the retry.
 */
export function ResultView({
  passed,
  reasons,
  locale = 'th',
  theme = defaultTheme,
  reduceMotion = false,
  onRetry,
  onDone,
}: ResultViewProps) {
  const t = strings(locale).result
  const advice = passed ? [] : explainReasons(locale, reasons)

  const scale = useRef(new Animated.Value(reduceMotion ? 1 : 0.6)).current
  useEffect(() => {
    if (reduceMotion) return
    Animated.spring(scale, {
      toValue: 1,
      useNativeDriver: true,
      ...theme.motion.spring,
    }).start()
  }, [scale, reduceMotion, theme.motion.spring])

  const accent = passed ? theme.colors.success : theme.colors.danger

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={styles.body}>
        <Animated.View
          style={[styles.badge, { backgroundColor: accent + '22', transform: [{ scale }] }]}
        >
          <Text style={[styles.glyph, { color: accent }]}>{passed ? '✓' : '!'}</Text>
        </Animated.View>

        <Text style={[theme.typography.title, styles.title, { color: theme.colors.text }]}>
          {passed ? t.successTitle : t.failTitle}
        </Text>

        {passed ? (
          <Text style={[theme.typography.body, styles.text, { color: theme.colors.textDim }]}>
            {t.successBody}
          </Text>
        ) : (
          <View style={styles.advice}>
            {advice.map((line) => (
              <View key={line} style={[styles.card, { backgroundColor: theme.colors.surface }]}>
                <Text style={[theme.typography.body, { color: theme.colors.text }]}>{line}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      <View style={styles.actions}>
        {passed ? (
          <Pressable
            accessibilityRole="button"
            onPress={onDone}
            style={({ pressed }) => [
              styles.primary,
              { backgroundColor: theme.colors.accent, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Text style={styles.primaryText}>{t.done}</Text>
          </Pressable>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={onRetry}
              style={({ pressed }) => [
                styles.primary,
                { backgroundColor: theme.colors.accent, opacity: pressed ? 0.85 : 1 },
              ]}
            >
              <Text style={styles.primaryText}>{t.retry}</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={onDone} style={styles.secondary}>
              <Text style={[styles.secondaryText, { color: theme.colors.textDim }]}>{t.cancel}</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  body: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28, gap: 10 },
  badge: {
    width: 88,
    height: 88,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  glyph: { fontSize: 42, fontWeight: '800', lineHeight: 48 },
  title: { textAlign: 'center' },
  text: { textAlign: 'center' },
  advice: { alignSelf: 'stretch', gap: 10, marginTop: 10 },
  card: { borderRadius: 16, padding: 16 },
  actions: { padding: 24, gap: 8 },
  primary: { height: 54, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#0A0E1A', fontSize: 17, fontWeight: '700' },
  secondary: { height: 46, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontSize: 15, fontWeight: '600' },
})
