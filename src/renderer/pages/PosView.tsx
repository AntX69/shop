/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * POS / Cashier & Checkout Screen (სალარო).
 * Implements:
 * - Barcode scanner & 5-digit manual lookup
 * - Mandatory Product Confirmation Modal before adding to cart
 * - Cart quantity controls with remaining stock validation
 * - 3 Payment Methods: ნაღდი, ნისია, შერეული (No bank cards!)
 * - Change calculation & Customer debt integration
 * - Receipt modal after successful atomic transaction
 * - Zero purchase cost/profit leakage on this screen.
 */

import React, { useState, useEffect, useRef } from 'react';
import { CartItem, Customer, Product, ProductVariant, Sale, User } from '../../shared/types.ts';
import { formatTetri } from '../../shared/money.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { WebcamModal } from '../components/WebcamModal.tsx';
import { 
  Barcode, 
  Search, 
  Camera, 
  Plus, 
  Minus, 
  Trash2, 
  CreditCard, 
  CheckCircle2, 
  AlertCircle, 
  UserCheck, 
  UserPlus, 
  X,
  Printer,
  ShoppingBag
} from 'lucide-react';

interface PosViewProps {
  currentUser: User;
}

export const PosView: React.FC<PosViewProps> = ({ currentUser }) => {
  // Search & input
  const [searchInput, setSearchInput] = useState<string>('');
  const [searchError, setSearchError] = useState<string>('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Catalogue suggestions for name/category search
  const [catalogueProducts, setCatalogueProducts] = useState<Product[]>([]);
  const [filteredVariants, setFilteredVariants] = useState<Array<{ variant: ProductVariant; product: Product }>>([]);

  // Product confirmation modal (MANDATORY per specification)
  const [confirmModalData, setConfirmModalData] = useState<{
    product: Product;
    variant: ProductVariant;
    codeUsed: string;
    quantityToAdd: number;
  } | null>(null);

  // Cart
  const [cart, setCart] = useState<CartItem[]>([]);

  // Checkout modal
  const [isCheckoutModalOpen, setIsCheckoutModalOpen] = useState<boolean>(false);
  const [paymentMethod, setPaymentMethod] = useState<'cash' | 'debt' | 'mixed'>('cash');
  const [cashReceivedInput, setCashReceivedInput] = useState<string>('');
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | null>(null);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [checkoutError, setCheckoutError] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);

  // Quick Customer Creation modal
  const [isNewCustomerModalOpen, setIsNewCustomerModalOpen] = useState<boolean>(false);
  const [newCustFirstName, setNewCustFirstName] = useState<string>('');
  const [newCustLastName, setNewCustLastName] = useState<string>('');
  const [newCustPhone, setNewCustPhone] = useState<string>('');

  // Receipt Modal
  const [completedSale, setCompletedSale] = useState<Sale | null>(null);

  // Webcam OCR Modal (Experimental M6 placeholder)
  const [isWebcamModalOpen, setIsWebcamModalOpen] = useState<boolean>(false);

  // Load catalogue and customers on mount
  useEffect(() => {
    loadCatalogue();
    loadCustomers();
    focusSearch();
  }, []);

  const focusSearch = () => {
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 100);
  };

  const loadCatalogue = async () => {
    try {
      const prods = await invokeIpc<Product[]>('products:list', { stockFilter: 'all' });
      setCatalogueProducts(prods);
    } catch (err) {
      console.error('Failed to load catalogue', err);
    }
  };

  const loadCustomers = async () => {
    try {
      const custs = await invokeIpc<Customer[]>('customers:list');
      setCustomers(custs);
    } catch (err) {
      console.error('Failed to load customers', err);
    }
  };

  // Filter catalogue by name or code live
  useEffect(() => {
    if (!searchInput.trim()) {
      setFilteredVariants([]);
      return;
    }
    const term = searchInput.trim().toLowerCase();
    const results: Array<{ variant: ProductVariant; product: Product }> = [];

    for (const prod of catalogueProducts) {
      const matchesName = prod.name.toLowerCase().includes(term);
      for (const v of prod.variants || []) {
        const matchesVariant = v.variant_name.toLowerCase().includes(term);
        const matchesCode = v.codes?.some(c => c.code_value.toLowerCase().includes(term));
        if (matchesName || matchesVariant || matchesCode) {
          results.push({ variant: v, product: prod });
        }
      }
    }
    setFilteredVariants(results.slice(0, 10));
  }, [searchInput, catalogueProducts]);

  // Keyboard Shortcuts (Space for checkout, Esc to close open modals)
  useEffect(() => {
    const handlePosKeyDown = (e: KeyboardEvent) => {
      const activeTag = (document.activeElement?.tagName || '').toLowerCase();
      const isInput = activeTag === 'input' || activeTag === 'textarea';

      if (e.key === 'Escape') {
        if (isWebcamModalOpen) {
          setIsWebcamModalOpen(false);
          focusSearch();
        } else if (confirmModalData) {
          setConfirmModalData(null);
          focusSearch();
        } else if (isNewCustomerModalOpen) {
          setIsNewCustomerModalOpen(false);
        } else if (isCheckoutModalOpen) {
          setIsCheckoutModalOpen(false);
          focusSearch();
        } else if (completedSale) {
          setCompletedSale(null);
          focusSearch();
        }
        return;
      }

      if (e.key === ' ' && !isInput) {
        if (cart.length > 0 && !confirmModalData && !isCheckoutModalOpen && !isNewCustomerModalOpen && !completedSale && !isWebcamModalOpen) {
          e.preventDefault();
          handleOpenCheckout();
        }
      }
    };

    window.addEventListener('keydown', handlePosKeyDown);
    return () => window.removeEventListener('keydown', handlePosKeyDown);
  }, [cart, confirmModalData, isCheckoutModalOpen, isNewCustomerModalOpen, completedSale, isWebcamModalOpen]);

  // Handle barcode scanner input or Enter key
  const handleSearchSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSearchError('');
    const code = searchInput.trim();
    if (!code) return;

    try {
      // 1. Direct code lookup
      const found = await invokeIpc<{
        variant: ProductVariant;
        product: Product;
        code_used: string;
      } | null>('products:lookupCode', { code });

      if (found) {
        // Open mandatory confirmation dialog!
        openConfirmationModal(found.product, found.variant, found.code_used);
        setSearchInput('');
        return;
      }

      // 2. If exactly one variant matches filtered list, pick it
      if (filteredVariants.length === 1) {
        const match = filteredVariants[0];
        const primaryCode = match.variant.codes?.[0]?.code_value || code;
        openConfirmationModal(match.product, match.variant, primaryCode);
        setSearchInput('');
        return;
      }

      if (filteredVariants.length > 1) {
        setSearchError('მოიძებნა რამდენიმე პროდუქტი, გთხოვთ აირჩიოთ სიიდან');
      } else {
        setSearchError(`კოდით "${code}" პროდუქტი ვერ მოიძებნა`);
      }
    } catch (err: any) {
      setSearchError(err.message || 'ძებნის შეცდომა');
    }
  };

  const openConfirmationModal = (product: Product, variant: ProductVariant, codeUsed: string) => {
    setSearchError('');
    setConfirmModalData({
      product,
      variant,
      codeUsed,
      quantityToAdd: 1
    });
  };

  // Add confirmed product to cart
  const confirmAddToCart = () => {
    if (!confirmModalData) return;
    const { product, variant, codeUsed, quantityToAdd } = confirmModalData;

    const unitPrice = variant.price_override_tetri ?? product.base_price_tetri;
    const existingIndex = cart.findIndex(c => c.variant_id === variant.id);

    if (existingIndex >= 0) {
      const existing = cart[existingIndex];
      const newQty = existing.quantity + quantityToAdd;
      if (newQty > variant.stock_quantity) {
        alert(`მარაგი შეზღუდულია! ხელმისაწვდომია: ${variant.stock_quantity}`);
        return;
      }
      const updatedCart = [...cart];
      updatedCart[existingIndex] = { ...existing, quantity: newQty };
      setCart(updatedCart);
    } else {
      if (quantityToAdd > variant.stock_quantity) {
        alert(`მარაგი შეზღუდულია! ხელმისაწვდომია: ${variant.stock_quantity}`);
        return;
      }
      setCart(prev => [
        ...prev,
        {
          variant_id: variant.id,
          product_id: product.id,
          product_name: product.name,
          variant_name: variant.variant_name,
          code_used: codeUsed,
          unit_price_tetri: unitPrice,
          quantity: quantityToAdd,
          available_stock: variant.stock_quantity
        }
      ]);
    }

    setConfirmModalData(null);
    focusSearch();
  };

  // Cart operations
  const updateCartQuantity = (variantId: number, delta: number) => {
    setCart(prev => {
      return prev.map(item => {
        if (item.variant_id === variantId) {
          const newQty = item.quantity + delta;
          if (newQty <= 0) return null;
          if (newQty > item.available_stock) {
            alert(`მარაგი შეზღუდულია! ხელმისაწვდომია: ${item.available_stock}`);
            return item;
          }
          return { ...item, quantity: newQty };
        }
        return item;
      }).filter(Boolean) as CartItem[];
    });
  };

  const removeFromCart = (variantId: number) => {
    setCart(prev => prev.filter(c => c.variant_id !== variantId));
  };

  const clearCart = () => {
    if (cart.length > 0 && confirm('ნამდვილად გსურთ კალათის გასუფთავება?')) {
      setCart([]);
      focusSearch();
    }
  };

  // Calculations
  const cartTotalTetri = cart.reduce((sum, item) => sum + (item.quantity * item.unit_price_tetri), 0);
  const cartItemCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  // Cash and change calculations
  const parsedCashReceived = Math.round(parseFloat(cashReceivedInput || '0') * 100) || 0;
  const changeTetri = Math.max(0, parsedCashReceived - cartTotalTetri);
  const debtTetri = paymentMethod === 'debt' 
    ? cartTotalTetri 
    : paymentMethod === 'mixed' 
    ? Math.max(0, cartTotalTetri - parsedCashReceived) 
    : 0;

  // Open checkout modal
  const handleOpenCheckout = () => {
    if (cart.length === 0) return;
    setPaymentMethod('cash');
    setCashReceivedInput((cartTotalTetri / 100).toFixed(2));
    setCheckoutError('');
    setIsCheckoutModalOpen(true);
  };

  // Execute checkout
  const handleCheckoutSubmit = async () => {
    setCheckoutError('');

    if (paymentMethod === 'cash') {
      if (parsedCashReceived < cartTotalTetri) {
        setCheckoutError(`მიღებული თანხა ნაკლებია გადასახდელ თანხაზე (${formatTetri(cartTotalTetri)})`);
        return;
      }
    } else if (paymentMethod === 'debt' || paymentMethod === 'mixed') {
      if (!selectedCustomerId) {
        setCheckoutError('ნისიით ან შერეული გადახდისას კლიენტის არჩევა სავალდებულოა');
        return;
      }
      if (paymentMethod === 'mixed') {
        if (parsedCashReceived <= 0 || parsedCashReceived >= cartTotalTetri) {
          setCheckoutError('შერეული გადახდისას ნაღდი თანხა უნდა იყოს 0-ზე მეტი და მთლიან თანხაზე ნაკლები');
          return;
        }
      }
    }

    try {
      setIsSubmitting(true);
      const sale = await invokeIpc<Sale>('pos:checkout', {
        items: cart.map(c => ({
          variant_id: c.variant_id,
          quantity: c.quantity,
          unit_price_tetri: c.unit_price_tetri
        })),
        payment_method: paymentMethod,
        customer_id: selectedCustomerId,
        cash_received_tetri: parsedCashReceived
      });

      // Clear cart, close checkout modal, show receipt
      setCart([]);
      setIsCheckoutModalOpen(false);
      setCompletedSale(sale);
      loadCatalogue(); // Refresh local stock counts
      loadCustomers();
    } catch (err: any) {
      setCheckoutError(err.message || 'გაყიდვის დასრულება ვერ მოხერხდა');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Quick customer creation
  const handleCreateCustomer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCustFirstName.trim()) return;

    try {
      const created = await invokeIpc<Customer>('customers:create', {
        first_name: newCustFirstName.trim(),
        last_name: newCustLastName.trim() || undefined,
        phone: newCustPhone.trim() || undefined
      });
      setCustomers(prev => [...prev, created]);
      setSelectedCustomerId(created.id);
      setIsNewCustomerModalOpen(false);
      setNewCustFirstName('');
      setNewCustLastName('');
      setNewCustPhone('');
    } catch (err: any) {
      alert(err.message || 'კლიენტის დამატება ვერ მოხერხდა');
    }
  };

  return (
    <div className="flex-1 flex flex-col h-full bg-slate-950 text-slate-100 overflow-hidden select-none min-h-0">
      
      {/* Main Split Grid: Left = Product Lookup & Catalogue, Right = Cart & Checkout */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        
        {/* LEFT COLUMN: Search & Product Discovery */}
        <div className="w-7/12 min-w-0 flex flex-col border-r border-slate-800 p-3 lg:p-4 min-h-0 overflow-hidden">
          
          {/* Top Search Bar */}
          <div className="mb-3 lg:mb-4 shrink-0">
            <form onSubmit={handleSearchSubmit} className="flex items-center space-x-2">
              <div className="relative flex-1">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder="სკანირება (შტრიხკოდი) / 5-ნიშნა კოდი / სახელი..."
                  className="w-full pl-10 sm:pl-11 pr-3 sm:pr-4 py-2.5 sm:py-3 bg-slate-900 border border-slate-700 rounded-xl text-white placeholder-slate-400 focus:outline-none focus:border-emerald-500 font-medium text-sm sm:text-base shadow-inner"
                />
                <Barcode className="w-4 h-4 sm:w-5 sm:h-5 text-slate-400 absolute left-3 sm:left-3.5 top-3 sm:top-3.5" />
              </div>

              <button
                type="submit"
                className="px-3.5 sm:px-5 py-2.5 sm:py-3 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl font-bold flex items-center space-x-1.5 sm:space-x-2 transition-colors cursor-pointer text-xs sm:text-sm shrink-0"
              >
                <Search className="w-4 h-4" />
                <span className="hidden sm:inline">ძებნა (Enter)</span>
                <span className="sm:hidden inline">ძებნა</span>
              </button>

              <button
                type="button"
                onClick={() => setIsWebcamModalOpen(true)}
                title="ვებკამერით 5-ნიშნა კოდის ამოცნობა (M6)"
                className="p-2.5 sm:p-3 bg-slate-900 hover:bg-slate-800 border border-slate-700 text-slate-300 hover:text-emerald-400 rounded-xl transition-colors cursor-pointer shrink-0"
              >
                <Camera className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
            </form>

            {searchError && (
              <div className="mt-2 text-xs text-red-400 flex items-center space-x-1.5">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <span>{searchError}</span>
              </div>
            )}
          </div>

          {/* Search suggestions / Filtered list */}
          <div className="flex-1 overflow-y-auto pr-1 space-y-2">
            <div className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-2 flex justify-between items-center">
              <span>{searchInput ? 'ძებნის შედეგები' : 'ხელმისაწვდომი პროდუქცია'}</span>
              <span className="text-[11px] text-slate-400">დააკლიკეთ პროდუქტზე დასადასტურებლად</span>
            </div>

            {(searchInput ? filteredVariants : catalogueProducts.flatMap(p => (p.variants || []).map(v => ({ variant: v, product: p })))).map(({ variant, product }) => {
              const primaryCode = variant.codes?.[0]?.code_value || '-';
              const effectivePrice = variant.price_override_tetri ?? product.base_price_tetri;
              const isOutOfStock = variant.stock_quantity <= 0;

              return (
                <div
                  key={variant.id}
                  onClick={() => !isOutOfStock && openConfirmationModal(product, variant, primaryCode)}
                  className={`flex items-center justify-between p-3 rounded-xl border transition-all ${
                    isOutOfStock
                      ? 'bg-slate-900/40 border-slate-800/40 opacity-50 cursor-not-allowed'
                      : 'bg-slate-900 hover:bg-slate-800/80 border-slate-800 hover:border-emerald-600/50 cursor-pointer shadow-sm group'
                  }`}
                >
                  <div className="flex items-center space-x-3">
                    <div className="w-12 h-12 rounded-lg bg-slate-950 border border-slate-800 flex items-center justify-center text-slate-500 font-bold text-xs uppercase overflow-hidden">
                      {product.images && product.images.length > 0 ? (
                        <img src={product.images[0].file_path} alt={product.name} className="w-full h-full object-cover" />
                      ) : (
                        <ShoppingBag className="w-6 h-6 text-slate-600" />
                      )}
                    </div>
                    <div>
                      <div className="text-sm font-bold text-white group-hover:text-emerald-400 transition-colors">
                        {product.name}
                      </div>
                      <div className="text-xs text-slate-400">
                        ვარიანტი: <span className="text-slate-300 font-medium">{variant.variant_name}</span> &bull; კოდი: <span className="font-mono text-emerald-400">{primaryCode}</span>
                      </div>
                    </div>
                  </div>

                  <div className="text-right">
                    <div className="text-base font-extrabold text-white">
                      {formatTetri(effectivePrice)}
                    </div>
                    <div className={`text-xs font-medium ${isOutOfStock ? 'text-red-400' : 'text-slate-400'}`}>
                      მარაგი: <span className={isOutOfStock ? 'font-bold' : 'text-slate-200'}>{variant.stock_quantity}</span> ც
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

        </div>

        {/* RIGHT COLUMN: Cart & Checkout Summary */}
        <div className="w-5/12 min-w-0 flex flex-col bg-slate-900/60 p-3 lg:p-4 min-h-0 overflow-hidden">
          
          <div className="flex items-center justify-between border-b border-slate-800 pb-2.5 lg:pb-3 mb-2.5 lg:mb-3 shrink-0">
            <div className="flex items-center space-x-2">
              <h2 className="text-sm lg:text-base font-bold text-white">კალათა</h2>
              <span className="px-2 py-0.5 rounded-full bg-emerald-600/20 text-emerald-400 border border-emerald-600/30 text-xs font-bold tabular-nums">
                {cartItemCount} ცალი
              </span>
            </div>

            {cart.length > 0 && (
              <button
                onClick={clearCart}
                className="text-xs text-red-400 hover:text-red-300 flex items-center space-x-1 cursor-pointer transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>გასუფთავება</span>
              </button>
            )}
          </div>

          {/* Cart Items List */}
          <div className="flex-1 overflow-y-auto space-y-2 pr-1 min-h-0">
            {cart.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-slate-400 text-center p-4 lg:p-6">
                <ShoppingBag className="w-10 h-10 lg:w-12 lg:h-12 text-slate-700 mb-2.5" />
                <p className="text-sm font-medium">კალათა ცარიელია</p>
                <p className="text-xs text-slate-400 mt-1">დაასკანირეთ შტრიხკოდი ან აირჩიეთ პროდუქტი</p>
              </div>
            ) : (
              cart.map((item) => (
                <div
                  key={item.variant_id}
                  className="bg-slate-900 border border-slate-800 rounded-xl p-2.5 lg:p-3 flex items-center justify-between shadow-sm"
                >
                  <div className="flex-1 pr-2 min-w-0">
                    <div className="text-xs sm:text-sm font-bold text-white truncate">{item.product_name}</div>
                    <div className="text-[11px] text-slate-400 truncate">
                      {item.variant_name} &bull; <span className="font-mono text-emerald-400">{item.code_used}</span>
                    </div>
                    <div className="text-xs text-slate-300 font-semibold mt-0.5 tabular-nums">
                      {formatTetri(item.unit_price_tetri)} &times; {item.quantity} = {formatTetri(item.quantity * item.unit_price_tetri)}
                    </div>
                  </div>

                  <div className="flex items-center space-x-1 sm:space-x-1.5 shrink-0">
                    <button
                      onClick={() => updateCartQuantity(item.variant_id, -1)}
                      className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center transition-colors cursor-pointer"
                    >
                      <Minus className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                    </button>
                    <span className="w-5 sm:w-6 text-center text-xs sm:text-sm font-bold text-white tabular-nums">
                      {item.quantity}
                    </span>
                    <button
                      onClick={() => updateCartQuantity(item.variant_id, 1)}
                      className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center justify-center transition-colors cursor-pointer"
                    >
                      <Plus className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                    </button>
                    <button
                      onClick={() => removeFromCart(item.variant_id)}
                      className="w-6 h-6 sm:w-7 sm:h-7 rounded-lg bg-red-950/40 hover:bg-red-900/60 text-red-400 flex items-center justify-center transition-colors ml-0.5 cursor-pointer"
                    >
                      <X className="w-3 h-3 sm:w-3.5 sm:h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Cart Bottom Summary */}
          <div className="border-t border-slate-800 pt-3 mt-2 bg-slate-900/90 rounded-2xl p-3 lg:p-4 shadow-xl shrink-0">
            <div className="flex justify-between items-center mb-2.5 lg:mb-3">
              <span className="text-slate-400 text-xs sm:text-sm font-medium">სულ გადასახდელი:</span>
              <span className="text-xl sm:text-2xl font-black text-emerald-400 tabular-nums">
                {formatTetri(cartTotalTetri)}
              </span>
            </div>

            <button
              onClick={handleOpenCheckout}
              disabled={cart.length === 0}
              className="w-full py-3 sm:py-3.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 disabled:hover:bg-emerald-600 text-white font-extrabold text-sm sm:text-base rounded-xl transition-all shadow-lg shadow-emerald-900/40 flex items-center justify-center space-x-2 cursor-pointer"
            >
              <CreditCard className="w-4 h-4 sm:w-5 sm:h-5" />
              <span>გაყიდვის დადასტურება</span>
              <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] bg-emerald-800/80 rounded border border-emerald-400/40 font-mono text-emerald-100 font-normal">Space</kbd>
            </button>
          </div>

        </div>

      </div>

      {/* --- MODAL 1: Mandatory Product Confirmation Modal --- */}
      {confirmModalData && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full max-h-[92vh] flex flex-col p-4 sm:p-6 shadow-2xl animate-in fade-in zoom-in-95 overflow-hidden">
            <div className="flex justify-between items-start border-b border-slate-800 pb-3 mb-3 shrink-0">
              <h3 className="text-base sm:text-lg font-bold text-white">პროდუქტის დადასტურება</h3>
              <button
                onClick={() => setConfirmModalData(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="space-y-4 overflow-y-auto flex-1 pr-1">
              <div>
                <div className="text-lg font-extrabold text-white">{confirmModalData.product.name}</div>
                <div className="text-sm text-slate-400 mt-0.5">
                  ვარიანტი: <span className="text-emerald-400 font-bold">{confirmModalData.variant.variant_name}</span>
                </div>
                <div className="text-xs text-slate-400 font-mono mt-0.5">
                  კოდი: {confirmModalData.codeUsed}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 bg-slate-950 p-3 rounded-xl border border-slate-800">
                <div>
                  <div className="text-[11px] text-slate-400 uppercase font-semibold">ერთეულის ფასი</div>
                  <div className="text-xl font-black text-white mt-0.5">
                    {formatTetri(confirmModalData.variant.price_override_tetri ?? confirmModalData.product.base_price_tetri)}
                  </div>
                </div>
                <div>
                  <div className="text-[11px] text-slate-400 uppercase font-semibold">ნაშთი მარაგში</div>
                  <div className="text-xl font-bold text-slate-200 mt-0.5">
                    {confirmModalData.variant.stock_quantity} ცალი
                  </div>
                </div>
              </div>

              {/* Quantity Picker */}
              <div>
                <label className="block text-xs font-semibold text-slate-400 uppercase mb-2">
                  რაოდენობა
                </label>
                <div className="flex items-center space-x-3">
                  <button
                    onClick={() => setConfirmModalData(prev => prev && { ...prev, quantityToAdd: Math.max(1, prev.quantityToAdd - 1) })}
                    className="w-10 h-10 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-lg flex items-center justify-center cursor-pointer"
                  >
                    -
                  </button>
                  <input
                    type="number"
                    min="1"
                    max={confirmModalData.variant.stock_quantity}
                    value={confirmModalData.quantityToAdd}
                    onChange={(e) => {
                      const val = parseInt(e.target.value, 10);
                      if (!isNaN(val)) {
                        setConfirmModalData(prev => prev && { ...prev, quantityToAdd: Math.min(confirmModalData.variant.stock_quantity, Math.max(1, val)) });
                      }
                    }}
                    className="flex-1 py-2 text-center text-xl font-bold bg-slate-950 border border-slate-700 rounded-xl text-white focus:outline-none focus:border-emerald-500"
                  />
                  <button
                    onClick={() => setConfirmModalData(prev => prev && { ...prev, quantityToAdd: Math.min(confirmModalData.variant.stock_quantity, prev.quantityToAdd + 1) })}
                    className="w-10 h-10 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-lg flex items-center justify-center cursor-pointer"
                  >
                    +
                  </button>
                </div>
              </div>

              <div className="pt-2 flex space-x-3">
                <button
                  type="button"
                  onClick={() => setConfirmModalData(null)}
                  className="flex-1 py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl transition-colors cursor-pointer"
                >
                  გაუქმება (Esc)
                </button>
                <button
                  type="button"
                  onClick={confirmAddToCart}
                  className="flex-1 py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl transition-colors shadow-lg shadow-emerald-900/40 cursor-pointer"
                >
                  კალათაში დამატება
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL 2: Payment Modal (Exact 3 Methods: ნაღდი, ნისია, შერეული) --- */}
      {isCheckoutModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-lg w-full max-h-[92vh] flex flex-col p-4 sm:p-6 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
            <div className="flex justify-between items-start border-b border-slate-800 pb-3 mb-3 shrink-0">
              <div>
                <h3 className="text-base sm:text-lg font-bold text-white">გადახდის დადასტურება</h3>
                <div className="text-xs text-slate-400">ჯამი: <span className="text-emerald-400 font-bold text-sm tabular-nums">{formatTetri(cartTotalTetri)}</span></div>
              </div>
              <button
                onClick={() => setIsCheckoutModalOpen(false)}
                className="text-slate-400 hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-y-auto flex-1 pr-1 space-y-3.5 my-1">
              {checkoutError && (
                <div className="p-3 bg-red-950/60 border border-red-800 rounded-xl text-red-200 text-xs flex items-center space-x-2">
                  <AlertCircle className="w-4 h-4 flex-shrink-0 text-red-400" />
                  <span>{checkoutError}</span>
                </div>
              )}

              {/* 3 Payment Method Tabs */}
              <div className="grid grid-cols-3 gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPaymentMethod('cash');
                    setCashReceivedInput((cartTotalTetri / 100).toFixed(2));
                    setCheckoutError('');
                  }}
                  className={`py-2.5 sm:py-3 px-2 rounded-xl text-xs font-bold transition-all border cursor-pointer ${
                    paymentMethod === 'cash'
                      ? 'bg-emerald-600 text-white border-emerald-500 shadow-lg shadow-emerald-900/30'
                      : 'bg-slate-950 text-slate-400 border-slate-800 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  1. ნაღდი
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setPaymentMethod('debt');
                    setCashReceivedInput('0');
                    setCheckoutError('');
                  }}
                  className={`py-2.5 sm:py-3 px-2 rounded-xl text-xs font-bold transition-all border cursor-pointer ${
                    paymentMethod === 'debt'
                      ? 'bg-amber-600 text-white border-amber-500 shadow-lg shadow-amber-900/30'
                      : 'bg-slate-950 text-slate-400 border-slate-800 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  2. ნისია
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setPaymentMethod('mixed');
                    setCashReceivedInput((Math.floor(cartTotalTetri / 200) || 1).toFixed(2));
                    setCheckoutError('');
                  }}
                  className={`py-2.5 sm:py-3 px-2 rounded-xl text-xs font-bold transition-all border cursor-pointer ${
                    paymentMethod === 'mixed'
                      ? 'bg-blue-600 text-white border-blue-500 shadow-lg shadow-blue-900/30'
                      : 'bg-slate-950 text-slate-400 border-slate-800 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  3. შერეული
                </button>
              </div>

              {/* Customer Selection (REQUIRED for Debt and Mixed; Optional for Cash) */}
              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <label className="text-xs font-semibold text-slate-300">
                    კლიენტი {paymentMethod !== 'cash' ? <span className="text-red-400 font-bold">* (სავალდებულოა)</span> : <span className="text-slate-400 font-normal">(სურვილისამებრ)</span>}
                  </label>
                  <button
                    type="button"
                    onClick={() => setIsNewCustomerModalOpen(true)}
                    className="text-xs text-emerald-400 hover:underline flex items-center space-x-1 cursor-pointer"
                  >
                    <UserPlus className="w-3.5 h-3.5" />
                    <span>+ ახალი კლიენტი</span>
                  </button>
                </div>

                <select
                  value={selectedCustomerId || ''}
                  onChange={(e) => setSelectedCustomerId(e.target.value ? parseInt(e.target.value, 10) : null)}
                  className="w-full px-3 py-2 sm:py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-white text-xs sm:text-sm focus:outline-none focus:border-emerald-500"
                >
                  <option value="">-- აირჩიეთ კლიენტი სიიდან --</option>
                  {customers.map(c => (
                    <option key={c.id} value={c.id}>
                      {c.first_name} {c.last_name || ''} {c.phone ? `(${c.phone})` : ''} — დავალიანება: {formatTetri(c.total_debt_tetri)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Cash Inputs & Change Calculation */}
              {(paymentMethod === 'cash' || paymentMethod === 'mixed') && (
                <div className="space-y-2.5">
                  <div>
                    <label className="block text-xs font-semibold text-slate-300 mb-1">
                      {paymentMethod === 'cash' ? 'მიღებული ნაღდი თანხა (₾)' : 'ახლა გადახდილი ნაღდი თანხა (₾)'}
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      value={cashReceivedInput}
                      onChange={(e) => setCashReceivedInput(e.target.value)}
                      className="w-full px-3.5 py-2 sm:py-2.5 bg-slate-950 border border-slate-700 rounded-xl text-white text-lg sm:text-xl font-bold focus:outline-none focus:border-emerald-500 tabular-nums"
                    />
                  </div>

                  {/* Quick denomination buttons for cash */}
                  {paymentMethod === 'cash' && (
                    <div className="flex flex-wrap gap-1.5">
                      {[10, 20, 50, 100, 200].map(bill => (
                        <button
                          key={bill}
                          type="button"
                          onClick={() => setCashReceivedInput(String(bill))}
                          className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg text-xs font-bold text-slate-200 transition-colors cursor-pointer"
                        >
                          +{bill} ₾
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setCashReceivedInput((cartTotalTetri / 100).toFixed(2))}
                        className="px-2.5 py-1 bg-emerald-950/60 hover:bg-emerald-900 border border-emerald-700 text-emerald-300 rounded-lg text-xs font-bold cursor-pointer"
                      >
                        ზუსტად
                      </button>
                    </div>
                  )}

                  {/* Dynamic Change / Debt breakdown box */}
                  <div className="bg-slate-950 p-3 rounded-xl border border-slate-800 space-y-1">
                    {paymentMethod === 'cash' && (
                      <div className="flex justify-between items-center text-xs sm:text-sm">
                        <span className="text-slate-400">ხურდა დასაბრუნებელი:</span>
                        <span className="text-base sm:text-lg font-black text-amber-400 tabular-nums">{formatTetri(changeTetri)}</span>
                      </div>
                    )}

                    {paymentMethod === 'mixed' && (
                      <div className="flex justify-between items-center text-xs sm:text-sm">
                        <span className="text-slate-400">დარჩენილი ვალი (ნისია):</span>
                        <span className="text-base sm:text-lg font-black text-amber-400 tabular-nums">{formatTetri(debtTetri)}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {paymentMethod === 'debt' && (
                <div className="bg-amber-950/30 border border-amber-800/60 p-3.5 rounded-xl text-xs text-amber-200">
                  სრული თანხა <span className="font-bold text-sm text-white tabular-nums">{formatTetri(cartTotalTetri)}</span> ჩაიწერება კლიენტის დავალიანებად.
                </div>
              )}
            </div>

            {/* Modal Actions - Sticky Bottom */}
            <div className="flex space-x-3 pt-3 border-t border-slate-800 shrink-0">
              <button
                type="button"
                onClick={() => setIsCheckoutModalOpen(false)}
                className="flex-1 py-2.5 sm:py-3 bg-slate-800 hover:bg-slate-700 text-slate-300 font-bold rounded-xl transition-colors cursor-pointer text-xs sm:text-sm"
              >
                გაუქმება
              </button>
              <button
                type="button"
                disabled={isSubmitting}
                onClick={handleCheckoutSubmit}
                className="flex-1 py-2.5 sm:py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-extrabold rounded-xl transition-colors shadow-lg shadow-emerald-900/40 cursor-pointer text-xs sm:text-sm"
              >
                {isSubmitting ? 'სრულდება...' : 'გაყიდვის დასრულება'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL 3: Quick Customer Registration --- */}
      {isNewCustomerModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-sm w-full max-h-[92vh] flex flex-col p-5 sm:p-6 shadow-2xl overflow-y-auto">
            <h3 className="text-sm sm:text-base font-bold text-white mb-3">ახალი კლიენტის რეგისტრაცია</h3>
            <form onSubmit={handleCreateCustomer} className="space-y-3">
              <div>
                <label className="block text-xs text-slate-400 mb-1">სახელი *</label>
                <input
                  type="text"
                  required
                  value={newCustFirstName}
                  onChange={(e) => setNewCustFirstName(e.target.value)}
                  placeholder="მაგ. დავით"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs sm:text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">გვარი (არასავალდებულო)</label>
                <input
                  type="text"
                  value={newCustLastName}
                  onChange={(e) => setNewCustLastName(e.target.value)}
                  placeholder="მაგ. ბერიძე"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs sm:text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">ტელეფონი (არასავალდებულო)</label>
                <input
                  type="text"
                  value={newCustPhone}
                  onChange={(e) => setNewCustPhone(e.target.value)}
                  placeholder="მაგ. 599 12 34 56"
                  className="w-full px-3 py-2 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs sm:text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              <div className="flex space-x-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsNewCustomerModalOpen(false)}
                  className="flex-1 py-2 bg-slate-800 text-slate-300 rounded-lg text-xs font-bold cursor-pointer hover:bg-slate-700 transition-colors"
                >
                  გაუქმება
                </button>
                <button
                  type="submit"
                  className="flex-1 py-2 bg-emerald-600 text-white rounded-lg text-xs font-bold cursor-pointer hover:bg-emerald-500 transition-colors shadow-sm"
                >
                  შენახვა
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- MODAL 4: Completed Sale Receipt View --- */}
      {completedSale && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-3 sm:p-4">
          <div className="bg-slate-900 border border-slate-700 rounded-2xl max-w-md w-full max-h-[92vh] flex flex-col p-4 sm:p-6 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
            <div className="text-center border-b border-slate-800 pb-3 mb-3 shrink-0">
              <div className="w-10 h-10 sm:w-12 sm:h-12 bg-emerald-600/20 text-emerald-400 border border-emerald-600/40 rounded-full flex items-center justify-center mx-auto mb-2">
                <CheckCircle2 className="w-6 h-6 sm:w-7 sm:h-7" />
              </div>
              <h3 className="text-base sm:text-lg font-bold text-white">გაყიდვა წარმატებით დასრულდა!</h3>
              <div className="text-xs text-slate-400 font-mono mt-0.5">ჩეკის #: {completedSale.receipt_number}</div>
            </div>

            {/* Receipt Summary */}
            <div className="space-y-2 mb-3 text-xs overflow-y-auto flex-1 pr-1">
              <div className="flex justify-between text-slate-400">
                <span>გადახდის მეთოდი:</span>
                <span className="font-bold text-white">
                  {completedSale.payment_method === 'cash' ? 'ნაღდი' : completedSale.payment_method === 'debt' ? 'ნისია' : 'შერეული'}
                </span>
              </div>
              {completedSale.customer_name && (
                <div className="flex justify-between text-slate-400">
                  <span>კლიენტი:</span>
                  <span className="font-bold text-white">{completedSale.customer_name}</span>
                </div>
              )}
              <div className="flex justify-between text-slate-400">
                <span>ჯამური თანხა:</span>
                <span className="font-black text-emerald-400 text-sm tabular-nums">{formatTetri(completedSale.total_tetri)}</span>
              </div>
              {completedSale.payment_method === 'cash' && (
                <>
                  <div className="flex justify-between text-slate-400">
                    <span>მიღებული თანხა:</span>
                    <span className="text-slate-200 tabular-nums">{formatTetri(completedSale.cash_received_tetri)}</span>
                  </div>
                  <div className="flex justify-between text-slate-400">
                    <span>დაბრუნებული ხურდა:</span>
                    <span className="font-bold text-amber-400 tabular-nums">{formatTetri(completedSale.change_given_tetri)}</span>
                  </div>
                </>
              )}
              {completedSale.debt_amount_tetri > 0 && (
                <div className="flex justify-between text-slate-400">
                  <span>დარჩენილი ნისია:</span>
                  <span className="font-bold text-amber-400 tabular-nums">{formatTetri(completedSale.debt_amount_tetri)}</span>
                </div>
              )}

              {/* Line Items Snapshot */}
              <div className="bg-slate-950 p-2.5 sm:p-3 rounded-xl border border-slate-800 max-h-36 overflow-y-auto my-2 space-y-1.5 text-xs">
                {completedSale.items?.map((it) => (
                  <div key={it.id} className="flex justify-between items-center">
                    <span className="text-slate-300 truncate pr-2">
                      {it.product_name_snap} ({it.variant_name_snap}) &times; {it.quantity}
                    </span>
                    <span className="font-semibold text-white shrink-0 tabular-nums">{formatTetri(it.total_price_tetri)}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex space-x-3 pt-3 border-t border-slate-800 shrink-0">
              <button
                onClick={() => {
                  window.print();
                }}
                className="flex-1 py-2.5 sm:py-3 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold rounded-xl flex items-center justify-center space-x-1.5 cursor-pointer text-xs"
              >
                <Printer className="w-4 h-4" />
                <span>ბეჭდვა</span>
              </button>
              <button
                onClick={() => {
                  setCompletedSale(null);
                  focusSearch();
                }}
                className="flex-1 py-2.5 sm:py-3 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl cursor-pointer text-xs shadow-lg shadow-emerald-900/30"
              >
                ახალი გაყიდვა
              </button>
            </div>
          </div>
        </div>
      )}

      {/* --- MODAL 5: Webcam Handwritten 5-Digit OCR (M6 Complete) --- */}
      <WebcamModal
        isOpen={isWebcamModalOpen}
        onClose={() => {
          setIsWebcamModalOpen(false);
          focusSearch();
        }}
        onConfirmProduct={(product, variant, code) => {
          setIsWebcamModalOpen(false);
          openConfirmationModal(product, variant, code);
        }}
      />

    </div>
  );
};
