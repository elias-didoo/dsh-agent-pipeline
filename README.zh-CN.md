# dsh-agent-pipeline

**中文** | [English](README.md)

[DeepSeek Harness](https://github.com/deepseek-ai) 插件：跑一个工作区固定的评审流程，agent 做完上一步就发下一步，只在你留了岔路的地方才问本地决策模型。

> **它不替你思考，只是把「下一步该做什么」这一判断交给一个模型，然后按你写好的决策点执行。**

## 前置条件

- **DSH Desktop**（插件依赖 `app.asar` 里的 client 运行时）
- **一个兼容 `/v1/systemone` 的决策模型服务**。本插件按 [llama.cpp server](https://github.com/ggerganov/llama.cpp) 的 `systemone` 接口开发，实测用 4B 决策模型（Kev-4B）跑通。
  - 只支持 `choice` / `score` / `noul` 三种问题类型
  - **不需要**文本生成能力
- 模型服务本机可达即可，默认 `http://127.0.0.1:8080`

## 安装

```bash
git clone https://github.com/elias-didoo/dsh-agent-pipeline.git \
  ~/Downloads/agent-pipeline
cd ~/Downloads/agent-pipeline
npm test          # 可选，验证环境
```

按 DSH 插件的方式装成 **bundle**——**Plugins → Add plugin** 填目录路径，或者：

```json
{ "action": "install_bundle", "target": "/absolute/path/to/agent-pipeline" }
```

然后在 `~/.dsh/profiles/desktop/cordis.patch.yml` 给它配置。只写 `id`、不带 `insert` 的 patch 会**整体替换**那一行的 config，entry 本身由 bundle 提供：

```yaml
- id: agent-pipeline
  name: "dsh-agent-pipeline"
  config:
    # 完整样例见下文「流程怎么配」
```

**不要给这个插件写 `- insert:`。** bundle 已经插入过这一行，同一个 id 再插一次会被拒绝；而纯手工挂载的插件不算已安装的 bundle，插件列表里也就看不到它。

**重启 DSH 生效。** 面板和工作区菜单要重启后才出现——重载只换掉 Host 那一半，浏览器里的模块代际不会变。

## 工作方式

```
你说要什么 → agent 调用 start_flow("requirement")
                  ↓
        插件按固定的步骤表推进，一轮一步
                  ↓
   ┌────────────────┬────────────────┬────────────────┬─────────────┐
  发送            停下            等你说话          分支
 一条消息        等你看一眼      等你说某个词      问模型
```

**为什么要分成两半**：一个工作区的流程是固定的——步骤、顺序、措辞都是你定好一次的东西。走这个流程属于代码的活：确定性、零成本、不会漂。真正属于模型的是流程里唯一一处岔路，比如「这轮自检还有要修的问题，还是已经干净了」。

按现在这套配置实测，模型从「每轮都被问一次、12 个选项」降到「每个流程被问一次、2 个选项」。

**流程由共享的 step 拼成**：三条流程大部分步骤相同，只有开头不一样。step 在表里定义一次、被 id 引用，所以改一句 prompt 是改一处，而不是改三处再等它们漂开。

## 流程怎么配

改 `~/.dsh/profiles/desktop/cordis.patch.yml` 里本插件的 `config`：

```yaml
workspaces:
  - path: /Users/you/project
    enabled: true
    steps:
      - id: review
        label: { en: Plan review, zh: 方案评审 }
        do: send
        prompt: 该读的文档和代码都去读。二次确认下是否评估全了…

      - id: confirm
        label: { en: Wait for go-ahead, zh: 等你决定开干 }
        do: stop
        notifyText: 看完方案，等你决定开干

      - id: start_work
        label: { en: User says go, zh: 用户说开干 }
        do: wait-user
        prompt: 已经列出改动点。等你说「开干」我再逐项检查你的改动。
        expect: 开干

      - id: selfcheck_branch
        label: { en: Any problems left?, zh: 还有问题吗 }
        do: branch
        question: agent 的回复是说仍有没修完的问题，还是说检查已经全部通过？
        options:
          problems: selfcheck_3
          clean: push

      - id: selfcheck_3
        do: send
        prompt: 每次自检都能发现新问题，你觉得还需要下次自检吗？下次你的重点范围和方法是什么？

      - id: push
        do: send
        prompt: 推送

    flows:
      - name: requirement
        label: { en: Requirement, zh: 需求流程 }
        steps: [review, confirm, start_work, selfcheck_branch, selfcheck_3, push]
```

`fixtures/brandu.yml` 是这套插件实际跑的那一份——12 个 step、3 条流程，覆盖需求、bug、冲突三种情况。

## step 的字段

一个 step 就是流程走到它时插件要做的一件事。

| 字段 | 必填 | 含义 |
|---|---|---|
| `id` | 是 | 稳定名字。也是它发出的消息上的标记。 |
| `do` | 是 | `send`、`stop`、`wait-user` 或 `branch`。 |
| `label` | 否 | `{ en, zh }`，面板上显示的名字。不填就用散文的第一行。 |
| `prompt` | `send`、`wait-user` | 消息正文。`wait-user` 时是告诉用户该说什么。 |
| `notifyText` | 否 | 面板上解释这次 `stop` 是什么意思。 |
| `expect` | 否 | 只有 `wait-user` 用：用户必须说出的词。留空则任何消息都算。 |
| `question` + `options` | `branch` | 一个二选一的问题，以及每个答案指向的 step id。 |

### 四种 `do` 各自做什么

**`send`** 发出 prompt 然后前进。不经过模型，这是最常见的情况。

**`stop`** 前进后停下：插件安静等待，直到用户开口。用在你希望先看方案再开工的地方。

**`wait-user`** 只有当最新的用户消息包含 `expect`、且写于流程到达这一步之后才前进。后一个条件是为了防止早先说过的「开干」把之后每一次等待都满足掉。它和 `stop` 不同：`stop` 任何回复都继续，`wait-user` 只认那个词。

**`branch`** 问模型一个二选一的问题，然后跳到选中的那一步。被跳过的 step 保持 pending，面板会显示「没做」而不是假装做了。

### 校验会拦住的几件事

- 流程里列出的 step 必须在共享表里存在。
- 同一条流程不能重复列同一个 step——日志记的是「这条消息发过」，不是「第几次访问发的」，重复会让进度无法复原。
- 一个分支正好两个选项，且都必须指向同一条流程里的 step。
- 每条流程至少要有一个 `stop` 或 `wait-user`，否则它会一路跑到底、从不为你停下来。

配置在加载时校验。引用写错会当场报错，而不是跑到那一步才停在一个没人预计过的状态。

## 怎么看流程

右键工作区，选 **Agent 流程…**。面板会列出每条流程的每一步、该步的完整提示词、每个分支走向哪里，以及这个工作区是否启用了插件。

面板是只读的——配置文件是唯一真相，面板底部会告诉你改哪个文件。

## 怎么启动一条流程

两种入口，同一份实现。

**`/flow`** —— 你自己敲，跟 `/goal` 一样的用法：

```
/flow requirement          启动这条
/flow pause|resume|cancel  控制正在跑的
```

`/flow` 只负责启动和控制，不打印规则。带参数的命令总会被拦下来等参数，所以空的 `/flow` 到不了处理函数——看规则是菜单的事。

**`start_flow`** —— agent 调用，和 `create_goal`、`todo_write` 完全一样的机制。你用话说，它把话变成调用：

```
你：评估如下需求，仅评估，不要动仓库：xxx
agent → start_flow({ flow: "requirement" })
```

两条路都调用同一个 host 方法，所以不会各走各的。

启动和控制是故意分开的：启动对两个调用方都开放，但暂停、继续、取消只给用户。一个能给自己的流程踩刹车的 agent，也可能悄悄跳过自检。

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

预算由插件自己估算，不用宿主的 `tokenMeter`。那个服务按「4 字符 = 1 token」计价，它自己的 README 就写明：这个比率下 **「CJK 文本和 JSON schema 会被严重低估」**，它的数字是**「参考值，不是计费记录」**，而且**「harness 里没有任何东西拿它做决策」**。实测：4825 个中文字符真实消耗 5289 tokens，tokenMeter 只算出 1215——差距大到插件以为 4.8k 的请求实际发出去是 11.2k，被模型直接拒绝。插件自己的估算按实测字符成本计，并且**故意偏高**：高估不过是多截掉一点上下文，低估会直接丢掉这一轮。

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

## 面板

一条流程在跑的时候，输入框上方（todo 列表和 goal 旁边）常驻一条面板：每一步一行，标成已完成、进行中和待完成，带流程名和 `n/m` 计数。暂停、继续、取消都在那里。

面板读的是 session projection，不是当前这一轮，所以你发消息它不会消失。这一条是改完之后最值得验的行为：它渲染的状态来自日志，从磁盘重新加载一个会话看到的应当是同一个样子。

暂停只停止自动推进，agent 本身不停。取消之后面板消失。

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
tail -f ~/.dsh/agent-pipeline/logs/$(date +%F).jsonl
```

| `ev` | 含义 |
|---|---|
| `apply` | 插件已挂载 |
| `config-invalid` / `config-validate-fail` | 配置被拒；`errors` 说明原因，功能保持关闭 |
| `locale` | 本次进程解析出的界面语言 |
| `projection-ready` | 投影已注册就绪 |
| `tools-registered` | `start_flow` 已注册，含可用的流程名 |
| `prompt-registered` | 已告诉 agent 这些流程存在。没有这行就不会有流程被启动：工具在，但没有任何东西指向它 |
| `prompt-fail` | 注入提示失败，`err` 说明原因 |
| `commands-registered` | 面板的 `flow` 命令已注册 |
| `flow-start` | 启动了某条流程；`flow` 说明是哪条 |
| `flow-control` | 暂停/继续/取消已生效；`action` 说明是哪个 |
| `send` | 发出了某一步的提示词；含 `step`、`iteration` |
| `advance` | 某步没发消息就通过了（用户已回答的等待） |
| `branch` | 模型选了方向；含 `step`、`choice`、`target`、`confidence` |
| `judge` | 分支上一次模型调用；含 `confidence` 与完整 `probabilities` |
| `halt` | 流程暂停；`step` 和 `why`（`stop` 或 `wait-user`）说明位置与原因 |
| `skip` | 被拦下没动作；`why` 说明原因：`no-flow`、`awaiting-user`、仲裁原因、`flow-paused`、`empty-input` |
| `uncertain` | 分支处置信度不足，流程停住而不是猜 |
| `error` / `retry` / `stop` | 某一轮出错、重试或终止；`why` 说明是哪种 |
| `send-fail` | 发送失败；含 `err` |

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
tail -20 ~/.dsh/agent-pipeline/logs/$(date +%F).jsonl
```

关键 `ev`：`judge`（阶段与置信度）、`pick`（选中哪条规则）、`send`、`skip`（被拦下，`why` 说明原因）、`halt`（命中 stop 规则后暂停）、`stop`（因错误或上限停止）。
