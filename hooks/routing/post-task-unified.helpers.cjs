'use strict';

// === 从 post-task-unified-completion.helpers.cjs 合并的内容 ===

function createPostTaskCompletionHelpers(deps) {
  const {
    fs,
    path,
    routerState,
    getFindingsRegistry,
    PROJECT_ROOT,
    TASKUPDATE_RECOVERY_QUEUE_PATH,
  } = deps;

  const COMPLETION_INDICATORS = [
    /task.*(?:complete|completed|done|finished)/i,
    /(?:complete|completed|done|finished).*task/i,
    /successfully.*(?:complete|created|implemented|fixed)/i,
    /all.*(?:tests|checks).*pass/i,
    /implementation.*complete/i,
    /changes.*made/i,
    /summary.*(?:of|:)/i,
    /## Summary/i,
    /Task \d+ (?:is )?(?:now )?complete/i,
    /I have (?:successfully )?(?:completed|finished|done)/i,
  ];

  function detectsCompletion(output) {
    if (!output || typeof output !== 'string') return false;
    return COMPLETION_INDICATORS.some(pattern => pattern.test(output));
  }

  function formatTaskCompletionWarning(output, taskId) {
    const snippet = output.substring(0, 200).replace(/\n/g, ' ');
    const idDisplay = taskId ? String(taskId) : '<TASK_ID>';
    return `
+======================================================================+
|  WARNING: TASK COMPLETION DETECTED WITHOUT TaskUpdate(completed)     |
+======================================================================+
|  Agent output indicates task completion, but no TaskUpdate was       |
|  recorded recently.                                                  |
|                                                                      |
|  Output snippet: "${snippet.substring(0, 50)}..."                    |
|                                                                      |
|  COPY-PASTE THIS AS YOUR ABSOLUTE LAST ACTION:                       |
|  TaskUpdate({                                                        |
|    taskId: "${idDisplay}",                                           |
|    status: "completed",                                              |
|    metadata: {                                                       |
|      summary: "Describe what was accomplished (>50 chars)",         |
|      filesModified: ["path/to/modified/file"],                      |
|    }                                                                 |
|  });                                                                 |
|                                                                      |
|  FAILURE TO CALL TaskUpdate(completed) = TASK STUCK IN SYSTEM       |
+======================================================================+
`;
  }

  function extractExpectedArtifactPaths(toolInput) {
    const text = `${toolInput?.prompt || ''}\n${toolInput?.description || ''}`;
    if (!text) return [];

    const results = new Set();
    const normalizeRel = raw => {
      const trimmed = String(raw || '')
        .trim()
        .replace(/^['"`]+|['"`]+$/g, '');
      if (!trimmed) return null;
      const normalized = trimmed.replace(/\\/g, '/');
      if (!normalized.startsWith('.claude/')) return null;
      return normalized;
    };

    const backtickRe = /`([^`]*\.claude[\\/]+context[\\/]+reports[\\/][^`]+)`/gi;
    let match;
    while ((match = backtickRe.exec(text)) !== null) {
      const normalized = normalizeRel(match[1]);
      if (normalized) results.add(normalized);
    }

    const writeToRe = /(?:write|save|output)[\s\S]{0,140}?\bto:\s*([^\s\n]+)/gi;
    while ((match = writeToRe.exec(text)) !== null) {
      const normalized = normalizeRel(match[1]);
      if (normalized && normalized.includes('.claude/context/reports/')) {
        results.add(normalized);
      }
    }
    return Array.from(results);
  }

  function getMissingArtifacts(expectedPaths) {
    if (!Array.isArray(expectedPaths) || expectedPaths.length === 0) return [];
    const missing = [];
    for (const relPath of expectedPaths) {
      const abs = path.resolve(PROJECT_ROOT, relPath);
      try {
        const stat = fs.statSync(abs);
        if (!stat.isFile() || stat.size === 0) missing.push(relPath);
      } catch (_err) {
        missing.push(relPath);
      }
    }
    return missing;
  }

  function ingestExpectedReportFindings(expectedPaths, metadata = {}) {
    if (!Array.isArray(expectedPaths) || expectedPaths.length === 0) {
      return { ingested: 0, errors: [] };
    }

    const registry = getFindingsRegistry();
    if (!registry || typeof registry.ingestReportFindings !== 'function') {
      return { ingested: 0, errors: [] };
    }

    const errors = [];
    let ingested = 0;
    for (const relPath of expectedPaths) {
      try {
        const absPath = path.resolve(PROJECT_ROOT, relPath);
        const result = registry.ingestReportFindings(PROJECT_ROOT, absPath, metadata);
        ingested += Number(result?.added || 0);
      } catch (err) {
        errors.push({ path: relPath, error: err?.message || String(err) });
      }
    }
    return { ingested, errors };
  }

  function resolveFindingsFromTaskCompletion(toolOutput, metadata = {}) {
    const text = String(toolOutput || '');
    if (!text || text.length < 30) return { resolved: 0, reviewed: 0 };

    const registry = getFindingsRegistry();
    if (!registry || typeof registry.resolveFindingsFromCompletion !== 'function') {
      return { resolved: 0, reviewed: 0 };
    }

    try {
      return registry.resolveFindingsFromCompletion(PROJECT_ROOT, text, metadata);
    } catch (_err) {
      return { resolved: 0, reviewed: 0 };
    }
  }

  function recordFindingsTrendSnapshot(source = 'post-task-unified') {
    const registry = getFindingsRegistry();
    if (!registry || typeof registry.recordFindingsTrendSnapshot !== 'function') {
      return null;
    }

    try {
      return registry.recordFindingsTrendSnapshot(PROJECT_ROOT, source);
    } catch (_err) {
      return null;
    }
  }

  // Issue 4 fix: Track retry counts per taskId to prevent infinite retry loops.
  // After MAX_TASK_RETRIES (default 2), escalate to user instead of retrying.
  const MAX_TASK_RETRIES = Number(process.env.MAX_TASK_RETRIES || 2);
  const _retryCountsByTaskId = new Map();

  function synthesizeRecoveryTaskUpdate(taskId, reason, retryHint, details = {}) {
    try {
      // Issue 4 fix: Check retry count before queuing another recovery attempt
      if (taskId) {
        const key = String(taskId);
        const currentCount = _retryCountsByTaskId.get(key) || 0;
        if (currentCount >= MAX_TASK_RETRIES) {
          // Max retries reached — escalate to user instead of looping
          const escalationRecord = {
            timestamp: new Date().toISOString(),
            sessionId: process.env.CLAUDE_SESSION_ID || null,
            taskId: taskId,
            status: 'escalated',
            synthetic: true,
            reason: `max_retries_exceeded (${MAX_TASK_RETRIES} attempts)`,
            retryHint: `Task ${taskId} failed ${MAX_TASK_RETRIES} times for reason: ${reason}. Escalate to user via AskUserQuestion.`,
            details: { ...details, retryCount: currentCount, originalReason: reason },
          };
          const dir = path.dirname(TASKUPDATE_RECOVERY_QUEUE_PATH);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.appendFileSync(
            TASKUPDATE_RECOVERY_QUEUE_PATH,
            `${JSON.stringify(escalationRecord)}\n`,
            'utf8'
          );
          return false; // Signal that retry was NOT queued — escalation instead
        }
        _retryCountsByTaskId.set(key, currentCount + 1);
      }

      const dir = path.dirname(TASKUPDATE_RECOVERY_QUEUE_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const record = {
        timestamp: new Date().toISOString(),
        sessionId: process.env.CLAUDE_SESSION_ID || null,
        taskId: taskId || null,
        status: 'in_progress',
        synthetic: true,
        reason,
        retryHint,
        details: { ...details, retryCount: taskId ? _retryCountsByTaskId.get(String(taskId)) : 0 },
      };

      fs.appendFileSync(TASKUPDATE_RECOVERY_QUEUE_PATH, `${JSON.stringify(record)}\n`, 'utf8');
      if (taskId) routerState.recordTaskUpdate(String(taskId), 'in_progress');
      return true;
    } catch (_err) {
      return false;
    }
  }

  function hasMatchingCompletedTaskUpdate(taskId) {
    const update = routerState.getLastTaskUpdate();
    if (!update || !update.timestamp) return false;
    if (Date.now() - update.timestamp > 120000) return false;
    if (!update.taskId || !update.status) return false;

    const normalizedStatus = String(update.status).toLowerCase();
    if (normalizedStatus !== 'completed') return false;
    if (taskId == null) return true;
    return String(update.taskId) === String(taskId);
  }

  function runTaskCompletionGuard(toolOutput, taskId = null, toolInput = null) {
    const enforcement = process.env.TASK_COMPLETION_GUARD || 'block';
    if (enforcement === 'off') return { pass: true };
    if (!toolOutput || !detectsCompletion(toolOutput)) return { pass: true };

    const expectedArtifacts = extractExpectedArtifactPaths(toolInput);
    const missingArtifacts = getMissingArtifacts(expectedArtifacts);
    if (missingArtifacts.length > 0) {
      const missingMessage =
        '[TASK ARTIFACT CONTRACT] Completion detected but expected artifacts are missing: ' +
        `${missingArtifacts.join(', ')}. Use Write/Edit tool to create required report file(s) before completion.`;
      synthesizeRecoveryTaskUpdate(
        taskId,
        'missing_expected_artifact',
        'Create missing artifact files with Write/Edit, then call TaskUpdate({status:"completed"}).',
        { expectedArtifacts, missingArtifacts }
      );

      if (enforcement === 'warn') {
        return { pass: true, result: 'warn', message: missingMessage };
      }
      return { pass: false, result: 'block', message: missingMessage };
    }

    ingestExpectedReportFindings(expectedArtifacts, {
      taskId: taskId || null,
      agentType: toolInput?.subagent_type || null,
    });
    resolveFindingsFromTaskCompletion(toolOutput, {
      taskId: taskId || null,
      agentType: toolInput?.subagent_type || null,
    });
    recordFindingsTrendSnapshot('post-task-guard');

    const wasUpdated = hasMatchingCompletedTaskUpdate(taskId);
    if (wasUpdated) {
      if (process.env.DEBUG_HOOKS) {
        console.error('[post-task-unified] Agent properly called TaskUpdate');
      }
      return { pass: true };
    }

    const warning = formatTaskCompletionWarning(toolOutput, taskId);
    synthesizeRecoveryTaskUpdate(
      taskId,
      'missing_taskupdate_completed',
      'Call TaskUpdate({ taskId, status: "completed", metadata: { summary, filesModified } }) before finishing.',
      {
        completionDetected: true,
        hasRecentMatchingTaskUpdate: false,
      }
    );

    if (enforcement === 'warn') {
      console.error(warning);
      return { pass: true, result: 'warn', message: warning };
    }

    return {
      pass: false,
      result: 'block',
      message:
        warning +
        '\nTask() output indicated completion, but no matching TaskUpdate({ taskId, status: "completed" }) was detected.',
    };
  }

  return {
    COMPLETION_INDICATORS,
    detectsCompletion,
    hasMatchingCompletedTaskUpdate,
    extractExpectedArtifactPaths,
    getMissingArtifacts,
    ingestExpectedReportFindings,
    resolveFindingsFromTaskCompletion,
    recordFindingsTrendSnapshot,
    synthesizeRecoveryTaskUpdate,
    runTaskCompletionGuard,
  };
}

// === 原有的 post-task-unified.helpers.cjs 内容 ===

function createPostTaskUnifiedHelpers(deps) {
  const {
    fs,
    path,
    getCachedState,
    routerState,
    getMemoryManager,
    PROJECT_ROOT,
    LEARNINGS_PATH,
    EVOLUTION_STATE_PATH,
    AUDIT_LOG_PATH,
  } = deps;

  const WORKFLOW_COMPLETE_MARKERS = [
    'workflow complete',
    'workflow completed',
    'all phases complete',
    'all tasks completed',
    'implementation complete',
  ];

  const LEARNING_PATTERNS = [
    /learned[:\s]+([^\n]+)/gi,
    /discovered[:\s]+([^\n]+)/gi,
    /pattern[:\s]+([^\n]+)/gi,
    /insight[:\s]+([^\n]+)/gi,
    /best practice[:\s]+([^\n]+)/gi,
    /tip[:\s]+([^\n]+)/gi,
    /note[:\s]+([^\n]+)/gi,
  ];

  function extractTaskDescription(toolInput) {
    if (!toolInput) return 'Task spawned';
    if (toolInput.description) return toolInput.description;
    if (toolInput.prompt) {
      const firstLine = toolInput.prompt.split('\n')[0];
      return firstLine.length > 100 ? firstLine.slice(0, 100) + '...' : firstLine;
    }
    if (toolInput.subagent_type) return `${toolInput.subagent_type} agent`;
    return 'Task spawned';
  }

  function isPlannerSpawn(toolInput) {
    if (!toolInput) return false;
    const subagentType = (toolInput.subagent_type || '').toLowerCase();
    const description = (toolInput.description || '').toLowerCase();
    const prompt = toolInput.prompt || '';
    if (subagentType.includes('plan')) return true;
    if (description.includes('planner')) return true;
    if (prompt.includes('You are PLANNER') || prompt.includes('You are the PLANNER')) return true;
    return false;
  }

  function isSecuritySpawn(toolInput) {
    if (!toolInput) return false;
    const subagentType = (toolInput.subagent_type || '').toLowerCase();
    const description = (toolInput.description || '').toLowerCase();
    const prompt = toolInput.prompt || '';
    if (subagentType.includes('security')) return true;
    if (description.includes('security')) return true;
    if (prompt.includes('SECURITY-ARCHITECT')) return true;
    return false;
  }

  function isArchitectSpawn(toolInput = {}) {
    const subagentType = (toolInput.subagent_type || '').toLowerCase();
    if (subagentType === 'architect') {
      return true;
    }

    const prompt = (toolInput.prompt || '').toLowerCase();
    const description = (toolInput.description || '').toLowerCase();
    const combined = `${prompt} ${description}`;
    if (combined.includes('security-architect') || combined.includes('database-architect')) {
      return false;
    }

    return prompt.includes('you are architect') || prompt.includes('you are the architect');
  }

  function runAgentContextTracker(toolInput) {
    const description = extractTaskDescription(toolInput);
    if (isPlannerSpawn(toolInput)) {
      routerState.markPlannerSpawned();
      if (process.env.ROUTER_DEBUG === 'true') {
        console.error('[post-task-unified] PLANNER agent detected and marked');
      }
    }
    if (isSecuritySpawn(toolInput)) {
      routerState.markSecuritySpawned();
      if (process.env.ROUTER_DEBUG === 'true') {
        console.error('[post-task-unified] SECURITY-ARCHITECT agent detected and marked');
      }
    }
    if (isArchitectSpawn(toolInput)) {
      routerState.markArchitectSpawned();
      if (process.env.ROUTER_DEBUG === 'true') {
        console.error('[post-task-unified] ARCHITECT agent detected and marked');
      }
    }
    if (process.env.ROUTER_DEBUG === 'true') {
      console.error(
        '[post-task-unified] Agent mode KEPT ACTIVE (router waiting for subagent completion)'
      );
      console.error(`[post-task-unified] Task description: ${description}`);
    }
  }

  function isWorkflowComplete(text) {
    if (!text || typeof text !== 'string') return false;
    const lower = text.toLowerCase();
    return WORKFLOW_COMPLETE_MARKERS.some(marker => lower.includes(marker));
  }

  function extractLearnings(text) {
    if (!text || typeof text !== 'string') return [];
    const learnings = [];
    for (const pattern of LEARNING_PATTERNS) {
      let match;
      pattern.lastIndex = 0;
      while ((match = pattern.exec(text)) !== null) {
        if (match[1] && match[1].length > 10 && match[1].length < 500) {
          learnings.push(match[1].trim());
        }
      }
      pattern.lastIndex = 0;
    }
    return [...new Set(learnings)];
  }

  function appendLearnings(learnings, workflowName = 'Unknown Workflow') {
    if (!learnings || learnings.length === 0) return false;
    const timestamp = new Date().toISOString().split('T')[0];
    const entry = `\n## [${timestamp}] Auto-Extracted: ${workflowName}\n\n${learnings
      .map(item => `- ${item}`)
      .join('\n')}\n`;
    try {
      const dir = path.dirname(LEARNINGS_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(LEARNINGS_PATH, entry);
      return true;
    } catch (err) {
      if (process.env.DEBUG_HOOKS) {
        console.error('Failed to append learnings:', err.message);
      }
      return false;
    }
  }

  function runWorkflowLearningExtraction(toolOutput, toolInput) {
    if (!isWorkflowComplete(toolOutput)) return;
    const learnings = extractLearnings(toolOutput);
    if (learnings.length > 0) {
      appendLearnings(learnings, toolInput?.description || 'Workflow');
    }
  }

  function extractPatterns(output) {
    if (!output || typeof output !== 'string') return [];
    const patterns = [];
    const indicators = [
      /(?:pattern|approach|solution|technique|best practice):\s*(.+)/gi,
      /(?:always|should|must|prefer)\s+(.{20,100})/gi,
      /(?:use|using)\s+(\w+)\s+(?:for|to|when)\s+(.{10,50})/gi,
    ];
    for (const regex of indicators) {
      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(output)) !== null) {
        const value = match[1]?.trim();
        if (value && value.length > 10 && value.length < 200) patterns.push(value);
      }
    }
    return patterns.slice(0, 3);
  }

  function extractGotchas(output) {
    if (!output || typeof output !== 'string') return [];
    const gotchas = [];
    const indicators = [
      /(?:gotcha|pitfall|warning|caution|watch out|careful):\s*(.+)/gi,
      /(?:don't|do not|never|avoid)\s+(.{20,100})/gi,
      /(?:bug|issue|problem):\s*(.{20,150})/gi,
      /(?:fixed|resolved)\s+(?:by|with)\s+(.{20,100})/gi,
    ];
    for (const regex of indicators) {
      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(output)) !== null) {
        const value = match[1]?.trim();
        if (value && value.length > 10 && value.length < 200) gotchas.push(value);
      }
    }
    return gotchas.slice(0, 3);
  }

  function extractDiscoveries(output) {
    if (!output || typeof output !== 'string') return [];
    const discoveries = [];
    const patterns = [
      /`([^`]+\.[a-z]{2,4})`[:\s-]+(.{10,100})/gi,
      /(?:file|module|component)\s+`?([^\s`]+\.[a-z]{2,4})`?\s+(?:is|handles|contains|manages)\s+(.{10,80})/gi,
    ];
    for (const regex of patterns) {
      let match;
      regex.lastIndex = 0;
      while ((match = regex.exec(output)) !== null) {
        const filePath = match[1]?.trim();
        const description = match[2]?.trim();
        if (filePath && description && !filePath.includes(' ')) {
          discoveries.push({ path: filePath, description });
        }
      }
    }
    return discoveries.slice(0, 5);
  }

  function runSessionMemoryExtraction(toolOutput) {
    if (!toolOutput || typeof toolOutput !== 'string' || toolOutput.length < 50) return;
    const mm = getMemoryManager();
    if (!mm) return;

    const patterns = extractPatterns(toolOutput);
    const gotchas = extractGotchas(toolOutput);
    const discoveries = extractDiscoveries(toolOutput);
    let recorded = 0;

    for (const pattern of patterns) {
      if (mm.recordPattern && mm.recordPattern(pattern, PROJECT_ROOT)) recorded++;
    }
    for (const gotcha of gotchas) {
      if (mm.recordGotcha && mm.recordGotcha(gotcha, PROJECT_ROOT)) recorded++;
    }
    for (const discovery of discoveries) {
      if (
        mm.recordDiscovery &&
        mm.recordDiscovery(discovery.path, discovery.description, 'general', PROJECT_ROOT)
      ) {
        recorded++;
      }
    }

    if (recorded > 0 && process.env.DEBUG_HOOKS) {
      console.error(`[post-task-unified] Recorded ${recorded} items from Task output`);
    }
  }

  function runTaskListTracking() {
    routerState.setTaskListCalled();
    if (process.env.DEBUG_HOOKS) {
      console.error('[post-task-unified] TaskList() call recorded');
    }
  }

  function getEvolutionState() {
    return getCachedState(EVOLUTION_STATE_PATH, null);
  }

  function isEvolutionCompletion(state) {
    if (!state) return false;
    if (state.currentEvolution && state.currentEvolution.phase === 'enable') return true;
    if (state.evolutions && Array.isArray(state.evolutions) && state.evolutions.length > 0) {
      const lastEvolution = state.evolutions[state.evolutions.length - 1];
      const completedTime = lastEvolution.createdAt
        ? new Date(lastEvolution.createdAt).getTime()
        : lastEvolution.completedAt
          ? new Date(lastEvolution.completedAt).getTime()
          : 0;
      if (completedTime > 0 && Date.now() - completedTime < 5 * 60 * 1000) return true;
    }
    return false;
  }

  function getLatestEvolution(state) {
    if (!state) return null;
    if (state.evolutions && Array.isArray(state.evolutions) && state.evolutions.length > 0) {
      return state.evolutions[state.evolutions.length - 1];
    }
    if (state.currentEvolution) return state.currentEvolution;
    return null;
  }

  function formatAuditEntry(evolution) {
    if (!evolution) {
      return (
        '[EVOLUTION] ' +
        new Date().toISOString() +
        ' | type=unknown | name=unknown | status=completed'
      );
    }
    const timestamp = evolution.completedAt || new Date().toISOString();
    const type = evolution.type || 'unknown';
    const name = evolution.name || 'unknown';
    const artifactPath = evolution.path || evolution.artifactPath || 'unknown';
    const researchReport = evolution.researchReport || 'none';
    return [
      '[EVOLUTION]',
      timestamp,
      '| type=' + type,
      '| name=' + name,
      '| path=' + artifactPath,
      '| research=' + researchReport,
      '| status=completed',
    ].join(' ');
  }

  function appendToAuditLog(entry) {
    try {
      const dir = path.dirname(AUDIT_LOG_PATH);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(AUDIT_LOG_PATH, entry + '\n');
    } catch (err) {
      if (process.env.DEBUG_HOOKS) {
        console.error('Failed to write audit log:', err.message);
      }
    }
  }

  function runEvolutionAudit() {
    const enforcement = process.env.EVOLUTION_AUDIT || 'on';
    if (enforcement === 'off') return;
    const state = getEvolutionState();
    if (!isEvolutionCompletion(state)) return;
    const entry = formatAuditEntry(getLatestEvolution(state));
    appendToAuditLog(entry);
    if (process.env.DEBUG_HOOKS) {
      console.error('[post-task-unified] Audit entry written:', entry);
    }
  }

  const completionHelpers = createPostTaskCompletionHelpers(deps);

  return {
    WORKFLOW_COMPLETE_MARKERS,
    LEARNING_PATTERNS,
    ...completionHelpers,
    extractTaskDescription,
    isPlannerSpawn,
    isSecuritySpawn,
    runAgentContextTracker,
    isWorkflowComplete,
    extractLearnings,
    appendLearnings,
    runWorkflowLearningExtraction,
    extractPatterns,
    extractGotchas,
    extractDiscoveries,
    runSessionMemoryExtraction,
    runTaskListTracking,
    getEvolutionState,
    isEvolutionCompletion,
    getLatestEvolution,
    formatAuditEntry,
    appendToAuditLog,
    runEvolutionAudit,
  };
}

module.exports = {
  createPostTaskUnifiedHelpers,
};
