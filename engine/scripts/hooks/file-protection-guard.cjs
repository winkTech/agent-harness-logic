#!/usr/bin/env node
/**
 * File Protection Guard
 *
 * PreToolUse hook: intercepts Edit/Write operations and blocks them
 * if the target file path matches a protected pattern.
 *
 * Protected patterns are defined inline below in PROTECTED_PATTERNS.
 * To customize, edit that array — no external config file needed.
 *
 * Exit code:
 *   0 — allow (no match or not an Edit/Write)
 *   2 — block (file matches a protected pattern)
 *
 * ⚠️ 必须用 exit 2 才能被 Claude Code Hook 系统识别为"拦截"。
 *    exit 1 会被视为非阻断错误，操作仍然继续。
 *    参见: ~/.claude/CLAUDE.md → 铁律第零条
 */

'use strict';

const fs = require('node:fs');

// ── Protected File Patterns ────────────────────────────────────────────────
// Edit this array to add/remove patterns. Glob-like syntax:
//   **  = match across directory boundaries
//   *   = match within a single path segment
//   ?   = match a single character
//
// See rules/08-constraints.md for the rationale behind each pattern.

const PROTECTED_PATTERNS = [
  '**/matlab/**',                // MATLAB golden model (浮点)
  '**/*golden*',                 // Any golden model file
  '**/*golden_model*',           // Explicit golden_model files
  '**/python/**/golden*',        // Python golden model scripts
  '**/python/**/fixed_point*',   // Python fixed-point reference
  '**/scripts/**/golden*',       // Shell/script golden model
];

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Check if a file path matches a glob-like pattern.
 * Supports ** (match anything), * (match within single path segment), ? (single char).
 */
function matchesPattern(filePath, pattern) {
  let regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '___GLOBSTAR___')
    .replace(/\*/g, '[^/]*')
    .replace(/___GLOBSTAR___/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexStr}$`, 'i').test(filePath);
}

/**
 * Try to extract tool call from stdin or env vars.
 */
function parseToolCall() {
  // Strategy 1: Read stdin (tool call JSON from Claude Code hook system)
  try {
    const input = fs.readFileSync(0, 'utf8');
    if (input && input.trim()) {
      const data = JSON.parse(input);

      // Format (a): {tool: {name: "Write", input: {file_path: "..."}}}
      if (data?.tool?.name && data?.tool?.input?.file_path) {
        return { toolName: data.tool.name, filePath: data.tool.input.file_path };
      }
      // Format (b): {tool_name: "Write", tool_input: {file_path: "..."}}
      if (data?.tool_name && data?.tool_input?.file_path) {
        return { toolName: data.tool_name, filePath: data.tool_input.file_path };
      }
      // Format (c): flat {name: "Write", input: {file_path: "..."}}
      if (data?.name && data?.input?.file_path) {
        return { toolName: data.name, filePath: data.input.file_path };
      }
      // Format (d): flat {arguments: {file_path: "..."}}
      if (data?.name && data?.arguments?.file_path) {
        return { toolName: data.name, filePath: data.arguments.file_path };
      }
    }
  } catch (_e) {
    // fall through to env var strategy
  }

  // Strategy 2: Environment variables
  const envName = process.env.CLAUDE_TOOL_NAME || '';
  const envInput = process.env.CLAUDE_TOOL_INPUT || '';
  if (envName && envInput) {
    try {
      const parsed = JSON.parse(envInput);
      const filePath = parsed?.file_path || parsed?.arguments?.file_path || '';
      if (filePath) return { toolName: envName, filePath };
    } catch (_e) {
      // ignore
    }
  }

  return null;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  // 逃生开关: CLAUDE_GATES_DISABLED=true 跳过所有门禁
  if (process.env.CLAUDE_GATES_DISABLED === 'true') process.exit(0);

  if (PROTECTED_PATTERNS.length === 0) {
    process.exit(0); // No patterns — allow everything
  }

  const call = parseToolCall();
  if (!call) {
    process.exit(0); // Can't determine tool call — allow (fail-open)
  }

  // Only protect against file-modifying operations
  if (call.toolName !== 'Edit' && call.toolName !== 'Write') {
    process.exit(0);
  }

  // Normalize: use forward slashes for cross-platform matching
  const normalizedPath = call.filePath.replace(/\\/g, '/');

  // ── Auto-backup settings.local.json ──────────────────────────────────────
  // 在修改 settings.local.json 前自动备份
  if (normalizedPath.endsWith('settings.local.json') || normalizedPath.endsWith('settings.json')) {
    try {
      const bakPath = call.filePath + '.bak';
      if (fs.existsSync(call.filePath)) {
        fs.copyFileSync(call.filePath, bakPath);
        console.error(`[FileProtection] 已自动备份 ${call.filePath} → ${bakPath}`);
      }
    } catch (_e) {
      // 备份失败不阻断操作
    }
  }

  for (const pattern of PROTECTED_PATTERNS) {
    if (matchesPattern(normalizedPath, pattern)) {
      console.error('');
      console.error('╔══════════════════════════════════════════════════════════════╗');
      console.error('║           🔒 FILE PROTECTION GUARD — BLOCKED               ║');
      console.error('╠══════════════════════════════════════════════════════════════╣');
      console.error(`║  File:  ${call.filePath.padEnd(51)}║`);
      console.error(`║  Rule:  ${pattern.padEnd(51)}║`);
      console.error('║                                                              ║');
      console.error('║  This file is protected by hard constraint rules.             ║');
      console.error('║  See rules/08-constraints.md for context.                     ║');
      console.error('║                                                              ║');
      console.error('║  To allow: edit file-protection-guard.cjs PROTECTED_PATTERNS  ║');
      console.error('╚══════════════════════════════════════════════════════════════╝');
      console.error('');
      process.exit(2); // 必须 exit 2 才被 Hook 系统识别为"拦截"；exit 1 仅警告不阻断
    }
  }

  process.exit(0); // No match — allow
}

main();
