# 升级与迁移

## 从早期 0.1.0 测试构建升级

早期测试构建把完整 `records_by_swipe` 主要保存在消息顶层，只在 `extra` 和 `swipe_info` 中保存摘要镜像。SillyTavern 创建新聊天分支时可能只复制持久化镜像，导致旧分支只剩 `record_id` 和状态摘要，无法重建 operation、证据和检查点。

当前构建会同时保存：

- 消息顶层完整时间线。
- `message.extra.psyche_timeline.timeline` 完整时间线镜像。
- 每个 `swipe_info[n].extra.psyche_timeline.record` 的完整 Swipe 记录。

这样刷新、重启和分支复制后都能重新聚合完整记录。

### 升级步骤

1. 在旧构建中不要继续创建新分支。
2. 备份 SillyTavern 的角色聊天目录。
3. 更新源码、安装依赖并运行 `npm.cmd run validate`。
4. 重启 SillyTavern，打开原聊天。
5. 检查每条角色回复的状态标记。
6. 对显示“未审计”但你希望保留状态的 Swipe，点击“重新提取当前回复”。
7. 确认记录后导出新的 `.psychetimeline` 完整备份。

只有摘要镜像、没有完整 `record` 的旧历史无法从摘要反推出原 operation。扩展不会伪造恢复内容；必须重新提取原回复，或在状态面板中人工修正。

## 从旧 `creator_notes` 剧情轨迹迁移

当前扩展不会自动把自由文本 `creator_notes` 当成权威时间线，因为其中可能混合未来设想、作者说明和已发生历史。

Character Card Designer 已支持正式结构化导出，但不会从旧自由文本中猜测事件。推荐流程：

1. 在 Character Card Designer 中导入旧角色卡和原文。
2. 选择“剧情线模式”，重新确认扮演角色、故事起点和允许改变的范围。
3. 完成分发。设计器会用额外的结构化编译调用、独立审计调用和确定性校验生成 PTE `StoryPlan`。
4. 导出 V3 JSON 或 PNG Card，确认其中包含 `data.extensions.psyche_timeline.inline_plan`。
5. 长事件列表可同时导出 `.psychebook`，再通过本扩展的“导入故事包”安装并核对摘要。
6. 在新聊天中确认故事 ID、角色绑定和起点后再开始对话。

如果旧设计器项目仍然存在，但项目状态中只有长篇 `creator_notes`，`.psychebook` 选项会保持禁用。这是预期保护：旧备注没有稳定的原文指纹、事件 ID 和知识边界，不能可靠反推 `StoryPlan`。

不要直接把 `creator_notes` 整段复制到 `initial_state`。未来事件不得写成角色已经经历的记忆。

## 迁移到另一台设备

需要同时迁移：

1. SillyTavern 角色卡和聊天 JSONL。
2. 对应的 `.psychebook` 原文件。
3. 建议额外保存 `.psychetimeline` 完整备份。

在新设备上安装扩展、导入摘要一致的故事包，再打开聊天。若摘要不同，扩展会拒绝静默绑定。

Connection Profile 和 API 密钥属于 SillyTavern 配置，不包含在时间线备份中，需要单独配置。
