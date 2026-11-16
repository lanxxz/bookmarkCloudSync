# 外部兜底：GitHub Actions 日检

扩展自己会做快照和冲突处理，但「扩展本身出问题」这件事它自己查不出来。
所以再给书签仓库配一份**独立**的定时校验：即使扩展写坏了、或者某次同步误删，
也能在第二天早上收到提醒，并从 git 历史里直接回滚。

## 一、为什么用独立实现

`tools/verify-doc.mjs` **不 import 扩展的任何代码**，它把 `bookmarks.json` 当成一份
普通 JSON 重新校验一遍：schema、id 唯一性、父子关系、成环、墓碑字段、URL 协议、序号稠密性。
相当于给生产端配了个对照实现。

如果直接复用 `src/lib/protocol.js` 去检查它自己写出来的东西，写错的那部分会被同一套误解
「验证通过」—— 等于没查。

## 二、三个判定等级

| 退出码 | 判定 | 含义 | CI 行为 |
| --- | --- | --- | --- |
| 0 | ✅ 正常 | 结构合法，变更量在阈值内 | 通过 |
| 1 | ❌ 结构错误 | 违反不变量，数据已损坏 | 任务失败 |
| 2 | ⚠️ 可疑变更 | 结构没问题，但批量删除/新增超阈值 | 开 issue 提醒 |

阈值默认「删除比例 > 35% 且基数 ≥ 5 条」。基数下限是必须的，
否则只有 2 条书签时删掉 1 条就会天天报警。

## 三、装到书签仓库

```bash
# 在你的「书签仓库」里（不是扩展仓库）
mkdir -p .github/workflows tools
cp <扩展仓库>/tools/verify-doc.mjs tools/
cp <扩展仓库>/templates/verify-bookmarks.yml .github/workflows/
git add . && git commit -m 'ci: 加书签文档日检' && git push
```

工作流引用的是同目录的 `verify-doc.mjs`，所以脚本要放在书签仓库根目录。它零依赖，只用 Node 内置模块。

## 四、它每天做什么

```
UTC 02:17（北京 10:17）
  ├─ checkout（fetch-depth: 0，需要 HEAD~1 做对比）
  ├─ node verify-doc.mjs bookmarks.json --github-summary --json > report.json
  ├─ 把结果写进 Actions Summary（总节点/书签/目录/墓碑/最大嵌套/重复 URL）
  ├─ invalid    -> 任务失败，邮件通知
  ├─ suspicious -> 开一个带 bookmark-sync 标签的 issue（同名已存在就跳过）
  └─ 上传 report.json 作为 artifact，保留 30 天
```

除了定时，`bookmarks.json` 每次被推送（= 每次同步）也会触发校验，
所以异常基本是「同步完几分钟内」就能发现，不用等第二天。

## 五、本地手动跑

```bash
# 只看当前文件（不和历史对比）
node tools/verify-doc.mjs bookmarks.json

# 和上一个 commit 对比（默认行为，检测批量删除）
node tools/verify-doc.mjs bookmarks.json --prev auto

# 和指定 commit 对比
node tools/verify-doc.mjs bookmarks.json --prev 839157c

# 和另一个文件对比
node tools/verify-doc.mjs bookmarks.json --prev backup.json

# 调整阈值（0.5 = 删掉一半才报警）
node tools/verify-doc.mjs bookmarks.json --prev auto --max-delete-ratio 0.5

# 机器可读输出
node tools/verify-doc.mjs bookmarks.json --json
```

## 六、误报怎么办

**确实是自己批量整理书签**
直接关掉那个 issue 即可。同名 issue 已存在时工作流会跳过，不会再刷屏。

**觉得阈值太敏感**
在 workflow 里给命令加 `--max-delete-ratio 0.6`，或把脚本里的 `MIN_BASE_FOR_RATIO` 调大。

**一直报「墓碑占比过高」**
这只是提示，不影响判定。到扩展设置里把「墓碑保留天数」调小，下次同步会自动清理过期墓碑。

## 七、真出事了怎么恢复

```bash
# 1. 看历史，找到最后一次正常的那次同步
git log --oneline -- bookmarks.json

# 2. 看那次到底改了什么
git show <sha> -- bookmarks.json | head -50

# 3a. 粗暴恢复：直接 checkout 回去
git checkout <sha> -- bookmarks.json && git commit -m 'revert: 恢复到 <sha>'

# 3b. 推荐：让扩展自己恢复
#    设置页 -> 5. 历史快照与恢复 -> 选那个 commit -> 合并恢复
```

方式 3b 更好：它把那个 commit 的文档当作「远端」再走一遍三方合并，
只把差异补回来，不会把当前设备上新增的书签一起冲掉。
