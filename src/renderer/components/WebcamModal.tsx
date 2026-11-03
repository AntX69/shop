/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Webcam Offline OCR Modal Component (M6, RC3).
 * Reads a handwritten 5-digit store code strictly offline with a local ONNX model. The code can be
 * written anywhere inside the green frame: the digits are found where they are, the frame on
 * screen is exactly the area recognised, doubtful digits are marked, unreadable ones are left
 * empty and every digit stays editable. The product is added only after the seller confirms it.
 * Handles one or several cameras (the choice is remembered on this computer), missing or busy
 * cameras and blocked camera access with plain instructions, photo import and a diagnostics
 * panel for testing.
 *
 * Camera lifecycle: a stream is opened only while the dialog is open and is stopped when it
 * closes, when another camera is chosen, or when the stream arrives after the dialog was
 * already closed (no camera is ever left switched on).
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Product, ProductVariant } from '../../shared/types.ts';
import { formatTetri } from '../../shared/money.ts';
import type { OcrResult } from '../../shared/ocr.ts';
import { invokeIpc } from '../api/ipcClient.ts';
import { canvasPng, checkPhotoFile, PHOTO_MAX_PIXELS, readRegion, recognizeRegion, regionPng, type BoundingBox, type RegionImage } from '../utils/offlineOcr.ts';
import { frameInVideo, OCR_FRAME } from '../utils/cameraRoi.ts';
import { compositeCanvas, drawCodeCrop } from '../utils/ocrDiagnostics.ts';
import { SmartDigitInput } from './SmartDigitInput.tsx';
import { OcrDiagnosticsBoundary, OcrDiagnosticsPanel } from './OcrDiagnosticsPanel.tsx';
import {
  Camera,
  RotateCw,
  CheckCircle2,
  AlertCircle,
  X,
  Sparkles,
  Scan,
  ShoppingBag,
  Microscope,
  Upload,
  Play
} from 'lucide-react';

interface WebcamModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirmProduct: (product: Product, variant: ProductVariant, code: string) => void;
}

const CAMERA_CHOICE_KEY = 'storepos_ocr_camera';
const DIAGNOSTICS_KEY = 'storepos_ocr_diagnostics';
const EMPTY_DIGITS = ['', '', '', '', ''];
const NO_FLAGS = [false, false, false, false, false];

function readSetting(key: string): string {
  try { return globalThis.localStorage?.getItem(key) || ''; } catch { return ''; }
}

function saveSetting(key: string, value: string): void {
  try {
    if (value) globalThis.localStorage?.setItem(key, value);
    else globalThis.localStorage?.removeItem(key);
  } catch {}
}

function stopStream(stream: MediaStream | null): void {
  stream?.getTracks().forEach((t) => t.stop());
}

/** Turns a getUserMedia failure into an instruction the seller can act on. */
export function describeCameraError(err: any): string {
  const name = String(err?.name || '');
  if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
    return 'კამერაზე წვდომა დაბლოკილია. Windows-ის პარამეტრებში (Settings → Privacy & security → Camera) ჩართეთ „Camera access“ და „Let desktop apps access your camera“, შემდეგ დააჭირეთ „ხელახლა ცდა“.';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return 'კამერა ვერ ჩაირთო: სავარაუდოდ მას სხვა პროგრამა იყენებს (მაგ. Camera, Zoom, Skype, Teams). დახურეთ ის პროგრამა და დააჭირეთ „ხელახლა ცდა“.';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return 'კამერა ვერ მოიძებნა. შეაერთეთ კამერა და დააჭირეთ „ხელახლა ცდა“.';
  }
  return `კამერის ჩართვა ვერ მოხერხდა${name ? ` (${name})` : ''}. დააჭირეთ „ხელახლა ცდა“ ან შეიყვანეთ კოდი ხელით.`;
}

export const WebcamModal: React.FC<WebcamModalProps> = ({
  isOpen,
  onClose,
  onConfirmProduct,
}) => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const codeCropRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  // The camera asked for ('' = system default) and the one actually streaming.
  const [requestedDeviceId, setRequestedDeviceId] = useState<string>('');
  const [activeDeviceId, setActiveDeviceId] = useState<string>('');
  // One camera session per opening (and per "retry"); 0 while the dialog is closed.
  const [cameraSession, setCameraSession] = useState<number>(0);
  const sessionCounterRef = useRef<number>(0);
  const [cameraError, setCameraError] = useState<string>('');
  const [cameraNotice, setCameraNotice] = useState<string>('');
  const [isRecognizing, setIsRecognizing] = useState<boolean>(false);
  const [ocrResult, setOcrResult] = useState<OcrResult | null>(null);
  const [region, setRegion] = useState<RegionImage | null>(null);
  const [frameInfo, setFrameInfo] = useState<{ canvas: HTMLCanvasElement; roi: BoundingBox } | null>(null);
  const [source, setSource] = useState<string>('');
  const [roundTripMs, setRoundTripMs] = useState<number | null>(null);

  // 5 editable digits ('' = not recognised, the seller types it) and the ones to check
  const [digitInputs, setDigitInputs] = useState<string[]>(EMPTY_DIGITS);
  const [flagged, setFlagged] = useState<boolean[]>(NO_FLAGS);

  // Matched product lookup
  const [matchedItem, setMatchedItem] = useState<{
    product: Product;
    variant: ProductVariant;
    code_used: string;
  } | null>(null);
  const [lookupError, setLookupError] = useState<string>('');
  // Only the answer for the code currently in the boxes may be shown (older lookups are dropped).
  const latestLookupRef = useRef<string>('');

  // Diagnostics panel (remembered on this computer) and test samples
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(() => readSetting(DIAGNOSTICS_KEY) === '1');
  const [expectedCode, setExpectedCode] = useState<string>('');
  const [saveNotice, setSaveNotice] = useState<string>('');

  // A video element that (re)appears gets the running stream.
  const setVideoElement = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el && streamRef.current && el.srcObject !== streamRef.current) {
      el.srcObject = streamRef.current;
    }
  }, []);

  // Every opening starts clean: no code, product or message from the previous use.
  useEffect(() => {
    if (!isOpen) {
      setCameraSession(0);
      return;
    }
    setOcrResult(null);
    setRegion(null);
    setFrameInfo(null);
    setDigitInputs(EMPTY_DIGITS);
    setFlagged(NO_FLAGS);
    setMatchedItem(null);
    setLookupError('');
    setCameraNotice('');
    setSaveNotice('');
    setRoundTripMs(null);
    latestLookupRef.current = '';
    setRequestedDeviceId(readSetting(CAMERA_CHOICE_KEY));
    setCameraSession(++sessionCounterRef.current);
    // Load the model on the OCR thread now, so the first recognition does not wait for it.
    invokeIpc('ocr:isModelReady').catch(() => {});
  }, [isOpen]);

  // Open the camera while the dialog is open; stop it on close, on camera change or on retry.
  useEffect(() => {
    if (!isOpen || cameraSession === 0) return;
    let cancelled = false;
    let stream: MediaStream | null = null;

    const refreshDevices = async () => {
      try {
        const list = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
        if (!cancelled) setDevices(list);
      } catch {}
    };

    const start = async () => {
      setCameraError('');
      setCameraNotice('');
      if (!navigator.mediaDevices?.getUserMedia) {
        setCameraError('ამ კომპიუტერზე კამერა მიუწვდომელია. შეიყვანეთ კოდი ხელით ან გამოიყენეთ შტრიხკოდის სკანერი.');
        return;
      }
      // Full HD when the camera has it: more pixels per pen stroke.
      const video: MediaTrackConstraints = { width: { ideal: 1920 }, height: { ideal: 1080 } };
      if (requestedDeviceId) video.deviceId = { exact: requestedDeviceId };
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      } catch (err: any) {
        if (cancelled) return;
        // The remembered camera is not connected now: use the default one this time (the
        // choice stays saved, so it is used again once it is plugged back in).
        if (requestedDeviceId && (err?.name === 'OverconstrainedError' || err?.name === 'NotFoundError')) {
          setRequestedDeviceId('');
          return;
        }
        setCameraError(describeCameraError(err));
        await refreshDevices();
        return;
      }
      if (cancelled) {
        // The dialog was closed (or the camera changed) while the camera was starting.
        stopStream(stream);
        return;
      }
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      const track = stream.getVideoTracks()[0];
      track?.addEventListener('ended', () => {
        if (!cancelled) setCameraError('კამერა გაითიშა. შეაერთეთ ის თავიდან და დააჭირეთ „ხელახლა ცდა“.');
      });
      setActiveDeviceId(track?.getSettings().deviceId || requestedDeviceId);
      // Camera names are listed only once access has been granted.
      await refreshDevices();
    };

    start();
    const onDeviceChange = () => { refreshDevices(); };
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);

    return () => {
      cancelled = true;
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
      stopStream(stream);
      if (streamRef.current === stream) streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
    };
  }, [isOpen, requestedDeviceId, cameraSession]);

  // The read code area under the digit cells.
  useEffect(() => {
    if (codeCropRef.current && region && ocrResult && ocrResult.digits.length) drawCodeCrop(codeCropRef.current, region, ocrResult, 56);
  }, [region, ocrResult]);

  const chooseCamera = (deviceId: string) => {
    saveSetting(CAMERA_CHOICE_KEY, deviceId);
    setActiveDeviceId(deviceId);
    setRequestedDeviceId(deviceId);
  };

  const retryCamera = () => setCameraSession(++sessionCounterRef.current);

  const toggleDiagnostics = () => {
    const next = !showDiagnostics;
    setShowDiagnostics(next);
    saveSetting(DIAGNOSTICS_KEY, next ? '1' : '');
  };

  // Recognise `roi` of the canvas through the offline pipeline.
  const processCanvasImage = async (canvas: HTMLCanvasElement, roi: BoundingBox, label: string) => {
    try {
      setIsRecognizing(true);
      setLookupError('');
      setMatchedItem(null);
      setCameraNotice('');
      setSaveNotice('');
      const t0 = performance.now();
      const reg = readRegion(canvas, roi);
      const result = await recognizeRegion(reg, showDiagnostics);
      setRoundTripMs(Math.round(performance.now() - t0));
      setOcrResult(result);
      setRegion(reg);
      setFrameInfo({ canvas, roi });
      setSource(label);

      if (result.status === 'rejected') {
        latestLookupRef.current = '';
        setDigitInputs(EMPTY_DIGITS);
        setFlagged(NO_FLAGS);
        setLookupError(`კოდი ვერ ამოიცნო: ${result.message || ''} კოდის შეყვანა ხელითაც შეგიძლიათ.`);
        return;
      }
      // Unreadable positions stay empty for the seller; a digit is never invented.
      const digitsArr = EMPTY_DIGITS.map((_, i) => (/^\d$/.test(result.digits[i]?.digit || '') ? result.digits[i].digit : ''));
      setDigitInputs(digitsArr);
      setFlagged(EMPTY_DIGITS.map((_, i) => !!result.digits[i] && (result.digits[i].doubtful || !result.digits[i].digit)));

      if (digitsArr.every((d) => d !== '')) {
        await checkProductLookup(digitsArr.join(''));
      } else {
        latestLookupRef.current = '';
        const missing = digitsArr.map((d, i) => (d ? null : `#${i + 1}`)).filter(Boolean).join(', ');
        setLookupError(`ციფრ(ებ)ი ${missing} ვერ ამოიცნო. შეიყვანეთ ხელით ან გადაიღეთ თავიდან.`);
      }
    } catch (err: any) {
      setLookupError('OCR ამოცნობის შეცდომა: ' + (err.message || ''));
    } finally {
      setIsRecognizing(false);
    }
  };

  // Capture frame from active video stream: exactly the part inside the green frame.
  const captureAndRecognize = async () => {
    if (!videoRef.current || !canvasRef.current) return;
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (video.videoWidth === 0 || video.videoHeight === 0) {
      setCameraNotice('კამერა ჯერ არ არის მზად. დაელოდეთ გამოსახულებას და სცადეთ თავიდან.');
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // The video element fills the preview inside its border; the frame is positioned in the same
    // box, so both are measured from it.
    const box = video.getBoundingClientRect();
    const roi = frameInVideo({ width: box.width, height: box.height }, { width: video.videoWidth, height: video.videoHeight });
    const label = devices.find((d) => d.deviceId === activeDeviceId)?.label || 'კამერა';
    await processCanvasImage(canvas, roi, `${label}, ${video.videoWidth}×${video.videoHeight}`);
  };

  // Test mode: printed sample code to check the model without a camera.
  const runSampleOcrTest = async () => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const roiWidth = 360;
    const roiHeight = 100;
    const roiX = (canvas.width - roiWidth) / 2;
    const roiY = (canvas.height - roiHeight) / 2;

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(roiX, roiY, roiWidth, roiHeight);

    ctx.fillStyle = '#0f172a';
    ctx.font = 'bold 58px monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    const sample = '10001';
    const slotW = roiWidth / 5;
    for (let i = 0; i < 5; i++) {
      ctx.fillText(sample[i], roiX + i * slotW + slotW / 2, roiY + roiHeight / 2);
    }

    await processCanvasImage(canvas, { x: roiX, y: roiY, width: roiWidth, height: roiHeight }, 'სატესტო ნიმუში 10001');
  };

  // A photo of a handwritten code (JPG/PNG), through exactly the same pipeline.
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !canvasRef.current) return;
    const problem = await checkPhotoFile(file);
    if (problem) {
      setLookupError(`ფოტოს გახსნა ვერ მოხერხდა: ${problem}`);
      return;
    }
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      setLookupError('ფოტოს გახსნა ვერ მოხერხდა: ფაილი დაზიანებულია');
      return;
    }
    if (bitmap.width * bitmap.height > PHOTO_MAX_PIXELS) {
      bitmap.close();
      setLookupError('ფოტოს გახსნა ვერ მოხერხდა: 40 მეგაპიქსელზე დიდია');
      return;
    }
    const canvas = canvasRef.current;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    await processCanvasImage(canvas, { x: 0, y: 0, width: canvas.width, height: canvas.height }, `ფოტო: ${file.name}`);
  };

  const saveSample = async (changeFolder: boolean) => {
    if (!ocrResult || !region) return;
    try {
      setSaveNotice('ინახება...');
      const composite = compositeCanvas(ocrResult, region, frameInfo, `StorePOS OCR — ${new Date().toLocaleString('ka-GE')} — ${source}`);
      const { diagnostics, ...summary } = ocrResult;
      const report = {
        savedAt: new Date().toISOString(),
        source,
        expectedCode,
        enteredCode: digitInputs.join(''),
        region: { width: region.width, height: region.height },
        frame: frameInfo ? { width: frameInfo.canvas.width, height: frameInfo.canvas.height, roi: frameInfo.roi } : null,
        roundTripMs,
        result: summary,
        diagnostics: diagnostics ? {
          thresholds: diagnostics.thresholds,
          strokeWidth: diagnostics.strokeWidth,
          digitHeight: diagnostics.digitHeight,
          ruledLinePixels: diagnostics.ruledLinePixels,
          codeBox: diagnostics.codeBox,
          components: diagnostics.components,
        } : null,
      };
      const saved = await invokeIpc<{ folder: string; files: string[] } | null>('ocr:saveSample', {
        regionPng: await regionPng(region),
        diagnosticPng: await canvasPng(composite),
        report: JSON.stringify(report, null, 2),
        expectedCode,
        changeFolder,
      });
      setSaveNotice(saved ? `შენახულია: ${saved.files[0]}` : 'შენახვა გაუქმდა');
    } catch (err: any) {
      setSaveNotice(`შენახვა ვერ მოხერხდა: ${err?.message || ''}`);
    }
  };

  const checkProductLookup = async (code: string) => {
    latestLookupRef.current = code;
    if (!/^\d{5}$/.test(code)) {
      setLookupError('კოდი უნდა იყოს ზუსტად 5-ნიშნა რიცხვი (10000-99999)');
      setMatchedItem(null);
      return;
    }

    try {
      setLookupError('');
      const found = await invokeIpc<any>('products:lookupCode', { code });
      if (latestLookupRef.current !== code) return; // the digits changed meanwhile
      if (found) {
        setMatchedItem(found);
      } else {
        setMatchedItem(null);
        setLookupError(`კოდით "${code}" პროდუქტი ვერ მოიძებნა`);
      }
    } catch (err: any) {
      if (latestLookupRef.current !== code) return;
      setLookupError(err.message || 'ძებნის შეცდომა');
    }
  };

  const currentCode = digitInputs.join('');
  // Digits still marked: doubtful or unreadable, and not edited by the seller since.
  const toCheck = (ocrResult?.digits || [])
    .map((d, i) => ({ position: i + 1, digit: d.digit, confidence: d.confidence }))
    .filter((d) => flagged[d.position - 1]);
  const canConfirm = !!matchedItem && digitInputs.every((d) => d !== '') && matchedItem.code_used === currentCode;
  const showsResult = !!ocrResult && ocrResult.status !== 'rejected';

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/85 backdrop-blur-md z-50 flex items-center justify-center p-3 sm:p-4 select-none">
      <div className="bg-slate-900 border border-slate-700 rounded-3xl max-w-2xl w-full max-h-[92vh] flex flex-col p-4 sm:p-6 shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">

        {/* Hidden canvas & file inputs for offline OCR processing */}
        <canvas ref={canvasRef} className="hidden" />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg"
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
              <p className="text-[10px] sm:text-[11px] text-slate-400">მიიტანეთ ხელით დაწერილი 5-ნიშნა კოდი მწვანე ჩარჩოში, ნებისმიერ ადგილას</p>
            </div>
          </div>

          <button onClick={onClose} aria-label="დახურვა" className="text-slate-400 hover:text-white transition-colors cursor-pointer">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Scrollable Modal Body */}
        <div className="overflow-y-auto flex-1 pr-1 space-y-3 min-h-0">

          {/* Camera Selector & Tools Bar */}
          <div className="flex items-center justify-between text-xs">
            <div className="flex items-center space-x-2 min-w-0">
              <span className="text-slate-400 font-medium shrink-0">კამერა:</span>
              {devices.length > 0 ? (
                <select
                  value={activeDeviceId || requestedDeviceId || devices[0]?.deviceId || ''}
                  onChange={(e) => chooseCamera(e.target.value)}
                  aria-label="კამერის არჩევა"
                  className="max-w-[16rem] truncate px-2.5 py-1 bg-slate-950 border border-slate-700 rounded-lg text-white text-xs focus:outline-none focus:border-emerald-500"
                >
                  {devices.map((d, idx) => (
                    <option key={d.deviceId || idx} value={d.deviceId}>
                      {d.label || `კამერა #${idx + 1}`}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-amber-400 font-mono text-[10px] sm:text-[11px] bg-amber-950/40 px-2 py-0.5 rounded border border-amber-800/40">
                  კამერა არ მოიძებნა
                </span>
              )}
            </div>

            <div className="flex items-center space-x-2 shrink-0">
              <button
                type="button"
                onClick={toggleDiagnostics}
                aria-pressed={showDiagnostics}
                className={`px-2.5 py-1 rounded-lg border text-xs font-semibold flex items-center space-x-1 cursor-pointer transition-colors ${
                  showDiagnostics
                    ? 'bg-sky-950/60 text-sky-300 border-sky-700'
                    : 'bg-slate-950 text-slate-400 border-slate-800 hover:text-white'
                }`}
              >
                <Microscope className="w-3.5 h-3.5" />
                <span>დიაგნოსტიკა</span>
              </button>
            </div>
          </div>

          {/* Video / frame viewport */}
          <div ref={previewRef} className="relative bg-slate-950 rounded-2xl overflow-hidden border border-slate-800 flex items-center justify-center h-44 sm:h-56 md:h-60 shadow-inner shrink-0">
            {cameraError ? (
              <div className="text-center p-4 sm:p-6 text-slate-400 max-w-md">
                <AlertCircle className="w-8 h-8 sm:w-10 sm:h-10 text-amber-500 mx-auto mb-2" />
                <p className="text-xs sm:text-sm font-semibold text-slate-200">{cameraError}</p>
                <p className="text-[11px] sm:text-xs text-slate-400 mt-1 mb-3">
                  შეგიძლიათ ასევე ატვირთოთ კოდის ფოტო ან გაუშვათ სატესტო 5-ნიშნა კოდის ამოცნობა:
                </p>
                <div className="flex items-center justify-center flex-wrap gap-2.5 sm:gap-3">
                  <button
                    type="button"
                    onClick={retryCamera}
                    className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-white text-xs font-bold rounded-lg border border-slate-600 flex items-center space-x-1.5 cursor-pointer transition-colors"
                  >
                    <RotateCw className="w-3.5 h-3.5 text-emerald-400" />
                    <span>ხელახლა ცდა</span>
                  </button>
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
                  ref={setVideoElement}
                  autoPlay
                  playsInline
                  muted
                  className="w-full h-full object-cover"
                />

                {/* The frame is exactly the area recognised (see utils/cameraRoi.ts). */}
                <div
                  data-testid="ocr-frame"
                  className="absolute pointer-events-none border-2 border-emerald-400/90 rounded-xl shadow-[0_0_20px_rgba(16,185,129,0.3)] bg-emerald-500/5 flex flex-col justify-between p-1.5"
                  style={{
                    left: `${OCR_FRAME.left * 100}%`,
                    top: `${OCR_FRAME.top * 100}%`,
                    width: `${OCR_FRAME.width * 100}%`,
                    height: `${OCR_FRAME.height * 100}%`,
                  }}
                >
                  <div className="flex justify-between items-center text-[10px] text-emerald-300 font-mono font-bold uppercase tracking-wider">
                    <span className="bg-slate-950/50 rounded px-1">ხელნაწერი 5-ნიშნა კოდი</span>
                    <span className="flex items-center space-x-1 bg-slate-950/50 rounded px-1">
                      <Scan className="w-3 h-3 animate-pulse" />
                      <span>OFFLINE</span>
                    </span>
                  </div>
                  <div className="text-[9px] text-slate-200 text-center">
                    <span className="bg-slate-950/50 rounded px-1">ციფრები ერთ ხაზზე, ჩარჩოს ნებისმიერ ადგილას</span>
                  </div>
                </div>
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

            {cameraNotice && (
              <div className="mt-2 text-[11px] text-amber-300 flex items-center justify-center space-x-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{cameraNotice}</span>
              </div>
            )}
          </div>

          {/* 5 Recognized Editable Digits */}
          <div className="bg-slate-950 p-3 sm:p-4 rounded-2xl border border-slate-800 space-y-2.5">
            <div className="flex justify-between items-center">
              <span className="text-[11px] sm:text-xs font-bold text-slate-300 uppercase tracking-wider">
                ამოცნობილი 5-ნიშნა კოდი (შესაძლებელია ჩასწორება):
              </span>
              {showsResult && ocrResult && (
                <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold border tabular-nums ${
                  ocrResult.status === 'ok' && toCheck.length === 0
                    ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800'
                    : 'bg-amber-950/60 text-amber-400 border-amber-800'
                }`}>
                  სანდოობა: {ocrResult.confidence}%
                </span>
              )}
            </div>

            {showsResult && ocrResult && ocrResult.digits.length > 0 && region && (
              <div className="flex justify-center">
                <canvas ref={codeCropRef} aria-label="ამოკითხული კოდის არე" className="max-w-full h-14 rounded border border-slate-700 bg-white" />
              </div>
            )}

            {/* Doubtful digits, per position: one unsure digit is never hidden by a good average */}
            {toCheck.length > 0 && (
              <div className="text-[10px] sm:text-[11px] text-amber-300 bg-amber-950/40 border border-amber-800/50 px-2.5 py-1 rounded-lg flex items-center space-x-2">
                <AlertCircle className="w-3.5 h-3.5 shrink-0 text-amber-400" />
                <span>
                  {`შეამოწმეთ მონიშნული ციფრები: ${toCheck.map((d) => (d.digit ? `#${d.position} („${d.digit}“, ${d.confidence}%)` : `#${d.position} (ვერ ამოიცნო)`)).join(', ')}. შეადარეთ ფურცელს და საჭიროებისას შეასწორეთ.`}
                </span>
              </div>
            )}

            <div className="flex justify-center py-1">
              <SmartDigitInput
                length={5}
                value={currentCode}
                slotValues={digitInputs}
                flagged={flagged}
                autoFocus={true}
                onChange={(code, slots) => {
                  const next = slots ? [...slots] : code.padEnd(5, ' ').split('').map(c => c.trim());
                  // A digit the seller typed is no longer the OCR's doubt.
                  setFlagged((prev) => prev.map((f, i) => f && next[i] === digitInputs[i]));
                  setDigitInputs(next);
                  if (next.every((d) => d !== '')) {
                    checkProductLookup(next.join(''));
                  } else {
                    latestLookupRef.current = '';
                    setMatchedItem(null);
                    setLookupError('');
                  }
                }}
              />
            </div>

            {lookupError && (
              <div className="text-xs text-amber-400 flex items-center justify-center space-x-1.5 pt-0.5 text-center">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{lookupError}</span>
              </div>
            )}
          </div>

          {/* Matched Product Preview & Confirmation Button */}
          {canConfirm && matchedItem && (
            <div className="bg-emerald-950/30 border border-emerald-800/60 p-3 sm:p-4 rounded-2xl space-y-2 animate-in fade-in slide-in-from-bottom-2">
              {toCheck.length > 0 && (
                <div className="text-[11px] text-amber-300 flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>კოდი შეადარეთ ფურცელს: მონიშნული ციფრები საეჭვოა. პროდუქტის არსებობა ამოცნობის სისწორეს არ ადასტურებს.</span>
                </div>
              )}
              <div className="flex items-center justify-between gap-2">
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
            </div>
          )}

          {showDiagnostics && (
            <OcrDiagnosticsBoundary key={ocrResult ? ocrResult.timings.totalMs + ':' + ocrResult.code : 'none'}>
            <OcrDiagnosticsPanel
              result={ocrResult}
              region={region}
              frame={frameInfo}
              source={source}
              roundTripMs={roundTripMs}
              expectedCode={expectedCode}
              onExpectedCode={setExpectedCode}
              onImport={() => fileInputRef.current?.click()}
              onSave={saveSample}
              saveNotice={saveNotice}
              busy={isRecognizing}
            />
            </OcrDiagnosticsBoundary>
          )}

        </div>

      </div>
    </div>
  );
};
