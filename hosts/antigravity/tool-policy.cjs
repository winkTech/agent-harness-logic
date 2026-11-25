'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {fileURLToPath} = require('node:url');

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && Boolean(value.trim());
const matlabTool = /^(?:mcp_.*_)?(evaluate_matlab_code|run_matlab_(?:test_)?file)$/i;

function validate(raw, event) {
  if (!record(raw)) throw new Error('Expected a hook payload object.');
  const session = raw.conversationId ?? raw.session_id ?? raw.sessionId;
  if (session !== undefined && (!nonempty(session) || Object.hasOwn(Object.prototype,session))) {
    throw new Error('Invalid hook session identifier.');
  }
  if (!['PreToolUse','PostToolUse'].includes(event)) return;
  const native = raw.toolCall !== undefined;
  const name = native ? raw.toolCall?.name : raw.tool_name;
  const args = native ? raw.toolCall?.args : raw.tool_input;
  if (!nonempty(name) || name !== name.trim() || !record(args)) throw new Error('Missing tool name or invalid argument object.');
  const paths = [args.Path,args.file_path,args.TargetFile,args.AbsolutePath].filter(v=>v!==undefined);
  const input = paths[0];
  if (['Read','Edit','Write','MultiEdit','read_file','edit_file','write_file','view_file','write_to_file',
    'replace_file_content','multi_replace_file_content'].includes(name) && (!nonempty(input) || paths.some(v=>v!==input))) {
    throw new Error('Missing or invalid file path.');
  }
  if (['run_command','Bash'].includes(name) && !nonempty(args.CommandLine ?? args.command)) throw new Error('Invalid command.');
  if (args.CommandLine !== undefined && args.command !== undefined && args.CommandLine !== args.command) {
    throw new Error('Conflicting tool arguments.');
  }
}

function execution(name, args) {
  if (name === 'Workflow' || name === 'run_workflow') {
    // Antigravity executes exactly one Python source or absolute script file.
    const absolute = value => nonempty(value) && !value.includes('\0') && path.isAbsolute(value)
      && (process.platform !== 'win32' || path.parse(value).root.length > 1);
    const {Script, ScriptPath, Cwd, Args, WaitMsBeforeAsync, Description} = args;
    if ((Script === undefined) === (ScriptPath === undefined)
        || (Script !== undefined && !nonempty(Script)) || (ScriptPath !== undefined && !absolute(ScriptPath))) {
      throw new Error('Workflow requires one inline Script or absolute ScriptPath.');
    }
    if ((Cwd !== undefined && !absolute(Cwd)) || (Args !== undefined && !record(Args))
        || (Description !== undefined && typeof Description !== 'string')
        || (WaitMsBeforeAsync !== undefined && (!Number.isInteger(WaitMsBeforeAsync) || WaitMsBeforeAsync < 0 || WaitMsBeforeAsync > 10000))) {
      throw new Error('Invalid workflow arguments.');
    }
    return {name:'Workflow', text:Script, script:ScriptPath, project:Cwd};
  }
  if (name === 'manage_task') {
    const action = args.Action ?? args.action;
    if (!nonempty(action) || (args.action && args.Action && args.Action !== args.action)) throw new Error('Invalid task action.');
    if (['status','list','kill'].includes(action)) return null;
    if (action !== 'send_input') throw new Error('Unrecognized terminal task action.');
    const text = args.Input ?? args.input;
    if (!nonempty(args.TaskId ?? args.task_id ?? args.taskId) || typeof text !== 'string') throw new Error('Invalid terminal input.');
    return {name:'terminal.send_input', text};
  }
  if (name === 'call_mcp_tool') {
    const tool = args.ToolName ?? args.tool_name ?? args.toolName;
    if (!nonempty(tool)) throw new Error('Missing MCP tool name.');
    name = tool;
    args = args.Arguments ?? args.arguments ?? {};
    if (!record(args)) throw new Error('Invalid MCP arguments.');
  }
  const match = matlabTool.exec(name);
  if (!match) return null;
  if (match[1].toLowerCase() === 'evaluate_matlab_code') {
    if (!nonempty(args.code ?? args.Code)) throw new Error('Missing MATLAB code.');
    if (args.project_path !== undefined && !nonempty(args.project_path)) throw new Error('Invalid MATLAB project path.');
    return {name:match[1], text:args.code ?? args.Code, project:args.project_path};
  }
  const script = args.script_path ?? args.scriptPath ?? args.test_file_path ?? args.file_path;
  if (!nonempty(script)) throw new Error('Missing MATLAB script path.');
  return {name:match[1], script};
}

function expandPath(input, cwd) {
  if (!nonempty(input) || input.includes('\0')) throw new Error('Invalid resource path.');
  let value = input.trim();
  if (/^file:/i.test(value)) value = fileURLToPath(value);
  value = value.replace(/^(?:~|%USERPROFILE%|\$env:USERPROFILE|\$HOME)(?=[\\/]|$)/i,os.homedir())
    .replace(/^\\\\\?\\UNC\\/i,'\\\\').replace(/^\\\\\?\\/,'');
  if (process.platform === 'win32' && /^[\\/](?![\\/])/.test(value)) return cwd ? path.resolve(cwd,value) : null;
  if (path.isAbsolute(value)) return path.normalize(value);
  return cwd ? path.resolve(cwd,value) : null;
}

function shellPath(value, dir) {
  if (!value || /^[-(]|\+|[,*?{}\x60]/.test(value)) return null;
  const literal = value.replace(/^(?:%USERPROFILE%|\$env:USERPROFILE|\$HOME)(?=[\\/]|$)/i,os.homedir());
  if (/[$%]/.test(literal)) return null;
  return expandPath(literal,dir);
}

function key(value) {
  return value.replace(/\\/g,'/').toLowerCase().replace(/:([^/]*)$/,'').replace(/[ .]+(?=\/|$)/g,'');
}

function pathForms(value) {
  const tail=[];
  let probe=value;
  while (true) {
    try { return [...new Set([key(value), key(path.join(fs.realpathSync.native(probe),...tail))])]; }
    catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; }
    const parent=path.dirname(probe);
    if (parent===probe) return [key(value)];
    tail.unshift(path.basename(probe));
    probe=parent;
  }
}

function sensitive(value) {
  return /(?:^|\/)(?:\.ssh(?:\/|$)|\.env(?:$|\.(?!example$|sample$|template$)[^/]+$)|[^/]*credential[^/]*(?:\/|$)|id_(?:rsa|dsa|ed25519|ecdsa)$)/i.test(value);
}

// Tokenize shell syntax outside quoted words. A wrapper command explicitly
// re-interprets its argument, so its command string is inspected separately.
function shellParts(code) {
  const commands = [];
  let words = [];
  const lexer = /[ \t\r]+|\n|(?:\d*>>?&\d+|\d*>>?)|&&|\|\||[|;&]|(?:(?:"(?:[^"]|"")*"|'(?:[^']|'')*'|[^"'\s|;&>])+)/gy;
  let match;
  while (lexer.lastIndex < code.length) {
    match = lexer.exec(code);
    if (!match) return null;
    const raw = match[0];
    if (/^[ \t\r]/.test(raw)) continue;
    if (/^(?:\n|&&|\|\||[;&|])$/.test(raw)) {
      if (words.length) commands.push(words);
      words = [];
      continue;
    }
    words.push({raw, value:raw.replace(/"([^"]*)"|'([^']*)'/g, (_, a, b) => a ?? b),
      redirect:/^\d*>>?/.test(raw)});
  }
  if (words.length) commands.push(words);
  return commands;
}

function optionValue(args, option) {
  const index = args.findIndex(value => option.test(value));
  return index < 0 ? undefined : args[index + 1];
}

const oneTarget = /^(?:set-content|add-content|out-file|tee-object|new-item|clear-content|rename-item)$/;
const manyTargets = /^(?:remove-item|del|erase|rm|rd|rmdir|touch|mkdir|tee)$/;
const scriptName = /\.(?:ps1|bat|cmd|sh|bash|py|js|mjs|cjs|vbs|wsf)$/i;
const gitMutation = /^(?:checkout|switch|restore|stash|clean|reset|apply|am|pull|merge|rebase|cherry-pick|revert|rm|mv|config|worktree)$/i;
const shellName = value => path.win32.basename(value).replace(/\.exe$/i,'').toLowerCase();
const fileAliases = new Map(Object.entries({
  ri:'remove-item', sc:'set-content', ac:'add-content', clc:'clear-content', cpi:'copy-item',
  mi:'move-item', ren:'rename-item', rni:'rename-item', ni:'new-item', sl:'set-location',
  chdir:'set-location', pushd:'push-location', popd:'pop-location', iwr:'invoke-webrequest',
  irm:'invoke-restmethod', rename:'rename-item', saps:'start-process', start:'start-process', icm:'invoke-command',
}));
// Inline runtimes have their own parsers. Treat known file mutation APIs as
// effectful even when the shell cannot establish an exact destination.
const runtimeWrite = /\b(?:write(?:File|FileSync|FileAtomic|FileAtomicSync|Stream|Sync|AllText|AllBytes|AllLines)?|append(?:File|FileSync|AllText|AllLines)?|createWriteStream|truncate(?:Sync)?|(?:copyFile|cp|rename|unlink|rm|rmdir|mkdir|link|symlink)(?:Sync)?|copy|copy2|copyfile|copytree|move|replace|remove|removedirs|rmtree|makedirs|touch|write_text|write_bytes|fopen|open(?:Sync)?)\s*\(/i;
const dotnetFile = /\[(?:System\.)?IO\.(?:File|FileInfo|Directory|DirectoryInfo|FileStream)\]\s*::\s*(\w*)/gi;
const dotnetRead = /^(?:exists|openread|readall(?:lines|text|bytes)(?:async)?|readlines(?:async)?|get(?:attributes|files|directories|filesystementries|creationtime(?:utc)?|last(?:access|write)time(?:utc)?)|enumerate(?:files|directories|filesystementries))$/i;
const review = () => ({decision:'force_ask',reason:'The effective write target or executable script requires review.'});
const protectedWrite = () => ({decision:'deny',reason:'Hook and verification files are protected.'});
const sensitiveRead = () => ({decision:'deny',reason:'Sensitive file access requires a manual operation.'});

// PowerShell accepts named arguments in any order. Keep option values out of
// positional target selection, and send unsupported binding forms for review.
function fileArguments(args) {
  const named = new Map(), positional = [];
  let ambiguous = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (/^-(?:path|literalpath|filepath|destination|destinationpath|newname|value|encoding|erroraction|filter|include|exclude|itemtype|width|stream|confirm)$/i.test(arg)) {
      const option = arg.toLowerCase();
      if (named.has(option) || !args[i+1] || args[i+1].startsWith('-')) ambiguous = true;
      named.set(option,args[++i]);
    } else if (/^-(?:force|recurse|append|noclobber|nonewline|passthru|verbose|whatif|container|confirm:\$(?:true|false))$/i.test(arg)) {
      continue;
    } else if (arg.startsWith('-')) ambiguous = true;
    else positional.push(arg);
  }
  return {path:named.get('-path') ?? named.get('-literalpath') ?? named.get('-filepath'),
    destination:named.get('-destination') ?? named.get('-destinationpath') ?? named.get('-newname'), positional, ambiguous};
}

function gitQuery(op, options) {
  if (op === 'stash') return /^(?:list|show)$/.test(options[0]);
  if (op === 'clean') return options.some(arg => /^--dry-run$|^-[A-Za-z]*n[A-Za-z]*$/.test(arg));
  if (op === 'worktree') return options[0] === 'list';
  if (op !== 'config') return false;
  const args = [];
  for (let i=0; i<options.length; i++) {
    const arg = options[i];
    if (/^(?:-f|--file|--blob|--type)$/.test(arg)) { i++; continue; }
    if (/^--(?:file|blob|type)=|^--(?:local|global|system|worktree|show-origin|show-scope|includes|null)$/.test(arg)) continue;
    args.push(arg);
  }
  if (args.some(arg => /^(?:set|unset|edit|--unset(?:-all)?|--edit|--add|--replace-all|--rename-section|--remove-section)$/.test(arg))) return false;
  return /^(?:get|list|-l|--list|--get(?:-all|-regexp|-urlmatch|-color|-colorbool)?)$/.test(args[0])
    || (args.length === 1 && /^[\w-]+\.[\w.-]+$/.test(args[0]));
}

function gitShowRevision(args, word) {
  if (!/^[\w][\w./-]*@\{\d+\}$/.test(word)) return false;
  let i = 0;
  while (i < args.length && args[i].startsWith('-C')) i += args[i] === '-C' ? 2 : 1;
  return args[i] === 'show' && args.indexOf(word) > i;
}

function protect(payload, capability, roots) {
  const {tool_name:name,tool_input:args}=payload;
  const base = Object.hasOwn(roots,'cwd') ? roots.cwd : payload.cwd;
  const work = capability?.project ?? args.Cwd ?? args.cwd;
  const cwd = work ? expandPath(work,base) : base;
  const targets = [__dirname, ...['core','hosts','var','.wright','settings.json','settings.local.json','AGENTS.md'].map(n=>path.join(roots.source,n)),
    path.join(os.homedir(),'.logical-paradox'), ...(roots.state===roots.source?[]:[roots.state]),
    process.env.HARNESS_VERIFY_GATE_STATE_FILE,process.env.HARNESS_SQLITE_PATH,process.env.HARNESS_VERIFICATION_LEDGER_FILE].filter(Boolean);
  let protectedKeys;
  function guarded(forms, includeParents = false) {
    protectedKeys ||= targets.flatMap(pathForms);
    return forms.some(value=>protectedKeys.some(root=>value===root || value.startsWith(root+'/')
      || (includeParents && root.startsWith(value.replace(/\/$/,'')+'/'))));
  }
  const deny = reason => ({decision:'deny',reason});
  const file = capability?.script || args.file_path || (name==='grep_search' ? args.SearchPath : null);
  if (file && (['Read','Edit','Write','MultiEdit','grep_search'].includes(name) || capability?.script)) {
    const absolute = expandPath(file,cwd);
    const forms = absolute ? pathForms(absolute) : [key(file)];
    if ((name==='Read' || name==='grep_search' || capability?.script) && forms.some(sensitive)) return sensitiveRead();
    if (['Edit','Write','MultiEdit'].includes(name)) {
      if (!absolute) return review();
      if (guarded(forms)) return protectedWrite();
    }
  }
  const code = name==='Bash'?args.command:capability?.text;
  if (!code) return null;
  if (/\bverification-gate\.cjs\b/i.test(code) && /(?:^|[\s'"])(?:--)?reset(?=$|[\s;|&'")])/i.test(code)) {
    return deny('Verification reset is reserved for manual operation.');
  }
  let verdict = null;
  function checkWrite(value, dir, tree = false) {
    if (verdict?.decision === 'deny') return;
    const absolute = shellPath(value,dir);
    if (!absolute) verdict = review();
    else if (guarded(pathForms(absolute),tree)) verdict = protectedWrite();
  }
  function checkRead(value, dir) {
    if (!value || /^(?:https?:\/\/|-)/i.test(value)) return;
    if (sensitive(key(value))) { verdict = sensitiveRead(); return; }
    if (!/[\\/.]/.test(value) || /[<>|\r\n"']/.test(value) || value.length > 4096) return;
    const absolute = shellPath(value,dir);
    if (absolute && pathForms(absolute).some(sensitive)) verdict = sensitiveRead();
  }
  function inspectWriterConstructor(text, cmd, args, rawArgs, dir) {
    if (cmd === 'new-object') {
      const type = optionValue(args, /^-typename$/i) ?? args[0];
      if (/^(?:System\.)?IO\.(?:StreamWriter|FileStream|FileInfo|DirectoryInfo)$/i.test(type)) {
        const list = args.findIndex(arg => /^-argumentlist$/i.test(arg));
        const first = rawArgs[(list < 0 ? args.indexOf(type) : list) + 1] ?? '';
        // PowerShell's comma separates constructor arguments only outside quotes.
        const operand = /^(?:"([^"$\x60]*)"|'([^']*)'|([^"',\s\x60]+))(?=,|$)/.exec(first);
        const dest = operand?.[1] ?? operand?.[2] ?? operand?.[3];
        checkRead(dest, dir);
        checkWrite(dest, dir, /\.DirectoryInfo$/i.test(type));
      } else if (/^(?:System\.)?Net\.WebClient$/i.test(type)) verdict ||= review();
    }
    // Keep offsets into the original command. Quoted examples and commas inside strings are data.
    const syntax = text.replace(/"(?:[^"\x60]|\x60[\s\S]|"")*"|'(?:[^']|'')*'/g, s => ' '.repeat(s.length));
    const constructor = /\[(?:System\.)?(IO\.StreamWriter|Net\.WebClient)\]\s*::\s*new\s*\(/gi;
    for (const match of syntax.matchAll(constructor)) {
      let offset = match.index + match[0].length;
      if (/webclient/i.test(match[1])) {
        const download = /^\s*\)\s*\.\s*DownloadFile(?:Async|TaskAsync)?\s*\([^(),;{}\r\n]*,/i.exec(syntax.slice(offset));
        if (!download) { verdict ||= review(); continue; }
        offset += download[0].length;
      }
      const literal = /^\s*(?:"([^"$\x60]*)"|'([^']*)')\s*(?=[,)])/.exec(text.slice(offset));
      checkWrite(literal?.[1] ?? literal?.[2], dir);
    }
  }
  function inspectRuntimeWrites(program, dir) {
    for (const match of program.matchAll(/(["'])(.+?)\1/g)) {
      checkRead(match[2],dir);
      checkWrite(match[2],dir);
    }
    verdict ||= review();
  }
  // Replace strings before inspecting calls. Markers preserve literal operands
  // while keeping program text in diagnostics, data and module names inert.
  function inspectInline(program, dir, python) {
    const literals = [];
    if (/[\x00-\x08]/.test(program)) { verdict ||= review(); return; }
    const tokens = python ? /#.*|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g
      : /\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/g;
    const code = program.replace(tokens, (token, offset) => {
      if (!/^["']/.test(token)) return ' ';
      const raw = token.slice(1,-1);
      const rawPython = python && /(?:^|\W)r$/i.test(program.slice(Math.max(0,offset-2),offset));
      const value = rawPython ? raw : /\\(?![\\"'])/.test(raw) ? undefined : raw.replace(/\\([\\"'])/g,'$1');
      checkRead(value ?? raw,dir);
      return '\x01' + (literals.push(value)-1) + '\x01';
    });
    // Template interpolation and malformed strings need the runtime parser.
    if (/["'\x60]/.test(code) || (python && /(?:^|\W)(?:f|fr|rf)\x01/i.test(code))) verdict ||= review();
    function literal(arg) {
      const match = /^(?:r)?\x01(\d+)\x01$/i.exec(arg || '');
      return match && literals[Number(match[1])];
    }
    function write(arg, tree) {
      const value = literal(arg);
      // A relative literal inside a runtime may follow an in-program chdir.
      // An absolute literal or a protected path in the supplied cwd is decisive.
      if (!value || !path.isAbsolute(value)) verdict ||= review();
      checkWrite(value,dir,tree);
    }
    const pathNames = new Set();
    if (python) {
      for (const declaration of code.matchAll(/\b(\w+)\s*(?:=\s*(?:\w+\.)?Path\s*\(|:\s*(?:\w+\.)?Path\b)/g)) {
        pathNames.add(declaration[1].toLowerCase());
      }
    }
    const calls = /\b([\w$]+(?:\s*\.\s*[\w$]+)*)\s*\(/g;
    for (const match of code.matchAll(calls)) {
      const parts = match[1].toLowerCase().split(/\s*\.\s*/);
      const method = parts.pop();
      if (!runtimeWrite.test(method+'(')) continue;
      const op = method.replace(/sync$/,'');
      if (!python && op === 'write' && /^process\.(?:stdout|stderr)$/.test(parts.join('.'))) continue;
      const receiver = python && /\bPath\(\s*((?:r)?\x01\d+\x01)\s*\)\s*\.\s*$/i.exec(code.slice(0,match.index));
      const pathVariable = parts.length === 1 && pathNames.has(parts[0]);
      // These bare method names also belong to ordinary strings/containers.
      if (/^(?:replace|append|copy|remove)$/.test(op) && !receiver && !pathVariable && !parts.some(p => /^(?:os|shutil|fs|fse|fsextra)$/.test(p))) {
        const imported = python && (!parts.length ? /\bfrom\s+(?:os|shutil)\s+import\b/.test(code)
          : [...code.matchAll(/\b(?:os|shutil)\s+as\s+(\w+)/gi)].some(m => m[1].toLowerCase() === parts[0]));
        if (!imported) continue;
      }
      const args = [];
      let depth = 0, start = match.index + match[0].length;
      for (let i=start; i<code.length; i++) {
        const ch = code[i];
        if ('([{'.includes(ch)) depth++;
        else if (')]}'.includes(ch) && depth) depth--;
        else if (!depth && (ch === ',' || ch === ')')) {
          args.push(code.slice(start,i).trim());
          if (ch === ')' || args.length === 2) break;
          start = i+1;
        }
      }
      if (/^(?:open|fopen)$/.test(op)) {
        const modeArg = receiver || pathVariable ? args[0] : args[1];
        const mode = modeArg ? literal(modeArg) : 'r';
        if (!mode) { verdict ||= review(); continue; }
        if (/^(?:r[bt]?|[bt]r|rs|sr|rtU)$/.test(mode)) continue;
      }
      if (receiver || pathVariable) {
        if (receiver) write(receiver[1],true);
        else verdict ||= review();
        if (/^(?:rename|replace)$/.test(op)) write(args[0],true);
      } else if (/^(?:write|write_text|write_bytes|touch)$/.test(op)) {
        // A stream or Path receiver determines the destination, not its data.
        verdict ||= review();
      } else if (/^(?:copy(?:2|file|tree)?|cp|link|symlink)$/.test(op)) write(args[1],true);
      else if (/^(?:rename|replace|move)$/.test(op)) { write(args[0],true); write(args[1],true); }
      else write(args[0],/^(?:rm|rmdir|rmtree|removedirs)$/.test(op));
    }
  }
  function inspect(command, dir, depth = 0) {
    const parts = depth < 5 && shellParts(command);
    if (!parts) { verdict ||= review(); return; }
    for (const words of parts) {
      if (verdict?.decision === 'deny') return;
      const args = [], rawArgs = [];
      for (let i=0; i<words.length; i++) {
        const token = words[i];
        if (token.redirect) {
          if (/&\d+$/.test(token.raw)) continue;
          const target = words[++i]?.value;
          if (!/^(?:\$null|nul|\/dev\/null)$/i.test(target || '')) checkWrite(target,dir);
        } else {
          args.push(token.value);
          rawArgs.push(token.raw);
        }
      }
      if (!args.length) continue;
      const invocation = rawArgs.shift();
      const executable = shellName(args.shift());
      const cmd = fileAliases.get(executable) || executable;
      // Escaped command names, command substitution and executable script
      // blocks can change the verb or its operands after lexical inspection.
      if (/[\x60^]/.test(invocation) || words.some(({raw}) => {
        const outsideSingle = raw.replace(/'(?:[^']|'')*'/g,'');
        return /\$\(/.test(outsideSingle) || (/[{}]/.test(outsideSingle.replace(/"(?:[^"]|"")*"/g,''))
          && !(cmd === 'git' && gitShowRevision(args, raw)));
      })) verdict ||= review();
      const shell = /^(?:cmd|pwsh|powershell|sh|bash)$/.test(cmd);
      const inside = shell ? args.findIndex(arg => /^(?:\/[ck]|-command|-c|-lc)$/i.test(arg)) : -1;
      if (inside >= 0) {
        const tail = rawArgs.slice(inside+1);
        const rawTail = tail.join(' ');
        const outer = rawTail[0];
        const quoted = (outer === '"' || outer === "'") && rawTail.at(-1) === outer;
        const nested = quoted ? rawTail.slice(1,-1) : rawTail;
        if (quoted && tail.length > 1) verdict ||= review();
        if (!nested) verdict ||= review();
        else inspect(nested,dir,depth+1);
        continue;
      }
      if (/^(?:cd|chdir|set-location|push-location|pushd|pop-location|popd)$/.test(cmd)) {
        const target = args.filter(arg => !/^(?:\/d|-literalpath|-path)$/i.test(arg))[0];
        dir = shellPath(target,dir);
        continue;
      }
      for (const arg of args) checkRead(arg,dir);
      if (/^(?:node(?:js)?|py|python(?:\d+(?:\.\d+)?)?|ruby|perl)$/.test(cmd)) {
        const inline = optionValue(args,/^(?:-e|-c|--eval|--print|-p)$/)
          ?? args.find(arg => /^--(?:eval|print)=/.test(arg))?.replace(/^--(?:eval|print)=/,'');
        if (inline) {
          if (/^(?:node(?:js)?|py|python(?:\d+(?:\.\d+)?)?)$/.test(cmd)) {
            inspectInline(inline,dir,!cmd.startsWith('node'));
            continue;
          }
          for (const match of inline.matchAll(/(["'])(.*?)\1/g)) checkRead(match[2],dir);
          if (runtimeWrite.test(inline)) inspectRuntimeWrites(inline,dir);
        }
      }
      const shellText = words.map(({raw}) => raw).join(' ');
      if (cmd === 'new-object' || /streamwriter|webclient/i.test(shellText)) {
        inspectWriterConstructor(shellText, cmd, args, rawArgs, dir);
      }
      if (shellText.includes('::')) {
        const calls = [...shellText.replace(/(["']).*?\1/g,'').matchAll(dotnetFile)];
        if (calls.some(call => !dotnetRead.test(call[1]))) inspectRuntimeWrites(shellText,dir);
        else if (calls.length) {
          for (const match of shellText.matchAll(/(["'])(.*?)\1/g)) checkRead(match[2],dir);
        }
      }
      const positional = args.filter(arg => !arg.startsWith('-') && !/^\/[a-z][a-z0-9:-]*$/i.test(arg));
      if (oneTarget.test(cmd) || /^(?:remove-item|move-item|copy-item|expand-archive)$/.test(cmd)) {
        const files = fileArguments(args);
        if (files.ambiguous) verdict ||= review();
        if (/^(?:copy-item|expand-archive)$/.test(cmd)) {
          checkWrite(files.destination ?? files.positional[files.path ? 0 : 1],dir,true);
        } else if (/^(?:remove-item|move-item)$/.test(cmd)) {
          const paths = [files.path, files.destination, ...files.positional].filter(Boolean);
          if (!paths.length) verdict ||= review();
          for (const target of paths) checkWrite(target,dir,true);
        } else if (cmd === 'rename-item') {
          const from = files.path ?? files.positional[0];
          const to = files.destination ?? files.positional[files.path ? 0 : 1];
          const absolute = shellPath(from,dir);
          checkWrite(from,dir,true);
          checkWrite(to,absolute ? path.dirname(absolute) : null,true);
        } else {
          checkWrite(files.path ?? files.positional[0],dir);
        }
      } else if (manyTargets.test(cmd) || /^(?:mv|move)$/.test(cmd) || (cmd === 'sed' && args.some(arg=>arg.startsWith('-i')))) {
        if (!positional.length) verdict ||= review();
        for (const target of positional) checkWrite(target,dir,true);
      } else if (/^(?:robocopy|xcopy|copy|cp)$/.test(cmd)) {
        const dest = optionValue(args,/^(?:-t|--target-directory)$/) ?? args.find(arg=>arg.startsWith('--target-directory='))?.split('=').slice(1).join('=') ??
          (cmd === 'robocopy' ? positional[1] : positional.length > 1 ? positional.at(-1) : undefined);
        checkWrite(dest,dir,true);
      } else if (cmd === 'tar' && args.some(arg => /^--extract$|^-?[a-z]*x[a-z]*$/i.test(arg))) {
        const dest = optionValue(args,/^(?:-C|--directory)$/) ?? args.find(arg=>arg.startsWith('--directory='))?.slice(12);
        checkWrite(dest ?? '.',dir,true);
      } else if (/^(?:curl|wget|invoke-webrequest|invoke-restmethod)$/.test(cmd)) {
        let prefix = cmd === 'wget' ? (optionValue(args,/^(?:--directory-prefix|-P)$/) ??
          args.find(arg=>arg.startsWith('--directory-prefix='))?.slice('--directory-prefix='.length)) : undefined;
        const destinations = [];
        let remoteName = false;
        function finishTransfer() {
          const outputDir = prefix === undefined ? dir : shellPath(prefix,dir);
          for (const {dest, transferOutput} of destinations) {
            if (dest === '-') continue;
            checkWrite(dest,transferOutput ? outputDir : dir);
            if (cmd === 'wget' && prefix !== undefined) checkWrite(dest,dir);
          }
          if ((!destinations.length && cmd === 'wget') || remoteName) checkWrite('.',outputDir,true);
          destinations.length = 0;
          prefix = undefined;
          remoteName = false;
        }
        for (let i=0; i<args.length; i++) {
          const arg = args[i];
          let dest;
          let transferOutput = true;
          if (cmd === 'curl' && arg === '--') break;
          if (cmd === 'curl' && arg === '--next') {
            finishTransfer();
          } else if (cmd === 'curl' && /^-[^-]/.test(arg)) {
            // A value-taking option consumes the rest of the cluster or the
            // next argument, even if that value looks like another option.
            for (let j=1; j<arg.length; j++) {
              const opt = arg[j];
              if (opt === ':') { finishTransfer(); continue; }
              if (opt === 'O') { remoteName = true; continue; }
              if ('012346#aBfgGIijkJlLMnNpqRsSvVZ'.includes(opt)) continue;
              if (!'oDcAEKCbdFHPmuxUQreXYytzTwh'.includes(opt)) { verdict ||= review(); break; }
              const value = arg.slice(j+1) || args[++i] || '';
              if ('oDc'.includes(opt)) {
                dest = value;
                transferOutput = opt === 'o';
              }
              break;
            }
          } else if (cmd === 'curl' && /^(?:--remote-name|--remote-name-all)$/.test(arg)) {
            remoteName = true;
          } else if (cmd === 'curl' && /^--output-dir(?:=|$)/.test(arg)) {
            prefix = arg === '--output-dir' ? args[++i] ?? '' : arg.slice('--output-dir='.length);
          } else if (cmd === 'curl' && /^(?:--user-agent|--header|--request|--referer|--proxy|--user|--data|--form|--write-out|--url)$/.test(arg)) {
            i++;
          } else if (cmd === 'curl' && /^--(?:trace(?:-ascii)?|stderr)(?:=|$)/.test(arg)) {
            // Diagnostic sinks are process-wide. --output-dir only redirects transfer output.
            const equals = arg.indexOf('=');
            const sink = equals === -1 ? args[++i] : arg.slice(equals+1);
            if (sink !== '-' && !(sink === '%' && arg.startsWith('--trace'))) checkWrite(sink,dir);
          } else if (/^(?:-o|--output|--dump-header|-D|--output-document|--output-file|--cookie-jar)$/.test(arg) ||
              (cmd === 'wget' && arg === '-O') || /^-outfile$/i.test(arg)) dest = args[++i] ?? '';
          else if (/^--(?:output|dump-header|output-document|output-file|cookie-jar)=/.test(arg)) dest = arg.slice(arg.indexOf('=')+1);
          else if (/^-outfile:/i.test(arg)) dest = arg.slice(9);
          else {
            const compact = cmd === 'wget' ? /^-[qvNck]*[Oo](.*)$/.exec(arg) : null;
            if (compact) dest = compact[1] || args[++i] || '';
          }
          if (dest !== undefined) destinations.push({dest, transferOutput:transferOutput && !/^--(?:dump-header|cookie-jar)(?:=|$)/.test(arg)});
        }
        finishTransfer();
      } else if (cmd === 'git') {
        let repo = dir, i = 0;
        while (i < args.length && args[i].startsWith('-')) {
          if (args[i] === '-C') repo = shellPath(args[++i],repo);
          else if (args[i].startsWith('-C')) repo = shellPath(args[i].slice(2),repo);
          else if (args[i] === '-c') i++;
          else if (/^--(?:git-dir|work-tree)(?:=|$)/.test(args[i])) { repo = null; if (!args[i].includes('=')) i++; }
          i++;
        }
        const op = args[i], options = args.slice(i+1);
        if (gitMutation.test(op) && !gitQuery(op,options)) {
          if (op === 'config') {
            const file = optionValue(options,/^(?:--file|-f)$/) ?? options.find(arg=>arg.startsWith('--file='))?.slice(7);
            if (file !== undefined) checkWrite(file,repo);
          }
          if (op === 'worktree') for (const arg of options.slice(1).filter(arg=>!arg.startsWith('-'))) checkWrite(arg,repo,true);
          // Worktree-wide operations can reach siblings of a -C subdirectory.
          const withinSource = repo && pathForms(repo).some(value => pathForms(roots.source).some(root => value === root || value.startsWith(root + '/')));
          checkWrite(withinSource ? roots.source : repo,null,true);
        }
      } else if (scriptName.test(cmd) || /^[$%(.]/.test(cmd) || /^(?:source|call|eval|invoke-expression|iex|start-process|invoke-command|wsl)$/.test(cmd)
          || (shell && !args.every(arg => /^(?:-+version|-+help|-v|\/\?)$/i.test(arg)))) {
        verdict ||= review();
      } else if (/^(?:if|for|foreach|foreach-object|while|try|do|switch|function|sudo|env|exec|command)$/.test(cmd)
          && args.some(arg => oneTarget.test(arg.toLowerCase()) || manyTargets.test(arg.toLowerCase())
            || /^(?:move-item|copy-item|expand-archive|cmd|pwsh|powershell|bash|sh|robocopy|xcopy|tar)$/i.test(arg)
            || scriptName.test(arg) || gitMutation.test(arg))) {
        // Scope and bindings inside compound statements and external launchers
        // cannot be inferred from a list of shell words.
        verdict ||= review();
      } else if (/\b(?:writeFile(?:Sync)?|unlink(?:Sync)?|fopen|write_text|write_bytes|open)\s*\(/i.test(command)) {
        // Runtime code is opaque to the shell. Escalate its file writes;
        // known literal protected paths can still receive a definitive denial.
        for (const arg of [command,...args]) inspectRuntimeWrites(arg,dir);
      }
    }
  }
  inspect(code,cwd);
  return verdict;
}

function verifyReadable(file) {
  let value;
  try { value=JSON.parse(fs.readFileSync(file,'utf8')); }
  catch(error) { if(error.code==='ENOENT') return; throw new Error('Verification state cannot be read.'); }
  if(!record(value) || !(value.version>=2 ? record(value.pending) && Object.values(value.pending).every(record) : typeof value.edited==='boolean')) {
    throw new Error('Verification state has an invalid format.');
  }
}

module.exports={validate,execution,protect,verifyReadable,record};
