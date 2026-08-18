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
  tier?: 'full' | 'reduced'
  client?: {
    platform: string
    osVersion: string
    model: string
    appVersion: string
  }
  /**
   * PAD-evaluation tag (`bona_fide`, `mask_silicone`, ...). Only meaningful on
   * an evaluation server with retention on; ignored by the decision.
   */
  label?: string
}

export type EKYCClientOptions = {
  /** e.g. `https://ekyc.example.com` — no trailing slash needed. */
  baseUrl: string
  /**
   * Shared secret sent as `X-API-Key` on every request. Required when the
   * server sets `EKYC_API_KEYS`. Authenticates the app, not the person.
   */
  apiKey?: string
  timeoutMs?: number
  /** Extra headers (auth token, tracing id) resolved per request. */
  headers?: () => Record<string, string> | Promise<Record<string, string>>
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch
}

/** One part of the multipart upload. Kept as plain data so it can be unit-tested. */
/** React Native's proprietary file part: `{ uri, name, type }`. */
export type FilePart = { uri: string; name: string; type: string }
export type EvidencePart = { name: string; value: string | FilePart; filename?: string; type?: string }

/**
 * Turn an evidence bundle into the multipart parts the server expects.
 *
 * File parts are described the React Native way (`{ uri, name, type }`);
 * `submit` decides at upload time whether the host's `fetch` wants that or a
 * Blob.
 */
/**
 * React Native's FormData opens `{ uri }` through the platform's content
 * resolver, which needs a scheme. Native capture APIs hand back bare paths
 * (`/data/user/0/…/cache/x.jpg`); sent as-is the request dies on the device
 * with "Network request failed" and the server never sees the submit — the
 * whole run then reads as "verification failed" for no visible reason.
 */
export function asFileUri(pathOrUri: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(pathOrUri) ? pathOrUri : `file://${pathOrUri}`
}

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
      value: { uri: asFileUri(frame.uri), name: filename, type: 'image/jpeg' },
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
      if (typeof part.value === 'string') {
        form.append(part.name, part.value)
        continue
      }
      const file = await this.readFile(part.value)
      // Blob + filename is the standard signature; RN's own FormData ignores the
      // third argument and takes the `{ uri, name, type }` object instead.
      form.append(part.name, file as Blob, part.filename)
    }
    return this.json<Decision>('POST', `/v1/sessions/${encodeURIComponent(sessionId)}/submit`, {
      body: form,
    })
  }

  /**
   * Turn a captured file into something the host's `fetch` can put in a
   * multipart body.
   *
   * Two `fetch`es exist in the React Native world and they disagree here.
   * Expo's (the global on every Expo app since SDK 52) rejects React Native's
   * proprietary `{ uri }` part outright ("Unsupported FormDataPart") — the
   * upload dies on the device before a byte leaves it — but can read `file://`
   * URLs itself, so we hand it a Blob. Bare React Native is the mirror image:
   * its networking cannot fetch `file://` but streams `{ uri }` parts natively.
   * Try the standard route; fall back to the proprietary one.
   */
  private async readFile(file: FilePart): Promise<Blob | FilePart> {
    try {
      const response = await this.fetchImpl(file.uri)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.blob()
    } catch {
      return file
    }
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
    const auth: Record<string, string> = this.options.apiKey ? { 'X-API-Key': this.options.apiKey } : {}

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        signal: controller.signal,
        headers: { ...auth, ...extra, ...(init.headers ?? {}) },
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
        // Include the server's response body: a 422 is otherwise opaque on the
        // device, and the body names the offending field.
        `Server returned ${response.status} for ${method} ${path}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
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
