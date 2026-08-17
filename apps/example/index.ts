import { registerRootComponent } from 'expo'

/**
 * Two entry points, chosen at runtime.
 *
 * The real app needs `react-native-vision-camera`, whose Nitro hybrid objects
 * are created at module scope — so merely *importing* it inside Expo Go throws
 * before any of our code runs. Requiring it inside a `try` lets the same bundle
 * fall back to the camera-free UI preview instead of crashing, which is what
 * makes the design reviewable over a plain Expo Go QR code.
 */
function pickRoot(): React.ComponentType {
  try {
    const { VisionCamera } = require('react-native-vision-camera')
    // Touch the hybrid object: creating it is what fails without the native
    // side, and we want that to happen here rather than mid-render.
    void VisionCamera.cameraPermissionStatus
    return require('./App').default
  } catch {
    return require('./UIPreview').default
  }
}

registerRootComponent(pickRoot())
