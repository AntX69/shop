/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Webcam Offline OCR Modal Component (M6).
 * Recognizes 5-digit handwritten store codes strictly offline using a local trained ONNX model.
 * Handles webcam devices, headless environments (Pending Hardware Verification),
 * image upload testing, manual digit correction, and mandatory seller confirmation before cart addition.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Product, ProductVariant } from '../../shared/types.ts';
import { formatTetri } from '../../shared/money.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { recognize5DigitsFromCanvas, OcrResult, BoundingBox } from '../utils/offlineOcr.ts';
import { 
  Camera, 
  RotateCw, 
  CheckCircle2, 
  AlertCircle, 
  X, 
  Sparkles, 
  Scan, 
  ShoppingBag,
  SlidersHorizontal,
  Upload,
  Play
} from 'lucide-react';

interface WebcamModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirmProduct: (product: Product, variant: ProductVariant, code: string) => void;
}

export const WebcamModal: React.FC<WebcamModalProps> = ({
  isOpen,
  onClose,
  onConfirmProduct,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>('');
  const [cameraError, setCameraError] = useState<string>('');
  const [isRecognizing, setIsRecognizing] = useState<boolean>(false);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  
  // 5 editable digits
  const [digitInputs, setDigitInputs] = useState<string[]>(['', '', '', '', '']);

  // Matched product lookup
  const [matchedItem, setMatchedItem] = useState<{
    product: Product;
    variant: ProductVariant;
    code_used: string;
  } | null>(null);
  const [lookupError, setLookupError] = useState<string>('');

  // Toggle binarized threshold preview
  const [showThresholdPreview, setShowThresholdPreview] = useState<boolean>(false);

  // Initialize camera list
  useEffect(() => {
    if (!isOpen) return;

    const getCameras = async () => {
      try {
        setCameraError('');
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
          setCameraError('ვებკამერა არ არის შეერთებული (Pending Hardware Verification)');
          return;
        }

        const allDevices = await navigator.mediaDevices.enumerateDevices();
        const videoDevs = allDevices.filter(d => d.kind === 'videoinput');
        setDevices(videoDevs);

        if (videoDevs.length > 0) {
          setSelectedDeviceId(videoDevs[0].deviceId);
        } else {
          setCameraError('ვებკამერა არ არის შეერთებული (Pending Hardware Verification)');
        }
      } catch (err: any) {
        setCameraError('ვებკამერა არ არის შეერთებული (Pending Hardware Verification)');
      }
    };

    getCameras();
  }, [isOpen]);

  // Start video stream when selected camera changes
  useEffect(() => {
    if (!isOpen || !selectedDeviceId) return;

    let currentStream: MediaStream | null = null;

    const startStream = async () => {
      try {
        setCameraError('');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            deviceId: { exact: selectedDeviceId },
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });

        currentStream = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
        }
      } catch (err: any) {
        setCameraError('ვებკამერის წვდომა ვერ მოხერხდა (Pending Hardware Verification)');
      }
    };

    startStream();

    return () => {
      if (currentStream) {
        currentStream.getTracks().forEach(t => t.stop());
      }
    };
  }, [isOpen, selectedDeviceId]);

  // Process canvas through offline ONNX OCR pipeline
  const processCanvasImage = async (canvas: HTMLCanvasElement, roi: BoundingBox) => {
    try {
      setIsRecognizing(true);
      setLookupError('');
      setMatchedItem(null);

      const result = await recognize5DigitsFromCanvas(canvas, roi);
      setOcrResult(result);

      const digitsArr = result.code.split('').slice(0, 5);
      while (digitsArr.length < 5) digitsArr.push('0');
      setDigitInputs(digitsArr);

      await checkProductLookup(result.code);
    } catch (err: any) {
      setLookupError('OCR ამოცნობის შეცდომა: ' + (err.message || ''));
    } finally {
      setIsRecognizing(false);
    }
  };

  // Capture frame from active video stream
  const captureAndRecognize = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (video.videoWidth === 0 || video.videoHeight === 0) {
      setCameraError('კამერა ჯერ არ არის მზად, გთხოვთ დაელოდოთ გამოსახულებას');
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Central ROI: 65% width, 28% height
    const roiWidth = Math.floor(canvas.width * 0.65);
    const roiHeight = Math.floor(canvas.height * 0.28);
    const roiX = Math.floor((canvas.width - roiWidth) / 2);
    const roiY = Math.floor((canvas.height - roiHeight) / 2);

    await processCanvasImage(canvas, {
      x: roiX,
      y: roiY,
      width: roiWidth,
      height: roiHeight,
    });
  };

  // Test mode: render realistic sample 5 digits to verify real ONNX inference without physical webcam
  const runSampleOcrTest = async () => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Background
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const roiWidth = 360;
    const roiHeight = 100;
    const roiX = (canvas.width - roiWidth) / 2;
    const roiY = (canvas.height - roiHeight) / 2;

    // White paper note in the center
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 2;
    ctx.fillRect(roiX, roiY, roiWidth, roiHeight);
    ctx.strokeRect(roiX, roiY, roiWidth, roiHeight);

    // Draw 5 distinct handwritten-style digits (e.g. 1 0 0 0 1)
    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 58px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const sample = '10001';
    const slotW = roiWidth / 5;
    for (let i = 0; i < 5; i++) {
      ctx.fillText(sample[i], roiX + i * slotW + slotW / 2, roiY + roiHeight / 2);
    }

    await processCanvasImage(canvas, {
      x: roiX,
      y: roiY,
      width: roiWidth,
      height: roiHeight,
    });
  };

  // Upload an image file to test OCR on real user photos/scans
  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !canvasRef.current) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new Image();
      img.onload = async () => {
        const canvas = canvasRef.current!;
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, 0, 0);

        // Treat whole image or center 80% as ROI
        await processCanvasImage(canvas, {
          x: Math.floor(img.width * 0.1),
          y: Math.floor(img.height * 0.1),
          width: Math.floor(img.width * 0.8),
          height: Math.floor(img.height * 0.8),
        });
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  const checkProductLookup = async (code: string) => {
    if (!/^\d{5}$/.test(code)) {
      setLookupError('კოდი უნდა იყოს ზუსტად 5-ნიშნა რიცხვი (10000-99999)');
      setMatchedItem(null);
      return;
    }

    try {
      setLookupError('');
      const found = await invokeIpc<any>('products:lookupCode', { code });
      if (found) {
        setMatchedItem(found);
      } else {
        setMatchedItem(null);
        setLookupError(`კოდით "${code}" პროდუქტი ვერ მოიძებნა`);
      }
    } catch (err: any) {
      setLookupError(err.message || 'ძებნის შეცდომა');
    }
  };

  // When seller edits a digit manually in the 5 boxes
  const handleDigitChange = (index: number, val: string) => {
    const clean = val.replace(/\D/g, '').slice(-1);
    const updated = [...digitInputs];
    updated[index] = clean;
    setDigitInputs(updated);

    const fullCode = updated.join('');
    if (fullCode.length === 5) {
      checkProductLookup(fullCode);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-2xl w-full max-h-[92vh] flex flex-col p-4 sm:p-6 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
        
        {/* Hidden canvas & file inputs for offline OCR processing */}
        <canvas ref={canvasRef} className="hidden" />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleFileUpload}
        />

        {/* Header */}
        <div className="flex justify-between items-center border-b border-slate-800 pb-3 mb-3 shrink-0">
          <div className="flex items-center space-x-2">
            <div className="p-1.5 sm:p-2 bg-emerald-600/20 text-emerald-400 border border-emerald-600/40 rounded-xl">
              <Camera className="w-4 h-4 sm:w-5 sm:h-5" />
            </div>
            <div>
              <h3 className="text-sm sm:text-base font-bold text-white">ვებკამერით 5-ნიშნა კოდის ამოცნობა (Offline ONNX OCR)</h3>
              <p className="text-[10px] sm:text-[11px] text-slate-400">მიიტანეთ ხელით დაწერილი 5-ნიშნა კოდი მწვანე ჩარჩოსთან</p>
            </div>
          </div>

          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Modal Body */}
        <div className="overflow-y-auto flex-1 pr-1 space-y-3 min-h-0">

          {/* Camera Selector & Tools Bar */}
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center space-x-2">
              <span className="text-slate-400 font-medium">კამერა:</span>
              {devices.length > 0 ? (
                <select
                  value={selectedDeviceId}
                  onChange={(e) => setSelectedDeviceId(e.target.value)}
                  className="px-2.5 py-1 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
                >
                  {devices.map((d, idx) => (
                    <option key={d.deviceId || idx} value={d.deviceId}>
                      {d.label || `კამერა #${idx + 1}`}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-amber-400 font-mono text-[10px] sm:text-[11px] bg-amber-950/40 px-2 py-0.5 rounded border border-amber-800/40">
                  Pending Hardware Verification
                </span>
              )}
            </div>

            <div className="flex items-center space-x-2">
              <button
                type="button"
                onClick={() => setShowThresholdPreview(!showThresholdPreview)}
                className={`px-2.5 py-1 rounded-lg border text-xs font-semibold flex items-center space-x-1 cursor-pointer transition-colors ${
                  showThresholdPreview
                    ? 'bg-emerald-950/60 text-emerald-300 border-emerald-700'
                    : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                }`}
              >
                <SlidersHorizontal className="w-3.5 h-3.5" />
                <span>კონტრასტის ხედი</span>
              </button>
            </div>
          </div>

          {/* Video / ROI Viewport */}
          <div className="relative bg-slate-950 rounded-2xl overflow-hidden border border-slate-800 flex items-center justify-center h-44 sm:h-56 md:h-60 shadow-inner shrink-0">
            {cameraError ? (
              <div className="text-center p-4 sm:p-6 text-slate-400 max-w-md">
                <AlertCircle className="w-8 h-8 sm:w-10 sm:h-10 text-amber-500 mx-auto mb-2" />
                <p className="text-xs sm:text-sm font-semibold text-slate-200">{cameraError}</p>
                <p className="text-[11px] sm:text-xs text-slate-400 mt-1 mb-3">
                  ტესტირებისთვის შეგიძლიათ ატვირთოთ ფოტო ან გაუშვათ სატესტო 5-ნიშნა კოდის ამოცნობა:
                </p>
                <div className="flex items-center justify-center space-x-2.5 sm:space-x-3">
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded-lg border border-slate-600 flex items-center space-x-1.5 cursor-pointer transition-colors"
                  >
                    <Upload className="w-3.5 h-3.5 text-emerald-400" />
                    <span>ფოტოს ატვირთვა</span>
                  </button>
                  <button
                    type="button"
                    onClick={runSampleOcrTest}
                    className="px-3 py-1.5 bg-emerald-700 hover:bg-emerald-600 text-white text-xs font-bold rounded-lg border border-emerald-500 flex items-center space-x-1.5 cursor-pointer transition-colors"
                  >
                    <Play className="w-3.5 h-3.5" />
                    <span>ONNX ტესტი</span>
                  </button>
                </div>
              </div>
            ) : (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />

                {/* ROI Guideline Overlay with 5 slots */}
                <div className="absolute inset-0 pointer-events-none flex items-center justify-center">
                  <div className="w-[65%] h-[40%] border-2 border-emerald-400/80 rounded-2xl shadow-[0_0_20px_rgba(16,185,129,0.3)] bg-emerald-500/5 backdrop-blur-[0.5px] flex flex-col justify-between p-2">
                    <div className="flex justify-between items-center text-[10px] text-emerald-300 font-mono font-bold uppercase tracking-wider">
                      <span>ხელნაწერი 5 ციფრი</span>
                      <span className="flex items-center space-x-1">
                        <Scan className="w-3 h-3 animate-pulse" />
                        <span>ONNX MODEL</span>
                      </span>
                    </div>

                    {/* 5 digit slot boxes */}
                    <div className="grid grid-cols-5 gap-1.5 h-12 sm:h-16">
                      {[1, 2, 3, 4, 5].map((slot) => (
                        <div
                          key={slot}
                          className="border border-dashed border-emerald-400/50 rounded-lg flex items-center justify-center text-xs font-mono text-emerald-400/70 bg-slate-950/20"
                        >
                          #{slot}
                        </div>
                      ))}
                    </div>

                    <div className="text-[9px] text-slate-400 text-center">
                      მოათავსეთ კოდი ჩარჩოს შუაში
                    </div>
                  </div>
                </div>

                {/* Optional Binarized Otsu Preview thumbnail in corner */}
                {showThresholdPreview && ocrResult?.processedImageUri && (
                  <div className="absolute bottom-2 right-2 border-2 border-emerald-500 rounded-lg overflow-hidden shadow-lg bg-black">
                    <img
                      src={ocrResult.processedImageUri}
                      alt="Binarized Threshold"
                      className="w-28 sm:w-32 h-12 sm:h-14 object-contain"
                    />
                    <div className="text-[9px] text-center bg-emerald-950/80 text-emerald-300 font-mono">
                      Otsu Binarized
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Capture Action Button */}
          <div>
            {!cameraError && (
              <button
                type="button"
                disabled={isRecognizing}
                onClick={captureAndRecognize}
                className="w-full py-2.5 sm:py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-extrabold text-xs sm:text-sm rounded-xl transition-all shadow-lg shadow-emerald-900/40 flex items-center justify-center space-x-2 cursor-pointer"
              >
                <Sparkles className="w-4 h-4" />
                <span>{isRecognizing ? 'ამოცნობა მიმდინარეობს...' : 'კადრის გადაღება და ამოცნობა'}</span>
              </button>
            )}

            {cameraError && (
              <button
                type="button"
                disabled={isRecognizing}
                onClick={runSampleOcrTest}
                className="w-full py-2.5 sm:py-3 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-extrabold text-xs sm:text-sm rounded-xl transition-all shadow-lg shadow-emerald-900/40 flex items-center justify-center space-x-2 cursor-pointer"
              >
                <Play className="w-4 h-4" />
                <span>{isRecognizing ? 'ამოცნობა მიმდინარეობს...' : 'სატესტო 5-ნიშნა კოდის გაშვება (ONNX)'}</span>
              </button>
            )}
          </div>

          {/* 5 Recognized Editable Digits */}
          <div className="bg-slate-950 p-3 sm:p-4 rounded-2xl border border-slate-800 space-y-2.5">
            <div className="flex justify-between items-center">
              <span className="text-[11px] sm:text-xs font-bold text-slate-300 uppercase tracking-wider">
                ამოცნობილი 5-ნიშნა კოდი (შესაძლებელია ჩასწორება):
              </span>
              {ocrResult && (
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold border tabular-nums ${
                  ocrResult.confidence >= 75
                    ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800'
                    : 'bg-amber-950/60 text-amber-400 border-amber-800'
                }`}>
                  სანდოობა: {ocrResult.confidence}%
                </span>
              )}
            </div>

            {/* Low confidence advisory alert */}
            {ocrResult && ocrResult.confidence < 70 && (
              <div className="text-[10px] sm:text-[11px] text-amber-300 bg-amber-950/40 border border-amber-800/50 px-2.5 py-1 rounded-lg flex items-center space-x-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                <span>ამოცნობის სანდოობა დაბალია (&lt;70%). გთხოვთ გადაამოწმოთ და საჭიროების შემთხვევაში ხელით შეასწოროთ 5-ნიშნა კოდი.</span>
              </div>
            )}

            <div className="flex justify-center space-x-2 sm:space-x-3">
              {digitInputs.map((d, idx) => (
                <input
                  key={idx}
                  type="text"
                  maxLength={1}
                  value={d}
                  onChange={(e) => handleDigitChange(idx, e.target.value)}
                  placeholder="0"
                  className="w-10 h-12 sm:w-12 sm:h-14 text-center text-xl sm:text-2xl font-black bg-slate-900 border-2 border-slate-700 focus:border-emerald-500 rounded-xl text-white font-mono shadow-inner focus:outline-none"
                />
              ))}
            </div>

            {lookupError && (
              <div className="text-xs text-amber-400 flex items-center justify-center space-x-1.5 pt-0.5">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{lookupError}</span>
              </div>
            )}
          </div>

          {/* Matched Product Preview & Confirmation Button */}
          {matchedItem && (
            <div className="bg-emerald-950/30 border border-emerald-800/60 p-3 sm:p-4 rounded-2xl flex items-center justify-between animate-in fade-in slide-in-from-bottom-2 gap-2">
              <div className="flex items-center space-x-2.5 sm:space-x-3 min-w-0">
                <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-slate-950 border border-emerald-700/50 flex items-center justify-center text-emerald-400 shrink-0">
                  <ShoppingBag className="w-5 h-5 sm:w-6 sm:h-6" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs sm:text-sm font-extrabold text-white truncate">{matchedItem.product.name}</div>
                  <div className="text-[11px] sm:text-xs text-slate-300 truncate">
                    ვარიანტი: <span className="text-emerald-300 font-bold">{matchedItem.variant.variant_name}</span> &bull; 
                    მარაგი: <span className="font-bold text-white tabular-nums">{matchedItem.variant.stock_quantity} ც</span>
                  </div>
                  <div className="text-[11px] sm:text-xs font-extrabold text-emerald-400 mt-0.5 tabular-nums">
                    ფასი: {formatTetri(matchedItem.variant.price_override_tetri ?? matchedItem.product.base_price_tetri)}
                  </div>
                </div>
              </div>

              {/* Strict Requirement: confirmation by seller required */}
              <button
                type="button"
                onClick={() => {
                  onConfirmProduct(matchedItem.product, matchedItem.variant, matchedItem.code_used);
                  onClose();
                }}
                className="px-3.5 sm:px-5 py-2 sm:py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white font-extrabold text-xs rounded-xl shadow-lg shadow-emerald-900/40 transition-colors cursor-pointer flex items-center space-x-1.5 shrink-0"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>დადასტურება</span>
              </button>
            </div>
          )}

        </div>

      </div>
    </div>
  );
};
