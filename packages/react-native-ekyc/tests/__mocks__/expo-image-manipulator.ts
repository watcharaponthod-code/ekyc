// Native module: not available under jest. Tests exercise the pure parts
// (laplacianVariance, flash scoring); anything calling manipulateAsync fails loudly.
export const SaveFormat = { JPEG: 'jpeg', PNG: 'png' }
export async function manipulateAsync(): Promise<never> {
  throw new Error('expo-image-manipulator is not available in tests')
}
