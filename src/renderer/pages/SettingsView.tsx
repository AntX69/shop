/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Settings & Backup Management View (Owner Only).
 * Implements:
 * - Store Settings (store name, currency ₾ GEL, timezone Asia/Tbilisi)
 * - Configurable Backup Directory (supports internal, external, and USB drives)
 * - Automated Daily Backup (> 24h interval check)
 * - One-click Database Backup Export (.posbackup with real photos & SHA-256 integrity)
 * - Safe Backup Restoration with PRAGMA integrity check & pre-restore safety snapshot
 * - Backups History Table with integrity verification
 * - System Audit Logs & Sensitive-Data-Sanitized Error Logs viewer
 * - Secure Database Reset with pre-wipe safety backup guarantee.
 */

import React, { useState, useEffect } from 'react';
import { AuditLog, SystemErrorLog, User, BackupInfo } from '../../shared/types.ts';
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
  Folder,
  HardDrive,
  Check,
  Play,
  Archive,
  Eye
} from 'lucide-react';

interface SettingsViewProps {
  currentUser: User;
  onStoreNameChanged: (name: string) => void;
}

export const SettingsView: React.FC<SettingsViewProps> = ({ currentUser, onStoreNameChanged }) => {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [storeNameInput, setStoreNameInput] = useState<string>('');
  const [backupDirInput, setBackupDirInput] = useState<string>('./data/backups');
  const [autoBackupEnabled, setAutoBackupEnabled] = useState<boolean>(true);
  
  const [backupsList, setBackupsList] = useState<BackupInfo[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [errorLogs, setErrorLogs] = useState<SystemErrorLog[]>([]);
  const [rightTab, setRightTab] = useState<'backups' | 'audit' | 'errors'>('backups');
  const [loading, setLoading] = useState<boolean>(true);
  const [statusMsg, setStatusMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Verifying / Testing Backup State
  const [verifyingFilename, setVerifyingFilename] = useState<string | null>(null);

  // Database Reset Modal (Owner Only)
  const [isResetModalOpen, setIsResetModalOpen] = useState<boolean>(false);
  const [resetPinInput, setResetPinInput] = useState<string>('');
  const [resetError, setResetError] = useState<string>('');
  const [isResetting, setIsResetting] = useState<boolean>(false);

  const handleResetDatabase = async (e: React.FormEvent) => {
    e.preventDefault();
    setResetError('');
    if (!resetPinInput.trim()) {
      setResetError('გთხოვთ შეიყვანოთ მფლობელის PIN კოდი');
      return;
    }
    try {
      setIsResetting(true);
      await invokeIpc('auth:resetStoreDatabase', { pin: resetPinInput.trim() });
      window.location.reload();
    } catch (err: any) {
      setResetError(err.message || 'ბაზის გასუფთავება უარყოფილია');
    } finally {
      setIsResetting(false);
    }
  };

  const loadData = async () => {
    try {
      setLoading(true);
      const [sets, logs, errLogs, backups] = await Promise.all([
        invokeIpc<Record<string, string>>('backup:getSettings'),
        invokeIpc<AuditLog[]>('backup:getLogs', { limit: 100 }),
        invokeIpc<SystemErrorLog[]>('system:getErrorLogs', { limit: 100 }),
        currentUser.role === 'owner' 
          ? invokeIpc<BackupInfo[]>('backup:list') 
          : Promise.resolve([])
      ]);
      setSettings(sets);
      setStoreNameInput(sets.store_name || 'ჩემი მაღაზია');
      setBackupDirInput(sets.backup_directory || './data/backups');
      setAutoBackupEnabled(sets.auto_backup_enabled !== '0');
      setAuditLogs(logs || []);
      setErrorLogs(errLogs || []);
      setBackupsList(backups || []);
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
          store_name: storeNameInput.trim() || 'ჩემი მაღაზია',
          backup_directory: backupDirInput.trim() || './data/backups',
          auto_backup_enabled: autoBackupEnabled ? '1' : '0'
        }
      });
      onStoreNameChanged(storeNameInput.trim());
      setStatusMsg({ type: 'success', text: 'პარამეტრები და სარეზერვო კონფიგურაცია წარმატებით შეინახა!' });
      setTimeout(() => setStatusMsg(null), 3000);
      loadData();
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
      }>('backup:create', { targetDir: backupDirInput.trim() });

      // Trigger download in browser
      const byteCharacters = atob(backup.data_base64);
      const byteNumbers = new Array(byteCharacters.length);
      for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
      }
      const byteArray = new Uint8Array(byteNumbers);
      const blob = new Blob([byteArray], { type: 'application/json' });

      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = backup.backup_filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setStatusMsg({
        type: 'success',
        text: `სარეზერვო ასლი წარმატებით შეიქმნა! (${(backup.size_bytes / 1024).toFixed(1)} KB, Checksum: ${backup.checksum_sha256.substring(0, 10)}...)`
      });
      loadData();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'სარეზერვო ასლის შექმნა ვერ მოხერხდა' });
    }
  };

  const handleRunDailyBackupNow = async () => {
    try {
      const ran = await invokeIpc<boolean>('backup:runDaily');
      if (ran) {
        setStatusMsg({ type: 'success', text: 'ყოველდღიური სარეზერვო ასლი წარმატებით შეიქმნა!' });
      } else {
        setStatusMsg({ type: 'success', text: 'სარეზერვო ასლი ბოლო 24 საათში უკვე შექმნილია, განახლება არ იყო საჭირო.' });
      }
      loadData();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: err.message || 'ავტომატური რეზერვირების შეცდომა' });
    }
  };

  const handleVerifyBackupItem = async (filename: string) => {
    try {
      setVerifyingFilename(filename);
      const res = await invokeIpc<{ is_valid: boolean; integrity_status: string; stats?: any }>('backup:verify', {
        filename
      });

      if (res.is_valid) {
        const statsStr = res.stats 
          ? ` (პროდუქცია: ${res.stats.products_count}, გაყიდვები: ${res.stats.sales_count}, მომხმარებლები: ${res.stats.customers_count})`
          : '';
        alert(`ვალიდაცია წარმატებულია!\n\nსტატუსი: ${res.integrity_status}${statsStr}`);
      } else {
        alert(`ყურადღება! ასლის შემოწმება ჩაიშალა:\n\n${res.integrity_status}`);
      }
    } catch (err: any) {
      alert(`შემოწმების შეცდომა: ${err.message}`);
    } finally {
      setVerifyingFilename(null);
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

    if (!confirm(`ყურადღება! "${file.name}" ფაილიდან აღდგენა ჩაანაცვლებს მიმდინარე მონაცემებს.\n\nავტომატურად შეიქმნება უსაფრთხოების ასლი (store.db.before_restore).\n\nნამდვილად გსურთ გაგრძელება?`)) {
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
    <div className="flex-1 flex flex-col h-full bg-slate-950 p-3 sm:p-4 lg:p-6 overflow-hidden min-h-0 select-none">
      
      {/* Top Header */}
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3 lg:mb-4 shrink-0">
        <div>
          <h1 className="text-lg lg:text-xl font-bold text-white flex items-center space-x-2">
            <Settings className="w-5 h-5 lg:w-6 lg:h-6 text-emerald-400" />
            <span>პარამეტრები, საიმედო რეზერვირება და დიაგნოსტიკა</span>
          </h1>
          <p className="text-[11px] lg:text-xs text-slate-400 mt-0.5">
            მონაცემთა ბაზის მთლიანობა, ფოტოების შენარჩუნება, ავტომატური რეზერვირება და უსაფრთხო აღდგენა
          </p>
        </div>
      </div>

      {statusMsg && (
        <div className={`mb-3 sm:mb-4 p-2.5 sm:p-3 rounded-xl border text-xs flex items-center space-x-2 shrink-0 ${
          statusMsg.type === 'success'
            ? 'bg-emerald-950/60 border-emerald-800 text-emerald-300'
            : 'bg-red-950/60 border-red-800 text-red-300'
        }`}>
          {statusMsg.type === 'success' ? <CheckCircle2 className="w-4 h-4" /> : <AlertCircle className="w-4 h-4" />}
          <span>{statusMsg.text}</span>
        </div>
      )}

      {/* Main 2-column layout */}
      <div className="flex-1 flex flex-col lg:flex-row gap-3 sm:gap-4 overflow-hidden min-h-0">
        
        {/* Left Column: Store Settings & Backup Configuration */}
        <div className="w-full lg:w-5/12 space-y-3 sm:space-y-4 overflow-y-auto pr-1 min-h-0 shrink-0 lg:shrink max-h-[42vh] lg:max-h-none">
          
          {/* Store Settings Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-4 sm:p-5 shadow-xl">
            <h2 className="text-xs sm:text-sm font-bold text-white flex items-center space-x-2 mb-3 sm:mb-4">
              <Store className="w-4 h-4 text-emerald-400" />
              <span>მაღაზიის პარამეტრები და ლოკაცია</span>
            </h2>

            <form onSubmit={handleSaveSettings} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">მაღაზიის სახელი</label>
                <input
                  type="text"
                  value={storeNameInput}
                  onChange={(e) => setStoreNameInput(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs focus:border-emerald-500 focus:outline-none"
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

              {/* Backup Directory & Automation */}
              <div className="pt-2 border-t border-slate-800/80 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center space-x-1.5">
                    <Folder className="w-3.5 h-3.5 text-amber-400" />
                    <span>სარეზერვო საქაღალდე (HDD / SSD / USB)</span>
                  </label>
                  <input
                    type="text"
                    value={backupDirInput}
                    onChange={(e) => setBackupDirInput(e.target.value)}
                    placeholder="./data/backups ან D:\POS_Backups"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white font-mono text-xs focus:border-emerald-500 focus:outline-none"
                  />
                  <p className="text-[10px] text-slate-500 mt-1">
                    მხარს უჭერს ლოკალურ და გარე მეხსიერების ბარათებს / USB დისკებს
                  </p>
                </div>

                <div className="flex items-center justify-between p-3 bg-slate-950 border border-slate-800 rounded-xl">
                  <div>
                    <span className="text-xs font-semibold text-slate-200 block">ავტომატური დღიური რეზერვირება</span>
                    <span className="text-[10px] text-slate-400">შემოწმება ყოველ 24 საათში პროგრამის გაშვებისას</span>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input 
                      type="checkbox" 
                      checked={autoBackupEnabled} 
                      onChange={(e) => setAutoBackupEnabled(e.target.checked)} 
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-slate-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500"></div>
                  </label>
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
              პაკეტი აერთიანებს SQLite მონაცემთა ბაზას, პროდუქციის რეალურ ფოტოებს (Binary Base64), მაღაზიის პარამეტრებს და SHA-256 ჰეშს (PRAGMA integrity_check დაცვით).
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
                <span>უსაფრთხოების სნეპშოტი:</span>
                <span className="text-slate-300 font-mono">store.db.before_restore</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>ბოლო ასლის თარიღი:</span>
                <span className="text-slate-300 font-mono">
                  {settings.last_backup_date ? new Date(settings.last_backup_date).toLocaleString('ka-GE') : 'არ ფიქსირდება'}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <button
                onClick={handleExportBackup}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition-colors shadow-lg shadow-emerald-900/30 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>ერთიანი ასლის შექმნა და ჩამოტვირთვა (.posbackup)</span>
              </button>

              <button
                onClick={handleRunDailyBackupNow}
                className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition-colors cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 text-amber-400" />
                <span>დღიური რეზერვირების შემოწმება ახლავე</span>
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

          {/* Danger Zone: Database Reset (Owner Only) */}
          {currentUser.role === 'owner' && (
            <div className="bg-slate-900 border border-red-900/40 rounded-2xl p-5 shadow-xl space-y-3">
              <h2 className="text-sm font-bold text-red-400 flex items-center space-x-2">
                <AlertTriangle className="w-4 h-4 text-red-400" />
                <span>სისტემის გასუფთავება (Danger Zone)</span>
              </h2>
              <p className="text-xs text-slate-400 leading-relaxed">
                ყველა პროდუქტის, გაყიდვის, ნისიისა და მომხმარებლის წაშლა. ოპერაციის წინ <strong className="text-slate-200">სისტემა ავტომატურად ქმნის საგანგებო ასლს</strong> (Emergency Pre-Reset Snapshot), რათა შეცდომის შემთხვევაში მონაცემები არ დაიკარგოს.
              </p>
              <button
                type="button"
                onClick={() => {
                  setResetPinInput('');
                  setResetError('');
                  setIsResetModalOpen(true);
                }}
                className="w-full py-2.5 bg-red-950/60 hover:bg-red-900 border border-red-800 text-red-300 font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition-colors cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                <span>მონაცემთა ბაზის გასუფთავება</span>
              </button>
            </div>
          )}

        </div>

        {/* Right Column: Backups History, Audit Logs & Error Log Viewer */}
        <div className="w-full lg:w-7/12 bg-slate-900 border border-slate-800 rounded-2xl flex flex-col shadow-xl overflow-hidden p-3 sm:p-5 min-h-0 flex-1">
          
          {/* Tabs */}
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-2.5 sm:pb-3 mb-3 shrink-0">
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
              <button
                onClick={() => setRightTab('backups')}
                className={`flex items-center space-x-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  rightTab === 'backups'
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Archive className="w-3.5 h-3.5" />
                <span>ასლები ({backupsList.length})</span>
              </button>

              <button
                onClick={() => setRightTab('audit')}
                className={`flex items-center space-x-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  rightTab === 'audit'
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <FileText className="w-3.5 h-3.5" />
                <span>აუდიტი ({auditLogs.length})</span>
              </button>

              <button
                onClick={() => setRightTab('errors')}
                className={`flex items-center space-x-1.5 px-2.5 sm:px-3 py-1.5 rounded-lg text-xs font-bold transition cursor-pointer ${
                  rightTab === 'errors'
                    ? 'bg-rose-600 text-white shadow-sm'
                    : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>შეცდომები ({errorLogs.length})</span>
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

          {/* Backups List Table */}
          {rightTab === 'backups' && (
            <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-x-auto overflow-y-auto min-h-0">
              <table className="w-full text-left text-xs min-w-[560px]">
                <thead className="bg-slate-900 text-slate-400 sticky top-0 border-b border-slate-800">
                  <tr>
                    <th className="py-2.5 px-3">ფაილი / თარიღი</th>
                    <th className="py-2.5 px-3">ზომა</th>
                    <th className="py-2.5 px-3">შინაარსი</th>
                    <th className="py-2.5 px-3">მთლიანობა</th>
                    <th className="py-2.5 px-3 text-right">მოქმედება</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {backupsList.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-slate-500">
                        <Archive className="w-8 h-8 mx-auto mb-2 text-slate-600 opacity-60" />
                        <span>სარეზერვო ასლები არ მოიძებნა მითითებულ საქაღალდეში</span>
                        <div className="text-[11px] text-slate-600 mt-1">დააჭირეთ „ერთიანი ასლის შექმნა“-ს პირველი ასლის შესაქმნელად</div>
                      </td>
                    </tr>
                  ) : (
                    backupsList.map((bk) => (
                      <tr key={bk.filename} className="hover:bg-slate-900/40">
                        <td className="py-2.5 px-3">
                          <div className="font-mono text-[11px] text-slate-200 font-semibold truncate max-w-xs" title={bk.filename}>
                            {bk.filename}
                          </div>
                          <div className="text-[10px] text-slate-500 mt-0.5">
                            {new Date(bk.created_at).toLocaleString('ka-GE')}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 font-mono text-slate-300 whitespace-nowrap">
                          {(bk.size_bytes / 1024).toFixed(1)} KB
                        </td>
                        <td className="py-2.5 px-3 text-slate-400 text-[11px]">
                          {bk.stats ? (
                            <span>პროდ: {bk.stats.products_count} | გაყ: {bk.stats.sales_count}</span>
                          ) : (
                            <span>-</span>
                          )}
                        </td>
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold inline-flex items-center space-x-1 ${
                            bk.is_valid
                              ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                              : 'bg-rose-950 text-rose-300 border border-rose-800'
                          }`}>
                            {bk.is_valid ? <CheckCircle2 className="w-3 h-3" /> : <AlertTriangle className="w-3 h-3" />}
                            <span>{bk.integrity_status}</span>
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right whitespace-nowrap">
                          <button
                            onClick={() => handleVerifyBackupItem(bk.filename)}
                            disabled={verifyingFilename === bk.filename}
                            className="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 text-[11px] font-semibold rounded-lg border border-slate-700 transition cursor-pointer"
                          >
                            {verifyingFilename === bk.filename ? 'მოწმდება...' : 'შემოწმება'}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}

          {/* Audit Logs Table */}
          {rightTab === 'audit' && (
            <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-x-auto overflow-y-auto min-h-0">
              <table className="w-full text-left text-xs min-w-[540px]">
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
                        <td className="py-2.5 px-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                          {new Date(log.created_at).toLocaleString('ka-GE')}
                        </td>
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300 font-mono text-[10px]">
                            {log.action}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-slate-200">
                          {log.details || '-'}
                        </td>
                        <td className="py-2.5 px-3 text-slate-400 whitespace-nowrap">
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
            <div className="flex-1 bg-slate-950 border border-slate-800 rounded-xl overflow-x-auto overflow-y-auto min-h-0">
              {errorLogs.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-center p-6 text-slate-400">
                  <div className="w-12 h-12 rounded-full bg-emerald-950/60 border border-emerald-800 flex items-center justify-center text-emerald-400 mb-2">
                    <CheckCircle2 className="w-6 h-6" />
                  </div>
                  <div className="text-sm font-bold text-white">სისტემური შეცდომები არ ფიქსირდება</div>
                  <div className="text-xs text-slate-500 mt-1">ყველა ოპერაცია და ტრანზაქცია მუშაობს გამართულად</div>
                </div>
              ) : (
                <table className="w-full text-left text-xs min-w-[560px]">
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

      {/* Database Reset Confirmation Modal */}
      {isResetModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-red-800 rounded-2xl max-w-md w-full max-h-[92vh] flex flex-col shadow-2xl overflow-hidden">
            <div className="flex items-center space-x-3 text-red-400 p-4 sm:p-5 border-b border-red-900/50 shrink-0">
              <div className="w-10 h-10 rounded-full bg-red-950 flex items-center justify-center border border-red-800 shrink-0">
                <AlertTriangle className="w-5 h-5 text-red-400" />
              </div>
              <div>
                <h3 className="text-base font-bold text-white">ბაზის სრული გასუფთავება</h3>
                <p className="text-xs text-red-300">ოპერაციის წინ შეიქმნება Emergency Backup</p>
              </div>
            </div>

            <div className="p-4 sm:p-5 overflow-y-auto flex-1 min-h-0 space-y-3">
              <p className="text-xs text-slate-300 leading-relaxed bg-red-950/40 p-3 rounded-xl border border-red-900/60">
                ყურადღება! ყველა მონაცემი: პროდუქცია, ნაშთები, გაყიდვები, ნისიები და მომხმარებლები წაიშლება. უსაფრთხოების მიზნით სისტემა ჯერ ავტომატურად შეინახავს ბაზის ასლს. გასაგრძელებლად შეიყვანეთ მფლობელის PIN კოდი:
              </p>

              {resetError && (
                <div className="p-3 bg-red-950/80 border border-red-700 rounded-xl text-xs text-red-200 flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                  <span>{resetError}</span>
                </div>
              )}

              <form id="reset-db-form" onSubmit={handleResetDatabase} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">
                    მფლობელის PIN კოდი
                  </label>
                  <input
                    type="password"
                    maxLength={6}
                    autoFocus
                    value={resetPinInput}
                    onChange={(e) => setResetPinInput(e.target.value.replace(/\D/g, ''))}
                    placeholder="••••"
                    className="w-full px-4 py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-center text-lg font-mono text-white tracking-widest focus:border-red-500 focus:outline-none"
                  />
                </div>
              </form>
            </div>

            <div className="flex space-x-3 p-4 sm:p-5 border-t border-slate-800 shrink-0 bg-slate-900/90">
              <button
                type="button"
                onClick={() => setIsResetModalOpen(false)}
                disabled={isResetting}
                className="flex-1 py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs transition cursor-pointer"
              >
                გაუქმება
              </button>
              <button
                type="submit"
                form="reset-db-form"
                disabled={isResetting || !resetPinInput}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition cursor-pointer"
              >
                {isResetting ? (
                  <span>იშლება...</span>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    <span>წაშლა და გასუფთავება</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
