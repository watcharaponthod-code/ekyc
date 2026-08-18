/**
 * Screen-flash display colours, matching the server's `FLASH_PALETTE` by name.
 *
 * The screen shows one of these full-screen to light the face; the server
 * correlates the *same* palette (by the colour name it issued) against the
 * colour the face reflected. So the device only has to render the right colour
 * for each name — bright, and channel-separated so the reflection is legible.
 */
export const FLASH_DISPLAY: Record<string, string> = {
  red: '#FF2626',
  green: '#26FF26',
  blue: '#2626FF',
  white: '#FFFFFF',
}

/** Display hex for a server-issued flash colour name; white if unknown. */
export function flashHex(name: string): string {
  return FLASH_DISPLAY[name] ?? '#FFFFFF'
}
