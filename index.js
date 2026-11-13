/**
 * dsh-idea-bridge — Host half.
 *
 * Two loopback-only routes for the browser half and for a future IDEA-side
 * caller (External Tool / plugin):
 *
 *   POST /dsh-idea/open     { file, line? }              -> `open idea://open?file=...`
 *   POST /dsh-idea/send     { sessionId, text, file?, line? } -> queue a user prompt
 *   POST /dsh-idea/draft    { sessionId, text, file?, line? } -> park a quote for the composer
 *   POST /dsh-idea/card     { sessionId, seq, index }     -> park a whole-file @ reference
 *   POST /dsh-idea/pending  { sessionId }                -> claim a parked draft (browser poll)
 *   GET  /dsh-idea/sessions                              -> live sessions with titles
 *   GET  /dsh-idea/status                                -> probe + endpoint list
 *
 * Security posture: the routes act on the local machine only (the DSH web
 * server binds loopback). A cross-origin page can still POST here, so every
 * request must be JSON (`content-type` forces a preflight the server never
 * approves) and an `Origin` header, when present, must equal this server's
 * own origin. No file content is ever read or returned.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

export const name = 'dsh-idea-bridge'

export const inject = ['webServer']

/** Route prefix owned by this plugin. */
const PREFIX = '/dsh-idea'

/** Request body ceiling; these payloads are tiny. */
const MAX_BODY_BYTES = 256 * 1024

const IDEA_APP = '/Applications/IntelliJ IDEA.app'

/**
 * Build the JetBrains URL scheme target. `line` is 1-based; JetBrains accepts
 * a missing line and then opens the file at the top.
 */
function ideaUrl(file, line) {
  const params = new URLSearchParams({ file })
  if (Number.isSafeInteger(line) && line > 0) params.set('line', String(line))
  return `idea://open?${params.toString()}`
}

/** Read and parse a JSON body, bounded and content-type checked. */
async function readJson(req) {
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) return { kind: 'too-large' }
    chunks.push(chunk)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim().length === 0) return { kind: 'ok', value: {} }
  try {
    const value = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'invalid' }
    return { kind: 'ok', value }
  } catch {
    return { kind: 'invalid' }
  }
}

function writeJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** A file path is only opened when it names an existing regular file. */
function checkFile(file) {
  if (typeof file !== 'string' || file.length === 0) return 'file must be a non-empty string'
  if (!isAbsolute(file)) return 'file must be an absolute path'
  let stats
  try {
    stats = statSync(file)
  } catch {
    return `file does not exist: ${file}`
  }
  if (!stats.isFile()) return `not a regular file: ${file}`
  return undefined
}

/**
 * Compose what a selection becomes. The composer turns it into a quote block,
 * so the code travels verbatim and the summary line carries the origin.
 * IDEA reports an absolute path, while the chat resolves `@` references
 * against the workspace, so this never claims to be a reference.
 */
function composeSelection(text, file, line, endLine) {
  const trimmed = text.trim()
  if (file === undefined) return { text: trimmed, anchor: undefined }
  const start = Number.isSafeInteger(line) && line > 0 ? line : undefined
  const end = Number.isSafeInteger(endLine) && endLine > 0 ? endLine : start
  const name = basename(file)
  const anchor =
    start === undefined ? name : end !== undefined && end !== start ? `${name}:${start}-${end}` : `${name}:${start}`
  return { text: trimmed, anchor }
}

/** Path relative to the session workspace, when the file lives inside it. */
function relativeTo(file, cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined
  const root = cwd.endsWith('/') ? cwd : `${cwd}/`
  return file.startsWith(root) ? file.slice(root.length) : undefined
}

export function apply(ctx, config) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || typeof webServer.register !== 'function') {
    ctx.logger?.('dsh-idea-bridge')?.warn?.('webServer service unavailable; routes not mounted')
    return
  }

  const origin = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : undefined
  const requireOrigin = config?.requireOrigin !== false

  // The port changes on every launch, so publish it where a local IDE action can
  // find it. `~/.dsh/idea-bridge.json` is read by the IntelliJ plugin.
  if (origin !== undefined) {
    try {
      const file = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'idea-bridge.json')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify({ origin, port: new URL(origin).port, updatedAt: new Date().toISOString() }, null, 2))
    } catch (error) {
      ctx.logger?.('dsh-idea-bridge')?.warn?.(`could not publish origin file: ${String(error)}`)
    }
  }

  const sessionController = () => {
    const service = ctx.get('sessionController')
    return service !== undefined && typeof service.prompt === 'function' ? service : undefined
  }

  /**
   * Parked drafts, keyed by session id. The browser half claims one with a
   * poll and drops the text into that session's composer instead of sending it,
   * so a selection from the IDE lands in the input box as a starting point.
   * Entries expire so a session nobody has open cannot accumulate text.
   */
  const DRAFT_TTL_MS = 5 * 60 * 1000
  const drafts = new Map()

  /** Park one entry per session; the browser claims it within a second or two. */
  const park = (sessionId, entry) => {
    drafts.set(sessionId, { ...entry, at: Date.now() })
    if (drafts.size > 32) {
      const oldest = [...drafts.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest !== undefined) drafts.delete(oldest[0])
    }
  }

  /** Working directory of a live session, used to make paths workspace-relative. */
  const sessionCwd = (sessionId) => {
    const service = ctx.get('sessions')
    if (service === undefined || typeof service.list !== 'function') return undefined
    for (const entry of service.list() ?? []) {
      const header = entry?.header ?? entry
      if ((header?.id ?? entry?.id) === sessionId) return typeof header?.cwd === 'string' ? header.cwd : undefined
    }
    return undefined
  }

  const takeDraft = (sessionId) => {
    const entry = drafts.get(sessionId)
    if (entry === undefined) return undefined
    drafts.delete(sessionId)
    if (Date.now() - entry.at > DRAFT_TTL_MS) return undefined
    return entry
  }

  const handlers = {
    async open(payload) {
      const problem = checkFile(payload.file)
      if (problem !== undefined) return { status: 400, body: { ok: false, error: problem } }
      const url = ideaUrl(payload.file, payload.line)
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
      child.unref()
      return { status: 200, body: { ok: true, url } }
    },

    async send(payload) {
      const service = sessionController()
      if (service === undefined) {
        return { status: 503, body: { ok: false, error: 'sessionController service unavailable' } }
      }
      if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
        return { status: 400, body: { ok: false, error: 'sessionId is required' } }
      }
      if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
        return { status: 400, body: { ok: false, error: 'text is required' } }
      }
      const text = composeSelection(payload.text, payload.file, payload.line, payload.endLine).text
      try {
        const result = await service.prompt(
          {
            sessionId: payload.sessionId,
            requestId: randomUUID(),
            content: [{ type: 'text', text }],
            mode: 'queue',
          },
          new AbortController().signal,
        )
        return { status: 200, body: { ok: true, accepted: result?.accepted === true } }
      } catch (error) {
        return {
          status: 500,
          body: { ok: false, error: String(error?.message ?? error) },
        }
      }
    },

    async draft(payload) {
      if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
        return { status: 400, body: { ok: false, error: 'sessionId is required' } }
      }
      if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
        return { status: 400, body: { ok: false, error: 'text is required' } }
      }
      const composed = composeSelection(payload.text, payload.file, payload.line, payload.endLine)
      const cwd = sessionCwd(payload.sessionId)
      const path = payload.file === undefined ? undefined : relativeTo(payload.file, cwd)
      park(payload.sessionId, { kind: 'selection', text: composed.text, anchor: composed.anchor, path })
      return { status: 200, body: { ok: true, queued: true, kind: 'selection', anchor: composed.anchor, path } }
    },

    /**
     * A changed-files card button only knows its own `actionUrl`
     * (`/api/present.open?sessionId&seq&index`), never the file path. Read the
     * presented event back and park a workspace-relative `@` reference for the
     * file at that position.
     */
    async card(payload) {
      const sessionId = payload.sessionId
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        return { status: 400, body: { ok: false, error: 'sessionId is required' } }
      }
      // The IDEA action knows the file's absolute path; translate it to the
      // session workspace so the composer can resolve it as a real reference.
      if (typeof payload.file === 'string' && payload.file.length > 0) {
        const checked = checkFile(payload.file)
        if (checked !== undefined) return { status: 400, body: { ok: false, error: checked } }
        const cwd = sessionCwd(sessionId)
        // Inside the workspace a relative path is what the composer resolves
        // fastest; outside it the absolute path is kept as-is (the reference
        // resolver passes absolute paths through untouched).
        const relative = relativeTo(payload.file, cwd) ?? payload.file
        park(sessionId, { kind: 'reference', path: relative, label: basename(relative) })
        return { status: 200, body: { ok: true, queued: true, kind: 'reference', path: relative } }
      }
      // A file context menu already knows the workspace-relative path.
      if (typeof payload.path === 'string' && payload.path.length > 0) {
        park(sessionId, { kind: 'reference', path: payload.path, label: basename(payload.path) })
        return { status: 200, body: { ok: true, queued: true, kind: 'reference', path: payload.path } }
      }
      const seq = Number(payload.seq)
      const index = Number(payload.index)
      if (!Number.isSafeInteger(seq) || seq < 0 || !Number.isSafeInteger(index) || index < 0) {
        return { status: 400, body: { ok: false, error: 'seq and index must be non-negative integers' } }
      }
      let path
      if (payload.source === 'changes') {
        // The review tab addresses a change summary, not a presented event.
        const changes = typeof ctx.get === 'function' ? ctx.get('workspaceChanges') : undefined
        if (changes === undefined || typeof changes.summary !== 'function') {
          return { status: 503, body: { ok: false, error: 'workspaceChanges service unavailable' } }
        }
        const summary = changes.summary(sessionId, seq)
        const file = summary !== undefined && Array.isArray(summary.files) ? summary.files[index] : undefined
        path = typeof file?.path === 'string' ? file.path : undefined
      } else {
        const query = ctx.get('sessionQuery')
        if (query === undefined || typeof query.readEvent !== 'function') {
          return { status: 503, body: { ok: false, error: 'sessionQuery service unavailable' } }
        }
        let read
        try {
          read = await query.readEvent({ sessionId, seq, before: 0, after: 0 }, new AbortController().signal)
        } catch (error) {
          return { status: 404, body: { ok: false, error: String(error?.message ?? error) } }
        }
        const target = read?.target ?? read
        const files = target?.type === 'deliverables/presented' ? target.data?.files : undefined
        const file = Array.isArray(files) ? files[index] : undefined
        path = typeof file?.path === 'string' ? file.path : undefined
      }
      if (path === undefined) {
        return { status: 404, body: { ok: false, error: 'no file at that position' } }
      }
      park(sessionId, { kind: 'reference', path, label: basename(path) })
      return { status: 200, body: { ok: true, queued: true, kind: 'reference', path } }
    },

    /** Put a claimed-but-unapplied draft back for the next poll. */
    async repark(payload) {
      if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
        return { status: 400, body: { ok: false, error: 'sessionId is required' } }
      }
      const draft = payload.draft
      if (draft === null || typeof draft !== 'object') {
        return { status: 400, body: { ok: false, error: 'draft is required' } }
      }
      if (draft.kind === 'reference' && typeof draft.path === 'string' && draft.path.length > 0) {
        park(payload.sessionId, { kind: 'reference', path: draft.path, label: typeof draft.label === 'string' ? draft.label : undefined })
        return { status: 200, body: { ok: true } }
      }
      if (typeof draft.text === 'string' && draft.text.trim().length > 0) {
        park(payload.sessionId, {
          kind: 'selection',
          text: draft.text,
          anchor: typeof draft.anchor === 'string' ? draft.anchor : undefined,
          path: typeof draft.path === 'string' ? draft.path : undefined,
        })
        return { status: 200, body: { ok: true } }
      }
      return { status: 400, body: { ok: false, error: 'draft has no content' } }
    },

    async pending(payload) {
      if (typeof payload.sessionId !== 'string' || payload.sessionId.length === 0) {
        return { status: 400, body: { ok: false, error: 'sessionId is required' } }
      }
      const entry = takeDraft(payload.sessionId)
      return { status: 200, body: { ok: true, draft: entry ?? null } }
    },

    async status() {
      return {
        status: 200,
        body: {
          ok: true,
          ideaApp: existsSync(IDEA_APP),
          origin,
          endpoints: [
            `${PREFIX}/open`,
            `${PREFIX}/send`,
            `${PREFIX}/draft`,
            `${PREFIX}/card`,
            `${PREFIX}/repark`,
            `${PREFIX}/pending`,
            `${PREFIX}/sessions`,
            `${PREFIX}/status`,
          ],
        },
      }
    },

    /**
     * Live sessions, newest first, so an external caller (IDEA External Tool)
     * can discover which session should receive a selection.
     */
    async sessions() {
      const service = ctx.get('sessions')
      if (service === undefined || typeof service.list !== 'function') {
        return { status: 503, body: { ok: false, error: 'sessions service unavailable' } }
      }
      const rows = service.list() ?? []
      const headers = []
      for (const entry of rows) {
        const header = entry?.header ?? entry
        const id = header?.id ?? entry?.id
        if (typeof id !== 'string') continue
        headers.push({ id, cwd: typeof header?.cwd === 'string' ? header.cwd : undefined })
      }

      // The session header carries no title; the folded title lives in the
      // session query corpus (the first user message, shortened).
      const titles = new Map()
      const query = ctx.get('sessionQuery')
      if (query !== undefined && typeof query.readTitleSnapshots === 'function' && headers.length > 0) {
        try {
          const snapshots = await query.readTitleSnapshots(headers.map((entry) => entry.id))
          for (const snapshot of snapshots ?? []) {
            if (snapshot?.status !== 'fulfilled') continue
            const value = snapshot.value
            const id = value?.session?.id
            const raw = value?.title
            const title = typeof raw === 'string' ? raw : typeof raw?.title === 'string' ? raw.title : undefined
            if (typeof id === 'string' && title !== undefined) titles.set(id, title)
          }
        } catch (error) {
          ctx.logger?.('dsh-idea-bridge')?.warn?.(`title lookup failed: ${String(error)}`)
        }
      }

      const items = headers.map((entry) => ({
        id: entry.id,
        title: titles.get(entry.id),
        cwd: entry.cwd,
      }))
      return { status: 200, body: { ok: true, sessions: items } }
    },
  }

  const reject = (req, res) => {
    if (requireOrigin && origin !== undefined) {
      const requestOrigin = req.headers.origin
      if (typeof requestOrigin === 'string' && requestOrigin !== origin) {
        writeJson(res, 403, { ok: false, error: 'cross-origin request rejected' })
        return true
      }
    }
    return false
  }

  const mount = (path, method, handler) => {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'exact',
          path: `${PREFIX}${path}`,
          handler: async (req, res) => {
            if (reject(req, res)) return
            if (req.method !== method) {
              writeJson(res, 405, { ok: false, error: `method must be ${method}` })
              return
            }
            let payload = {}
            if (method === 'POST') {
              const contentType = (req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
              if (contentType !== 'application/json') {
                writeJson(res, 415, { ok: false, error: 'content type must be application/json' })
                return
              }
              const body = await readJson(req)
              if (body.kind === 'too-large') {
                writeJson(res, 413, { ok: false, error: 'request body too large' })
                return
              }
              if (body.kind === 'invalid') {
                writeJson(res, 400, { ok: false, error: 'body must be a JSON object' })
                return
              }
              payload = body.value
            }
            try {
              const reply = await handler(payload)
              writeJson(res, reply.status, reply.body)
            } catch (error) {
              writeJson(res, 500, { ok: false, error: String(error?.message ?? error) })
            }
          },
        }),
      `dsh-idea-bridge: ${path}`,
    )
  }

  mount('/open', 'POST', handlers.open)
  mount('/send', 'POST', handlers.send)
  mount('/draft', 'POST', handlers.draft)
  mount('/card', 'POST', handlers.card)
  mount('/pending', 'POST', handlers.pending)
  mount('/repark', 'POST', handlers.repark)
  mount('/sessions', 'GET', handlers.sessions)
  mount('/status', 'GET', handlers.status)
}
