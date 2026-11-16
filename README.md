# Bookmark Cloud Sync

把 **Chrome** 与 **ego(lite)** 的书签双向同步到 **Google Drive 的 appDataFolder**（扩展私有空间，不混入普通网盘文件）。

- 不修改任何浏览器本体，纯扩展实现（Manifest V3 + 原生 JavaScript，零构建、零依赖）。
- 删除**先快照、后执行**：每次同步前落一份本地 + 云端快照，误删可一键回滚。
- **三方合并**（base / local / remote）而不是"覆盖"，两台设备同时改也不丢数据。

~~~

Chrome 扩展 A ──┐                        ┌── ego(lite) 扩展 B
 base/local/remote                      base/local/remote
        │                               │
        ▼                               ▼
   ┌──────────────────────────────────────────┐
   │  Google Drive appDataFolder              │
   │   bookmarks.json     全量节点 + 墓碑      │
   │   bcs-history/       历史快照（环形保留）  │
   └──────────────────────────────────────────┘

~~~

---

## 一、它解决什么问题

| 场景 | Chrome | ego(lite) | 本扩展 |
| --- | --- | --- | --- |
| 登录 Google 账号同步书签 | 支持 | **不支持** | 两边都不依赖它 |
| 从 Chrome 导入书签到 ego(lite) | — | 一次性 | 持续双向 |
| 手动导出 HTML 再导入 | 麻烦 | 麻烦 | 自动 |
| 删除保护 | 无 | 无 | 快照 + 墓碑 + 阈值拦截 |

ego(lite) 是 Chromium 分支，官方明确不支持 Google 账号书签同步，旧版本的"浏览器数据同步"也已移除。所以走**独立扩展 + Drive 私有目录**：两个浏览器装同一个扩展、连同一个 Google 账号，共用一个 bookmarks.json。

---

## 二、核心设计

### 1. 三方合并，而不是覆盖

每次同步都保留三份状态：

- **base**：上次同步成功后的结果（两边一致的那份记忆）
- **local**：本机浏览器当前的书签树
- **remote**：云端当前的文档

逐节点比对，只有"相对 base 发生了变化"的那一侧才算改动：

| local | remote | 结果 |
| --- | --- | --- |
| 改了 | 没改 | 用 local |
| 没改 | 改了 | 用 remote |
| 都改了 | 都改了 | 逐字段 LWW（标题 / URL / 父目录 / 顺序各自独立判断） |
| 删了 | 没改 | 尊重删除（生成墓碑） |
| 删了 | **改过** | **保留内容**（防误删，记一条冲突） |
| 删了 | 删了 | 保留墓碑，防止离线设备"复活" |

### 2. 删除不是覆盖，是墓碑

节点删除后不会从文档里消失，而是变成：

~~~json
{ "id": "b_xxx", "deleted": true, "deletedAt": 1730000000000 }
~~~

墓碑默认保留 90 天（可配 7–365 天）。这样：

- B 设备离线一周 → 上线时看到墓碑 → 执行删除，而不是把书签又推回去；
- 删错了 → 快照恢复，或直接把墓碑翻回 deleted: false。

### 3. 每次同步先落快照

| 时机 | 快照类型 | 位置 |
| --- | --- | --- |
| 推送云端前 | pre-push | 本地 |
| 写云端成功后 | pre-sync | 本地 + 云端 |
| 应用本地变更前 | pre-sync | 本地 |
| 手动点"保存快照" | manual | 本地 |
| 恢复/导入前 | restore | 本地 |

本地保留 30 份、云端保留 10 份（都可配）。恢复有两种：**合并恢复**（只补缺失，不删现有）和**覆盖恢复**（清空后重建，恢复前自动再备份一次）。

### 4. 批量删除拦截

单轮要删除超过 maxAutoDeletes（默认 50）条时，**不写本地**，任务进入 pending，在弹窗里显示"将被删除的清单"等你二次确认。防的是：云端文档损坏/被清空时，一轮把本机书签全删掉。

### 5. 树结构压平

Chrome 的永久根节点 0 不可写，它的子节点是"书签栏 / 其他书签 / 移动设备书签"。为了让两台设备的树拓扑完全一致：

- **书签栏**不产生节点，它的子节点直接挂到虚拟根 root；
- **其他书签 / 移动设备书签**作为普通文件夹挂到 root，标记为系统节点（不可删、不可移动）；
- 新建 parentId = root 的节点统一落在"书签栏"下。

这样就不会因为永久文件夹 id 不同（不同设备 / 不同 profile 可能不一样）而每次同步都触发 move。

### 6. 本地修改时间台账

Chrome 书签节点**没有修改时间字段**。如果扫描出来的 updatedAt 永远是 0，本地改的标题永远输给云端时间戳，用户会觉得"我改完同步又被改回去"。

做法：维护 nodeId → {指纹, 时间} 台账。内容指纹（父目录/类型/标题/URL/顺序/删除态）没变就沿用旧时间；指纹变了才盖当前时间。于是本地修改在 LWW 里有真实的先后关系，同时不会每次扫描都抖动。

---

## 三、目录结构

~~~
bookmarkCloudSync/
├── manifest.json              MV3 清单（含固定 key，保证扩展 ID 稳定）
├── icons/                     16/32/48/128 图标（脚本生成，无二进制依赖）
├── src/
│   ├── lib/
│   │   ├── protocol.js        文档 schema + 三方合并 + 树修复 + 应用计划（纯函数，可测）
│   │   ├── local.js           chrome.bookmarks 适配层（扫描 / 落地 / 清空）
│   │   ├── drive.js           Drive v3 客户端（appDataFolder / ETag / 重试）
│   │   ├── auth.js            OAuth 2.0（PKCE / 隐式 / 手动 token）
│   │   ├── history.js         本地 + 云端快照
│   │   ├── sync.js            同步编排（加锁 / 引导 / 重试 / 差异保护 / 恢复）
│   │   ├── idb.js             IndexedDB 封装
│   │   ├── log.js             环形日志
│   │   ├── selftest.js        环境自检（API 支持度探测）
│   │   ├── messages.js        消息协议常量
│   │   └── util.js            ID / 时间 / 并发 / URL 规范化
│   ├── background/
│   │   ├── service-worker.js  消息路由 + 事件编排
│   │   ├── alarms.js          定时补偿 + 远端轻量轮询
│   │   └── bookmark-watch.js  书签事件 → 防抖 → 触发同步
│   └── ui/
│       ├── popup.html/js/css  状态、立即同步、预览、待确认
│       └── options.html/js/css 授权、参数、冲突策略、快照、自检、日志
├── tests/                     49 个单元/仿真测试（node:test）
├── tools/                     图标、扩展 key、校验、打包脚本
└── docs/                      协议说明、部署、排错
~~~

---

## 四、部署（Windows）

### 步骤 1：创建 OAuth 客户端

1. 打开 Google Cloud Console，新建项目（例如 bookmark-cloud-sync）。
2. **API 和服务 → 库**，搜索并启用 **Google Drive API**。
3. **API 和服务 → OAuth 同意屏幕**：用户类型选 **外部**，填写应用名与邮箱；发布状态保持"测试中"，把要用的 Google 账号加到 **测试用户**。
4. **API 和服务 → 凭据 → 创建凭据 → OAuth 客户端 ID**：
   - 应用类型选 **Web 应用**；
   - **已获授权的重定向 URI** 填：

     ~~~
     https://ommklboenelehaimfiplifjamboilegc.chromiumapp.org/oauth2
     ~~~

   > 这个 ID 来自 manifest.json 里的 key 字段，只要 key 不改，扩展 ID 就是固定的。
   > 如果重装了 key（npm run key 会重新生成），需要回到这里改成新的 URI。
5. 记下 **Client ID** 和 **Client Secret**。

### 步骤 2：加载扩展

**Chrome**

1. 地址栏打开 chrome://extensions ；
2. 右上角打开 **开发者模式**；
3. **加载已解压的扩展程序** → 选择本目录 bookmarkCloudSync 。

**ego(lite)**

1. 打开 ego://extensions（或"设置 → 扩展程序"，再打开开发者模式）；
2. **加载已解压的扩展程序** → 选择同一个目录；
3. 如果 ego(lite) 的扩展管理页不支持"加载已解压"，可以先用 Chrome 打包成 zip（npm run pack）再拖入。

### 步骤 3：授权

1. 点扩展图标 → 齿轮 → 设置页；
2. 展开 **高级：OAuth 客户端配置**，填入 Client ID / Client Secret，模式选 **PKCE 授权码**；
3. 点 **连接 Google 账号**，在弹窗里选账号并同意 drive.appdata；
4. 回到设置页，点 **运行自检**，确认没有红色失败项；
5. 点 **立即同步** 完成首轮上传。

在第二台设备（另一个浏览器）上重复步骤 2–3，用**同一个 Google 账号**授权，然后点"立即同步"即可拉取。

---

## 五、日常使用

| 操作 | 位置 | 说明 |
| --- | --- | --- |
| 立即同步 | 弹窗 / 设置页 | 手动触发，不受节流限制 |
| 预览差异 | 弹窗 / 设置页 | **只计算不写入**，先看清楚再决定 |
| 保存快照 | 弹窗 / 设置页 | 打一个后悔药点 |
| 确认删除 | 弹窗（出现提示时） | 超过阈值才会出现 |
| 恢复快照 | 设置页 → 历史快照 | 合并恢复 / 覆盖恢复 |
| 导出 JSON | 设置页 | 全量节点导出，可用于备份或迁移 |
| 环境自检 | 设置页 | 部署前后各跑一次 |

自动化：书签变化 → 防抖 4 秒 → 同步；另有 15 分钟定时补偿（可配 1–180 分钟）和 5 分钟远端轻量轮询（只读 modifiedTime，变了才拉全量）。

---

## 六、开发与验证

~~~bash
npm run test     # 49 个测试：合并语义、树修复、墓碑、删除保护、双设备收敛仿真
npm run check    # manifest 校验 + 全部模块装载 + 未使用导入
npm run icons    # 重新生成图标
npm run key      # 重新生成扩展公钥（会改变扩展 ID）
npm run pack     # 打包 dist/bookmark-cloud-sync-vX.Y.Z.zip
~~~

测试里最重要的是 tests/two-devices.test.js：它用假云端跑两台设备的完整同步流程，验证

- 双端各自新增 → 收敛到同一状态；
- A 删除、B 离线 → B 上线后书签不会复活；
- A 删除、B 改过标题 → 保留书签、记一条冲突、A 再同步也能拿回来；
- 双端同时改同一标题 → 按时间取新，且**不会**产生"循环写入"（第二轮同步零写入）。

---

## 七、权限与数据

| 权限 | 用途 |
| --- | --- |
| bookmarks | 读写本机书签（核心功能） |
| storage / unlimitedStorage | 设置、token、日志、快照索引 |
| alarms | 定时补偿与远端轮询 |
| identity | launchWebAuthFlow 走 OAuth |
| notifications | 同步完成提示（可关闭） |
| contextMenus | 右键图标"立即同步" |
| host_permissions | 仅 www.googleapis.com 与 oauth2.googleapis.com |

- 作用域只要 https://www.googleapis.com/auth/drive.appdata ：**只能读写本扩展自己的隐藏目录**，看不到网盘里的其它文件。
- Token 存在本机 chrome.storage.local，不上传任何第三方；随时可在设置页"断开"（会调用 Google revoke）。
- 全量数据只在你自己的 Drive 里，代码里没有任何遥测或外发请求。

---

## 八、已知边界

- **ego(lite) 的 chrome.identity**：如果该分支不提供 launchWebAuthFlow，自检会标"注意"。此时改用**手动 token 模式**（从 Google OAuth Playground 取一个带 drive.appdata 的 access token 粘贴）。token 1 小时过期，适合临时验证。
- **书签顺序**：合并时顺序按 (index, id) 决定；两端同时插入不同位置时可能略有差异，但不影响内容。
- **超大书签树**（> 2 万条）：全量文档约 1–3 MB，仍在 Drive 单次 multipart 上传范围内；但首轮扫描会比较慢，建议先手动同步一次。
- **扩展 ID 与重定向 URI 绑定**：改 manifest.key 必须同步改 Google 控制台里的重定向 URI。

---

## 九、许可

个人自用项目，随取随用。
