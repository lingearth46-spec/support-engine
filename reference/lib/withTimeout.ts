/**
 * Run a promise against an AbortController that fires after `ms`, returning null
 * on timeout or any throw. No provider knowledge — shared by lib/embeddings.ts,
 * lib/gemini.ts and lib/openaiSupport.ts so the ceiling can't be raised for one
 * and not another by accident.
 */
export async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await p(ctrl.signal);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
