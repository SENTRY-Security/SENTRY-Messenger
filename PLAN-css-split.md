# 方案 B：app-inline.css 按功能拆分計畫

## 現狀
- `app-inline.css`：4,782 行，單一檔案包含所有元件樣式
- 已有獨立 CSS：`styles.css`、`profile-extra.css`、`cropper.css`

## 拆分原則
1. 按 UI 功能區塊分檔，每檔 ≥100 行才值得獨立
2. `:root` 變數 + 全域 reset + 共用 keyframes 放 `base.css`，最先載入
3. 各功能檔獨立無相依，載入順序不影響正確性
4. Media query 跟隨所屬元件（不另外抽出 responsive 檔）

---

## 拆分方案（9 個檔案）

### 1. `app-base.css` — 變數 / Reset / 共用工具 / 動畫
| 來源行範圍 | 內容 |
|-----------|------|
| 1-34 | `:root` CSS variables + 全域 reset |
| 3342-3354 | `prefers-reduced-motion` |
| 3683-3693 | `.sr-only` |
| 3062-3084 | `@keyframes` msg-shimmer / msg-reveal / msg-reveal-scan |
| 3666-3681 | `@keyframes` hintPulse |
| 3842-3850 | `@keyframes` share-spinner |
| 4103-4119 | `@keyframes` modal-spin / modal-pop |
| **合計** | **~130 行** |

### 2. `app-layout.css` — 頂欄 / 導航列 / 版面容器 / 方向鎖定
| 來源行範圍 | 內容 |
|-----------|------|
| 36-110 | topbar + connection indicator |
| 112-235 | user menu + avatar dropdown |
| 786-833 | content container + fullscreen |
| 834-860 | messages-header |
| 862-965 | navbar + buttons + badges + icon stacks |
| 1616-1619 | navbtn touch-action |
| 2085-2120 | orientation overlay |
| 3430-3460 | keyboard-open mode（隱藏 topbar/navbar） |
| **合計** | **~380 行** |

### 3. `app-subscription.css` — 訂閱 / 頻道 / 掃描結果
| 來源行範圍 | 內容 |
|-----------|------|
| 236-784 | subscription status, pills, metrics, tabs, steps, channels, scan pane |
| **合計** | **~549 行** |

### 4. `app-contacts.css` — 聯絡人 / 表單控件 / 列表
| 來源行範圍 | 內容 |
|-----------|------|
| 967-1098 | tab display + refresh spinners |
| 1100-1227 | contact items + swipe delete + empty state |
| 1229-1297 | form inputs + buttons + loading |
| 1302-1377 | breadcrumbs + list action buttons |
| **合計** | **~340 行** |

### 5. `app-drive.css` — 雲端硬碟 / 檔案列表 / 上傳 / 資料夾
| 來源行範圍 | 內容 |
|-----------|------|
| 1378-1604 | storage bar + file items + swipe + empty state |
| 1606-1614 | output pre display |
| 2144-2201 | folder modal |
| 2203-2281 | upload modal |
| **合計** | **~360 行** |

### 6. `app-modals.css` — 通用 Modal 系統 + 各功能 Modal
| 來源行範圍 | 內容 |
|-----------|------|
| 1620-2070 | modal base + header + body + viewers + PDF + security modal + progress modal |
| 2071-2083 | PDF responsive |
| 2122-2142 | progress bar / loading text |
| 4067-4107 | loading modal + spinner |
| 4109-4119 | → 動畫移至 base（此處刪除） |
| 4121-4182 | version modal |
| 4184-4221 | confirm modal |
| 4307-4532 | settings modal + subscription modal shell + form items |
| 4534-4582 | settings switch toggle |
| 4584-4637 | change-password modal |
| 4329-4415 | logout modal + redirect cover |
| **合計** | **~940 行** |

### 7. `app-messages.css` — 訊息面板 / 對話列表 / 氣泡 / Composer
| 來源行範圍 | 內容 |
|-----------|------|
| 2521-2783 | messages pane + sidebar + conversation list |
| 2785-2912 | thread container + header + scroll area |
| 2914-3061 | message bubbles (不含 keyframes) |
| 3086-3255 | message files + preview |
| 3256-3340 | message colors + status indicators |
| 3356-3429 | composer |
| 3461-3531 | messages responsive (max-width: 959px) |
| 4223-4293 | toast notifications |
| 4295-4305 | message separator |
| **合計** | **~1,150 行** |

### 8. `app-profile.css` — 個人檔案 / 暱稱 / 頭像裁切
| 來源行範圍 | 內容 |
|-----------|------|
| 2283-2434 | profile card + avatar + stats + share button |
| 2436-2478 | nickname modal |
| 2480-2519 | QR placeholder + contact list header + modal-open state |
| 3533-3575 | profile responsive (max-width: 600px) |
| 3577-3665 | avatar cropper modal (不含 keyframes) |
| **合計** | **~340 行** |

### 9. `app-share.css` — 分享 Modal / QR / 掃描 + 權限 / 安全
| 來源行範圍 | 內容 |
|-----------|------|
| 3695-3841 | share modal + 3D flip + countdown + refresh |
| 3851-3895 | share close + countdown empty |
| 3896-3981 | corner toggle (QR vs scan) |
| 3983-4065 | QR display + scan video + preview wrap |
| 4639-4782 | security locked + media permission overlay |
| **合計** | **~510 行** |

---

## 行數統計

| 檔案 | 行數 | 佔比 |
|------|-----:|-----:|
| app-base.css | ~130 | 2.7% |
| app-layout.css | ~380 | 7.9% |
| app-subscription.css | ~549 | 11.5% |
| app-contacts.css | ~340 | 7.1% |
| app-drive.css | ~360 | 7.5% |
| app-modals.css | ~940 | 19.7% |
| app-messages.css | ~1,150 | 24.1% |
| app-profile.css | ~340 | 7.1% |
| app-share.css | ~510 | 10.7% |
| **合計** | **~4,700** | **~98%** |

> 差異 ~80 行為空行與跨區塊邊界的重疊計算

---

## app.html 載入順序

```html
<!-- 共用基底 -->
<link rel="stylesheet" href="/assets/styles.css" />
<link href="https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css" rel="stylesheet" />
<link rel="stylesheet" href="/assets/profile-extra.css" />
<link rel="stylesheet" href="/assets/cropper.css" />

<!-- app-inline.css 拆分後 -->
<link rel="stylesheet" href="/assets/app-base.css" />
<link rel="stylesheet" href="/assets/app-layout.css" />
<link rel="stylesheet" href="/assets/app-subscription.css" />
<link rel="stylesheet" href="/assets/app-contacts.css" />
<link rel="stylesheet" href="/assets/app-drive.css" />
<link rel="stylesheet" href="/assets/app-modals.css" />
<link rel="stylesheet" href="/assets/app-messages.css" />
<link rel="stylesheet" href="/assets/app-profile.css" />
<link rel="stylesheet" href="/assets/app-share.css" />
```

## 實作步驟

1. 依上方行範圍從 `app-inline.css` 提取各區塊，寫入對應新檔
2. 共用 keyframes 統一收進 `app-base.css`（從原位置移除）
3. 更新 `app.html`：移除單一 `<link href="app-inline.css">`，換成 9 個 `<link>`
4. 刪除 `app-inline.css`
5. 瀏覽器測試：確認所有頁面樣式無異
6. Commit + push

## 風險

- **極低**：純 CSS 搬移，不改任何選擇器或屬性值
- **唯一風險**：如果有 CSS 規則依賴「在同一檔案內的順序」來覆蓋（後寫的覆蓋先寫的），拆檔後載入順序必須維持。上方載入順序已按原檔行號排列，與原始順序一致。
