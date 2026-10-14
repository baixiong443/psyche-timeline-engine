# Psyche Timeline Engine

Psyche Timeline Engine 是一个面向 SillyTavern 的分支感知剧情状态扩展。它把原作计划、聊天实际发生的状态、每个 Swipe 的提取记录和人工修正分开保存，使聊天可以延迟、跳过、失效或适配原作事件，而不是把原作当成必须复刻的标准答案。

当前版本为 `0.1.0` 预发布版，已在 SillyTavern `1.18.0` 上验证。除短篇和内联时间线外，它已经支持设计器导出的渐进式整本原文库：顺序窗口保证不漏读，SillyTavern 向量索引补充跨章节关联，独立审计证据提供事实边界，附近窗口按当前分支懒编译为可执行事件。

## 已实现

- 读取角色卡 V3 的 `data.extensions.psyche_timeline`。
- 导入并校验 `.psychebook`，使用 SHA-256 摘要绑定正确版本。
- 维护事实、人物状态、人物知识、关系、物品、线索和原作事件状态。
- 支持跟随原作、自适应、平行线和自由剧情四种参与模式。
- 为每个消息 UUID、每个 Swipe 独立保存完整 `TurnRecord`。
- 编辑、删除、Swipe 删除和创建聊天分支后重放有效记录。
- Standard 提取与 Strict 独立审计，支持 SillyTavern Connection Profile。
- 模型结构化输出失败时重试；非法 operation 会被隔离，不会整轮静默消失。
- Pending 变化可逐条批准、拒绝或编辑。
- 原作事件可锁定、延迟、恢复、开始、完成、失效或适配。
- 完整时间线备份和恢复，包含故事绑定、手动记录、全部 Swipe 记录和 Projection 哈希。
- 群聊生成时按当前起草成员选择知识视角；无法可靠识别成员时不注入私有知识。
- 与 Character Card Designer 正式联动：读取设计器导出的内联 `psyche_timeline`，并安装设计器生成的可复现 `.psychebook`。
- 角色卡 `mode_defaults` 会在每个聊天首次绑定时初始化参与模式、审计模式和自动应用设置；用户之后的选择按聊天保存。
- 主生成注入会携带当前角色自己的状态、关系方向、相关物品、未结线索和分支偏离，同时屏蔽其他角色的私有状态与物品。
- 好感度、信任度等关系数值轴可由提取模型增减，也可在“关系与物品”中输入目标值手动修正，并参与重放、锁定和备份。
- 分歧度由 `set_divergence` 记录为 `0..1` 的结构变化并保存因果摘要；普通措辞差异不会提升分歧度。
- 平行线模式在分歧度达到 `0.5` 后停止注入原作事件，自适应与跟随原作模式在达到 `0.75` 后停止注入；自由剧情始终不注入锚点。已被标记为 `active` 的事件不受影响。
- `StoryEvent.scope` 区分世界级进程与角色际事件：`world`（天灾、战争、瘟疫等）不受分歧度抑制，只由显式 `forbiddenWhen`/`preconditions` 决定是否发生，因此分支消除前因时仍可被提前阻止；省略或未识别时按 `interpersonal` 处理，旧故事包行为不变。
- 注入候选受 `canonicalOrder` 前瞻窗口约束（默认 25）：游标之后的远处事件不会作为“附近锚点”提前注入，从而避免远期剧透。窗口是资格闸门而非排序偏好，因为跟随模式下硬锚点的基础分（90）高于整个邻近度区间（80）；`world` 事件同样受窗口约束——两百里外的灾难依然是剧透。
- 原作事件首次进入 `completed_canonical` 时会从只读 StoryPlan 自动应用声明的 `effects`；`completed_adapted` 只采用聊天中实际提取的变化，不会强行套用原作精确后果。
- 规范完成与适配完成都会把该事件仍为 `pending` 的 `narrativePurposes` 自动标记为 `fulfilled`；锁定路径或显式状态优先。
- `StoryEvent.effects` 不允许包含 `transition_canon_event`，避免递归完成和事件效果循环。
- `adaptation.allowDelay=false` 会同时阻止模型和面板延迟事件；迁移与替代均不允许时，`completed_adapted` 也会被本地 Reducer 拒绝。
- `bindings.user_role_id` 会进入主生成、状态提取和独立审计，用于把用户行为、知识、关系和物品变化写到正确的故事角色上。
- `active_only` 原作事件在真正进入 active 状态前不会暴露给主生成模型。
- 安装 `.psychebook` 中的 `source/index.json`、检索片段、分析单元、证据声明和编译记录，并归一化到独立 IndexedDB，不把整本原文复制进聊天元数据。
- 运行时同时使用强制顺序窗口、关键词/向量连续性检索和独立文风样本；未来原文只进入内部控制器，不会注入叙述模型或自动成为角色知识。
- 复用 SillyTavern 当前配置的 `/api/vector` 来源，按游标附近优先、每次最多 64 个片段渐进建库；失败时明确降级到顺序与关键词检索，不静默切换嵌入模型。
- 原文窗口在生成前由专用规划 Profile 编译，再由独立审计 Profile 复核。失败不会阻断正常回复，也不会写入半成品事件。
- L4 缓存拒绝跨窗口事件 ID 和 `canonicalOrder` 冲突；失败记录不会参与计划合并。连续三次失败后停止调用，面板显示诊断并要求显式重置。
- “故事包”页显示准备模式、原文游标、L2/L3/L4 覆盖、证据数、向量来源与进度、失败单元和检索降级警告。

## 安装

### 从仓库安装

在 SillyTavern 的用户扩展目录中克隆仓库：

```powershell
Set-Location "F:\SillyTavern\data\default-user\extensions"
git clone https://github.com/baixiong443/psyche-timeline-engine.git
Set-Location .\psyche-timeline-engine
npm.cmd ci
npm.cmd run build
```

重启 SillyTavern。扩展设置中出现“剧情时间线”即表示加载成功。

不同 SillyTavern 用户的扩展目录不同，请把示例中的 `default-user` 替换为实际用户目录。

### 本地源码开发

可以把源码目录连接到 SillyTavern 扩展目录，避免维护两份文件：

```powershell
New-Item -ItemType Junction `
  -Path "F:\SillyTavern\data\default-user\extensions\psyche-timeline-engine" `
  -Target "H:\Trae CN\psyche-timeline-engine"
```

修改源码后运行：

```powershell
npm.cmd run validate
```

然后在浏览器中完整刷新 SillyTavern。

## 快速开始

1. 打开一个真实角色聊天。
2. 在“扩展程序 -> 剧情时间线”中保持“启用”打开。
3. 有 `.psychebook` 时点击“导入故事包”；只想跟踪当前角色时点击“创建当前角色时间线”。
4. 选择参与模式和审计模式。
5. 在“提取模型”“原文窗口规划模型”和“审计模型”中选择 SillyTavern Connection Profile。
6. 正常聊天。角色回复下方会显示“未审计、待确认、已应用、过期或错误”。
7. 在“待确认”标签中批准、拒绝或编辑模型提出的领域操作。

“配置不可用时回退当前连接”只在 SillyTavern 当前 API 已连接时有效。若希望提取与主聊天完全分离，应创建专用 Connection Profile。

## 审计模式

- `关闭`：提取记录会保存为未审计，适合低成本测试。
- `标准`：一个模型提取状态，本地 Schema、Reducer 和锁定字段负责校验。
- `双层严格`：提取后再调用独立审计模型。审计模型不可用或格式持续错误时，记录保留但标为失败，不会自动应用。

建议把提取模型和审计模型设置为不同 Profile。使用同一个 Profile 仍能运行，但不构成真正的独立交叉审计。

原文窗口规划模型也可单独选择。留空时跟随提取模型；它只负责把当前游标附近、已经分块且受证据约束的原文编译成候选事件，审计模型仍会独立复核。

## 渐进式长篇架构

同一份原文按成熟度逐层增加信息，而不是分成互不兼容的“流式版”和“预编译版”：

- `L0`：不可变原文、章节、顺序和字符偏移。
- `L1`：关键词与向量检索索引。向量只负责排序，不能证明事实。
- `L2`：按原文顺序提取的细粒度事件与证据骨架。
- `L3`：第二 AI 重新对照原文后的审计骨架和带来源声明。
- `L4`：PTE 结合当前分支，只编译游标附近的 1 到 3 个可执行 `StoryEvent`。

主生成只能读取当前及过去的顺序、连续性和文风通道。未来片段可供控制器判断下一窗口，但不会进入角色/叙述注入；结构分歧达到 `0.75` 时未来原文控制通道也会关闭。完整设计见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 时间线备份

面板工具栏中的导出图标会生成：

```text
<story-id>-timeline-backup.psychetimeline
```

备份包含：

- 聊天故事绑定和故事包摘要。
- 当前聊天的参与模式、审计模式和自动应用选择。
- 手动修正记录。
- 按稳定消息 UUID 保存的全部 Swipe 记录。
- 当前 Projection、Projection 哈希和整个备份哈希。

恢复前会显示文件名、故事 ID、消息数、记录数和摘要。恢复只允许用于消息 UUID 序列一致、故事 ID 一致且本机故事包摘要匹配的聊天。恢复失败时扩展会尝试回滚到恢复前状态。

备份不是聊天文本备份。迁移设备时还需要迁移 SillyTavern 聊天，并在新设备重新导入摘要一致的 `.psychebook`。

## 数据边界

- 故事包只读取 JSON、JSONL 和文本，不执行包内脚本。
- `.psychebook` 有 64 MiB 导入上限、路径穿越检查和解压大小限制。
- 模型只提出白名单领域操作，不能写任意 JSON 路径。
- 原作计划是只读基线，实际聊天状态通过 Delta 和检查点重放。
- 群聊成员无法可靠映射到故事角色时，不会获得绑定角色的私有知识。

## 与 Character Card Designer 联动

Character Card Designer 的“剧情线模式”会在原作证据提取、第二 AI 复核、分项生成和分项审计之后，再编译并独立审计 PTE `StoryPlan`。

- V2、V3 与 PNG Card 在 `data.extensions.psyche_timeline` 中携带 `inline_plan`，只导入角色卡即可由本扩展建立内联时间线。
- 导出页也可生成 `.psychebook`。扩展负责解压、Schema 校验、路径安全检查、SHA-256 摘要计算和本地安装。
- SillyTavern 核心只负责保留自定义扩展字段，不会执行 PTE 事件；解析、注入、审计和回放都由本扩展完成。
- 设计器仍会保留第三方角色卡扩展，不会用 `psyche_timeline` 覆盖其他插件字段。
- 旧项目只有 `creator_notes` 自由文本时不会自动升级；缺少原作证据映射时，猜测事件比拒绝迁移更危险。

## SillyTavern 群聊验收

已在 SillyTavern `1.18.0` 中用两个同故事 V3 角色卡完成真实群聊验收。群聊采用“手动”发言顺序和“交换角色卡”生成模式，并绑定 `examples/group-isolation/双角色知识隔离验收.psychebook`。

- 林砚的角色主生成请求包含铜钥匙完整事实，不包含河道信标完整事实。
- 周栖的角色主生成请求包含河道信标完整事实，不包含铜钥匙完整事实。
- 两名角色的中文回复分别明确不知道另一方的线索，回复后的双层严格审计均通过。
- 在林砚的后台提取与审计尚未落盘时立即点周栖发言，扩展会等上一轮处理完成，再按周栖的 `force_chid` 重建投影；快速连续发言没有复用前一名成员的私有知识。
- 状态提取器和审计器作为系统状态维护者会读取完整 Projection；隔离约束针对扮演角色的主生成请求，不能把审计请求读取全局事实误判为角色已知。

验收夹具可用 `npm.cmd run build:group-fixture` 重建；脚本会生成可复现的故事包、更新两张角色卡摘要并打印 SHA-256。

### 三 Swipe 验收

已在“敏明 - 2026-07-13@13h03m28s971ms - Branch #7”中完成真实三 Swipe 验收：

- 同一条用户消息生成了 `3/3`，活动 Swipe 为 `swipe_id = 2`。
- 三个 Swipe 共用同一个 `inputHash`，但 `recordId` 和 `outputHash` 各不相同。
- Swipe 1 的双层审计通过；Swipe 2 因无证据的 UTC 时区推断被拒绝；Swipe 3 隔离了一个无效操作，并因关系态度证据不足拒绝对应操作。
- 用界面左右按钮实际切换 `3 -> 2 -> 1 -> 2 -> 3` 后，计数、活动记录、审计状态和消息下方徽标会随当前 Swipe 切换，三份记录没有互相覆盖。

### 分支、删除与聊天迁移验收

已使用 Branch #7 的三 Swipe 聊天创建两个专用测试分支，并通过 SillyTavern 的聊天文件界面完成导出再导入：

- 在 Branch #8 删除第 3 个 Swipe 后，界面回到 `2/2`，`records_by_swipe` 只剩 `0`、`1`；前两条的 `recordId` 和 `outputHash` 保持不变。
- 在 Branch #9 删除整条角色消息后，聊天从 3 条消息变为 2 条，被删消息的稳定 UUID 不再存在；时间线重放只保留此前已应用的手动修正，不再显示该消息的三条 Swipe 记录。
- 从 Branch #7 导出 JSONL，再用“导入聊天”导回新副本后，3 条消息 UUID、故事绑定、`3/3`、活动 Swipe、三条 `recordId`、输入/输出哈希、审计状态和待确认状态全部保留。
- 原 Branch #7 始终保留为未执行删除操作的验收样本；删除操作只发生在专用分支。

## 当前限制

- 设计器的 L2/L3 后台任务需要设计器页面保持打开；关闭后任务会保留在 IndexedDB，下次可继续，但当前没有独立桌面守护进程。
- 酒馆的 `webllm`、`koboldcpp` 等客户端直算向量来源不能通过服务端 `/api/vector` 复用，PTE 会显示警告并使用顺序与关键词检索，不会自动换模型。
- 每次刷新最多补建 64 个原文向量；大型语料需要多次刷新或继续对话才能逐步完成，附近片段优先。
- L4 是分支相关的附近窗口缓存，不会在导入时把整本小说一次性硬编译为事件；这是为了避免后期分叉后继续受无关未来原文污染。
- 跨聊天分支的可视化差异比较仍未实现；每个聊天内部的 Swipe、检查点、回溯和分支重放已经可用。
- 旧 `creator_notes` 剧情轨迹没有无证据自动迁移器；应在 Character Card Designer 中连同原文重新走剧情线导入。
- Webpack 仍可能报告默认 244 KiB 的体积建议警告；它是性能提示，不代表构建失败。

升级旧测试版前请阅读 [MIGRATION.md](./MIGRATION.md)。常见故障见 [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)。

## 开发验证

```powershell
npm.cmd run typecheck
npm.cmd run test
npm.cmd run build
npm.cmd run validate
npm.cmd run test:integration:designer
```

`npm.cmd run validate` 会依次执行 TypeScript、独立仓库单元测试和生产构建。相邻目录存在 `character-card-designer` 时，`test:integration:designer` 会让设计器源码真实生成渐进 `.psychebook`，再验证 PTE 的解析、安装、未来隔离、L4 缓存写入与无重复 AI 调用。示例故事包可通过 `npm.cmd run build:example` 重新生成，双角色群聊验收夹具可通过 `npm.cmd run build:group-fixture` 重新生成。
