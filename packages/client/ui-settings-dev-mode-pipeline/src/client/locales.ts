/** Copy dictionary for the Development Mode settings section. */

/** English strings (the key-set source of truth for this pair). */
export const en = {
  nav: 'Development Mode',
  title: 'Development Mode',
  intro: 'Configure the four-stage Development Mode pipeline: per-role models and per-component prompt context.',
  tabModels: 'Models',
  tabPrompts: 'Prompts',
  tabs: 'Development Mode settings tabs',
  modelsIntro: 'Role subagents (plan review, implementation, code review) run on these models. The planner and '
    + 'coding-orchestrator stages are the session\u2019s own agent, so they run on the session model instead.',
  promptsIntro: 'Inspect each pipeline component\u2019s baseline prompt and add extra context that is injected when '
    + 'that step runs.',
  roleLabelPlanReview: 'Plan Review',
  roleLabelImplement: 'Implementation',
  roleLabelCodeReview: 'Code Review',
  componentLabelPlanner: 'Planner',
  componentLabelPlanReview: 'Plan Review',
  componentLabelImplement: 'Implementation',
  componentLabelCodeReview: 'Code Review',
  provider: 'Provider',
  model: 'Model',
  sessionDefault: 'Session default',
  loadingModels: 'Loading models\u2026',
  loadFailed: 'Loading the model catalog failed: {message}',
  retry: 'Retry',
  baselineLabel: 'Baseline prompt (read-only)',
  contextLabel: 'Extra context',
  contextPlaceholder: 'Optional context to add\u2026',
  save: 'Save',
  saving: 'Saving\u2026',
  saved: 'Saved',
  saveFailed: 'Save failed: {message}',
  readOnly: 'The settings document is read-only in this deployment.',
}

/** Chinese strings (mirrors the `en` key set exactly). */
export const zh: { [Key in keyof typeof en]: string } = {
  nav: '开发模式',
  title: '开发模式',
  intro: '配置四阶段开发模式流水线：各角色的模型与各环节的提示词上下文。',
  tabModels: '模型',
  tabPrompts: '提示词',
  tabs: '开发模式设置标签',
  modelsIntro: '角色子代理（计划评审、实现、代码评审）运行在这些模型上。规划与编码协调阶段就是本会话自身的代理，因此使用会话模型。',
  promptsIntro: '查看每个流水线环节的基线提示词，并添加在该步骤运行时注入的额外上下文。',
  roleLabelPlanReview: '计划评审',
  roleLabelImplement: '实现',
  roleLabelCodeReview: '代码评审',
  componentLabelPlanner: '规划',
  componentLabelPlanReview: '计划评审',
  componentLabelImplement: '实现',
  componentLabelCodeReview: '代码评审',
  provider: '提供方',
  model: '模型',
  sessionDefault: '会话默认',
  loadingModels: '正在加载模型\u2026',
  loadFailed: '加载模型目录失败：{message}',
  retry: '重试',
  baselineLabel: '基线提示词（只读）',
  contextLabel: '额外上下文',
  contextPlaceholder: '可选的额外上下文\u2026',
  save: '保存',
  saving: '保存中\u2026',
  saved: '已保存',
  saveFailed: '保存失败：{message}',
  readOnly: '此部署的设置文档为只读。',
}

/** Copy dictionary key type for the Development Mode settings namespace. */
export type DevModePipelineSettingsKey = keyof typeof en
