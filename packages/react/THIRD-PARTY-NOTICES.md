# 第三方软件声明（@huan/react）

本包包含从下列 MIT 许可项目移植的代码。按 MIT 许可要求，此处收录其版权声明与许可全文。

---

## 1. @assistant-ui/react-pi@0.0.29

**移植范围**（本包 `src/` 下的实现，除 `src/vendor/` 另行标注的部分）：

| 本包文件 | 上游文件 |
| --- | --- |
| `src/event-types.ts` | `src/eventTypes.ts` |
| `src/queue-ids.ts` | `src/queueIds.ts` |
| `src/error-text.ts` | `src/utils.ts` |
| `src/client/validation.ts` | `src/client/validation.ts` |
| `src/client/event-source.ts` | `src/client/eventSource.ts` |
| `src/client/http-client.ts` | `src/client/httpClient.ts`（`subscribe` 改为单订阅实现，见文件头） |
| `src/runtime/thread-state.ts` | `src/runtime/threadState.ts` |
| `src/runtime/message-projection.ts` | `src/runtime/messageProjection.ts` |
| `src/runtime/host-ui.ts` | `src/runtime/hostUi.ts` |
| `src/runtime/thread-controller.ts` | `src/runtime/ThreadController.ts` |
| `src/runtime/runtime-types.ts` | `src/runtime/runtimeTypes.ts` |
| `src/runtime/extras.ts` | `src/runtime/piExtras.ts` |
| `src/runtime/dispose-controllers.ts` | `src/runtime/disposeControllers.ts` |
| `src/runtime/hooks.ts` | `src/runtime/hooks.ts` |
| `src/runtime/use-harness-runtime.ts` | `src/runtime/usePiRuntime.ts`（移除 Assistant Cloud 分支） |
| `src/**/*.test.ts(x)` | 对应的上游测试文件（注释与描述译为中文） |

相对上游的改动（类型命名空间迁移、内部工具本地化、注释中文化、部分裁剪）在各文件头部注明。

## 2. @assistant-ui/core@0.3.27

**移植范围**：

| 本包文件 | 上游文件 |
| --- | --- |
| `src/vendor/anti-corruption.ts`（`isRecord`） | `src/utils/json/is-json.ts` |
| `src/vendor/anti-corruption.ts`（`invokeUserCallback`） | `src/utils/invoke-user-callback.ts` |
| `src/vendor/anti-corruption.ts`（`parseDataUrl` 等） | `src/utils/data-url.ts` |
| `src/vendor/anti-corruption.ts`（`detectImageMediaType`） | `src/utils/image-media-type.ts` |
| `src/vendor/anti-corruption.ts`（`resolveImageMediaType`） | `src/utils/wire-media.ts` |
| `src/vendor/anti-corruption.ts`（`RunLeases`） | `src/utils/run-lease.ts` |
| `src/vendor/anti-corruption.ts`（`bytesToBase64`） | `src/adapters/attachment.ts` |
| `src/vendor/hooks.ts`（`useLatestRef`） | `src/react/runtimes/assistant-transport/useLatestRef.ts` |
| `src/vendor/hooks.ts`（`createRuntimeExtras` 等） | `src/runtime/utils/runtime-extras-brand.ts`、`src/react/runtimes/createRuntimeExtras.ts` |
| `src/vendor/part-status.ts` | `src/utils/normalizePartStatus.ts` |
| `src/vendor/tool-approval.ts` | `src/runtime/utils/resolveToolApprovalResponse.ts` |

## 3. @assistant-ui/store@0.3.19

**移植范围**：

| 本包文件 | 上游文件 |
| --- | --- |
| `src/vendor/hooks.ts`（`useReplaySafeEffect`） | `src/utils/useReplaySafeEffect.ts` |

---

## MIT 许可全文

下列三个上游项目均以 MIT 许可发布，版权归同一主体。

```
MIT License

Copyright (c) 2026 AgentbaseAI Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
