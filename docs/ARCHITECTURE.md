# StorePOS — System Architecture & Technical Specifications

---

## 1. არქიტექტურული მიმოხილვა (High-Level Architecture)

StorePOS შექმნილია როგორც **Dual-Target Desktop Application**, რომელიც მუშაობს:
1. **Electron Production Desktop Runtime-ში:** Electron Main პროცესი + Preload Script + Chromium Renderer.
2. **AI Studio / Web Dev Runtime-ში:** Express Node.js Server + Vite Middlewares + Browser Client.

ეს ორმაგი თავსებადობა მიიღწევა **Unified IPC Client Bridge**-ის (`src/renderer/api/ipcClient.ts`) მეშვეობით:
- თუ არსებობს `window.electronAPI?.invoke`, იძახებს Electron-ის მშობლიურ IPC არხს.
- სხვა შემთხვევაში აგზავნის HTTP POST მოთხოვნას ლოკალურ Express ენდფოინთზე `/api/ipc`.
- ორივე გზა სრულდება ერთსა და იმავე დომენურ სერვისებსა და SQLite მონაცემთა ბაზაზე.

```
[UI Renderer / React 19 + Tailwind v4]
        │
        ▼ (invokeIpc)
[Dual-Target Bridge: ipcClient.ts]
   ├── Desktop: window.electronAPI.invoke(channel, payload)
   └── Web Server: fetch('/api/ipc', { channel, payload })
        │
        ▼
[Central IPC Dispatcher: handlers.ts]
        │
  ├── AuthService (PBKDF2 PIN Salted Hashing & Sessions)
  ├── ProductsService (Products, Variants, Barcodes, 5-Digit Manual Codes, Images)
  ├── PosService (Atomic Checkouts, Receipts, Cash Change, Debts)
  ├── InventoryService (FIFO Lots, Restock, Stock Corrections with Audit)
  ├── CustomerService (Customers CRUD & Debt Repayment Ledger)
  ├── ReturnsService (Returns, Debt Deduction Priority, Exchanges)
  ├── FinanceService (FIFO COGS, Unknown Cost Flags, Expenses, CSV)
  └── BackupService (.posbackup Bundles, SHA-256 Checksum, PRAGMA integrity_check)
        │
        ▼ (runInTransaction / Prepared Statements)
[Node.js 22 Built-in node:sqlite (WAL Mode)]
        │
  data/store.db (18 Relational Tables)
```

---

## 2. ფინანსური სიზუსტე: Integer Tetri პოლიტიკა

ფინანსური გამოთვლებისას `Float` ან `Double` ტიპების გამოყენება კატეგორიულად აკრძალულია დამრგვალების ცდომილებების თავიდან ასაცილებლად.
- **ყველა თანხა ბაზაში და სერვისებში ინახება მთელ თეთრებში (`INTEGER` tetri)**:
  `1.00 GEL = 100 Tetri`.
- გადამყვანი ფუნქციები მოდულში `src/shared/money.ts`:
  - `gelToTetri(gelStringOrNumber)`: უსაფრთხო გარდაქმნა მათემატიკური დამრგვალებით.
  - `formatTetri(tetri)`: ქართული ფორმატირება ლარის სიმბოლოთი: მაგ. `15.50 ₾`.

---

## 3. მონაცემთა ბაზის სქემა (18 SQLite ცხრილი)

1. `users`: მომხმარებლები, როლები (`owner`, `seller`), PBKDF2 ჰეშირებული PIN და მარილი (salt).
2. `categories`: პროდუქციის კატეგორიები.
3. `products`: ძირითადი პროდუქტის ბარათი, საბაზისო ფასი, საბაზისო თვითღირებულება.
4. `product_variants`: ვარიანტები (ზომა, ფერი), ფასის გადაფარვა, მიმდინარე ნაშთი.
5. `product_codes`: შტრიხკოდები და ხელნაწერი 5-ნიშნა კოდები (`10000–99999`).
6. `product_images`: მრავალფოტოიანი გალერეა პროდუქტზე (primary/secondary).
7. `customers`: მყიდველები, საკონტაქტო მონაცემები.
8. `inventory_movements`: მარაგების ყველა მოძრაობის უცვლელი ისტორია (Audit).
9. `inventory_lots`: FIFO პარტიები თვითღირებულების ზუსტი ჩამოწერისთვის.
10. `sales`: გაყიდვების რეესტრი, უნიკალური ნომერი (`RCP-YYYYMMDD-XXXX`), გადახდის მეთოდი (ნაღდი, ნისია, შერეული).
11. `sale_items`: გაყიდული პოზიციები, ფასი, რაოდენობა.
12. `debt_repayments`: ნისიის დაფარვის რეესტრი (აღრიცხავს ფულად შემოდინებას გაყიდვების გაორმაგების გარეშე).
13. `returns`: საქონლის დაბრუნებები და გაცვლები.
14. `return_items`: დაბრუნებული ნივთები.
15. `expenses`: მაღაზიის საოპერაციო ხარჯები (ქირა, კომუნალური, ტრანსპორტი და სხვ.).
16. `audit_logs`: სისტემური აუდიტის ჩანაწერები.
17. `app_settings`: მაღაზიის კონფიგურაცია.
18. `system_error_logs`: შიდა სისტემური შეცდომების ლოგი.

---

## 4. FIFO თვითღირებულება და უცნობი ფასის ინდიკატორი

- გაყიდვისას პროდუქტის თვითღირებულება იანგარიშება FIFO (First-In, First-Out) ლოტების მიხედვით.
- თუ მაღაზიის მფლობელმა პროდუქტის შესყიდვის ფასი არ იცოდა (მაგ. ძველი ნაშთი), ლოტს ენიჭება `unit_cost_tetri = NULL`.
- გაყიდვების ფინანსურ რეპორტში ასეთი შემთხვევა აღინიშნება როგორც **„გაფრთხილება: უცნობი თვითღირებულება“ (`has_unknown_costs = true`)**, რაც იცავს მფლობელს არაზუსტი მოგების დათვლისგან.

---

## 5. დაბრუნების პრიორიტეტი (Debt Deduction Priority)

თუ კლიენტს აქვს მიმდინარე დავალიანება (ნისია) და აბრუნებს ნივთს:
1. თანხა **პირველ რიგში აკლდება მის არსებულ ნისიას**.
2. მხოლოდ ნისიის სრულად განულების შემდეგ გაიცემა დარჩენილი თანხა სალაროდან ნაღდი ფულის სახით.
3. ეს წესი გარანტირებულად იცავს მაღაზიას ფინანსური ზარალისგან.
