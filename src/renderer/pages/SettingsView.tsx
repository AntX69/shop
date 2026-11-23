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
import { tr, trServer } from '../../shared/i18n/index.ts';
import { CURRENCIES, Currency, isCurrency } from '../../shared/currency.ts';
import { currencyName, timeZoneOptions } from '../utils/shopLocale.ts';
import { fmtDateTime } from '../../shared/i18n/format.ts';

interface SettingsViewProps {
  currentUser: User;
  onStoreNameChanged: (name: string) => void;
  /** The currency or time zone was saved: amounts and dates are drawn again. */
  onShopSettingsChanged?: () => void;
}

const DEFAULT_STORE_NAME = 'ჩემი მაღაზია';

export const SettingsView: React.FC<SettingsViewProps> = ({ currentUser, onStoreNameChanged, onShopSettingsChanged }) => {
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [storeNameInput, setStoreNameInput] = useState<string>('');
  const [backupDirInput, setBackupDirInput] = useState<string>('');
  const [mirrorDirInput, setMirrorDirInput] = useState<string>('');
  const [retentionInput, setRetentionInput] = useState<string>('30');
  const [lockMinutesInput, setLockMinutesInput] = useState<string>('15');
  const [autoBackupEnabled, setAutoBackupEnabled] = useState<boolean>(true);
  const [currencyInput, setCurrencyInput] = useState<Currency>('GEL');
  const [timezoneInput, setTimezoneInput] = useState<string>('Asia/Tbilisi');
  // The currency can change only while the shop has no money records (amounts are never converted).
  const [canChangeCurrency, setCanChangeCurrency] = useState<boolean>(false);
  const [isBusy, setIsBusy] = useState<boolean>(false);
  
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
      setResetError(tr('გთხოვთ შეიყვანოთ მფლობელის PIN კოდი'));
      return;
    }
    try {
      setIsResetting(true);
      await invokeIpc('auth:resetStoreDatabase', { pin: resetPinInput.trim() });
      window.location.reload();
    } catch (err: any) {
      setResetError(trServer(err.message) || tr('ბაზის გასუფთავება უარყოფილია'));
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
      setStoreNameInput(sets.store_name && sets.store_name !== DEFAULT_STORE_NAME ? sets.store_name : tr(DEFAULT_STORE_NAME));
      setCurrencyInput(isCurrency(sets.currency) ? sets.currency : 'GEL');
      setTimezoneInput(sets.timezone || 'Asia/Tbilisi');
      invokeIpc<{ allowed: boolean }>('backup:canChangeCurrency').then((r) => setCanChangeCurrency(!!r.allowed)).catch(() => setCanChangeCurrency(false));
      setBackupDirInput(sets.backup_directory || '');
      setMirrorDirInput(sets.backup_mirror_directory || '');
      setRetentionInput(sets.backup_retention_count || '30');
      setLockMinutesInput(sets.inactivity_lock_minutes || '15');
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
          store_name: storeNameInput.trim() || tr(DEFAULT_STORE_NAME),
          currency: currencyInput,
          timezone: timezoneInput,
          backup_directory: backupDirInput.trim(),
          backup_mirror_directory: mirrorDirInput.trim(),
          backup_retention_count: retentionInput.trim() || '30',
          inactivity_lock_minutes: lockMinutesInput.trim() || '15',
          auto_backup_enabled: autoBackupEnabled ? '1' : '0'
        }
      });
      onStoreNameChanged(storeNameInput.trim());
      onShopSettingsChanged?.();
      setStatusMsg({ type: 'success', text: tr('პარამეტრები და სარეზერვო კონფიგურაცია წარმატებით შეინახა!') });
      setTimeout(() => setStatusMsg(null), 3000);
      loadData();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: trServer(err.message) || tr('შენახვის შეცდომა') });
    }
  };

  const handleExportBackup = async () => {
    try {
      setIsBusy(true);
      const backup = await invokeIpc<{
        backup_filename: string;
        filepath: string;
        size_bytes: number;
        checksum_sha256: string;
        mirror_filepath?: string | null;
        mirror_error?: string | null;
      }>('backup:create');
      const mirror = backup.mirror_filepath
        ? tr(' ასლი ასევე ჩაიწერა: {mirror_filepath}.', { mirror_filepath: backup.mirror_filepath })
        : backup.mirror_error ? tr(' დამატებით საქაღალდეში ჩაწერა ვერ მოხერხდა: {mirror_error}.', { mirror_error: backup.mirror_error }) : '';
      setStatusMsg({
        type: backup.mirror_error ? 'error' : 'success',
        text: tr('სარეზერვო ასლი შეიქმნა: {filepath} ({toFixed} KB).{mirror}', { filepath: backup.filepath, toFixed: (backup.size_bytes / 1024).toFixed(1), mirror })
      });
      loadData();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: trServer(err.message) || tr('სარეზერვო ასლის შექმნა ვერ მოხერხდა') });
    } finally {
      setIsBusy(false);
    }
  };

  const handleRunDailyBackupNow = async () => {
    try {
      const ran = await invokeIpc<boolean>('backup:runDaily');
      if (ran) {
        setStatusMsg({ type: 'success', text: tr('დღევანდელი ავტომატური სარეზერვო ასლი შეიქმნა.') });
      } else {
        setStatusMsg({ type: 'success', text: tr('დღევანდელი ავტომატური ასლი უკვე არსებობს (ან ავტომატური რეზერვირება გამორთულია).') });
      }
      loadData();
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: trServer(err.message) || tr('ავტომატური რეზერვირების შეცდომა') });
    }
  };

  const chooseFolder = async (purpose: 'primary' | 'mirror') => {
    try {
      const res = await invokeIpc<{ path: string | null }>('backup:chooseDirectory', { purpose });
      if (res.path) (purpose === 'primary' ? setBackupDirInput : setMirrorDirInput)(res.path);
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: trServer(err.message) || tr('საქაღალდის არჩევა ვერ მოხერხდა') });
    }
  };

  const handleOpenBackupFolder = async () => {
    try {
      await invokeIpc('backup:openFolder');
    } catch (err: any) {
      setStatusMsg({ type: 'error', text: trServer(err.message) || tr('საქაღალდის გახსნა ვერ მოხერხდა') });
    }
  };

  const confirmRestore = (label: string) =>
    confirm(tr('ყურადღება! "{label}"-დან აღდგენა ჩაანაცვლებს მიმდინარე მონაცემებს.\n\nმანამდე ავტომატურად შეიქმნება მიმდინარე მდგომარეობის სარეზერვო ასლი. შეცდომის შემთხვევაში არაფერი შეიცვლება.\n\nნამდვილად გსურთ გაგრძელება?', { label }));

  const afterRestore = (res: { message?: string; cancelled?: boolean } | null) => {
    if (!res || res.cancelled) return;
    alert(trServer(res.message) || tr('ბაზა წარმატებით აღდგა. გთხოვთ ხელახლა შეხვიდეთ.'));
    window.location.reload();
  };

  const handleRestoreFromList = async (filename: string) => {
    if (!confirmRestore(filename)) return;
    try {
      setIsBusy(true);
      afterRestore(await invokeIpc<{ message: string }>('backup:restoreFromList', { filename }));
    } catch (err: any) {
      alert(trServer(err.message) || tr('აღდგენის შეცდომა'));
    } finally {
      setIsBusy(false);
    }
  };

  const handleRestoreFromFileDialog = async () => {
    if (!confirmRestore(tr('არჩეული ფაილი'))) return;
    try {
      setIsBusy(true);
      afterRestore(await invokeIpc<{ message?: string; cancelled?: boolean }>('backup:restoreFromFile'));
    } catch (err: any) {
      alert(trServer(err.message) || tr('აღდგენის შეცდომა'));
    } finally {
      setIsBusy(false);
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
          ? tr(' (პროდუქცია: {products_count}, გაყიდვები: {sales_count}, მომხმარებლები: {customers_count})', { products_count: res.stats.products_count, sales_count: res.stats.sales_count, customers_count: res.stats.customers_count })
          : '';
        alert(tr('ვალიდაცია წარმატებულია!\n\nსტატუსი: {integrity_status}{statsStr}', { integrity_status: res.integrity_status, statsStr }));
      } else {
        alert(tr('ყურადღება! ასლის შემოწმება ჩაიშალა:\n\n{integrity_status}', { integrity_status: res.integrity_status }));
      }
    } catch (err: any) {
      alert(tr('შემოწმების შეცდომა: {message}', { message: trServer(err.message) }));
    } finally {
      setVerifyingFilename(null);
    }
  };

  const handleClearErrorLogs = async () => {
    if (!confirm(tr('ნამდვილად გსურთ შეცდომების ლოგის გასუფთავება?'))) return;
    try {
      await invokeIpc('system:clearErrorLogs');
      setErrorLogs([]);
      setStatusMsg({ type: 'success', text: tr('შეცდომების ჟურნალი წარმატებით გასუფთავდა') });
    } catch (err: any) {
      alert(trServer(err.message) || tr('შეცდომა'));
    }
  };

  const handleImportBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!confirmRestore(file.name)) {
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
        alert(trServer(res?.message) || tr('ბაზა წარმატებით აღდგა! გვერდი გადაიტვირთება.'));
        window.location.reload();
      } catch (err: any) {
        alert(trServer(err.message) || tr('აღდგენის შეცდომა'));
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
            <span>{tr('პარამეტრები, საიმედო რეზერვირება და დიაგნოსტიკა')}</span>
          </h1>
          <p className="text-[11px] lg:text-xs text-slate-400 mt-0.5">{tr('მონაცემთა ბაზის მთლიანობა, ფოტოების შენარჩუნება, ავტომატური რეზერვირება და უსაფრთხო აღდგენა')}</p>
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
              <span>{tr('მაღაზიის პარამეტრები და ლოკაცია')}</span>
            </h2>

            <form onSubmit={handleSaveSettings} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">{tr('მაღაზიის სახელი')}</label>
                <input
                  type="text"
                  value={storeNameInput}
                  onChange={(e) => setStoreNameInput(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <label htmlFor="settings-currency" className="block text-slate-400 mb-1">{tr('ვალუტა')}</label>
                  <select
                    id="settings-currency"
                    data-testid="settings-currency"
                    value={currencyInput}
                    disabled={!canChangeCurrency}
                    onChange={(e) => setCurrencyInput(e.target.value as Currency)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white font-bold focus:border-emerald-500 focus:outline-none disabled:opacity-70 disabled:cursor-not-allowed"
                  >
                    {CURRENCIES.map((c) => <option key={c} value={c}>{currencyName(c)}</option>)}
                  </select>
                </div>
                <div>
                  <label htmlFor="settings-timezone" className="block text-slate-400 mb-1">{tr('დროის სარტყელი')}</label>
                  <select
                    id="settings-timezone"
                    data-testid="settings-timezone"
                    value={timezoneInput}
                    onChange={(e) => setTimezoneInput(e.target.value)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white font-mono focus:border-emerald-500 focus:outline-none"
                  >
                    {timeZoneOptions(timezoneInput).map((z) => <option key={z} value={z}>{z}</option>)}
                  </select>
                </div>
              </div>
              <p className="text-[11px] text-slate-400" data-testid="currency-note">
                {canChangeCurrency
                  ? tr('ვალუტის შეცვლა შესაძლებელია, სანამ მაღაზიას გაყიდვა, მარაგის მიღება, ხარჯი ან ნისიის ჩანაწერი არ აქვს. თანხები არ გადაიყვანება.')
                  : tr('მაღაზიას უკვე აქვს ფულადი ჩანაწერები, ამიტომ ვალუტა აღარ იცვლება: თანხები არ გადაიყვანება.')}
              </p>

              {/* Backup Directory & Automation */}
              <div className="pt-2 border-t border-slate-800/80 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center space-x-1.5">
                    <Folder className="w-3.5 h-3.5 text-amber-400" />
                    <span>{tr('სარეზერვო საქაღალდე (HDD / SSD / USB)')}</span>
                  </label>
                  <div className="flex gap-1.5">
                    <div className="flex-1 min-w-0 px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white font-mono text-[11px] truncate" title={backupDirInput || tr('ნაგულისხმევი (პროგრამის მონაცემების საქაღალდე)')}>
                      {backupDirInput || tr('ნაგულისხმევი (პროგრამის მონაცემების საქაღალდე)')}
                    </div>
                    <button type="button" onClick={() => chooseFolder('primary')} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-[11px] font-bold cursor-pointer">{tr('შეცვლა')}</button>
                    {backupDirInput && (
                      <button type="button" onClick={() => setBackupDirInput('')} className="px-2 py-2 text-slate-400 hover:text-white text-[11px] cursor-pointer" title={tr('ნაგულისხმევზე დაბრუნება')}>✕</button>
                    )}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1 flex items-center space-x-1.5">
                    <Folder className="w-3.5 h-3.5 text-cyan-400" />
                    <span>{tr('დამატებითი ასლი (მაგ. USB დისკი) — სურვილისამებრ')}</span>
                  </label>
                  <div className="flex gap-1.5">
                    <div className="flex-1 min-w-0 px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white font-mono text-[11px] truncate" title={mirrorDirInput || tr('არ არის არჩეული')}>
                      {mirrorDirInput || tr('არ არის არჩეული')}
                    </div>
                    <button type="button" onClick={() => chooseFolder('mirror')} className="px-3 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-[11px] font-bold cursor-pointer">{tr('არჩევა')}</button>
                    {mirrorDirInput && (
                      <button type="button" onClick={() => setMirrorDirInput('')} className="px-2 py-2 text-slate-400 hover:text-white text-[11px] cursor-pointer" title={tr('მოხსნა')}>✕</button>
                    )}
                  </div>
                  <p className="text-[10px] text-slate-500 mt-1">{tr('ყოველი ასლი იქაც ჩაიწერება. თუ დისკი შეერთებული არ არის, მთავარი ასლი მაინც შეიქმნება და შეცდომა ჟურნალში ჩაიწერება.')}</p>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-300 mb-1">{tr('შესანახი ავტომატური ასლები')}</label>
                    <input value={retentionInput} onChange={(e) => setRetentionInput(e.target.value.replace(/\D/g, ''))} inputMode="numeric"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs focus:border-emerald-500 focus:outline-none" />
                    <p className="text-[10px] text-slate-500 mt-1">{tr('ძველი ავტომატური ასლები იშლება (3–365); ხელით შექმნილი რჩება.')}</p>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-300 mb-1">{tr('ავტო-ჩაკეტვა (წუთი)')}</label>
                    <input value={lockMinutesInput} onChange={(e) => setLockMinutesInput(e.target.value.replace(/\D/g, ''))} inputMode="numeric"
                      className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs focus:border-emerald-500 focus:outline-none" />
                    <p className="text-[10px] text-slate-500 mt-1">{tr('უმოქმედობისას სესია იხურება (1–240).')}</p>
                  </div>
                </div>

                <div className="flex items-center justify-between p-3 bg-slate-950 border border-slate-800 rounded-xl">
                  <div>
                    <span className="text-xs font-semibold text-slate-200 block">{tr('ავტომატური დღიური რეზერვირება')}</span>
                    <span className="text-[10px] text-slate-400">{tr('დღეში ერთხელ, ავტომატურად, სანამ პროგრამა ჩართულია')}</span>
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
              >{tr('პარამეტრების შენახვა')}</button>
            </form>
          </div>

          {/* Backup & Restore Card */}
          <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 shadow-xl space-y-4">
            <h2 className="text-sm font-bold text-white flex items-center space-x-2">
              <Database className="w-4 h-4 text-emerald-400" />
              <span>{tr('ერთიანი სარეზერვო ასლი (.posbackup)')}</span>
            </h2>

            <p className="text-xs text-slate-400 leading-relaxed">{tr('ერთი ფაილი შეიცავს მონაცემთა ბაზას, პროდუქციის ფოტოებს და პარამეტრებს, SHA-256 შემოწმებით. აღდგენამდე ფაილი სრულად მოწმდება; შეცდომისას მიმდინარე მონაცემები უცვლელი რჩება.')}</p>

            <div className="p-3 rounded-xl bg-slate-950 border border-slate-800 text-[11px] space-y-1.5">
              <div className="flex justify-between text-slate-400">
                <span>{tr('მთლიანობის შემოწმება:')}</span>
                <span className="text-emerald-400 font-semibold flex items-center space-x-1">
                  <ShieldCheck className="w-3.5 h-3.5 inline" />
                  <span>SHA-256 + SQLite Integrity Check</span>
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>{tr('აღდგენამდე:')}</span>
                <span className="text-slate-300">{tr('მიმდინარე მდგომარეობის ასლი ავტომატურად')}</span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>{tr('ბოლო ასლის თარიღი:')}</span>
                <span className="text-slate-300 font-mono">
                  {settings.last_backup_date ? fmtDateTime(settings.last_backup_date) : tr('არ ფიქსირდება')}
                </span>
              </div>
              <div className="flex justify-between text-slate-400">
                <span>{tr('ბოლო ავტომატური ასლი:')}</span>
                <span className="text-slate-300 font-mono">{settings.last_auto_backup_date || tr('ჯერ არ შექმნილა')}</span>
              </div>
            </div>

            <div className="space-y-2">
              <button
                onClick={handleExportBackup}
                disabled={isBusy}
                className="w-full py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition-colors shadow-lg shadow-emerald-900/30 cursor-pointer"
              >
                <Download className="w-4 h-4" />
                <span>{isBusy ? tr('მიმდინარეობს...') : tr('სარეზერვო ასლის შექმნა ახლავე')}</span>
              </button>

              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={handleOpenBackupFolder}
                  className="py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs flex items-center justify-center space-x-1.5 cursor-pointer"
                >
                  <Folder className="w-3.5 h-3.5 text-amber-400" />
                  <span>{tr('საქაღალდის გახსნა')}</span>
                </button>
                <button
                  onClick={handleRestoreFromFileDialog}
                  disabled={isBusy}
                  className="py-2.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 font-bold rounded-xl text-xs flex items-center justify-center space-x-1.5 cursor-pointer"
                >
                  <Upload className="w-3.5 h-3.5 text-emerald-400" />
                  <span>{tr('ფაილიდან აღდგენა…')}</span>
                </button>
              </div>

              <button
                onClick={handleRunDailyBackupNow}
                className="w-full py-2.5 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition-colors cursor-pointer"
              >
                <Play className="w-3.5 h-3.5 text-amber-400" />
                <span>{tr('დღიური რეზერვირების შემოწმება ახლავე')}</span>
              </button>

              <label className="w-full py-3 bg-slate-950 hover:bg-slate-800 border border-slate-700 text-slate-300 font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition-colors cursor-pointer block text-center">
                <Upload className="w-4 h-4 inline mr-1 text-emerald-400" />
                <span>{tr('ასლის ატვირთვა და აღდგენა (.posbackup)')}</span>
                <input
                  type="file"
                  accept=".posbackup,application/json"
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
                <span>{tr('სისტემის გასუფთავება (Danger Zone)')}</span>
              </h2>
              <p className="text-xs text-slate-400 leading-relaxed">{tr('ყველა პროდუქტის, გაყიდვის, ნისიისა და მომხმარებლის წაშლა. ოპერაციის წინ')}{' '}<strong className="text-slate-200">{tr('სისტემა ავტომატურად ქმნის საგანგებო ასლს')}</strong>{' '}{tr('(Emergency Pre-Reset Snapshot), რათა შეცდომის შემთხვევაში მონაცემები არ დაიკარგოს.')}</p>
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
                <span>{tr('მონაცემთა ბაზის გასუფთავება')}</span>
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
                <span>{tr('ასლები ({length})', { length: backupsList.length })}</span>
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
                <span>{tr('აუდიტი ({length})', { length: auditLogs.length })}</span>
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
                <span>{tr('შეცდომები ({length})', { length: errorLogs.length })}</span>
              </button>
            </div>

            <div className="flex items-center space-x-2">
              {rightTab === 'errors' && errorLogs.length > 0 && (
                <button
                  onClick={handleClearErrorLogs}
                  className="px-2.5 py-1 bg-red-950/60 hover:bg-red-900 text-red-300 border border-red-800 rounded-lg text-xs font-semibold flex items-center space-x-1 cursor-pointer"
                  title={tr('შეცდომების გასუფთავება')}
                >
                  <Trash2 className="w-3 h-3" />
                  <span>{tr('გასუფთავება')}</span>
                </button>
              )}
              <button
                onClick={loadData}
                className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg cursor-pointer"
                title={tr('განახლება')}
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
                    <th className="py-2.5 px-3">{tr('ფაილი / თარიღი')}</th>
                    <th className="py-2.5 px-3">{tr('ზომა')}</th>
                    <th className="py-2.5 px-3">{tr('შინაარსი')}</th>
                    <th className="py-2.5 px-3">{tr('მთლიანობა')}</th>
                    <th className="py-2.5 px-3 text-right">{tr('მოქმედება')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {backupsList.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="py-12 text-center text-slate-500">
                        <Archive className="w-8 h-8 mx-auto mb-2 text-slate-600 opacity-60" />
                        <span>{tr('სარეზერვო ასლები არ მოიძებნა მითითებულ საქაღალდეში')}</span>
                        <div className="text-[11px] text-slate-600 mt-1">{tr('დააჭირეთ „ერთიანი ასლის შექმნა“-ს პირველი ასლის შესაქმნელად')}</div>
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
                            {fmtDateTime(bk.created_at)}
                            {bk.kind && (
                              <span className="ml-1.5 text-slate-400">
                                • {bk.kind === 'auto' ? tr('ავტომატური') : bk.kind === 'manual' ? tr('ხელით') : bk.kind === 'prereset' ? tr('განულებამდე') : tr('აღდგენამდე')}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="py-2.5 px-3 font-mono text-slate-300 whitespace-nowrap">
                          {(bk.size_bytes / 1024).toFixed(1)} KB
                        </td>
                        <td className="py-2.5 px-3 text-slate-400 text-[11px]">
                          {bk.stats ? (
                            <span>{tr('პროდ: {products_count} | გაყ: {sales_count}', { products_count: bk.stats.products_count, sales_count: bk.stats.sales_count })}</span>
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
                            {verifyingFilename === bk.filename ? tr('მოწმდება...') : tr('შემოწმება')}
                          </button>
                          <button
                            onClick={() => handleRestoreFromList(bk.filename)}
                            disabled={isBusy || !bk.is_valid}
                            className="ml-1.5 px-2 py-1 bg-amber-950/50 hover:bg-amber-900/50 disabled:opacity-40 text-amber-200 text-[11px] font-semibold rounded-lg border border-amber-800/60 transition cursor-pointer"
                          >{tr('აღდგენა')}</button>
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
                    <th className="py-2.5 px-3">{tr('თარიღი')}</th>
                    <th className="py-2.5 px-3">{tr('მოქმედება')}</th>
                    <th className="py-2.5 px-3">{tr('დეტალები')}</th>
                    <th className="py-2.5 px-3">{tr('ავტორი')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60">
                  {auditLogs.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-slate-500">{tr('აუდიტის ჩანაწერები არ არის')}</td>
                    </tr>
                  ) : (
                    auditLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-900/40">
                        <td className="py-2.5 px-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                          {fmtDateTime(log.created_at)}
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
                  <div className="text-sm font-bold text-white">{tr('სისტემური შეცდომები არ ფიქსირდება')}</div>
                  <div className="text-xs text-slate-500 mt-1">{tr('ყველა ოპერაცია და ტრანზაქცია მუშაობს გამართულად')}</div>
                </div>
              ) : (
                <table className="w-full text-left text-xs min-w-[560px]">
                  <thead className="bg-slate-900 text-slate-400 sticky top-0 border-b border-slate-800">
                    <tr>
                      <th className="py-2.5 px-3">{tr('თარიღი')}</th>
                      <th className="py-2.5 px-3">{tr('სიმძიმე')}</th>
                      <th className="py-2.5 px-3">{tr('წყარო')}</th>
                      <th className="py-2.5 px-3">{tr('შეტყობინება')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/60">
                    {errorLogs.map((err) => (
                      <tr key={err.id} className="hover:bg-slate-900/40">
                        <td className="py-2.5 px-3 font-mono text-[11px] text-slate-400 whitespace-nowrap">
                          {fmtDateTime(err.created_at)}
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
                          <div className="font-semibold text-rose-300">{trServer(err.error_message)}</div>
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
                <h3 className="text-base font-bold text-white">{tr('ბაზის სრული გასუფთავება')}</h3>
                <p className="text-xs text-red-300">{tr('ოპერაციის წინ შეიქმნება Emergency Backup')}</p>
              </div>
            </div>

            <div className="p-4 sm:p-5 overflow-y-auto flex-1 min-h-0 space-y-3">
              <p className="text-xs text-slate-300 leading-relaxed bg-red-950/40 p-3 rounded-xl border border-red-900/60">{tr('ყურადღება! ყველა მონაცემი: პროდუქცია, ნაშთები, გაყიდვები, ნისიები და მომხმარებლები წაიშლება. უსაფრთხოების მიზნით სისტემა ჯერ ავტომატურად შეინახავს ბაზის ასლს. გასაგრძელებლად შეიყვანეთ მფლობელის PIN კოდი:')}</p>

              {resetError && (
                <div className="p-3 bg-red-950/80 border border-red-700 rounded-xl text-xs text-red-200 flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
                  <span>{resetError}</span>
                </div>
              )}

              <form id="reset-db-form" onSubmit={handleResetDatabase} className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">{tr('მფლობელის PIN კოდი')}</label>
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
              >{tr('გაუქმება')}</button>
              <button
                type="submit"
                form="reset-db-form"
                disabled={isResetting || !resetPinInput}
                className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-bold rounded-xl text-xs flex items-center justify-center space-x-2 transition cursor-pointer"
              >
                {isResetting ? (
                  <span>{tr('იშლება...')}</span>
                ) : (
                  <>
                    <Trash2 className="w-4 h-4" />
                    <span>{tr('წაშლა და გასუფთავება')}</span>
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
