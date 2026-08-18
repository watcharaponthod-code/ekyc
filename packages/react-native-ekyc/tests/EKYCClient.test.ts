import { buildEvidenceParts, EKYCClient } from '../src/client/EKYCClient'
import { EKYCError, type EvidenceBundle } from '../src/types'

const bundle: EvidenceBundle = {
  manifest: {
    nonce: 'n0nc3',
    startedAt: 1000,
    finishedAt: 9000,
    steps: [
      {
        name: 'center',
        tStart: 1000,
        tEnd: 1800,
        observed: { yaw: 1, pitch: 0, roll: 0, leftEye: 0.9, rightEye: 0.9, smile: 0 },
      },
    ],
    capture: { frameWidth: 1280, frameHeight: 720, fps: 30, mirrored: true },
  },
  frames: [
    { key: 'neutral', uri: 'file:///tmp/a.jpg' },
    { key: 'turnLeft', uri: 'file:///tmp/b.jpg' },
  ],
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('buildEvidenceParts', () => {
  it('sends the manifest as JSON plus one part per frame', () => {
    const parts = buildEvidenceParts(bundle)
    expect(parts.map((p) => p.name)).toEqual(['manifest', 'frames', 'frames'])
    expect(parts.slice(1).map((p) => p.filename)).toEqual(['neutral.jpg', 'turnLeft.jpg'])
    expect(JSON.parse(parts[0]!.value as string).nonce).toBe('n0nc3')
  })

  it('describes frames the way React Native FormData expects', () => {
    const [, neutral] = buildEvidenceParts(bundle)
    expect(neutral!.value).toEqual({
      uri: 'file:///tmp/a.jpg',
      name: 'neutral.jpg',
      type: 'image/jpeg',
    })
  })

  it('gives bare native paths a file:// scheme, and leaves real URIs alone', () => {
    const bare: EvidenceBundle = {
      ...bundle,
      frames: [
        { key: 'neutral', uri: '/data/user/0/app/cache/n.jpg' },
        { key: 'turnLeft', uri: 'content://media/1' },
      ],
    }
    const [, neutral, turn] = buildEvidenceParts(bare)
    expect((neutral!.value as { uri: string }).uri).toBe('file:///data/user/0/app/cache/n.jpg')
    expect((turn!.value as { uri: string }).uri).toBe('content://media/1')
  })
})

describe('EKYCClient', () => {
  it('posts a session request and returns the server-issued challenges', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({
        sessionId: 's1',
        nonce: 'n1',
        challenges: ['turnRight', 'closeEyes'],
        expiresAt: '2026-08-17T10:00:00Z',
        policy: { holdMs: 700, perStepTimeoutMs: 12000, totalTimeoutMs: 60000 },
      }),
    )
    const client = new EKYCClient({ baseUrl: 'https://x.test/', fetchImpl: fetchImpl as never })

    const created = await client.createSession({ purpose: 'enroll' })

    expect(created.challenges).toEqual(['turnRight', 'closeEyes'])
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://x.test/v1/sessions')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ purpose: 'enroll' })
  })

  it('merges caller-supplied headers', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse([]))
    const client = new EKYCClient({
      baseUrl: 'https://x.test',
      fetchImpl: fetchImpl as never,
      headers: () => ({ Authorization: 'Bearer t' }),
    })

    await client.listPersons()

    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t')
  })

  it('uploads evidence to the session submit endpoint, reading each frame through fetch as a Blob', async () => {
    const fetchImpl = jest.fn(async (url: string) =>
      url.startsWith('file://')
        ? ({ ok: true, status: 200, blob: async () => new Blob(['jpeg'], { type: 'image/jpeg' }) } as Response)
        : jsonResponse({ decision: 'pass', reasons: [], scores: {}, personId: 'p1' }),
    )
    const client = new EKYCClient({ baseUrl: 'https://x.test', fetchImpl: fetchImpl as never })

    const decision = await client.submit('s 1', bundle)

    expect(decision.decision).toBe('pass')
    const urls = fetchImpl.mock.calls.map(([u]) => u as string)
    expect(urls).toEqual(['file:///tmp/a.jpg', 'file:///tmp/b.jpg', 'https://x.test/v1/sessions/s%201/submit'])
    const [, init] = fetchImpl.mock.calls[2] as unknown as [string, RequestInit]
    const form = init.body as FormData
    expect(form.getAll('frames').every((v) => v instanceof Blob)).toBe(true)
    expect((form.getAll('frames')[0] as File).name).toBe('neutral.jpg')
  })

  it("falls back to React Native's { uri } part when the host fetch cannot read file://", async () => {
    // React Native's FormData accepts arbitrary objects; the DOM one in this
    // test runtime does not, so stand in a minimal RN-shaped FormData.
    const DomFormData = globalThis.FormData
    class RNFormData {
      parts: Array<[string, unknown]> = []
      append(name: string, value: unknown) {
        this.parts.push([name, value])
      }
    }
    globalThis.FormData = RNFormData as unknown as typeof FormData
    try {
      const fetchImpl = jest.fn(async (url: string) => {
        if (url.startsWith('file://')) throw new TypeError('Network request failed')
        return jsonResponse({ decision: 'pass', reasons: [], scores: {}, personId: 'p1' })
      })
      const client = new EKYCClient({ baseUrl: 'https://x.test', fetchImpl: fetchImpl as never })

      await client.submit('s1', bundle)

      const [, init] = fetchImpl.mock.calls[fetchImpl.mock.calls.length - 1] as unknown as [string, RequestInit]
      const parts = (init.body as unknown as RNFormData).parts
      expect(parts[1]).toEqual(['frames', { uri: 'file:///tmp/a.jpg', name: 'neutral.jpg', type: 'image/jpeg' }])
    } finally {
      globalThis.FormData = DomFormData
    }
  })

  it('turns transport failures into a retriable NETWORK error', async () => {
    const client = new EKYCClient({
      baseUrl: 'https://x.test',
      fetchImpl: (async () => {
        throw new Error('offline')
      }) as never,
    })

    await expect(client.listPersons()).rejects.toMatchObject({
      code: 'NETWORK',
      retriable: true,
    })
  })

  it('maps a missing session to SESSION_EXPIRED', async () => {
    const client = new EKYCClient({
      baseUrl: 'https://x.test',
      fetchImpl: (async (url: string) =>
        url.startsWith('file://')
          ? ({ ok: true, status: 200, blob: async () => new Blob(['jpeg']) } as Response)
          : jsonResponse({ detail: 'gone' }, 404)) as never,
    })

    await expect(client.submit('s1', bundle)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' })
  })

  it('marks 5xx as retriable and 4xx as not', async () => {
    const server = new EKYCClient({
      baseUrl: 'https://x.test',
      fetchImpl: (async () => jsonResponse({}, 503)) as never,
    })
    const bad = new EKYCClient({
      baseUrl: 'https://x.test',
      fetchImpl: (async () => jsonResponse({}, 422)) as never,
    })

    await expect(server.listPersons()).rejects.toMatchObject({ code: 'SERVER', retriable: true })
    await expect(bad.listPersons()).rejects.toMatchObject({ code: 'SERVER', retriable: false })
  })

  it('handles a 204 delete without trying to parse a body', async () => {
    const client = new EKYCClient({
      baseUrl: 'https://x.test',
      fetchImpl: (async () =>
        ({
          ok: true,
          status: 204,
          json: async () => {
            throw new Error('no body')
          },
          text: async () => '',
        }) as unknown as Response) as never,
    })

    await expect(client.deletePerson('p1')).resolves.toBeUndefined()
  })

  it('exposes EKYCError so callers can switch on the code', async () => {
    const client = new EKYCClient({
      baseUrl: 'https://x.test',
      fetchImpl: (async () => {
        throw new Error('offline')
      }) as never,
    })

    await expect(client.health()).rejects.toBeInstanceOf(EKYCError)
  })
})

describe('EKYCClient API key', () => {
  it('sends X-API-Key on every request when configured', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse([]))
    const client = new EKYCClient({ baseUrl: 'https://x.test', apiKey: 'k-one', fetchImpl: fetchImpl as never })
    await client.listPersons()
    const [, init] = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('k-one')
  })

  it('sends no key header when none is configured, and lets custom headers win', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse([]))
    const client = new EKYCClient({
      baseUrl: 'https://x.test',
      apiKey: 'k-one',
      headers: () => ({ 'X-API-Key': 'override' }),
      fetchImpl: fetchImpl as never,
    })
    await client.listPersons()
    const [, init] = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])
    expect((init.headers as Record<string, string>)['X-API-Key']).toBe('override')

    const bare = jest.fn(async () => jsonResponse([]))
    await new EKYCClient({ baseUrl: 'https://x.test', fetchImpl: bare as never }).listPersons()
    const [, init2] = (bare.mock.calls[0] as unknown as [string, RequestInit])
    expect((init2.headers as Record<string, string>)['X-API-Key']).toBeUndefined()
  })
})

