import { spawn, type ChildProcess } from "node:child_process"
import { createInterface, type Interface } from "node:readline"
import { randomBytes, randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { editFile, readFile } from "./tools.js"
import { runShellSession } from "./shell.js"
import { CLIENT_HOME, CLIENT_WORKSPACE_ROOT, MAX_LINE_LENGTH, MAX_RESULT_BYTES, SHELL_ENV } from "./config.js"

export type PythonExecutionContext = {
  agentId: string
  invocationId: string
  deadlineAt: string
  hostRpcEndpoint?: string
  hostRpcGrant?: string
}

export type PythonExecutionResult = { output: string; status: "ok" | "error" | "cancelled"; restarted?: boolean }

type OutputArchive = { id: string; data: Buffer; truncated: boolean; createdAt: number }

type Pending = {
  resolve: (value: PythonExecutionResult) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
  escalationTimer?: NodeJS.Timeout
  interrupted?: boolean
  chunks: Buffer[]
  retainedBytes: number
  truncated: boolean
  archiveChunks: Buffer[]
  archiveBytes: number
  archiveTruncated: boolean
  previousOutputId: string | null
  stdoutScan: Buffer
  stdoutDone: boolean
  stderrScan: Buffer
  stderrDone: boolean
  endMarker: Buffer
  result?: { status: string; result?: string; error?: string }
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// fds: 0=closed stdin, 1/2=user stdout/stderr, 3=control in (Node->Python), 4=control out (Python->Node)
const PYTHON_BOOTSTRAP = String.raw`
import ast, asyncio, contextlib, contextvars, fnmatch as _fnmatch, json, os, re, sys, traceback, urllib.request, urllib.error, uuid, datetime

_control_in = os.fdopen(3, "r", encoding="utf-8")
_control_out = os.fdopen(4, "w", encoding="utf-8")

def _send(obj):
    _control_out.write(json.dumps(obj, ensure_ascii=False) + "\n")
    _control_out.flush()

def _bounded(text, limit=200000):
    text = str(text)
    if len(text) <= limit:
        return text
    return text[:limit] + "\n...[truncated Python value at %d chars]" % limit

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(line_buffering=True)
    except Exception:
        pass

_namespace = {"__name__": "__main__"}
_execution_var = contextvars.ContextVar("niri_execution", default={})
_loop = asyncio.new_event_loop()
asyncio.set_event_loop(_loop)

def _local(method, args):
    request_id = str(uuid.uuid4())
    _send({"type": "local.call", "requestId": request_id, "method": method, "args": args})
    line = _control_in.readline()
    if not line:
        raise RuntimeError("Python host control channel closed")
    response = json.loads(line)
    if response.get("type") != "local.result" or response.get("requestId") != request_id:
        raise RuntimeError("invalid local helper response")
    if not response.get("ok"):
        raise RuntimeError(response.get("error", "local helper failed"))
    return response.get("result")

def read(path, start_line=1, end_line=None, hashline=False):
    """Read a bounded file slice; set hashline=True to receive edit anchors."""
    return _local("read", {"path": os.path.abspath(path), "start_line": start_line, "end_line": end_line, "hashline": hashline})

def edit(path, target, content):
    """Replace or delete a hashline-anchored line or inclusive range."""
    return _local("edit", {"path": os.path.abspath(path), "target": target, "content": content})

_SEARCH_SKIP_DIRS = {".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", "dist", "build"}
_SEARCH_MAX_FILE_BYTES = 2 * 1024 * 1024

def _workspace_files(root=".", include_hidden=False):
    root = os.path.abspath(root)
    if os.path.isfile(root):
        yield root, os.path.basename(root), os.path.relpath(root, os.getcwd()).replace(os.sep, "/")
        return
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(
            name for name in dirnames
            if name not in _SEARCH_SKIP_DIRS and (include_hidden or not name.startswith("."))
        )
        for name in sorted(filenames):
            if not include_hidden and name.startswith("."):
                continue
            full = os.path.join(dirpath, name)
            relative = os.path.relpath(full, root).replace(os.sep, "/")
            display_path = os.path.relpath(full, os.getcwd()).replace(os.sep, "/")
            yield full, relative, display_path

def _glob_matches(path, pattern):
    normalized = str(pattern).replace("\\", "/")
    return _fnmatch.fnmatchcase(path, normalized) or (
        normalized.startswith("**/") and _fnmatch.fnmatchcase(path, normalized[3:])
    )

def glob(pattern, root=".", limit=200, include_hidden=False):
    """Return bounded workspace file matches without printing file contents."""
    bounded_limit = max(0, min(5000, int(limit)))
    if bounded_limit == 0:
        return []
    matches = []
    for _full, relative, display_path in _workspace_files(root, bool(include_hidden)):
        if not _glob_matches(relative, pattern):
            continue
        matches.append(display_path)
        if len(matches) >= bounded_limit:
            break
    return matches

def grep(pattern, path=".", case=False, fixed=False, include=None, limit=100):
    """Return structured bounded line matches while keeping unprinted results in Python."""
    bounded_limit = max(0, min(5000, int(limit)))
    if bounded_limit == 0:
        return []
    include_patterns = [] if include is None else ([include] if isinstance(include, str) else list(include))
    flags = 0 if case else re.IGNORECASE
    matcher = None if fixed else re.compile(str(pattern), flags)
    needle = str(pattern) if case else str(pattern).lower()
    matches = []
    for full, relative, display_path in _workspace_files(path):
        if include_patterns and not any(_glob_matches(relative, item) for item in include_patterns):
            continue
        try:
            if os.path.getsize(full) > _SEARCH_MAX_FILE_BYTES:
                continue
            with open(full, "r", encoding="utf-8", errors="replace") as handle:
                for line_number, line in enumerate(handle, 1):
                    if "\x00" in line:
                        break
                    haystack = line if case else line.lower()
                    found = needle in haystack if fixed else matcher.search(line) is not None
                    if not found:
                        continue
                    text = line.rstrip("\r\n")
                    if len(text) > 1000:
                        text = text[:1000] + " ... [truncated]"
                    matches.append({"path": display_path, "line": line_number, "text": text})
                    if len(matches) >= bounded_limit:
                        return matches
        except (OSError, UnicodeError):
            continue
    return matches

class ShellResult:
    """Result of sh(); full merged output stays in stdout until explicitly inspected."""
    def __init__(self, stdout="", returncode=None, status="", session_id="", signal=None):
        self.stdout = stdout
        self.returncode = returncode
        self.status = status
        self.session_id = session_id
        self.signal = signal
        self.bytes = len(stdout.encode("utf-8"))
        self.lines = stdout.count("\n") + (1 if stdout and not stdout.endswith("\n") else 0)
    def __getattr__(self, name):
        if name == "stderr":
            raise AttributeError("ShellResult has no .stderr; stdout already contains the command's stderr merged in")
        raise AttributeError("ShellResult has no attribute %r; use stdout, output(), page(), tail(), grep(), returncode, status, session_id, or signal" % name)
    def output(self):
        return self.stdout
    def page(self, offset=0, limit=4000):
        start = max(0, int(offset))
        count = max(0, min(200000, int(limit)))
        return self.stdout[start:start + count]
    def tail(self, n=4000):
        count = max(0, min(200000, int(n)))
        return self.stdout[-count:] if count else ""
    def grep(self, pattern, limit=50, case=True):
        expression = re.compile(str(pattern), 0 if case else re.IGNORECASE)
        bounded_limit = max(0, min(5000, int(limit)))
        if bounded_limit == 0:
            return ""
        matches = []
        for line in self.stdout.splitlines():
            if expression.search(line) is None:
                continue
            matches.append(line if len(line) <= 1000 else line[:1000] + " ... [truncated]")
            if len(matches) >= bounded_limit:
                break
        return "\n".join(matches)
    def __repr__(self):
        return "ShellResult(status=%r, returncode=%r, session_id=%r, bytes=%d, lines=%d; output retained in .stdout, .tail(), .grep(), .page())" % (
            self.status, self.returncode, self.session_id, self.bytes, self.lines
        )

def sh(command, timeout_ms=30000):
    value = _local("sh", {"action": "start", "command": str(command), "timeout_ms": timeout_ms, "cwd": os.getcwd()})
    return ShellResult(**value)

def _shell_action(action):
    def call(session_id, timeout_ms=30000):
        value = _local("sh", {"action": action, "session_id": str(session_id), "timeout_ms": timeout_ms})
        return ShellResult(**value)
    return call

sh.poll = _shell_action("poll")
sh.terminate = _shell_action("terminate")

class _Output:
    """Synchronous bounded access to retained output from recent Python cells."""
    def list(self): return _local("output", {"action": "list"})
    def size(self, output_id=None): return _local("output", {"action": "size", "id": output_id})
    def page(self, offset=0, limit=4000, output_id=None): return _local("output", {"action": "page", "offset": offset, "limit": limit, "id": output_id})
    def tail(self, n=4000, output_id=None): return _local("output", {"action": "tail", "n": n, "id": output_id})
    def grep(self, pattern, limit=50, output_id=None): return _local("output", {"action": "grep", "pattern": str(pattern), "limit": limit, "id": output_id})

out = _Output()

class NiriError(Exception):
    """Base exception for typed niri host RPC failures."""
    default_code = "operation_failed"
    def __init__(self, message, code=None):
        super().__init__(message)
        self.code = code or self.default_code

class NiriInvalid(NiriError):
    """The host rejected an invalid argument."""
    default_code = "invalid_argument"

class NiriNotFound(NiriError):
    """The requested host resource does not exist."""
    default_code = "not_found"

class NiriUnauthorized(NiriError):
    """The execution grant does not authorize the host call."""
    default_code = "unauthorized"

class NiriDeadlineExceeded(NiriError):
    """The host call exceeded its deadline."""
    default_code = "deadline_exceeded"

class NiriUnavailable(NiriError):
    """The host RPC service is unavailable."""
    default_code = "unavailable"

_NIRI_ERROR_TYPES = {
    "invalid_argument": NiriInvalid,
    "not_found": NiriNotFound,
    "unauthorized": NiriUnauthorized,
    "deadline_exceeded": NiriDeadlineExceeded,
    "unavailable": NiriUnavailable,
}

def _niri_exception(message, code=None, http_status=None):
    error_type = _NIRI_ERROR_TYPES.get(code)
    if error_type:
        return error_type(message, code)
    if http_status == 400:
        return NiriInvalid(message)
    if http_status == 403:
        return NiriUnauthorized(message)
    if http_status == 408:
        return NiriDeadlineExceeded(message)
    if http_status is not None and http_status >= 500:
        return NiriUnavailable(message)
    return NiriError(message, code)

async def _host_call(method, args):
    execution = _execution_var.get()
    endpoint = execution.get("hostRpcEndpoint")
    grant = execution.get("hostRpcGrant")
    if not endpoint or not grant:
        raise NiriUnavailable("host RPC is unavailable for this Python execution")
    now = datetime.datetime.now(datetime.timezone.utc)
    deadline = execution.get("deadlineAt")
    body = {
        "type": "host.call",
        "requestId": str(uuid.uuid4()),
        "outerInvocationId": execution["invocationId"],
        "method": method,
        "args": args,
        "issuedAt": now.isoformat().replace("+00:00", "Z"),
        "deadlineAt": deadline,
    }
    def perform():
        request = urllib.request.Request(
            endpoint.rstrip("/") + "/host-rpc",
            data=json.dumps(body).encode(),
            headers={"content-type": "application/json", "authorization": "Bearer " + grant},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as exc:
            code = None
            try:
                detail = json.loads(exc.read().decode()).get("error", exc.reason)
                if isinstance(detail, dict):
                    code = detail.get("code")
            except Exception:
                detail = exc.reason
            raise _niri_exception("host RPC failed: " + str(detail), code, exc.code)
    response = await asyncio.to_thread(perform)
    if response.get("type") != "host.result" or response.get("requestId") != body["requestId"]:
        raise NiriUnavailable("host returned an invalid RPC result")
    if response.get("status") != "ok":
        error = response.get("error") or {}
        raise _niri_exception(error.get("message", "host RPC failed"), error.get("code"))
    return response.get("result")

class _Memory:
    async def search(self, query, limit=None): """Coroutine: search agent memory."""; return await _host_call("memory.search", {"query": query, "limit": limit})
    async def read(self, path, start_line=None, end_line=None, hashline=False): """Coroutine: read an agent memory file."""; return await _host_call("memory.read", {"path": path, "start_line": start_line, "end_line": end_line, "hashline": hashline})
    async def list(self): """Coroutine: list agent memory files."""; return await _host_call("memory.list", {})
    async def grep(self, query, case_insensitive=False): """Coroutine: grep across agent memory files."""; return await _host_call("memory.grep", {"query": query, "case_insensitive": case_insensitive})
    async def write(self, path, content, mode="append", target=None): """Coroutine: write an agent memory file."""; return await _host_call("memory.write", {"path": path, "content": content, "mode": mode, "target": target})

class _Soul:
    async def read(self, hashline=False): """Coroutine: read the agent soul document."""; return await _host_call("soul.read", {"hashline": hashline})
    async def write(self, content, mode="append", target=None): """Coroutine: write the agent soul document."""; return await _host_call("soul.write", {"content": content, "mode": mode, "target": target})

class _Context:
    async def grep(self, query, limit=None, summary_id=None): """Coroutine: grep retained conversation context."""; return await _host_call("context.grep", {"query": query, "limit": limit, "summary_id": summary_id})
    async def describe(self, id, token_cap=None): """Coroutine: describe a retained context item."""; return await _host_call("context.describe", {"id": id, "token_cap": token_cap})
    async def expand(self, summary_id, offset=None, limit=None): """Coroutine: expand a retained context summary."""; return await _host_call("context.expand", {"summary_id": summary_id, "offset": offset, "limit": limit})

class _Discord:
    async def inbox(self, limit=20, statuses=None): """Coroutine: read the Discord inbox."""; return await _host_call("discord.inbox", {"limit": limit, "statuses": statuses})
    async def backread(self, channel_id, limit=40, before_message_id=None): """Coroutine: read earlier Discord messages."""; return await _host_call("discord.backread", {"channel_id": channel_id, "limit": limit, "before_message_id": before_message_id})
    async def search(self, channel_id, query=None, message_id=None, limit=None): """Coroutine: search Discord messages."""; return await _host_call("discord.search", {"channel_id": channel_id, "query": query, "message_id": message_id, "limit": limit})
    async def channels(self): """Coroutine: list available Discord channels."""; return await _host_call("discord.channels", {})

class _Schedule:
    async def create(self, message, at=None, delay_ms=None, repeat_every_ms=None): """Coroutine: create a scheduled message."""; return await _host_call("schedule.create", {"message": message, "at": at, "delay_ms": delay_ms, "repeat_every_ms": repeat_every_ms})
    async def list(self, limit=50): """Coroutine: list scheduled messages."""; return await _host_call("schedule.list", {"limit": limit})
    async def cancel(self, id): """Coroutine: cancel a scheduled message."""; return await _host_call("schedule.cancel", {"id": id})

class _Aliases:
    async def list(self): """Coroutine: list memory aliases."""; return await _host_call("memory.alias.list", {})
    async def set(self, handle, canonical): """Coroutine: set a memory alias."""; return await _host_call("memory.alias.set", {"handle": handle, "canonical": canonical})
    async def remove(self, handle, canonical=None): """Coroutine: remove a memory alias."""; return await _host_call("memory.alias.remove", {"handle": handle, "canonical": canonical})

def _seconds_remaining(execution):
    deadline = execution.get("deadlineAt")
    if not deadline:
        return 0.0
    try:
        target = datetime.datetime.fromisoformat(str(deadline).replace("Z", "+00:00"))
        return max(0.0, (target - datetime.datetime.now(datetime.timezone.utc)).total_seconds())
    except (TypeError, ValueError):
        return 0.0

class _Niri:
    """Persistent niri API namespaces: memory, soul, context, discord, schedule, aliases, and scratch."""
    scratch = os.environ["NIRI_SCRATCH"]
    memory = _Memory()
    soul = _Soul()
    context = _Context()
    discord = _Discord()
    schedule = _Schedule()
    aliases = _Aliases()
    async def budget(self):
        """Coroutine: return the loop turn, token, context, and current invocation deadline budget."""
        value = await _host_call("loop.budget", {})
        identity = self.whoami()
        return {**value, "deadline_at": identity["deadline_at"], "seconds_remaining": identity["seconds_remaining"]}
    def whoami(self):
        """Synchronous (not a coroutine): describe the current agent, invocation, paths, deadline, and host RPC."""
        execution = _execution_var.get()
        return {
            "agent_id": execution.get("agentId"),
            "invocation_id": execution.get("invocationId"),
            "workspace": os.environ.get("NIRI_WORKSPACE"),
            "home": os.environ.get("HOME"),
            "scratch": self.scratch,
            "deadline_at": execution.get("deadlineAt"),
            "seconds_remaining": _seconds_remaining(execution),
            "host_rpc": bool(execution.get("hostRpcEndpoint") and execution.get("hostRpcGrant")),
        }
    def deadline(self):
        """Synchronous (not a coroutine): return seconds remaining for the current invocation."""
        return _seconds_remaining(_execution_var.get())

niri = _Niri()
_namespace.update({"niri": niri, "out": out, "read": read, "edit": edit, "sh": sh, "glob": glob, "grep": grep,
    "ShellResult": ShellResult, "NiriError": NiriError, "NiriInvalid": NiriInvalid, "NiriNotFound": NiriNotFound,
    "NiriUnauthorized": NiriUnauthorized, "NiriDeadlineExceeded": NiriDeadlineExceeded, "NiriUnavailable": NiriUnavailable})

def _execute(source):
    tree = ast.parse(source, mode="exec")
    result = None
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        prefix = ast.Module(body=tree.body[:-1], type_ignores=[])
        if prefix.body:
            value = eval(compile(prefix, "<niri-python>", "exec", ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), _namespace)
            if hasattr(value, "__await__"):
                _loop.run_until_complete(value)
        expr = ast.Expression(tree.body[-1].value)
        value = eval(compile(expr, "<niri-python>", "eval", ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), _namespace)
        result = _loop.run_until_complete(value) if hasattr(value, "__await__") else value
    else:
        value = eval(compile(tree, "<niri-python>", "exec", ast.PyCF_ALLOW_TOP_LEVEL_AWAIT), _namespace)
        if hasattr(value, "__await__"):
            _loop.run_until_complete(value)
    return result

_send({"type": "ready", "version": list(sys.version_info[:2]), "platform": sys.platform})

while True:
    line = _control_in.readline()
    if not line:
        break
    try:
        command = json.loads(line)
    except Exception:
        continue
    if command.get("type") == "shutdown":
        break
    if command.get("type") == "reset":
        keep = {key: _namespace[key] for key in ("__name__", "niri", "out", "read", "edit", "sh", "glob", "grep",
            "ShellResult", "NiriError", "NiriInvalid", "NiriNotFound", "NiriUnauthorized", "NiriDeadlineExceeded", "NiriUnavailable")}
        _namespace.clear()
        _namespace.update(keep)
        _send({"type": "reset.result", "id": command.get("id")})
        continue
    if command.get("type") != "execute":
        continue
    # The cell-end marker is minted per execution by the host, so output that
    # happens to contain a marker-shaped byte string cannot forge a boundary.
    end_marker = ("\n\x00" + str(command.get("endMarker") or "") + "\n").encode()
    token = _execution_var.set(command.get("context") or {})
    status = "ok"
    error = None
    result = None
    try:
        result = _execute(command.get("code", ""))
    except KeyboardInterrupt:
        status = "cancelled"
        error = "execution interrupted"
    except BaseException:
        status = "error"
        error = _bounded(traceback.format_exc())
    _execution_var.reset(token)
    try:
        sys.stdout.flush()
    except Exception:
        pass
    try:
        sys.stderr.flush()
    except Exception:
        pass
    try:
        os.write(1, end_marker)
    except Exception:
        pass
    try:
        os.write(2, end_marker)
    except Exception:
        pass
    payload = {"type": "execute.result", "id": command.get("id"), "status": status}
    if status == "ok" and result is not None:
        payload["result"] = _bounded(repr(result))
    if error is not None:
        payload["error"] = _bounded(error)
    _send(payload)
`

const PYTHON_MIN_VERSION = 309
const READY_TIMEOUT_MS = 8_000
const RESET_TIMEOUT_MS = 10_000
const INTERRUPT_GRACE_MS = 2_000
const MAX_RETAINED_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_OUTPUT_ARCHIVES = 32
const MAX_OUTPUT_ARCHIVE_TOTAL_BYTES = 32 * 1024 * 1024

/** Mint one execution's cell-end token; unguessable so cell output cannot forge a boundary. */
function cellEndToken(): string {
  return `NIRI_CELL_END_${randomBytes(12).toString("hex")}`
}

/** The bytes Python writes to fd 1/2 to close out a cell, for the token above. */
function cellEndMarker(token: string): Buffer {
  return Buffer.from(`\n\u0000${token}\n`, "utf8")
}

function rawStream(child: ChildProcess, index: number): NodeJS.ReadableStream {
  const stream = child.stdio[index]
  if (!stream || typeof (stream as NodeJS.ReadableStream).on !== "function") {
    throw new Error(`missing python kernel stdio stream ${index}`)
  }
  return stream as NodeJS.ReadableStream
}
function isChildAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

export class PythonKernelManager {
  private child: ChildProcess | null = null
  private control: Interface | null = null
  private pending = new Map<string, Pending>()
  private resets = new Map<string, Deferred<void>>()
  private queue: Promise<void> = Promise.resolve()
  private activeId: string | null = null
  private starting: Promise<ChildProcess> | null = null
  private lastError: Error | null = null
  private outputArchives = new Map<string, OutputArchive>()
  private outputArchiveBytes = 0
  private latestOutputId: string | null = null

  isReady(): boolean {
    return Boolean(this.child && isChildAlive(this.child) && !this.lastError)
  }

  async probe(): Promise<boolean> {
    if (this.isReady()) return true
    try {
      await this.ensureStarted()
      return true
    } catch (error) {
      this.lastError = error instanceof Error ? error : new Error(String(error))
      return false
    }
  }

  async execute(code: string, context: PythonExecutionContext): Promise<PythonExecutionResult> {
    const task = this.queue.then(() => this.executeNow(code, context))
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  /**
   * Clear the kernel namespace. Serialized on the execution queue and resolved
   * only once Python acknowledges, so a caller that awaits this knows the
   * namespace is gone — and an explicit reset can never land mid-cell.
   */
  async reset(): Promise<void> {
    const task = this.queue.then(() => this.resetNow())
    this.queue = task.then(() => undefined, () => undefined)
    return task
  }

  private async resetNow(): Promise<void> {
    const child = this.child
    if (!child || !isChildAlive(child)) return
    const stream = child.stdio[3]
    if (!stream || typeof (stream as NodeJS.WritableStream).write !== "function") return
    const id = randomUUID()
    const pending = deferred<void>()
    this.resets.set(id, pending)
    const timer = setTimeout(() => {
      this.resets.delete(id)
      pending.reject(new Error("Python kernel reset timed out"))
    }, RESET_TIMEOUT_MS)
    timer.unref?.()
    try {
      ;(stream as NodeJS.WritableStream).write(JSON.stringify({ type: "reset", id }) + "\n")
      await pending.promise
    } finally {
      clearTimeout(timer)
      this.resets.delete(id)
    }
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.control?.close()
    this.control = null
    if (child && isChildAlive(child)) {
      try {
        const stream = child.stdio[3]
        if (stream && typeof (stream as NodeJS.WritableStream).write === "function") {
          ;(stream as NodeJS.WritableStream).write(JSON.stringify({ type: "shutdown" }) + "\n")
        }
      } catch {
        // best effort
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve() }, 500)
        timer.unref?.()
        child.once("exit", () => { clearTimeout(timer); resolve() })
      })
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      clearTimeout(pending.escalationTimer)
      pending.reject(new Error("Python kernel stopped"))
    }
    this.pending.clear()
    this.failWaitingResets(new Error("Python kernel stopped"))
    this.activeId = null
    this.starting = null
    this.clearOutputArchives()
  }

  private async executeNow(code: string, context: PythonExecutionContext): Promise<PythonExecutionResult> {
    if (Date.now() >= Date.parse(context.deadlineAt)) throw new Error("Python execution expired while queued")
    const child = await this.ensureStarted()
    if (!this.isReady()) throw new Error(this.lastError?.message ?? "Python kernel unavailable")
    const id = randomUUID()
    const endMarker = cellEndToken()
    const remaining = Math.max(1, Date.parse(context.deadlineAt) - Date.now())
    const previousOutputId = this.latestOutputId
    return new Promise<PythonExecutionResult>((resolve, reject) => {
      const pending: Pending = {
        resolve,
        reject,
        timer: undefined as unknown as NodeJS.Timeout,
        chunks: [],
        retainedBytes: 0,
        truncated: false,
        archiveChunks: [],
        archiveBytes: 0,
        archiveTruncated: false,
        previousOutputId,
        stdoutScan: Buffer.alloc(0),
        stdoutDone: false,
        stderrScan: Buffer.alloc(0),
        stderrDone: false,
        endMarker: cellEndMarker(endMarker),
      }
      pending.timer = setTimeout(() => {
        if (this.child !== child || !isChildAlive(child) || !this.pending.has(id)) return
        pending.escalationTimer = setTimeout(() => {
          if (this.pending.has(id)) this.restart(new Error("Python execution timed out; kernel restarted and namespace was lost"))
        }, INTERRUPT_GRACE_MS)
        pending.escalationTimer.unref?.()
        if (child.kill("SIGINT")) pending.interrupted = true
      }, remaining)
      pending.timer.unref?.()
      this.pending.set(id, pending)
      this.activeId = id
      const stream = child.stdio[3]
      if (!stream || typeof (stream as NodeJS.WritableStream).write !== "function") {
        this.pending.delete(id)
        clearTimeout(pending.timer)
        clearTimeout(pending.escalationTimer)
        this.activeId = null
        reject(new Error("python kernel control channel is unavailable"))
        return
      }
      ;(stream as NodeJS.WritableStream).write(JSON.stringify({ type: "execute", id, code, context, endMarker }) + "\n")
    })
  }

  private async ensureStarted(): Promise<ChildProcess> {
    if (this.isReady()) return this.child as ChildProcess
    if (this.starting) return this.starting
    this.starting = this.start().finally(() => { this.starting = null })
    return this.starting
  }

  private async start(): Promise<ChildProcess> {
    if (this.child && isChildAlive(this.child)) {
      await this.stop()
    }
    const pythonCache = path.join(CLIENT_HOME, ".cache", "niri-python")
    const scratch = path.join(CLIENT_HOME, ".cache", "niri-scratch")
    await Promise.all([
      mkdir(pythonCache, { recursive: true, mode: 0o700 }),
      mkdir(scratch, { recursive: true, mode: 0o700 }),
    ])
    SHELL_ENV.PYTHONPYCACHEPREFIX = pythonCache
    const ready = deferred<ChildProcess>()
    const child = spawn(process.env.NIRI_PYTHON ?? "python3", ["-u", "-c", PYTHON_BOOTSTRAP], {
      cwd: CLIENT_WORKSPACE_ROOT,
      env: { ...SHELL_ENV, HOME: CLIENT_HOME, NIRI_WORKSPACE: CLIENT_WORKSPACE_ROOT, NIRI_SCRATCH: scratch, PYTHONPYCACHEPREFIX: pythonCache },
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    })
    this.child = child
    this.lastError = null

    const readyTimer = setTimeout(() => {
      ready.reject(new Error("Python kernel readiness timed out"))
    }, READY_TIMEOUT_MS)
    readyTimer.unref?.()

    child.once("error", (error) => {
      clearTimeout(readyTimer)
      if (this.child !== child) return
      this.lastError = error
      ready.reject(error)
    })
    child.once("exit", (code, signal) => {
      clearTimeout(readyTimer)
      // A stale child must never poison a newer replacement's readiness state.
      if (this.child !== child) return
      const error = new Error(`Python kernel exited${signal ? ` (${signal})` : code !== null ? ` with code ${code}` : ""}`)
      this.lastError = error
      ready.reject(error)
      this.restart(error)
    })

    const stdout = rawStream(child, 1)
    const stderr = rawStream(child, 2)
    stdout.on("data", (chunk: Buffer) => this.onRaw(chunk, "stdout"))
    stderr.on("data", (chunk: Buffer) => this.onRaw(chunk, "stderr"))

    const controlOut = rawStream(child, 4)
    this.control = createInterface({ input: controlOut })
    this.control.on("line", (line) => {
      void this.handleLine(line, child, ready)
    })

    return ready.promise
  }

  private async handleLine(line: string, child: ChildProcess, ready: Deferred<ChildProcess>): Promise<void> {
    let message: { type?: string; requestId?: unknown; method?: unknown; args?: unknown; id?: unknown; status?: unknown; result?: unknown; error?: unknown; version?: unknown }
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (message.type === "ready") {
      const version = Array.isArray(message.version) ? message.version : []
      const major = Number(version[0] ?? 0)
      const minor = Number(version[1] ?? 0)
      if (major * 100 + minor < PYTHON_MIN_VERSION) {
        const error = new Error(`Python ${major}.${minor} is too old; niri requires >= 3.9`)
        this.lastError = error
        ready.reject(error)
        return
      }
      ready.resolve(child)
      return
    }
    if (message.type === "reset.result") {
      const waiter = this.resets.get(String(message.id ?? ""))
      if (waiter) {
        this.resets.delete(String(message.id ?? ""))
        waiter.resolve()
      }
      return
    }
    if (message.type === "local.call") {
      try {
        const result = await this.localCall(String(message.method ?? ""), (message.args ?? {}) as Record<string, unknown>)
        this.writeControl(child, { type: "local.result", requestId: message.requestId, ok: true, result })
      } catch (error) {
        this.writeControl(child, { type: "local.result", requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) })
      }
      return
    }
    if (message.type !== "execute.result") return
    const pending = this.pending.get(String(message.id ?? ""))
    if (!pending) return
    pending.result = {
      status: String(message.status ?? "ok"),
      ...(typeof message.result === "string" ? { result: message.result } : {}),
      ...(typeof message.error === "string" ? { error: message.error } : {}),
    }
    this.maybeFinalize(String(message.id ?? ""))
  }

  private writeControl(child: ChildProcess, value: unknown): void {
    const stream = child.stdio[3]
    if (!stream || typeof (stream as NodeJS.WritableStream).write !== "function") return
    ;(stream as NodeJS.WritableStream).write(JSON.stringify(value) + "\n")
  }

  private onRaw(chunk: Buffer, stream: "stdout" | "stderr"): void {
    const pending = this.activeId ? this.pending.get(this.activeId) : undefined
    if (!pending) return
    const scan = stream === "stdout" ? pending.stdoutScan : pending.stderrScan
    const combined = scan.length ? Buffer.concat([scan, chunk]) : chunk
    const markerIndex = combined.indexOf(pending.endMarker)
    if (markerIndex >= 0) {
      this.retain(pending, combined.subarray(0, markerIndex))
      if (stream === "stdout") { pending.stdoutScan = Buffer.alloc(0); pending.stdoutDone = true }
      else { pending.stderrScan = Buffer.alloc(0); pending.stderrDone = true }
      this.maybeFinalize(this.activeId ?? "")
      return
    }
    const keepLength = Math.min(pending.endMarker.length - 1, combined.length)
    this.retain(pending, combined.subarray(0, combined.length - keepLength))
    if (stream === "stdout") pending.stdoutScan = combined.subarray(combined.length - keepLength)
    else pending.stderrScan = combined.subarray(combined.length - keepLength)
  }

  private retain(pending: Pending, chunk: Buffer): void {
    if (chunk.length === 0) return
    const transportRemaining = Math.max(0, MAX_RESULT_BYTES - pending.retainedBytes)
    if (transportRemaining > 0) {
      const visible = chunk.subarray(0, transportRemaining)
      pending.chunks.push(visible)
      pending.retainedBytes += visible.length
    }
    if (chunk.length > transportRemaining) pending.truncated = true
    const archiveRemaining = Math.max(0, MAX_RETAINED_OUTPUT_BYTES - pending.archiveBytes)
    if (archiveRemaining > 0) {
      const archived = chunk.subarray(0, archiveRemaining)
      pending.archiveChunks.push(archived)
      pending.archiveBytes += archived.length
    }
    if (chunk.length > archiveRemaining) pending.archiveTruncated = true
  }

  private clearOutputArchives(): void {
    this.outputArchives.clear()
    this.outputArchiveBytes = 0
    this.latestOutputId = null
  }

  private rememberOutput(archive: OutputArchive): void {
    const prior = this.outputArchives.get(archive.id)
    if (prior) this.outputArchiveBytes -= prior.data.length
    this.outputArchives.delete(archive.id)
    this.outputArchives.set(archive.id, archive)
    this.outputArchiveBytes += archive.data.length
    this.latestOutputId = archive.id
    while (
      this.outputArchives.size > MAX_OUTPUT_ARCHIVES ||
      (this.outputArchiveBytes > MAX_OUTPUT_ARCHIVE_TOTAL_BYTES && this.outputArchives.size > 1)
    ) {
      const oldestId = this.outputArchives.keys().next().value as string | undefined
      if (!oldestId) break
      const oldest = this.outputArchives.get(oldestId)
      this.outputArchives.delete(oldestId)
      if (oldest) this.outputArchiveBytes -= oldest.data.length
    }
  }

  private resolveOutputArchive(requestedId: unknown, pending?: Pending): OutputArchive | null {
    const id = typeof requestedId === "string" && requestedId
      ? requestedId
      : pending?.previousOutputId ?? this.latestOutputId
    if (!id) return null
    const archive = this.outputArchives.get(id)
    if (!archive) throw new Error(`unknown retained output id: ${id}`)
    return archive
  }

  private maybeFinalize(id: string): void {
    const pending = this.pending.get(id)
    if (!pending || !pending.result || !pending.stdoutDone || !pending.stderrDone) return
    this.pending.delete(id)
    if (this.activeId === id) this.activeId = null
    clearTimeout(pending.timer)
    clearTimeout(pending.escalationTimer)

    const result = pending.result
    const suffixParts: string[] = []
    if (result.status !== "ok") {
      suffixParts.push(`${result.status}: ${result.error ?? "unknown Python error"}`)
    } else if (result.result) {
      suffixParts.push(result.result)
    }
    if (pending.interrupted) {
      suffixParts.push("Python execution exceeded its deadline and was interrupted; the kernel namespace is intact.")
    }
    const suffix = suffixParts.length > 0 ? `${suffixParts.join("\n")}\n` : ""
    const suffixBuffer = Buffer.from(suffix, "utf8")

    const archivedStream = Buffer.concat(pending.archiveChunks, pending.archiveBytes)
    const combinedArchive = Buffer.concat([archivedStream, suffixBuffer])
    const archiveTruncated = pending.archiveTruncated || combinedArchive.length > MAX_RETAINED_OUTPUT_BYTES
    const outputId = `out_${id}`
    this.rememberOutput({
      id: outputId,
      data: combinedArchive.subarray(0, MAX_RETAINED_OUTPUT_BYTES),
      truncated: pending.truncated || archiveTruncated,
      createdAt: Date.now(),
    })

    const transport = Buffer.concat([
      Buffer.concat(pending.chunks, pending.retainedBytes),
      suffixBuffer,
    ])
    const transportTruncated = pending.truncated || transport.length > MAX_RESULT_BYTES
    let output: string
    if (transportTruncated) {
      const notice =
        `\n[truncated at ${MAX_RESULT_BYTES} bytes for transport; retained as ${outputId}. ` +
        `use out.tail(output_id=${JSON.stringify(outputId)}), out.grep(..., output_id=${JSON.stringify(outputId)}), or out.page(..., output_id=${JSON.stringify(outputId)})]`
      const prefixBytes = Math.max(0, MAX_RESULT_BYTES - Buffer.byteLength(notice, "utf8"))
      output = transport.subarray(0, prefixBytes).toString("utf8").replace(/\uFFFD$/, "") + notice
    } else {
      output = transport.toString("utf8")
    }

    if (pending.interrupted) {
      pending.resolve({ output, status: "cancelled" })
      return
    }
    if (result.status !== "ok") {
      pending.resolve({ output, status: result.status === "cancelled" ? "cancelled" : "error" })
      return
    }
    pending.resolve({ output, status: "ok" })
  }

  private async localCall(method: string, args: Record<string, unknown>): Promise<unknown> {
    if (method === "output") {
      const pending = this.activeId ? this.pending.get(this.activeId) : undefined
      if (args.action === "list") {
        return [...this.outputArchives.values()].reverse().map((archive) => ({
          id: archive.id,
          bytes: archive.data.length,
          truncated: archive.truncated,
          created_at: new Date(archive.createdAt).toISOString(),
        }))
      }
      const archive = this.resolveOutputArchive(args.id, pending)
      if (args.action === "size") {
        return archive
          ? { id: archive.id, bytes: archive.data.length, truncated: archive.truncated }
          : { id: null, bytes: 0, truncated: false }
      }
      if (!archive) return ""
      if (args.action === "page") {
        const requestedOffset = Number(args.offset ?? 0)
        const requestedLimit = Number(args.limit ?? 4_000)
        const offset = Number.isFinite(requestedOffset) ? Math.max(0, Math.trunc(requestedOffset)) : 0
        const limit = Number.isFinite(requestedLimit) ? Math.min(MAX_RESULT_BYTES, Math.max(0, Math.trunc(requestedLimit))) : 4_000
        return archive.data.subarray(offset, offset + limit).toString("utf8").replace(/^\uFFFD|\uFFFD$/g, "")
      }
      if (args.action === "tail") {
        const requested = Number(args.n ?? 4_000)
        const count = Number.isFinite(requested) ? Math.min(MAX_RESULT_BYTES, Math.max(0, Math.trunc(requested))) : 4_000
        return archive.data.subarray(Math.max(0, archive.data.length - count)).toString("utf8").replace(/^\uFFFD/, "")
      }
      if (args.action === "grep") {
        const pattern = new RegExp(String(args.pattern ?? ""))
        const requested = Number(args.limit ?? 50)
        const limit = Number.isFinite(requested) ? Math.max(0, Math.trunc(requested)) : 50
        if (limit === 0) return ""
        const matches: string[] = []
        for (const line of archive.data.toString("utf8").split(/\r?\n/)) {
          if (!pattern.test(line)) continue
          matches.push(line.length <= MAX_LINE_LENGTH ? line : `${line.slice(0, MAX_LINE_LENGTH)} ... [truncated line of ${line.length} characters]`)
          if (matches.length >= limit) break
        }
        const matched = Buffer.from(matches.join("\n"), "utf8")
        return matched.length <= MAX_RESULT_BYTES
          ? matched.toString("utf8")
          : matched.subarray(0, MAX_RESULT_BYTES).toString("utf8").replace(/\uFFFD$/, "")
      }
      throw new Error(`unknown retained output action: ${String(args.action ?? "")}`)
    }
    if (method === "read") {
      return readFile(
        String(args.path ?? ""),
        Number(args.start_line ?? 1),
        args.end_line == null ? undefined : Number(args.end_line),
        undefined,
        args.hashline === true,
      )
    }
    if (method === "edit") {
      const result = await editFile(String(args.path ?? ""), String(args.target ?? ""), String(args.content ?? ""))
      if (!result.ok) throw new Error(result.message)
      return result.message
    }
    if (method === "sh") {
      const action = args.action === "poll" || args.action === "terminate" ? args.action : "start"
      const result = await runShellSession({
        action,
        ...(typeof args.command === "string" ? { command: args.command } : {}),
        ...(typeof args.session_id === "string" ? { sessionId: args.session_id } : {}),
        timeoutMs: Number(args.timeout_ms ?? 30_000),
        ...(action === "start" ? { cwd: String(args.cwd || CLIENT_WORKSPACE_ROOT) } : {}),
      })
      return { stdout: result.output, returncode: result.exitCode, status: result.status, session_id: result.sessionId, signal: result.signal }
    }
    throw new Error(`unknown local Python helper: ${method}`)
  }

  private restart(error: Error): void {
    const child = this.child
    this.child = null
    this.control?.close()
    this.control = null
    this.lastError = error
    if (child && isChildAlive(child)) child.kill("SIGKILL")
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      clearTimeout(pending.escalationTimer)
      pending.reject(error)
    }
    this.pending.clear()
    this.failWaitingResets(error)
    this.activeId = null
  }

  private failWaitingResets(error: Error): void {
    for (const waiter of this.resets.values()) waiter.reject(error)
    this.resets.clear()
  }
}
