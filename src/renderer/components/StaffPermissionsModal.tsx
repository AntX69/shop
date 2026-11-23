/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Granular Staff Permissions Management Modal (Owner Only).
 * Allows the owner to configure individual business permissions for each seller.
 */

import React, { useState, useEffect } from 'react';
import { User } from '../../shared/types.ts';
import { 
  PERMISSION_GROUPS, 
  DEFAULT_SELLER_PERMISSIONS, 
  ALL_PERMISSION_IDS,
  OWNER_ONLY_CAPABILITIES
} from '../../shared/permissions.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { 
  Shield, 
  ShieldAlert, 
  Check, 
  X, 
  CheckSquare, 
  Square, 
  RotateCcw, 
  AlertTriangle,
  Lock
} from 'lucide-react';
import { tr, trServer } from '../../shared/i18n/index.ts';

/** Permissions that touch money or hidden figures: marked so the owner notices them. */
const SENSITIVE = new Set(['sales.discount', 'debts.correct', 'reports.profit', 'reports.financial', 'expenses.manage', 'products.prices']);

interface StaffPermissionsModalProps {
  user: User;
  onClose: () => void;
  onSaved: () => void;
}

export const StaffPermissionsModal: React.FC<StaffPermissionsModalProps> = ({
  user,
  onClose,
  onSaved
}) => {
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(new Set());
  const [initialPermissions, setInitialPermissions] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [successMsg, setSuccessMsg] = useState<string>('');

  useEffect(() => {
    const fetchPermissions = async () => {
      try {
        setLoading(true);
        setError('');
        const perms = await invokeIpc<string[]>('auth:getUserPermissions', { userId: user.id });
        const set = new Set(perms || []);
        setSelectedPermissions(set);
        setInitialPermissions(new Set(set));
      } catch (err: any) {
        setError(trServer(err.message) || tr('უფლებების ჩატვირთვა ვერ მოხერხდა'));
      } finally {
        setLoading(false);
      }
    };
    fetchPermissions();
  }, [user.id]);

  const isDirty = (() => {
    if (selectedPermissions.size !== initialPermissions.size) return true;
    for (const p of selectedPermissions) {
      if (!initialPermissions.has(p)) return true;
    }
    return false;
  })();

  const handleToggle = (permId: string) => {
    setSelectedPermissions(prev => {
      const next = new Set(prev);
      if (next.has(permId)) {
        next.delete(permId);
      } else {
        next.add(permId);
      }
      return next;
    });
  };

  const handleToggleGroup = (groupId: string, selectAll: boolean) => {
    const group = PERMISSION_GROUPS.find(g => g.id === groupId);
    if (!group) return;
    setSelectedPermissions(prev => {
      const next = new Set(prev);
      group.permissions.forEach(p => {
        if (selectAll) {
          next.add(p.id);
        } else {
          next.delete(p.id);
        }
      });
      return next;
    });
  };

  const handleSelectAll = () => {
    setSelectedPermissions(new Set(ALL_PERMISSION_IDS));
  };

  const handleDeselectAll = () => {
    setSelectedPermissions(new Set());
  };

  const handleResetDefaults = () => {
    setSelectedPermissions(new Set(DEFAULT_SELLER_PERMISSIONS));
  };

  const handleClose = () => {
    if (isDirty) {
      if (!confirm(tr('გაქვთ შეუნახავი ცვლილებები. ნამდვილად გსურთ ფანჯრის დახურვა?'))) {
        return;
      }
    }
    onClose();
  };

  const handleSave = async () => {
    try {
      setSaving(true);
      setError('');
      setSuccessMsg('');

      const permsArray = Array.from(selectedPermissions);
      await invokeIpc('auth:setUserPermissions', {
        userId: user.id,
        permissions: permsArray
      });

      setSuccessMsg(tr('უფლებები წარმატებით შეინახა'));
      setInitialPermissions(new Set(selectedPermissions));
      setTimeout(() => {
        onSaved();
      }, 700);
    } catch (err: any) {
      setError(trServer(err.message) || tr('უფლებების შენახვა ვერ მოხერხდა'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/80 backdrop-blur-sm animate-fadeIn">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-3xl flex flex-col max-h-[92vh] shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60 shrink-0">
          <div className="flex items-center space-x-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-950/80 border border-emerald-800/60 flex items-center justify-center text-emerald-400">
              <Shield className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-base sm:text-lg font-bold text-white flex items-center gap-2">
                <span>{tr('უფლებების მართვა:')}</span>
                <span className="text-emerald-400">{user.name}</span>
              </h2>
              <p className="text-xs text-slate-400">{tr('ინდივიდუალური წვდომები და შეზღუდვები გამყიდველისთვის')}</p>
            </div>
          </div>
          <button
            onClick={handleClose}
            className="p-2 text-slate-400 hover:text-white hover:bg-slate-800 rounded-xl transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Global Toolbar */}
        <div className="px-4 py-3 bg-slate-950/40 border-b border-slate-800/80 flex flex-wrap items-center justify-between gap-2 shrink-0">
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={handleSelectAll}
              className="px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors flex items-center space-x-1.5 cursor-pointer"
            >
              <CheckSquare className="w-3.5 h-3.5 text-emerald-400" />
              <span>{tr('ყველას მონიშვნა')}</span>
            </button>
            <button
              type="button"
              onClick={handleDeselectAll}
              className="px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors flex items-center space-x-1.5 cursor-pointer"
            >
              <Square className="w-3.5 h-3.5 text-slate-400" />
              <span>{tr('ყველას გაუქმება')}</span>
            </button>
            <button
              type="button"
              onClick={handleResetDefaults}
              className="px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors flex items-center space-x-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5 text-blue-400" />
              <span>{tr('ნაგულისხმევი')}</span>
            </button>
          </div>

          <div className="text-xs font-medium text-slate-400">{tr('არჩეულია:')}{' '}<span className="text-emerald-400 font-bold">{selectedPermissions.size}</span> / {ALL_PERMISSION_IDS.length}
          </div>
        </div>

        {/* Feedback messages */}
        {error && (
          <div className="mx-4 mt-3 p-3 bg-red-950/60 border border-red-800/60 text-red-200 text-xs rounded-xl flex items-center space-x-2 shrink-0">
            <AlertTriangle className="w-4 h-4 text-red-400 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {successMsg && (
          <div className="mx-4 mt-3 p-3 bg-emerald-950/60 border border-emerald-800/60 text-emerald-200 text-xs rounded-xl flex items-center space-x-2 shrink-0">
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{successMsg}</span>
          </div>
        )}

        {/* Content: Grouped Permissions List */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-5 min-h-0">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400 space-y-2">
              <div className="w-7 h-7 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              <p className="text-xs">{tr('უფლებების ჩატვირთვა...')}</p>
            </div>
          ) : (
            <>
              {PERMISSION_GROUPS.map(group => {
                const groupPermIds = group.permissions.map(p => p.id);
                const selectedInGroup = groupPermIds.filter(id => selectedPermissions.has(id)).length;
                const allSelected = selectedInGroup === groupPermIds.length;
                const someSelected = selectedInGroup > 0 && !allSelected;

                return (
                  <div 
                    key={group.id}
                    className="bg-slate-950/50 border border-slate-800 rounded-xl overflow-hidden shadow-sm"
                  >
                    {/* Group Header */}
                    <div className="px-4 py-3 bg-slate-900/90 border-b border-slate-800 flex items-center justify-between">
                      <div>
                        <h3 className="text-xs sm:text-sm font-bold text-white flex items-center gap-2">
                          <span>{tr(group.title)}</span>
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-800 text-slate-400">
                            {selectedInGroup} / {group.permissions.length}
                          </span>
                        </h3>
                        <p className="text-[11px] text-slate-400 mt-0.5">{tr(group.description)}</p>
                      </div>

                      <div className="flex items-center space-x-2">
                        <button
                          type="button"
                          onClick={() => handleToggleGroup(group.id, !allSelected)}
                          className="text-[11px] font-medium text-emerald-400 hover:text-emerald-300 hover:underline cursor-pointer"
                        >
                          {allSelected ? tr('ყველას გაუქმება') : tr('ყველას მონიშვნა')}
                        </button>
                      </div>
                    </div>

                    {/* Group Permissions Grid */}
                    <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-2.5">
                      {group.permissions.map(perm => {
                        const isChecked = selectedPermissions.has(perm.id);
                        return (
                          <label
                            key={perm.id}
                            className={`flex items-start space-x-3 p-2.5 rounded-xl border transition-all cursor-pointer ${
                              isChecked 
                                ? 'bg-emerald-950/20 border-emerald-800/40 hover:bg-emerald-950/30' 
                                : 'bg-slate-900/40 border-slate-800/80 hover:bg-slate-800/40'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={isChecked}
                              onChange={() => handleToggle(perm.id)}
                              className="mt-0.5 w-4 h-4 rounded text-emerald-600 bg-slate-800 border-slate-700 focus:ring-emerald-500 focus:ring-offset-slate-900 cursor-pointer"
                            />
                            <div className="flex-1 min-w-0">
                              <div className="text-xs font-bold text-white leading-tight flex items-center gap-1.5 flex-wrap">
                                <span>{tr(perm.name)}</span>
                                {SENSITIVE.has(perm.id) && (
                                  <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded-full bg-amber-950/70 border border-amber-800/60 text-amber-300">{tr('ფულს ეხება')}</span>
                                )}
                              </div>
                              <div className="text-[11px] text-slate-400 leading-normal mt-0.5">
                                {tr(perm.description)}
                              </div>
                            </div>
                          </label>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {/* Owner-only: shown locked, never stored for a seller */}
              <div className="bg-slate-950/50 border border-amber-800/40 rounded-xl overflow-hidden">
                <div className="px-4 py-3 bg-amber-950/20 border-b border-amber-800/40 flex items-center gap-2">
                  <Lock className="w-4 h-4 text-amber-400 shrink-0" />
                  <div>
                    <h3 className="text-xs sm:text-sm font-bold text-amber-300">{tr('მხოლოდ მფლობელი')}</h3>
                    <p className="text-[11px] text-slate-400 mt-0.5">{tr('ეს მოქმედებები გამყიდველს ვერ გადაეცემა: მათით შესაძლებელი იქნებოდა საკუთარი უფლებების გაზრდა ან მფლობელის ჩაკეტვა.')}</p>
                  </div>
                </div>
                <div className="p-3 grid grid-cols-1 md:grid-cols-2 gap-2.5">
                  {OWNER_ONLY_CAPABILITIES.map((cap) => (
                    <div key={cap.id} className="flex items-start space-x-3 p-2.5 rounded-xl border border-slate-800/80 bg-slate-900/30 opacity-80">
                      <Lock className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-bold text-slate-300 leading-tight">{tr(cap.name)}</div>
                        <div className="text-[11px] text-slate-500 leading-normal mt-0.5">{tr(cap.description)}</div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-4 bg-slate-950/80 border-t border-slate-800 flex items-center justify-between shrink-0">
          <div>
            {isDirty && (
              <span className="text-xs text-amber-400 font-medium flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />{tr('გაქვთ შეუნახავი ცვლილებები')}</span>
            )}
          </div>
          
          <div className="flex items-center space-x-3">
            <button
              type="button"
              onClick={handleClose}
              disabled={saving}
              className="px-4 py-2 text-xs font-bold text-slate-400 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-xl transition-colors cursor-pointer"
            >{tr('გაუქმება')}</button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !isDirty}
              className="px-5 py-2 text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-lg shadow-emerald-950/50 flex items-center space-x-2 cursor-pointer"
            >
              {saving ? (
                <>
                  <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  <span>{tr('ინახება...')}</span>
                </>
              ) : (
                <>
                  <Check className="w-4 h-4" />
                  <span>{tr('შენახვა')}</span>
                </>
              )}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
};
