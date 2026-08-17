import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'

import { strings, type Locale } from './copy'
import { defaultTheme, type EKYCTheme } from './theme'

export type IntroViewProps = {
  locale?: Locale
  theme?: EKYCTheme
  onStart: () => void
  onCancel?: (() => void) | undefined
}

/**
 * The screen before the camera opens.
 *
 * Every major SDK ships an intro screen and lets you disable it; Onfido's own
 * documentation warns that removing it raises drop-off. It also happens to be
 * the only honest place to put the consent line — biometric data under Thai
 * PDPA needs explicit consent, and "explicit" means before the camera starts,
 * not in a settings page.
 */
export function IntroView({ locale = 'th', theme = defaultTheme, onStart, onCancel }: IntroViewProps) {
  const t = strings(locale).intro
  const common = strings(locale).result

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={[styles.badge, { backgroundColor: theme.colors.accentSoft }]}>
          <Text style={styles.badgeGlyph}>◎</Text>
        </View>

        <Text style={[theme.typography.title, { color: theme.colors.text }]}>{t.title}</Text>
        <Text style={[theme.typography.body, styles.body, { color: theme.colors.textDim }]}>
          {t.body}
        </Text>

        <View style={styles.steps}>
          {t.steps.map((step, index) => (
            <View key={step} style={styles.step}>
              <View style={[styles.stepIndex, { borderColor: theme.colors.accent }]}>
                <Text style={[styles.stepIndexText, { color: theme.colors.accent }]}>
                  {index + 1}
                </Text>
              </View>
              <Text style={[theme.typography.body, styles.stepText, { color: theme.colors.text }]}>
                {step}
              </Text>
            </View>
          ))}
        </View>

        <Text style={[theme.typography.caption, styles.consent, { color: theme.colors.textDim }]}>
          {t.consent}
        </Text>
      </ScrollView>

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          onPress={onStart}
          style={({ pressed }) => [
            styles.primary,
            { backgroundColor: theme.colors.accent, opacity: pressed ? 0.85 : 1 },
          ]}
        >
          <Text style={styles.primaryText}>{t.start}</Text>
        </Pressable>
        {onCancel ? (
          <Pressable accessibilityRole="button" onPress={onCancel} style={styles.secondary}>
            <Text style={[styles.secondaryText, { color: theme.colors.textDim }]}>
              {common.cancel}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 28, paddingTop: 72, gap: 12 },
  badge: {
    width: 64,
    height: 64,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  badgeGlyph: { fontSize: 30, color: '#6C8CFF' },
  body: { marginTop: 4 },
  steps: { marginTop: 24, gap: 16 },
  step: { flexDirection: 'row', alignItems: 'flex-start', gap: 14 },
  stepIndex: {
    width: 26,
    height: 26,
    borderRadius: 999,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stepIndexText: { fontSize: 13, fontWeight: '700' },
  stepText: { flex: 1 },
  consent: { marginTop: 28 },
  actions: { padding: 24, gap: 8 },
  primary: {
    height: 54,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryText: { color: '#0A0E1A', fontSize: 17, fontWeight: '700' },
  secondary: { height: 46, alignItems: 'center', justifyContent: 'center' },
  secondaryText: { fontSize: 15, fontWeight: '600' },
})
