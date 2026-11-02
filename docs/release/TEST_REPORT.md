# Test Report — StorePOS V1.0

გარემო: Windows 11 Pro 10.0.26200 x64; Node 26.13 (ტესტები), Electron 45.1.0 (პროგრამა); კოდი `c825b1b`.

## 1. როგორ გავუშვა

```bash
npm ci
npm test                      # unit + integration (Node test runner, tsx)
npm run lint                  # TypeScript
npm run dist:win              # ინსტალერი → release/StorePOS-Setup-1.0.0.exe
node e2e/desktop-acceptance.mjs --exe "<StorePOS.exe>" --data "<ცარიელი საქაღალდე>" --out "<ანგარიშის საქაღალდე>"
node e2e/load-test.mjs        --exe "<StorePOS.exe>" --data "<ცარიელი საქაღალდე>" --out "<ანგარიშის საქაღალდე>"
```

E2E სკრიპტები **ყოველთვის** იყენებენ ცალკე პროფილს (`--user-data-dir`) და არასდროს ეხებიან რეალურ `%APPDATA%\StorePOS`-ს; პროფილი, რომელშიც უკვე არის ბაზა, უარყოფილია.

## 2. შედეგები

| ნაკრები | ფაილი | შედეგი |
|---|---|---|
| Unit + integration | `src/**/*.test.ts` (13 ფაილი) | **96/96** |
| ფინანსები და FIFO | `src/main/domain/v1Accounting.test.ts` | 20/20 |
| უსაფრთხოება (IPC-ის გავლით) | `src/main/ipc/security.test.ts` | 6/6 |
| Backup/Restore/Reset | `src/main/domain/v1Backup.test.ts` | 7/7 |
| პროდუქტები/ფოტოები/კატალოგი | `src/main/domain/v1Products.test.ts` | 6/6 |
| OCR | `src/main/domain/ocrService.test.ts` | 6/6 |
| M8/M11/M12 ტესტები (Google AI) | `productionReliability`, `m11Regression`, `m12DebtAndAccounting`, `realStoreSimulation`, `storeScenarios`, `SmartDigitInput` … | ყველა გადის Windows-ზე |
| Desktop acceptance (დაყენებული პროგრამა) | `e2e/desktop-acceptance.mjs` | **28/28** |
| M12 → V1.0 განახლება (დაყენებული პროგრამა) | `e2e/upgrade/*` | **15/15** |
| დატვირთვა და შეჯერება (დაყენებული პროგრამა) | `e2e/load-test.mjs` | **16/16** |
| თავდაპირველი აუდიტი F1–F13 | `e2e/audit/verify-findings.mts` | **0/13 მეორდება** |

M12-ის კოდზე Windows-ზე იყო 44/52; გამოსწორდა: OCR ×4 (`buf.buffer`), Restore `EBUSY`, Linux-ის `/tmp` გზა, reset ტესტი (არასწორ ბაზას აკოპირებდა), `localStorage` Node-ში.

## 3. ინსტალერის შემოწმება (Windows 11)

| ნაბიჯი | შედეგი |
|---|---|
| Build, ინსტალერის შიგთავსი | ✅ `app.asar` 17.8 MB: UI, main/preload, onnxruntime-web (Node + SIMD WASM); dev/Cloud პაკეტები არ არის |
| ჩუმი ინსტალაცია (`/S /D=`) | ✅ 15 წმ; exe, resources, მოდელი, uninstaller |
| Desktop და Start Menu shortcut | ✅ სწორ exe-ზე |
| Windows-ის პროგრამების სია | ✅ „StorePOS 1.0.0“ |
| გახსნა, SQLite, პირველი Owner, პროდუქტი, გაყიდვა | ✅ (acceptance) |
| დახურვა, ხელახლა გახსნა, მონაცემები | ✅ |
| ზემოდან ინსტალაცია არსებული მონაცემებით | ✅ 2 პროდუქტი, 4 გაყიდვა, 255.00 ₾ — უცვლელი |
| ძველი ვერსიის (M12) მონაცემებით გახსნა | ✅ 15/15 |
| Offline | ✅ 0 ქსელური მოთხოვნა; ინტერნეტზე ნავიგაცია დაბლოკილია |
| Uninstall | ✅ პროგრამა, shortcut-ები, რეესტრი წაიშალა; მონაცემები დარჩა |
| Windows 10 | ⏳ არ შემოწმებულა |

## 4. UI (ემულაცია, 8 ეკრანი × 10 კომბინაცია)

1280×720, 1366×768, 1920×1080, 2560×1440 (100%); 1366×768 125%; 1920×1080 125/150/175%; 2560×1440 150/175% — გვერდის ჰორიზონტალური/ვერტიკალური გადავსება არ არის, ჰედერის 8-ვე ჩანართი ჩანს. ეკრანის სურათები: `docs/release/screenshots/`. ხელით არ შემოწმებულა: ფიზიკური მონიტორები, ახალი დიალოგების ყველა ველი.
