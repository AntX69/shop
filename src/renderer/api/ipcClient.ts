/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Typed IPC Client Bridge for StorePOS Renderer.
 * Dispatches transparently via window.electronAPI in Electron desktop mode,
 * or via local /api/ipc endpoint in Web Dev mode.
 */

let activeAuthToken: string = localStorage.getItem('storepos_session_token') || '';

export function setClientToken(token: string): void {
  activeAuthToken = token;
  if (token) {
    localStorage.setItem('storepos_session_token', token);
  } else {
    localStorage.removeItem('storepos_session_token');
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
