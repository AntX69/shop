/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Typed IPC Client Bridge for StorePOS Renderer.
 * Dispatches transparently via window.electronAPI in Electron desktop mode,
 * or via local /api/ipc endpoint in Web Dev mode.
 */

// The token is kept for the life of the window only (sessionStorage survives a reload,
// not an app restart; the main process forgets all sessions on restart anyway).
const TOKEN_KEY = 'storepos_session_token';

function readStoredToken(): string {
  try {
    return globalThis.sessionStorage?.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

let activeAuthToken: string = readStoredToken();

export function setClientToken(token: string): void {
  activeAuthToken = token;
  try {
    if (token) {
      globalThis.sessionStorage?.setItem(TOKEN_KEY, token);
    } else {
      globalThis.sessionStorage?.removeItem(TOKEN_KEY);
    }
    // Tokens written by earlier versions to persistent storage are removed.
    globalThis.localStorage?.removeItem(TOKEN_KEY);
  } catch {
    // Storage unavailable (tests, locked-down profile): the in-memory token still works.
  }
}

export function getClientToken(): string {
  return activeAuthToken;
}

export async function invokeIpc<T = any>(channel: string, payload?: any): Promise<T> {
  const token = activeAuthToken;

  // Check if running in Electron environment
  if (typeof window !== 'undefined' && (window as any).electronAPI?.invoke) {
    const res = await (window as any).electronAPI.invoke(channel, payload, token);
    if (!res.success) {
      throw new Error(res.error || 'მოთხოვნა ვერ შესრულდა');
    }
    return res.data as T;
  }

  // Fallback to local server API (Express server in web mode)
  const response = await fetch('/api/ipc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel,
      payload,
      token,
    }),
  });

  if (!response.ok) {
    throw new Error(`სერვერის შეცდომა (${response.status})`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(result.error || 'მოთხოვნა ვერ შესრულდა');
  }

  return result.data as T;
}
