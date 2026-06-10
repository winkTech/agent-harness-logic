一、harness 的五层全景打个类比：Claude 像一个能力超强、学得飞快、但不守规矩的新同事。单靠口头说规矩他做小任务完全没问题，但做严肃项目就必须有门禁、团队百科、任务管理、同事反馈、SOP 手册围着他。我搭的 harness 就是这五件事的自动化版本：层类比角色解决什么问题核心机制
1. 边界层门禁 + 审计硬拦截危险动作、验证证据hooks（工具调用前后自动跑的脚本）
2. 记忆层团队百科几个月前的决策怎么找到语义记忆 + 代码图谱 + 字面量搜索 + 时间轴查询
3. 交接层任务管理新 session 怎么接上昨天双轨任务状态（人读协议 + 机器状态）
4. 认知层同事反馈卡住了怎么跳出思维定势7 种推理模式 + 自动切换
5. 技能层SOP 手册高频工作流怎么固化自定义 slash 命令这五层不是从架构书里抄的，是被坑出来的。每一层都对应我被坑过的一类具体事故。

下面一层一层讲。




二、边界层：把规则变成物理拦截有一次我让 Claude 修一个 Supabase migration 报错。它试了四五种方案都不行，最后一步”为了清洁一下状态”，它生成了 supabase db reset --linked。这一个命令会清空生产数据库的全部数据，不可恢复。我当时已经在 CLAUDE.md 里加粗大字写了 “绝不 reset 生产数据库”。Claude 读过、同意了、还是生成了这个命令。这件事让我学到一个硬道理：规则写在 markdown 里是宪法，宪法靠合作。真正的边界必须是物理的。于是有了hooks。hooks 是 Claude Code 的一个机制 —— 每次 Claude 调用工具（执行 bash、编辑文件、读文件、停止对话）的前后，系统会自动跑一段你指定的脚本。脚本可以拒绝这个工具调用、修改工具输入、向 Claude 注入额外上下文。hooks 跑在 Claude 的 context 之外，Claude 看不见。我的第一个 hook 是 15 行的 shell：每次 Claude 想执行 bash 命令前，脚本先扫一遍命令内容，命中 DROP TABLE / TRUNCATE / rm -rf / / db reset 就直接 exit 2 拒绝。Claude 收到的反馈是”这个命令没执行”，没有办法合理化成”好吧我试别的” —— 因为它根本不知道为什么没执行，连错误信息都看不到拒绝原因。这一条 hook 救过我三次。hooks 的另一个关键用法是验证闭环。CLAUDE.md 第一条原则是”不验证不提交” —— 改了代码必须先跑 TypeScript 类型检查和测试才能提交。这条规则写在 markdown 里时，Claude 的守约率大概七成。有三成它会说”已通过 tsc 检查”然后直接提交，其实根本没跑。我改成两个 hook 配合：编辑后的 hook：只要 Claude 改了 .ts 文件，自动跑 tsc 和对应的测试。跑完后留一个”证据文件”（本质是一个带时间戳的小 JSON，放在系统临时目录）结束会话的 hook：Claude 要结束对话时先查 —— 有改动的文件 + 10 分钟内没有证据文件？拒绝结束，强制要求先跑验证这个设计的精髓是：不让模型自己声称”通过了”，让另一个脚本核实。”我跑过 tsc” 这句话必须有一个模型没法伪造的物理证据，证据就是那个带时间戳的小文件 —— 你得真的 spawn 一个 tsc 进程、进程得 exit 0，hook 才会写文件。三个月下来我把边界层的哲学压成一句话：CLAUDE.md 写承诺，hooks 写执行。承诺可以被合理化，执行不可以。边界层做对了，整个 harness 的底座就稳了。



三、记忆层：四工具分工，反直觉的是主力是 grep做 Claude Code 久了会撞到一个高频痛点：”这个决策三个月前做过了，理由我忘了 —— 你还记得吗？” Claude 摇摇头，白纸。主流 AI 编辑器（Cursor、Continue、Cody、Claude Projects）的做法是：把整个代码库和文档 embed 成向量，用户提问时 cosine 相似度召回 top-K 塞进 context。这叫 RAG（retrieval-augmented generation）。我花了两周给项目搭了一套完整的 RAG：7000 多个语义 chunks、向量召回、时间衰减、三层缓存、declarative eval，全套。跑了三个月后统计调用频率：日常问 Claude 问题里，用语义 RAG 召回的大约三成；grep 反而是主力，占了一半多。不是 RAG 做失败了。是我在设计时就决定的：每种”查信息”的工具都有算法物理上的不可替代场景，强行用一个工具覆盖所有场景是性能浪费加正确性损失。举一个项目里的真实 query：“为什么打卡和任务工时用了两张表？报表该选哪张？”这一句话里夹了三种信息需求：“两张表” 涉及 DB 字段名 work_entries（我项目里的具体字段名，这里只是举例）—— 精确字面量，一个字符都不能错“打卡 / attendance” —— 中英术语 gap，业务叫打卡、代码叫 attendance、数据库叫英文字段“报表该选哪张” —— 我三个月前做过的决策，理由记在 decisions 文档里某处这三种需求分别对应三个不同工具：精确字面量 → grep 秒杀。向量会把 work_entries 模糊化成”任何跟表有关的文档”中英跨词桥接 → 向量召回。grep 在 “打卡” 和 “attendance” 之间是 0 hits三个月前决策 why → 向量召回 命中 decisions 文档再加第四类场景：“这个字段在代码里哪些文件用过 / 调用链是什么” → 代码图谱（AST-based graph）。向量不理解语法结构，grep 只能找字符不能找引用关系“这条规则是谁什么时候加的 / 上周改过哪里” → git log / git blame。带时间轴和作者的查询，前三个工具都做不到四个工具，四个不可替代的场景：场景正确工具用错工具的后果跨词同义召回语义向量grep 0 hits字段名 / URL / 环境变量grep向量给出模糊前 20 候选，全错调用链 / import 关系代码图谱向量不理解语法谁何时改过git log向量没有时间轴这张表的精髓是：覆盖域 0 重叠，每个场景只有一个正确工具。这里有一个反主流的架构决策：我拒绝装一个”智能路由器”，不去写一段代码自动判断”这个 query 用哪个工具”。理由很简单 —— 模型在进化，今天 Claude 分不清的场景，明年的 Claude 能分清。我只需要在 prompt 里说清楚”四个工具的边界”，让 Claude 自己学选。装了路由器反而把这个选择权从 Claude 手里抢回来硬编码，锁死未来。设计原则：把规则告诉模型，让模型选；不要做模型的代打。顺带澄清一个容易混淆的点：语义记忆层管的是“历史决策 + 跨词召回”，不管“当前任务做到哪”。”当前任务做到哪” 是下一层 —— 交接层的事。记忆是长期的、历史的、衰减的；交接是当前的、热的、每 session 重写的。把两者混在一起会互相污染。



四、交接层：新 session 怎么接上昨天每一次新开 session，Claude 都是完全的白纸。主流 AI 编辑器的做法是把聊天历史塞进新 session。这个方案有两个致命问题。第一，聊天历史是高噪音的流水账。三小时对话里大部分内容是无效尝试、错误路径、临时想法、回退操作、工具报错。把整段塞进新 session 会污染 context —— Claude 下一步的思考质量会被这些噪音降低。第二，聊天历史会超长。Claude Code 自动压缩上下文的时候，关键信息（比如”我们决定不走 X 路线因为发现 Y 问题”）会和噪音一起被压掉，留下一份很难说哪里可信的总结。我的解法是双轨任务状态：一份人类可读的任务协议 —— YAML 格式的任务清单，记录 “当前功能是什么 / 完成了哪些步骤 / 下一步该做什么 / 现在卡在哪”。每次 session 结束时 Claude 主动更新、每次 session 开始时 Claude 主动读一份机器可读的运行时状态 —— JSON 格式的运行数据，记录工具调用轨迹、累计失败次数、当前推理模式、最近命令历史。这份由 hooks 自动维护，Claude 不用管两份文件各管一件事：协议 是 意图 —— 人类语义的”我今天想做什么、昨天做到哪”状态 是 现场 —— 机器测量的”已经试过哪些方案、累计失败几次”每次 /start 一个新 session，Claude 自动做这些事：读任务协议（知道当前功能上下文）读运行时状态（知道之前的失败和压力等级）查最近 3 天的 session 日志（知道最近的交接上下文）从语义记忆里召回跟当前功能相关的历史决策把四样东西编织成一张 briefing 给我这张 briefing 比 1M token 的聊天历史质量高一个数量级，因为它是结构化的结论而不是过程流水账。这里有一个容易踩的坑，我踩过之后专门设计了架构防护：任务协议和运行时状态文件绝对不能进语义记忆索引。原因是：任务协议是每 session 重写的当前态，半衰期应该是”本 session 结束”。如果它被 embed 进长期记忆，明年某次语义召回可能把今天的 TODO 注入到一个不相关的任务里，制造幻觉。对比一下 session 日志：session 日志 应该 进记忆，因为它是历史决策的载体，fresh 态是交接输入、衰减后是记忆语料。但”当前做到哪”这种任务态永远不该进记忆。这就是整个交接层设计里最锐利的一条边界：区分”任务态”和”历史态”，同一个 markdown 文件夹里的不同文件有完全不同的生命周期。看起来是小事，实际上决定了整个记忆系统会不会被污染。


五、认知层：卡住不是情绪，是信号先说一件我拒绝做的事：PUA Claude。社区里有个流派用”你只剩 3.25 学分”、”你被解雇了” 这种话术倒逼模型。我试过一周，结论是技术上无效（不是道德问题）。话术让模型做角色扮演 —— 演一个被骂的员工。演戏消耗的是 prompt 能力，不是解决问题的能力。演完”我收到警告”之后，Claude 下一步还是改个参数重跑，角色变了，推理范式没变。我最后吸收的抽象是另一个方向：挫败感不是情绪，是信息熵信号。具体解释：用户说”再试试”、”不对”、”又错了” —— 这些话本身不带新约束。没有新信息进入对话 = 上一轮的方案没形成有效反馈 = 当前推理范式失败的确定信号。这时候正确的干预不是施压，是换推理框架。于是我给 Claude 配了 7 种推理模式（不是 7 种”人设”，是 7 种不同的推理框架）：模式适用场景核心方法根因分析修 bug、查事故5-Why + 扫同类 bug第一性原理干净新建功能质疑→删除→简化→加速→自动化减法重构、清理删除优先，不增加新抽象搜索优先根因未知先查历史 / 文档，再判断Working Backwards新模块设计倒推用户终态 + 写 PR 稿证据驱动性能 / 质量测量用数据替代直觉闭环默认部署 / 运维 / 其他定目标、追过程、拿结果关键机制是自动切换：一个 hook 监听对话里的挫败感关键词，命中就自动注入一段技术决策文本（不是话术）： “标记当前方案为已失败。从 7 种推理模式重新选一个。切之前先对用户说’我将切换到 X 模式，因为原模式失败在 Y’。”这里的语义是：范式失败 ≠ 模型失败，是当前推理框架跟问题不匹配。让模型从”我再努力一次” 切到 “我换个角度”。这套设计跟 PUA 的根本区别在于失效边界的诚实性：我的方案：只在用户反馈确实是挫败信号时有效。用户自己搞错了问题（问的不对）时，这套机制会静默降级，不制造心理压力PUA 方案：在所有场景下等价施压，分不清”模型思路错了”还是”用户问错了”，一律给模型加压PUA 的假设是”模型一定是错的一方，加压就能修”。我的假设是”失败是系统级信号，应该触发系统切换，不是给模型加压”。底层世界观不一样。这套做下来我意识到一件事：Agent 治理的核心不是让模型听话，是给模型一个能跳出思维定势的机制。

作者：响水大米
链接：https://www.zhihu.com/question/2016648624256340425/answer/2028556334010841014
来源：知乎
著作权归作者所有。商业转载请联系作者获得授权，非商业转载请注明出处。

六、技能层：工作流固化Skills 是 Claude Code 的另一个核心机制，也是整个 harness 里最不起眼但使用最频繁的一层。简单说：skill 是一个 slash 命令 + 一份 markdown 文件。markdown 文件告诉 Claude “当用户敲这个命令时，按这个顺序做这些事”。不需要写代码、不需要配 MCP server、不需要装插件。Claude 读 markdown，按步骤执行。这个设计不是 Claude Code 特有的。OpenAI 在 Shell + Skills + Compaction: Tips for long-running agents 里把 skill 定义成 agent 的三大基元之一（另外两个是 shell 执行和 context compaction）。Anthropic 在 Building Agents with the Claude Agent SDK 里也把 skill 作为核心抽象。两家的共识是：把稳定的工作流从临时 prompt 里拔出来，做成可复用的包。我用得最多的三个 skill：/start：新 session 开场。读任务协议 + 读最近 session 日志 + 从记忆层召回相关历史 + 检查当前 git 状态，给我一份 briefing/commit：提交代码前的动作链。按改动的文件类型路由对应验证，全部绿才生成合规 commit message，再执行 git commit/handoff：session 结束的收尾仪式下面专门讲 /handoff。它是整个 harness 里最能展示 skill 设计威力的一个 skill —— 一个命令下去，同时触发交接层、记忆层、认知层的协同更新。/handoff 长什么样先看 markdown 的核心结构（简化版）：---
name: handoff
description: "Session wrap-up 仪式：保存当前进度、写 session 日志、重建
索引、flush 记忆队列。用户触发词：'结束' / '收工' / '交接' / 'handoff' /
'保存进度' / '今天到这'。"
---

# /handoff — Session Wrap-Up

> 每个 session 结束时调用。目标: ≤ 4 tool calls 完成 handoff。

## Fast Path（默认）

### Step 1: Gather（1 条消息，2 并行）

同一条消息发出：

| # | 工具 | 目的 |
|---|------|------|
| 1 | Bash | git log -5 + status + diff-stat + 危险模式扫描 |
| 2 | Read | 读任务协议最新 100 行 |

### Step 2: Analyze（纯推理，0 IO）

- 生成 session summary（feature / 完成摘要 / blocked_on / next_3_steps）
- Gap 分析（原计划 3 步 vs 实际完成：DONE/PARTIAL/SKIPPED/UNPLANNED）
- Session Wisdom 候选（有非平凡 bug/pattern/decision 值得跨 session 复用才记）

### Step 3: Write（1 条消息，4 并行）

同一条消息发出：

| # | 工具 | 目标 |
|---|------|------|
| 1 | Edit | 更新任务协议（active_plan + next_3_steps + recent_log） |
| 2 | Write | 新写一份 session 日志 |
| 3 | Bash | 重建 session 索引 |
| 4 | Bash | flush 记忆层 pending 队列（embed + merge） |

条件追加：有 Session Wisdom → 第 5 个 Edit 追加到 error-journal。

### Step 3.5: Cognitive 状态持久化（仅当本 session 有失败发生）

读运行时 cognitive-state.json → 写入任务协议的 cognitive 子段
（failure_count / active_mode / command_history / tried_approaches）

### Step 4: Report（≤ 15 行）

打印 session summary + Gap 表 + Next 3 步 + 固化条目（如有）

## Full Path（`--full` 显式触发）

在 Fast 基础上额外跑 8 个固化判定：
A. Diff 签名 → patterns-cache 规则
B. Session Wisdom → 对抗模式 / MEMORY 约束
C. 文档 staleness → 自动生成 codebase-index
D. error-journal 状态更新 (fixed/crystallized/recurred)
E. Archive Sweep（>30 天的 crystallized/fixed 归档）
F. Plan Crystallization（临时 plan 升格到归档）
G. Domain Knowledge Capture（experiments/dead-ends/decisions）
H. Sprint ✅ 标记到 progress-map这份 markdown 有五个关键设计，每一个都是手工 handoff 时我踩过坑学到的：(1) description 里写”触发词”。用户说”结束” / “收工” / “今天到这” / “handoff” / “交接” 都命中同一个 skill。这是意图匹配不是关键字匹配 —— “今天到这” 字面跟 handoff 毫无关系，但语义上是。Claude 读 description 里的触发词列表，match 到就自动调 skill。(2) 性能约束写在 skill 里。标题下面写着 “目标: ≤ 4 tool calls 完成 handoff”。这是个硬约束，写给 Claude 看的 —— 每次 handoff 最多 4 次工具调用。没有这个约束，Claude 会”认真”地挨个 Read / Edit / Bash，变成 12 次调用，慢且浪费 context。(3) 并行调用明确标注。Step 1 和 Step 3 的标题都写着 “1 条消息，N 并行” —— 强制 Claude 在同一条消息里发出多个工具调用。这个设计很关键：Claude 默认会一个一个发，但其实 git log 和 read task protocol 是互相独立的，可以同时发。明确写出 “N 并行” 把 latency 从线性降到常数。(4) 分级复杂度 Fast vs Full。默认 /handoff 跑 Fast Path —— 4 次工具调用、15 行 report、够每日收尾用。大型 sprint 或 phase 收尾时 /handoff --full 触发 Full Path —— 额外跑 8 个固化判定（代码模式提炼、对抗模式记录、archive sweep 等）。一个命令两种精度，按需使用，不强制每次都跑最重的。(5) 条件触发。”Session Wisdom 候选”和”Cognitive 状态持久化”都是有才写，没有跳过。没有值得固化的 pattern 就不写 error-journal（避免 journal 被无效条目污染）；本 session 没失败就不写 cognitive state（没状态可存）。条件触发让 skill 保持精准，不做无效动作。/handoff 如何串联 harness 五层这是 skill 层真正的价值 —— 一个命令触发跨层协同：交接层：Step 3.1 更新任务协议（下次 session 开局用）+ Step 3.2 写新 session 日志（进入 72h 交接窗口）记忆层：Step 3.4 flush pending queue —— 本 session 编辑过的 markdown 批量 embed 进长期记忆认知层：Step 3.5 把运行时的失败计数和当前推理模式原子性持久化到任务协议，下次 session 启动自动恢复边界层：Step 3 的 Edit 动作会触发编辑后 hook（类型检查/测试验证 cooldown）—— 间接保证交接时没有未验证的代码变更技能层自身：Full Path 可能调用 /document-release、/review 等其他 skill，实现组合用户敲一个 /handoff 或说一句 “收工”，背后发生的是整个 harness 在做收尾。没有 skill 层，用户要手动敲十来个命令、改三个文件、保证顺序不错、记得 flush 队列、记得持久化 cognitive state。有了 /handoff，这些动作被折叠成一个原子操作。skill 跟 Unix 哲学的对应Unix 有一句经典原则：Do one thing well, and compose small tools via pipes。Skill 是这个原则在 LLM 时代的转译：“do one thing well” = 每个 skill 专注一件事（/handoff 只管收尾、/commit 只管提交、/start 只管开场）“small tools” = 每个 skill 是一份短 markdown（几十到几百行），不是一套框架“compose via pipes” = skill 可以调用 skill（/commit --ship 内部组合 /verify + /document-release + push）唯一的区别是：脚本是 markdown 写的，执行者是 LLM 而不是 shell 解释器。markdown 写错了改一行，成本接近零；代码写错了要重构，成本高一个数量级。Anthropic 在 Building Effective Agents 里讲过一个原则：agentic 系统应该从最简单的解决方案开始，只在必要时增加复杂度。skill 层就是这个原则的极致体现 —— 不是给 Claude 写代码，是给 Claude 写 SOP。规模感我现在的项目里有 20 多个自定义 skill，覆盖从开场（/start）、提交（/commit）、收尾（/handoff）、调试（/investigate）、架构评审（/strategic-review）、文档同步（/document-release）到跨分支协作（/worktree）的全流程。每一个都是一份 markdown 文件，加起来不到 5000 行。5000 行 markdown 换来的是每天敲几百次命令的确定性 —— 这是整个 harness 投入产出比最高的一层。边界层、记忆层、认知层都需要实际脚本和架构设计（几千行代码），只有 skill 层是纯 markdown —— 几乎零代码换来一整套工作流自动化。七、回到一个原则五层做下来，底层哲学很干净：可靠的系统承载不可靠的模型。模型是熵源。模型的输出有概率性、有 hallucination、有上下文污染、有被”说服跳过规则”的空间。系统的确定性必须来自模型之外：hooks 的拒绝 是确定的 —— 模型看不见它的逻辑记忆层的边界规则 是确定的 —— 不到 50 行 regex 决定什么进什么不进任务协议 是确定的 —— 一份人类手写的 YAML，模型只读和追加推理模式切换 是确定的 —— hook 按关键词自动注入，不靠模型自觉技能步骤 是确定的 —— markdown 里写死的动作顺序模型在哪里参与？在每一层的中心位置。模型决定用哪个工具查信息、召回什么、当前该用哪种推理模式、要不要切换、技能命令里每一步的具体参数。模型做决策，系统保正确。这个分工跟主流的方向是相反的。主流相信”模型越强越好，能塞进 prompt 就塞进 prompt”。我的判断反过来：模型越强，越不能信它自报数据。能让脚本解决的不让模型解决，能让文件做证据的不让对话做证据，能让 kernel 拦截的不让 prompt 规劝。这套设计同时呼应了一个越来越常见的行业术语：Context Engineering（上下文工程）。Anthropic 在 2025 年 9 月发的 Effective Context Engineering for AI Agents 里明确说：提示工程是 2023-2024 的关键词、已经到头了；2025 之后的关键词是 Context Engineering。两者的区别是：提示工程优化”模型看到什么”，上下文工程优化”什么时刻让模型看到什么、什么不让它看到”。OpenAI 在 2025 年 11 月发 GPT-5.1-Codex-Max 时同步推出 Compaction 机制 —— 让 agent 在单个长任务里跨越多个 context window 工作。这也是 Context Engineering 的一个 OS 层实现：当 context 要满了，系统自动压缩老的对话、保留关键节点、让 agent 继续跑。Anthropic 的 Effective Harnesses for Long-Running Agents 里也讲了类似的思路。两家厂商在做 Context Engineering 的 kernel 层（模型自己的压缩机制、session 继续能力）。我在这篇文章里讲的 harness 是 Context Engineering 的 userland 层 —— 普通开发者不能改模型本身，但可以在外面搭一套系统决定什么进 context、什么不进、什么时候进、什么时候被淘汰。hooks 决定当前工具调用前后注入什么 / 拦截什么记忆层决定从历史里召回什么进当前 session交接层决定上个 session 的什么信息带到下个 session认知层决定失败信号该让模型看到什么新框架技能层决定某类任务应该按什么顺序让模型接触哪些信息每一层都是在操纵 context，只不过操纵的对象、时机、目的不同。整个 harness 架构其实就是 Context Engineering 的一套 userland 实现。结尾：三个 takeaway三个月下来，Claude 从”能写代码的助手”变成了”能守规矩的同事”。最大的变化不是效率 —— 效率一直都高。最大的变化是可信任感 —— 我可以放心把跨多 session 的复杂功能丢给它，知道它不会在第三天忘记第一天的决策、不会在压力下 DROP 生产表、不会声称跑过其实没跑的验证。三个 takeaway：1. vibe coding 在简单项目好用，在复杂项目是物理上失效的。不是 prompt 技巧问题，是长上下文衰减、跨 session 失忆、规则一致性这三件事靠单纯写提示词无法解决。复杂项目必须要有 harness。2. 别跟模型讲道理，给模型写 kernel。CLAUDE.md 是协议，协议靠合作；真正守边界的是 hooks，因为它在模型看不见的维度上运行。模型没法合理化它不知道存在的约束。3. 主流的 “模型够强就够了” 是错的。模型越强，越需要一个能力反比例的外部系统框住它。因为模型越强，它越能找到跳过约束交付结果的聪明方案 —— 你唯一的对策是让约束变成物理边界而不是口头协议。如果你也在把 Claude Code 从 vibe coding 用到真实项目，从边界层和交接层这两个最基础的层开始。边界层防止灾难性事故，交接层让你能够做超过一个 session 的连续工作。有了这两层之后再加记忆、认知、技能 —— 一个月你就能感觉到不同。不是学更好的 prompt。是搭一套能让 prompt 不那么重要的系统。

作者：响水大米
链接：https://www.zhihu.com/question/2016648624256340425/answer/2028556334010841014
来源：知乎
著作权归作者所有。商业转载请联系作者获得授权，非商业转载请注明出处。