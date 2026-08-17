/**
 * Haptic feedback, if the host app has `expo-haptics` installed.
 *
 * Haptics on identity capture are a real convention, not a flourish: Persona
 * fires one on capture, Regula on every step change (200 ms, default on),
 * Onfido per completed side. Sound is the opposite — **no** surveyed SDK plays
 * audio on capture, so we never do either.
 *
 * `expo-haptics` is an optional peer dependency. When it is absent every call
 * here is a no-op rather than a crash.
 */

type HapticsModule = {
  impactAsync: (style: unknown) => Promise<void>
  notificationAsync: (type: unknown) => Promise<void>
  ImpactFeedbackStyle: { Light: unknown; Medium: unknown; Heavy: unknown }
  NotificationFeedbackType: { Success: unknown; Warning: unknown; Error: unknown }
}

let loaded: HapticsModule | null | undefined

function load(): HapticsModule | null {
  if (loaded !== undefined) return loaded
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    loaded = require('expo-haptics') as HapticsModule
  } catch {
    loaded = null
  }
  return loaded
}

function safely(run: (module: HapticsModule) => Promise<void>): void {
  const module = load()
  if (!module) return
  void run(module).catch(() => {})
}

/** One step passed. */
export function hapticStep(): void {
  safely((h) => h.impactAsync(h.ImpactFeedbackStyle.Medium))
}

/** The whole check passed. */
export function hapticSuccess(): void {
  safely((h) => h.notificationAsync(h.NotificationFeedbackType.Success))
}

/** The check failed. */
export function hapticFailure(): void {
  safely((h) => h.notificationAsync(h.NotificationFeedbackType.Error))
}
