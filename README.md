# StorePOS

სრულიად offline Windows სალარო და მაღაზიის მართვის პროგრამა ერთი მრავალპროფილიანი ქართული მაღაზიისთვის (სათამაშოები, ტანსაცმელი, ფეხსაცმელი, საყოფაცხოვრებო ნივთები, აქსესუარები).

- სალარო: შტრიხკოდის სკანერი, 5-ნიშნა კოდი, ხელნაწერი კოდის offline OCR, ნაღდი / ნისია / შერეული გადახდა, Owner-ის ფასდაკლება.
- პროდუქცია: ვარიანტები (ზომა/ფერი), საკუთარი კოდი და მარაგი, ფოტოები, არქივი.
- მარაგი FIFO თვითღირებულებით; ნისიები; დაბრუნება და გაცვლა ისტორიიდან; ფინანსები თბილისის დროით.
- Owner / Seller როლები სერვერის დონეზე, PIN-ის დაცვა, ყოველდღიური ავტომატური და USB სარეზერვო ასლები.
- Electron 45 + React 19 + SQLite (`node:sqlite`); ინტერნეტი, ღრუბელი და Node.js-ის ცალკე ინსტალაცია არ სჭირდება.

## დოკუმენტაცია

| | |
|---|---|
| ინსტალაცია | [docs/WINDOWS_INSTALLATION.md](docs/WINDOWS_INSTALLATION.md) |
| მომხმარებლის სახელმძღვანელო | [docs/USER_GUIDE_KA.md](docs/USER_GUIDE_KA.md) |
| განახლება / ახალ კომპიუტერზე გადატანა | [docs/UPDATE_GUIDE.md](docs/UPDATE_GUIDE.md) |
| Release Readiness (V1.0 RC1) | [docs/release/RELEASE_READINESS.md](docs/release/RELEASE_READINESS.md) |
| უსაფრთხოება / ფინანსები / Backup / ტესტები | [docs/release/](docs/release/) |
| აპარატურის სტატუსი (სკანერი, კამერა, DATECS DP-150) | [docs/HARDWARE_STATUS.md](docs/HARDWARE_STATUS.md) |
| ცნობილი შეზღუდვები | [docs/KNOWN_LIMITATIONS.md](docs/KNOWN_LIMITATIONS.md) |
| არქიტექტურა / OCR | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), [docs/OFFLINE_OCR.md](docs/OFFLINE_OCR.md) |
| Build და Release | [docs/BUILD_AND_RELEASE.md](docs/BUILD_AND_RELEASE.md) |

## დეველოპმენტი

```bash
npm ci
npm test            # unit + integration
npm run lint        # TypeScript
npm run dev         # ბრაუზერში, http://127.0.0.1:3000
npm run dist:win    # Windows ინსტალერი → release/
```

რეალური მაღაზიის მონაცემები (`store.db`, `.posbackup`, ფოტოები) რეპოზიტორიაში არასდროს ინახება — ისინი `%APPDATA%\StorePOS`-შია.
