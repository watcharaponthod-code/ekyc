/**
 * The bug that made every real session fail (2026-08-19): native capture
 * returns a bare path, expo-image-manipulator needs a `file://` URI, and
 * every frame came back FRAME_UNREADABLE. Pin the fix at the seam.
 */
import * as jpeg from 'jpeg-js'

const calls: string[] = []

jest.mock('expo-image-manipulator', () => {
  const rgba = new Uint8Array(112 * 112 * 4).fill(128)
  const encoded = jpeg.encode({ data: rgba, width: 112, height: 112 }, 90).data
  let bin = ''
  for (let i = 0; i < encoded.length; i += 0x8000) bin += String.fromCharCode(...encoded.subarray(i, i + 0x8000))
  const b64 = btoa(bin)
  return {
    SaveFormat: { JPEG: 'jpeg' },
    manipulateAsync: jest.fn(async (uri: string, _actions: unknown[], opts: { base64?: boolean }) => {
      calls.push(uri)
      return { uri, width: 112, height: 112, ...(opts?.base64 ? { base64: b64 } : {}) }
    }),
  }
}, { virtual: true })
jest.mock('react-native-fast-tflite', () => ({ loadTensorflowModel: jest.fn() }), { virtual: true })
// The core barrel drags in react-native UI; the embedder only needs asFileUri.
jest.mock('@ekyc/react-native-ekyc', () => ({ asFileUri: jest.requireActual('../../react-native-ekyc/src/client/EKYCClient').asFileUri }))
jest.mock('expo-asset', () => ({ Asset: { fromModule: jest.fn() } }), { virtual: true })

import { cropFace, faceThumbnail } from '../src/heavy/embedder'

describe('image ops always receive a file:// URI', () => {
  beforeEach(() => calls.splice(0))

  it('cropFace turns a bare native path into file://', async () => {
    await cropFace({ uri: '/data/user/0/com.ekyc.local/cache/x.jpg', box: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 }, roll: 0 })
    expect(calls.length).toBeGreaterThan(0)
    for (const uri of calls) expect(uri).toBe('file:///data/user/0/com.ekyc.local/cache/x.jpg')
  })

  it('faceThumbnail does too, and leaves real URIs alone', async () => {
    await faceThumbnail('/data/user/0/app/cache/p.jpg', { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 112)
    expect(calls[0]).toBe('file:///data/user/0/app/cache/p.jpg')
    calls.splice(0)
    await faceThumbnail('content://media/1', { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, 112)
    expect(calls[0]).toBe('content://media/1')
  })
})
