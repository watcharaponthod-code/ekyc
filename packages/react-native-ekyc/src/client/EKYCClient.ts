import {
  EKYCError,
  type CreatedSession,
  type Decision,
  type EvidenceBundle,
  type Person,
  type Purpose,
} from '../types'

export type CreateSessionRequest = {
  purpose: Purpose
  personId?: string
  displayName?: string
  client?: {
    platform: string
    osVersion: string
    model: string
    appVersion: string
  }
}

export type EKYCClientOptions = {
  /** e.g. `https://ekyc.example.com` — no trailing slash needed. */
  baseUrl: string
  timeoutMs?: number
  /** Extra headers (auth token, tracing id) resolved per request. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

/** One part of the multipart upload. Kept as plain data so it can be unit-tested. */
export type EvidencePart = { name: string; value: unknown; filename?: string; type?: string }

/**
 * Turn an evidence bundle into the multipart parts the server expects.
 *
 * React Native's `FormData` accepts `{ uri, name, type }` for file parts, which
 * is why the value is `unknown` rather than `Blob`.
 */
export function buildEvidenceParts(bundle: EvidenceBundle): EvidencePart[] {
  const parts: EvidencePart[] = [
    { name: 'manifest', value: JSON.stringify(bundle.manifest), type: 'application/json' },
  ]
  for (const frame of bundle.frames) {
    // Every frame goes under the single `frames` field; the filename carries
    // the key, because a multipart part cannot have a dynamic field name in
    // the server's typed signature.
    const filename = `${frame.key}.jpg`
    parts.push({
      name: 'frames',
      value: { uri: frame.uri, name: filename, type: 'image/jpeg' },
      filename,
      type: 'image/jpeg',
    })
  }
  return parts
}

/**
 * Thin HTTP client for the eKYC server. Knows nothing about cameras.
 *
 * Uses `fetch` only — no extra dependency.
 */
export class EKYCClient {
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: EKYCClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch
  }

  createSession(request: CreateSessionRequest): Promise<CreatedSession> {
    return this.json<CreatedSession>('POST', '/v1/sessions', {
      body: JSON.stringify(request),
      headers: { 'Content-Type': 'application/json' },
    })
  }

  async submit(sessionId: string, bundle: EvidenceBundle): Promise<Decision> {
    const form = new FormData()
    for (const part of buildEvidenceParts(bundle)) {
      // RN's FormData takes `{ uri, name, type }`; the DOM lib types disagree.
      form.append(part.name, part.value as string)
    }
    return this.json<Decision>('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/submit`, {
      body: form,
    })
  }

  listPersons(): Promise<Person[]> {
    return this.json<Person[]>('GET', '/v1/persons')
  }

  async deletePerson(personId: string): Promise<void> {
    await this.json<unknown>('DELETE', `/v1/persons/${encodeURIComponent(personId)}`)
  }

  health(): Promise<{ status: string; models: Record<string, boolean>; version: string }> {
    return this.json('GET', '/v1/health')
  }

  /** Fire-and-forget diagnostic line. Never throws, never awaited by callers. */
  clientLog(entry: { device: string; level: string; message: string; detail?: string; session?: string }): void {
    void this.json<unknown>('POST', '/v1/client-log', {
      body: JSON.stringify({ ...entry, at: Date.now() }),
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => {})
  }

  // -------------------------------------------------------------------------

  private async json<T>(
    method: string,
    path: string,
    init: { body?: BodyInit; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const extra = (await this.options.headers?.()) ?? {}

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: { ...extra, ...(init.headers ?? {}) },
        ...(init.body === undefined ? {} : { body: init.body }),
      })
    } catch (cause) {
      throw new EKYCError('NETWORK', `Could not reach the eKYC server (${method} ${path})`, true, cause)
    } finally {
      clearTimeout(timer)
    }

    if (!response.ok) {
      const detail = await safeText(response)
      if (response.status === 404 && path.includes('/sessions/')) {
        throw new EKYCError('SESSION_EXPIRED', 'This verification session is no longer valid', true, detail)
      }
      throw new EKYCError(
        'SERVER',
        `Server returned ${response.status} for ${method} ${path}`,
        response.status >= 500,
        detail,
      )
    }

    if (response.status === 204) return undefined as T
    return (await response.json()) as T
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}
