import { StyleSheet, Text, View } from 'react-native'

import { defaultTheme, type EKYCTheme } from './theme'

export type StepDotsProps = {
  count: number
  current: number
  theme?: EKYCTheme
  label?: string
}

/**
 * One dot per challenge.
 *
 * A dot per step is the right primitive for discrete challenges — a sweeping
 * sector ring only makes sense for a continuous head sweep.
 *
 * State is never carried by colour alone: a finished step is a *filled, larger*
 * dot with a tick glyph, the current step is a *ring*, and pending steps are
 * small and dim. That keeps it readable for colour-blind users — a real defect
 * in at least one shipped SDK, which distinguishes active from inactive purely
 * by hue.
 */
export function StepDots({ count, current, theme = defaultTheme, label }: StepDotsProps) {
  return (
    <View
      style={styles.row}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: count, now: Math.min(current, count) }}
    >
      {Array.from({ length: count }, (_, index) => {
        const done = index < current
        const active = index === current
        return (
          <View
            key={index}
            style={[
              styles.dot,
              done && { backgroundColor: theme.colors.success, width: 22, height: 22 },
              active && {
                borderColor: theme.colors.accent,
                borderWidth: 2.5,
                width: 20,
                height: 20,
                backgroundColor: theme.colors.accentSoft,
              },
              !done && !active && { backgroundColor: theme.colors.ovalIdle },
            ]}
          >
            {done ? <Text style={styles.tick}>✓</Text> : null}
          </View>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tick: {
    color: '#06110A',
    fontSize: 13,
    fontWeight: '900',
    lineHeight: 15,
  },
})
