# 第三方来源与许可（@huan/harness）

本应用的基础组件、主题 tokens 与字体来自以下项目。界面 tokens 与紧凑尺度另外参考了用户自有项目末语工坊（fishflow）的实现，未复制其 Tauri/编辑器专用状态。

## @base-ui/react

- 来源：https://github.com/mui/base-ui
- 用途：应用自有 Dialog、Popover、Tooltip、Avatar、Collapsible、Combobox、Select 等无头组件。
- 许可：MIT

```text
MIT License

Copyright (c) 2019 Material-UI SAS

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

## shadcn/ui（base-nova 样式）

- 来源：https://github.com/shadcn-ui/ui
- 用途：按钮、弹层、输入、选择器等基础组件的结构、状态样式与 CSS tokens 参考。
- 许可：MIT

本应用的Button、Dialog、Input、Select保留按需维护的本地封装；直接取得registry源码的组件逐项记录如下。

### 2026-11-03 获取的官方 Base UI registry 组合

最终聊天展示直接采用以下官方 registry 源码，未用本地自写 DOM 冒充组合：

| 官方来源 | 本地文件 | 本地差异 |
| --- | --- | --- |
| https://ui.shadcn.com/r/styles/base-nova/message.json | `src/components/ui/message.tsx` | 仅改本地 `cn` 导入 |
| https://ui.shadcn.com/r/styles/base-nova/bubble.json | `src/components/ui/bubble.tsx` | 仅改本地 `cn` 导入 |
| https://ui.shadcn.com/r/styles/base-nova/trace.json | `src/components/ui/trace.tsx` | 本地 collapsible 路径；官网 create 占位图标换为 lucide `ChevronRightIcon` |
| https://ui.shadcn.com/r/styles/base-nova/input-group.json | `src/components/ui/input-group.tsx` | 本地 Button/Input/Textarea 路径 |
| https://ui.shadcn.com/r/styles/base-nova/attachment.json | `src/components/ui/attachment.tsx` | 本地 Button 路径 |
| https://ui.shadcn.com/r/styles/base-nova/code-block.json | `src/components/ui/code-block.tsx` | 本地 Button 路径；复制按钮接本应用剪贴板 hook 与中文可访问名称；不引入官网 `use-highlighted-code`/Shiki 运行时 |
| https://ui.shadcn.com/r/styles/base-nova/empty.json | `src/components/ui/empty.tsx` | 补充 React 类型导入 |
| https://ui.shadcn.com/r/styles/base-nova/collapsible.json | `src/components/ui/collapsible.tsx` | 原样本地路径 |

`src/components/ui/model-selector.tsx` 与 `model-selection.ts` 保留原 Base UI 选择器组合，已移除 assistant-ui 状态/运行时绑定；现无 `@assistant-ui/*` 运行依赖。

上游 MIT 许可：`Copyright (c) 2023 shadcn`。

### 2026-11-03 设置界面采用的官方组件

以下源码来自base-nova registry，保留上游组合API与variant。路径、中文标签与主题tokens按本应用接入；没有引入额外组件运行库。

| 官方来源 | 本地文件 | 本地差异 |
| --- | --- | --- |
| https://ui.shadcn.com/r/styles/base-nova/tabs.json | `src/components/ui/tabs.tsx` | 补传Root的orientation；方向选择器显式使用data属性 |
| https://ui.shadcn.com/r/styles/base-nova/field.json | `src/components/ui/field.tsx` | 本地Label/Separator路径；显式方向选择器 |
| https://ui.shadcn.com/r/styles/base-nova/checkbox.json | `src/components/ui/checkbox.tsx` | 使用lucide CheckIcon；圆角使用现有4px token |
| https://ui.shadcn.com/r/styles/base-nova/radio-group.json | `src/components/ui/radio-group.tsx` | 本地cn路径 |
| https://ui.shadcn.com/r/styles/base-nova/switch.json | `src/components/ui/switch.tsx` | 本地cn路径；作为二态控件保留，三态设置使用Select |
| https://ui.shadcn.com/r/styles/base-nova/item.json | `src/components/ui/item.tsx` | 本地cn/Separator路径 |
| https://ui.shadcn.com/r/styles/base-nova/separator.json | `src/components/ui/separator.tsx` | 本地cn路径；显式方向选择器 |
| https://ui.shadcn.com/r/styles/base-nova/label.json | `src/components/ui/label.tsx` | 本地cn路径 |
| https://ui.shadcn.com/r/styles/base-nova/alert.json | `src/components/ui/alert.tsx` | 本地cn路径 |
| https://ui.shadcn.com/r/styles/base-nova/badge.json | `src/components/ui/badge.tsx` | 本地cn路径 |

`src/components/settings-dialog.tsx`参照https://ui.shadcn.com/r/styles/base-nova/sidebar-13.json的设置弹层结构，以官方Tabs替代演示Sidebar导航，保留应用既有Dialog。页面业务组合使用上述Field/Item等组件。ReUI未取得可采用的具体源码，本轮未采用。

上游MIT许可：`Copyright (c) 2023 shadcn`。

```text
MIT License

Copyright (c) 2023 shadcn

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

## react-markdown / remark-gfm

- 来源：https://github.com/remarkjs/react-markdown 、https://github.com/remarkjs/remark-gfm
- 用途：消息 Markdown、GFM 表格/任务列表/删除线与代码块渲染。
- 许可：MIT

## Geist 可变字体

- 来源：https://github.com/vercel/geist-font
- 包：`@fontsource-variable/geist`
- 许可：SIL Open Font License 1.1

Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font) Geist-Italic[wght].ttf: Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
