# 聯絡人列表捲動驅動重構計劃

## 目標

重寫聯絡人 tab 的捲動機制，讓原生 scroll 驅動漸進式隱藏 UI，最終達到全螢幕列表。
取代現有 touchmove + passive:false 的做法，徹底解決無法捲動的問題。

## 行為規格

### 往上滑（scrollTop 增加）

| 階段 | scrollTop 範圍 | 行為 |
|------|---------------|------|
| 1 | 0 → headerH (~40px) | 「N個好友」依比例淡出（opacity） |
| 2 | headerH → headerH+searchH (~90px) | 搜尋 bar 自然捲出可視區 |
| 3 | > headerH+searchH | topbar 向上滑出、navbar 向下滑出（漸進 ~60px） |

全部是**位置驅動**。

### 往下滑（從全螢幕狀態）

| 順序 | 觸發條件 | 行為 |
|------|---------|------|
| 1 | 方向改變瞬間 | topbar + navbar 立即動畫回復 |
| 2 | 繼續往下滑 | 搜尋 bar 自然捲回 |
| 3 | scrollTop 40→0 | 「N個好友」淡入 |

隱藏＝位置驅動，回復＝方向驅動。

### 特殊狀況

- scrollTop === 0 且 bars 可見 → 允許 pull-to-refresh
- 切換到其他 tab → 強制回復 bars
- bars 回復後再往上滑 → 再次隱藏（循環）

---

## 實作步驟

### Step 1: 新建 contacts-scroll-controller.js

`web/src/app/ui/mobile/contacts-scroll-controller.js`

職責：
- 監聽 `contactsScrollEl` 的原生 `scroll` 事件
- 追蹤捲動方向（比較 scrollTop 與 prevScrollTop）
- 計算階段並驅動所有視覺變化
- 管理 pull-to-refresh 觸發條件
- 提供 `destroy()` 清理和 `restoreBars()` 供 tab 切換呼叫

狀態變數：
- `prevScrollTop` — 方向偵測
- `barsHidden` — bars 是否已隱藏
- `headerH` / `searchH` — 從 DOM 量測（一次）
- `rafId` — requestAnimationFrame 節流

### Step 2: 「N個好友」淡出（階段 1）

scroll handler 內：
```js
opacity = clamp(1 - scrollTop / headerH, 0, 1)
contactListHeaderEl.style.opacity = opacity
```
opacity = 0 時加 `visibility: hidden`。

### Step 3: topbar/navbar 隱藏（階段 3 — 位置驅動）

scrollTop 超過 barThreshold (headerH + searchH) 後：
```js
barRange = 60
progress = clamp((scrollTop - barThreshold) / barRange, 0, 1)
topbar.style.transform = `translateY(${-progress * 100}%)`
navbar.style.transform = `translateY(${progress * 100}%)`
```
progress = 1 時：加 `.contacts-fullscreen` class 讓 tab 擴展到全螢幕。

### Step 4: topbar/navbar 回復（方向驅動）

偵測到 scrollTop < prevScrollTop（往下滑）時：
- 若 bars 已隱藏 → 立即移除 transform，加 CSS transition 做平滑動畫
- 移除 `.contacts-fullscreen`
- 設 `barsHidden = false`

再次往上滑超過門檻 → 重新隱藏。

### Step 5: 全螢幕佈局

CSS：
```css
#tab-contacts.contacts-fullscreen {
  position: fixed;
  inset: 0;
  height: auto;
  z-index: 9;
}
#tab-contacts.contacts-fullscreen .contacts-scroll {
  padding-bottom: 28px; /* 移除 navbar 高度的 padding */
}
```

### Step 6: pull-to-refresh 整合

保留現有 pull-to-refresh，但加入前置條件：
- 僅在 `scrollTop === 0` **且** `barsHidden === false` 時啟動
- pull-to-refresh 繼續使用 touchmove（僅用於下拉手勢）
- 一般捲動完全由原生 scroll 處理，不被 touchmove 阻擋

### Step 7: tab 切換清理

`switchTab()` 切離 contacts 時呼叫 `restoreBars()`，確保其他 tab 的 topbar/navbar 正常。

### Step 8: CSS 變更

- `app-contacts.css`：新增 `.contacts-fullscreen`、`will-change: opacity` on header
- `app-layout.css`：topbar/navbar 加 `transition: transform 220ms ease-out`、`will-change: transform`

### Step 9: 清理舊 workaround

- 移除 pull-to-refresh 對 scroll container 的 transform: translateY 操作
- 清理殘留的 transition/transform inline styles

---

## 修改的檔案

| 檔案 | 變更 |
|------|------|
| `contacts-scroll-controller.js` | **新建** — 捲動控制器 |
| `contacts-view.js` | 整合 scroll controller，簡化 pull-to-refresh |
| `app-mobile.js` | tab 切換時呼叫 restoreBars() |
| `app-contacts.css` | fullscreen class、transitions、will-change |
| `app-layout.css` | topbar/navbar transition 屬性 |

## 效能注意事項

- 所有動畫僅用 `transform` 和 `opacity`（compositor-only，不觸發 reflow）
- scroll handler 以 `requestAnimationFrame` 節流
- topbar/navbar 加 `will-change: transform` 提前建立 compositing layer
- 不再有 `passive: false` 的 touchmove 阻擋原生捲動
