/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * OCR diagnostics: every stage of one recognition (camera frame and the region read, grey,
 * lighting-corrected contrast, ink mask with what the segmenter found, the five model inputs and
 * the model's answers, timings and the reason for a rejection), photo import through the same
 * pipeline, and saving a labelled test sample on request. Nothing leaves this computer.
 */

import React, { useEffect, useRef } from 'react';
import type { OcrResult } from '../../shared/ocr.ts';
import type { RegionImage } from '../utils/offlineOcr.ts';
import type { Rect } from '../utils/cameraRoi.ts';
import { drawMaskWithComponents, drawRegionWithDigits, drawScaled, inputCanvas, KIND_COLOURS, KIND_LABELS, planeCanvas, strokeBox } from '../utils/ocrDiagnostics.ts';
import { FolderOpen, ImagePlus, Save } from 'lucide-react';

interface Props {
  result: OcrResult | null;
  region: RegionImage | null;
  frame: { canvas: HTMLCanvasElement; roi: Rect } | null;
  source: string;
  roundTripMs: number | null;
  expectedCode: string;
  onExpectedCode: (code: string) => void;
  onImport: () => void;
  onSave: (changeFolder: boolean) => void;
  saveNotice: string;
  busy: boolean;
}

const STATUS_TEXT: Record<OcrResult['status'], string> = {
  ok: 'კოდი ამოიცნო',
  check: 'შესამოწმებელი ციფრები',
  rejected: 'უარყოფილი',
};

function Picture({ draw, label }: { draw: (c: HTMLCanvasElement) => void; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (ref.current) draw(ref.current);
  });
  return (
    <figure className="min-w-0">
      <figcaption className="text-[10px] text-slate-400 mb-0.5">{label}</figcaption>
      <canvas ref={ref} className="w-full h-auto rounded border border-slate-700 bg-white" />
    </figure>
  );
}

/** A drawing problem in the diagnostics never takes the cash register screen down with it. */
export class OcrDiagnosticsBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };

  static getDerivedStateFromError(err: any) {
    return { error: String(err?.message || err) };
  }

  render() {
    if (this.state.error) {
      return (
        <p role="alert" className="text-[11px] text-amber-300 bg-amber-950/40 border border-amber-800/50 rounded-lg px-2.5 py-1.5">
          დიაგნოსტიკის ჩვენება ვერ მოხერხდა ({this.state.error}). ამოცნობა და სალარო ჩვეულებრივად მუშაობს.
        </p>
      );
    }
    return this.props.children;
  }
}

export const OcrDiagnosticsPanel: React.FC<Props> = ({ result, region, frame, source, roundTripMs, expectedCode, onExpectedCode, onImport, onSave, saveNotice, busy }) => {
  const d = result?.diagnostics;
  const W = 340;
  return (
    <section aria-label="OCR დიაგნოსტიკა" className="bg-slate-950 border border-sky-900/60 rounded-2xl p-3 space-y-3 text-[11px] text-slate-300">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-bold text-sky-300 uppercase tracking-wider text-[11px]">OCR დიაგნოსტიკა</span>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={onImport} disabled={busy} className="px-2.5 py-1 rounded-lg border border-slate-600 bg-slate-800 hover:bg-slate-700 text-white font-semibold flex items-center gap-1 disabled:opacity-50 cursor-pointer">
            <ImagePlus className="w-3.5 h-3.5 text-sky-300" />
            <span>ფოტოს ჩატვირთვა (JPG/PNG)</span>
          </button>
        </div>
      </div>

      {!result && <p className="text-slate-400">გადაიღეთ კადრი ან ჩატვირთეთ ფოტო: აქ გამოჩნდება დამუშავების ყველა ეტაპი.</p>}

      {result && region && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" data-testid="ocr-diag-summary">
            <div><div className="text-slate-500">სტატუსი</div><div className={`font-bold ${result.status === 'ok' ? 'text-emerald-400' : 'text-amber-400'}`}>{STATUS_TEXT[result.status]}</div></div>
            <div><div className="text-slate-500">კოდი</div><div className="font-mono font-bold text-white">{result.digits.length ? result.digits.map((x) => x.digit || '?').join('') : '—'}</div></div>
            <div><div className="text-slate-500">სანდოობა (მთლიანი კოდი)</div><div className="font-bold text-white tabular-nums">{result.confidence}%</div></div>
            <div><div className="text-slate-500">დრო</div><div className="tabular-nums text-white">{result.timings.totalMs} მს{roundTripMs !== null ? ` (სულ ${roundTripMs} მს)` : ''}</div></div>
          </div>
          {result.message && <p className="text-amber-300" data-testid="ocr-diag-reason">მიზეზი: {result.message}</p>}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {frame && (
              <Picture label={`კამერის კადრი (${frame.canvas.width}×${frame.canvas.height}) და დამუშავებული არე`} draw={(c) => {
                const s = drawScaled(c, frame.canvas, W);
                strokeBox(c.getContext('2d')!, frame.roi, s, '#22c55e');
              }} />
            )}
            <Picture label={`დამუშავებული არე (${region.width}×${region.height}): კოდი და ციფრები`} draw={(c) => drawRegionWithDigits(c, region, result, W)} />
            {d && <Picture label="ნაცრისფერი" draw={(c) => drawScaled(c, planeCanvas(d.gray, d.previewWidth, d.previewHeight), W)} />}
            {d && <Picture label="კონტრასტი (განათების კორექციით)" draw={(c) => drawScaled(c, planeCanvas(d.contrast, d.previewWidth, d.previewHeight), W)} />}
            {d && <Picture label="მელანი (ხმაურის და რვეულის ხაზების გარეშე) და ნაპოვნი ნაწილები" draw={(c) => drawMaskWithComponents(c, result, W)} />}
          </div>
          {d && (
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {(Object.keys(KIND_LABELS) as Array<keyof typeof KIND_LABELS>).map((k) => (
                <span key={k} className="flex items-center gap-1"><span className="inline-block w-3 h-3 rounded-sm border-2" style={{ borderColor: KIND_COLOURS[k] }} />{KIND_LABELS[k]}</span>
              ))}
            </div>
          )}

          {d && d.digitInputs.length > 0 && (
            <div>
              <div className="text-slate-400 mb-1">მოდელის შესასვლელი (28×28) და პასუხი თითო ციფრზე</div>
              <div className="grid grid-cols-5 gap-2" data-testid="ocr-diag-digits">
                {d.digitInputs.map((inp, i) => {
                  const g = result.digits[i];
                  return (
                    <div key={i} className={`rounded-lg border p-1 ${g?.doubtful || !g?.digit ? 'border-amber-600' : 'border-emerald-800'}`}>
                      <Picture label={`#${i + 1}${g?.split ? ' (გაყოფილი)' : ''}`} draw={(c) => {
                        const src = inputCanvas(inp);
                        c.width = src.width;
                        c.height = src.height;
                        c.getContext('2d')!.drawImage(src, 0, 0);
                      }} />
                      <div className="font-mono font-bold text-white text-center mt-0.5">{g?.digit || '?'} <span className="text-slate-400 font-normal">{g?.confidence}%</span></div>
                      <div className="font-mono text-[10px] text-slate-500 text-center">{(g?.alternatives || []).map((a) => `${a.digit}:${a.confidence}`).join(' ')}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-3 gap-y-0.5 font-mono text-[10px] text-slate-400">
            <div>წყარო: {source}</div>
            <div>ნაპოვნი სიმბოლო: {result.found}</div>
            <div>მოდელი: {result.modelUsed}</div>
            <div>შესრულდა: {result.ranOn === 'worker' ? 'ცალკე ნაკადში (worker)' : result.ranOn === 'main' ? 'მთავარ პროცესში' : '—'}</div>
            <div>წინასწარი დამუშავება: {result.timings.preprocessMs} მს</div>
            <div>სეგმენტაცია: {result.timings.segmentMs} მს</div>
            <div>კლასიფიკაცია: {result.timings.classifyMs} მს</div>
            {d && <div>ზღვარი: {d.thresholds.low} / {d.thresholds.high}</div>}
            {d && <div>მელნის დონე: {d.thresholds.ink}, ხმაური: {d.thresholds.noise}</div>}
            {d && <div>ხაზის სისქე: {d.strokeWidth} px, ციფრის სიმაღლე: {d.digitHeight} px</div>}
            {d && <div>წაშლილი ხაზის პიქსელი: {d.ruledLinePixels}</div>}
          </dl>
        </>
      )}

      <div className="flex flex-wrap items-end gap-2 border-t border-slate-800 pt-2">
        <label className="flex flex-col gap-0.5">
          <span className="text-slate-400">სწორი კოდი (ტესტისთვის, არასავალდებულო)</span>
          <input
            value={expectedCode}
            onChange={(e) => onExpectedCode(e.target.value.replace(/\D/g, '').slice(0, 5))}
            onKeyDown={(e) => e.stopPropagation()}
            inputMode="numeric"
            aria-label="სწორი კოდი ტესტისთვის"
            className="w-28 px-2 py-1 bg-slate-900 border border-slate-700 rounded-lg text-white font-mono focus:outline-none focus:border-sky-500"
          />
        </label>
        <button type="button" disabled={!result || !region || busy} onClick={() => onSave(false)} className="px-2.5 py-1.5 rounded-lg border border-sky-700 bg-sky-900/50 hover:bg-sky-800 text-white font-semibold flex items-center gap-1 disabled:opacity-40 cursor-pointer">
          <Save className="w-3.5 h-3.5" />
          <span>ნიმუშის შენახვა</span>
        </button>
        <button type="button" disabled={!result || !region || busy} onClick={() => onSave(true)} className="px-2.5 py-1.5 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-slate-300 flex items-center gap-1 disabled:opacity-40 cursor-pointer">
          <FolderOpen className="w-3.5 h-3.5" />
          <span>სხვა საქაღალდე</span>
        </button>
        {saveNotice && <span className="text-sky-300" data-testid="ocr-save-notice">{saveNotice}</span>}
      </div>
      <p className="text-[10px] text-slate-500">ფოტოები და შედეგები ინახება მხოლოდ „ნიმუშის შენახვის“ დაჭერისას, თქვენ მიერ არჩეულ საქაღალდეში. არაფერი იგზავნება ინტერნეტით.</p>
    </section>
  );
};
