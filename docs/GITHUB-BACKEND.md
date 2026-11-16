# 用 GitHub 私有仓库做云端

这是第二种存储后端。相比 Google Drive 路线，它的优势很直接：

| 维度 | GitHub 私有仓库 | Google Drive appDataFolder |
| --- | --- | --- |
| 前置配置 | 建一个仓库 + 一个 PAT | 建 GCP 项目 + OAuth 同意屏幕 + 客户端 |
| 是否需要 `chrome.identity` | **不需要** | 需要 |
| ego(lite) 兼容性 | 好（纯 fetch + PAT） | 取决于该分支是否提供 identity API |
| 版本历史 | 每次同步一个 commit，天然可 checkout | 需要自己维护快照文件 |
| 数据位置 | 你的私有仓库 | 你的网盘隐藏目录 |
| 大小限制 | 单文件 100MB（Contents API 约 90MB 可用） | 5MB 走 multipart |
| 速率限制 | 5000 次/小时（认证后） | 每用户每 100 秒 20000 次 |

## 一、创建仓库

1. 打开 https://github.com/new
2. 仓库名随意，例如 `bookmarks`
3. **Visibility 选 Private** —— 这一步很重要，Public 仓库的书签内容对所有人可见
4. 勾选 "Add a README file" 让仓库非空（空仓库没有分支，第一次写会失败）
5. 创建

> 也可以用已有的私有仓库，扩展只往 `bookmarks.json` 和 `bcs-history/` 写，不会碰其它文件。

## 二、创建 Fine-grained PAT

1. https://github.com/settings/personal-access-tokens/new
2. **Token name**：`bookmark-cloud-sync`
3. **Expiration**：按需（建议 90 天，到期重填一次）
4. **Repository access** → **Only select repositories** → 选中刚才那个仓库
5. **Repository permissions** 里只开两项：
   - **Contents: Read and write**（必需）
   - **Metadata: Read-only**（GitHub 会强制勾选）
6. 其余全部留 **No access**
7. 生成并复制 token（`github_pat_...`，只显示一次）

## 三、在扩展里连接

1. 设置页 → **1. 选择云端存储** → 选 **GitHub 私有仓库**
2. 填 PAT、`owner/repo`、分支（默认 `main`）、文档路径（默认 `bookmarks.json`）
3. 点 **连接仓库**
   - 扩展会先验 token 本身，再验仓库写权限，两步都过才保存
   - 如果仓库是 Public，会弹一条橙色警告
4. 点 **运行自检**，确认 `云端连通性` 一项是 OK
5. 点 **立即同步** —— 首次会把本机书签推成一个 commit

第二台设备（比如 ego(lite)）重复第 3 步，用**同一个 PAT**，点"立即同步"即可拉取。

## 四、它到底写了什么

```
你的私有仓库/
├── bookmarks.json           ← 全量节点集合（含墓碑），每次同步覆盖并提交
└── bcs-history/
    ├── snap-2026-11-16T08-30-00-000Z_dev-a1b2c3d4_pre-push.json
    └── snap-...                       ← 每次同步前的快照，环形保留 N 份
```

所有 commit 的 message 都是 `chore(bcs): ...` 前缀，方便在 git log 里筛。

## 五、并发控制怎么做的

GitHub Contents API 的 `sha` 就是文件版本号，等价于 ETag：

```
设备 A 读到 bookmarks.json (sha=aaa)
设备 B 也读到 (sha=aaa)
设备 A 先写：PUT + sha=aaa  → 成功，得到 sha=bbb
设备 B 后写：PUT + sha=aaa  → 409 / 422 "sha does not match"
                              → 扩展抛 CONFLICT
                              → 重新读取（拿到 sha=bbb）
                              → 重新三方合并
                              → 再写（最多 3 轮）
```

所以在两台设备上同时改书签不会互相覆盖，最终会收敛到同一份合并结果。

## 六、回滚

GitHub 模式下有两条恢复路径，都在设置页 → **5. 历史快照与恢复**：

| 来源 | 说明 |
| --- | --- |
| `bcs-history/` 里的 `snap-*.json` | 扩展自己写的快照，含墓碑，可**合并恢复**或**覆盖恢复** |
| 文档的 commit 历史 | 每次同步一个 commit，点"合并恢复"即把该 commit 的文档当作远端再合并一次 |

也可以在 GitHub 网页上直接看 diff、点 "Revert"——这是 Drive 模式没有的便利。

## 七、注意事项

**Token 存哪里**
`chrome.storage.local`，不上传任何第三方。断开时从本机删除。

**Token 权限过大有风险**
Fine-grained PAT 请务必只勾选那一个仓库的 Contents 权限，不要用 classic token（classic 是账号级全仓库权限）。

**空仓库**
新建的仓库如果没有任何 commit，就没有 `main` 分支，首次写会 404。勾选 README 初始化即可。

**分支保护**
如果 `main` 分支开了保护规则（要求 PR / 状态检查），PAT 直接 push 会被拒。改用另一个分支，或临时放开保护。

**速率限制**
认证后 5000 次/小时。一次同步通常 2–4 次请求（读元数据 + 读正文 + 写 + 偶尔快照），完全够用。限流时扩展会提示"大约 N 分钟后恢复"。

**公开仓库**
扩展不会主动拦截，但连接时会警告。真要用公开仓库的话，建议把 `bookmarks.json` 改成难猜的名字，虽然这并不构成真正的保护。
