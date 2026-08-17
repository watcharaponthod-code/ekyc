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

  it('uploads evidence to the session submit endpoint', async () => {
    const fetchImpl = jest.fn(async () =>
      jsonResponse({ decision: 'pass', reasons: [], scores: {}, personId: 'p1' }),
    )
    const client = new EKYCClient({ baseUrl: 'https://x.test', fetchImpl: fetchImpl as never })

    const decision = await client.submit('s 1', bundle)

    expect(decision.decision).toBe('pass')
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://x.test/v1/sessions/s%201/submit')
    expect(init.body).toBeInstanceOf(FormData)
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
      fetchImpl: (async () => jsonResponse({ detail: 'gone' }, 404)) as never,
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
