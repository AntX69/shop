var Oe=Object.create;var Ee=Object.defineProperty;var be=Object.getOwnPropertyDescriptor;var Ie=Object.getOwnPropertyNames;var Le=Object.getPrototypeOf,ve=Object.prototype.hasOwnProperty;var we=(c,t,e,r)=>{if(t&&typeof t=="object"||typeof t=="function")for(let s of Ie(t))!ve.call(c,s)&&s!==e&&Ee(c,s,{get:()=>t[s],enumerable:!(r=be(t,s))||r.enumerable});return c};var A=(c,t,e)=>(e=c!=null?Oe(Le(c)):{},we(t||!c||!c.__esModule?Ee(e,"default",{value:c,enumerable:!0}):e,c));var C=require("electron"),w=A(require("node:path"),1),x=A(require("node:fs"),1);var me=require("node:sqlite"),D=A(require("node:path"),1),v=A(require("node:fs"),1);var oe=A(require("node:fs"),1);var Ce=[{version:1,name:"001_initial_schema",up:c=>{c.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('owner', 'seller')),
          pin_hash TEXT NOT NULL,
          pin_salt TEXT NOT NULL,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE NOT NULL,
          created_at TEXT NOT NULL
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
          description TEXT,
          base_price_tetri INTEGER NOT NULL,
          base_cost_tetri INTEGER,
          is_active INTEGER NOT NULL DEFAULT 1,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS product_variants (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          variant_name TEXT NOT NULL,
          size TEXT,
          color TEXT,
          price_override_tetri INTEGER,
          cost_override_tetri INTEGER,
          stock_quantity INTEGER NOT NULL DEFAULT 0,
          is_active INTEGER NOT NULL DEFAULT 1
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS product_codes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          variant_id INTEGER NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
          code_type TEXT NOT NULL CHECK(code_type IN ('barcode', 'manual_5digit')),
          code_value TEXT UNIQUE NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_product_codes_value ON product_codes(code_value);
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS product_images (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          is_primary INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          first_name TEXT NOT NULL,
          last_name TEXT,
          phone TEXT,
          address TEXT,
          notes TEXT,
          created_at TEXT NOT NULL
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS inventory_movements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          variant_id INTEGER NOT NULL REFERENCES product_variants(id),
          movement_type TEXT NOT NULL CHECK(movement_type IN ('initial', 'restock', 'sale', 'return', 'exchange', 'correction')),
          quantity_change INTEGER NOT NULL,
          resulting_stock INTEGER NOT NULL,
          unit_cost_tetri INTEGER,
          reason TEXT,
          reference_id TEXT,
          user_id INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS inventory_lots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          variant_id INTEGER NOT NULL REFERENCES product_variants(id),
          initial_quantity INTEGER NOT NULL,
          remaining_quantity INTEGER NOT NULL,
          unit_cost_tetri INTEGER,
          movement_id INTEGER REFERENCES inventory_movements(id),
          created_at TEXT NOT NULL
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS sales (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          receipt_number TEXT UNIQUE NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id),
          customer_id INTEGER REFERENCES customers(id),
          payment_method TEXT NOT NULL CHECK(payment_method IN ('cash', 'debt', 'mixed')),
          total_tetri INTEGER NOT NULL,
          cash_received_tetri INTEGER NOT NULL,
          change_given_tetri INTEGER NOT NULL,
          debt_amount_tetri INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'completed' CHECK(status IN ('completed', 'returned', 'partially_returned')),
          notes TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_sales_receipt ON sales(receipt_number);
        CREATE INDEX IF NOT EXISTS idx_sales_created_at ON sales(created_at);
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS sale_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
          variant_id INTEGER NOT NULL REFERENCES product_variants(id),
          product_name_snap TEXT NOT NULL,
          variant_name_snap TEXT,
          code_snap TEXT,
          quantity INTEGER NOT NULL,
          unit_price_tetri INTEGER NOT NULL,
          unit_cost_tetri INTEGER,
          total_price_tetri INTEGER NOT NULL,
          returned_quantity INTEGER NOT NULL DEFAULT 0
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS debt_repayments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          customer_id INTEGER NOT NULL REFERENCES customers(id),
          sale_id INTEGER REFERENCES sales(id),
          amount_tetri INTEGER NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id),
          payment_method TEXT NOT NULL DEFAULT 'cash',
          notes TEXT,
          created_at TEXT NOT NULL
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS returns (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          sale_id INTEGER NOT NULL REFERENCES sales(id),
          user_id INTEGER NOT NULL REFERENCES users(id),
          return_type TEXT NOT NULL CHECK(return_type IN ('refund', 'exchange')),
          total_refund_tetri INTEGER NOT NULL,
          debt_deduction_tetri INTEGER NOT NULL,
          cash_refund_tetri INTEGER NOT NULL,
          condition TEXT NOT NULL CHECK(condition IN ('resellable', 'damaged')),
          reason TEXT,
          created_at TEXT NOT NULL
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS return_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
          sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
          variant_id INTEGER NOT NULL REFERENCES product_variants(id),
          quantity INTEGER NOT NULL,
          unit_price_tetri INTEGER NOT NULL,
          total_tetri INTEGER NOT NULL
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          category TEXT NOT NULL,
          description TEXT NOT NULL,
          amount_tetri INTEGER NOT NULL,
          user_id INTEGER NOT NULL REFERENCES users(id),
          expense_date TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS audit_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER REFERENCES users(id),
          action TEXT NOT NULL,
          entity TEXT NOT NULL,
          entity_id TEXT,
          details TEXT,
          created_at TEXT NOT NULL
        );
      `),c.exec(`
        CREATE TABLE IF NOT EXISTS app_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `),c.exec(`
        INSERT OR IGNORE INTO app_settings (key, value) VALUES 
        ('store_name', '\u10E9\u10D4\u10DB\u10D8 \u10DB\u10D0\u10E6\u10D0\u10D6\u10D8\u10D0'),
        ('currency', 'GEL'),
        ('timezone', 'Asia/Tbilisi'),
        ('inactivity_lock_minutes', '15');
      `)}},{version:2,name:"system_error_logs",up:c=>{c.exec(`
        CREATE TABLE IF NOT EXISTS system_error_logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER REFERENCES users(id),
          error_source TEXT NOT NULL,
          error_message TEXT NOT NULL,
          stack_trace TEXT,
          severity TEXT NOT NULL DEFAULT 'error',
          created_at TEXT NOT NULL
        );
      `)}},{version:3,name:"idempotency_keys_and_backup_settings",up:c=>{try{c.exec("ALTER TABLE sales ADD COLUMN idempotency_key TEXT;")}catch{}c.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_idempotency ON sales(idempotency_key) WHERE idempotency_key IS NOT NULL;");try{c.exec("ALTER TABLE debt_repayments ADD COLUMN idempotency_key TEXT;")}catch{}c.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_repayments_idempotency ON debt_repayments(idempotency_key) WHERE idempotency_key IS NOT NULL;"),c.exec(`
        INSERT OR IGNORE INTO app_settings (key, value) VALUES 
        ('auto_backup_enabled', '1'),
        ('backup_directory', ''),
        ('last_backup_date', '');
      `)}}];function le(c,t){c.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);let e=c.prepare("SELECT version FROM schema_migrations ORDER BY version ASC").all(),r=new Set(e.map(i=>i.version)),s=Ce.filter(i=>!r.has(i.version));if(s.length!==0){if(t&&t!==":memory:"&&oe.default.existsSync(t))try{c.exec("PRAGMA wal_checkpoint(TRUNCATE);");let i=`${t}.before_migration_v${s[0].version}_${Date.now()}.bak`;oe.default.copyFileSync(t,i),console.log(`[DB Migration] Safety pre-migration backup created: ${i}`)}catch(i){console.warn("[DB Migration Warning] Could not create pre-migration backup:",i)}for(let i of s){c.exec("BEGIN IMMEDIATE;");try{i.up(c),c.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(i.version,i.name,new Date().toISOString()),c.exec("COMMIT;"),console.log(`[DB Migration] Applied migration #${i.version}: ${i.name}`)}catch(n){throw c.exec("ROLLBACK;"),console.error(`[DB Migration Error] Failed at migration #${i.version}: ${i.name}`,n),n}}}}var k=null,Ae="";function V(){if(process.env.STORE_DATA_DIR){let t=D.default.resolve(process.env.STORE_DATA_DIR);return v.default.existsSync(t)||v.default.mkdirSync(t,{recursive:!0}),t}if(process.env.STORE_DB_PATH&&process.env.STORE_DB_PATH!==":memory:"){let t=D.default.dirname(D.default.resolve(process.env.STORE_DB_PATH));return v.default.existsSync(t)||v.default.mkdirSync(t,{recursive:!0}),t}if(process.env.APPDATA){let t=D.default.join(process.env.APPDATA,"StorePOS");return v.default.existsSync(t)||v.default.mkdirSync(t,{recursive:!0}),t}let c=D.default.resolve(process.cwd(),"data");return v.default.existsSync(c)||v.default.mkdirSync(c,{recursive:!0}),c}function ce(){let c=D.default.join(V(),"images");return v.default.existsSync(c)||v.default.mkdirSync(c,{recursive:!0}),c}function pe(){let c=D.default.join(V(),"backups");return v.default.existsSync(c)||v.default.mkdirSync(c,{recursive:!0}),c}function ue(){return process.env.STORE_DB_PATH?process.env.STORE_DB_PATH:D.default.join(V(),"store.db")}function X(c){if(k)return k;let t=c||ue();if(Ae=t,t!==":memory:"){let r=D.default.dirname(t);v.default.existsSync(r)||v.default.mkdirSync(r,{recursive:!0})}let e=new me.DatabaseSync(t);if(e.exec("PRAGMA foreign_keys = ON;"),e.exec("PRAGMA busy_timeout = 5000;"),t!==":memory:"){e.exec("PRAGMA journal_mode = WAL;");let r=process.env.SQLITE_SYNCHRONOUS||"FULL";e.exec(`PRAGMA synchronous = ${r};`)}return le(e,t),k=e,k}function I(){return k||X()}function z(){if(k){try{k.exec("PRAGMA wal_checkpoint(TRUNCATE);")}catch{}k.close(),k=null}}function L(c,t=I()){t.exec("BEGIN IMMEDIATE;");try{let e=c(t);return t.exec("COMMIT;"),e}catch(e){throw t.exec("ROLLBACK;"),e}}var J=A(require("node:crypto"),1);function G(c){return/^\d{4,6}$/.test(c.trim())}function Q(c=16){return J.default.randomBytes(c).toString("hex")}function Y(c,t){let e=c.trim();return J.default.pbkdf2Sync(e,t,1e4,32,"sha256").toString("hex")}function de(c,t,e){if(!c||!t||!e)return!1;let r=Y(c,e);try{return J.default.timingSafeEqual(Buffer.from(r,"hex"),Buffer.from(t,"hex"))}catch{return!1}}var Te=require("node:sqlite");var f=A(require("node:fs"),1),b=A(require("node:path"),1),P=A(require("node:crypto"),1);var $=class{constructor(t=I(),e){this.db=t,this.customDbPath=e}getTargetDbPath(){return this.customDbPath||ue()}checkOwner(t){if(t.role!=="owner")throw new Error("\u10E1\u10D0\u10E0\u10D4\u10D6\u10D4\u10E0\u10D5\u10DD \u10D0\u10E1\u10DA\u10D4\u10D1\u10D8\u10E1 \u10DB\u10D0\u10E0\u10D7\u10D5\u10D8\u10E1 \u10E3\u10E4\u10DA\u10D4\u10D1\u10D0 \u10D0\u10E5\u10D5\u10E1 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1 (Owner)")}getEffectiveBackupDirectory(){try{let t=this.getSettings();if(t.backup_directory&&t.backup_directory.trim()){let e=b.default.resolve(t.backup_directory.trim());return f.default.existsSync(e)||f.default.mkdirSync(e,{recursive:!0}),e}}catch{}return pe()}createBackup(t,e){this.checkOwner(t);let r=this.getTargetDbPath();if(r!==":memory:"&&!f.default.existsSync(r))throw new Error("\u10D1\u10D0\u10D6\u10D8\u10E1 \u10E4\u10D0\u10D8\u10DA\u10D8 \u10D5\u10D4\u10E0 \u10DB\u10DD\u10D8\u10EB\u10D4\u10D1\u10DC\u10D0");let s=this.db.prepare("PRAGMA integrity_check;").get();if(!s||s.integrity_check!=="ok")throw new Error(`\u10D1\u10D0\u10D6\u10D8\u10E1 \u10DB\u10D7\u10DA\u10D8\u10D0\u10DC\u10DD\u10D1\u10D8\u10E1 \u10E8\u10D4\u10EA\u10D3\u10DD\u10DB\u10D0: PRAGMA integrity_check = ${s?.integrity_check||"fail"}`);r!==":memory:"&&this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");let i;r===":memory:"?i=Buffer.from("SQLite format 3\0test_snapshot"):i=f.default.readFileSync(r);let n=P.default.createHash("sha256").update(i).digest("hex"),a=new Date().toISOString(),d=`store_backup_${a.replace(/[:.]/g,"-")}.posbackup`,_=this.db.prepare("SELECT product_id, file_path, is_primary FROM product_images").all().map(g=>{let U="";if(g.file_path.startsWith("data:"))U=g.file_path;else{let F=[b.default.resolve(g.file_path),b.default.join(ce(),b.default.basename(g.file_path)),b.default.join(V(),g.file_path)];for(let B of F)if(f.default.existsSync(B))try{U=`data:image/jpeg;base64,${f.default.readFileSync(B).toString("base64")}`;break}catch{}}return{product_id:g.product_id,file_path:g.file_path,is_primary:g.is_primary,data_base64:U||void 0}}),o=this.getSettings(),p=this.db.prepare("SELECT COUNT(*) as cnt FROM products").get()?.cnt||0,h=this.db.prepare("SELECT COUNT(*) as cnt FROM sales").get()?.cnt||0,l=this.db.prepare("SELECT COUNT(*) as cnt FROM customers").get()?.cnt||0,T=0;try{let g=this.db.prepare(`
        SELECT (
          COALESCE((SELECT SUM(debt_amount_tetri) FROM sales), 0)
          - COALESCE((SELECT SUM(amount_tetri) FROM debt_repayments), 0)
          - COALESCE((SELECT SUM(debt_deduction_tetri) FROM returns), 0)
        ) as total_debt
      `).get();T=Math.max(0,g?.total_debt||0)}catch{}let S={format:"StorePOS-Unified-Backup",version:"1.0",created_at:a,created_by_user_id:t.id,db_checksum_sha256:n,db_size_bytes:i.length,db_base64:i.toString("base64"),images:_,settings:o,stats:{products_count:p,sales_count:h,customers_count:l,total_debt_tetri:T}},y=JSON.stringify(S,null,2),m=Buffer.from(y,"utf-8"),R=P.default.createHash("sha256").update(m).digest("hex"),O=e?b.default.resolve(e):this.getEffectiveBackupDirectory();f.default.existsSync(O)||f.default.mkdirSync(O,{recursive:!0});let N=b.default.join(O,d);f.default.writeFileSync(N,m);try{this.db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('last_backup_date', ?)").run(a)}catch{}return this.db.prepare(`
      INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
      VALUES (?, 'BACKUP_CREATE', 'system', ?, ?, ?)
    `).run(t.id,d,`Created verified backup: ${m.length} bytes, SHA256: ${R.substring(0,16)}..., images: ${_.length}, products: ${p}`,a),{backup_filename:d,filepath:N,size_bytes:m.length,checksum_sha256:R,created_at:a,data_base64:m.toString("base64")}}createEmergencyPreResetBackup(t){try{let e=this.getEffectiveBackupDirectory();return this.createBackup(t,e).filepath}catch(e){return console.warn("[BackupService] Could not create emergency pre-reset backup:",e),""}}restoreBackup(t,e,r){this.checkOwner(t);let s,i=e.trim();i.startsWith("{")?s=Buffer.from(i,"utf-8"):s=Buffer.from(i,"base64");let n=P.default.createHash("sha256").update(s).digest("hex"),a,u=[],d=null,E=!1;try{let l=s.toString("utf-8");if(l.includes("StorePOS-Unified-Backup")){let T=JSON.parse(l);if(T.format!=="StorePOS-Unified-Backup")throw new Error("\u10D0\u10E0\u10D0\u10D7\u10D0\u10D5\u10E1\u10D4\u10D1\u10D0\u10D3\u10D8 \u10E1\u10D0\u10E0\u10D4\u10D6\u10D4\u10E0\u10D5\u10DD \u10D0\u10E1\u10DA\u10D8\u10E1 \u10E4\u10DD\u10E0\u10DB\u10D0\u10E2\u10D8");a=Buffer.from(T.db_base64,"base64");let S=P.default.createHash("sha256").update(a).digest("hex");if(T.db_checksum_sha256&&T.db_checksum_sha256!==S)throw new Error("\u10E1\u10D0\u10E0\u10D4\u10D6\u10D4\u10E0\u10D5\u10DD \u10D0\u10E1\u10DA\u10D8\u10E1 \u10E8\u10D4\u10DB\u10DD\u10EC\u10DB\u10D4\u10D1\u10D8\u10E1 \u10E8\u10D4\u10EA\u10D3\u10DD\u10DB\u10D0: \u10DB\u10DD\u10DC\u10D0\u10EA\u10D4\u10DB\u10D7\u10D0 \u10D1\u10D0\u10D6\u10D8\u10E1 \u10E8\u10D8\u10D3\u10D0 Checksum \u10D0\u10E0 \u10D4\u10DB\u10D7\u10EE\u10D5\u10D4\u10D5\u10D0 (\u10D3\u10D0\u10D6\u10D8\u10D0\u10DC\u10D4\u10D1\u10E3\u10DA\u10D8 \u10DB\u10DD\u10DC\u10D0\u10EA\u10D4\u10DB\u10D4\u10D1\u10D8)");u=T.images||[],d=T.settings||null,E=!0}else a=s}catch(l){if(l.message.includes("Checksum"))throw l;a=s}if(r){let l=P.default.createHash("sha256").update(a).digest("hex");if(r!==n&&r!==l)throw new Error("\u10E1\u10D0\u10E0\u10D4\u10D6\u10D4\u10E0\u10D5\u10DD \u10D0\u10E1\u10DA\u10D8\u10E1 \u10E8\u10D4\u10DB\u10DD\u10EC\u10DB\u10D4\u10D1\u10D8\u10E1 \u10E8\u10D4\u10EA\u10D3\u10DD\u10DB\u10D0: \u10E4\u10D0\u10D8\u10DA\u10D8\u10E1 Checksum \u10D0\u10E0 \u10D4\u10DB\u10D7\u10EE\u10D5\u10D4\u10D5\u10D0 (\u10D3\u10D0\u10D6\u10D8\u10D0\u10DC\u10D4\u10D1\u10E3\u10DA\u10D8 \u10E4\u10D0\u10D8\u10DA\u10D8)")}let _=this.getTargetDbPath();if(_===":memory:")return{success:!0,message:"\u10E2\u10D4\u10E1\u10E2\u10E3\u10E0 \u10DB\u10D4\u10EE\u10E1\u10D8\u10D4\u10E0\u10D4\u10D1\u10D0\u10E8\u10D8 \u10D0\u10E6\u10D3\u10D2\u10D4\u10DC\u10D0 \u10EC\u10D0\u10E0\u10DB\u10D0\u10E2\u10D4\u10D1\u10D8\u10D7 \u10E8\u10D4\u10DB\u10DD\u10EC\u10DB\u10D3\u10D0",restored_stats:{products_count:u.length,sales_count:0,customers_count:0,images_restored:u.length}};let o=`${_}.candidate_${Date.now()}.db`,p=`${_}.before_restore_${Date.now()}.bak`;f.default.writeFileSync(o,a);try{let l=new Te.DatabaseSync(o),T=l.prepare("PRAGMA integrity_check;").get();if(!T||T.integrity_check!=="ok")throw l.close(),f.default.existsSync(o)&&f.default.unlinkSync(o),new Error(`\u10D1\u10D0\u10D6\u10D8\u10E1 \u10E4\u10D0\u10D8\u10DA\u10D8 \u10D3\u10D0\u10D6\u10D8\u10D0\u10DC\u10D4\u10D1\u10E3\u10DA\u10D8\u10D0: PRAGMA integrity_check = ${T?.integrity_check||"fail"}`);let S=["users","products","product_variants","sales","customers"];for(let y of S)if(!l.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(y))throw l.close(),f.default.existsSync(o)&&f.default.unlinkSync(o),new Error(`\u10E1\u10D0\u10E0\u10D4\u10D6\u10D4\u10E0\u10D5\u10DD \u10D0\u10E1\u10DA\u10D8 \u10D0\u10E0\u10D0\u10D7\u10D0\u10D5\u10E1\u10D4\u10D1\u10D0\u10D3\u10D8\u10D0: \u10EA\u10EE\u10E0\u10D8\u10DA\u10D8 "${y}" \u10D5\u10D4\u10E0 \u10DB\u10DD\u10D8\u10EB\u10D4\u10D1\u10DC\u10D0`);l.close()}catch(l){throw f.default.existsSync(o)&&f.default.unlinkSync(o),new Error(`\u10E1\u10D0\u10E0\u10D4\u10D6\u10D4\u10E0\u10D5\u10DD \u10D0\u10E1\u10DA\u10D8\u10E1 \u10D5\u10D0\u10DA\u10D8\u10D3\u10D0\u10EA\u10D8\u10D0 \u10E9\u10D0\u10D8\u10E8\u10D0\u10DA\u10D0: ${l.message}`)}if(f.default.existsSync(_)){try{this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);")}catch{}f.default.copyFileSync(_,p)}z();let h=0;try{f.default.copyFileSync(o,_),f.default.existsSync(o)&&f.default.unlinkSync(o);let l=`${_}-wal`,T=`${_}-shm`;f.default.existsSync(l)&&f.default.unlinkSync(l),f.default.existsSync(T)&&f.default.unlinkSync(T);let S=this.customDbPath?b.default.join(b.default.dirname(this.customDbPath),"images"):ce();f.default.existsSync(S)||f.default.mkdirSync(S,{recursive:!0});for(let g of u)if(g.data_base64&&g.data_base64.startsWith("data:"))try{let U=g.data_base64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);if(U&&U[2]){let F=Buffer.from(U[2],"base64"),B=b.default.join(S,b.default.basename(g.file_path));if(f.default.writeFileSync(B,F),b.default.isAbsolute(g.file_path)&&g.file_path!==B){let j=b.default.dirname(g.file_path);f.default.existsSync(j)||f.default.mkdirSync(j,{recursive:!0}),f.default.writeFileSync(g.file_path,F)}h++}}catch{}let y=X(_);this.db=y;let m=y.prepare("PRAGMA integrity_check;").get();if(!m||m.integrity_check!=="ok")throw new Error("\u10D0\u10E6\u10D3\u10D2\u10D4\u10DC\u10D8\u10E1 \u10E8\u10D4\u10DB\u10D3\u10D2\u10DD\u10DB\u10D8 \u10E8\u10D4\u10DB\u10DD\u10EC\u10DB\u10D4\u10D1\u10D0 \u10E9\u10D0\u10D8\u10E8\u10D0\u10DA\u10D0");let R=y.prepare("SELECT COUNT(*) as cnt FROM products").get()?.cnt||0,O=y.prepare("SELECT COUNT(*) as cnt FROM sales").get()?.cnt||0,N=y.prepare("SELECT COUNT(*) as cnt FROM customers").get()?.cnt||0;return y.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'BACKUP_RESTORE', 'system', ?, ?, ?)
      `).run(t.id,"store.db",`Restored database snapshot successfully. Safety backup: ${b.default.basename(p)}. Restored ${R} products, ${O} sales, ${N} customers.`,new Date().toISOString()),{success:!0,message:"\u10D1\u10D0\u10D6\u10D0 \u10EC\u10D0\u10E0\u10DB\u10D0\u10E2\u10D4\u10D1\u10D8\u10D7 \u10E8\u10D4\u10DB\u10DD\u10EC\u10DB\u10D3\u10D0 (PRAGMA integrity_check: OK) \u10D3\u10D0 \u10D0\u10E6\u10D3\u10D2\u10D0.",restored_stats:{products_count:R,sales_count:O,customers_count:N,images_restored:h}}}catch(l){if(f.default.existsSync(p))try{f.default.copyFileSync(p,_),this.db=X(_)}catch{}throw new Error(`\u10D0\u10E6\u10D3\u10D2\u10D4\u10DC\u10D8\u10E1 \u10E8\u10D4\u10EA\u10D3\u10DD\u10DB\u10D0: ${l.message}`)}}listBackups(t){this.checkOwner(t);let e=this.getEffectiveBackupDirectory();if(!f.default.existsSync(e))return[];let r=f.default.readdirSync(e).filter(i=>i.endsWith(".posbackup")),s=[];for(let i of r){let n=b.default.join(e,i);try{let a=f.default.statSync(n),u=f.default.readFileSync(n,"utf-8"),d=JSON.parse(u),E=P.default.createHash("sha256").update(u).digest("hex"),_=d.format==="StorePOS-Unified-Backup"&&!!d.db_base64;s.push({filename:i,filepath:n,size_bytes:a.size,created_at:d.created_at||a.mtime.toISOString(),checksum_sha256:E,is_valid:_,integrity_status:_?"OK":"INVALID_FORMAT",stats:d.stats})}catch{s.push({filename:i,filepath:n,size_bytes:0,created_at:new Date().toISOString(),checksum_sha256:"",is_valid:!1,integrity_status:"CORRUPTED"})}}return s.sort((i,n)=>new Date(n.created_at).getTime()-new Date(i.created_at).getTime())}verifyBackup(t,e,r){this.checkOwner(t);try{let s;if(r){let d=b.default.join(this.getEffectiveBackupDirectory(),b.default.basename(r));if(!f.default.existsSync(d))return{is_valid:!1,integrity_status:`\u10E4\u10D0\u10D8\u10DA\u10D8 "${r}" \u10D5\u10D4\u10E0 \u10DB\u10DD\u10D8\u10EB\u10D4\u10D1\u10DC\u10D0`};s=f.default.readFileSync(d)}else if(e){let d=e.trim();d.startsWith("{")?s=Buffer.from(d,"utf-8"):s=Buffer.from(d,"base64")}else return{is_valid:!1,integrity_status:"\u10DB\u10DD\u10DC\u10D0\u10EA\u10D4\u10DB\u10D4\u10D1\u10D8 \u10D0\u10E0 \u10D0\u10E0\u10D8\u10E1 \u10DB\u10D8\u10D7\u10D8\u10D7\u10D4\u10D1\u10E3\u10DA\u10D8"};let i=s.toString("utf-8"),n=JSON.parse(i);if(n.format!=="StorePOS-Unified-Backup")return{is_valid:!1,integrity_status:"\u10E3\u10EA\u10DC\u10DD\u10D1\u10D8 \u10E4\u10DD\u10E0\u10DB\u10D0\u10E2\u10D8"};let a=Buffer.from(n.db_base64,"base64"),u=P.default.createHash("sha256").update(a).digest("hex");return n.db_checksum_sha256&&n.db_checksum_sha256!==u?{is_valid:!1,integrity_status:"\u10DB\u10DD\u10DC\u10D0\u10EA\u10D4\u10DB\u10D7\u10D0 \u10D1\u10D0\u10D6\u10D8\u10E1 \u10E8\u10D8\u10D3\u10D0 \u10F0\u10D4\u10E8\u10D8 \u10D3\u10D0\u10D6\u10D8\u10D0\u10DC\u10D4\u10D1\u10E3\u10DA\u10D8\u10D0"}:a.subarray(0,16).toString("utf-8").startsWith("SQLite format 3")?{is_valid:!0,integrity_status:"\u10DB\u10D7\u10DA\u10D8\u10D0\u10DC\u10DD\u10D1\u10D0 \u10D3\u10D0\u10D3\u10D0\u10E1\u10E2\u10E3\u10E0\u10D4\u10D1\u10E3\u10DA\u10D8\u10D0 (SHA-256 + SQLite Valid)",stats:n.stats}:{is_valid:!1,integrity_status:"\u10D0\u10E0\u10D0\u10D5\u10D0\u10DA\u10D8\u10D3\u10E3\u10E0\u10D8 SQLite \u10D1\u10D0\u10D6\u10D0"}}catch(s){return{is_valid:!1,integrity_status:`\u10E8\u10D4\u10EA\u10D3\u10DD\u10DB\u10D0: ${s.message}`}}}checkAndRunDailyBackup(t){try{let e=this.getSettings();if(e.auto_backup_enabled==="0")return!1;let r=e.last_backup_date;if(r){let n=new Date(r).getTime();if((Date.now()-n)/(1e3*60*60)<24)return!1}let s=this.db.prepare("SELECT id, name, role FROM users WHERE role = 'owner' LIMIT 1").get();if(!s)return!1;let i=t||{id:s.id,name:s.name,role:"owner",is_active:1,created_at:new Date().toISOString()};return this.createBackup(i),console.log("[BackupService] Automated daily backup executed successfully."),!0}catch(e){return console.warn("[BackupService] Automated daily backup failed:",e),!1}}logSystemError(t,e,r,s="error",i){try{let n=this.sanitizeSensitiveText(e),a=r?this.sanitizeSensitiveText(r):null,u=new Date().toISOString();this.db.prepare(`
        INSERT INTO system_error_logs (user_id, error_source, error_message, stack_trace, severity, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(i||null,t,n,a,s,u)}catch(n){console.error("Failed to write to system_error_logs table:",n)}}sanitizeSensitiveText(t){return t.replace(/pin["':\s]+[0-9]+/gi,"pin: [REDACTED]").replace(/token["':\s]+[a-f0-9]+/gi,"token: [REDACTED]").replace(/password["':\s]+[^\s,}]+/gi,"password: [REDACTED]")}getErrorLogs(t=100){try{return this.db.prepare(`
        SELECT sel.*, u.name as user_name
        FROM system_error_logs sel
        LEFT JOIN users u ON sel.user_id = u.id
        ORDER BY sel.id DESC
        LIMIT ?
      `).all(t)}catch{return[]}}clearErrorLogs(t){this.checkOwner(t),this.db.prepare("DELETE FROM system_error_logs").run()}getAuditLogs(t=100){return this.db.prepare(`
      SELECT al.*, u.name as user_name
      FROM audit_logs al
      LEFT JOIN users u ON al.user_id = u.id
      ORDER BY al.id DESC
      LIMIT ?
    `).all(t)}getSettings(){let t=this.db.prepare("SELECT key, value FROM app_settings").all(),e={};for(let r of t)e[r.key]=r.value;return e}updateSettings(t,e){this.checkOwner(t),L(r=>{let s=r.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)");for(let[i,n]of Object.entries(e))s.run(i,String(n))},this.db)}};var he=A(require("node:crypto"),1);var ge=new Map;function Se(c){return c&&ge.get(c)||null}function fe(c){let t=he.default.randomBytes(32).toString("hex");return ge.set(t,c),{user:c,token:t}}var Z=class{constructor(t=I()){this.db=t}hasOwner(){return this.db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'owner'").get().count>0}getActiveUsers(){return this.db.prepare("SELECT id, name, role, is_active, created_at FROM users WHERE is_active = 1 ORDER BY role DESC, id ASC").all()}getAllUsers(t){if(t.role!=="owner")throw new Error("\u10D7\u10D0\u10DC\u10D0\u10DB\u10E8\u10E0\u10DD\u10DB\u10DA\u10D4\u10D1\u10D8\u10E1 \u10E1\u10D8\u10D8\u10E1 \u10DC\u10D0\u10EE\u10D5\u10D0 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1 \u10E8\u10D4\u10E3\u10EB\u10DA\u10D8\u10D0");return this.db.prepare("SELECT id, name, role, is_active, created_at FROM users ORDER BY id ASC").all()}setupInitialOwner(t,e){if(this.hasOwner())throw new Error("\u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10D8\u10E1 \u10D0\u10DC\u10D2\u10D0\u10E0\u10D8\u10E8\u10D8 \u10E3\u10D9\u10D5\u10D4 \u10E8\u10D4\u10E5\u10DB\u10DC\u10D8\u10DA\u10D8\u10D0. \u10D2\u10D7\u10EE\u10DD\u10D5\u10D7 \u10D2\u10D0\u10D8\u10D0\u10E0\u10DD\u10D7 \u10D0\u10D5\u10E2\u10DD\u10E0\u10D8\u10D6\u10D0\u10EA\u10D8\u10D0.");let r=t.trim();if(!r)throw new Error("\u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10D8\u10E1 \u10E1\u10D0\u10EE\u10D4\u10DA\u10D8 \u10E1\u10D0\u10D5\u10D0\u10DA\u10D3\u10D4\u10D1\u10E3\u10DA\u10DD\u10D0");if(!G(e))throw new Error("PIN \u10D9\u10DD\u10D3\u10D8 \u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D3\u10D2\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 4-\u10D3\u10D0\u10DC 6 \u10EA\u10D8\u10E4\u10E0\u10D8\u10E1\u10D2\u10D0\u10DC");let s=Q(),i=Y(e,s),n=new Date().toISOString(),a=this.db.prepare("INSERT INTO users (name, role, pin_hash, pin_salt, is_active, created_at) VALUES (?, 'owner', ?, ?, 1, ?)").run(r,i,s,n),u=Number(a.lastInsertRowid),d={id:u,name:r,role:"owner",is_active:1,created_at:n};return this.db.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'OWNER_SETUP', 'users', ?, 'Initial owner created', ?)").run(u,String(u),n),fe(d)}login(t,e){if(!G(e))throw new Error("PIN \u10D9\u10DD\u10D3\u10D8 \u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D3\u10D2\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 4-\u10D3\u10D0\u10DC 6 \u10EA\u10D8\u10E4\u10E0\u10D8\u10E1\u10D2\u10D0\u10DC");let r=this.db.prepare("SELECT id, name, role, pin_hash, pin_salt, is_active, created_at FROM users WHERE id = ?").get(t);if(!r)throw new Error("\u10DB\u10DD\u10DB\u10EE\u10DB\u10D0\u10E0\u10D4\u10D1\u10D4\u10DA\u10D8 \u10D5\u10D4\u10E0 \u10DB\u10DD\u10D8\u10EB\u10D4\u10D1\u10DC\u10D0");if(r.is_active===0)throw new Error("\u10D4\u10E1 \u10D0\u10DC\u10D2\u10D0\u10E0\u10D8\u10E8\u10D8 \u10D3\u10D0\u10D1\u10DA\u10DD\u10D9\u10D8\u10DA\u10D8\u10D0");if(!de(e,r.pin_hash,r.pin_salt))throw new Error("\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 PIN \u10D9\u10DD\u10D3\u10D8");let i={id:r.id,name:r.name,role:r.role,is_active:r.is_active,created_at:r.created_at};return fe(i)}addUser(t,e,r,s="seller"){if(t.role!=="owner")throw new Error("\u10D7\u10D0\u10DC\u10D0\u10DB\u10E8\u10E0\u10DD\u10DB\u10DA\u10D8\u10E1 \u10D3\u10D0\u10DB\u10D0\u10E2\u10D4\u10D1\u10D0 \u10E8\u10D4\u10E3\u10EB\u10DA\u10D8\u10D0 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1");let i=e.trim();if(!i)throw new Error("\u10D7\u10D0\u10DC\u10D0\u10DB\u10E8\u10E0\u10DD\u10DB\u10DA\u10D8\u10E1 \u10E1\u10D0\u10EE\u10D4\u10DA\u10D8 \u10E1\u10D0\u10D5\u10D0\u10DA\u10D3\u10D4\u10D1\u10E3\u10DA\u10DD\u10D0");if(!G(r))throw new Error("PIN \u10D9\u10DD\u10D3\u10D8 \u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D3\u10D2\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 4-\u10D3\u10D0\u10DC 6 \u10EA\u10D8\u10E4\u10E0\u10D8\u10E1\u10D2\u10D0\u10DC");let n=Q(),a=Y(r,n),u=new Date().toISOString(),d=this.db.prepare("INSERT INTO users (name, role, pin_hash, pin_salt, is_active, created_at) VALUES (?, ?, ?, ?, 1, ?)").run(i,s,a,n,u),E=Number(d.lastInsertRowid);return this.db.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'USER_CREATE', 'users', ?, ?, ?)").run(t.id,String(E),`Created user ${i} (${s})`,u),{id:E,name:i,role:s,is_active:1,created_at:u}}setUserActive(t,e,r){if(t.role!=="owner")throw new Error("\u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1 \u10E8\u10D4\u10E3\u10EB\u10DA\u10D8\u10D0 \u10DB\u10DD\u10DB\u10EE\u10DB\u10D0\u10E0\u10D4\u10D1\u10DA\u10D8\u10E1 \u10E1\u10E2\u10D0\u10E2\u10E3\u10E1\u10D8\u10E1 \u10E8\u10D4\u10EA\u10D5\u10DA\u10D0");if(t.id===e&&!r)throw new Error("\u10E1\u10D0\u10D9\u10E3\u10D7\u10D0\u10E0\u10D8 \u10D7\u10D0\u10D5\u10D8\u10E1 \u10D3\u10D0\u10D1\u10DA\u10DD\u10D9\u10D5\u10D0 \u10E8\u10D4\u10E3\u10EB\u10DA\u10D4\u10D1\u10D4\u10DA\u10D8\u10D0");let s=new Date().toISOString();this.db.prepare("UPDATE users SET is_active = ? WHERE id = ?").run(r?1:0,e),this.db.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'USER_STATUS_CHANGE', 'users', ?, ?, ?)").run(t.id,String(e),`Active set to ${r}`,s)}resetPin(t,e,r){if(t.role!=="owner"&&t.id!==e)throw new Error("PIN-\u10D8\u10E1 \u10E8\u10D4\u10EA\u10D5\u10DA\u10D8\u10E1 \u10E3\u10E4\u10DA\u10D4\u10D1\u10D0 \u10D0\u10E0 \u10D2\u10D0\u10E5\u10D5\u10D7");if(!G(r))throw new Error("\u10D0\u10EE\u10D0\u10DA\u10D8 PIN \u10D9\u10DD\u10D3\u10D8 \u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D3\u10D2\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 4-\u10D3\u10D0\u10DC 6 \u10EA\u10D8\u10E4\u10E0\u10D8\u10E1\u10D2\u10D0\u10DC");let s=Q(),i=Y(r,s),n=new Date().toISOString();this.db.prepare("UPDATE users SET pin_hash = ?, pin_salt = ? WHERE id = ?").run(i,s,e),this.db.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'PIN_RESET', 'users', ?, 'PIN reset', ?)").run(t.id,String(e),n)}verifyOwnerPin(t,e){if(!G(e))return!1;let r=this.db.prepare("SELECT pin_hash, pin_salt, role FROM users WHERE id = ?").get(t);return!r||r.role!=="owner"?!1:de(e,r.pin_hash,r.pin_salt)}resetStoreDatabase(t,e){if(t.role!=="owner")throw new Error("\u10DB\u10DD\u10DC\u10D0\u10EA\u10D4\u10DB\u10D7\u10D0 \u10D1\u10D0\u10D6\u10D8\u10E1 \u10D2\u10D0\u10E1\u10E3\u10E4\u10D7\u10D0\u10D5\u10D4\u10D1\u10D8\u10E1 \u10E3\u10E4\u10DA\u10D4\u10D1\u10D0 \u10D0\u10E5\u10D5\u10E1 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1 (Owner)");if(!e||!this.verifyOwnerPin(t.id,e))throw new Error("\u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8 PIN \u10D9\u10DD\u10D3\u10D8. \u10D1\u10D0\u10D6\u10D8\u10E1 \u10D2\u10D0\u10E1\u10E3\u10E4\u10D7\u10D0\u10D5\u10D4\u10D1\u10D0 \u10E3\u10D0\u10E0\u10E7\u10DD\u10E4\u10D8\u10DA\u10D8\u10D0");try{new $(this.db).createEmergencyPreResetBackup(t)}catch(r){console.warn("[AuthService] Automatic pre-reset backup warning:",r)}L(()=>{this.db.exec(`
        DELETE FROM sale_items;
        DELETE FROM sales;
        DELETE FROM debt_repayments;
        DELETE FROM return_items;
        DELETE FROM returns;
        DELETE FROM inventory_lots;
        DELETE FROM inventory_movements;
        DELETE FROM product_codes;
        DELETE FROM product_images;
        DELETE FROM product_variants;
        DELETE FROM products;
        DELETE FROM categories;
        DELETE FROM customers;
        DELETE FROM expenses;
        DELETE FROM audit_logs;
        DELETE FROM system_error_logs;
        DELETE FROM users;
      `)})}};var ee=class{constructor(t=I()){this.db=t}getCategories(){return this.db.prepare("SELECT id, name, created_at FROM categories ORDER BY name ASC").all()}createCategory(t,e){if(t.role!=="owner")throw new Error("\u10D9\u10D0\u10E2\u10D4\u10D2\u10DD\u10E0\u10D8\u10D8\u10E1 \u10D3\u10D0\u10DB\u10D0\u10E2\u10D4\u10D1\u10D0 \u10E8\u10D4\u10E3\u10EB\u10DA\u10D8\u10D0 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1");let r=e.trim();if(!r)throw new Error("\u10D9\u10D0\u10E2\u10D4\u10D2\u10DD\u10E0\u10D8\u10D8\u10E1 \u10E1\u10D0\u10EE\u10D4\u10DA\u10D8 \u10E1\u10D0\u10D5\u10D0\u10DA\u10D3\u10D4\u10D1\u10E3\u10DA\u10DD\u10D0");let s=new Date().toISOString();try{let i=this.db.prepare("INSERT INTO categories (name, created_at) VALUES (?, ?)").run(r,s);return{id:Number(i.lastInsertRowid),name:r,created_at:s}}catch(i){throw i.message&&i.message.includes("UNIQUE")?new Error(`\u10D9\u10D0\u10E2\u10D4\u10D2\u10DD\u10E0\u10D8\u10D0 \u10E1\u10D0\u10EE\u10D4\u10DA\u10D8\u10D7 "${r}" \u10E3\u10D9\u10D5\u10D4 \u10D0\u10E0\u10E1\u10D4\u10D1\u10DD\u10D1\u10E1`):i}}deleteCategory(t,e){if(t.role!=="owner")throw new Error("\u10D9\u10D0\u10E2\u10D4\u10D2\u10DD\u10E0\u10D8\u10D8\u10E1 \u10EC\u10D0\u10E8\u10DA\u10D0 \u10E8\u10D4\u10E3\u10EB\u10DA\u10D8\u10D0 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1");this.db.prepare("DELETE FROM categories WHERE id = ?").run(e)}validateManualCode(t){let e=t.trim();if(!/^\d{5}$/.test(e))throw new Error(`\u10EE\u10D4\u10DA\u10D8\u10D7 \u10E8\u10D4\u10E1\u10D0\u10E7\u10D5\u10D0\u10DC\u10D8 \u10D9\u10DD\u10D3\u10D8 \u10E3\u10DC\u10D3\u10D0 \u10D8\u10E7\u10DD\u10E1 \u10D6\u10E3\u10E1\u10E2\u10D0\u10D3 5-\u10DC\u10D8\u10E8\u10DC\u10D0 \u10E0\u10D8\u10EA\u10EE\u10D5\u10D8 (10000-99999). \u10DB\u10D8\u10E6\u10D4\u10D1\u10E3\u10DA\u10D8\u10D0: "${t}"`);return e}validateBarcode(t){let e=t.trim();if(!e||!/^\d+$/.test(e))throw new Error(`\u10E8\u10E2\u10E0\u10D8\u10EE\u10D9\u10DD\u10D3\u10D8 \u10E3\u10DC\u10D3\u10D0 \u10E8\u10D4\u10D8\u10EA\u10D0\u10D5\u10D3\u10D4\u10E1 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10EA\u10D8\u10E4\u10E0\u10D4\u10D1\u10E1 (\u10EC\u10D0\u10DB\u10E7\u10D5\u10D0\u10DC\u10D8 \u10DC\u10E3\u10DA\u10D4\u10D1\u10D8\u10E1 \u10E9\u10D0\u10D7\u10D5\u10DA\u10D8\u10D7). \u10DB\u10D8\u10E6\u10D4\u10D1\u10E3\u10DA\u10D8\u10D0: "${t}"`);return e}checkCodeUniqueness(t,e){let r="SELECT pc.id, pc.code_type, pc.code_value, pv.variant_name, p.name as product_name FROM product_codes pc JOIN product_variants pv ON pc.variant_id = pv.id JOIN products p ON pv.product_id = p.id WHERE pc.code_value = ?",s=[t];e&&(r+=" AND pc.variant_id != ?",s.push(e));let i=this.db.prepare(r).get(...s);if(i)throw new Error(`\u10D9\u10DD\u10D3\u10D8 "${t}" \u10E3\u10D9\u10D5\u10D4 \u10D2\u10D0\u10DB\u10DD\u10E7\u10D4\u10DC\u10D4\u10D1\u10E3\u10DA\u10D8\u10D0 \u10DE\u10E0\u10DD\u10D3\u10E3\u10E5\u10E2\u10D6\u10D4: "${i.product_name}" (${i.variant_name})`)}createProduct(t,e){if(t.role!=="owner")throw new Error("\u10DE\u10E0\u10DD\u10D3\u10E3\u10E5\u10E2\u10D8\u10E1 \u10D3\u10D0\u10DB\u10D0\u10E2\u10D4\u10D1\u10D0 \u10E8\u10D4\u10E3\u10EB\u10DA\u10D8\u10D0 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1");let r=e.name.trim();if(!r)throw new Error("\u10DE\u10E0\u10DD\u10D3\u10E3\u10E5\u10E2\u10D8\u10E1 \u10D3\u10D0\u10E1\u10D0\u10EE\u10D4\u10DA\u10D4\u10D1\u10D0 \u10E1\u10D0\u10D5\u10D0\u10DA\u10D3\u10D4\u10D1\u10E3\u10DA\u10DD\u10D0");if(e.base_price_tetri<=0)throw new Error("\u10D2\u10D0\u10E1\u10D0\u10E7\u10D8\u10D3\u10D8 \u10E4\u10D0\u10E1\u10D8 \u10E3\u10DC\u10D3\u10D0 \u10D8\u10E7\u10DD\u10E1 0-\u10D6\u10D4 \u10DB\u10D4\u10E2\u10D8");if(!e.variants||e.variants.length===0)throw new Error("\u10DE\u10E0\u10DD\u10D3\u10E3\u10E5\u10E2\u10E1 \u10E3\u10DC\u10D3\u10D0 \u10F0\u10E5\u10DD\u10DC\u10D3\u10D4\u10E1 \u10DB\u10D8\u10DC\u10D8\u10DB\u10E3\u10DB \u10D4\u10E0\u10D7\u10D8 \u10D5\u10D0\u10E0\u10D8\u10D0\u10DC\u10E2\u10D8");for(let s of e.variants){if(!s.codes||s.codes.length===0)throw new Error(`\u10D5\u10D0\u10E0\u10D8\u10D0\u10DC\u10E2\u10D8\u10E1\u10D7\u10D5\u10D8\u10E1 "${s.variant_name}" \u10E1\u10D0\u10D5\u10D0\u10DA\u10D3\u10D4\u10D1\u10E3\u10DA\u10DD\u10D0 \u10DB\u10D8\u10DC\u10D8\u10DB\u10E3\u10DB 1 \u10D9\u10DD\u10D3\u10D8 (\u10E8\u10E2\u10E0\u10D8\u10EE\u10D9\u10DD\u10D3\u10D8 \u10D0\u10DC 5-\u10DC\u10D8\u10E8\u10DC\u10D0 \u10D9\u10DD\u10D3\u10D8)`);for(let i of s.codes){let n=i.code_value.trim();i.code_type==="manual_5digit"?n=this.validateManualCode(n):n=this.validateBarcode(n),this.checkCodeUniqueness(n)}}return L(s=>{let i=new Date().toISOString(),n=s.prepare("INSERT INTO products (name, category_id, description, base_price_tetri, base_cost_tetri, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)").run(r,e.category_id||null,e.description||null,e.base_price_tetri,e.base_cost_tetri||null,i,i),a=Number(n.lastInsertRowid);for(let u of e.variants){let d=Math.max(0,Math.floor(u.initial_stock||0)),E=s.prepare("INSERT INTO product_variants (product_id, variant_name, size, color, price_override_tetri, cost_override_tetri, stock_quantity, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)").run(a,u.variant_name.trim()||"\u10E1\u10E2\u10D0\u10DC\u10D3\u10D0\u10E0\u10E2\u10E3\u10DA\u10D8",u.size?.trim()||null,u.color?.trim()||null,u.price_override_tetri??null,u.cost_override_tetri??null,d),_=Number(E.lastInsertRowid);for(let o of u.codes){let p=o.code_type==="manual_5digit"?this.validateManualCode(o.code_value):this.validateBarcode(o.code_value);s.prepare("INSERT INTO product_codes (variant_id, code_type, code_value) VALUES (?, ?, ?)").run(_,o.code_type,p)}if(d>0){let o=u.cost_override_tetri??e.base_cost_tetri??null,p=s.prepare("INSERT INTO inventory_movements (variant_id, movement_type, quantity_change, resulting_stock, unit_cost_tetri, reason, user_id, created_at) VALUES (?, 'initial', ?, ?, ?, '\u10E1\u10D0\u10EC\u10E7\u10D8\u10E1\u10D8 \u10D8\u10DC\u10D5\u10D4\u10DC\u10E2\u10D0\u10E0\u10D8\u10D6\u10D0\u10EA\u10D8\u10D0', ?, ?)").run(_,d,d,o,t.id,i),h=Number(p.lastInsertRowid);s.prepare("INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, movement_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(_,d,d,o,h,i)}}return e.image_paths&&e.image_paths.length>0&&e.image_paths.forEach((u,d)=>{s.prepare("INSERT INTO product_images (product_id, file_path, is_primary, created_at) VALUES (?, ?, ?, ?)").run(a,u,d===0?1:0,i)}),s.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'PRODUCT_CREATE', 'products', ?, ?, ?)").run(t.id,String(a),`Created product ${r}`,i),this.getProductById(a)},this.db)}getProductById(t){let e=this.db.prepare(`
      SELECT p.*, c.name as category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.id = ?
    `).get(t);if(!e)return null;let r=this.db.prepare(`
      SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1
    `).all(t);for(let i of r)i.codes=this.db.prepare(`
        SELECT * FROM product_codes WHERE variant_id = ?
      `).all(i.id),i.effective_price_tetri=i.price_override_tetri??e.base_price_tetri;let s=this.db.prepare(`
      SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, id ASC
    `).all(t);return{...e,variants:r,images:s}}listProducts(t){let e=`
      SELECT p.*, c.name as category_name
      FROM products p
      LEFT JOIN categories c ON p.category_id = c.id
      WHERE p.is_active = 1
    `,r=[];if(t?.categoryId&&(e+=" AND p.category_id = ?",r.push(t.categoryId)),t?.searchTerm){let a=`%${t.searchTerm.trim()}%`;e+=` AND (
        p.name LIKE ? OR 
        p.id IN (
          SELECT pv.product_id FROM product_variants pv 
          JOIN product_codes pc ON pc.variant_id = pv.id 
          WHERE pc.code_value LIKE ?
        )
      )`,r.push(a,a)}e+=" ORDER BY p.id DESC";let s=this.db.prepare(e).all(...r),i=[],n=t?.lowStockThreshold??5;for(let a of s){let u=this.db.prepare(`
        SELECT * FROM product_variants WHERE product_id = ? AND is_active = 1
      `).all(a.id);for(let _ of u)_.codes=this.db.prepare(`
          SELECT * FROM product_codes WHERE variant_id = ?
        `).all(_.id),_.effective_price_tetri=_.price_override_tetri??a.base_price_tetri;let d=u.reduce((_,o)=>_+(o.stock_quantity||0),0);if(t?.stockFilter==="in_stock"&&d<=0||t?.stockFilter==="zero"&&d>0||t?.stockFilter==="low"&&(d>n||d===0))continue;let E=this.db.prepare(`
        SELECT * FROM product_images WHERE product_id = ? ORDER BY is_primary DESC, id ASC
      `).all(a.id);i.push({...a,variants:u,images:E})}return i}lookupByCode(t){let e=t.trim();if(!e)return null;let r=this.db.prepare(`
      SELECT pc.code_type, pc.code_value, pv.id as variant_id, pv.product_id
      FROM product_codes pc
      JOIN product_variants pv ON pc.variant_id = pv.id
      JOIN products p ON pv.product_id = p.id
      WHERE pc.code_value = ? AND pv.is_active = 1 AND p.is_active = 1
    `).get(e);if(!r)return null;let s=this.getProductById(r.product_id);if(!s)return null;let i=s.variants?.find(n=>n.id===r.variant_id);return i?{variant:i,product:s,code_used:r.code_value,code_type:r.code_type}:null}addImage(t,e,r,s=!1){if(t.role!=="owner")throw new Error("\u10E1\u10E3\u10E0\u10D0\u10D7\u10D8\u10E1 \u10D3\u10D0\u10DB\u10D0\u10E2\u10D4\u10D1\u10D0 \u10E8\u10D4\u10E3\u10EB\u10DA\u10D8\u10D0 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1");let i=r.trim();if(!i)throw new Error("\u10E1\u10E3\u10E0\u10D0\u10D7\u10D8\u10E1 \u10DB\u10D8\u10E1\u10D0\u10DB\u10D0\u10E0\u10D7\u10D8 \u10E1\u10D0\u10D5\u10D0\u10DA\u10D3\u10D4\u10D1\u10E3\u10DA\u10DD\u10D0");let n=new Date().toISOString();s&&this.db.prepare("UPDATE product_images SET is_primary = 0 WHERE product_id = ?").run(e);let a=this.db.prepare(`
      INSERT INTO product_images (product_id, file_path, is_primary, created_at)
      VALUES (?, ?, ?, ?)
    `).run(e,i,s?1:0,n);return{id:Number(a.lastInsertRowid),product_id:e,file_path:i,is_primary:s?1:0,created_at:n}}deleteImage(t,e){if(t.role!=="owner")throw new Error("\u10E1\u10E3\u10E0\u10D0\u10D7\u10D8\u10E1 \u10EC\u10D0\u10E8\u10DA\u10D0 \u10E8\u10D4\u10E3\u10EB\u10DA\u10D8\u10D0 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1");this.db.prepare("DELETE FROM product_images WHERE id = ?").run(e)}};var q=class{constructor(t=I()){this.db=t}generateReceiptNumber(){let t=new Date,e=t.getFullYear(),r=String(t.getMonth()+1).padStart(2,"0"),s=String(t.getDate()).padStart(2,"0"),i=`RCP-${e}${r}${s}-`,n=this.db.prepare("SELECT receipt_number FROM sales WHERE receipt_number LIKE ? ORDER BY id DESC LIMIT 1").get(`${i}%`),a=1;if(n){let u=n.receipt_number.split("-"),d=parseInt(u[2],10);isNaN(d)||(a=d+1)}return`${i}${String(a).padStart(4,"0")}`}checkout(t,e){if(!e.items||e.items.length===0)throw new Error("\u10D9\u10D0\u10DA\u10D0\u10D7\u10D0 \u10EA\u10D0\u10E0\u10D8\u10D4\u10DA\u10D8\u10D0");if(e.idempotency_key){let a=this.db.prepare("SELECT id FROM sales WHERE idempotency_key = ?").get(e.idempotency_key);if(a)return this.getSaleById(a.id)}for(let a of e.items)if(!a.quantity||a.quantity<=0)throw new Error("\u10E0\u10D0\u10DD\u10D3\u10D4\u10DC\u10DD\u10D1\u10D0 \u10E3\u10DC\u10D3\u10D0 \u10D8\u10E7\u10DD\u10E1 \u10DB\u10D8\u10DC\u10D8\u10DB\u10E3\u10DB 1");let r=e.items.reduce((a,u)=>a+u.quantity*u.unit_price_tetri,0);if(r<=0)throw new Error("\u10D2\u10D0\u10E7\u10D8\u10D3\u10D5\u10D8\u10E1 \u10EF\u10D0\u10DB\u10E3\u10E0\u10D8 \u10D7\u10D0\u10DC\u10EE\u10D0 \u10E3\u10DC\u10D3\u10D0 \u10D0\u10E6\u10D4\u10DB\u10D0\u10E2\u10D4\u10D1\u10DD\u10D3\u10D4\u10E1 0-\u10E1");let s=0,i=0,n=0;if(e.payment_method==="cash"){if(s=e.cash_received_tetri,s<r)throw new Error(`\u10DB\u10D8\u10E6\u10D4\u10D1\u10E3\u10DA\u10D8 \u10DC\u10D0\u10E6\u10D3\u10D8 \u10D7\u10D0\u10DC\u10EE\u10D0 (${(s/100).toFixed(2)} \u20BE) \u10DC\u10D0\u10D9\u10DA\u10D4\u10D1\u10D8\u10D0 \u10EF\u10D0\u10DB\u10E3\u10E0 \u10D7\u10D0\u10DC\u10EE\u10D0\u10D6\u10D4 (${(r/100).toFixed(2)} \u20BE)`);i=s-r,n=0}else if(e.payment_method==="debt"){if(!e.customer_id)throw new Error("\u10DC\u10D8\u10E1\u10D8\u10D8\u10D7 \u10D2\u10D0\u10E7\u10D8\u10D3\u10D5\u10D8\u10E1\u10D7\u10D5\u10D8\u10E1 \u10D9\u10DA\u10D8\u10D4\u10DC\u10E2\u10D8\u10E1 \u10D0\u10E0\u10E9\u10D4\u10D5\u10D0 \u10D0\u10DC \u10E0\u10D4\u10D2\u10D8\u10E1\u10E2\u10E0\u10D0\u10EA\u10D8\u10D0 \u10D0\u10E3\u10EA\u10D8\u10DA\u10D4\u10D1\u10D4\u10DA\u10D8\u10D0");s=0,i=0,n=r}else if(e.payment_method==="mixed"){if(!e.customer_id)throw new Error("\u10E8\u10D4\u10E0\u10D4\u10E3\u10DA\u10D8 \u10D2\u10D0\u10D3\u10D0\u10EE\u10D3\u10D8\u10E1\u10D7\u10D5\u10D8\u10E1 (\u10DC\u10D0\u10E6\u10D3\u10D8 + \u10DC\u10D8\u10E1\u10D8\u10D0) \u10D9\u10DA\u10D8\u10D4\u10DC\u10E2\u10D8\u10E1 \u10D0\u10E0\u10E9\u10D4\u10D5\u10D0 \u10D0\u10DC \u10E0\u10D4\u10D2\u10D8\u10E1\u10E2\u10E0\u10D0\u10EA\u10D8\u10D0 \u10D0\u10E3\u10EA\u10D8\u10DA\u10D4\u10D1\u10D4\u10DA\u10D8\u10D0");if(s=e.cash_received_tetri,s<=0||s>=r)throw new Error(`\u10E8\u10D4\u10E0\u10D4\u10E3\u10DA\u10D8 \u10D2\u10D0\u10D3\u10D0\u10EE\u10D3\u10D8\u10E1\u10D0\u10E1 \u10DB\u10D8\u10E6\u10D4\u10D1\u10E3\u10DA\u10D8 \u10DC\u10D0\u10E6\u10D3\u10D8 \u10D7\u10D0\u10DC\u10EE\u10D0 \u10E3\u10DC\u10D3\u10D0 \u10D8\u10E7\u10DD\u10E1 0-\u10D6\u10D4 \u10DB\u10D4\u10E2\u10D8 \u10D3\u10D0 \u10DB\u10D7\u10DA\u10D8\u10D0\u10DC \u10D7\u10D0\u10DC\u10EE\u10D0\u10D6\u10D4 (${(r/100).toFixed(2)} \u20BE) \u10DC\u10D0\u10D9\u10DA\u10D4\u10D1\u10D8`);i=0,n=r-s}else throw new Error("\u10D2\u10D0\u10D3\u10D0\u10EE\u10D3\u10D8\u10E1 \u10DB\u10D4\u10D7\u10DD\u10D3\u10D8 \u10D0\u10E0\u10D0\u10E1\u10EC\u10DD\u10E0\u10D8\u10D0");return L(a=>{let u=new Date().toISOString();if(e.customer_id&&!a.prepare("SELECT id FROM customers WHERE id = ?").get(e.customer_id))throw new Error("\u10DB\u10D8\u10D7\u10D8\u10D7\u10D4\u10D1\u10E3\u10DA\u10D8 \u10D9\u10DA\u10D8\u10D4\u10DC\u10E2\u10D8 \u10D5\u10D4\u10E0 \u10DB\u10DD\u10D8\u10EB\u10D4\u10D1\u10DC\u10D0");for(let o of e.items){let p=a.prepare(`
          SELECT pv.id, pv.stock_quantity, pv.variant_name, p.name as product_name
          FROM product_variants pv
          JOIN products p ON pv.product_id = p.id
          WHERE pv.id = ?
        `).get(o.variant_id);if(!p)throw new Error(`\u10D5\u10D0\u10E0\u10D8\u10D0\u10DC\u10E2\u10D8 #${o.variant_id} \u10D5\u10D4\u10E0 \u10DB\u10DD\u10D8\u10EB\u10D4\u10D1\u10DC\u10D0`);if(p.stock_quantity<o.quantity)throw new Error(`\u10D0\u10E0\u10D0\u10E1\u10D0\u10D9\u10DB\u10D0\u10E0\u10D8\u10E1\u10D8 \u10DB\u10D0\u10E0\u10D0\u10D2\u10D8: "${p.product_name}" (${p.variant_name}). \u10EE\u10D4\u10DA\u10DB\u10D8\u10E1\u10D0\u10EC\u10D5\u10D3\u10DD\u10DB\u10D8\u10D0: ${p.stock_quantity}, \u10DB\u10DD\u10D7\u10EE\u10DD\u10D5\u10DC\u10D8\u10DA\u10D8\u10D0: ${o.quantity}`)}let d=this.generateReceiptNumber(),E=a.prepare(`
        INSERT INTO sales (
          receipt_number, user_id, customer_id, payment_method,
          total_tetri, cash_received_tetri, change_given_tetri,
          debt_amount_tetri, status, notes, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)
      `).run(d,t.id,e.customer_id||null,e.payment_method,r,s,i,n,e.notes?.trim()||null,e.idempotency_key||null,u),_=Number(E.lastInsertRowid);for(let o of e.items){let p=a.prepare(`
          SELECT pv.id, pv.variant_name, pv.stock_quantity, p.name as product_name, p.base_cost_tetri, pv.cost_override_tetri
          FROM product_variants pv
          JOIN products p ON pv.product_id = p.id
          WHERE pv.id = ?
        `).get(o.variant_id),h=a.prepare("SELECT code_value FROM product_codes WHERE variant_id = ? ORDER BY id ASC LIMIT 1").get(o.variant_id),l=o.quantity,T=0,S=0,y=a.prepare(`
          SELECT id, remaining_quantity, unit_cost_tetri
          FROM inventory_lots
          WHERE variant_id = ? AND remaining_quantity > 0
          ORDER BY id ASC
        `).all(o.variant_id);for(let N of y){if(l<=0)break;let g=Math.min(l,N.remaining_quantity),U=N.remaining_quantity-g;a.prepare("UPDATE inventory_lots SET remaining_quantity = ? WHERE id = ?").run(U,N.id),N.unit_cost_tetri!==null&&N.unit_cost_tetri!==void 0&&(T+=g*N.unit_cost_tetri,S+=g),l-=g}let m=null;S===o.quantity?m=Math.round(T/o.quantity):p.cost_override_tetri!==null?m=p.cost_override_tetri:p.base_cost_tetri!==null&&(m=p.base_cost_tetri);let R=o.quantity*o.unit_price_tetri;a.prepare(`
          INSERT INTO sale_items (
            sale_id, variant_id, product_name_snap, variant_name_snap,
            code_snap, quantity, unit_price_tetri, unit_cost_tetri,
            total_price_tetri, returned_quantity
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        `).run(_,o.variant_id,p.product_name,p.variant_name,h?.code_value||null,o.quantity,o.unit_price_tetri,m,R);let O=p.stock_quantity-o.quantity;a.prepare("UPDATE product_variants SET stock_quantity = ? WHERE id = ?").run(O,o.variant_id),a.prepare(`
          INSERT INTO inventory_movements (
            variant_id, movement_type, quantity_change, resulting_stock,
            unit_cost_tetri, reason, reference_id, user_id, created_at
          ) VALUES (?, 'sale', ?, ?, ?, '\u10D2\u10D0\u10E7\u10D8\u10D3\u10D5\u10D0', ?, ?, ?)
        `).run(o.variant_id,-o.quantity,O,m,d,t.id,u)}return a.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'SALE_CHECKOUT', 'sales', ?, ?, ?)
      `).run(t.id,String(_),`Sale ${d} completed: total ${r} tetri, method: ${e.payment_method}`,u),this.getSaleById(_)},this.db)}getSaleById(t){let e=this.db.prepare(`
      SELECT s.*, u.name as user_name, 
             c.first_name || CASE WHEN c.last_name IS NOT NULL THEN ' ' || c.last_name ELSE '' END as customer_name
      FROM sales s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE s.id = ?
    `).get(t);if(!e)return null;let r=this.db.prepare(`
      SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id ASC
    `).all(t);if(e.debt_amount_tetri>0){let s=this.db.prepare(`
        SELECT COALESCE(SUM(amount_tetri), 0) as total FROM debt_repayments WHERE sale_id = ?
      `).get(t),i=this.db.prepare(`
        SELECT COALESCE(SUM(debt_deduction_tetri), 0) as total FROM returns WHERE sale_id = ?
      `).get(t);e.debt_remaining_tetri=Math.max(0,e.debt_amount_tetri-s.total-i.total)}else e.debt_remaining_tetri=0;return{...e,items:r}}searchSales(t){let e=`
      SELECT s.*, u.name as user_name,
             c.first_name || CASE WHEN c.last_name IS NOT NULL THEN ' ' || c.last_name ELSE '' END as customer_name
      FROM sales s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      WHERE 1=1
    `,r=[];if(t?.searchTerm){let i=`%${t.searchTerm.trim()}%`;e+=` AND (
        s.receipt_number LIKE ? OR 
        c.first_name LIKE ? OR 
        c.last_name LIKE ? OR
        s.id IN (SELECT sale_id FROM sale_items WHERE code_snap LIKE ? OR product_name_snap LIKE ?)
      )`,r.push(i,i,i,i,i)}t?.startDate&&(e+=" AND s.created_at >= ?",r.push(t.startDate)),t?.endDate&&(e+=" AND s.created_at <= ?",r.push(t.endDate)),e+=" ORDER BY s.id DESC LIMIT ?",r.push(t?.limit||50);let s=this.db.prepare(e).all(...r);for(let i of s)i.items=this.db.prepare("SELECT * FROM sale_items WHERE sale_id = ?").all(i.id);return s}};var te=class{constructor(t=I()){this.db=t}restockVariant(t,e){if(t.role!=="owner")throw new Error("\u10DB\u10D0\u10E0\u10D0\u10D2\u10D8\u10E1 \u10E8\u10D4\u10D5\u10E1\u10D4\u10D1\u10D0 \u10E8\u10D4\u10E3\u10EB\u10DA\u10D8\u10D0 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1");if(e.added_quantity<=0)throw new Error("\u10D3\u10D0\u10DB\u10D0\u10E2\u10D4\u10D1\u10E3\u10DA\u10D8 \u10E0\u10D0\u10DD\u10D3\u10D4\u10DC\u10DD\u10D1\u10D0 \u10E3\u10DC\u10D3\u10D0 \u10D8\u10E7\u10DD\u10E1 1 \u10D0\u10DC \u10DB\u10D4\u10E2\u10D8");return L(r=>{let s=r.prepare("SELECT id, product_id, variant_name, stock_quantity FROM product_variants WHERE id = ?").get(e.variant_id);if(!s)throw new Error("\u10DE\u10E0\u10DD\u10D3\u10E3\u10E5\u10E2\u10D8\u10E1 \u10D5\u10D0\u10E0\u10D8\u10D0\u10DC\u10E2\u10D8 \u10D5\u10D4\u10E0 \u10DB\u10DD\u10D8\u10EB\u10D4\u10D1\u10DC\u10D0");let i=new Date().toISOString(),n=s.stock_quantity+e.added_quantity;r.prepare("UPDATE product_variants SET stock_quantity = ? WHERE id = ?").run(n,s.id);let a=r.prepare("INSERT INTO inventory_movements (variant_id, movement_type, quantity_change, resulting_stock, unit_cost_tetri, reason, user_id, created_at) VALUES (?, 'restock', ?, ?, ?, ?, ?, ?)").run(s.id,e.added_quantity,n,e.unit_cost_tetri??null,e.notes?.trim()||"\u10DB\u10D0\u10E0\u10D0\u10D2\u10D8\u10E1 \u10E8\u10D4\u10D5\u10E1\u10D4\u10D1\u10D0",t.id,i),u=Number(a.lastInsertRowid);return r.prepare("INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, movement_id, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(s.id,e.added_quantity,e.added_quantity,e.unit_cost_tetri??null,u,i),r.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'INVENTORY_RESTOCK', 'product_variants', ?, ?, ?)").run(t.id,String(s.id),`Restocked +${e.added_quantity} to stock ${n}`,i),{new_stock:n}},this.db)}correctStock(t,e){if(t.role!=="owner")throw new Error("\u10DB\u10D0\u10E0\u10D0\u10D2\u10D8\u10E1 \u10D9\u10DD\u10E0\u10D4\u10E5\u10E2\u10D8\u10E0\u10D4\u10D1\u10D0 \u10E8\u10D4\u10E3\u10EB\u10DA\u10D8\u10D0 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1");let r=e.reason?.trim();if(!r)throw new Error("\u10DB\u10D0\u10E0\u10D0\u10D2\u10D8\u10E1 \u10D9\u10DD\u10E0\u10D4\u10E5\u10E2\u10D8\u10E0\u10D4\u10D1\u10D8\u10E1\u10D7\u10D5\u10D8\u10E1 \u10DB\u10D8\u10D6\u10D4\u10D6\u10D8\u10E1 \u10DB\u10D8\u10D7\u10D8\u10D7\u10D4\u10D1\u10D0 \u10E1\u10D0\u10D5\u10D0\u10DA\u10D3\u10D4\u10D1\u10E3\u10DA\u10DD\u10D0");if(e.counted_quantity<0)throw new Error("\u10D3\u10D0\u10D7\u10D5\u10DA\u10D8\u10DA\u10D8 \u10DB\u10D0\u10E0\u10D0\u10D2\u10D8 \u10D0\u10E0 \u10E8\u10D4\u10D8\u10EB\u10DA\u10D4\u10D1\u10D0 \u10D8\u10E7\u10DD\u10E1 \u10E3\u10D0\u10E0\u10E7\u10DD\u10E4\u10D8\u10D7\u10D8");return L(s=>{let i=s.prepare("SELECT id, product_id, variant_name, stock_quantity FROM product_variants WHERE id = ?").get(e.variant_id);if(!i)throw new Error("\u10DE\u10E0\u10DD\u10D3\u10E3\u10E5\u10E2\u10D8\u10E1 \u10D5\u10D0\u10E0\u10D8\u10D0\u10DC\u10E2\u10D8 \u10D5\u10D4\u10E0 \u10DB\u10DD\u10D8\u10EB\u10D4\u10D1\u10DC\u10D0");let n=e.counted_quantity-i.stock_quantity;if(n===0)return{new_stock:i.stock_quantity,diff:0};let a=new Date().toISOString();return s.prepare("UPDATE product_variants SET stock_quantity = ? WHERE id = ?").run(e.counted_quantity,i.id),s.prepare("INSERT INTO inventory_movements (variant_id, movement_type, quantity_change, resulting_stock, unit_cost_tetri, reason, user_id, created_at) VALUES (?, 'correction', ?, ?, NULL, ?, ?, ?)").run(i.id,n,e.counted_quantity,`\u10D9\u10DD\u10E0\u10D4\u10E5\u10EA\u10D8\u10D0: ${r}`,t.id,a),s.prepare("INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at) VALUES (?, 'INVENTORY_CORRECTION', 'product_variants', ?, ?, ?)").run(t.id,String(i.id),`Stock corrected from ${i.stock_quantity} to ${e.counted_quantity} (${n>=0?"+":""}${n}). Reason: ${r}`,a),{new_stock:e.counted_quantity,diff:n}},this.db)}getMovements(t,e=50){let r=`
      SELECT im.*, pv.variant_name, p.name as product_name, u.name as user_name
      FROM inventory_movements im
      JOIN product_variants pv ON im.variant_id = pv.id
      JOIN products p ON pv.product_id = p.id
      LEFT JOIN users u ON im.user_id = u.id
    `,s=[];return t&&(r+=" WHERE im.variant_id = ?",s.push(t)),r+=" ORDER BY im.id DESC LIMIT ?",s.push(e),this.db.prepare(r).all(...s)}};var re=class{constructor(t=I()){this.db=t}createCustomer(t,e){let r=e.first_name.trim();if(!r)throw new Error("\u10D9\u10DA\u10D8\u10D4\u10DC\u10E2\u10D8\u10E1 \u10E1\u10D0\u10EE\u10D4\u10DA\u10D8 \u10E1\u10D0\u10D5\u10D0\u10DA\u10D3\u10D4\u10D1\u10E3\u10DA\u10DD\u10D0");let s=new Date().toISOString(),i=this.db.prepare(`
      INSERT INTO customers (first_name, last_name, phone, address, notes, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(r,e.last_name?.trim()||null,e.phone?.trim()||null,e.address?.trim()||null,e.notes?.trim()||null,s),n=Number(i.lastInsertRowid);return this.db.prepare(`
      INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
      VALUES (?, 'CUSTOMER_CREATE', 'customers', ?, ?, ?)
    `).run(t.id,String(n),`Created customer ${r}`,s),this.getCustomerById(n)}listCustomers(t){let e=`
      SELECT c.*,
        (
          COALESCE((SELECT SUM(debt_amount_tetri) FROM sales WHERE customer_id = c.id), 0)
          - COALESCE((SELECT SUM(amount_tetri) FROM debt_repayments WHERE customer_id = c.id), 0)
          - COALESCE((SELECT SUM(r.debt_deduction_tetri) FROM returns r JOIN sales s ON r.sale_id = s.id WHERE s.customer_id = c.id), 0)
        ) as total_debt_tetri
      FROM customers c
    `,r=[];if(t&&t.trim()){let i=`%${t.trim()}%`;e+=" WHERE c.first_name LIKE ? OR c.last_name LIKE ? OR c.phone LIKE ?",r.push(i,i,i)}return e+=" ORDER BY c.first_name ASC",this.db.prepare(e).all(...r).map(i=>({...i,total_debt_tetri:Math.max(0,i.total_debt_tetri||0)}))}getCustomerById(t){let e=this.db.prepare(`
      SELECT c.*,
        (
          COALESCE((SELECT SUM(debt_amount_tetri) FROM sales WHERE customer_id = c.id), 0)
          - COALESCE((SELECT SUM(amount_tetri) FROM debt_repayments WHERE customer_id = c.id), 0)
          - COALESCE((SELECT SUM(r.debt_deduction_tetri) FROM returns r JOIN sales s ON r.sale_id = s.id WHERE s.customer_id = c.id), 0)
        ) as total_debt_tetri
      FROM customers c WHERE c.id = ?
    `).get(t);return e?{...e,total_debt_tetri:Math.max(0,e.total_debt_tetri||0)}:null}recordRepayment(t,e){if(e.amount_tetri<=0)throw new Error("\u10D3\u10D0\u10E4\u10D0\u10E0\u10D5\u10D8\u10E1 \u10D7\u10D0\u10DC\u10EE\u10D0 \u10E3\u10DC\u10D3\u10D0 \u10D8\u10E7\u10DD\u10E1 0-\u10D6\u10D4 \u10DB\u10D4\u10E2\u10D8");if(e.idempotency_key){let r=this.db.prepare("SELECT dr.*, u.name as user_name FROM debt_repayments dr JOIN users u ON dr.user_id = u.id WHERE dr.idempotency_key = ?").get(e.idempotency_key);if(r)return{id:r.id,customer_id:r.customer_id,sale_id:r.sale_id,amount_tetri:r.amount_tetri,user_id:r.user_id,user_name:r.user_name,payment_method:"cash",notes:r.notes||void 0,idempotency_key:r.idempotency_key,created_at:r.created_at}}return L(r=>{let s=this.getCustomerById(e.customer_id);if(!s)throw new Error("\u10D9\u10DA\u10D8\u10D4\u10DC\u10E2\u10D8 \u10D5\u10D4\u10E0 \u10DB\u10DD\u10D8\u10EB\u10D4\u10D1\u10DC\u10D0");let i=s.total_debt_tetri||0;if(i<=0)throw new Error(`\u10D9\u10DA\u10D8\u10D4\u10DC\u10E2\u10E1 (${s.first_name}) \u10D3\u10D0\u10D5\u10D0\u10DA\u10D8\u10D0\u10DC\u10D4\u10D1\u10D0 \u10D0\u10E0 \u10D4\u10E0\u10D8\u10EA\u10EE\u10D4\u10D1\u10D0`);if(e.amount_tetri>i)throw new Error(`\u10E8\u10D4\u10E2\u10D0\u10DC\u10D8\u10DA\u10D8 \u10D7\u10D0\u10DC\u10EE\u10D0 (${(e.amount_tetri/100).toFixed(2)} \u20BE) \u10D0\u10E6\u10D4\u10DB\u10D0\u10E2\u10D4\u10D1\u10D0 \u10DB\u10D8\u10DB\u10D3\u10D8\u10DC\u10D0\u10E0\u10D4 \u10D3\u10D0\u10D5\u10D0\u10DA\u10D8\u10D0\u10DC\u10D4\u10D1\u10D0\u10E1 (${(i/100).toFixed(2)} \u20BE)`);let n=new Date().toISOString(),a=r.prepare(`
        INSERT INTO debt_repayments (customer_id, sale_id, amount_tetri, user_id, payment_method, notes, idempotency_key, created_at)
        VALUES (?, ?, ?, ?, 'cash', ?, ?, ?)
      `).run(s.id,e.sale_id||null,e.amount_tetri,t.id,e.notes?.trim()||null,e.idempotency_key||null,n),u=Number(a.lastInsertRowid);return r.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'DEBT_REPAYMENT', 'debt_repayments', ?, ?, ?)
      `).run(t.id,String(u),`Repaid ${(e.amount_tetri/100).toFixed(2)} GEL for customer ${s.first_name} by ${t.name}`,n),{id:u,customer_id:s.id,sale_id:e.sale_id||null,amount_tetri:e.amount_tetri,user_id:t.id,user_name:t.name,payment_method:"cash",notes:e.notes?.trim()||void 0,created_at:n}},this.db)}getRepayments(t){return this.db.prepare(`
      SELECT dr.*, u.name as user_name
      FROM debt_repayments dr
      JOIN users u ON dr.user_id = u.id
      WHERE dr.customer_id = ?
      ORDER BY dr.id DESC
    `).all(t)}};var se=class{constructor(t=I()){this.db=t,this.posService=new q(t)}processReturn(t,e){if(!e.items||e.items.length===0)throw new Error("\u10D3\u10D0\u10E1\u10D0\u10D1\u10E0\u10E3\u10DC\u10D4\u10D1\u10D4\u10DA\u10D8 \u10DE\u10E0\u10DD\u10D3\u10E3\u10E5\u10E2\u10D4\u10D1\u10D8 \u10D0\u10E0 \u10D0\u10E0\u10D8\u10E1 \u10D0\u10E0\u10E9\u10D4\u10E3\u10DA\u10D8");return L(r=>{let s=new Date().toISOString(),i=r.prepare("SELECT * FROM sales WHERE id = ?").get(e.sale_id);if(!i)throw new Error("\u10DD\u10E0\u10D8\u10D2\u10D8\u10DC\u10D0\u10DA\u10D8 \u10D2\u10D0\u10E7\u10D8\u10D3\u10D5\u10D0 \u10D5\u10D4\u10E0 \u10DB\u10DD\u10D8\u10EB\u10D4\u10D1\u10DC\u10D0");let n=r.prepare(`
        SELECT COALESCE(SUM(debt_deduction_tetri), 0) as past_debt_deduction,
               COALESCE(SUM(cash_refund_tetri), 0) as past_cash_refund
        FROM returns WHERE sale_id = ?
      `).get(i.id),a=r.prepare(`
        SELECT COALESCE(SUM(amount_tetri), 0) as total_repaid
        FROM debt_repayments WHERE sale_id = ?
      `).get(i.id),u=Math.max(0,i.debt_amount_tetri-n.past_debt_deduction-a.total_repaid),d=Math.max(0,i.cash_received_tetri-i.change_given_tetri+a.total_repaid-n.past_cash_refund),E=0,_=[];for(let m of e.items){if(m.quantity<=0)throw new Error("\u10D3\u10D0\u10E1\u10D0\u10D1\u10E0\u10E3\u10DC\u10D4\u10D1\u10D4\u10DA\u10D8 \u10E0\u10D0\u10DD\u10D3\u10D4\u10DC\u10DD\u10D1\u10D0 \u10E3\u10DC\u10D3\u10D0 \u10D8\u10E7\u10DD\u10E1 \u10DB\u10D8\u10DC\u10D8\u10DB\u10E3\u10DB 1");let R=r.prepare(`
          SELECT * FROM sale_items WHERE id = ? AND sale_id = ?
        `).get(m.sale_item_id,i.id);if(!R)throw new Error(`\u10D2\u10D0\u10E7\u10D8\u10D3\u10E3\u10DA\u10D8 \u10DE\u10DD\u10D6\u10D8\u10EA\u10D8\u10D0 #${m.sale_item_id} \u10D0\u10E0 \u10D4\u10D9\u10E3\u10D7\u10D5\u10DC\u10D8\u10E1 \u10D0\u10DB \u10D2\u10D0\u10E7\u10D8\u10D3\u10D5\u10D0\u10E1`);let O=R.quantity-R.returned_quantity;if(m.quantity>O)throw new Error(`\u10E8\u10D4\u10EA\u10D3\u10DD\u10DB\u10D0: "${R.product_name_snap}"-\u10E1\u10D7\u10D5\u10D8\u10E1 \u10D3\u10D0\u10E1\u10D0\u10D1\u10E0\u10E3\u10DC\u10D4\u10D1\u10D4\u10DA\u10D8 \u10E0\u10D0\u10DD\u10D3\u10D4\u10DC\u10DD\u10D1\u10D0 (${m.quantity}) \u10D0\u10E6\u10D4\u10DB\u10D0\u10E2\u10D4\u10D1\u10D0 \u10D3\u10D0\u10E0\u10E9\u10D4\u10DC\u10D8\u10DA \u10D3\u10D0\u10D1\u10E0\u10E3\u10DC\u10D4\u10D1\u10D0\u10D3 \u10E0\u10D0\u10DD\u10D3\u10D4\u10DC\u10DD\u10D1\u10D0\u10E1 (${O})`);let N=m.quantity*R.unit_price_tetri;E+=N,_.push({sale_item_id:R.id,variant_id:m.variant_id,quantity:m.quantity,unit_price_tetri:R.unit_price_tetri,line_total_tetri:N,condition:m.condition})}let o=Math.min(E,u),p=E-o,h=Math.min(p,d),l=r.prepare(`
        INSERT INTO returns (
          sale_id, user_id, return_type, total_refund_tetri,
          debt_deduction_tetri, cash_refund_tetri, condition, reason, created_at
        ) VALUES (?, ?, 'refund', ?, ?, ?, ?, ?, ?)
      `).run(i.id,t.id,E,o,h,e.items[0].condition,e.reason?.trim()||null,s),T=Number(l.lastInsertRowid);for(let m of _){r.prepare(`
          INSERT INTO return_items (return_id, sale_item_id, variant_id, quantity, unit_price_tetri, total_tetri)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(T,m.sale_item_id,m.variant_id,m.quantity,m.unit_price_tetri,m.line_total_tetri),r.prepare(`
          UPDATE sale_items SET returned_quantity = returned_quantity + ? WHERE id = ?
        `).run(m.quantity,m.sale_item_id);let R=r.prepare("SELECT stock_quantity FROM product_variants WHERE id = ?").get(m.variant_id),O=R?R.stock_quantity:0;if(m.condition==="resellable"){let N=O+m.quantity;r.prepare("UPDATE product_variants SET stock_quantity = ? WHERE id = ?").run(N,m.variant_id);let g=r.prepare(`
            INSERT INTO inventory_movements (
              variant_id, movement_type, quantity_change, resulting_stock,
              unit_cost_tetri, reason, reference_id, user_id, created_at
            ) VALUES (?, 'return', ?, ?, NULL, '\u10D3\u10D0\u10D1\u10E0\u10E3\u10DC\u10D4\u10D1\u10D0 (\u10D5\u10D0\u10E0\u10D2\u10D8\u10E1\u10D8)', ?, ?, ?)
          `).run(m.variant_id,m.quantity,N,i.receipt_number,t.id,s);r.prepare(`
            INSERT INTO inventory_lots (variant_id, initial_quantity, remaining_quantity, unit_cost_tetri, movement_id, created_at)
            VALUES (?, ?, ?, NULL, ?, ?)
          `).run(m.variant_id,m.quantity,m.quantity,Number(g.lastInsertRowid),s)}else r.prepare(`
            INSERT INTO inventory_movements (
              variant_id, movement_type, quantity_change, resulting_stock,
              unit_cost_tetri, reason, reference_id, user_id, created_at
            ) VALUES (?, 'return', 0, ?, NULL, '\u10D3\u10D0\u10D1\u10E0\u10E3\u10DC\u10D4\u10D1\u10D0 (\u10D3\u10D0\u10D6\u10D8\u10D0\u10DC\u10D4\u10D1\u10E3\u10DA\u10D8/\u10E9\u10D0\u10DB\u10DD\u10EC\u10D4\u10E0\u10D8\u10DA\u10D8)', ?, ?, ?)
          `).run(m.variant_id,O,i.receipt_number,t.id,s)}let S=r.prepare(`
        SELECT SUM(quantity) as total_qty, SUM(returned_quantity) as total_ret
        FROM sale_items WHERE sale_id = ?
      `).get(i.id),y=S.total_ret>=S.total_qty?"returned":"partially_returned";return r.prepare("UPDATE sales SET status = ? WHERE id = ?").run(y,i.id),r.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'SALE_RETURN', 'returns', ?, ?, ?)
      `).run(t.id,String(T),`Return processed for sale ${i.receipt_number}: total ${E} tetri (debt reduced: ${o}, cash refunded: ${h})`,s),{return_id:T,total_refund_tetri:E,debt_deduction_tetri:o,cash_refund_tetri:h}},this.db)}processExchange(t,e){return L(r=>{let s=this.processReturn(t,{sale_id:e.original_sale_id,items:e.return_items,reason:"\u10D2\u10D0\u10EA\u10D5\u10DA\u10D0 (Exchange)"}),i=e.new_items.reduce((d,E)=>d+E.quantity*E.unit_price_tetri,0),n=i-s.total_refund_tetri,a=r.prepare("SELECT * FROM sales WHERE id = ?").get(e.original_sale_id),u=this.posService.checkout(t,{items:e.new_items,payment_method:"cash",customer_id:a.customer_id,cash_received_tetri:Math.max(i,0),notes:`\u10D2\u10D0\u10EA\u10D5\u10DA\u10D0 \u10D2\u10D0\u10E7\u10D8\u10D3\u10D5\u10D8\u10D3\u10D0\u10DC #${a.receipt_number}`});return r.prepare(`
        INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
        VALUES (?, 'EXCHANGE', 'sales', ?, ?, datetime('now'))
      `).run(t.id,String(u.id),`Exchange linked to original sale ${a.receipt_number}. Return value: ${s.total_refund_tetri}, New value: ${i}, Difference: ${n}`),{return_id:s.return_id,new_sale_id:u.id,difference_tetri:n}},this.db)}};var ie=class{constructor(t=I()){this.db=t}checkOwner(t){if(t.role!=="owner")throw new Error("\u10E4\u10D8\u10DC\u10D0\u10DC\u10E1\u10E3\u10E0\u10D8 \u10DB\u10DD\u10DC\u10D0\u10EA\u10D4\u10DB\u10D4\u10D1\u10D8\u10E1 \u10DC\u10D0\u10EE\u10D5\u10D8\u10E1 \u10E3\u10E4\u10DA\u10D4\u10D1\u10D0 \u10D0\u10E5\u10D5\u10E1 \u10DB\u10EE\u10DD\u10DA\u10DD\u10D3 \u10DB\u10E4\u10DA\u10DD\u10D1\u10D4\u10DA\u10E1")}getFinancialSummary(t,e,r){this.checkOwner(t);let s="WHERE 1=1",i="WHERE 1=1",n="WHERE 1=1",a="WHERE 1=1",u=[],d=[],E=[],_=[];e&&(s+=" AND created_at >= ?",i+=" AND created_at >= ?",n+=" AND created_at >= ?",a+=" AND expense_date >= ?",u.push(e),d.push(e),E.push(e),_.push(e)),r&&(s+=" AND created_at <= ?",i+=" AND created_at <= ?",n+=" AND created_at <= ?",a+=" AND expense_date <= ?",u.push(r),d.push(r),E.push(r),_.push(r));let o=this.db.prepare(`
      SELECT 
        COUNT(*) as sales_count,
        COALESCE(SUM(total_tetri), 0) as gross_revenue_tetri,
        COALESCE(SUM(cash_received_tetri - change_given_tetri), 0) as direct_cash_tetri,
        COALESCE(SUM(debt_amount_tetri), 0) as new_debt_tetri
      FROM sales ${s}
    `).get(...u),p=this.db.prepare(`
      SELECT COALESCE(SUM(amount_tetri), 0) as debt_cash_tetri
      FROM debt_repayments ${i}
    `).get(...d),h=this.db.prepare(`
      SELECT 
        COALESCE(SUM(total_refund_tetri), 0) as total_returns_tetri,
        COALESCE(SUM(cash_refund_tetri), 0) as cash_refunds_tetri
      FROM returns ${n}
    `).get(...E),l=this.db.prepare(`
      SELECT COALESCE(SUM(amount_tetri), 0) as total_expenses_tetri
      FROM expenses ${a}
    `).get(..._),T=`
      SELECT 
        si.quantity,
        si.unit_cost_tetri,
        si.total_price_tetri
      FROM sale_items si
      JOIN sales s ON si.sale_id = s.id
      ${s.replace(/created_at/g,"s.created_at")}
    `,S=this.db.prepare(T).all(...u),y=0,m=0;for(let W of S)W.unit_cost_tetri===null||W.unit_cost_tetri===void 0?m+=W.quantity:y+=W.quantity*W.unit_cost_tetri;let R=m>0,O=o.direct_cash_tetri||0,N=p.debt_cash_tetri||0,g=h.cash_refunds_tetri||0,U=O+N-g,F=l.total_expenses_tetri||0,B=U-F,j=(o.gross_revenue_tetri||0)-(h.total_returns_tetri||0),Ne=R?null:j-y-F;return{period_start:e||"\u10D3\u10D0\u10E1\u10D0\u10EC\u10E7\u10D8\u10E1\u10D8\u10D3\u10D0\u10DC",period_end:r||"\u10D3\u10E6\u10D4\u10DB\u10D3\u10D4",total_sales_count:o.sales_count||0,total_sales_revenue_tetri:o.gross_revenue_tetri||0,cash_collected_direct_tetri:O,cash_collected_debts_tetri:N,total_cash_inflow_tetri:U,total_new_debt_tetri:o.new_debt_tetri||0,total_returns_amount_tetri:h.total_returns_tetri||0,total_expenses_tetri:F,cost_of_goods_sold_tetri:y,has_unknown_costs:R,unknown_cost_items_count:m,estimated_gross_profit_tetri:Ne,net_cash_flow_tetri:B}}createExpense(t,e){if(this.checkOwner(t),e.amount_tetri<=0)throw new Error("\u10EE\u10D0\u10E0\u10EF\u10D8\u10E1 \u10D7\u10D0\u10DC\u10EE\u10D0 \u10E3\u10DC\u10D3\u10D0 \u10D8\u10E7\u10DD\u10E1 0-\u10D6\u10D4 \u10DB\u10D4\u10E2\u10D8");let r=e.description.trim();if(!r)throw new Error("\u10EE\u10D0\u10E0\u10EF\u10D8\u10E1 \u10D0\u10E6\u10EC\u10D4\u10E0\u10D0 \u10E1\u10D0\u10D5\u10D0\u10DA\u10D3\u10D4\u10D1\u10E3\u10DA\u10DD\u10D0");let s=new Date().toISOString(),i=e.expense_date||s.split("T")[0],n=this.db.prepare(`
      INSERT INTO expenses (category, description, amount_tetri, user_id, expense_date, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(e.category.trim()||"\u10E1\u10EE\u10D5\u10D0",r,e.amount_tetri,t.id,i,s),a=Number(n.lastInsertRowid);return this.db.prepare(`
      INSERT INTO audit_logs (user_id, action, entity, entity_id, details, created_at)
      VALUES (?, 'EXPENSE_CREATE', 'expenses', ?, ?, ?)
    `).run(t.id,String(a),`Expense ${r}: ${e.amount_tetri} tetri`,s),{id:a,category:e.category,description:r,amount_tetri:e.amount_tetri,user_id:t.id,user_name:t.name,expense_date:i,created_at:s}}listExpenses(t,e=100){return this.checkOwner(t),this.db.prepare(`
      SELECT e.*, u.name as user_name
      FROM expenses e
      JOIN users u ON e.user_id = u.id
      ORDER BY e.expense_date DESC, e.id DESC
      LIMIT ?
    `).all(e)}exportSalesCSV(t){this.checkOwner(t);let e=this.db.prepare(`
      SELECT s.receipt_number, s.created_at, u.name as seller, 
             c.first_name || ' ' || COALESCE(c.last_name, '') as customer,
             s.payment_method, s.total_tetri, s.cash_received_tetri, s.debt_amount_tetri, s.status
      FROM sales s
      JOIN users u ON s.user_id = u.id
      LEFT JOIN customers c ON s.customer_id = c.id
      ORDER BY s.id DESC
    `).all(),r=`\uFEFF\u10E9\u10D4\u10D9\u10D8\u10E1 #,\u10D7\u10D0\u10E0\u10D8\u10E6\u10D8,\u10D2\u10D0\u10DB\u10E7\u10D8\u10D3\u10D5\u10D4\u10DA\u10D8,\u10D9\u10DA\u10D8\u10D4\u10DC\u10E2\u10D8,\u10D2\u10D0\u10D3\u10D0\u10EE\u10D3\u10D8\u10E1 \u10DB\u10D4\u10D7\u10DD\u10D3\u10D8,\u10EF\u10D0\u10DB\u10D8 (\u20BE),\u10DB\u10D8\u10E6\u10D4\u10D1\u10E3\u10DA\u10D8 \u10DC\u10D0\u10E6\u10D3\u10D8 (\u20BE),\u10DC\u10D8\u10E1\u10D8\u10D0 (\u20BE),\u10E1\u10E2\u10D0\u10E2\u10E3\u10E1\u10D8
`;for(let s of e){let i=(s.total_tetri/100).toFixed(2),n=(s.cash_received_tetri/100).toFixed(2),a=(s.debt_amount_tetri/100).toFixed(2),u=s.payment_method==="cash"?"\u10DC\u10D0\u10E6\u10D3\u10D8":s.payment_method==="debt"?"\u10DC\u10D8\u10E1\u10D8\u10D0":"\u10E8\u10D4\u10E0\u10D4\u10E3\u10DA\u10D8",d=s.status==="completed"?"\u10D3\u10D0\u10E1\u10E0\u10E3\u10DA\u10D4\u10D1\u10E3\u10DA\u10D8":s.status==="returned"?"\u10D3\u10D0\u10D1\u10E0\u10E3\u10DC\u10D4\u10D1\u10E3\u10DA\u10D8":"\u10DC\u10D0\u10EC\u10D8\u10DA\u10DD\u10D1\u10E0\u10D8\u10D5 \u10D3\u10D0\u10D1\u10E0\u10E3\u10DC\u10D4\u10D1\u10E3\u10DA\u10D8";r+=`"${s.receipt_number}","${s.created_at}","${s.seller}","${s.customer||"-"}","${u}","${i}","${n}","${a}","${d}"
`}return r}};var ne=A(require("node:fs"),1),H=A(require("node:path"),1),ae=A(require("onnxruntime-web"),1),ye=require("node:url"),_e={};var K=class c{static{this.session=null}static{this.sessionPromise=null}static getModelPath(){let t="";try{typeof _e<"u"&&_e.url&&(t=H.default.dirname((0,ye.fileURLToPath)(_e.url)))}catch{}let e=[H.default.join(process.cwd(),"public","models","mnist.onnx"),H.default.join(process.cwd(),"dist","models","mnist.onnx"),H.default.join(process.resourcesPath||"","models","mnist.onnx"),t?H.default.join(t,"..","..","..","public","models","mnist.onnx"):""];for(let r of e)if(r&&ne.default.existsSync(r))return r;return H.default.join(process.cwd(),"public","models","mnist.onnx")}static async getSession(){return c.session?c.session:(c.sessionPromise||(c.sessionPromise=(async()=>{try{let t=c.getModelPath();if(!ne.default.existsSync(t))return console.warn(`[OCR] ONNX model not found at ${t}`),null;let e=ne.default.readFileSync(t),r=await ae.InferenceSession.create(e.buffer);return c.session=r,r}catch(t){return console.error("[OCR] Failed to initialize ONNX session:",t),null}finally{c.sessionPromise=null}})()),c.sessionPromise)}static async predictDigit(t){let e=await c.getSession();if(!e)throw new Error("ONNX InferenceSession \u10D5\u10D4\u10E0 \u10D8\u10DC\u10D8\u10EA\u10D8\u10D0\u10DA\u10D8\u10D6\u10D3\u10D0");let r=e.inputNames[0],s=new ae.Tensor("float32",t,[1,1,28,28]),i=await e.run({[r]:s}),n=e.outputNames[0],a=i[n],u=Array.from(a.data),d=Math.max(...u),E=u.map(T=>Math.exp(T-d)),_=E.reduce((T,S)=>T+S,0),o=E.map(T=>T/(_||1)),p=0,h=0;for(let T=0;T<10;T++)o[T]>h&&(h=o[T],p=T);let l=Math.max(1,Math.min(100,Math.round(h*100)));return{digit:p,confidence:l}}binarize(t,e,r){let s=e*r,i=new Uint8Array(s),n=new Int32Array(256);for(let l=0;l<s;l++){let T=l*4,S=t[T],y=t[T+1],m=t[T+2],R=Math.round(.299*S+.587*y+.114*m);i[l]=R,n[R]++}let a=0;for(let l=0;l<256;l++)a+=l*n[l];let u=0,d=0,E=0,_=0,o=128;for(let l=0;l<256;l++){if(d+=n[l],d===0)continue;if(E=s-d,E===0)break;u+=l*n[l];let T=u/d,S=(a-u)/E,y=d*E*(T-S)*(T-S);y>_&&(_=y,o=l)}let p=Math.min(220,Math.max(50,o-10)),h=new Uint8Array(s);for(let l=0;l<s;l++)h[l]=i[l]<p?1:0;return h}find5Boxes(t,e,r){let s=new Int32Array(e);for(let E=0;E<e;E++){let _=0;for(let o=0;o<r;o++)t[o*e+E]===1&&_++;s[E]=_}let i=[],n=!1,a=0,u=Math.max(2,Math.floor(r*.04));for(let E=0;E<e;E++)s[E]>=u?n||(n=!0,a=E):n&&(n=!1,E-a>3&&i.push({startX:a,endX:E}));n&&e-a>3&&i.push({startX:a,endX:e});let d=[];if(i.length===5)for(let E of i){let _=this.getVerticalBounds(t,e,r,E.startX,E.endX);_&&d.push(_)}if(d.length!==5){d.length=0;let E=e/5;for(let _=0;_<5;_++){let o=Math.floor(_*E+E*.05),p=Math.floor((_+1)*E-E*.05),h=this.getVerticalBounds(t,e,r,o,p);h?d.push(h):d.push({x:o,y:Math.floor(r*.1),width:Math.max(1,p-o),height:Math.floor(r*.8)})}}return d.slice(0,5)}getVerticalBounds(t,e,r,s,i){let n=r,a=0,u=i,d=s,E=!1;for(let _=s;_<i;_++)for(let o=0;o<r;o++)t[o*e+_]===1&&(E=!0,o<n&&(n=o),o>a&&(a=o),_<u&&(u=_),_>d&&(d=_));return!E||a<=n?null:{x:Math.max(0,u-1),y:Math.max(0,n-1),width:Math.min(e-u,d-u+3),height:Math.min(r-n,a-n+3)}}normalizeTo28x28Float(t,e,r){let s=new Float32Array(784);if(r.width<=0||r.height<=0)return s;let i=r.width/20,n=r.height/20,a=4,u=4;for(let d=0;d<20;d++){let E=Math.min(r.y+r.height-1,Math.floor(r.y+d*n));for(let _=0;_<20;_++){let o=Math.min(r.x+r.width-1,Math.floor(r.x+_*i)),p=t[E*e+o];s[(u+d)*28+(a+_)]=p===1?1:0}}return s}async recognize5Digits(t,e,r){let s=this.binarize(t,e,r),i=this.find5Boxes(s,e,r),n=[],a=0;for(let _=0;_<5;_++){let o=i[_]||{x:_*e/5,y:0,width:e/5,height:r},p=this.normalizeTo28x28Float(s,e,o),h=await c.predictDigit(p);n.push({digit:String(h.digit),confidence:h.confidence,box:o}),a+=h.confidence}let u=n.map(_=>_.digit).join(""),d=Math.round(a/5),E=/^\d{5}$/.test(u);return{code:u,confidence:d,digits:n,isFiveDigits:E,modelUsed:"mnist.onnx"}}};async function Re(c){try{let{channel:t,payload:e,token:r}=c,s=new Z,i=new ee,n=new q,a=new te,u=new re,d=new se,E=new ie,_=new $;if(t==="auth:hasOwner")return{success:!0,data:s.hasOwner()};if(t==="auth:setupOwner")return{success:!0,data:s.setupInitialOwner(e.name,e.pin)};if(t==="auth:getActiveUsers")return{success:!0,data:s.getActiveUsers()};if(t==="auth:login")return{success:!0,data:s.login(e.userId,e.pin)};if(!r)return{success:!1,error:"\u10D0\u10D5\u10E2\u10DD\u10E0\u10D8\u10D6\u10D0\u10EA\u10D8\u10D0 \u10D0\u10E0 \u10D0\u10E0\u10D8\u10E1 \u10D2\u10D0\u10D5\u10DA\u10D8\u10DA\u10D8 (No token)"};let o=Se(r);return o?t==="auth:getAllUsers"?{success:!0,data:s.getAllUsers(o)}:t==="auth:addUser"?{success:!0,data:s.addUser(o,e.name,e.pin,e.role)}:t==="auth:setUserActive"?(s.setUserActive(o,e.userId,e.isActive),{success:!0}):t==="auth:resetPin"?(s.resetPin(o,e.userId,e.newPin),{success:!0}):t==="products:getCategories"?{success:!0,data:i.getCategories()}:t==="products:createCategory"?{success:!0,data:i.createCategory(o,e.name)}:t==="products:deleteCategory"?(i.deleteCategory(o,e.categoryId),{success:!0}):t==="products:list"?{success:!0,data:i.listProducts(e)}:t==="products:getById"?{success:!0,data:i.getProductById(e.productId)}:t==="products:lookupCode"?{success:!0,data:i.lookupByCode(e.code)}:t==="ocr:isModelReady"?{success:!0,data:{ready:!!await K.getSession(),model:"mnist.onnx"}}:t==="ocr:recognize"?{success:!0,data:await new K().recognize5Digits(e.pixels,e.width,e.height)}:t==="products:create"?{success:!0,data:i.createProduct(o,e)}:t==="products:addImage"?{success:!0,data:i.addImage(o,e.productId,e.filePath,e.isPrimary)}:t==="products:deleteImage"?(i.deleteImage(o,e.imageId),{success:!0,data:{deleted:!0}}):t==="inventory:restock"?{success:!0,data:a.restockVariant(o,e)}:t==="inventory:correct"?{success:!0,data:a.correctStock(o,e)}:t==="inventory:getMovements"?{success:!0,data:a.getMovements(e?.variantId,e?.limit)}:t==="pos:checkout"?{success:!0,data:n.checkout(o,e)}:t==="pos:searchSales"?{success:!0,data:n.searchSales(e)}:t==="pos:getSale"?{success:!0,data:n.getSaleById(e.saleId)}:t==="customers:list"?{success:!0,data:u.listCustomers(e?.searchTerm)}:t==="customers:get"?{success:!0,data:u.getCustomerById(e.customerId)}:t==="customers:create"?{success:!0,data:u.createCustomer(o,e)}:t==="customers:repay"?{success:!0,data:u.recordRepayment(o,e)}:t==="customers:getRepayments"?{success:!0,data:u.getRepayments(e.customerId)}:t==="returns:process"?{success:!0,data:d.processReturn(o,e)}:t==="returns:exchange"?{success:!0,data:d.processExchange(o,e)}:t==="finance:summary"?{success:!0,data:E.getFinancialSummary(o,e?.startDate,e?.endDate)}:t==="finance:createExpense"?{success:!0,data:E.createExpense(o,e)}:t==="finance:listExpenses"?{success:!0,data:E.listExpenses(o,e?.limit)}:t==="finance:exportSalesCSV"?{success:!0,data:E.exportSalesCSV(o)}:t==="backup:create"?{success:!0,data:_.createBackup(o,e?.targetDir)}:t==="backup:list"?{success:!0,data:_.listBackups(o)}:t==="backup:verify"?{success:!0,data:_.verifyBackup(o,e?.dataString,e?.filename)}:t==="backup:runDaily"?{success:!0,data:_.checkAndRunDailyBackup(o)}:t==="backup:restore"?{success:!0,data:_.restoreBackup(o,e.base64Data,e.expectedChecksum)}:t==="backup:getLogs"?{success:!0,data:_.getAuditLogs(e?.limit)}:t==="backup:getSettings"?{success:!0,data:_.getSettings()}:t==="backup:updateSettings"?(_.updateSettings(o,e.settings),{success:!0}):t==="system:getErrorLogs"?{success:!0,data:_.getErrorLogs(e?.limit)}:t==="system:clearErrorLogs"?(_.clearErrorLogs(o),{success:!0}):t==="auth:resetStoreDatabase"?(s.resetStoreDatabase(o,e?.pin),{success:!0}):{success:!1,error:`\u10E3\u10EA\u10DC\u10DD\u10D1\u10D8 IPC \u10D0\u10E0\u10EE\u10D8: "${t}"`}:{success:!1,error:"\u10E1\u10D4\u10E1\u10D8\u10D0 \u10D5\u10D0\u10D3\u10D0\u10D2\u10D0\u10E1\u10E3\u10DA\u10D8\u10D0, \u10D2\u10D7\u10EE\u10DD\u10D5\u10D7 \u10EE\u10D4\u10DA\u10D0\u10EE\u10DA\u10D0 \u10E8\u10D4\u10D8\u10E7\u10D5\u10D0\u10DC\u10DD\u10D7 PIN \u10D9\u10DD\u10D3\u10D8"}}catch(t){if(t.message&&(t.message.includes("PIN")||t.message.includes("\u10DB\u10D0\u10E0\u10D0\u10D2\u10D8")||t.message.includes("\u10E4\u10DD\u10E0\u10DB\u10D0\u10E2\u10D8")||t.message.includes("\u10DC\u10D0\u10D9\u10DA\u10D4\u10D1\u10D8\u10D0")||t.message.includes("\u10E1\u10D0\u10D5\u10D0\u10DA\u10D3\u10D4\u10D1\u10E3\u10DA\u10DD\u10D0")))console.log(`[IPC Validation in ${c.channel}]: ${t.message}`);else{console.error(`[IPC Error in ${c.channel}]:`,t);try{new $().logSystemError(c.channel,t.message,t.stack,"error")}catch{}}return{success:!1,error:t.message||"\u10D3\u10D0\u10E4\u10D8\u10E5\u10E1\u10D8\u10E0\u10D3\u10D0 \u10E1\u10D8\u10E1\u10E2\u10D4\u10DB\u10E3\u10E0\u10D8 \u10E8\u10D4\u10EA\u10D3\u10DD\u10DB\u10D0"}}}var M=null,Ue=C.app.requestSingleInstanceLock();Ue?(C.app.on("second-instance",()=>{M&&(M.isMinimized()&&M.restore(),M.focus())}),C.app.whenReady().then(()=>{let c=C.app.getPath("userData"),t=w.default.join(c,"data");process.env.STORE_DATA_DIR=t;let e=w.default.join(t,"store.db");process.env.STORE_DB_PATH=e,x.default.existsSync(t)||x.default.mkdirSync(t,{recursive:!0});let r=w.default.join(t,"images");x.default.existsSync(r)||x.default.mkdirSync(r,{recursive:!0});let s=w.default.join(t,"backups");x.default.existsSync(s)||x.default.mkdirSync(s,{recursive:!0}),console.log(`[StorePOS Main] Initializing SQLite database at: ${e}`),X(e),C.ipcMain.handle("api:ipc",async(d,E)=>await Re(E));let i=[w.default.join(__dirname,"preload.cjs"),w.default.join(__dirname,"preload.js"),w.default.join(__dirname,"../dist-electron/preload.cjs"),w.default.join(C.app.getAppPath(),"dist-electron","preload.cjs")],n=i.find(d=>x.default.existsSync(d))||i[0],u=[w.default.join(C.app.getAppPath(),"resources","icons","icon.ico"),w.default.join(__dirname,"../resources/icons/icon.ico"),w.default.join(process.resourcesPath||"","icons","icon.ico")].find(d=>x.default.existsSync(d));if(M=new C.BrowserWindow({width:1440,height:900,minWidth:1280,minHeight:720,title:"StorePOS \u2014 \u10DA\u10DD\u10D9\u10D0\u10DA\u10E3\u10E0\u10D8 \u10DB\u10D0\u10E6\u10D0\u10D6\u10D8\u10D8\u10E1 \u10DB\u10D0\u10E0\u10D7\u10D5\u10D0 (Offline)",icon:u,backgroundColor:"#020617",autoHideMenuBar:!0,webPreferences:{preload:n,contextIsolation:!0,nodeIntegration:!1,sandbox:!0,webSecurity:!0}}),M.setMenuBarVisibility(!1),process.env.VITE_DEV_SERVER_URL)M.loadURL(process.env.VITE_DEV_SERVER_URL);else{let d=[w.default.join(C.app.getAppPath(),"dist","index.html"),w.default.join(__dirname,"../dist/index.html"),w.default.join(process.resourcesPath||"","app.asar","dist","index.html")],E=d.find(_=>x.default.existsSync(_))||d[0];console.log(`[StorePOS Main] Loading UI from: ${E}`),M.loadFile(E)}M.on("closed",()=>{M=null})}),C.app.on("window-all-closed",()=>{z(),process.platform!=="darwin"&&C.app.quit()})):C.app.quit();
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Database Schema Migrations for SQLite.
 * Uses strict transactions, foreign key constraints, integer tetri representation,
 * and tracks executed migrations in schema_migrations table.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * SQLite Database Connection and Lifecycle Management.
 * Runs in Node.js (Electron main process, server, and tests).
 * Enforces PRAGMA foreign_keys = ON and PRAGMA journal_mode = WAL.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Secure salted PIN hashing for StorePOS offline desktop application.
 * Plaintext PINs are NEVER stored in the database or logs.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Production-Grade Backup, Restore, and Data Protection Service (M8).
 * Features:
 * - SQLite Online Snapshot & WAL flush (PRAGMA wal_checkpoint(TRUNCATE))
 * - Real product photo file bundling (base64 binary preservation)
 * - PRAGMA integrity_check verification before backup & before restore
 * - Zero-connection file replacement: closes active SQLite connection before overwriting
 * - Safety snapshot before restore and emergency backup before wipe
 * - Configurable backup directory (supports external drives & USB)
 * - Automatic daily backups with last_backup_date tracking
 * - Log sanitization (never logs PINs or session tokens)
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Authentication and User Management Service.
 * Runs in main process / backend.
 * Enforces Role-Based Access Control (RBAC): Owner vs Seller.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Products, Categories, Variants, and Codes Domain Service.
 * Runs in main process / backend with SQLite transactions.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Point of Sale (POS) & Checkout Domain Service.
 * Implements strict atomic checkout transactions, stock deduction,
 * cash/debt/mixed payment validation, and FIFO lot depletion.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Inventory Management Domain Service.
 * Handles Restock, Stock Corrections, and Movement Ledgers.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Customer and Debt Management Domain Service.
 * Tracks customer profiles, outstanding debts, and partial/full repayments.
 * CRITICAL RULE: Debt repayment is a cash collection and NOT counted as a new sale.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Returns & Exchanges Domain Service.
 * Ensures returns are linked to real sales, validates available returnable quantity,
 * deducts open debt first before any cash refund, and handles resellable vs damaged stock.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Financial Reporting and Store Expenses Domain Service (Owner Only).
 * Implements strict separation between:
 * - Sales Revenue
 * - Cash Inflow (direct cash + debt collections - cash returns)
 * - Receivables (open debts)
 * - Returns & Cost of Goods Sold (COGS)
 * - Profit Calculation with explicit warning for unknown purchase costs.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Offline OCR Domain Service (M6).
 * Executes real ONNX neural network inference for 5-digit handwritten codes (MNIST-trained).
 * 100% offline, local execution without Cloud, API, or external network requests.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Central IPC Handlers & Dispatcher.
 * Validates session tokens, enforces backend permissions, and invokes domain services.
 * Renderer NEVER has raw database or file system access.
 */
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Electron Main Process Entry Point for StorePOS (Production Windows Desktop).
 * Features:
 * - Single-instance enforcement (prevents multiple processes touching SQLite)
 * - Safe persistent storage in Windows %APPDATA%/StorePOS/data (isolated from installer)
 * - Pre-creation of required folders: data, images, backups
 * - SQLite initialization with WAL mode, foreign keys, and synchronous=FULL durability
 * - Secure sandboxed IPC dispatcher (contextIsolation: true, sandbox: true)
 * - Offline asset loading from dist/index.html (no localhost or Express required in production)
 */
