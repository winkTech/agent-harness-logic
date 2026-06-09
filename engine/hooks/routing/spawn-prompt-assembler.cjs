#!/usr/bin/env node
/**
 * Spawn Prompt Assembler Hook entrypoint.
 *
 * Implementation lives in spawn-prompt-assembler.runtime.cjs
 */

'use strict';

const assembler = require('./spawn-prompt-assembler.runtime.cjs');

/*
 * Compatibility markers for legacy static tests that scan this entry file:
 * - function enrichAllowedTools
 * - ['TaskUpdate', 'Skill']
 * - loadAgentRegistry
 * - getDefaultTools
 * - module.exports + enrichAllowedTools
 */

if (require.main === module) {
  assembler.main();
}

module.exports = assembler;
