/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Products & Categories Management View.
 * Allows viewing all products, categories, variants, and assigned codes.
 * Product and Category creation/modification is restricted to Owner only.
 */

import React, { useState, useEffect } from 'react';
import { Category, Product, User } from '../../shared/types.ts';
import { formatTetri, gelToTetri } from '../../shared/money.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { 
  Package, 
  Plus, 
  Search, 
  Tag, 
  Layers, 
  Barcode, 
  AlertCircle, 
  X, 
  Trash2,
  CheckCircle,
  ShoppingBag,
  Image as ImageIcon,
  Upload,
  Eye,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';

interface ProductsViewProps {
  currentUser: User;
}

export const ProductsView: React.FC<ProductsViewProps> = ({ currentUser }) => {
  const isOwner = currentUser.role === 'owner';

  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedCategory, setSelectedCategory] = useState<number | null>(null);

  // Multi-Image Gallery Modal
  const [galleryProduct, setGalleryProduct] = useState<Product | null>(null);
  const [activeImageIndex, setActiveImageIndex] = useState<number>(0);

  // New Category Modal
  const [isNewCategoryOpen, setIsNewCategoryOpen] = useState<boolean>(false);
  const [newCategoryName, setNewCategoryName] = useState<string>('');

  // New Product Modal (Owner only)
  const [isNewProductOpen, setIsNewProductOpen] = useState<boolean>(false);
  const [prodName, setProdName] = useState<string>('');
  const [prodCategory, setProdCategory] = useState<number | null>(null);
  const [prodDesc, setProdDesc] = useState<string>('');
  const [prodBasePrice, setProdBasePrice] = useState<string>('');
  const [prodBaseCost, setProdBaseCost] = useState<string>(''); // Optional purchase cost
  const [newProductImages, setNewProductImages] = useState<string[]>([]);
  
  // Variants in new product
  const [variantsList, setVariantsList] = useState<Array<{
    variant_name: string;
    size: string;
    color: string;
    price_override: string;
    cost_override: string;
    initial_stock: number;
    manual_5digit: string;
    barcode: string;
  }>>([
    {
      variant_name: 'სტანდარტული',
      size: '',
      color: '',
      price_override: '',
      cost_override: '',
      initial_stock: 5,
      manual_5digit: '',
      barcode: ''
    }
  ]);

  const [formError, setFormError] = useState<string>('');
  const [formSuccess, setFormSuccess] = useState<string>('');

  const loadData = async () => {
    try {
      setLoading(true);
      const [cats, prods] = await Promise.all([
        invokeIpc<Category[]>('products:getCategories'),
        invokeIpc<Product[]>('products:list', {
          searchTerm: searchTerm || undefined,
          categoryId: selectedCategory || undefined
        })
      ]);
      setCategories(cats);
      setProducts(prods);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, [searchTerm, selectedCategory]);

  const handleCreateCategory = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCategoryName.trim()) return;
    try {
      const created = await invokeIpc<Category>('products:createCategory', { name: newCategoryName.trim() });
      setCategories(prev => [...prev, created]);
      setNewCategoryName('');
      setIsNewCategoryOpen(false);
    } catch (err: any) {
      alert(err.message || 'კატეგორიის შექმნა ვერ მოხერხდა');
    }
  };

  const addVariantRow = () => {
    setVariantsList(prev => [
      ...prev,
      {
        variant_name: '',
        size: '',
        color: '',
        price_override: '',
        cost_override: '',
        initial_stock: 0,
        manual_5digit: '',
        barcode: ''
      }
    ]);
  };

  const removeVariantRow = (index: number) => {
    if (variantsList.length <= 1) return;
    setVariantsList(prev => prev.filter((_, i) => i !== index));
  };

  const handleCreateProductSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError('');
    setFormSuccess('');

    if (!prodName.trim()) {
      setFormError('პროდუქტის დასახელება სავალდებულოა');
      return;
    }

    let basePriceTetri = 0;
    try {
      basePriceTetri = gelToTetri(prodBasePrice);
      if (basePriceTetri <= 0) {
        setFormError('გასაყიდი ფასი უნდა აღემატებოდეს 0-ს');
        return;
      }
    } catch (err: any) {
      setFormError(err.message);
      return;
    }

    let baseCostTetri: number | null = null;
    if (prodBaseCost.trim()) {
      try {
        baseCostTetri = gelToTetri(prodBaseCost);
      } catch (err: any) {
        setFormError(`შესყიდვის ფასი: ${err.message}`);
        return;
      }
    }

    // Validate variants
    const payloadVariants: any[] = [];
    for (const [idx, v] of variantsList.entries()) {
      const vName = v.variant_name.trim() || `ვარიანტი ${idx + 1}`;
      const codes: any[] = [];

      if (!v.manual_5digit.trim() && !v.barcode.trim()) {
        setFormError(`ვარიანტისთვის "${vName}" სავალდებულოა მიუთითოთ 5-ნიშნა კოდი ან ქარხნული შტრიხკოდი`);
        return;
      }

      if (v.manual_5digit.trim()) {
        const manCode = v.manual_5digit.trim();
        if (!/^\d{5}$/.test(manCode)) {
          setFormError(`ხელით შესაყვანი კოდი უნდა იყოს ზუსტად 5-ნიშნა რიცხვი (10000-99999). ვარიანტი: "${vName}"`);
          return;
        }
        codes.push({ code_type: 'manual_5digit', code_value: manCode });
      }

      if (v.barcode.trim()) {
        const barCode = v.barcode.trim();
        if (!/^\d+$/.test(barCode)) {
          setFormError(`შტრიხკოდი უნდა შეიცავდეს მხოლოდ ციფრებს. ვარიანტი: "${vName}"`);
          return;
        }
        codes.push({ code_type: 'barcode', code_value: barCode });
      }

      let priceOverride: number | null = null;
      if (v.price_override.trim()) {
        priceOverride = gelToTetri(v.price_override);
      }

      let costOverride: number | null = null;
      if (v.cost_override.trim()) {
        costOverride = gelToTetri(v.cost_override);
      }

      payloadVariants.push({
        variant_name: vName,
        size: v.size.trim() || undefined,
        color: v.color.trim() || undefined,
        price_override_tetri: priceOverride,
        cost_override_tetri: costOverride,
        initial_stock: Math.max(0, Math.floor(v.initial_stock || 0)),
        codes
      });
    }

    try {
      await invokeIpc('products:create', {
        name: prodName.trim(),
        category_id: prodCategory || undefined,
        description: prodDesc.trim() || undefined,
        base_price_tetri: basePriceTetri,
        base_cost_tetri: baseCostTetri,
        variants: payloadVariants,
        image_paths: newProductImages.length > 0 ? newProductImages : undefined
      });

      setFormSuccess('პროდუქტი წარმატებით დაემატა!');
      setIsNewProductOpen(false);
      // Reset form
      setProdName('');
      setProdBasePrice('');
      setProdBaseCost('');
      setProdDesc('');
      setNewProductImages([]);
      setVariantsList([{
        variant_name: 'სტანდარტული',
        size: '',
        color: '',
        price_override: '',
        cost_override: '',
        initial_stock: 5,
        manual_5digit: '',
        barcode: ''
      }]);
      loadData();
    } catch (err: any) {
      setFormError(err.message || 'პროდუქტის შექმნის შეცდომა');
    }
  };

  const handleImageFileChange = (e: React.ChangeEvent<HTMLInputElement>, isGalleryModal: boolean = false) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const reader = new FileReader();
      reader.onload = async () => {
        const base64 = reader.result as string;
        if (isGalleryModal && galleryProduct) {
          try {
            await invokeIpc('products:addImage', {
              productId: galleryProduct.id,
              filePath: base64,
              isPrimary: (galleryProduct.images?.length || 0) === 0
            });
            const updated = await invokeIpc<Product>('products:getById', { productId: galleryProduct.id });
            setGalleryProduct(updated);
            loadData();
          } catch (err: any) {
            alert(err.message || 'სურათის დამატება ვერ მოხერხდა');
          }
        } else {
          setNewProductImages(prev => [...prev, base64]);
        }
      };
      reader.readAsDataURL(file);
    }
    // reset input
    e.target.value = '';
  };

  const handleDeleteGalleryImage = async (imageId: number) => {
    if (!galleryProduct) return;
    if (!window.confirm('ნამდვილად გსურთ სურათის წაშლა?')) return;
    try {
      await invokeIpc('products:deleteImage', { imageId });
      const updated = await invokeIpc<Product>('products:getById', { productId: galleryProduct.id });
      setGalleryProduct(updated);
      setActiveImageIndex(0);
      loadData();
    } catch (err: any) {
      alert(err.message || 'სურათის წაშლა ვერ მოხერხდა');
    }
  };

  return (
    <div className="flex-1 flex flex-col h-[calc(100vh-4rem)] bg-slate-950 p-6 overflow-hidden select-none">
      
      {/* Top Controls Bar */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center space-x-2">
            <Package className="w-6 h-6 text-emerald-400" />
            <span>პროდუქცია და კატალოგი</span>
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">სულ რეგისტრირებულია {products.length} პროდუქტი</p>
        </div>

        <div className="flex items-center space-x-3">
          {isOwner && (
            <>
              <button
                onClick={() => setIsNewCategoryOpen(true)}
                className="px-3.5 py-2 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-200 text-xs font-semibold rounded-xl flex items-center space-x-1.5 transition-colors cursor-pointer"
              >
                <Tag className="w-3.5 h-3.5 text-slate-400" />
                <span>+ კატეგორია</span>
              </button>

              <button
                onClick={() => {
                  setIsNewProductOpen(true);
                  setFormError('');
                }}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-xl flex items-center space-x-1.5 transition-colors shadow-lg shadow-emerald-900/40 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>ახალი პროდუქტის დამატება</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Filter and Search row */}
      <div className="flex items-center space-x-3 mb-4">
        <div className="relative flex-1">
          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="ძებნა სახელით, შტრიხკოდით ან 5-ნიშნა კოდით..."
            className="w-full pl-9 pr-4 py-2 bg-slate-900 border border-slate-800 rounded-xl text-white placeholder-slate-400 text-xs focus:outline-none focus:border-emerald-500"
          />
          <Search className="w-4 h-4 text-slate-500 absolute left-3 top-2.5" />
        </div>

        {/* Category Tabs */}
        <div className="flex items-center space-x-1 overflow-x-auto pb-1 max-w-md">
          <button
            onClick={() => setSelectedCategory(null)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
              selectedCategory === null
                ? 'bg-emerald-600 text-white font-bold'
                : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            ყველა
          </button>
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setSelectedCategory(c.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium whitespace-nowrap transition-colors ${
                selectedCategory === c.id
                  ? 'bg-emerald-600 text-white font-bold'
                  : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
      </div>

      {/* Products Table */}
      <div className="flex-1 bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden flex flex-col shadow-xl">
        <div className="overflow-y-auto flex-1">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-950/80 text-slate-400 uppercase font-semibold tracking-wider sticky top-0 border-b border-slate-800">
              <tr>
                <th className="py-3 px-4 w-16 text-center">ფოტო</th>
                <th className="py-3 px-4">პროდუქტი</th>
                <th className="py-3 px-4">კატეგორია</th>
                <th className="py-3 px-4">ვარიანტები და კოდები</th>
                <th className="py-3 px-4 text-right">გასაყიდი ფასი</th>
                {isOwner && <th className="py-3 px-4 text-right">თვითღირებულება</th>}
                <th className="py-3 px-4 text-right">მარაგი</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/60">
              {products.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <Package className="w-10 h-10 text-slate-700 mx-auto mb-2" />
                    პროდუქცია არ მოიძებნა
                  </td>
                </tr>
              ) : (
                products.map((p) => {
                  const totalStock = (p.variants || []).reduce((acc, v) => acc + v.stock_quantity, 0);
                  const hasImages = p.images && p.images.length > 0;
                  return (
                    <tr key={p.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-3 px-4 text-center">
                        {hasImages ? (
                          <button
                            type="button"
                            onClick={() => { setGalleryProduct(p); setActiveImageIndex(0); }}
                            className="relative group inline-block w-10 h-10 rounded-lg overflow-hidden border border-slate-700 bg-slate-950 hover:border-emerald-500 transition-colors cursor-pointer"
                            title="გალერეის გახსნა"
                          >
                            <img src={p.images![0].file_path} alt={p.name} className="w-full h-full object-cover" />
                            {p.images!.length > 1 && (
                              <span className="absolute bottom-0 right-0 bg-black/85 text-[9px] font-mono text-emerald-400 px-1 rounded-tl">
                                +{p.images!.length - 1}
                              </span>
                            )}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => { setGalleryProduct(p); setActiveImageIndex(0); }}
                            className="w-10 h-10 rounded-lg border border-dashed border-slate-800 hover:border-slate-600 flex items-center justify-center text-slate-600 hover:text-slate-400 transition-colors cursor-pointer mx-auto"
                            title="სურათის დამატება"
                          >
                            <ImageIcon className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                      <td className="py-3 px-4">
                        <div className="font-bold text-white text-sm">{p.name}</div>
                        {p.description && <div className="text-[11px] text-slate-400 truncate max-w-xs">{p.description}</div>}
                      </td>
                      <td className="py-3 px-4">
                        <span className="px-2 py-0.5 rounded bg-slate-800 text-slate-300 text-[11px]">
                          {p.category_name || 'ზოგადი'}
                        </span>
                      </td>
                      <td className="py-3 px-4">
                        <div className="space-y-1">
                          {p.variants?.map((v) => (
                            <div key={v.id} className="flex items-center space-x-2 text-[11px]">
                              <span className="text-slate-300 font-semibold">{v.variant_name}:</span>
                              {v.codes?.map(c => (
                                <span key={c.id} className="font-mono bg-slate-950 px-1.5 py-0.5 rounded text-emerald-400 border border-slate-800">
                                  {c.code_value} ({c.code_type === 'manual_5digit' ? '5-ნიშნა' : 'შტრიხკოდი'})
                                </span>
                              ))}
                              <span className="text-slate-400 font-medium">({v.stock_quantity} ც)</span>
                            </div>
                          ))}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right font-bold text-white text-sm">
                        {formatTetri(p.base_price_tetri)}
                      </td>
                      {isOwner && (
                        <td className="py-3 px-4 text-right text-slate-400">
                          {p.base_cost_tetri !== null && p.base_cost_tetri !== undefined ? formatTetri(p.base_cost_tetri) : <span className="italic text-slate-600">უცნობი</span>}
                        </td>
                      )}
                      <td className="py-3 px-4 text-right">
                        <span className={`px-2.5 py-1 rounded-full font-bold text-[11px] ${
                          totalStock > 5
                            ? 'bg-emerald-950/60 text-emerald-400 border border-emerald-800/40'
                            : totalStock > 0
                            ? 'bg-amber-950/60 text-amber-400 border border-amber-800/40'
                            : 'bg-red-950/60 text-red-400 border border-red-800/40'
                        }`}>
                          {totalStock} ცალი
                        </span>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* --- MODAL: Add Category --- */}
      {isNewCategoryOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full p-6 shadow-2xl">
            <h3 className="text-base font-bold text-white mb-3">ახალი კატეგორია</h3>
            <form onSubmit={handleCreateCategory} className="space-y-3">
              <input
                type="text"
                required
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="მაგ. სათამაშოები, ტანსაცმელი..."
                className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm"
              />
              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsNewCategoryOpen(false)}
                  className="flex-1 py-2 bg-slate-800 text-slate-300 rounded-xl text-xs font-bold"
                >
                  გაუქმება
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 text-white rounded-xl text-xs font-bold"
                >
                  დამატება
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: Add Product (Owner Only) --- */}
      {isNewProductOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-3xl w-full p-6 shadow-2xl max-h-[90vh] flex flex-col">
            
            <div className="flex justify-between items-center border-b border-slate-800 pb-3 mb-4">
              <h3 className="text-lg font-bold text-white">ახალი პროდუქტის რეგისტრაცია</h3>
              <button onClick={() => setIsNewProductOpen(false)} className="text-slate-400 hover:text-white">
                <X className="w-5 h-5" />
              </button>
            </div>

            {formError && (
              <div className="mb-4 p-3 bg-red-950/60 border border-red-800 rounded-xl text-red-200 text-xs flex items-center space-x-2">
                <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
                <span>{formError}</span>
              </div>
            )}

            <form onSubmit={handleCreateProductSubmit} className="flex-1 overflow-y-auto space-y-4 pr-1">
              {/* Product main details */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">დასახელება *</label>
                  <input
                    type="text"
                    required
                    value={prodName}
                    onChange={(e) => setProdName(e.target.value)}
                    placeholder="მაგ. საბავშვო კურტკა"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">კატეგორია</label>
                  <select
                    value={prodCategory || ''}
                    onChange={(e) => setProdCategory(e.target.value ? parseInt(e.target.value, 10) : null)}
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm"
                  >
                    <option value="">-- აირჩიეთ კატეგორია --</option>
                    {categories.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">გასაყიდი ფასი (₾) *</label>
                  <input
                    type="number"
                    step="0.01"
                    required
                    value={prodBasePrice}
                    onChange={(e) => setProdBasePrice(e.target.value)}
                    placeholder="25.50"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm font-bold"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1">შესყიდვის ფასი (₾, არასავალდებულო)</label>
                  <input
                    type="number"
                    step="0.01"
                    value={prodBaseCost}
                    onChange={(e) => setProdBaseCost(e.target.value)}
                    placeholder="თუ უცნობია დატოვეთ ცარიელი"
                    className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-xl text-white text-sm"
                  />
                </div>
              </div>

              {/* Product Photos / Images upload */}
              <div className="border-t border-slate-800 pt-3">
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  პროდუქტის ფოტოები (მრავალფოტოიანი გალერეა)
                </label>
                <div className="flex flex-wrap items-center gap-2">
                  {newProductImages.map((img, idx) => (
                    <div key={idx} className="relative w-14 h-14 rounded-lg overflow-hidden border border-slate-700 bg-slate-950 group">
                      <img src={img} alt="preview" className="w-full h-full object-cover" />
                      <button
                        type="button"
                        onClick={() => setNewProductImages(prev => prev.filter((_, i) => i !== idx))}
                        className="absolute top-0 right-0 bg-red-600/90 text-white p-0.5 rounded-bl hover:bg-red-700 cursor-pointer"
                        title="წაშლა"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                  <label className="w-14 h-14 rounded-lg border-2 border-dashed border-slate-700 hover:border-emerald-500 bg-slate-950/60 flex flex-col items-center justify-center text-slate-400 hover:text-emerald-400 transition cursor-pointer">
                    <Upload className="w-4 h-4 mb-0.5" />
                    <span className="text-[9px] font-medium">+ფოტო</span>
                    <input
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={(e) => handleImageFileChange(e, false)}
                      className="hidden"
                    />
                  </label>
                </div>
              </div>

              {/* Variants Section */}
              <div className="border-t border-slate-800 pt-3">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                    ვარიანტები (ზომა / ფერი) და კოდები
                  </span>
                  <button
                    type="button"
                    onClick={addVariantRow}
                    className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center space-x-1"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>+ ვარიანტის დამატება</span>
                  </button>
                </div>

                <div className="space-y-3">
                  {variantsList.map((v, i) => (
                    <div key={i} className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-semibold text-emerald-400">ვარიანტი #{i + 1}</span>
                        {variantsList.length > 1 && (
                          <button
                            type="button"
                            onClick={() => removeVariantRow(i)}
                            className="text-xs text-red-400 hover:text-red-300"
                          >
                            წაშლა
                          </button>
                        )}
                      </div>

                      <div className="grid grid-cols-4 gap-2">
                        <div>
                          <label className="block text-[11px] text-slate-400 mb-0.5">სახელი</label>
                          <input
                            type="text"
                            value={v.variant_name}
                            onChange={(e) => {
                              const updated = [...variantsList];
                              updated[i].variant_name = e.target.value;
                              setVariantsList(updated);
                            }}
                            placeholder="მაგ. შავი / 42"
                            className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] text-slate-400 mb-0.5">5-ნიშნა კოდი (მხოლოდ ხელით, 10000-99999)</label>
                          <input
                            type="text"
                            maxLength={5}
                            value={v.manual_5digit}
                            onChange={(e) => {
                              const updated = [...variantsList];
                              updated[i].manual_5digit = e.target.value.replace(/\D/g, '');
                              setVariantsList(updated);
                            }}
                            placeholder="მაგ. 10001"
                            className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs font-mono text-emerald-400"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] text-slate-400 mb-0.5">ქარხნული შტრიხკოდი</label>
                          <input
                            type="text"
                            value={v.barcode}
                            onChange={(e) => {
                              const updated = [...variantsList];
                              updated[i].barcode = e.target.value.replace(/\D/g, '');
                              setVariantsList(updated);
                            }}
                            placeholder="სკანირება / ციფრები"
                            className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs font-mono text-white"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] text-slate-400 mb-0.5">საწყისი მარაგი (ცალი)</label>
                          <input
                            type="number"
                            min="0"
                            value={v.initial_stock}
                            onChange={(e) => {
                              const updated = [...variantsList];
                              updated[i].initial_stock = parseInt(e.target.value, 10) || 0;
                              setVariantsList(updated);
                            }}
                            className="w-full px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-xs text-white"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Actions */}
              <div className="flex space-x-3 pt-3 border-t border-slate-800">
                <button
                  type="button"
                  onClick={() => setIsNewProductOpen(false)}
                  className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl text-xs"
                >
                  გაუქმება
                </button>
                <button
                  type="submit"
                  className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs shadow-lg shadow-emerald-900/40"
                >
                  პროდუქტის რეგისტრაცია
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL: Multi-Image Product Gallery --- */}
      {galleryProduct && (
        <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-2xl w-full p-6 shadow-2xl flex flex-col max-h-[90vh]">
            <div className="flex justify-between items-center border-b border-slate-800 pb-3 mb-4">
              <div>
                <h3 className="text-base font-bold text-white flex items-center space-x-2">
                  <ImageIcon className="w-5 h-5 text-emerald-400" />
                  <span>{galleryProduct.name} — ფოტო გალერეა</span>
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  სულ {galleryProduct.images?.length || 0} ფოტო
                </p>
              </div>
              <button 
                onClick={() => setGalleryProduct(null)} 
                className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Main Image Stage */}
            <div className="relative flex-1 bg-slate-950 rounded-xl border border-slate-800 min-h-[300px] max-h-[440px] flex items-center justify-center overflow-hidden">
              {galleryProduct.images && galleryProduct.images.length > 0 ? (
                <>
                  <img
                    src={galleryProduct.images[activeImageIndex]?.file_path}
                    alt={galleryProduct.name}
                    className="max-h-[420px] max-w-full object-contain"
                  />
                  {galleryProduct.images.length > 1 && (
                    <>
                      <button
                        type="button"
                        onClick={() => setActiveImageIndex((prev) => (prev > 0 ? prev - 1 : galleryProduct.images!.length - 1))}
                        className="absolute left-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-slate-900/80 hover:bg-slate-800 text-white border border-slate-700 transition cursor-pointer"
                      >
                        <ChevronLeft className="w-5 h-5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => setActiveImageIndex((prev) => (prev < galleryProduct.images!.length - 1 ? prev + 1 : 0))}
                        className="absolute right-3 top-1/2 -translate-y-1/2 p-2 rounded-full bg-slate-900/80 hover:bg-slate-800 text-white border border-slate-700 transition cursor-pointer"
                      >
                        <ChevronRight className="w-5 h-5" />
                      </button>
                    </>
                  )}
                  {isOwner && (
                    <button
                      type="button"
                      onClick={() => handleDeleteGalleryImage(galleryProduct.images![activeImageIndex].id)}
                      className="absolute top-3 right-3 px-3 py-1.5 bg-red-950/80 hover:bg-red-900 text-red-200 border border-red-700/60 rounded-lg text-xs font-semibold flex items-center space-x-1 cursor-pointer transition shadow"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>წაშლა</span>
                    </button>
                  )}
                </>
              ) : (
                <div className="text-center p-8 text-slate-500">
                  <ImageIcon className="w-12 h-12 mx-auto mb-2 opacity-40" />
                  <p className="text-sm">პროდუქტს არ აქვს ატვირთული ფოტო</p>
                </div>
              )}
            </div>

            {/* Thumbnails row */}
            {galleryProduct.images && galleryProduct.images.length > 1 && (
              <div className="flex items-center space-x-2 mt-4 overflow-x-auto py-1">
                {galleryProduct.images.map((img, idx) => (
                  <button
                    type="button"
                    key={img.id}
                    onClick={() => setActiveImageIndex(idx)}
                    className={`w-14 h-14 rounded-lg overflow-hidden border-2 shrink-0 transition cursor-pointer ${
                      activeImageIndex === idx ? 'border-emerald-500 ring-2 ring-emerald-500/30' : 'border-slate-800 opacity-60 hover:opacity-100'
                    }`}
                  >
                    <img src={img.file_path} alt="" className="w-full h-full object-cover" />
                  </button>
                ))}
              </div>
            )}

            {/* Bottom Actions */}
            <div className="flex items-center justify-between border-t border-slate-800 pt-4 mt-4">
              {isOwner ? (
                <label className="flex items-center space-x-2 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-bold cursor-pointer transition">
                  <Upload className="w-4 h-4 text-emerald-400" />
                  <span>ახალი ფოტოს დამატება</span>
                  <input
                    type="file"
                    accept="image/*"
                    multiple
                    onChange={(e) => handleImageFileChange(e, true)}
                    className="hidden"
                  />
                </label>
              ) : <div />}

              <button
                type="button"
                onClick={() => setGalleryProduct(null)}
                className="px-5 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-xl text-xs font-bold cursor-pointer"
              >
                დახურვა
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
};
