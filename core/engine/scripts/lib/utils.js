'use strict';

/**
 * engine/scripts/lib/utils.js — 基础工具函数库
 *
 * 供 ecc-runner 等脚本需要的通用工具函数。
 * 该文件的存在标志 ECC 插件根目录的合法性。
 */

const path = require('node:path');
const fs = require('node:fs');
const { HARNESS_ROOT } = require('./harness-root.cjs');

/** 安全读取 JSON 文件 */
function safeReadJSON(filePath, fallback = null) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch { /* 静默降级 */ }
  return fallback;
}

/** 确保目录存在 */
function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
  return dirPath;
}

/** 获取 .claude 目录路径 */
function getClaudeDir() {
  return HARNESS_ROOT;
}

module.exports = { safeReadJSON, ensureDir, getClaudeDir };
