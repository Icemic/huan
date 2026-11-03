# 第三方软件声明（@huan/react）

本包包含从下列 MIT 许可项目移植的代码。按 MIT 许可要求，此处收录其版权声明与许可全文。

---

## 1. @assistant-ui/react-pi@0.0.29

**移植范围**（本包 `src/` 下的实现，除 `src/vendor/` 另行标注的部分）：

| 本包文件 | 上游文件 |
| --- | --- |
| `src/model/event-types.ts` | `src/eventTypes.ts` |
| `src/error-text.ts` | `src/utils.ts` |
| `../protocol/src/wire-validation.ts`（R5 迁出本包） | `src/client/validation.ts`（声明见 `packages/protocol/THIRD-PARTY-NOTICES.md`） |
| `src/client/event-source.ts` | `src/client/eventSource.ts` |
| `src/client/http-client.ts` | `src/client/httpClient.ts`（`subscribe` 改为单订阅实现，见文件头） |
| `src/model/thread-state.ts` | `src/runtime/threadState.ts`（拆分元数据/运行数据、完整快照语义） |
| `src/model/message-view.ts` | `src/runtime/messageProjection.ts`（输出改为独立展示类型） |
| `src/model/host-ui.ts` | `src/runtime/hostUi.ts`（移除 assistant-ui approval 适配） |
| `src/browser/service-store.ts`、`src/browser/window-store.ts`、`src/browser/resources.ts` | `src/runtime/ThreadController.ts`、`src/runtime/usePiRuntime.ts` 的状态/订阅/帧合并语义（按整改规范重写为 Zustand 与资源所有者） |
| `src/**/*.test.ts(x)` | 对应的上游测试文件（注释与描述译为中文；按新状态模型迁移） |

相对上游的改动（类型命名空间迁移、内部工具本地化、注释中文化、结构重写与裁剪）在各文件头部注明。

## 2. @assistant-ui/core@0.3.27

**移植范围**：

| 本包文件 | 上游文件 |
| --- | --- |
| `src/vendor/anti-corruption.ts`（`isRecord`） | `src/utils/json/is-json.ts` |
| `src/vendor/anti-corruption.ts`（`invokeUserCallback`） | `src/utils/invoke-user-callback.ts` |
| `src/vendor/anti-corruption.ts`（`parseDataUrl` 等） | `src/utils/data-url.ts` |
| `src/vendor/anti-corruption.ts`（`detectImageMediaType`） | `src/utils/image-media-type.ts` |
| `src/vendor/anti-corruption.ts`（`resolveImageMediaType`） | `src/utils/wire-media.ts` |
| `src/vendor/anti-corruption.ts`（`bytesToBase64`） | `src/adapters/attachment.ts` |

---

## MIT 许可全文

上述上游项目均以 MIT 许可发布，版权归同一主体。

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
