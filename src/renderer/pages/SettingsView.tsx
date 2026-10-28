/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Settings & Backup Management View (Owner Only).
 * Implements:
 * - Store Settings (store name, currency ₾ GEL, timezone Asia/Tbilisi)
 * - One-click Database Backup Export (.db with SHA-256 checksum)
 * - Backup Restore with integrity checks
 * - System Audit Logs viewer.
 */

import React, { useState, useEffect } from 'react';
import { AuditLog, SystemErrorLog, User } from '../../shared/types.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { 
  Settings, 
  Database, 
  Download, 
  Upload, 
  ShieldCheck, 
  Clock, 
  Store, 
  CheckCircle2, 
  AlertCircle,
  AlertTriangle,
  FileText,
  Trash2,
  RefreshCw,
  Layers
} from 'lucide-react';

interface SettingsViewProps {
  currentUser: User;
  onStoreNameChanged: (name: string) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ currentUser, onStoreNameChanged }) => {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [storeNameInput, setStoreNameInput] = useState<string>('');
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [errorLogs, setErrorLogs] = useState<SystemErrorLog[]>([]);
  const [rightTab, setRightTab] = useState<'audit' | 'errors'>('audit');
  const [loading, setLoading] = useState<boolean>(true);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      const [sets, logs, errLogs] = await Promise.all([
        invokeIpc<Record<string, string>>('backup:getSettings'),
        invokeIpc<AuditLog[]>('backup:getLogs', { limit: 100 }),
        invokeIpc<SystemErrorLog[]>('system:getErrorLogs', { limit: 100 })
      ]);
      setSettings(sets);
      setStoreNameInput(sets.store_name || 'ჩემი მაღაზია');
      setAuditLogs(logs);
      setErrorLogs(errLogs);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await invokeIpc('backup:updateSettings', {
        settings: {
          store_name: storeNameInput.trim() || 'ჩემი მაღაზია'
        }
      });
      onStoreNameChanged(storeNameInput.trim());
      setStatusMsg({ type: 'success', text: 'პარამეტრები წარმატებით შეინახა!' });
      setTimeout(() => setStatusMsg(null), 3000);
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'შენახვის შეცდომა' });
    }
  };

  const handleExportBackup = async () => {
    try {
      const backup = await invokeIpc<{
        backup_filename: string;
        size_bytes: number;
        checksum_sha256: string;
        created_at: string;
        data_base64: string;
      }>('backup:create');

      // Trigger download in browser
      const byteCharacters = atob(backup.data_base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/x-sqlite3' });

      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = backup.backup_filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setStatusMsg({
        type: 'success',
        text: `სარეზერვო ასლი შეიქმნა! (${(backup.size_bytes / 1024).toFixed(1)} KB, Checksum: ${backup.checksum_sha256.substring(0, 8)}...)`
      });
      loadData();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'სარეზერვო ასლის შექმნა ვერ მოხერხდა' });
    }
  };

  const handleClearErrorLogs = async () => {
    if (!confirm('ნამდვილად გსურთ შეცდომების ლოგის გასუფთავება?')) return;
    try {
      await invokeIpc('system:clearErrorLogs');
      setErrorLogs([]);
      setStatusMsg({ type: 'success', text: 'შეცდომების ჟურნალი წარმატებით გასუფთავდა' });
    } catch (err: any) {
      alert(err.message || 'შეცდომა');
    }
  };

  const handleImportBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!confirm(`ყურადღება! "${file.name}" ფაილიდან აღდგენა ჩაანაცვლებს მიმდინარე მონაცემებს. ნამდვილად გსურთ გაგრძელება?`)) {
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const resultString = reader.result as string;
        let payloadData: string;
        if (resultString.startsWith('data:')) {
          payloadData = resultString.split(',')[1];
        } else {
          payloadData = resultString;
        }

        const res = await invokeIpc<{ success: boolean; message: string }>('backup:restore', { base64Data: payloadData });
        alert(res?.message || 'ბაზა წარმატებით აღდგა! გვერდი გადაიტვირთება.');
        window.location.reload();
      } catch (err: any) {
        alert(err.message || 'აღდგენის შეცდომა');
      }
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-4rem)] bg-slate-950 p-6 overflow-hidden select-none">
      
      {/* Top Header */}
      <div className="flex items-center justify-between mb-5">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center space-x-2">
            <Settings className="w-6 h-6 text-emerald-400" />
            <span>პარამეტრები, ერთიანი სარეზერვო ასლი (.posbackup) და დიაგნოსტიკა</span>
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">მაღაზიის კონფიგურაცია, მონაცემთა ლოკალური რეზერვირება, მთლიანობის შემოწმება და შეცდომების ჟურნალი</p>
        </div>
      </div>

      {statusMsg && (
        <div className={`mb-4 p-3 rounded-xl border text-xs flex items-center space-x-2 ${
          statusMsg.type === 'success'
            ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
            : 'bg-red-950/60 border-red-800 text-red-300'
        }`}>
          {statusMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          <span>{statusMsg.text}</span>
        </div>
      )}

      {/* Main 2-column layout */}
      <div className="flex-1 flex space-x-4 overflow-hidden">
        
        {/* Left Column: Store Settings & Backup */}
        <div className="w-5/12 space-y-4 overflow-y-auto pr-1">
          
          {/* Store Settings Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl">
            <h2 className="text-sm font-bold text-white flex items-center space-x-2 mb-4">
              <Store className="w-4 h-4 text-emerald-400" />
              <span>მაღაზიის პარამეტრები</span>
            </h2>

            <form onSubmit={handleSaveSettings} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">მაღაზიის სახელი</label>
                <input
                  type="text"
                  value={storeNameInput}
                  onChange={(e) => setStoreNameInput(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label className="block text-slate-400 mb-1">ვალუტა</label>
                  <div className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white font-mono font-bold">
                    ₾ (GEL)
                  </div>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">დროის სარტყელი</label>
                  <div className="px-3 py-2 bg-slate-950 border border-slate-800 rounded-xl text-white font-mono">
                    Asia/Tbilisi
                  </div>
                </div>
              </div>

              <button
                type="submit"
                className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-xl text-xs transition-colors cursor-pointer"
              >
                პარამეტრების შენახვა
              </button>
            </form>
          </div>

          {/* Backup & Restore Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
            <h2 className="text-sm font-bold text-white flex items-center space-x-2">
              <Database className="w-4 h-4 text-emerald-400" />
              <span>ერთიანი სარეზერვო ასლი (.posbackup)</span>
            </h2>

            <p className="text-xs text-slate-400 leading-relaxed">
              პაკეტი აერთიანებს SQLite მონაცემთა ბაზას, პროდუქციის ფოტოებს, მაღაზიის პარამეტრებს და SHA-256 ჰეშს (PRAGMA integrity_check დაცვით).
            </p>

            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-[11px] space-y-1.5">
              <div className="flex justify-between text-slate-400">
                <span>მთლიანობის შემოწმება:</span>
                <span className="text-emerald-400 font-semibold flex items-center space-x-1">
                  <ShieldCheck className="w-3.5 h-3.5 inline" />
                  <span>SHA-256 + SQLite Integrity Check</span>
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>ავტომატური აღდგენის დაცვა:</span>
                <span className="text-slate-300 font-mono">store.db.before_restore</span>
              </div>
            </div>

            <div className="space-y-2">
              <button
                onClick={handleExportBackup}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition-colors shadow-lg shadow-emerald-900/30 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>ერთიანი ასლის ჩამოტვირთვა (.posbackup)</span>
              </button>

              <label className="w-full py-3 bg-slate-950 hover:bg-slate-800 border border-slate-700 text-slate-300 font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition-colors cursor-pointer block text-center">
                <Upload className="w-4 h-4 inline mr-1 text-emerald-400" />
                <span>ასლიდან აღდგენა (.posbackup ან .db)</span>
                <input
                  type="file"
                  accept=".posbackup,.db,application/json"
                  onChange={handleImportBackup}
                  className="hidden"
                />
              </label>
            </div>
          </div>

        </div>

        {/* Right Column: Audit Logs & Error Log Viewer */}
        <div className="w-7/12 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col shadow-xl overflow-hidden p-5">
          
          {/* Tabs */}
          <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-3">
            <div className="flex items-center space-x-2">
              <button
                onClick={() => setRightTab('audit')}
                className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  rightTab === 'audit'
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                <span>აუდიტის ჟურნალი ({auditLogs.length})</span>
              </button>

              <button
                onClick={() => setRightTab('errors')}
                className={`flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  rightTab === 'errors'
                    ? 'bg-rose-600 text-white shadow-sm'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>შეცდომების ჟურნალი ({errorLogs.length})</span>
              </button>
            </div>

            <div className="flex items-center space-x-2">
              {rightTab === 'errors' && errorLogs.length > 0 && (
                <button
                  onClick={handleClearErrorLogs}
                  className="px-2.5 py-1 bg-red-950/60 hover:bg-red-900 text-red-300 border border-red-800 rounded-lg text-xs font-semibold flex items-center space-x-1 cursor-pointer"
                  title="შეცდომების გასუფთავება"
                >
                  <Trash2 className="w-3 h-3" />
                  <span>გასუფთავება</span>
                </button>
              )}
              <button
                onClick={loadData}
                className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg cursor-pointer"
                title="განახლება"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Audit Logs Table */}
          {rightTab === 'audit' && (
            <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-y-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-slate-900 text-slate-400 sticky top-0 border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-3">თარიღი</th>
                    <th className="py-2.5 px-3">მოქმედება</th>
                    <th className="py-2.5 px-3">დეტალები</th>
                    <th className="py-2.5 px-3">ავტორი</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {auditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-slate-500">
                        აუდიტის ჩანაწერები არ არის
                      </td>
                    </tr>
                  ) : (
                    auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-900/40">
                        <td className="py-2.5 px-3 font-mono text-[11px] text-slate-400">
                          {new Date(log.created_at).toLocaleString('ka-GE')}
                        </td>
                        <td className="py-2.5 px-3">
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[10px]">
                            {log.action}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-slate-200">
                          {log.details || '-'}
                        </td>
                        <td className="py-2.5 px-3 text-slate-400">
                          {log.user_name || 'System'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* System Error Logs Table */}
          {rightTab === 'errors' && (
            <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-y-auto">
              {errorLogs.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400">
                  <div className="w-12 h-12 rounded-full bg-emerald-950/60 border border-emerald-800 flex items-center justify-center text-emerald-400 mb-2">
                    <CheckCircle2 className="w-6 h-6" />
                  </div>
                  <div className="text-sm font-bold text-white">სისტემური შეცდომები არ ფიქსირდება</div>
                  <div className="text-xs text-slate-500 mt-1">ყველა ოპერაცია და ტრანზაქცია მუშაობს გამართულად</div>
                </div>
              ) : (
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-900 text-slate-400 sticky top-0 border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-3">თარიღი</th>
                      <th className="py-2.5 px-3">სიმძიმე</th>
                      <th className="py-2.5 px-3">წყარო</th>
                      <th className="py-2.5 px-3">შეტყობინება</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {errorLogs.map((err) => (
                      <tr key={err.id} className="hover:bg-slate-900/40">
                        <td className="py-2.5 px-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                          {new Date(err.created_at).toLocaleString('ka-GE')}
                        </td>
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            err.severity === 'critical'
                              ? 'bg-red-950 text-red-300 border border-red-800'
                              : err.severity === 'warning'
                              ? 'bg-amber-950 text-amber-300 border border-amber-800'
                              : 'bg-rose-950 text-rose-300 border border-rose-800'
                          }`}>
                            {err.severity.toUpperCase()}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 font-mono text-[11px] text-slate-300 whitespace-nowrap">
                          {err.error_source}
                        </td>
                        <td className="py-2.5 px-3 text-slate-200">
                          <div className="font-semibold text-rose-300">{err.error_message}</div>
                          {err.stack_trace && (
                            <div className="text-[10px] font-mono text-slate-500 truncate max-w-sm mt-0.5">
                              {err.stack_trace.split('\n')[0]}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

        </div>

      </div>

    </div>
  );
};
