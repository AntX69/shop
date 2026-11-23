/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Language choice, always in the header and on the sign-in screen. Each language is written in
 * itself and the label names all four, so a user who does not read the current language still
 * finds theirs.
 */

import React from 'react';
import { Globe } from 'lucide-react';
import { getLanguage, Lang, LANGUAGES, LANGUAGE_NAMES } from '../../shared/i18n/index.ts';

const LABEL = 'ენა / Language / Язык / Idioma';

interface LanguageSwitcherProps {
  onChange: (lang: Lang) => void;
  className?: string;
}

export const LanguageSwitcher: React.FC<LanguageSwitcherProps> = ({ onChange, className = '' }) => {
  const lang = getLanguage();
  return (
    <label
      title={LABEL}
      className={`flex items-center gap-1 px-1.5 py-1 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 hover:border-emerald-600 transition-colors cursor-pointer shrink-0 ${className}`}
    >
      <Globe className="w-3.5 h-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
      <select
        aria-label={LABEL}
        data-testid="language-switcher"
        value={lang}
        onChange={(e) => onChange(e.target.value as Lang)}
        className="bg-transparent text-[11px] sm:text-xs font-semibold text-slate-100 focus:outline-none cursor-pointer"
      >
        {LANGUAGES.map((l) => (
          <option key={l} value={l} className="bg-slate-900 text-white">
            {LANGUAGE_NAMES[l]}
          </option>
        ))}
      </select>
    </label>
  );
};
