(() => {
  "use strict";
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const LIMITS = Object.freeze({
    search: 256,
    workflowBytes: 256 * 1024,
    workflowName: 120,
    workflowSteps: 32,
    workflowDepth: 12,
    workflowNodes: 2000,
    stepId: 64,
  });
  const NOTE_FIELDS = Object.freeze([
    { id: "noteSymptom", key: "symptom", label: "异常表象", max: 2000 },
    { id: "notePath", key: "path", label: "排查路径", max: 4000 },
    { id: "noteCause", key: "cause", label: "最终根因", max: 2000 },
    { id: "noteFix", key: "fix", label: "修复动作", max: 2000 },
  ]);
  const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);
  const state = {
    toastTimer: null,
    lastFocus: null,
    filter: "all",
    noteMode: "confirm",
    workflowRunId: 0,
    workflowTimers: [],
  };

  class InputError extends Error {}

  function syncBodyScroll() {
    const overlayOpen = $("#noteDrawer")?.classList.contains("open") || $$(".modal-backdrop:not(.hidden)").length > 0;
    document.body.style.overflow = overlayOpen ? "hidden" : "";
  }

  function setJsonHelp(message, isError = false) {
    const help = $("#jsonHelp");
    help.textContent = message;
    help.classList.toggle("error", isError);
  }

  function clampSearchInput(input) {
    if (input.value.length > LIMITS.search) input.value = input.value.slice(0, LIMITS.search);
    return input.value.trim().toLowerCase();
  }

  function collectNote() {
    return Object.fromEntries(NOTE_FIELDS.map(field => [field.key, $(`#${field.id}`).value]));
  }

  function validateNote(note, requireAll) {
    for (const field of NOTE_FIELDS) {
      const value = note[field.key];
      if (typeof value !== "string") throw new InputError(`${field.label}格式无效。`);
      if (value.length > field.max) throw new InputError(`${field.label}内容过大，最多 ${field.max.toLocaleString()} 字符。`);
      if (requireAll && !value.trim()) throw new InputError(`请填写${field.label}。`);
    }
  }

  function validateJsonTree(value, path = "workflow", depth = 0, counter = { value: 0 }) {
    counter.value += 1;
    if (counter.value > LIMITS.workflowNodes) throw new InputError(`Workflow 节点总量不能超过 ${LIMITS.workflowNodes}。`);
    if (depth > LIMITS.workflowDepth) throw new InputError(`Workflow 嵌套深度不能超过 ${LIMITS.workflowDepth} 层。`);
    if (typeof value === "number" && !Number.isFinite(value)) throw new InputError(`${path} 包含非有限数值。`);
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach((item, index) => validateJsonTree(item, `${path}[${index}]`, depth + 1, counter));
      return;
    }
    Object.entries(value).forEach(([key, item]) => {
      if (FORBIDDEN_KEYS.has(key)) throw new InputError(`${path} 包含不安全字段 ${key}。`);
      validateJsonTree(item, `${path}.${key}`, depth + 1, counter);
    });
  }

  function parseWorkflow(raw) {
    if (typeof raw !== "string") throw new InputError("Workflow JSON 不能为空。");
    const normalized = raw.replace(/^\uFEFF/u, "");
    if (!normalized.trim()) throw new InputError("Workflow JSON 不能为空。");
    if (new TextEncoder().encode(normalized).length > LIMITS.workflowBytes) throw new InputError("Workflow 文件过大，最大允许 256 KiB。");
    let config;
    try { config = JSON.parse(normalized); }
    catch { throw new InputError("JSON 格式错误，请检查括号、逗号与引号。"); }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new InputError("Workflow 必须是对象，且根节点不能是 null 或数组。");

    const missing = ["name", "steps", "mode"].filter(key => !Object.hasOwn(config, key));
    if (missing.length) throw new InputError(`缺少字段：${missing.join("、")}。`);
    if (typeof config.name !== "string" || !config.name.trim()) throw new InputError("name 必须是非空字符串。");
    if (config.name.length > LIMITS.workflowName) throw new InputError(`name 不能超过 ${LIMITS.workflowName} 字符。`);
    if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(config.name)) throw new InputError("name 不能包含控制字符或双向文本控制符。");
    if (config.mode !== "read_only") throw new InputError("mode 必须严格等于 read_only。");
    if (!Array.isArray(config.steps)) throw new InputError("steps 必须是数组。");
    if (config.steps.length < 1) throw new InputError("steps 至少需要 1 个诊断步骤。");
    if (config.steps.length > LIMITS.workflowSteps) throw new InputError(`steps 最多允许 ${LIMITS.workflowSteps} 个诊断步骤。`);

    const ids = config.steps.map((step, index) => {
      const id = typeof step === "string" ? step : step && typeof step === "object" ? step.id : null;
      if (typeof id !== "string" || !id.trim()) throw new InputError(`steps[${index}].id 必须是非空字符串。`);
      if (id.length > LIMITS.stepId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) throw new InputError(`steps[${index}].id 格式无效。`);
      return id;
    });
    const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
    if (duplicate) throw new InputError(`步骤 ID 必须唯一：${duplicate} 重复。`);
    validateJsonTree(config);
    return { ...config, name: config.name.trim() };
  }

  function toast(message) {
    const element = $("#toast");
    element.textContent = message;
    element.classList.add("show");
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => element.classList.remove("show"), 3200);
  }
  function openModal(modal, opener = document.activeElement) {
    state.lastFocus = opener;
    modal.classList.remove("hidden");
    syncBodyScroll();
    setTimeout(() => $("button, input, textarea", modal)?.focus(), 0);
  }
  function closeModal(modal) {
    if (modal.classList.contains("hidden")) return;
    modal.classList.add("hidden");
    syncBodyScroll();
    state.lastFocus?.focus?.();
  }
  function openNote(mode = "confirm", opener = document.activeElement) {
    state.noteMode = mode;
    state.lastFocus = opener;
    $("#noteDrawer").classList.add("open");
    $("#noteDrawer").setAttribute("aria-hidden", "false");
    $("#noteDrawer").removeAttribute("inert");
    $("#drawerBackdrop").classList.remove("hidden");
    syncBodyScroll();
    if (mode === "supplement") {
      $("#noteCause").value = "";
      setTimeout(() => $("#noteCause").focus(), 220);
      toast("原候选将记为负样本，请填写你确认的其他根因。");
    } else setTimeout(() => $("#noteSymptom").focus(), 220);
  }
  function closeNote() {
    $("#noteDrawer").classList.remove("open");
    $("#noteDrawer").setAttribute("aria-hidden", "true");
    $("#noteDrawer").setAttribute("inert", "");
    $("#drawerBackdrop").classList.add("hidden");
    syncBodyScroll();
    state.lastFocus?.focus?.();
  }

  $("#openNote").addEventListener("click", e => openNote("confirm", e.currentTarget));
  $("#acceptDiagnosis").addEventListener("click", e => openNote("confirm", e.currentTarget));
  $("#supplementDiagnosis").addEventListener("click", e => openNote("supplement", e.currentTarget));
  $("#closeNote").addEventListener("click", closeNote);
  $("#drawerBackdrop").addEventListener("click", closeNote);
  $("#saveDraft").addEventListener("click", () => {
    try {
      const draft = collectNote();
      validateNote(draft, false);
      localStorage.setItem("traceroot-note-draft", JSON.stringify(draft));
      $("#draftState").textContent = `草稿已保存 · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      toast("诊断笔记草稿已保存在本地。");
    } catch (error) {
      const message = error instanceof InputError ? error.message : "草稿保存失败：浏览器本地空间不足，请缩短内容后重试。";
      $("#draftState").textContent = "草稿未保存，当前编辑内容仍保留";
      toast(message);
    }
  });
  $("#noteForm").addEventListener("submit", event => {
    event.preventDefault();
    try { validateNote(collectNote(), true); }
    catch (error) {
      const field = NOTE_FIELDS.find(item => !$("#" + item.id).value.trim() || $("#" + item.id).value.length > item.max);
      if (field) $("#" + field.id).focus();
      toast(error.message);
      return;
    }
    try { localStorage.removeItem("traceroot-note-draft"); } catch {}
    closeNote();
    toast(state.noteMode === "supplement" ? "专家修正已进入复核队列，原候选已记为负样本；相似案例关联待复核。" : "诊断笔记 TR-128 已入库，3 条相似案例关联已更新。");
  });

  function restoreDraft() {
    let raw;
    try { raw = localStorage.getItem("traceroot-note-draft"); }
    catch { $("#draftState").textContent = "本地草稿不可用，已保留系统预填内容"; return; }
    if (!raw) return;
    try {
      const draft = JSON.parse(raw);
      validateNote(draft, false);
      NOTE_FIELDS.forEach(field => { $(`#${field.id}`).value = draft[field.key]; });
      $("#draftState").textContent = "已恢复本地草稿";
    } catch {
      $("#draftState").textContent = "本地草稿无法读取，已保留系统预填内容";
    }
  }

  function showEvidence(panelId, scroll = false) {
    $$(".evidence-content").forEach(panel => { const active = panel.id === panelId; panel.hidden = !active; panel.classList.toggle("active", active); });
    $$("[data-panel]").forEach(button => { const active = button.dataset.panel === panelId; button.classList.toggle("active", active); button.setAttribute("aria-selected", String(active)); });
    if (scroll) $(".evidence-panel").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  $$("[data-panel]").forEach(button => button.addEventListener("click", () => showEvidence(button.dataset.panel)));
  $$("[data-show-panel]").forEach(button => button.addEventListener("click", () => showEvidence(button.dataset.showPanel, true)));

  function filterExperiments() {
    const query = clampSearchInput($("#experimentSearch"));
    let visible = 0;
    $$(".experiment-card").forEach(card => {
      const matchesText = card.dataset.search.toLowerCase().includes(query);
      const matchesFilter = state.filter === "all" || card.dataset.status === state.filter;
      const matches = matchesText && matchesFilter;
      card.classList.toggle("hidden", !matches);
      if (matches) visible += 1;
    });
    $("#experimentEmpty").classList.toggle("hidden", visible > 0);
  }
  $("#experimentSearch").addEventListener("input", filterExperiments);
  $$("[data-filter]").forEach(button => button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    $$("[data-filter]").forEach(item => item.classList.toggle("active", item === button));
    filterExperiments();
  }));
  $$(".experiment-card").forEach(card => card.addEventListener("click", () => {
    if (!card.classList.contains("selected")) toast(`${$("code", card).textContent} 可切换；本 Demo 的完整诊断现场固定为 EXP-1042。`);
  }));
  $("#globalSearch").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      clampSearchInput(event.currentTarget);
      $("#experimentSearch").value = event.currentTarget.value;
      filterExperiments();
      $("#experimentSearch").focus();
    }
  });

  function runWorkflow(name = null) {
    state.workflowRunId += 1;
    const runId = state.workflowRunId;
    state.workflowTimers.forEach(clearTimeout);
    state.workflowTimers = [];
    if (name) $("#workflowName").textContent = name;
    const steps = $$("#workflowSteps li");
    const status = $("#workflowStatus");
    $("#rerunDiagnosis").disabled = true;
    steps.forEach(step => step.classList.remove("done", "running"));
    status.innerHTML = "<span><i></i>正在执行诊断</span><small>只读模式 · 不修改训练任务</small>";
    steps.forEach((step, index) => {
      const timer = setTimeout(() => {
        if (runId !== state.workflowRunId) return;
        steps.forEach((item, i) => { item.classList.toggle("done", i < index); item.classList.toggle("running", i === index); });
      }, index * 430);
      state.workflowTimers.push(timer);
    });
    state.workflowTimers.push(setTimeout(() => {
      if (runId !== state.workflowRunId) return;
      steps.forEach(step => { step.classList.remove("running"); step.classList.add("done"); });
      status.innerHTML = "<span><i></i>执行成功</span><small>刚刚 · 耗时 22s · 8 个引用已校验</small>";
      $("#rerunDiagnosis").disabled = false;
      toast("诊断 Workflow 执行完成，根因排序和证据已刷新。");
      state.workflowTimers = [];
    }, steps.length * 430 + 200));
  }
  $("#rerunDiagnosis").addEventListener("click", () => runWorkflow());

  const workflowModal = $("#workflowModal");
  function selectWorkflowPane(id) {
    $$("[data-workflow-tab]").forEach(item => { const active = item.dataset.workflowTab === id; item.classList.toggle("active", active); item.setAttribute("aria-selected", String(active)); });
    $$(".workflow-pane").forEach(pane => { const active = pane.id === id; pane.hidden = !active; pane.classList.toggle("active", active); });
  }
  $("#generateWorkflow").addEventListener("click", e => { $("#workflow-modal-title").textContent = "生成诊断 Workflow"; selectWorkflowPane("generatePane"); openModal(workflowModal, e.currentTarget); });
  $("#importWorkflow").addEventListener("click", e => { $("#workflow-modal-title").textContent = "导入诊断 Workflow"; selectWorkflowPane("importPane"); openModal(workflowModal, e.currentTarget); });
  $("#closeWorkflow").addEventListener("click", () => closeModal(workflowModal));
  $$("[data-workflow-tab]").forEach(button => button.addEventListener("click", () => selectWorkflowPane(button.dataset.workflowTab)));
  $("#previewWorkflow").addEventListener("click", event => {
    event.currentTarget.disabled = true; event.currentTarget.textContent = "生成中…";
    setTimeout(() => { event.currentTarget.disabled = false; event.currentTarget.textContent = "重新生成"; toast("已根据当前数据源生成 5 步只读 Workflow。"); }, 700);
  });
  $("#executeGenerated").addEventListener("click", () => { closeModal(workflowModal); runWorkflow("AI 生成 · Loss Spike Evidence v1"); });
  $("#workflowFile").addEventListener("change", event => {
    const [file] = event.currentTarget.files; if (!file) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setJsonHelp("文件格式错误：仅允许 .json 文件。", true);
      event.currentTarget.value = "";
      return;
    }
    if (file.size > LIMITS.workflowBytes) {
      setJsonHelp("Workflow 文件过大，最大允许 256 KiB。", true);
      event.currentTarget.value = "";
      return;
    }
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      $("#workflowJson").value = String(reader.result);
      setJsonHelp(`已读取 ${file.name}，执行前将校验结构。`);
      toast(`已读取 ${file.name}`);
    });
    reader.addEventListener("error", () => setJsonHelp("文件读取失败，请重新选择或粘贴 JSON。", true));
    reader.addEventListener("abort", () => setJsonHelp("文件读取已取消。", true));
    reader.readAsText(file, "utf-8");
  });
  $("#executeImported").addEventListener("click", () => {
    try {
      const config = parseWorkflow($("#workflowJson").value);
      setJsonHelp(`校验通过 · ${config.steps.length} 个步骤 · 只读模式`);
      closeModal(workflowModal); runWorkflow(config.name);
    } catch (error) {
      setJsonHelp(`校验失败：${error instanceof InputError ? error.message : "未知输入错误。"}`, true);
      $("#workflowJson").focus();
    }
  });

  const compareModal = $("#compareModal");
  [$("#openCompare"), $("#compareFromInspector"), $("#openKnowledge")].forEach(button => button.addEventListener("click", e => openModal(compareModal, e.currentTarget)));
  $("#closeCompare").addEventListener("click", () => closeModal(compareModal));
  const caseDetails = {
    "TR-019": ["与当前分析高度一致", "Falcon 模型、数据阶段切换、grad_clip 缺失", "历史案例使用 32 GPU，当前实验使用 64 GPU", "设置 grad_clip=1.0 后从 checkpoint 恢复", "400 step 内 loss 恢复至基线"],
    "TR-011": ["数据阶段相似，但根因不同", "均在 Code 数据比例升高后出现 loss spike", "TR-011 已开启 grad_clip，异常来自长序列样本过多", "降低 code_ratio 并过滤长序列极值", "loss 在 600 step 后恢复"],
    "TR-008": ["仅症状相似，不建议复用结论", "均出现 loss 和 grad_norm 同步上升", "模型族、数据阶段和学习率均不同", "降低学习率 40%", "300 step 后 grad_norm 回落"]
  };
  function selectCase(row) {
    if (!row) return;
    $$("#caseTableBody tr").forEach(item => item.classList.toggle("selected", item === row));
    $("input[type=radio]", row).checked = true;
    const id = $("input", row).value;
    const detail = caseDetails[id];
    if (!detail) return;
    const [title, common, difference, action, outcome] = detail;
    $("#selectedCaseId").textContent = id; $("#caseDetailTitle").textContent = title; $("#caseCommon").textContent = common; $("#caseDifference").textContent = difference; $("#caseAction").textContent = action; $("#caseOutcome").textContent = outcome;
    $("#useCaseAsReference").disabled = false;
  }
  $$("#caseTableBody tr").forEach(row => row.addEventListener("click", () => selectCase(row)));
  function filterCases() {
    const query = clampSearchInput($("#caseSearch"));
    const activeFilter = $("[data-case-filter].active").dataset.caseFilter;
    const rows = $$("#caseTableBody tr");
    const visibleRows = rows.filter(row => {
      const visible = row.dataset.search.toLowerCase().includes(query) && (activeFilter === "all" || row.dataset.owner === activeFilter);
      row.classList.toggle("hidden", !visible);
      return visible;
    });
    $("#caseEmpty").classList.toggle("hidden", visibleRows.length > 0);
    const selectedVisible = visibleRows.find(row => row.classList.contains("selected"));
    if (!selectedVisible && visibleRows.length) selectCase(visibleRows[0]);
    if (!visibleRows.length) {
      rows.forEach(row => row.classList.remove("selected"));
      $("#selectedCaseId").textContent = "—";
      $("#caseDetailTitle").textContent = "没有可对比方案";
      $("#caseCommon").textContent = "—";
      $("#caseDifference").textContent = "—";
      $("#caseAction").textContent = "—";
      $("#caseOutcome").textContent = "—";
      $("#useCaseAsReference").disabled = true;
    }
  }
  $("#caseSearch").addEventListener("input", filterCases);
  $$("[data-case-filter]").forEach(button => button.addEventListener("click", () => { $$("[data-case-filter]").forEach(item => item.classList.toggle("active", item === button)); filterCases(); }));
  $("#useCaseAsReference").addEventListener("click", () => { closeModal(compareModal); toast(`${$("#selectedCaseId").textContent} 已加入当前诊断证据。`); });
  $$("[data-open-case]").forEach(button => button.addEventListener("click", e => { openModal(compareModal, e.currentTarget); toast(`${button.dataset.openCase} 的实验快照已加载。`); }));

  const validationModal = $("#validationModal");
  $("#runValidation").addEventListener("click", e => openModal(validationModal, e.currentTarget));
  $("#closeValidation").addEventListener("click", () => closeModal(validationModal));
  $("#cancelValidation").addEventListener("click", () => closeModal(validationModal));
  $("#approveValidation").addEventListener("click", event => {
    const button = event.currentTarget; button.disabled = true; button.textContent = "正在创建…";
    setTimeout(() => { closeModal(validationModal); button.disabled = false; button.textContent = "确认创建"; $("#runValidation").textContent = "验证沙箱运行中 · VAL-1042-A"; $("#runValidation").disabled = true; toast("验证沙箱 VAL-1042-A 已启动，原训练任务不受影响。"); }, 900);
  });
  $("#rejectDiagnosis").addEventListener("click", () => toast("该结论已记为负样本，原始证据仍保留。你可继续补充根因。"));
  $("#copyLogs").addEventListener("click", async () => { try { await navigator.clipboard.writeText($("#logsPanel pre").innerText); toast("日志片段已复制。"); } catch { toast("剪贴板未授权，请手动复制。"); } });

  [workflowModal, compareModal, validationModal].forEach(modal => modal.addEventListener("click", event => { if (event.target === modal) closeModal(modal); }));
  document.addEventListener("keydown", event => {
    const activeModal = [validationModal, compareModal, workflowModal].find(modal => !modal.classList.contains("hidden"));
    const activeOverlay = activeModal || ($("#noteDrawer").classList.contains("open") ? $("#noteDrawer") : null);
    if (event.key === "Escape") {
      if (activeModal) closeModal(activeModal);
      else if (activeOverlay) closeNote();
      return;
    }
    if (event.key !== "Tab" || !activeOverlay) return;
    const focusable = $$('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), a[href]', activeOverlay)
      .filter(element => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  restoreDraft();
})();
