# SENTRY Messenger — i18n 導入可行性評估

## 1. 現狀分析

### 1.1 技術架構
- **前端框架**: Vanilla JavaScript（無 React/Vue）
- **打包工具**: esbuild（支援 ES module、code splitting）
- **部署**: Cloudflare Pages（靜態 + Pages Functions）
- **後端**: Node.js Express（API 回傳結構化資料，無 UI 文字）

### 1.2 目前語系狀態
- **完全沒有 i18n 基礎設施**，所有 UI 文字為繁體中文硬編碼
- HTML 已標記 `lang="zh-Hant"`
- 無任何翻譯檔案、語言切換機制

### 1.3 需要翻譯的字串規模

| 類別 | 涉及檔案數 | 預估字串數 | 說明 |
|------|-----------|-----------|------|
| JS UI 元件（DOM 操作） | 27 個檔案 | ~142 處 | `.textContent`、`.innerHTML` 等賦值 |
| JS 全部中文字串 | 65 個檔案 | ~860 處 | 含 log、error message、狀態文字等 |
| HTML 模板 | 3 個檔案 | ~50 處 | `placeholder`、`aria-label`、靜態文字 |
| **合計** | **~68 個檔案** | **~910 處** | 部分為 debug/log 用途，不一定需要翻譯 |

### 1.4 字串分佈熱點（前 10）

| 檔案 | 中文字串數 |
|------|-----------|
| `drive-pane.js` | 88 |
| `share-controller.js` | 76 |
| `app.html` | 41 |
| `subscription-modal.js` | 40 |
| `call-overlay.js` | 38 |
| `media-handling-controller.js` | 37 |
| `renderer.js` | 26 |
| `ui-utils.js` | 26 |
| `app-mobile.js` | 25 |
| `composer-controller.js` | 23 |

---

## 2. 建議架構

### 2.1 目錄結構

```
web/src/locales/
├── index.js          # i18n 核心模組（語言載入、fallback、t() 函式）
├── en.json           # English（fallback 預設語言）
├── zh-Hant.json      # 繁體中文（目前主要語言）
├── zh-Hans.json      # 簡體中文（未來可擴充）
└── ja.json           # 日文（未來可擴充）
```

### 2.2 核心模組設計（`locales/index.js`）

```js
// web/src/locales/index.js
let currentLang = 'zh-Hant';
let messages = {};
let fallbackMessages = {};  // 永遠載入 en.json 作為 fallback

/**
 * 初始化 i18n — 載入語言包
 * @param {string} lang - BCP 47 語言標籤，例如 'en', 'zh-Hant', 'ja'
 */
export async function initI18n(lang = detectLang()) {
  // 永遠先載入 fallback（英文）
  fallbackMessages = await loadJSON('/locales/en.json');

  if (lang !== 'en') {
    try {
      messages = await loadJSON(`/locales/${lang}.json`);
    } catch {
      // 不支援的語言 → fallback 到英文
      console.warn(`[i18n] Locale "${lang}" not found, falling back to English`);
      messages = {};
    }
  }

  currentLang = lang;
  document.documentElement.lang = lang;
}

/**
 * 取得翻譯字串
 * 支援巢狀 key（如 'messages.send'）和插值（如 '{name}'）
 */
export function t(key, params = {}) {
  const val = resolve(messages, key) ?? resolve(fallbackMessages, key) ?? key;
  return typeof val === 'string'
    ? val.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`)
    : val;
}

/**
 * 偵測使用者語言偏好
 */
function detectLang() {
  // 1. localStorage 使用者設定 > 2. 瀏覽器偏好 > 3. fallback
  return localStorage.getItem('sentry-lang')
    ?? navigator.language
    ?? 'en';
}

function resolve(obj, path) {
  return path.split('.').reduce((o, k) => o?.[k], obj);
}

async function loadJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
```

### 2.3 語言包範例

**`en.json`**（English — fallback）：
```json
{
  "common": {
    "loading": "Loading…",
    "loadMore": "Load more",
    "refreshing": "Refreshing…",
    "delete": "Delete",
    "cancel": "Cancel",
    "confirm": "Confirm",
    "save": "Save",
    "send": "Send"
  },
  "status": {
    "online": "Online",
    "offline": "Offline",
    "connecting": "Connecting…",
    "unstableNetwork": "Unstable network"
  },
  "contacts": {
    "noFriends": "No friends added yet",
    "selectToChat": "Select a friend to start chatting",
    "addFriend": "Add friend",
    "deleteFriend": "Delete friend",
    "createGroup": "Create group"
  },
  "messages": {
    "noMessages": "No messages",
    "newMessage": "New message",
    "sendFailed": "Send failed",
    "systemMessage": "System message",
    "secureConnectionEstablished": "Secure connection established"
  },
  "calls": {
    "callLog": "Call log",
    "answer": "Answer",
    "answerVideo": "Answer video call",
    "micPermissionRequired": "Microphone permission is required for voice calls"
  },
  "settings": {
    "title": "Settings",
    "changePassword": "Change password",
    "editNickname": "Edit nickname",
    "updateAvatar": "Update avatar"
  },
  "auth": {
    "accountExpired": "Account expired",
    "accountLoggedInElsewhere": "Account logged in on another device",
    "accountCleared": "Account has been cleared",
    "subscription": "Subscription / Top-up"
  }
}
```

**`zh-Hant.json`**（繁體中文）：
```json
{
  "common": {
    "loading": "載入中…",
    "loadMore": "載入更多",
    "refreshing": "刷新中…",
    "delete": "刪除",
    "cancel": "取消",
    "confirm": "確認",
    "save": "儲存",
    "send": "送出"
  },
  "status": {
    "online": "在線",
    "offline": "離線",
    "connecting": "連線中…",
    "unstableNetwork": "網路不穩"
  },
  "contacts": {
    "noFriends": "尚未新增好友",
    "selectToChat": "選擇好友開始聊天",
    "addFriend": "新增好友",
    "deleteFriend": "刪除好友",
    "createGroup": "建立群組"
  }
}
```

### 2.4 使用方式（改造前後對比）

**改造前：**
```js
el.textContent = '載入中…';
toast.show('傳送失敗');
btn.textContent = `已選擇 ${count} 個檔案`;
```

**改造後：**
```js
import { t } from '/locales/index.js';

el.textContent = t('common.loading');
toast.show(t('messages.sendFailed'));
btn.textContent = t('files.selected', { count });
```

### 2.5 HTML 靜態文字處理

對於 `app.html`、`login.html` 中的靜態文字，使用 `data-i18n` attribute 標記：

```html
<!-- 改造前 -->
<span>搜尋好友名稱…</span>
<input placeholder="輸入訊息…">

<!-- 改造後 -->
<span data-i18n="contacts.searchPlaceholder">Search friends…</span>
<input data-i18n-placeholder="messages.inputPlaceholder" placeholder="Type a message…">
```

在 `initI18n()` 完成後掃描 DOM：

```js
function applyDOMTranslations() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll('[data-i18n-aria-label]').forEach(el => {
    el.setAttribute('aria-label', t(el.dataset.i18nAriaLabel));
  });
}
```

---

## 3. Fallback 機制

```
使用者設定語言 (localStorage)
       ↓ 有對應語言包？
      YES → 使用該語言包
       NO ↓
瀏覽器語言 (navigator.language)
       ↓ 有對應語言包？
      YES → 使用該語言包
       NO ↓
      English (en.json) ← 最終 fallback
```

**Key-level fallback**：即使載入了某語言包，若特定 key 缺失，`t()` 函式會自動回退到英文。這允許漸進式翻譯——不需要一次翻譯完所有字串。

---

## 4. 與 esbuild 的整合

### 方案 A：Runtime 載入（推薦）
- 語言包作為靜態 JSON 檔案，放在 `dist/locales/` 目錄
- 透過 `fetch()` 在 runtime 動態載入
- **優點**：新增語言無需重新打包；語言包可獨立快取
- **缺點**：首次載入多一個 HTTP request
- **整合方式**：修改 `build.mjs`，將 `src/locales/*.json` 複製到 `dist/locales/`

```js
// build.mjs 新增
cpSync(resolve(src, 'locales'), resolve(dist, 'locales'), { recursive: true });
```

### 方案 B：Build-time 內嵌
- 透過 esbuild plugin 將語言包 inline 進 JS bundle
- **優點**：零額外 HTTP request
- **缺點**：新增語言需重新打包；bundle 體積增加
- **不推薦**：不利於未來擴充

---

## 5. 實施計畫

### Phase 1：基礎設施建立（1-2 天）
1. 建立 `web/src/locales/` 目錄結構
2. 實作 `index.js` 核心模組（`t()`、`initI18n()`、`detectLang()`）
3. 建立 `en.json` 和 `zh-Hant.json` 初始語言包
4. 修改 `build.mjs` 複製語言包到 `dist/`
5. 在 `app-mobile.js` 和 `login-ui.js` 啟動時呼叫 `initI18n()`

### Phase 2：高頻元件改造（3-5 天）
優先改造字串密度最高的檔案：
1. `drive-pane.js`（88 處）
2. `share-controller.js`（76 處）
3. `app.html`（41 處）
4. `subscription-modal.js`（40 處）
5. `call-overlay.js`（38 處）

### Phase 3：全面改造（5-7 天）
- 改造剩餘 60+ 個檔案
- 處理 `login.html` 靜態文字
- 處理動態生成的文字（template literals）

### Phase 4：語言切換 UI（1 天）
- 在設定頁面新增語言選擇器
- 切換後儲存至 `localStorage` 並重載頁面

### Phase 5：新增語言（按需）
- 每新增一個語言只需建立對應 JSON 檔案
- 缺失的 key 自動 fallback 到英文

---

## 6. 風險與注意事項

### 6.1 不需要 npm 套件
此方案為**純手寫 i18n 模組**，不引入任何第三方 i18n 函式庫（如 i18next、FormatJS），原因：
- 本專案使用 Vanilla JS，無框架綁定需求
- 字串用途單純（無複雜的複數規則、日期格式化等）
- 減少依賴有利於安全審計（符合 SENTRY 的安全理念）
- 自行實作的模組約 50 行程式碼，完全可控

### 6.2 需注意的風險
| 風險 | 影響 | 緩解措施 |
|------|------|---------|
| 字串遺漏 | 部分 UI 顯示英文 | Key-level fallback 確保不會 crash |
| Template literal 中的中文 | 翻譯困難 | 改為 `t(key, params)` 插值語法 |
| HTML 中的行內文字 | 需手動標記 | `data-i18n` attribute 批次處理 |
| SRI hash 變動 | build 產出改變 | build.mjs 已自動處理 SRI |
| 首次載入延遲 | 語言包 fetch | JSON 檔案極小（< 10KB），影響微乎其微 |
| 後端 error message | 客戶端無法翻譯 | 後端回傳 error code，前端查表翻譯 |

### 6.3 不在範圍內
- **後端 API 回應訊息**：後端應回傳結構化 error code，前端負責翻譯
- **日期/數字格式化**：可直接使用 `Intl.DateTimeFormat` / `Intl.NumberFormat`，無需 i18n 函式庫
- **RTL 語系支援**：目前不在需求範圍

---

## 7. 結論

| 面向 | 評估 |
|------|------|
| **技術可行性** | ✅ 高 — Vanilla JS + esbuild 架構可直接支援，無技術障礙 |
| **實施難度** | ⚠️ 中 — 主要工作量在字串提取（~910 處），但可漸進式完成 |
| **對現有功能影響** | ✅ 低 — Key-level fallback 確保不會因缺少翻譯而 crash |
| **維護成本** | ✅ 低 — 新增語言只需加 JSON 檔案 |
| **推薦方案** | Runtime 載入 + 自行實作 i18n 模組（約 50 行程式碼） |
| **預估總工時** | 10-15 天（含全面改造） |
