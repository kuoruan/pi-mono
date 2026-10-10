# pi-pigment → `pi.registerToolRenderer` 迁移计划（v2）

包：`extensions/pi-pigment`。基线：`@earendil-works/pi-coding-agent` 1.1.0（devDep），peer floor 目标 `>=1.0.1`。v2 已吸收 plan-reviewer 的 6 个必须修正项与建议项。

## 0. 已核实的技术前提（勿重复调研）

- `registerToolRenderer` 于 **1.0.1** 引入；`durationMs`/`outputPad` 于 **1.1.0** 加入 render context（SDK 包内 `CHANGELOG.md` 1.0.1 段第 122/131 行、1.1.0 段第 16-17 行）。
- resolver 链（`dist/core/extensions/runner.js:542`）：扩展 resolver 按**加载顺序** → `base()`。TUI base = `withBuiltInRenderers(name, session.getToolDefinition(name))`（`dist/modes/interactive/interactive-mode.js:1706`）；HTML 导出 base = `session.getToolDefinition(name)`（`dist/core/agent-session.js:3483`）。→ resolver 可覆盖内置工具，`next()` 给到内置 renderer。
- `ToolRenderers = Pick<AnyToolDefinition, "renderShell" | "renderCall" | "renderResult">`（`types.d.ts:508`）。
- write 是唯一非纯渲染工具：原生 `write.js:47-51` `details: undefined`；原生 `edit.js:137` `details: { diff, patch, firstChangedLine }`。SDK 无文件快照/历史 API。
- `tool_call`（`agent-session.js:327`，所有模式触发，只能 block，`input` 可变且改后不重校验）与 `tool_result`（`agent-session.js:349`、`runner.js:904-950`，返回 `{details}` 会合并并随 toolResult 落盘）是仅有的执行前/后数据钩子；`tool_execution_end` 只读。
- 嵌套调用走同一套钩子（`nested-tool-calls.js` 的 runToolCall 传 before/afterToolCall），**但嵌套结果不持久化**（该文件注释）。
- TUI `getRenderContext` 的 `durationMs = isPartial ? undefined : result?.durationMs`（`tool-execution.js`），来源是 `agent-session.js` 扩散的 `event.durationMs`；HTML 导出 context 恒 `durationMs: undefined, outputPad: 1`。

## 1. 目标

用 `pi.registerToolRenderer(resolver)` 取代同名 `registerTool` 重注册，pigment 不再拥有任何工具的执行与注册，只贡献渲染。验收：8 个工具渲染字节一致 + 无执行回归。

## 2. 目标架构

1. **一次注册的 resolver**：扩展 load 时调用一次，内部读可变 current-kit slot。
2. **kit 每 session 重建**：`session_start` 里 `createRenderKit` 后写 slot；首次 `session_start` 前或 kit 构建失败时 fail-safe 到 `next()`。
3. **yield gate 移进 resolver**：resolver 调用时读 `pi.getAllTools()`，该名为外来扩展所有（非 builtin、非 self）则返回 `next()`。FFF 的 `/fff-mode` 命令信号保留。
4. **disabledTools 改为逐调用判 `kit.config`**（顺序：先让位、再查 disabled）。
5. **工厂换 renderer 三元组 seam**：`createToolWrapper` 收 `origRenderers: ToolRenderers | undefined`（来自 `next()`）、吐 `{renderShell, renderCall, renderResult}`；bash 的原生输出委托目标从 `orig.renderResult` 改为 `next().renderResult`。
6. **删除**：`registerToolIfEnabled`、`decorateBuiltin`、`ownPath`、`claimedByOther` 使用点、`SettingsManager` 懒建、各 `createXToolDefinition(cwd)`/`defineTool`、注册期 disabledTools 跳过。

## 3. 阶段 —— **顺序重排（顾问 2026-10-10）**

> **顺序重排：M1 先行，理由 = 零行为空窗 + 零依赖违例。** M1 钩子与渲染注册正交；若先做工厂 seam，write 的 `spec.execute`（唯一使用者）会在 Phase 3 前无处容身，临时形态会让 resolver 通道与 decorate 通道行为分叉。新顺序：**Phase 1′ write 侧信道 → Phase 2′ 工厂 seam → Phase 3′ resolver+harness → Phase 4′ timing → Phase 5′ 契约**。

### Phase 1′（=原 Phase 3）— write details 侧信道

1. **共享 producer**：把 operate 里的 `oldText/content → {kind:diff|new|noChange}` 逻辑（含 `parseDiff`+`detectLanguage`）抽成纯函数，execute 与钩子同调。
2. **新模块** `src/render/write-details-channel.ts`：`tool_call` 按 `toolCallId` 暂存 `{path, content, oldText}`；`tool_result` 校验后 `return {details}`。map 生命周期：`tool_result` 删、`session_start`/`session_shutdown` 清空。
3. **fail-closed 校验**：`isError` / 无 map 条目 / 重读磁盘 ≠ stash.content → 不返回 details。（`tool_result` 事件确认携带最终 `input`；跨扩展改参后磁盘内容会与 stash 不符→丢弃。）注：write 是覆写语义，计划里“`oldText + content === 落盘`”按“**磁盘 == stashed content**”实现。
4. **通道挂闸门**：kit slot + `disabledTools` + 外来名检查（复用 `claimedByOther`）；本阶段先建 module 级 current-kit slot（Phase 3′ resolver 读同一个）。
5. **严格只碰 `toolName === "write"`**。
6. **两步走**：(a) 通道落地 + execute 改调共享 producer（现存测试零改动、绿）；(b) 删 execute 暂存 + write 测试改事件驱动（harness 增量，不动现断言）。
7. **嵌套 write**：live diff 保留，重放回退 plain（与今天持平）。

### Phase 2′（=原 Phase 1）— 工厂 seam

`createToolWrapper(name, origRenderers, services, spec): {renderShell, renderCall, renderResult}`；renderShell 显式 `spec.renderShell ?? origRenderers?.renderShell`；bash 的 `origRenderResult` 闭包捕获入参 renderers。harness 不动。

### Phase 3′（=原 Phase 2）— resolver + harness

同原计划；handoff 改造（M2）仍为必须。

### Phase 4′ — timing（裁决 (a)，同原 Phase 4）

### Phase 5′ — 契约（同原 Phase 5）

### Phase 0 — 验证（硬性 go/no-go，无生产改动）

1. 真实会话（**1.1.0**）确认：`tool_result` 返回的 `details` 到达 `renderResult` 且跨 resume 保留；resolver 覆盖**内置**工具；嵌套调用触发 `tool_call`/`tool_result`。
2. **新增：1.0.1 实机冒烟**（M1 修正）——临时把 devDep 指向 1.0.1，跑 8 工具渲染 + write diff + resume + HTML export + 一次嵌套调用，确认 `tool_result` details 合并/落盘、钩子、export 走 resolver、bash base 定义自带 `commandPrefix`/`shellPath` 在 1.0.1 同样成立。
3. **新增：重放 timing 行为**（M5 修正）——在 1.1.0 真实会话确认"重放的 write/error 行是否带 `durationMs`"，作为 Phase 4 的决策输入。
4. 任一失败 → write 走 Phase 3 的 M8 回退；resolver 前提失败则中止迁移。

### Phase 1 — 工厂 seam

`createToolWrapper` 改为 `origRenderers` 三元组进出。此阶段 harness 不变，byte-parity 套件保持绿。

### Phase 2 — resolver + harness 改造

- 新增 `src/render/resolver.ts`（名字→renderers 映射、yield gate、FFF 信号、disabledTools、current-kit slot）。
- `extension.ts` 只在 load 时注册一次 resolver，删掉 §2.6 清单。
- **M2 修正：`tests/fixtures.ts` 的 mock 必须改造**——捕获 `registerToolRenderer`、提供 `resolve(name, next)` 驱动、`next()` 桩返回真 SDK renderer（可用 `withBuiltInRenderers` 构造）；`tool-yield.test.ts` 的断言从"注册了哪些工具"改为"resolver 对该名返回 undefined"。这是 Phase 2 的显式任务，不是"套件不动"。

### Phase 3 — write

- **M1（首选）**：`tool_call` 预读旧文件按 `toolCallId` 暂存 → `tool_result` 计算并 `return { details }`（details 形状与今天一致，history-compat 测试不动）。
  - **M4 修正·自校验规格**：`tool_result` 时取 `toolCallId` 的预读值，**重读目标文件校验 `预读oldText + content === 落盘内容`**；不匹配、或 `isError`、或 `toolCallId` 不在 map → 丢弃 details 走 plain fallback。覆盖跨扩展改参、并行写竞态、被 block/abort 三种情况。
  - map 生命周期：`tool_result` 删除；`session_start`/`session_shutdown` 清空（被 block 的调用不会触发 `tool_result`）。
  - **M6 修正·边界声明**：嵌套 write 的 diff 仅 live 显示，重放回退 plain（嵌套结果不持久化，与今天持平）。
- **M8（回退）**：仅 write 保留同名注册。

### Phase 4 — timing

- `tookMs = ctx.durationMs ?? stopTiming(...)`；`armTiming`/`stopTiming` 回退路径保持不动。
- **M5 修正·ADR 决策**：依 Phase 0 结果二选一——(a) 跟随 1.1.0（重放行带 Took）则**改 ADR 0005** 并加测试；(b) 保持旧行为则 1.1.0 也强制回退 stopTiming。
- `outputPad` 只做"字段被携带、不读取"，不铺投机管线。

### Phase 5 — 契约

- peer `pi-coding-agent` 与 `pi-tui` 一起抬到 `>=1.0.1`（可加 `<2.0.0`）。
- 修订 `docs/adr/0005-rendering-only.md`：上游"缺装饰层"缺口闭合（改而非追加）；**M3 修正**：把"resolver 按扩展加载顺序先到先得、渲染器级让位无法实现"写成契约，别写成"谁先注册谁赢"。
- 更新 `GLOSSARY.md`（yield gate / renderer resolver；退役注册期术语；注明 renderer-only 邻居若要占位需先注册工具名）。
- changeset（minor；floor 提升对 <1.0.1 是破坏性；1.1.0 重放行可能新增 Took 若选 (a)）。

## 4. 验证门

- 每阶段：`tsc --noEmit`、`oxlint`、`oxfmt --check`、全量 vitest 绿；byte-parity 套件除 Phase 2 的 harness 改造外不动。
- 新增测试：resolver 顺序/覆盖/契约（undefined→next 链、bash 委托、edit renderShell 覆盖）、外来名让位、FFF 信号、disabledTools 逐调用、无 kit fail-safe、`durationMs` 优先与回退、**跨扩展改参不写 details**、被阻断 write 不写 details、重载后 hydrated write 仍有 diff。
- 收尾人工走查（真实会话）：实时 write diff、重载 write diff（含 1.1.0 是否带 Took）、bash 错误帧、FFF 存在时 grep/find、**HTML export 一次**、**嵌套 write 一次**。

## 5. 未决 —— 已由顾问裁决（2026-10-10）

- **write 路径 → M1 即日定案，M8 降级为预定义逃生口**。迁移目标「pigment 不再拥有任何注册」只有 M1 满足；自校验规格保证最坏只是少一个 diff 预览，不影响执行/模型可见结果。Phase 0.1/0.2 从「决策门」降为「确认步」：照跑，仅当「details 不合并/不落盘」或「resolver 覆盖不了内置」才翻回 M8；Phase 1/2 编码不等它。
- **timing → (a) 跟随 1.1.0 即日定案**。`tookMs = ctx.durationMs ?? stopTiming(...)` 在 1.0.1/HTML 导出/partial 下自动回退，与今天一致；1.1.0 live 用 pi 自己的时钟。ADR 0005 的「live-only」禁止的是**编造**时长，显示真实持久化的执行时长不属于编造。Phase 0.3 从「分叉决策」降为「ADR 措辞输入」，不阻塞代码。

## 6. 已知风险

- **yield gate 只能识别"注册了工具名的邻居"**（M3）：只注册 renderer 的邻居不在 `getAllTools()` 里，gate 不触发，pigment 按加载顺序可能无声遮蔽（与今天 first-wins 持平，非回归）。已作为契约声明，FFF 信号为已知例外。
- kit slot 在 fork/reload 时旧会话 in-flight 渲染短暂读新 kit（cwd 变化）——与今天注册表整体替换同级 parity，记录备查。
- 1.0.1 无 `durationMs`/`outputPad`，源码运行期必须字段缺失时回退（编译期以 1.1.0 为准）。
- M1 的 `toolCallId` map 泄漏（被 block 的 write）——session 边界清空 + 自校验。
