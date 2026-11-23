/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Language of this computer's StorePOS screens before anyone signs in (the sign-in and
 * first-run screens, and the program's own error windows).
 *
 * Order: the language last chosen on this computer (ui-language.json in the profile folder),
 * otherwise the language chosen in the installer (install-language.txt next to StorePOS.exe,
 * written by the installer as a Windows language id), otherwise Georgian.
 *
 * Each signed-in user has their own language stored with their account (users.ui_language).
 */

import fs from 'node:fs';
import path from 'node:path';
import { isLang, Lang, LCID_LANGUAGES } from '../shared/i18n/index.ts';

const PROFILE_FILE = 'ui-language.json';
const INSTALLER_FILE = 'install-language.txt';

let profileDir: string | null = null;
let exeDir: string | null = null;
let memory: Lang | null = null;

export function configureDeviceLanguage(dirs: { userData?: string | null; exeDir?: string | null }): void {
  profileDir = dirs.userData || null;
  exeDir = dirs.exeDir || null;
  memory = null;
}

/** Language chosen in the installer, or null (not installed with a language choice, or unreadable). */
export function installerLanguage(): Lang | null {
  if (!exeDir) return null;
  try {
    const raw = fs.readFileSync(path.join(exeDir, INSTALLER_FILE), 'utf8').replace(/^﻿/, '').trim();
    const lang = LCID_LANGUAGES[raw] ?? (isLang(raw) ? raw : undefined);
    return lang ?? null;
  } catch {
    return null;
  }
}

function savedLanguage(): Lang | null {
  if (memory) return memory;
  if (!profileDir) return null;
  try {
    const data = JSON.parse(fs.readFileSync(path.join(profileDir, PROFILE_FILE), 'utf8'));
    return isLang(data?.language) ? data.language : null;
  } catch {
    return null;
  }
}

export function getDeviceLanguage(): Lang {
  return savedLanguage() ?? installerLanguage() ?? 'ka';
}

/** Remembers the language chosen on this computer (written atomically; never fails the caller). */
export function setDeviceLanguage(language: unknown): Lang {
  if (!isLang(language)) throw new Error('ენა არასწორია');
  memory = language;
  if (profileDir) {
    try {
      fs.mkdirSync(profileDir, { recursive: true });
      const file = path.join(profileDir, PROFILE_FILE);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ language }));
      fs.renameSync(tmp, file);
    } catch (err) {
      console.warn('[StorePOS] Could not save the screen language:', (err as Error)?.message);
    }
  }
  return language;
}
