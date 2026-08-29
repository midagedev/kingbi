export function abortError(message = 'Operation aborted') {
  if (typeof DOMException === 'function') return new DOMException(message, 'AbortError');
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function throwIfAborted(signal, message) {
  if (signal?.aborted) throw abortError(message);
}

export function isAbortError(error) {
  return error?.name === 'AbortError';
}
