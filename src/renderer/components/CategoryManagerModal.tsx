/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Complete Category Management Modal (Feature B).
 * Allows Owner to:
 * - Create category with custom name and color (with live preview & preset palette)
 * - Rename and recolor existing categories
 * - Safely delete categories with product count verification and safe reassignment
 * - Archive and restore categories without corrupting historical transactions
 */

import React, { useState, useEffect } from 'react';
import { Category } from '../../shared/types.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { 
  Tag, 
  Plus, 
  Pencil, 
  Trash2, 
  Archive, 
  ArchiveRestore, 
  X, 
  CheckCircle, 
  AlertTriangle,
  FolderSync,
  Layers
} from 'lucide-react';

interface CategoryManagerModalProps {
  onClose: () => void;
  onChanged: () => void;
}

export const CATEGORY_PALETTE = [
  { name: 'ზურმუხტი', hex: '#10b981' },
  { name: 'ლურჯი', hex: '#3b82f6' },
  { name: 'ინდიგო', hex: '#6366f1' },
  { name: 'იისფერი', hex: '#8b5cf6' },
  { name: 'ქარვა', hex: '#f59e0b' },
  { name: 'ნარინჯისფერი', hex: '#f97316' },
  { name: 'ვარდისფერი', hex: '#f43f5e' },
  { name: 'ცისფერი', hex: '#06b6d4' },
  { name: 'ჟოლოსფერი', hex: '#ec4899' },
  { name: 'გრაფიტი', hex: '#64748b' },
];

export const CategoryManagerModal: React.FC<CategoryManagerModalProps> = ({ onClose, onChanged }) => {
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string>('');
  const [notice, setNotice] = useState<string>('');
  const [showArchived, setShowArchived] = useState<boolean>(false);

  // Create / Edit state
  const [isEditing, setIsEditing] = useState<boolean>(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [nameInput, setNameInput] = useState<string>('');
  const [colorInput, setColorInput] = useState<string>('#10b981');
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Safe delete dialog state
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null);
  const [usageInfo, setUsageInfo] = useState<{ active_products_count: number; archived_products_count: number; total: number } | null>(null);
  const [reassignTargetId, setReassignTargetId] = useState<number | ''>('');
  const [deleting, setDeleting] = useState<boolean>(false);

  const loadCategories = async () => {
    try {
      setLoading(true);
      const data = await invokeIpc<Category[]>('products:getCategories', { includeArchived: true });
      setCategories(data);
    } catch (err: any) {
      setError(err.message || 'კატეგორიების ჩატვირთვა ვერ მოხერხდა');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadCategories();
  }, []);

  const startCreate = () => {
    setIsEditing(true);
    setEditingId(null);
    setNameInput('');
    setColorInput('#10b981');
    setError('');
    setNotice('');
  };

  const startEdit = (cat: Category) => {
    setIsEditing(true);
    setEditingId(cat.id);
    setNameInput(cat.name);
    setColorInput(cat.color || '#10b981');
    setError('');
    setNotice('');
  };

  const cancelEdit = () => {
    setIsEditing(false);
    setEditingId(null);
    setNameInput('');
    setColorInput('#10b981');
  };

  const handleSaveCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!nameInput.trim()) {
      setError('კატეგორიის სახელი სავალდებულოა');
      return;
    }

    try {
      setSubmitting(true);
      setError('');
      if (editingId) {
        await invokeIpc('products:updateCategory', {
          categoryId: editingId,
          name: nameInput.trim(),
          color: colorInput
        });
        setNotice(`კატეგორია "${nameInput.trim()}" განახლებულია`);
      } else {
        await invokeIpc('products:createCategory', {
          name: nameInput.trim(),
          color: colorInput
        });
        setNotice(`ახალი კატეგორია "${nameInput.trim()}" შექმნილია`);
      }
      setIsEditing(false);
      setEditingId(null);
      setNameInput('');
      loadCategories();
      onChanged();
    } catch (err: any) {
      setError(err.message || 'შენახვა ვერ მოხერხდა');
    } finally {
      setSubmitting(false);
    }
  };

  const handleToggleArchive = async (cat: Category) => {
    const nextArchived = !cat.is_archived;
    try {
      await invokeIpc('products:setCategoryArchived', {
        categoryId: cat.id,
        isArchived: nextArchived
      });
      setNotice(nextArchived ? `კატეგორია "${cat.name}" დაარქივდა` : `კატეგორია "${cat.name}" აღდგა`);
      loadCategories();
      onChanged();
    } catch (err: any) {
      setError(err.message || 'სტატუსის შეცვლა ვერ მოხერხდა');
    }
  };

  const openDeleteDialog = async (cat: Category) => {
    setDeleteTarget(cat);
    setReassignTargetId('');
    setError('');
    try {
      const usage = await invokeIpc<{ active_products_count: number; archived_products_count: number; total: number }>('products:getCategoryUsage', { categoryId: cat.id });
      setUsageInfo(usage);
    } catch {
      setUsageInfo({ active_products_count: cat.products_count || 0, archived_products_count: cat.archived_products_count || 0, total: (cat.products_count || 0) + (cat.archived_products_count || 0) });
    }
  };

  const closeDeleteDialog = () => {
    setDeleteTarget(null);
    setUsageInfo(null);
    setReassignTargetId('');
  };

  const handleExecuteDelete = async () => {
    if (!deleteTarget) return;

    try {
      setDeleting(true);
      setError('');
      await invokeIpc('products:deleteCategory', {
        categoryId: deleteTarget.id,
        reassignToCategoryId: reassignTargetId === '' ? null : Number(reassignTargetId)
      });
      setNotice(`კატეგორია "${deleteTarget.name}" უსაფრთხოდ წაიშალა`);
      closeDeleteDialog();
      loadCategories();
      onChanged();
    } catch (err: any) {
      setError(err.message || 'კატეგორიის წაშლა ვერ მოხერხდა');
    } finally {
      setDeleting(false);
    }
  };

  const visibleCategories = categories.filter(c => showArchived ? true : !c.is_archived);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-sm animate-fade-in">
      <div className="bg-slate-900 border border-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden">
        
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 shrink-0">
          <div className="flex items-center space-x-2.5">
            <div className="w-8 h-8 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-emerald-400">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">კატეგორიების მართვა</h2>
              <p className="text-[11px] text-slate-400">პროდუქტების კატეგორიები, ფერები და უსაფრთხო არქივაცია</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800 cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Notifications */}
        {error && (
          <div className="mx-5 mt-4 p-3 bg-red-950/60 border border-red-800/60 rounded-xl text-red-300 text-xs flex items-center space-x-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        {notice && !error && (
          <div className="mx-5 mt-4 p-3 bg-emerald-950/50 border border-emerald-800/50 rounded-xl text-emerald-300 text-xs flex items-center space-x-2">
            <CheckCircle className="w-4 h-4 shrink-0" />
            <span>{notice}</span>
          </div>
        )}

        {/* Editor Form (Create or Edit) */}
        {isEditing && (
          <form onSubmit={handleSaveCategory} className="m-5 p-4 bg-slate-950 border border-slate-800 rounded-xl space-y-3.5 shrink-0">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                <Tag className="w-3.5 h-3.5" />
                {editingId ? 'კატეგორიის რედაქტირება' : 'ახალი კატეგორიის შექმნა'}
              </span>
              <button type="button" onClick={cancelEdit} className="text-slate-400 hover:text-white text-xs cursor-pointer">
                გაუქმება
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1">დასახელება *</label>
                <input
                  type="text"
                  autoFocus
                  required
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  placeholder="მაგ. ხილი და ბოსტნეული"
                  className="w-full px-3 py-2 bg-slate-900 border border-slate-700 rounded-lg text-white text-xs focus:border-emerald-500 focus:outline-none"
                  maxLength={60}
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-300 mb-1">ფერი</label>
                <div className="flex items-center space-x-2">
                  <input
                    type="color"
                    value={colorInput}
                    onChange={(e) => setColorInput(e.target.value)}
                    className="w-9 h-8 bg-transparent rounded cursor-pointer border border-slate-700"
                    title="ფერის ამომრჩევი"
                  />
                  <div className="flex-1 flex items-center gap-1 overflow-x-auto py-1">
                    {CATEGORY_PALETTE.map((c) => (
                      <button
                        key={c.hex}
                        type="button"
                        onClick={() => setColorInput(c.hex)}
                        className={`w-6 h-6 rounded-full border-2 transition-transform cursor-pointer shrink-0 ${colorInput.toLowerCase() === c.hex.toLowerCase() ? 'scale-110 border-white' : 'border-transparent hover:scale-105'}`}
                        style={{ backgroundColor: c.hex }}
                        title={c.name}
                      />
                    ))}
                  </div>
                </div>
              </div>
            </div>

            {/* Live Preview */}
            <div className="flex items-center justify-between pt-1 text-xs text-slate-400">
              <span className="flex items-center gap-2">
                ცოცხალი ხედი:
                <span 
                  className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[11px] font-bold text-white shadow-sm"
                  style={{ backgroundColor: colorInput }}
                >
                  <Tag className="w-3 h-3 mr-1" />
                  {nameInput.trim() || 'კატეგორიის ნიმუში'}
                </span>
              </span>

              <button
                type="submit"
                disabled={submitting}
                className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold cursor-pointer transition-colors"
              >
                {submitting ? 'ინახება...' : (editingId ? 'განახლება' : 'შექმნა')}
              </button>
            </div>
          </form>
        )}

        {/* Toolbar & Filter */}
        <div className="px-5 py-2.5 flex items-center justify-between border-b border-slate-800/60 bg-slate-900/50 text-xs">
          <div className="flex items-center space-x-3">
            <span className="text-slate-400 font-medium">სულ: {categories.length}</span>
            <label className="flex items-center space-x-1.5 text-slate-400 hover:text-white cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showArchived}
                onChange={(e) => setShowArchived(e.target.checked)}
                className="rounded border-slate-700 bg-slate-950 text-emerald-500 focus:ring-0"
              />
              <span className="text-[11px]">დაარქივებულების ჩვენება</span>
            </label>
          </div>

          {!isEditing && (
            <button
              onClick={startCreate}
              className="flex items-center space-x-1 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-bold text-xs cursor-pointer transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>ახალი კატეგორია</span>
            </button>
          )}
        </div>

        {/* Categories List */}
        <div className="flex-1 overflow-y-auto p-5 space-y-2 min-h-0">
          {loading ? (
            <div className="py-12 text-center text-slate-500 text-sm">იტვირთება...</div>
          ) : visibleCategories.length === 0 ? (
            <div className="py-12 text-center text-slate-500 text-xs">კატეგორიები ვერ მოიძებნა</div>
          ) : (
            visibleCategories.map((cat) => {
              const isArchived = cat.is_archived === 1;
              return (
                <div
                  key={cat.id}
                  className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                    isArchived
                      ? 'bg-slate-950/40 border-amber-900/40 opacity-75'
                      : 'bg-slate-950 border-slate-800 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center space-x-3 min-w-0">
                    <span
                      className="w-3.5 h-3.5 rounded-full shrink-0 shadow-sm"
                      style={{ backgroundColor: cat.color || '#10b981' }}
                    />
                    <div className="min-w-0">
                      <div className="flex items-center space-x-2">
                        <span className={`text-xs font-bold truncate ${isArchived ? 'text-slate-400 line-through' : 'text-white'}`}>
                          {cat.name}
                        </span>
                        {isArchived && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-950/60 text-amber-400 border border-amber-800/40 font-semibold">
                            დაარქივებული
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        აქტიური პროდუქტი: <span className="font-semibold text-slate-300">{cat.products_count || 0}</span>
                        {(cat.archived_products_count || 0) > 0 && (
                          <span className="ml-2">
                            (დაარქივებული: <span className="font-semibold text-slate-400">{cat.archived_products_count}</span>)
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex items-center space-x-1 shrink-0 ml-3">
                    <button
                      onClick={() => startEdit(cat)}
                      className="p-1.5 text-slate-400 hover:text-emerald-400 rounded-lg hover:bg-slate-800 cursor-pointer"
                      title="რედაქტირება"
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleToggleArchive(cat)}
                      className="p-1.5 text-slate-400 hover:text-amber-400 rounded-lg hover:bg-slate-800 cursor-pointer"
                      title={isArchived ? 'აღდგენა' : 'დაარქივება'}
                    >
                      {isArchived ? <ArchiveRestore className="w-3.5 h-3.5" /> : <Archive className="w-3.5 h-3.5" />}
                    </button>
                    <button
                      onClick={() => openDeleteDialog(cat)}
                      className="p-1.5 text-slate-400 hover:text-red-400 rounded-lg hover:bg-slate-800 cursor-pointer"
                      title="უსაფრთხო წაშლა"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-slate-800 flex justify-end shrink-0 bg-slate-900">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-xl text-xs font-bold cursor-pointer"
          >
            დახურვა
          </button>
        </div>

      </div>

      {/* Safe Delete Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-60 flex items-center justify-center p-4 bg-slate-950/85 backdrop-blur-md animate-fade-in">
          <div className="bg-slate-900 border border-red-900/60 rounded-2xl w-full max-w-md p-5 space-y-4 shadow-2xl">
            <div className="flex items-center space-x-2.5 text-red-400">
              <AlertTriangle className="w-5 h-5 shrink-0" />
              <h3 className="text-sm font-bold text-white">კატეგორიის წაშლა: "{deleteTarget.name}"</h3>
            </div>

            {usageInfo && usageInfo.total > 0 ? (
              <div className="space-y-3 text-xs text-slate-300">
                <div className="p-3 bg-amber-950/40 border border-amber-800/40 rounded-xl space-y-1">
                  <div className="font-bold text-amber-300">ყურადღება! კატეგორია შეიცავს პროდუქტებს:</div>
                  <div className="text-[11px] text-slate-300">
                    აქტიური: <b>{usageInfo.active_products_count}</b> &bull; დაარქივებული: <b>{usageInfo.archived_products_count}</b> (სულ {usageInfo.total})
                  </div>
                  <p className="text-[10px] text-slate-400 pt-1">
                    წაშლისას პროდუქტები და გაყიდვების ისტორია <b>არ წაიშლება</b>.
                  </p>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold text-slate-300 mb-1">
                    სად გადავიტანოთ ეს პროდუქტები?
                  </label>
                  <select
                    value={reassignTargetId}
                    onChange={(e) => setReassignTargetId(e.target.value ? Number(e.target.value) : '')}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
                  >
                    <option value="">კატეგორიის გარეშე (ზოგადი)</option>
                    {categories
                      .filter((c) => c.id !== deleteTarget.id && !c.is_archived)
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          გადატანა: {c.name}
                        </option>
                      ))}
                  </select>
                </div>
              </div>
            ) : (
              <p className="text-xs text-slate-300">
                კატეგორია ცარიელია (პროდუქტები არ ეკუთვნის). ნამდვილად გსურთ წაშლა?
              </p>
            )}

            <div className="flex space-x-2 pt-2">
              <button
                type="button"
                onClick={closeDeleteDialog}
                disabled={deleting}
                className="flex-1 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold cursor-pointer"
              >
                გაუქმება
              </button>
              <button
                type="button"
                onClick={handleExecuteDelete}
                disabled={deleting}
                className="flex-1 py-2 bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold cursor-pointer transition-colors"
              >
                {deleting ? 'იშლება...' : 'დადასტურება და წაშლა'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
