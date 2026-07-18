# graphite ui 层

三层结构（均可整体复制到消费方项目 `src/components/ui/`）：

- `primitives/`：行为层（motion 动效 + radix 无障碍 + floating-ui 定位），无样式。
- `components/`：样式层，在 primitives 上贴 graphite token。
- `icons/`：16 个动画图标 + `icon.tsx` 触发引擎（animateOnHover / animateOnTap / animateOnView / loop）。
- 顶层 `data-display.tsx / input.tsx / select.tsx`：数据展示与表单原语。

来源：vendored 自 animate-ui registry（MIT）。部分文件头带上游约定说明，另有本地无障碍增强的分歧注释（见 primitives/animate/tabs.tsx）。已按 graphite 视觉体系定制。
上游文档：组件 registry https://animate-ui.com/docs/components · 动画图标 https://animate-ui.com/docs/icons/get-started · 静态图标目录 https://lucide.dev/icons/ （扩展流程见 declarations/components.md「上游生态与扩展」）。
禁止在业务层绕过本目录直接写原生 button/input/select/textarea/dialog（check-ui.mjs 强制）。
