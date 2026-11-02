# StorePOS — Build და Release (დეველოპერისთვის)

## 1. მოთხოვნები

- Windows 10/11 x64 (ინსტალერი იწყობა Windows-ზე).
- Node.js ≥ 22.13 (შემოწმებულია Node 26.13 / npm 12.2), Git.
- ინტერნეტი საჭიროა მხოლოდ პირველ `npm ci`-ზე და პირველ build-ზე (Electron-ისა და NSIS-ის ჩამოტვირთვა cache-ში). შემდეგ ყველაფერი offline მუშაობს.
- **რეპოზიტორია არ განათავსო OneDrive-ის სინქრონიზებულ საქაღალდეში build-ისთვის**: `node_modules` (~1 GB) და `release/` OneDrive-ს გადატვირთავს და build-ის დროს ფაილებს ბლოკავს.

## 2. ბრძანებები

```bash
npm ci                       # ზუსტი dependency-ები lockfile-იდან (Windows-ის native პაკეტების ჩათვლით)
npm test                     # 96 unit/integration ტესტი
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
| `resources/models/mnist.onnx` | OCR მოდელი |
| `resources/icons/` | იკონები |
| Electron 45 runtime | `StorePOS.exe` და Chromium ფაილები |

React, Vite, Tailwind, Express, TypeScript — მხოლოდ build-ისთვის (`devDependencies`) და ინსტალერში არ ხვდება. ერთადერთი runtime dependency: `onnxruntime-web`.

დაცვა build-ის დონეზე: production CSP (`vite.config.ts`), Electron fuses (`electron-builder.yml`: RunAsNode off, NODE_OPTIONS/--inspect off, asar integrity, მხოლოდ asar), DevTools გამორთული packaged პროგრამაში.

## 4. Release-ის ჩამონათვალი

1. `package.json` → `version` გაზრდა; ბაზის ცვლილება — მხოლოდ **ახალი** მიგრაციით.
2. `npm ci && npm test && npm run lint`.
3. `npm run dist:win`.
4. ინსტალერის შემოწმება (ყოველთვის **იზოლირებული პროფილით** — არასდროს გაუშვა სატესტოდ `StorePOS.exe` `--user-data-dir`-ის გარეშე, თორემ ის რეალურ `%APPDATA%\StorePOS`-ში შექმნის ბაზას):
   ```bash
   StorePOS-Setup-X.Y.Z.exe /S /D=C:\StorePOS-test\app
   node e2e/desktop-acceptance.mjs --exe C:\StorePOS-test\app\StorePOS.exe --data C:\StorePOS-test\profile --out C:\StorePOS-test\report
   node e2e/load-test.mjs --exe C:\StorePOS-test\app\StorePOS.exe --data C:\StorePOS-test\load --out C:\StorePOS-test\load-report
   ```
   განახლების ტესტი წინა ვერსიის მონაცემებით: `e2e/upgrade/` (M12-ისთვის მზა სკრიპტი; ახალი ვერსიებისთვის — წინა რელიზის ინსტალერით შექმნილი პროფილი).
   ბოლოს: `"C:\StorePOS-test\app\Uninstall StorePOS.exe" /S /currentuser`.
5. SHA-256: `Get-FileHash release\StorePOS-Setup-X.Y.Z.exe`.
6. განაახლე `docs/release/*` (შედეგები, ჰეში, ცნობილი შეზღუდვები).
7. Git tag `vX.Y.Z`.

## 5. Code signing (ჯერ არ არის)

ინსტალერი ხელმოუწერელია → SmartScreen-ის გაფრთხილება. ხელმოწერისთვის საჭიროა Code Signing სერტიფიკატი (OV/EV); electron-builder-ში — `win.signtoolOptions` / `CSC_LINK` + `CSC_KEY_PASSWORD` გარემოს ცვლადები. სერტიფიკატის ფაილი და პაროლი რეპოზიტორიაში არასდროს.
