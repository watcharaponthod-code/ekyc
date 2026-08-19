import * as jpeg from 'jpeg-js'

import {
  DEFAULT_CONSISTENCY_MIN,
  DEFAULT_MATCH_MIN,
  EMBEDDING_INPUT,
  base64ToBytes,
  consistency,
  cosine,
  decodeJpeg,
  embeddingFromJson,
  embeddingToJson,
  judge,
  l2normalize,
  preprocessRgba,
} from '../src/identity'

function vec(...values: number[]): Float32Array {
  return Float32Array.from(values)
}

/** Node's btoa over bytes, chunked so a few-KB JPEG does not blow the arg limit. */
function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(bin)
}

describe('cosine / l2normalize', () => {
  it('is 1 for parallel, 0 for orthogonal, -1 for opposite', () => {
    expect(cosine(vec(1, 0), vec(2, 0))).toBeCloseTo(1)
    expect(cosine(vec(1, 0), vec(0, 3))).toBeCloseTo(0)
    expect(cosine(vec(1, 1), vec(-1, -1))).toBeCloseTo(-1)
  })
  it('does not care about scale, and a zero vector scores 0', () => {
    const a = vec(0.3, 0.4, 0.5)
    expect(cosine(a, l2normalize(a))).toBeCloseTo(1)
    expect(cosine(a, vec(0, 0, 0))).toBe(0)
  })
  it('l2normalize yields unit length', () => {
    const n = l2normalize(vec(3, 4))
    expect(Math.hypot(n[0]!, n[1]!)).toBeCloseTo(1)
  })
})

describe('preprocessRgba', () => {
  it('maps 0..255 RGBA onto (x-127.5)/128 RGB, NHWC', () => {
    const w = EMBEDDING_INPUT
    const rgba = new Uint8Array(w * w * 4)
    rgba[0] = 255
    rgba[1] = 0
    rgba[2] = 127
    rgba[3] = 255
    const out = preprocessRgba(rgba, w, w)
    expect(out.length).toBe(w * w * 3)
    expect(out[0]).toBeCloseTo((255 - 127.5) / 128)
    expect(out[1]).toBeCloseTo(-127.5 / 128)
    expect(out[2]).toBeCloseTo((127 - 127.5) / 128)
  })
  it('rejects the wrong size', () => {
    expect(() => preprocessRgba(new Uint8Array(10), 5, 5)).toThrow(/112x112/)
  })
})

describe('jpeg decode + base64', () => {
  it('round-trips a 112x112 image through jpeg-js and base64', () => {
    const w = EMBEDDING_INPUT
    const rgba = new Uint8Array(w * w * 4)
    for (let i = 0; i < w * w; i++) {
      rgba[i * 4] = 200
      rgba[i * 4 + 1] = 120
      rgba[i * 4 + 2] = 60
      rgba[i * 4 + 3] = 255
    }
    const encoded = jpeg.encode({ data: rgba, width: w, height: w }, 95).data
    const b64 = toBase64(new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength))
    const decoded = decodeJpeg(b64)
    expect(decoded.width).toBe(w)
    expect(decoded.height).toBe(w)
    expect(Math.abs(decoded.rgba[0]! - 200)).toBeLessThan(6)
    expect(Math.abs(decoded.rgba[1]! - 120)).toBeLessThan(6)
    expect(Math.abs(decoded.rgba[2]! - 60)).toBeLessThan(6)
  })
  it('base64ToBytes decodes, with and without a data: prefix, with or without atob', () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7])
    const b64 = toBase64(bytes)
    expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes))
    expect(Array.from(base64ToBytes(`data:image/jpeg;base64,${b64}`))).toEqual(Array.from(bytes))
    const g = globalThis as { atob?: unknown }
    const saved = g.atob
    g.atob = undefined
    try {
      expect(Array.from(base64ToBytes(b64))).toEqual(Array.from(bytes))
    } finally {
      g.atob = saved
    }
  })
})

describe('consistency + judge', () => {
  const alice = l2normalize(vec(1, 0.1, 0.05, 0))
  const aliceTurned = l2normalize(vec(0.9, 0.3, 0.1, 0.05))
  const bob = l2normalize(vec(0, 0.1, 1, 0.2))

  it('reports the worst pair, not the mean', () => {
    const frames = [
      { key: 'neutral', embedding: alice },
      { key: 'turnLeft', embedding: aliceTurned },
      { key: 'openMouth', embedding: bob },
    ]
    const report = consistency(frames) // star: 2 pairs, both against neutral
    expect(report.min).toBeLessThan(0.3)
    expect(report.weakest).toEqual(['neutral', 'openMouth'])
    expect(report.pairs).toHaveLength(2)
    expect(consistency(frames, 'all').pairs).toHaveLength(3)
  })

  it('one person across poses passes; a swapped frame fails', () => {
    expect(judge([{ key: 'neutral', embedding: alice }, { key: 'turnLeft', embedding: aliceTurned }]).passed).toBe(true)
    const swapped = judge([{ key: 'neutral', embedding: alice }, { key: 'turnLeft', embedding: bob }])
    expect(swapped.passed).toBe(false)
    expect(swapped.reasons).toEqual(['IDENTITY_INCONSISTENT'])
  })

  it('verifies against a reference when given, on the neutral frame', () => {
    const frames = [{ key: 'turnLeft', embedding: aliceTurned }, { key: 'neutral', embedding: alice }]
    const ok = judge(frames, { reference: alice })
    expect(ok.match!.ok).toBe(true)
    expect(ok.match!.score).toBeCloseTo(1, 5)
    const impostor = judge(frames, { reference: bob })
    expect(impostor.passed).toBe(false)
    expect(impostor.reasons).toContain('NO_MATCH')
    expect(impostor.match!.score).toBeLessThan(DEFAULT_MATCH_MIN)
  })

  it('no frames is a failure, thresholds are knobs', () => {
    expect(judge([]).reasons).toEqual(['NO_FRAMES'])
    const strict = judge([{ key: 'neutral', embedding: alice }, { key: 'turnLeft', embedding: aliceTurned }], { consistencyMin: 0.999 })
    expect(strict.passed).toBe(false)
    expect(DEFAULT_CONSISTENCY_MIN).toBeLessThan(DEFAULT_MATCH_MIN)
  })

  it('embeddings survive a JSON round trip', () => {
    const json = embeddingToJson(alice)
    expect(json.length).toBeLessThan(200)
    const back = embeddingFromJson(json)
    expect(cosine(back, alice)).toBeCloseTo(1, 5)
    expect(() => embeddingFromJson('{"no":1}')).toThrow()
  })
})

describe('star topology', () => {
  const neutral = l2normalize(vec(1, 0.1, 0.05, 0))
  const left = l2normalize(vec(0.8, 0.5, 0.1, 0.05))
  const right = l2normalize(vec(0.8, -0.5, 0.1, 0.05))
  const frames = [
    { key: 'neutral', embedding: neutral },
    { key: 'turnLeft', embedding: left },
    { key: 'turnRight', embedding: right },
  ]
  it('compares every frame to neutral only, never left vs right', () => {
    const star = consistency(frames, 'star')
    expect(star.topology).toBe('star')
    expect(star.pairs.map((p) => `${p.a}-${p.b}`).sort()).toEqual(['neutral-turnLeft', 'neutral-turnRight'])
    const all = consistency(frames, 'all')
    expect(all.pairs).toHaveLength(3)
    // the left–right pair is the hardest one and only "all" pays for it
    expect(all.min).toBeLessThan(star.min)
  })
  it('falls back to all pairs when there is no neutral frame', () => {
    const r = consistency(frames.slice(1), 'star')
    expect(r.topology).toBe('all')
    expect(r.pairs).toHaveLength(1)
  })
  it('a swapped turned frame is still caught against neutral', () => {
    const bob = l2normalize(vec(0, 0.1, 1, 0.2))
    const r = judge([{ key: 'neutral', embedding: neutral }, { key: 'turnLeft', embedding: left }, { key: 'turnRight', embedding: bob }])
    expect(r.passed).toBe(false)
    expect(r.consistency.weakest).toEqual(['neutral', 'turnRight'])
  })
})
