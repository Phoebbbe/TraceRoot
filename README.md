# TraceRoot 训练异常诊断 Demo

这是一个可直接打开、无需安装依赖的交互原型。

## 运行

直接使用浏览器打开 `index.html`。若浏览器对本地文件有限制，可在本目录启动任意静态文件服务。

## 推荐演示路径

1. 在左侧选择异常实验，中间直接查看 Workflow、训练曲线、日志和多维 Diff。
2. 点击“生成 Workflow”使用当前诊断目标生成并执行流程。
3. 点击“导入并执行”，粘贴或选择只读 Workflow JSON。
4. 从右侧根因结论打开历史方案对比，在“我的”和“团队”案例中选择参考。
5. 创建最小验证沙箱，确认资源上限和唯一配置变更。
6. 打开“诊断笔记”，校正系统预填的异常表象、排查路径、最终根因和修复动作，确认后更新知识库关联。

## 产品取舍

- 只演示 loss 突增的证据诊断，不追求异常类型覆盖率。
- 首屏是工程师直接操作的诊断现场，不展示产品说明与验收报告。
- 系统仅读，验证实验是隔离的模拟流程，不修改原任务。
- Workflow 支持目标生成、JSON 导入、格式校验和执行演示。
- 因果强度分为“观测证据”与“干预证据”；原型不会伪装成已实现完整 SCM 因果引擎。
- 专家经验由系统基于本次证据预填，必须经专家确认才会进入案例库与知识图谱。
- 允许工程师补充其他根因：原候选会记为负样本，专家修正进入待复核知识队列。

## 技术说明

为确保笔试 Demo 无环境依赖、现场可重复演示，本交付使用原生 HTML/CSS/JavaScript。生产化时仍建议使用 Next.js + TypeScript 并将诊断编排拆为独立后端服务。

## 边界测试

高攻击性输入、异常文件与极值测试见 `../tests/ADVERSARIAL_TEST_CASES.md`。在项目根目录运行：

```powershell
node tests/adversarial-boundary.test.mjs
```

也可运行 `npm test`，依次执行 20 项静态契约检查、21 项完整交互回归和 33 组浏览器边界回归。若环境仅提供 Node.js，可依次运行：

```powershell
node tests/static-contract.test.mjs
node tests/demo-interaction.test.mjs
node tests/adversarial-boundary.test.mjs
```
