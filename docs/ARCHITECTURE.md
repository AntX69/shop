# StorePOS — არქიტექტურა (V1.0)

## 1. მიმოხილვა

StorePOS არის ერთ კომპიუტერზე მომუშავე, სრულიად offline Electron პროგრამა. ყველა მონაცემი და ბიზნესლოგიკა არის **main process**-ში; renderer (React UI) ბაზას ან ფაილურ სისტემას ვერ ხედავს და მხოლოდ ერთი IPC არხით მუშაობს.

```
Renderer (React 19 + Tailwind 4, CSP, sandbox, contextIsolation)
   │  window.electronAPI.invoke(channel, payload, token)      ← preload: მხოლოდ invoke
   ▼
ipcMain 'api:ipc'  — გამგზავნის შემოწმება (მხოლოდ მთავარი ფანჯრის საკუთარი გვერდი)
   ▼
handlers.ts — არხების ცხრილი: public / user / owner; სესიის შემოწმება; Seller-ის პასუხების ფილტრი
   ▼
Domain services
   ├── AuthService       PIN (PBKDF2), lockout, სესიები (sessions.ts)
   ├── ProductsService   პროდუქტები, ვარიანტები, კოდები, არქივი, ფოტოები (productImages.ts)
   ├── PosService        ფასწარმოება ბაზიდან, ფასდაკლება, გადახდა, FIFO ჩამოწერა
   ├── ReturnsService    დაბრუნება, გაცვლა, FIFO ფენების აღდგენა
   ├── CustomerService   კლიენტები, ნისიები, დაფარვის განაწილება, კორექციები
   ├── InventoryService  შევსება, კორექცია, მოძრაობები
   ├── FinanceService    პერიოდის ანგარიში (Asia/Tbilisi), ხარჯები, ფასდაკლებები, CSV
   ├── BackupService     .posbackup, scheduler-ის ლოგიკა, retention, USB, restore, განულება
   └── OcrService        ONNX (onnxruntime-web WASM) ხელნაწერი ციფრებისთვის
   ▼
node:sqlite (SQLite 3.53, WAL, synchronous=FULL, foreign_keys=ON)
   %APPDATA%\StorePOS\data\store.db  +  images\  +  backups\
```

Main process ასევე აკეთებს: დღიური backup-ის scheduler (`backupScheduler.ts`), `storepos-img://` პროტოკოლი ფოტოებისთვის, ქსელის სრული დაბლოკვა, ნავიგაციის/ნებართვების შეზღუდვა, Windows-ის ფაილის/საქაღალდის დიალოგები (`setNativeHost`).

`server.ts` — მხოლოდ დეველოპმენტისთვის (`npm run dev`): იგივე `handleIpcMessage` HTTP-ით (`127.0.0.1:3000`), ფოტოები `/storepos-img/`-ით. დაყენებულ პროგრამაში არ გამოიყენება.

## 2. ტრანზაქციები და idempotency

- ყველა ცვლილება `runInTransaction`-ში (`BEGIN IMMEDIATE`, ჩადგმულზე SAVEPOINT); შეცდომა → სრული rollback.
- გაყიდვა, დაბრუნება, გაცვლა, დაფარვა, ჩამოწერა იღებს `idempotency_key`-ს (UNIQUE index). იგივე გასაღებით განმეორებული მოთხოვნა აბრუნებს პირველ შედეგს; სხვა შიგთავსით — შეცდომა. UI ინახავს გასაღებს ერთი ოპერაციის განმეორებისთვის და ახალს ქმნის შემდეგი ოპერაციისთვის.

## 3. ფული და დრო

- ყველა თანხა — **მთელი თეთრი** (INTEGER). ვალიდაცია (`validation.ts`) უარყოფს წილადს, NaN-ს, ტექსტს.
- `allocateProportionally` (კალათის ფასდაკლების გაყოფა) და `proratedLineAmount` (ნაწილობრივი დაბრუნება) — BigInt, ჯამი ყოველთვის ზუსტი.
- დრო ინახება UTC ISO-თი; პერიოდები, ჩეკის ნომრის თარიღი (`RCP-YYYYMMDD-XXXX`) და ხარჯის თარიღი — Asia/Tbilisi-ის კალენდარული დღით (`src/shared/time.ts`).

## 4. მონაცემთა ბაზა (სქემა v6)

| ცხრილი | დანიშნულება |
|---|---|
| `users` | Owner/Seller, PIN ჰეში + salt, `failed_pin_attempts`, `locked_until` |
| `categories`, `products`, `product_variants`, `product_codes`, `product_images` | კატალოგი; კოდი UNIQUE; ფოტო — ფაილის სახელი |
| `inventory_lots` | FIFO ფენები (`remaining_quantity`, `unit_cost_tetri` ან NULL = უცნობი) |
| `inventory_movements` | მარაგის ყოველი ცვლილების ისტორია |
| `sales`, `sale_items` | ჩეკი: `subtotal`/`discount`/`total`, ნაღდი, ხურდა, ნისია, გაცვლის კრედიტი; ხაზზე საფასო ფასი და გადახდილი თანხა |
| `sale_item_lots` | რომელი ფენიდან გავიდა თითოეული ცალი (და რამდენი დაბრუნდა) |
| `returns`, `return_items` | დაბრუნება/გაცვლა: ნისიის შემცირება + კრედიტი + ნაღდი; ხაზზე მდგომარეობა და უკუგატარებული COGS |
| `customers`, `debt_repayments`, `debt_repayment_allocations`, `debt_adjustments` | ნისიები: დაფარვა და მისი განაწილება ჩეკებზე, გაუქმება, ჩამოწერა |
| `expenses`, `audit_logs`, `system_error_logs`, `app_settings`, `schema_migrations` | |
| view `sale_debt_balances` | თითოეული ნისიის ჩეკის ნაშთი = ნისია − დაფარვები (გაუქმებულის გარეშე) − დაბრუნების შემცირება − ჩამოწერა |

ინვარიანტები (ტესტებით და load-test-ით მოწმდება): `stock_quantity` = ფენების ნაშთების ჯამი; ყოველი გაყიდული/დაბრუნებული ცალი მიბმულია ფენაზე; ყოველი ჩეკი = ნაღდი − ხურდა + ნისია + კრედიტი; ყოველი დაბრუნება = ნისიის შემცირება + კრედიტი + ნაღდი.

**მიგრაციები** (`migrations.ts`): ვერსიონირებული, თითოეული ტრანზაქციაში; არსებული ბაზის განახლებამდე — `store.db.before_migration_vN_*.bak`. v6 აკეთებს ძველი მონაცემების backfill-ს და მარაგი/FIFO შეჯერებას. დაწყებისას inline (base64) ფოტოები გადადის ფაილებში.

## 5. აღრიცხვის წესები (მოკლედ)

- გაყიდვა: ფასი ბაზიდან; ფასდაკლება მხოლოდ Owner-ის; FIFO — ყველაზე ძველი ფენა პირველი.
- დაბრუნება: გადახდილი ფასით; ჯერ ამ ჩეკის ნისია, შემდეგ ნაღდი; ვარგისი → თავის ფენაში იმავე ფასით; დაზიანებული → დანაკარგი.
- გაცვლა: კრედიტი ჯერ ახალ ნივთს ფარავს, ნარჩენი — ძველ ნისიას, შემდეგ ნაღდი; სხვაობის გადახდა აშკარად.
- დაფარვა: გაყიდვა არ არის; ზოგადი — FIFO ჩეკებზე; კონკრეტული — მხოლოდ იმავე კლიენტის ჩეკზე.
- სრული აღწერა: `docs/release/FINANCIAL_RECONCILIATION.md`.

## 6. უსაფრთხოება და Backup

იხ. `docs/release/SECURITY_VALIDATION.md` და `docs/release/BACKUP_RESTORE_VERIFICATION.md`.

## 7. კოდის სტრუქტურა

```
src/main/app.ts               Electron main: ფანჯარა, hardening, IPC, პროტოკოლი, scheduler
src/main/db/                  კავშირი, ტრანზაქციები, მიგრაციები
src/main/domain/              სერვისები + ტესტები
src/main/ipc/handlers.ts      არხები, წვდომა, ფილტრი
src/main/fiscal/              DP-150-ის საზღვარი (არ არის ინტეგრირებული)
src/preload/index.ts          contextBridge: invoke
src/renderer/                 React გვერდები და კომპონენტები
src/shared/                   ტიპები, ფული, დრო, PIN ჰეში
e2e/                          ტესტები რეალურ StorePOS.exe-ზე (DevTools protocol)
```
