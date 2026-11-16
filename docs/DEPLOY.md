# 部署清单

## A. Google Cloud Console

| 步骤 | 位置 | 值 |
| --- | --- | --- |
| 1 | API 和服务 → 库 | 启用 **Google Drive API** |
| 2 | OAuth 同意屏幕 | 用户类型：外部；范围：.../auth/drive.appdata |
| 3 | 测试用户 | 加入你要用的 Google 账号 |
| 4 | 凭据 → OAuth 客户端 ID | 类型：**Web 应用** |
| 5 | 已授权重定向 URI | https://ommklboenelehaimfiplifjamboilegc.chromiumapp.org/oauth2 |
| 6 | 记录 | Client ID / Client Secret |

> 扩展 ID 由 manifest.json 的 key 字段决定。npm run key -- --force 会重新生成，
> 之后必须回到第 5 步更新重定向 URI。

## B. Chrome

1. chrome://extensions → 打开开发者模式 → 加载已解压的扩展程序 → 选项目根目录。
2. 打开扩展的"服务工作进程"检查视图，确认日志出现 service worker 已启动 。
3. 点图标 → 齿轮 → 填 Client ID / Secret → 连接 Google 账号。
4. 运行自检 → 没有红色失败项 → 立即同步。

## C. ego(lite)

1. 打开扩展管理页（地址栏输入 ego://extensions ，或菜单里找"扩展程序"）。
2. 打开"开发者模式" → "加载已解压的扩展程序" → 选同一个目录。
3. 如果该版本不支持加载已解压：先在 Chrome 里 npm run pack 出 zip，再拖进 ego(lite) 的扩展页。
4. 授权同 B 的步骤 3–4。
5. **如果"连接 Google 账号"报错**（该分支可能没有 chrome.identity.launchWebAuthFlow）：
   - 自检页会显示 "chrome.identity → 注意"；
   - 降级方案：设置里把模式改为"手动粘贴 access token"，从
     https://developers.google.com/oauthplayground/ 取一个带
     https://www.googleapis.com/auth/drive.appdata 的 token 粘贴进去（约 1 小时有效）。

## D. 验证清单

- [ ] 两台设备都显示"已连接：你的邮箱"
- [ ] 自检：没有红色"失败"项
- [ ] Chrome 新增一个书签 → 等 5–10 秒 → ego(lite) 点"立即同步"能看到
- [ ] ego(lite) 删除该书签 → Chrome 点"立即同步"该书签消失
- [ ] 设置页 → 历史快照 → 能看到云端快照列表
- [ ] 故意在 Chrome 里批量删 60 个 → 弹窗出现"等待确认"

## E. 升级

改完 src/ 后回到扩展管理页点"重新加载"。manifest.version 建议同步递增。
