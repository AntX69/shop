/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Backups for a seller the owner allowed to make them ("backups.create"): make a backup now and
 * see the list. Restoring, folders and backup settings stay on the owner's settings screen.
 */

import React, { useEffect, useState } from 'react';
import { BackupInfo, User } from '../../shared/types.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { DatabaseBackup, CheckCircle2, AlertCircle } from 'lucide-react';
import { tr, trServer } from '../../shared/i18n/index.ts';
import { fmtDateTime } from '../../shared/i18n/format.ts';

interface SellerBackupViewProps {
  currentUser: User;
}

export const SellerBackupView: React.FC<SellerBackupViewProps> = () => {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const load = () => {
    invokeIpc<BackupInfo[]>('backup:list')
      .then(setBackups)
      .catch((err) => setStatus({ type: 'error', text: trServer(err.message) || tr('სიის ჩატვირთვა ვერ მოხერხდა') }));
  };
  useEffect(load, []);

  const create = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const b = await invokeIpc<{ filepath: string; size_bytes: number; mirror_filepath?: string | null; mirror_error?: string | null }>('backup:create');
      const mirror = b.mirror_filepath ? tr(' ასლი ასევე ჩაიწერა: {mirror_filepath}.', { mirror_filepath: b.mirror_filepath }) : b.mirror_error ? tr(' დამატებით საქაღალდეში ჩაწერა ვერ მოხერხდა: {mirror_error}.', { mirror_error: b.mirror_error }) : '';
      setStatus({ type: b.mirror_error ? 'error' : 'success', text: tr('სარეზერვო ასლი შეიქმნა: {filepath} ({toFixed} KB).{mirror}', { filepath: b.filepath, toFixed: (b.size_bytes / 1024).toFixed(1), mirror }) });
      load();
    } catch (err: any) {
      setStatus({ type: 'error', text: trServer(err.message) || tr('სარეზერვო ასლის შექმნა ვერ მოხერხდა') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 lg:p-6 bg-slate-950">
      <div className="max-w-3xl mx-auto space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-white">{tr('სარეზერვო ასლი')}</h2>
            <p className="text-xs text-slate-400">{tr('ასლის აღდგენა და პარამეტრები მხოლოდ მფლობელს შეუძლია.')}</p>
          </div>
          <button
            type="button"
            onClick={create}
            disabled={busy}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-sm font-bold rounded-xl flex items-center gap-2 cursor-pointer"
          >
            <DatabaseBackup className="w-4 h-4" />
            {busy ? tr('იქმნება...') : tr('ასლის შექმნა ახლა')}
          </button>
        </div>

        {status && (
          <div className={`p-3 rounded-xl text-xs flex items-start gap-2 border ${status.type === 'success' ? 'bg-emerald-950/50 border-emerald-800 text-emerald-200' : 'bg-red-950/50 border-red-800 text-red-200'}`}>
            {status.type === 'success' ? <CheckCircle2 className="w-4 h-4 shrink-0" /> : <AlertCircle className="w-4 h-4 shrink-0" />}
            <span className="break-all">{status.text}</span>
          </div>
        )}

        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-slate-950 text-slate-400">
              <tr>
                <th className="py-2 px-3 text-left">{tr('ფაილი')}</th>
                <th className="py-2 px-3 text-left">{tr('თარიღი')}</th>
                <th className="py-2 px-3 text-right">{tr('ზომა')}</th>
                <th className="py-2 px-3 text-center">{tr('მთლიანობა')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {backups.length === 0 && (
                <tr><td colSpan={4} className="py-6 text-center text-slate-500">{tr('ასლები ჯერ არ არის')}</td></tr>
              )}
              {backups.map((b) => (
                <tr key={b.filename}>
                  <td className="py-2 px-3 font-mono text-slate-200 break-all">{b.filename}</td>
                  <td className="py-2 px-3 text-slate-300 whitespace-nowrap">{fmtDateTime(b.created_at)}</td>
                  <td className="py-2 px-3 text-right text-slate-300 tabular-nums">{(b.size_bytes / 1024).toFixed(0)} KB</td>
                  <td className="py-2 px-3 text-center">{b.is_valid ? <span className="text-emerald-400">✔</span> : <span className="text-red-400">✖</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
