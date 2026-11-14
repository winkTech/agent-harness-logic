#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const os = require('os');

fs.writeFileSync(path.join(os.tmpdir(), 'claude-hook-debug.txt'),
  JSON.stringify({
    time: new Date().toISOString(),
    argv: process.argv,
    cwd: process.cwd(),
    env_HOME: process.env.HOME,
    env_USERPROFILE: process.env.USERPROFILE,
    hasStdin: !process.stdin.isTTY,
    stdioMode: 'initialized'
  }, null, 2));
process.exit(0);
