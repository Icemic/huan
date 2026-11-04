# 第三方来源与许可（@huan/harness）

本应用的基础组件、主题 tokens 与字体来自以下项目。界面 tokens 与紧凑尺度另外参考了用户自有项目末语工坊（fishflow）的实现，未复制其 Tauri/编辑器专用状态。

## @base-ui/react

- 来源：https://github.com/mui/base-ui
- 用途：shadcn官方组件内部的无头交互；业务组件通过已安装组件组合，不直接重写这些原语。
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
- 用途：应用内安装的base-nova基础与聊天展示组件，以及官方Tailwind状态变体。
- 许可：MIT

### 当前安装结果

2026-11-03使用官方CLI `shadcn@4.23.0`，从`apps/harness`运行`add`安装下列30个组件，随后同CLI安装ButtonGroup（当前31个）。保留CLI生成的路径与lucide图标转换结果；仅Tabs包含下述已注明的本地修正，其余30个组件文件保持安装结果。包版本满足仓库3天发布龄约束。

| 官方registry名称 | 本地目录 |
| --- | --- |
| alert、attachment、avatar、badge、bubble、button、checkbox、code-block、collapsible、dialog | `src/components/ui/`同名tsx文件 |
| empty、field、input、input-group、item、label、message、popover、radio-group、scroll-area | 同上 |
| select、separator、skeleton、switch、tabs、textarea、tooltip、trace、combobox、dropdown-menu、button-group | 同上 |

registry地址形式为`https://ui.shadcn.com/r/styles/base-nova/{name}.json`。CLI同时安装`src/hooks/use-highlighted-code.ts`、`src/lib/highlighter.tsx`及Shiki依赖；当前消息代码块没有启用高亮。两份附带源码在Biome配置中按明确路径排除，与ui目录相同保留CLI生成内容，不以项目格式规则改写。`shadcn@4.23.0`作为依赖提供`shadcn/tailwind.css`，由全局CSS导入，主题tokens继续在应用维护。

原自写`menu.tsx`、`model-selector.tsx`与`model-selection.ts`已删除。模型/Thinking在`pi-model-selector.tsx`组合官方Combobox与独立思考强度DropdownMenuRadioGroup；TooltipIconButton移至业务组件目录。ScrollArea在调用处组合Select、DropdownMenu、Combobox、CodeBlock和AttachmentGroup，不在上游文件内插入滚动结构。设置弹层业务布局继续参考官方sidebar-13示例；ReUI尚未采用。

此前从原始registry复制并手工调整路径、图标、滚动和方向样式的版本已由本次CLI安装替换。当前唯一上游文件差异为`tabs.tsx`补传`orientation={orientation}`，修复垂直页签键盘语义，修改位置已加中文注释。Tooltip官方文件保持原样，业务调用处通过className隐藏直系Arrow，避免与文字重叠，并附中文原因注释。审计与实施记录见[UI调整§5.12](../../docs/iteration/2026-11/2026-11-03-feat-ui-adjustments.md#512-基础组件来源审计与官方安装整改)。

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

## tw-animate-css

- 来源：https://github.com/Wombosvideo/tw-animate-css
- 安装版本：1.4.0；许可：MIT（许可文本随依赖分发）。
- 用途：官方组件animate-in/out、淡入淡出、缩放与滑动的CSS工具类。全局速度由应用CSS变量维护，不改包内源码；系统减少动态效果偏好在应用层处理。

## @tanstack/react-virtual

- 来源：https://github.com/TanStack/virtual
- 安装版本：3.14.24；许可：MIT（许可文本随依赖分发）。
- 用途：会话树可见行虚拟渲染、动态行高测量与索引定位，滚动容器继续使用官方ScrollArea。

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
