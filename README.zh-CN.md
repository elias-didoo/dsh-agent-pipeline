# dsh-decision-orchestrator

**中文** | [English](README.md)

[DeepSeek Harness](https://github.com/deepseek-ai) 插件：在 agent 每一轮工作结束后，用本地决策模型判断当前处于流程的哪个阶段，按你配置的规则自动推进。

> **它不替你思考，只是把「下一步该做什么」这一判断交给一个模型，然后按你写好的规则执行。**

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

最后在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里挂载（配置样例见下文「规则怎么配」）：

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
              本地 Kev 判定「当前处于 6 个阶段中的哪一个」
                          ↓
              插件数日志，算出「这个阶段走到第几步」
                          ↓
        ┌─────────────────┼─────────────────┐
     自动发送          停下来等你          什么都不做
```

**为什么要分成两步**：Kev 擅长判断「现在在讨论方案还是改代码」，但判断不了「这是第几轮自检」——后者不在对话文本里。所以阶段交给模型，顺序交给计数器。

## 六个阶段

| 阶段 | 含义 | 插件通常做什么 |
|---|---|---|
| `planning` | 用户在讨论需求或方案，agent 从未改过代码 | 发方案评审、发汇总 |
| `implementing` | 用户说了开干，agent 正在改代码 | **不动作**（不打断它） |
| `selfchecking` | agent 已完成改动，在做自检 | 按轮次发自检提示，最后发推送 |
| `waiting` | agent 停下，明确等你决定 | **停下来**，不自动回 |
| `finished` | 任务彻底结束（已推送或明确说完成） | **停下来** |
| `conflict` | rebase/merge 遇到冲突 | 发冲突追问 |

## 规则怎么配

在 `~/.dsh/profiles/desktop/cordis.patch.yml` 里编辑本插件的 `config`：

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
        rules:
          # ── 方案阶段：按顺序各发一次 ──
          - id: bug_root
            when: planning
            scene: 用户在报 bug，agent 已排查但根因只是推测，没有证据证明
            action: send
            prompt: 以上是你的猜测还是已经有证据证明的根因？需要在浏览器 console 里取什么信息的话你自己去取，cdp 和登录脚本都有现成的

          - id: review
            when: planning
            scene: user 尚未说开干，agent 刚给出技术方案或评估报告
            action: send
            prompt: 该读的文档和代码都去读。二次确认下是否评估全了，是否会带来其他逻辑的影响？…

          - id: summarize
            when: planning
            scene: 二次评审已完成，需要汇总改动点
            action: send
            prompt: 汇总列出你计划的改动点，要点列全

          - id: need_confirm
            when: planning
            scene: 改动点已汇总，等用户决定是否开干
            action: stop
            notifyText: 看完方案，等你决定开干

          # ── 自检阶段：固定四步 ──
          - id: selfcheck_1
            when: selfchecking
            scene: 代码改动完成，尚未自检
            action: send
            prompt: 仔细检查你刚改动的所有文件，是否原本计划的改动全都顺利完成了？…

          - id: selfcheck_2
            when: selfchecking
            scene: 第一轮自检完成
            action: send
            prompt: 该修的问题都修该修的问题都修了吗？有问题就去修

          - id: selfcheck_3
            when: selfchecking
            scene: 第二轮自检完成
            action: send
            prompt: 每次自检都能发现新问题，你觉得还需要下次自检吗？

          - id: push
            when: selfchecking
            scene: 三轮自检都完成
            action: send
            prompt: 推送

          # ── 其他阶段 ──
          - id: conflict
            when: conflict
            scene: rebase 或 merge 最新 head 时发生冲突
            action: send
            prompt: 刚才rebase/merge最新 head 时是否有冲突，你是怎么解决的

          - id: waiting
            when: waiting
            scene: agent 停下并等待用户决定
            action: stop
            notifyText: 需要你看一下

          - id: finished
            when: finished
            scene: 任务已推送或 agent 明确说全部完成
            action: stop
            notifyText: 需求已完成
```

### 规则字段

| 字段 | 说明 |
|---|---|
| `id` | 规则标识，同一工作区内唯一 |
| `when` | **属于哪个阶段**，必须是上面 6 个之一 |
| `scene` | 场景描述，帮助理解这条规则何时生效（不直接喂给模型） |
| `action` | `send` 自动发 / `stop` 停下来等你 / `silent` 不做事 |
| `prompt` | `action: send` 时必填 |
| `notifyText` | 选填，面板上说明这条规则停下时是什么情况 |

### 同一阶段内的顺序

**同一 `when` 下的 `send` 规则，按配置顺序各发一次。**

- `planning` 阶段：`bug_root` → `review` → `summarize` → 全部发过之后由 `need_confirm` 停下来
- `selfchecking` 阶段：`selfcheck_1` → `selfcheck_2` → `selfcheck_3` → `push`，发完就停

顺序靠**数日志里发过的消息**决定，不是靠模型判断，所以准确率是 100%。

## 置信度

Kev 返回的是概率分布。插件用的是**归一化置信度**：

```
normalized = (p_max - 1/n) / (1 - 1/n)
```

含义：把「瞎猜」压到 0，把「绝对确定」拉到 1。

**为什么要归一化**：原始 `p_max` 的含义随选项数变化——2 个选项时瞎猜是 0.5，6 个选项时瞎猜是 0.167。不归一化的话，门槛的松紧会跟着阶段数漂移。

**因此插件固定发全部 6 个阶段给模型**，不按当前配置裁剪。否则选项数随配置变化，同一个 0.5 在不同工作区代表不同把握。你没配规则的阶段不会被选中执行。

低于 `confidenceFloor`（默认 0.3）时，插件不动作，记一条 `uncertain` 日志并暂停自动推进。

## 全局参数

```yaml
    defaults:
      maxIterations: 20        # 单会话最多自动推进多少轮
      failureRetryLimit: 3     # 连续出错几次后停止（网络错误与决策服务失败共用此计数）
      confidenceFloor: 0.3     # 归一化置信度门槛
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

## 看规则

左栏工作区右键 → **决策规则…** → 按阶段分组展示当前规则。

修改请编辑 `cordis.patch.yml`，改完重启 DSH 生效。

> 首次安装后 client 需要**重启 DSH** 才会出现。

## 消息来源标记

插件发出的消息 `source.kind = "decision"`，与真人消息区分开：

- 不会误触发会话标题生成
- 不会重置重复工具调用保护
- 不会被当成「人工活动」而自我抑制
- 插件靠它数日志推导阶段进度

## 关于提醒

**本插件不发系统通知，也不往会话里发消息。**

它只在进程内记录状态。要知道 agent 何时停下、为什么停下，请看日志：

```bash
tail -f ~/.dsh/decision-orchestrator/logs/$(date +%F).jsonl
```

全部 `ev`：

| `ev` | 含义 |
|---|---|
| `apply` / `projection-ready` | 插件装配与 projection 就绪（每次启动或重载记一次） |
| `judge` | 一次判定；含 `stage`、`confidence`、`rawConfidence` |
| `pick` | 选中了哪条规则；含 `stage`、`ruleId`、`progress` |
| `halt` | **命中 `action: stop` 的规则，自动推进已暂停**；`ruleId` 说明是哪条 |
| `stop` | **因错误、迭代上限或判定卡住而终止**；`why` 说明原因 |
| `uncertain` | 置信度不足，未做判定 |
| `send` | 自动发送了一条提示词；含 `ruleId`、`iterations` |
| `send-fail` | 发送失败；含 `err` |
| `skip` | 被拦下没动作；`why` 说明原因（仲裁、等待态、空输入等） |
| `error` | 单次执行出错但未到终止阈值；含 `code`、`failures` |
| `retry` | 网络中断后自动重发「请继续」 |

**为什么不用系统通知**：插件运行在 DSH 的纯 Node 进程里（`ELECTRON_RUN_AS_NODE=1`），
拿不到 Electron 的 Notification。退回 `osascript` 的话，macOS 会把通知归属给
Script Editor，图标错误且点击会打开该应用。宁可没有提醒，也不发一条误导的通知。

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
