/**
 * The bug that made every real session fail (2026-08-19): native capture
 * returns a bare path, expo-image-manipulator needs a `file://` URI. Pin the
 * fix at the one image op the light flow performs.
 */
import * as jpeg from 'jpeg-js'

const calls: string[] = []

jest.mock('expo-image-manipulator', () => {
  const rgba = new Uint8Array(16 * 16 * 4)
  for (let i = 0; i < 16 * 16; i++) {
    rgba[i * 4] = 200
    rgba[i * 4 + 1] = 100
    rgba[i * 4 + 2] = 50
    rgba[i * 4 + 3] = 255
  }
  const encoded = jpeg.encode({ data: rgba, width: 16, height: 16 }, 95).data
  let bin = ''
  for (let i = 0; i < encoded.length; i += 0x8000) bin += String.fromCharCode(...encoded.subarray(i, i + 0x8000))
  const b64 = btoa(bin)
  return {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: jest.fn(async (uri: string, _actions: unknown[], opts: { base64?: boolean }) => {
      calls.push(uri)
      return { uri, width: 640, height: 480, ...(opts?.base64 ? { base64: b64 } : {}) }
    }),
  }
}, { virtual: true })
jest.mock('@ekyc/react-native-ekyc', () => ({ asFileUri: jest.requireActual('../../react-native-ekyc/src/client/EKYCClient').asFileUri }))

import { meanFaceColour } from '../src/colour'

describe('meanFaceColour', () => {
  beforeEach(() => calls.splice(0))
  it('always hands the manipulator a file:// URI and returns the mean RGB in 0..1', async () => {
    const rgb = await meanFaceColour('/data/user/0/com.ekyc.local/cache/x.jpg', { x: 0.2, y: 0.2, w: 0.5, h: 0.5 })
    expect(calls.length).toBe(2)
    for (const uri of calls) expect(uri).toBe('file:///data/user/0/com.ekyc.local/cache/x.jpg')
    expect(rgb[0]).toBeCloseTo(200 / 255, 1)
    expect(rgb[1]).toBeCloseTo(100 / 255, 1)
    expect(rgb[2]).toBeCloseTo(50 / 255, 1)
  })
  it('leaves a real URI alone', async () => {
    await meanFaceColour('content://media/7', { x: 0, y: 0, w: 1, h: 1 })
    expect(calls[0]).toBe('content://media/7')
  })
})
