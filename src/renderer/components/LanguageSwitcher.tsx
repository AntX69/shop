/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Language choice, always in the header and on the sign-in screen. The list shows each language
 * written in itself and the label names all four, so a user who does not read the current
 * language still finds theirs. In the header it is compact (globe + KA/EN/RU/ES) so all eight
 * screen tabs keep fitting; the native list opens on click.
 */

import React from 'react';
import { Globe } from 'lucide-react';
import { getLanguage, Lang, LANGUAGES, LANGUAGE_NAMES } from '../../shared/i18n/index.ts';

const LABEL = 'ენა / Language / Язык / Idioma';

interface LanguageSwitcherProps {
  onChange: (lang: Lang) => void;
  /** Show the language's full name (sign-in screen) instead of its two-letter code (header). */
  full?: boolean;
  className?: string;
}

export const LanguageSwitcher: React.FC<LanguageSwitcherProps> = ({ onChange, full = false, className = '' }) => {
  const lang = getLanguage();
  return (
    <label
      title={LABEL}
      data-testid="language-switcher-box"
      className={`relative flex items-center gap-1 px-1.5 py-1 bg-slate-800 border border-slate-700 rounded-lg text-slate-200 hover:border-emerald-600 focus-within:border-emerald-500 transition-colors cursor-pointer shrink-0 ${className}`}
    >
      <Globe className="w-3.5 h-3.5 shrink-0 text-emerald-400" aria-hidden="true" />
      <span className="text-[11px] sm:text-xs font-bold text-slate-100 leading-none" aria-hidden="true">
        {full ? LANGUAGE_NAMES[lang] : lang.toUpperCase()}
      </span>
      {/* The real control: invisible over the label, so the list is the system's own (keyboard, screen readers). */}
      <select
        aria-label={LABEL}
        data-testid="language-switcher"
        value={lang}
        onChange={(e) => onChange(e.target.value as Lang)}
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
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
