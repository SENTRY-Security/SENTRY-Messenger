# Page snapshot

```yaml
- generic [active] [ref=e1]:
  - main [ref=e2]:
    - generic [ref=e3]:
      - img "SENTRY MESSENGER" [ref=e4]
      - heading "SENTRY MESSENGER" [level=1] [ref=e5]
    - paragraph [ref=e6]: 感應 SENTRY MESSENGER 晶片後輸入密碼即可登入。
    - generic [ref=e7]:
      - generic "晶片識別圖" [ref=e8]
      - generic:
        - generic:
          - generic: 登入密碼
          - generic:
            - textbox "登入密碼":
              - /placeholder: 至少六位數
            - button "顯示密碼":
              - generic: 
        - text: 
      - button "登入" [disabled] [ref=e37]
      - paragraph [ref=e38]:
        - generic [ref=e39]: 🔒
        - generic [ref=e40]: SENTRY MESSENGER 採用 E2EE 端對端加密技術，所有加解密均於前端計算，伺服器端僅儲存加密過的資訊，所有敏感資訊僅保留於記憶體，並於畫面切換時即刻清除。
  - button "顯示版本資訊" [ref=e41] [cursor=pointer]: i
```