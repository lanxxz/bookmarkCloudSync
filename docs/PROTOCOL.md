# 同步协议

## 1. 云端文档

位置：Google Drive 的 appDataFolder / bookmarks.json（文件名可配）。

~~~jsonc
{
  "schemaVersion": 2,
  "revision": 12,                 // 每次写入 +1
  "writer": "dev-a1b2c3d4e5",     // 最后写入的设备
  "createdAt": 1729000000000,
  "updatedAt": 1730000000000,
  "nodes": [
    {
      "id": "b_lq3k2j1h0",        // 同步层稳定 ID（与浏览器 bookmarks id 无关）
      "parentId": "root",         // 虚拟根，或另一个 folder 的 id
      "type": "bookmark",         // bookmark | folder
      "title": "Google",
      "url": "https://www.google.com/",
      "index": 0,                 // 同父节点内的稠密序号
      "deleted": false,
      "deletedAt": 0,
      "updatedAt": 1730000000000,
      "deviceId": "dev-a1b2c3d4e5"
    }
  ]
}
~~~

### 为什么 id 不用浏览器原生 id

chrome.bookmarks 的 id 是**本机单调整数**，两台设备上完全不同的书签可能都是 42。所以同步层自己发 ID：

- folder： f + 时间戳(base36) + 随机
- bookmark： b + 时间戳(base36) + 随机

浏览器原生 id 只存在本地映射表 nodeId -> chromeId 里，不上云。

---

## 2. 节点不变式

1. parentId === null 或 'root' 表示挂在书签栏下；
2. type === 'folder' 时 url 恒为空串；
3. deleted === true 时必须带 deletedAt；
4. 同一父节点下 index 会被 normalizeIndices() 压成 0..n-1；
5. 禁止成环；发现环 → 该节点重挂到 root 并记 cycle 冲突。

---

## 3. 合并算法（mergeDocs）

输入：base / local / remote 三个 Map<id, node>。

按 id 取并集，逐个节点判定：

~~~
if 两侧完全相同                 -> 用它
else if 两侧都没有             -> 跳过（两边都删则留墓碑）
else if base 里没有（新增）      -> 两侧都有 => 取 updatedAt 大的；
                                  否则取存在的那一侧
else if 只有一侧存在（另一侧删） -> 见下表
else 两侧都在但不同            -> 逐字段判定
~~~

### 单侧存在（另一侧删除）

| 存活侧相对 base | 策略 keep（默认） | 策略 delete |
| --- | --- | --- |
| 没改过 | 删除（生成墓碑） | 删除 |
| 改过 | **保留**（resurrect + 记冲突） | 删除（记冲突） |

存活侧本身已是墓碑时，**原样保留，绝不重新盖时间戳** —— 否则每轮同步都会产生一次云端写入，永不收敛。

### 两侧都在但不同

- 只有一侧变了 → 取变的那侧；
- 都变了 → 逐字段 LWW：
  - title / url / parentId / index 各自独立判定（fieldConflict 可强制 local / remote）；
  - deleted：只有在另一侧**也**没改过内容时才删除，否则保留。

---

## 4. 冲突类型

| kind | 含义 | 处理 |
| --- | --- | --- |
| delete-vs-modify | 一侧删、另一侧改 | 默认保留内容，detail.resolution = kept |
| field | 同一节点多字段冲突 | 逐字段 LWW，记 detail.fields |
| orphan | 父节点不存在 | 重挂到 root |
| cycle | 父链成环 | 重挂到 root |
| duplicate-id | 两端同 id 内容不同 | 取 updatedAt 大的，记冲突 |

每次同步最多保留最近 40 条冲突，展示在弹窗 / 设置页。

---

## 5. 写入并发

updateTextFile 带 If-Match: <etag>。若云端在此期间被另一台设备写过，Drive 返回 **412**：

~~~
412 -> 重新 readRemote -> 重新 merge -> 重新写（最多 3 轮）
~~~

ETag 优先从媒体下载响应头取；拿不到时补一次元数据请求（getFileEtag）。

---

## 6. 快照

文件名：snap-<ISO时间>_<设备前8位>_<kind>.json（Drive 文件名不能含斜杠）。

~~~jsonc
{
  "schemaVersion": 2,
  "kind": "snapshot",
  "snapshotKind": "pre-sync",
  "ts": 1730000000000,
  "reason": "推送云端 r12",
  "deviceId": "dev-...",
  "revision": 12,
  "count": 1532,
  "stats": { "total": 1532, "folders": 210, "bookmarks": 1300, "tombstones": 22 },
  "nodes": [ /* ... */ ]
}
~~~

快照含墓碑，所以能精确还原"某个时间点的完整视图"。

---

## 7. 状态机（单设备）

~~~
未初始化 --首次同步--> 已初始化（云端无文档时用本地树引导上传）

空闲 --书签变化/定时/手动--> 加锁 --合并--> 有云端差异? --是--> 写云端（412 则重试）
                                                    |
                                         有本地差异? --是--> 落快照 -> 应用到本地 -> 重扫
                                                    |--否--> 更新 base
                                  删除数超阈值? --是--> pending（等用户确认）--确认--> 应用
~~~

---

## 8. 排除文件夹

设置里的"跳过文件夹标题"会在 **local / remote / base 三份集合上同时过滤**（filterExcluded，含整棵子树）。

只过滤本地会让云端误判成"本地删除了这个文件夹"，从而把云端也删掉 —— 这是必须三份都过滤的原因。
