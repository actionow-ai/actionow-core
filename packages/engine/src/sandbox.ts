import { getQuickJS, type QuickJSWASMModule } from 'quickjs-emscripten';

/** Thrown when a plugin handler errors, times out, exceeds memory, or returns non-JSON. */
export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxError';
  }
}

/** The handler entry points a provider plugin may export. */
export type HandlerFn = 'mapRequest' | 'mapResponse' | 'mapPoll' | 'mapCallback';

export interface RunHandlerOptions {
  /** Hard wall-clock cap (default 50ms) — an interrupt handler aborts past it. */
  timeoutMs?: number;
  /** Hard memory cap in MB (default 16). */
  memoryMb?: number;
}

const DEFAULT_TIMEOUT_MS = 50;
const DEFAULT_MEMORY_MB = 16;

let modulePromise: Promise<QuickJSWASMModule> | undefined;
function quickjs(): Promise<QuickJSWASMModule> {
  modulePromise ??= getQuickJS();
  return modulePromise;
}

/**
 * Run one plugin handler function in a fresh, hard-isolated QuickJS-WASM context
 * (spec D5): the WASM boundary means NO host bindings (no fetch/process/timers/
 * console/network/I/O), time-boxed via an interrupt handler, memory-capped, and
 * deterministic for a pure mapper. `arg` is marshalled in as JSON (so the handler
 * can never reach a host object reference); the return value is marshalled out as
 * JSON. A throw / timeout / OOM / non-JSON return → {@link SandboxError}. Secrets
 * are NEVER passed in here — auth/signing happens outside the sandbox (D7).
 */
export async function runHandler(
  handlerCode: string,
  fnName: HandlerFn,
  arg: unknown,
  opts: RunHandlerOptions = {},
): Promise<unknown> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const memoryMb = opts.memoryMb ?? DEFAULT_MEMORY_MB;
  const QuickJS = await quickjs();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(memoryMb * 1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  runtime.setInterruptHandler(() => Date.now() > deadline);
  const ctx = runtime.newContext();

  try {
    // Inject arg as a JSON string global (no host-object reference crosses in).
    const argHandle = ctx.newString(JSON.stringify(arg ?? null));
    ctx.setProp(ctx.global, '__ARG_JSON__', argHandle);
    argHandle.dispose();

    const code = `${handlerCode}\n;JSON.stringify((${fnName})(JSON.parse(__ARG_JSON__)))`;
    const result = ctx.evalCode(code);

    if (result.error !== undefined) {
      const dumped: unknown = ctx.dump(result.error);
      result.error.dispose();
      const msg =
        typeof dumped === 'object' && dumped !== null && 'message' in dumped
          ? String(dumped.message)
          : JSON.stringify(dumped);
      throw new SandboxError(`handler ${fnName} threw: ${msg}`);
    }

    const outJson: unknown = ctx.dump(result.value);
    result.value.dispose();
    if (typeof outJson !== 'string') {
      throw new SandboxError(`handler ${fnName} returned a non-serializable value`);
    }
    return JSON.parse(outJson);
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    // Interrupt (timeout) and OOM surface as engine errors from evalCode.
    throw new SandboxError(
      `handler ${fnName} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    ctx.dispose();
    runtime.dispose();
  }
}
