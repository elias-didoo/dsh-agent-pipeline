# dsh-decision-orchestrator

**中文** | [English](README.md)

[DeepSeek Harness](https://github.com/deepseek-ai) 插件：在 agent 每一轮工作结束后，用本地决策模型判断当前该做什么，按你配置的决策点自动推进。

> **它不替你思考，只是把「下一步该做什么」这一判断交给一个模型，然后按你写好的决策点执行。**

## 前置条件

- **DSH Desktop**（插件依赖 `app.asar` 里的 client 运行时）
- **一个兼容 `/v1/systemone` 的决策模型服务**。本插件按 [llama.cpp server](https://github.com/ggerganov/llama.cpp) 的 `systemone` 接口开发，实测用 4B 决策模型（Kev-4B）跑通。
  - 只支持 `choice` / `score` / `noul` 三种问题类型
  - **不需要**文本生成能力
- 模型服务本机可达即可，默认 `http://127.0.0.1:8080`

## 安装

```bash
git clone https://github.com/elias-didoo/dsh-decision-orchestrator.git \
  ~/.dsh/plugins/decision-orchestrator
cd ~/.dsh/plugins/decision-orchestrator
npm test          # 可选，验证环境
```

然后在 `~/.dsh/profiles/desktop/package.json` 加依赖：

```json
{
  "dependencies": {
    "dsh-decision-orchestrator": "file:../../plugins/decision-orchestrator"
  }
}
```

最后在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里挂载（配置样例见下文「决策点怎么配」）：

```yaml
- insert:
    - id: decision-orchestrator
      name: "dsh-decision-orchestrator"
      config:
        # ...
```

**重启 DSH 生效。** client 面板需要重启后才会出现。

## 工作方式

```
你发需求 → agent 工作 → agent 停手
                          ↓
              插件读 agent 最后一条回复 + 往前几轮对话
                          ↓
              本地 Kev 判定「最符合当前情形的是哪个决策点」
                          ↓
              插件查日志：这个决策点是不是已经触发过了
                          ↓
        ┌─────────────────┼─────────────────┐
     自动发送          停下来等你          什么都不做
```

**为什么要分成两步**：判断「现在是什么情形」交给模型——它读对话（包括插件自己发的消息），去匹配你写的 `when`。记住「哪些已经发生了」交给插件——它数日志里的消息，精确且几乎不花成本。

两边都不猜对方的活。模型不被要求记账，插件也不去解读散文。

## 决策点怎么配

改 `~/.dsh/profiles/desktop/cordis.patch.yml` 里本插件的 `config`：

```yaml
- id: decision-orchestrator
  name: "dsh-decision-orchestrator"
  config:
    model:
      baseUrl: http://127.0.0.1:8080
      name: kev-latest
    workspaces:
      - path: /Users/you/project
        enabled: true
        decisions:
          - id: bug_root
            when: 用户在报 bug，agent 已排查但根因还只是推测，插件还没问过证据
            do: send
            prompt: 以上是你的猜测还是已经有证据证明的根因？需要在浏览器 console 里取什么信息的话你自己去取，cdp 和登录脚本都有现成的

          - id: review
            when: agent 刚给出技术方案或评估结论，插件还没发过评审要求
            do: send
            prompt: 该读的文档和代码都去读。二次确认下是否评估全了…

          - id: summarize
            when: 插件已发过评审要求，agent 已答复，插件还没要求汇总改动点
            do: send
            prompt: 汇总列出你计划的改动点，要点列全

          - id: confirm
            when: agent 已列出改动点清单，在等用户决定是否开干
            do: stop
            notifyText: 方案已就绪，等你决定是否开干

          - id: finished
            when: 已推送完成（回复里有 HEAD -> main），或明确宣告任务结束
            do: stop
            notifyText: 任务已结束。
```

`fixtures/brandu.yml` 是这套插件实际在跑的一整套配置——12 个决策点，覆盖方案评审、
三轮自检和冲突处理。上面的例子做了精简，完整版本看那个文件。

## 决策点的字段

一个决策点就是插件接下来**可能做的一件事**。模型读对话，挑出最符合当前情形的那一条，插件照着执行。

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` | 是 | 稳定标识，也是它发出的消息上打的标记 |
| `when` | 是 | **这个决策点适用的情形，用自然语言写。** 这就是模型的输入 |
| `do` | 是 | `send` 发消息 / `stop` 停下等你 / `silent` 什么都不做 |
| `prompt` | `send` 必填 | 要发的正文 |
| `notifyText` | 否 | 面板上说明这个 `stop` 是什么意思 |

**没有阶段列表，没有 behavior 表，没有条件表达式。** `when` 写成散文，是因为模型分辨「agent 仍说发现了问题」比任何正则都准。

### 顺序

**每个决策点只触发一次。** 配置里的顺序不决定先后——模型按情形挑，不按位置挑。顺序只影响面板里怎么读。

插件保证同一条 `send` 不会重复：它按 `id` 数自己发过的消息，发过就不再发。`stop` 停一次，之后保持安静，直到用户再次开口。

**模型首选的那条已经发过时**，插件会取次优且尚未发过的一条，而不是让这一轮空转。两个相邻决策点的得分可能只差一个百分点——实测第三轮自检后是 29.9% 对 29.2%——此时模型排第二的那条才是对的，排第一的只是同一情形的上一轮。发生回退时，`pick` 日志里会带 `fellBackFrom`。

这个回退门槛比 `confidenceFloor` 低，是有意的。正常门槛守的是模型的**第一个**答案，分数低意味着对话什么都没对上；而回退发生在一个已经对上过某个决策点之后，相邻那条是对上一轮次，不是瞎猜。已经发过的 `stop` 不会回退——停下是等人的决定，不是流程的一步。

### `when` 怎么写才有效

模型靠**情形之间的边界**来区分，而它只能用对话里有的东西。两条实测有效的规则：

**引用插件已经发过的消息原文。** 对话里包含插件自己发的消息，用开头几个字点名它们：

```yaml
- id: summarize
  when: 对话里已经出现「该读的文档和代码都去读」，但 agent 的回复是一段评审结论，
        不是编号清单。还没有出现「汇总列出你计划的改动点」。
- id: confirm
  when: 对话里已经出现「汇总列出你计划的改动点」这条插件消息，agent 的回复是一条
        编号的改动清单。这是方案阶段的最后一步。
```

不写这两句，两条判据在模型眼里几乎一样。写上之后，同一个场景里正确答案的置信度从 14.8% 升到 51.1%。

**描述回复长什么样，而不只是发生了什么。**「agent 给出了方案」在评审前后都成立；「一条编号的改动清单」只有汇总后才有。

**让模型读位置，别让它替你下决心。** 你已经定死下一步该做什么的地方，就写成「最后一条消息是谁」：

```yaml
- id: selfcheck_go
  when: 上一条插件提问是「每次自检都能发现新问题」，agent 已经回复了它。
  do: send
  prompt: 开始自检
```

这样无论 agent 答什么都成立。如果写成「agent 说自己还需要再来一轮」，等于让模型去判断一个你已经回答过的问题——实测三种回复（说要、说不要、只说「好的」）全部判错。

用什么语言写都行，中英文都可以。

### 决策点越多，边界越要拉开

每个决策点对模型都是一个选项，选项越多，相邻描述越难区分。在 12 条的集合上实测：删掉一条与当前对话完全无关的判据，正确答案就被相邻的抢走——因为它稀释了整个候选面。

所以一套判据不灵时，正确的做法通常是**把相邻的那两条写得更锋利**，而不是再加条目。十几个决策点的工作区，需要比三个的写得更分明。

## 语言

有两处语言，规则不同。

| 位置 | 跟随 |
|---|---|
| 面板文案、发给 agent 的「请继续」 | **DSH 的界面语言设置** |
| 决策点的 `when`（送给决策模型的文本） | 按你的配置 |

面板从 DSH 设置读语言，不用额外配置就和界面一致。如果从来没在 DSH 里显式
选过语言，插件回退到英文。

`when` 是模型输入，不是文档，按你顺手的方式来写。

## 置信度

模型给每个选项一个概率。置信度就是它选中那一项的概率——原始 `p_max`，不再做任何折算。

低于 `confidenceFloor`（默认 `0.15`）时插件不动作：记一条 `uncertain` 日志并暂停自动推进。对话没有明确对上任何决策点的那些轮次因此不会产生动作，这正是期望行为。

**为什么不用归一化。** 早期版本把随机基准 `1/n` 映到 0，好处是固定门槛在任意选项数下含义一致。6 个选项时成立，11 个选项时失效：正确答案归一化后落在 0.06–0.41，而瞎猜落在 0.04–0.06，区间重叠，任何门槛都分不开。原始 `p_max` 能分开——正确答案 0.21 以上，瞎猜 0.14 以下。

**代价：** 有效区间取决于工作区定义了多少个决策点。默认值适合十个左右；选项多得多的工作区可能要调低门槛。每条 `judge` 日志都带完整分布，可以拿真实会话重新标定。

## 全局参数

```yaml
    defaults:
      maxIterations: 20        # 单会话最多自动推进多少轮
      failureRetryLimit: 3     # 连续出错几次后停止（网络错误与决策服务失败共用此计数）
      confidenceFloor: 0.15    # 原始 p_max 门槛
      humanCooldownMs: 30000   # 你发言后多久内不自动发送
      quietWindowMs: 30000     # 其他 agent relay 后多久内不自动发送
      contextBudgetRatio: 0.7  # 上下文占用模型窗口比例
      maxTurns: 3              # 判定时往前看几轮
```

**上下文取舍**：最后一条 agent 回复总是完整保留，更早的轮次才按预算截断。实测同一条输入，只给 120 字会判错，给完整内容判对。

## 仲裁：什么时候插件不动作

任一成立即静默：

1. 你的消息还在队列里等待处理
2. 你刚发过言（30 秒内）
3. 其他 agent 刚 relay 过（30 秒内）
4. **goal 处于 active + armed**（goal 自己会推进，让给它）
5. 有定时任务待投递到本会话
6. 已暂停自动推进、正在等你回应

## 停止与恢复

插件会在几种情况下**停止该会话的自动推进**，并写入 `stoppedReason`：

| `stoppedReason` | 触发条件 |
|---|---|
| `non-retryable:<code>` | 不可恢复的错误 |
| `failure-limit:<n>` | 网络异常连续重发达到 `failureRetryLimit` |
| `iteration-limit:<n>` | 自动推进轮数达到 `maxIterations` |
| `judge-failure:<n>` | 决策服务连续失败 |

**停止后该会话不再有任何动作**，直到：

- 重启 DSH —— `stoppedReason` 存在进程内 `WeakMap`，重启即清零；
- 或调高对应的上限（`failureRetryLimit` / `maxIterations`）后重启。

⚠️ **`iterations` 是会话生命周期内的累计值**，不随用户发言清零。
一条会话如果长期跨多个任务使用，会累积消耗额度，达到 `maxIterations` 后即停止。
需要长时间复用时，重启 DSH 或调高该值。

## 网络异常

agent 因网络中断或 provider 超时停止时，连续重发到 `failureRetryLimit` 次后停止。

**注意：这个计数器是所有错误类型共用的**（网络错误、发送失败、决策服务失败）。
它们共享 `failures`，只有成功发出一次提示词才会归零。因此不同类型的错误会互相加速到达上限。

这与 `dsh-llm-retry` 不冲突：后者是系统级重连，插件只在会话**已停止后**才发消息。

## 看决策点

左栏工作区右键 → **决策规则…** → 按阶段分组展示当前规则。

修改请编辑 `cordis.patch.yml`，改完重启 DSH 生效。

> 首次安装后 client 需要**重启 DSH** 才会出现。

## 消息来源标记

插件发出的消息 `source.kind = "decision"`，与真人消息区分开：

- 不会误触发会话标题生成
- 不会重置重复工具调用保护
- 不会被当成「人工活动」而自我抑制
- 插件靠它数日志判断哪些决策点已触发

## 看日志

插件不发通知。要知道它何时停下、为什么停下，看日志：

```bash
tail -f ~/.dsh/decision-orchestrator/logs/$(date +%F).jsonl
```

| `ev` | 含义 |
|---|---|
| `apply` / `projection-ready` | 插件挂载、投影就绪 |
| `locale` | 本次进程解析出的界面语言 |
| `judge` | 一次判定；含 `decision`、`confidence`、完整 `probabilities` |
| `pick` | 选中了哪个决策点；含 `decision`、`progress` |
| `halt` | 命中 stop 决策点，自动推进已暂停 |
| `stop` | 因错误或迭代上限而终止；`why` 说明原因 |
| `uncertain` | 置信度不足，未做判定 |
| `send` | 自动发送了一条提示词；含 `ruleId`、`iterations` |
| `send-fail` | 发送失败；含 `err` |
| `skip` | 被拦下没动作；`why` 说明原因 |
| `error` | 单次执行出错但未到终止阈值 |
| `retry` | 网络中断后自动重发「请继续」 |

## 测试

```bash
node test/all.mjs          # 全部（含真实 Kev）
node test/all.mjs --fast   # 跳过真实 Kev
./test/typecheck.sh        # 只跑类型检查
```

| 套件 | 覆盖 |
|---|---|
| `contracts.mjs` | DSH 运行时契约、inject 覆盖、零外部依赖 |
| `apply.mjs` | projection 装配与 schema |
| `context.mjs` | 上下文预算、最后一条优先、来源标签 |
| `confidence.mjs` | 置信度归一化与门槛效果 |
| `phase.mjs` | 阶段进度推导 + pickRule 查表 |
| `flow.mjs` | 主循环全部分支 |
| `e2e-kev.mjs` | 真实 Kev 端到端 |

## 排查

```bash
tail -20 ~/.dsh/decision-orchestrator/logs/$(date +%F).jsonl
```

关键 `ev`：`judge`（阶段与置信度）、`pick`（选中哪条规则）、`send`、`skip`（被拦下，`why` 说明原因）、`halt`（命中 stop 规则后暂停）、`stop`（因错误或上限停止）。
