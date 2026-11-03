# StorePOS — Build და Release (დეველოპერისთვის)

## 1. მოთხოვნები

- Windows 10/11 x64 (ინსტალერი იწყობა Windows-ზე).
- Node.js ≥ 22.13 (შემოწმებულია Node 26.13 / npm 12.2), Git.
- ინტერნეტი საჭიროა მხოლოდ პირველ `npm ci`-ზე და პირველ build-ზე (Electron-ისა და NSIS-ის ჩამოტვირთვა cache-ში). შემდეგ ყველაფერი offline მუშაობს.
- **რეპოზიტორია არ განათავსო OneDrive-ის სინქრონიზებულ საქაღალდეში build-ისთვის**: `node_modules` (~1 GB) და `release/` OneDrive-ს გადატვირთავს და build-ის დროს ფაილებს ბლოკავს.

## 2. ბრძანებები

```bash
npm ci                       # ზუსტი dependency-ები lockfile-იდან (Windows-ის native პაკეტების ჩათვლით)
npm test                     # 129 unit/integration ტესტი
npm run lint                 # TypeScript (tsc --noEmit)
npm run dist:win             # vite build + esbuild (main/preload) + electron-builder NSIS
```

შედეგი: `release/StorePOS-Setup-<version>.exe` (~124 MB) და `release/win-unpacked/`.

შენიშვნები:
- npm 12 აფრთხილებს, რომ `electron-winstaller`, `esbuild`, `protobufjs`-ის install-script-ები არ გაეშვა — build-ისთვის არცერთი არ არის საჭირო.
- Electron-ის binary (`npm run dev:electron`, E2E დეველოპმენტის build-ზე) საჭიროებს: `node node_modules/electron/install.js`.
- დეველოპმენტი ბრაუზერში: `npm run dev` → `http://127.0.0.1:3000` (იგივე სერვისები HTTP-ით; მხოლოდ loopback). მონაცემები: `%APPDATA%\StorePOS` ან `STORE_DATA_DIR`.

## 3. რა შედის ინსტალერში

| ნაწილი | შიგთავსი |
|---|---|
| `resources/app.asar` (~17.8 MB) | `dist/` (UI), `dist-electron/main.cjs` + `preload.cjs`, `onnxruntime-web` (Node entry + SIMD WASM) და მისი dependency-ები |
| `resources/models/handwriting-digits.onnx` | OCR მოდელი (CC BY-SA 3.0, ბარათი: `resources/models/README.md`, `model-card.json`) |
| `resources/icons/` | იკონები |
| Electron 45 runtime | `StorePOS.exe` და Chromium ფაილები |

React, Vite, Tailwind, Express, TypeScript — მხოლოდ build-ისთვის (`devDependencies`) და ინსტალერში არ ხვდება. ერთადერთი runtime dependency: `onnxruntime-web`.

დაცვა build-ის დონეზე: production CSP (`vite.config.ts`), Electron fuses (`electron-builder.yml`: RunAsNode off, NODE_OPTIONS/--inspect off, asar integrity, მხოლოდ asar), DevTools გამორთული packaged პროგრამაში.

## 4. Release-ის ჩამონათვალი

1. `package.json` → `version` გაზრდა; ბაზის ცვლილება — მხოლოდ **ახალი** მიგრაციით.
2. `npm ci && npm test && npm run lint`.
3. `npm run dist:win`.
4. პროგრამის შემოწმება: ყოველთვის **იზოლირებული პროფილით**. არასდროს გაუშვა სატესტოდ `StorePOS.exe` `--user-data-dir`-ის გარეშე, თორემ ის რეალურ `%APPDATA%\StorePOS`-ში შექმნის ან გახსნის ბაზას. E2E ნაკრებები `release\win-unpacked\StorePOS.exe`-ზე (იგივე ფაილები, რაც ინსტალერშია):
   ```bash
   node e2e/desktop-acceptance.mjs --exe release\win-unpacked\StorePOS.exe --data <ცარიელი> --out <ანგარიში>
   node e2e/hardware-readiness.mjs --exe ... ; node e2e/restart-test.mjs --exe ... ; node e2e/dr-restore-test.mjs --exe ...
   node e2e/load-test.mjs --exe ... ; node e2e/soak-test.mjs --exe ... --minutes 120
   ```
   სატესტო ფანჯრები ეკრანის მიღმა გადადის, რომ ვინმემ შემთხვევით არ დახუროს. ხილვადისთვის: `STOREPOS_E2E_VISIBLE=1`.
   M12-ის მონაცემების განახლება: `e2e/upgrade/`.
5. **ინსტალერის ტესტი იმ კომპიუტერზე, სადაც StorePOS უკვე დაყენებულია** (მაგ. მაღაზიის): მხოლოდ **სატესტო იდენტობით** (`StorePOS-Test`, სხვა appId, საქაღალდე და რეესტრი; ბრძანება: `e2e/installer-upgrade-test.mjs`-ის თავში). ნამდვილი იდენტობის ინსტალერი იმავე appId-ით ჯერ არსებულ ინსტალაციას წაშლის. ის მხოლოდ სუფთა სატესტო კომპიუტერზე ან მაღაზიის რეალური განახლებისთვის გამოიყენე. სატესტო ინსტალერები ინსტალაციის საქაღალდის **გარეთ** შეინახე (electron-builder-ის „გაშვებული პროგრამის“ შემოწმება ყველა პროცესს ეძებს, რომლის მისამართი ინსტალაციის საქაღალდის სახელით იწყება).
   build mirror-ში (robocopy `/MIR`) სატესტო build-ის საქაღალდე `release/` შიგნით უნდა იყოს, თორემ სინქრონიზაცია წაშლის.
6. SHA-256: `Get-FileHash release\StorePOS-Setup-X.Y.Z.exe`.
7. განაახლე `docs/release/*` (შედეგები, ჰეში, ცნობილი შეზღუდვები), `CHANGELOG.md`, `docs/release/RELEASE_CHECKLIST.md`.
8. Git tag `vX.Y.Z` (მხოლოდ საბოლოო რელიზზე, Owner-ის თანხმობით).

## 5. OCR მოდელი: სწავლება და შეფასება (`scripts/ocr/`, ინსტალერში არ შედის)

მონაცემები რეპოზიტორიაში **არ** ინახება (ზომა, ლიცენზია). მოკლე გზაზე (Windows-ის 260-სიმბოლოიანი ზღვარი) Python-ის venv PyTorch-ით (CPU):

```bash
node scripts/ocr/fetch-datasets.mjs <datasets>            # MNIST + UCI pendigits, SHA-256 შემოწმებით
npx tsx scripts/ocr/make-training-set.ts --data <datasets> --out <set> --kind iso --shard 0 --shards 4 --repeat 5   # ×4 shard
npx tsx scripts/ocr/make-training-set.ts --data <datasets> --out <set> --kind seg --shard 0 --shards 2 --codes 2400  # ×2 shard
npx tsx scripts/ocr/make-training-set.ts --data <datasets> --out <set> --kind val
python -I scripts/ocr/train/train_digits.py --data <set> --out <model dir> --epochs 8
npx tsx scripts/ocr/eval-model.ts --data <datasets> --writers val --model <model dir>/handwriting-digits.onnx
npx tsx scripts/ocr/benchmark.ts --data <datasets> --set dev --n 600 --conditions random,user-case,touching ...
```

წესები:
- `--set test` / `--writers test` (pendigits-ის 14 დამოუკიდებელი ავტორი, MNIST test) მხოლოდ საბოლოო ანგარიშისთვისაა. ზღვრებს ან მოდელს მის მიხედვით **არ** ვარჩევთ.
- რეალური ნიმუშები (დიაგნოსტიკიდან შენახული): `npx tsx scripts/ocr/photo-benchmark.ts --dir <საქაღალდე>`. ცვლილებამდე და ცვლილების შემდეგ ერთსა და იმავე ნიმუშებზე; ნახევარი დამოუკიდებელ ტესტად რჩება.
- ძველი მოდელი შედარებისთვის: `scripts/ocr/models/mnist-8.onnx` (ONNX Model Zoo, MIT). RC2-ის ამოცნობა: `scripts/ocr/lib/rc2Engine.ts`.

## 6. Code signing (ჯერ არ არის)

ინსტალერი ხელმოუწერელია → SmartScreen-ის გაფრთხილება. ხელმოწერისთვის საჭიროა Code Signing სერტიფიკატი (OV/EV); electron-builder-ში — `win.signtoolOptions` / `CSC_LINK` + `CSC_KEY_PASSWORD` გარემოს ცვლადები. სერტიფიკატის ფაილი და პაროლი რეპოზიტორიაში არასდროს.
