export function getClientId(): string {
  let clientId = localStorage.getItem('ppt_transl_client_id');
  if (!clientId) {
    clientId = `cli_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
    localStorage.setItem('ppt_transl_client_id', clientId);
  }
  return clientId;
}

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const clientId = getClientId();

  // 1. Redundant: Append to query parameter
  let targetUrl = url;
  try {
    const hasQuery = targetUrl.includes('?');
    targetUrl = targetUrl + (hasQuery ? '&' : '?') + `clientId=${encodeURIComponent(clientId)}`;
  } catch (e) {
    console.warn('URL parsing failed', e);
  }

  // 2. Redundant: Set a client-side cookie so that direct browser clicks (downloads, etc.) get isolated too
  try {
    document.cookie = `clientId=${clientId}; path=/; max-age=31536000; SameSite=Lax`;
  } catch (e) {
    console.warn('Failed to write client-side cookie', e);
  }

  // 3. Redundant: Set custom header as a standard plain object
  const headers: Record<string, string> = {};
  if (options.headers) {
    if (options.headers instanceof Headers) {
      options.headers.forEach((value, key) => {
        headers[key] = value;
      });
    } else if (Array.isArray(options.headers)) {
      options.headers.forEach(([key, value]) => {
        headers[key] = value;
      });
    } else {
      Object.assign(headers, options.headers);
    }
  }

  headers['X-Client-ID'] = clientId;

  return fetch(targetUrl, {
    ...options,
    headers,
  });
}
