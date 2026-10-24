# usd_brep 预研入门（写给小白）

> 目标：读完这一篇，你就明白 usd_brep 是什么、能干什么、为什么它值得预研。
> 全文不需要任何 CAD 或图形学背景。

---

## 一、一句话理解

**usd_brep = 用数学公式造零件，而不是用小方块拼零件。**

想象你要描述一个保龄球：

- **网格思路**（游戏/电影常用）：用几万个小三角形把它"贴"出来。放大看是拼图，永远不是真圆。
- **usd_brep 思路**（工业 CAD 常用）：直接写下一个数学等式"到原点距离 = 2 的所有点"。**无限精确**，放大十亿倍边缘还是真圆。

这个"数学等式描述曲面"的技术，行话叫 **BRep（Boundary Representation，边界表示）**，
曲面是 **NURBS**（可以理解为"可调控制点的柔性数学曲面"）。

| | 网格（PolyBrep / Mesh） | 精确 BRep（usd_brep 的原生形态） |
|---|---|---|
| 本质 | 小三角片拼贴 | 数学公式 |
| 放大后 | 棱角分明 | 依然光滑 |
| 体积计算 | 近似（拼出来的） | **精确**（积分数值解） |
| 布尔运算 | 近似、易出破面 | 精确、保持解析曲面 |
| 文件大小 | 大（存所有三角形） | 小（存公式和参数） |
| 渲染 | 直接渲染 | 需先"细分"成网格 |

## 二、它和 OpenUSD 的关系

**OpenUSD 是"场景格式"，usd_brep 是"精确零件内核"，两者分工明确：**

- OpenUSD（皮克斯发明的）：负责把成千上万个模型、材质、灯光**组装成一个大场景**，
  是 3D 界的"协作文档格式"。
- usd_brep（NVIDIA Omniverse 出的 Python 库）：负责**造出高精度零件**，并以
  BrepArray prim 的形式存进 USD 场景文件。

一句话：**USD 管" assembled 组装"，usd_brep 管"part 零件制造"。**

## 三、5 分钟上手（真实可跑的例子）

### 例子 1：垫圈（CAD 界的 Hello World）

一根 Φ6 圆柱，挖掉 Φ2 的中心孔——这就是垫圈。

```python
import usd_brep

body   = usd_brep.primitives.create_cylinder((0,0,0), 3.0, 0.5)  # 外圆 Φ6, 高 0.5
hole   = usd_brep.primitives.create_cylinder((0,0,-0.5), 1.0, 1.5)  # 内孔 Φ2
washer = usd_brep.booleans.boolean_difference(body, hole)         # 减！

usd_brep.usd.export_brep(washer, "washer.usda")
```

**验证精度**（这就是 BRep 的厉害之处）：
- 教科书公式 π × 0.5 × (3² − 1²) = **12.5664**
- usd_brep 算出来 = **12.5664**
- **误差 0%** —— 网格方法永远做不到这一点。

### 例子 2：精度阶梯（决定"显示多细腻"）

BRep 是精确的，但屏幕显示需要转成三角网格。"允许多贴近真曲面"由
`chord_height_tolerance`（弦高容差）控制——实测同一个球体模型：

| 质量档 | 弦高容差 | 三角形数 | 网格体积 | 与精确值误差 |
|---|---|---|---|---|
| 粗略预览 | 0.1 | 864 | 28.85 | 1.61% |
| 一般可视化 | 0.01 | 2,848 | 29.18 | 0.48% |
| 高质量渲染 | 0.001 | 14,208 | 29.29 | 0.10% |
| **精确 BRep** | — | — | **29.3213** | **0%（基准）** |

> 记忆口诀：**容差越小 → 三角形越多 → 越像真曲面 → 越费性能。**
> 三角形数大致按容差平方反比增长。

## 四、能干什么（API 全景）

约 200 个函数，按用途分 8 大类：

| 类别 | 代表函数 | 小白翻译 |
|---|---|---|
| **primitives 基本体** | create_sphere / box / cylinder / cone / torus | 造毛坯 |
| **booleans 布尔** | boolean_union / difference / intersection | 拼接 / 挖孔 / 取公共部分 |
| **sweeps 扫掠** | linear_sweep / rotational_sweep / pipe_sweep | 拉伸、旋转成型、沿路径走管 |
| **fillets 圆角** | fillet_edges / chamfer | 把尖角磨圆 / 倒斜角 |
| **stitching 缝合** | stitch_brep / stitch_into_solid | 把碎片缝成完整实体 |
| **offset 偏置** | offset_brep / shell_brep | 加厚 / 抽壳（做成空心） |
| **queries 查询** | compute_volume / compute_area / bounding_box | 算体积、面积、尺寸 |
| **usd 读写** | export_brep / import_breps / tessellate_file | 存成 USD 文件 / 读回来 / 转网格 |

## 五、实际工作流（本仓库插件的完整链路）

```
① 建 模    usd_brep.primitives.* + booleans.*     → 得到 Brep 对象
② 导 出    usd_brep.usd.export_brep(brep, x.usda) → 精确 BRep 文件
③ 细 分    tessellate(brep, chord_height_tolerance=0.01)
④ 可视化   three.js / Omniverse / usdview / Blender
```

在 DSH 里你只需要说人话（"建一个带中心孔的垫圈"），agent 自动完成 ①-④，
最后给你一个可拖拽旋转的 HTML 查看器。

## 六、预研结论与建议路线

**核心结论：**
1. **精度是真优势**：体积、面积等测量值与解析解误差为 0（网格方法通常 0.1%~2%）。
2. **布尔运算保持解析曲面**：球减盒之后，残留部分仍然是"球面+平面"的数学表达，
   后续倒角、抽壳依然精确——网格方法做完布尔就是一堆碎三角形。
3. **文件小**：同样的零件，BRep usda 几 KB，高精度网格要几百 KB~几 MB。
4. **性能可调**：显示精度和性能由容差一个参数控制，很灵活。

**局限（要诚实）：**
1. 学习曲线：NURBS/拓扑概念比网格复杂。
2. 渲染必须先细分，多一道工序。
3. Windows 需要 CPython 3.12 + MSVC 运行库（wheel 只发 3.12）。
4. 不要和 usd-core 25.11 混装（符号冲突）。

**建议预研路线（按周）：**
- 第 1 周：跑通 3 个基本体 + 布尔，理解 prim/Brep 概念（就是本文的例子）。
- 第 2 周：工程零件练习——法兰盘（圆柱+螺栓孔阵列）、弹簧（螺旋扫掠）。
- 第 3 周：与网格工作流对比——同零件两条路各做一遍，比精度/文件大小/耗时。
- 第 4 周：接入真实业务（参数化生成器：输入几个数字，输出一族零件）。

## 七、常见问题（FAQ）

**Q: 和 Blender/SketchUp 之类的建模软件冲突吗？**
不冲突。Blender 擅长艺术建模（网格），usd_brep 擅长工程建模（精确曲面）。
usd_brep 导出的 USD 文件 Blender 可以导入（自动转网格）。

**Q: 运行时刷屏的 "No module named 'pxr'" 警告要紧吗？**
不要紧。那是 OpenUSD 原生 C++ 运行时在找 Python 绑定，找不到也照样工作，
所有导出/布尔/细分结果不受影响，可以无视。

**Q: 为什么 wheel 只支持 Python 3.12？**
NVIDIA 只发布了 cp312 的二进制 wheel（含 C++ 内核），其他版本需要自己从源码编译。

**Q: 单位是什么？**
无单位（约定俗成当"米"或"毫米"用），体积单位就是对应的三次方。

---

*本文档由 DSH + usd-brep 插件生成；演示代码与数据均来自真实运行
（见 `test/` 目录与 `washer.usda`、`sphere_r2_minus_box.usda`）。*
