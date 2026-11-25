'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawnSync} = require('node:child_process');
const baseline = require('./security-probes.baseline.json');
const source = require('./resolve-root.cjs').resolveHarnessRoot(__dirname).root;

function fixture(t, launchFromPlugin = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-tool-policy-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true, maxRetries:4, retryDelay:150}));
  const cwd = path.join(dir, 'work');
  const state = path.join(dir, 'state');
  const gate = path.join(state, 'var', 'verify-gate.json');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.dirname(gate), {recursive:true});
  function invoke(event, body, extra = {}) {
    const result = spawnSync(process.execPath, ['--no-warnings', path.join(__dirname,'bridge.cjs'), event], {
      input: typeof body === 'string' ? body : JSON.stringify({conversationId:'policy-review', cwd, ...body}),
      encoding:'utf8', cwd:launchFromPlugin ? __dirname : cwd, windowsHide:true, timeout:20000, env: {...process.env, HARNESS_ROOT:source,
        HARNESS_STATE_DIR:state, PLUGIN_DATA:state, HARNESS_VERIFY_GATE_STATE_FILE:gate,
        HARNESS_SQLITE_PATH:path.join(state,'test.db'), HARNESS_VERIFICATION_LEDGER_FILE:path.join(state,'ledger.jsonl'), ...extra}
    });
    assert.ifError(result.error);
    return {output: JSON.parse(result.stdout), status:result.status, stderr:result.stderr};
  }
  function count() {
    if (!fs.existsSync(gate)) return 0;
    return Object.values(JSON.parse(fs.readFileSync(gate,'utf8')).pending || {}).reduce((sum,e)=>sum+e.editCount,0);
  }
  return {cwd,state,gate,invoke,count};
}

function call(name,args,id) { return {toolCall:{name,args,id}}; }
const terminal = call('manage_task',{Action:'send_input',TaskId:'fixture',Input:'echo fixture'},'terminal');
const matlab = call('call_mcp_tool',{ServerName:'matlab',ToolName:'evaluate_matlab_code',Arguments:{code:'disp(1)'}},'matlab');
function surface(f) {
  const golden = path.join(f.cwd,'golden_model','ref_top','ref_top.sv');
  return [call('write_file',{Path:golden,Content:'# fixture'}), call('edit_file',{Path:golden,Target:'x',Replacement:'y'}),
    call('read_file',{Path:path.join(f.cwd,'.ssh','id_rsa')}), call('read_file',{Path:path.join(f.cwd,'.env')}),
    call('write_file',{Path:path.join(__dirname,'hooks.json')}), call('edit_file',{Path:path.join(__dirname,'bridge.cjs')}),
    call('write_file',{Path:path.join(source,'core','engine','scripts','hooks','bash-safety-guard.cjs')}),
    call('write_file',{Path:f.gate}), matlab, call('mcp_logical-paradox_matlab_evaluate_matlab_code',{code:'disp(2)'},'direct'), terminal];
}

test('invalid input, unavailable engine and unreadable verification state deny with a protocol response', t=>{
  const f=fixture(t);
  for(const body of ['{','null','[]','{}',call('run_command','{}'),call('run_command',{}),call('write_file',{Path:42}),call('call_mcp_tool',{})]) {
    assert.equal(f.invoke('PreToolUse',body).output.decision,'deny');
  }
  assert.equal(f.invoke('PreToolUse',matlab,{HARNESS_ROOT:path.join(f.cwd,'missing')}).output.decision,'deny');
  fs.writeFileSync(f.gate,'{');
  assert.equal(f.invoke('PreToolUse',matlab).output.decision,'deny');
  for (const repeated of [false,true]) {
    const result = f.invoke('Stop',{continuationActive:repeated},{HARNESS_NO_PERSIST:'1',HARNESS_RISK_POLICY_MODE:''});
    assert.equal(result.output.decision,'allow','read-only Stop cannot persist a continuation receipt');
    assert.match(result.output.reason,/unverified/i);
  }
  assert.equal(f.invoke('Stop',{terminationReason:'USER_CANCELED'}).output.decision,'allow');
  assert.equal(fs.readFileSync(f.gate,'utf8'),'{');
});

test('outside-project hooks keep host paths distinct from the plugin process directory', t=>{
  const f=fixture(t,true);
  const probe = command => f.invoke('PreToolUse',{cwd:undefined,workspacePaths:[],
    ...call('run_command',{CommandLine:command})}).output.decision;
  assert.equal(probe('Get-ChildItem "'+__dirname+'" 2>$null'),'allow');
  assert.equal(probe('Remove-Item -LiteralPath "'+path.join(f.cwd,'scratch.txt')+'"'),'allow');
  assert.equal(probe('node -e "console.log([1].map(n => n + 1))"'),'allow');
  const policyFile = path.join(__dirname,'tool-policy.cjs').split(path.sep).join('/');
  const scratch = path.join(f.cwd,'scratch').split(path.sep).join('/');
  assert.equal(probe(`node -e "require('${policyFile}'); console.log('fixture.replace(')"`),'allow');
  assert.equal(probe(`node -e "require('${policyFile}'); fs.mkdirSync('${scratch}')"`),'allow');
  assert.equal(probe('git show HEAD@{1}'),'allow');
  assert.equal(probe('Get-ChildItem | Where-Object { $_.Length -gt 0 }'),'force_ask');
  assert.equal(probe('Set-Content relative.txt value'),'force_ask');
  assert.equal(probe('pwsh -File inspect.ps1'),'force_ask');
  assert.equal(probe('git -C "'+source+'" restore -- core/fixture.txt'),'deny');
  assert.equal(f.count(),0);
});

test('read-only paths and successful absolute test files outside a workspace produce no false advisory', t=>{
  const f=fixture(t,true);
  const run=(event,body) => f.invoke(event,{...body,cwd:undefined,workspacePaths:[]});
  for (const file of [path.join(source,'core/engine/scripts/lib/verification-state.cjs'),path.join(f.cwd,'golden','sample.py')]) {
    assert.equal(run('PreToolUse',call('read_file',{Path:file})).output.decision,'allow');
  }
  const testFile=path.join(f.cwd,'example.test.cjs');
  fs.writeFileSync(testFile, "require('node:test')('sample', () => {});\n");
  const env={...process.env};
  delete env.NODE_TEST_CONTEXT; // Start a distinct test invocation with its normal reporter.
  const output=spawnSync(process.execPath,['--test','--test-reporter=tap',testFile],{env,cwd:__dirname,encoding:'utf8',windowsHide:true});
  assert.equal(output.status,0);
  assert.match(output.stdout,/# pass 1/);
  const tool=call('run_command',{CommandLine:'node --test "'+testFile+'"'},'absolute-test');
  assert.equal(run('PreToolUse',tool).output.decision,'allow');
  const post=run('PostToolUse',{...tool,exitCode:output.status,stdout:output.stdout});
  assert.equal(post.status,0);
  assert.doesNotMatch(post.stderr,/verification result rejected/);
  const bridgeFile=path.join(f.state,'var','antigravity-bridge.json');
  const queued=fs.existsSync(bridgeFile) ? JSON.parse(fs.readFileSync(bridgeFile)).sessions['policy-review']?.pendingContexts : [];
  assert.doesNotMatch(JSON.stringify(queued || []),/Risk R2: read-only|verification result rejected/);
  assert.equal(f.count(),0);
});

test('execution requires review, denial makes no entry and delivered post marks the project pending', t=>{
  const f=fixture(t);
  for(const body of [matlab,terminal,call('mcp__matlab__run_matlab_file',{script_path:path.join(f.cwd,'test.m')},'script'),
    call('mcp__matlab__run_matlab_test_file',{script_path:path.join(f.cwd,'test.m')},'test')]) {
    const before=f.count();
    assert.equal(f.invoke('PreToolUse',body).output.decision,'force_ask');
    assert.equal(f.count(),before);
    assert.equal(f.invoke('PostToolUse',{...body,status:'not_started'}).status,0);
    assert.equal(f.count(),before);
    assert.equal(f.invoke('PostToolUse',body).status,0);
    assert.equal(f.count(),before+1);
    assert.equal(f.invoke('PostToolUse',body).status,0);
    assert.equal(f.count(),before+1,'a replay must not reopen or increment the same edit');
  }
  assert.equal(f.invoke('PreToolUse',call('run_command',{CommandLine:'python run_app.py'})).output.decision,'deny');
});

test('workflow execution requests review and registers only its effective projects after dispatch', t=>{
  const f=fixture(t);
  const project=path.join(path.dirname(f.cwd),'project');
  const library=path.join(path.dirname(f.cwd),'library');
  const worktree=path.join(path.dirname(f.cwd),'worktree');
  for (const dir of [f.cwd,project,library,worktree]) fs.mkdirSync(path.join(dir,'.git'),{recursive:true});
  const script=path.join(library,'saved.py');
  const inline={Script:'log("workflow fixture")', Description:'Fixture', Args:{label:'demo'}, WaitMsBeforeAsync:0};
  for(const args of [{}, {ScriptPath:'relative.py'}, {Script:' '}, {ScriptPath:script,Script:inline.Script},
    {...inline,Cwd:'relative'}, {...inline,Args:'[]'}, {...inline,WaitMsBeforeAsync:-1}]) {
    assert.equal(f.invoke('PreToolUse',call('run_workflow',args,'bad')).output.decision,'deny');
  }
  const spool=path.join(f.state,'workflow-spool');
  const invoke=(event, tool, fields={})=>f.invoke(event,{workspacePaths:[project],...tool,...fields},
    {HARNESS_TELEMETRY_SPOOL_DIR:spool});
  const tool=call('run_workflow', inline, 'inline');
  const pending=()=>Object.values(JSON.parse(fs.readFileSync(f.gate,'utf8')).pending);
  assert.equal(invoke('PreToolUse',tool).output.decision,'force_ask');
  invoke('PostToolUse',tool,{executed:false});
  invoke('PostToolUse',tool,{status:'canceled_before_dispatch'});
  assert.equal(f.count(),0);
  for(let i=0;i<2;i++) assert.equal(invoke('PostToolUse',tool,{status:'running'}).status,0);
  assert.deepEqual(pending().map(entry=>entry.projectRoot),[project]);
  assert.equal(f.count(),1);
  const saved={tool_name:'Workflow',tool_input:{ScriptPath:script,Cwd:worktree},step_index:18};
  assert.equal(invoke('PreToolUse',saved).output.decision,'force_ask');
  for(let i=0;i<2;i++) assert.equal(invoke('PostToolUse',saved,{error:'fixture script raised after dispatch'}).status,0);
  assert.deepEqual(new Set(pending().map(entry=>entry.projectRoot)),new Set([worktree,project,library]));
  assert.equal(f.count(),3);
  assert.equal(invoke('PreToolUse',call('run_workflow',{ScriptPath:path.join(library,'.env'),file_path:script},'sensitive')).output.decision,'deny');
  assert.notEqual(invoke('PostToolUse',call('run_workflow',{Script:4},'bad')).status,0);
  assert.equal(f.count(),3);
  const events=fs.readdirSync(spool).flatMap(name=>fs.readFileSync(path.join(spool,name),'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(events.filter(e=>e.type==='tool.post' && e.toolName==='Workflow').length,2);
});

test('project verification follows sessions, shell cwd and subagents, and isolates overlapping edits', t=>{
  const f = fixture(t);
  const other = path.join(path.dirname(f.cwd),'sibling');
  fs.mkdirSync(other);
  const shell = (event, session, project, command, id, fields={}) => f.invoke(event,{
    conversationId:session, ...call('run_command',{CommandLine:command,Cwd:project},id), ...fields
  }).output;
  const decision = (session,project) => shell('PreToolUse',session,project,'python run_app.py','build').decision;
  const edit = (session,project,file) => {
    const event = {...call('write_file',{Path:path.join(project,file),Content:'# test'}),conversationId:session,cwd:project};
    assert.equal(f.invoke('PostToolUse',event).status,0);
  };
  const verify = (when,session,project,id,fields) => shell(when,session,project,'pytest -q',id,fields);
  const pass = {exitCode:0,stdout:'1 passed in 0.2s'};
  edit('parent',f.cwd,'a.py');
  assert.equal(decision('new-session',f.cwd),'deny');
  assert.equal(decision('subagent',f.cwd),'deny');
  assert.equal(decision('parent',other),'allow');
  edit('parent',other,'b.py');
  assert.equal(verify('PreToolUse','subagent',f.cwd,'first').decision,'allow');
  edit('concurrent',f.cwd,'late.py');
  verify('PostToolUse','subagent',f.cwd,'first',pass);
  assert.equal(decision('new-session',f.cwd),'deny');
  verify('PreToolUse','new-session',f.cwd,'retry');
  verify('PostToolUse','new-session',f.cwd,'retry',{exitCode:1,stderr:'test failed'});
  assert.equal(decision('parent',f.cwd),'deny');
  verify('PreToolUse','subagent',f.cwd,'fresh');
  verify('PostToolUse','subagent',f.cwd,'fresh',pass);
  assert.equal(decision('parent',f.cwd),'allow');
  assert.equal(decision('subagent',other),'deny');
  const prefix = 'cd "' + other + '" && ';
  assert.equal(shell('PreToolUse','parent',f.cwd,prefix+'python run_app.py','via-cd').decision,'deny');
  const unconditional = 'Set-Location -LiteralPath "' + other + '"; ';
  assert.equal(shell('PreToolUse','parent',f.cwd,'sl "'+other+'"; python run_app.py','via-alias').decision,'deny');
  assert.equal(shell('PreToolUse','parent',f.cwd,unconditional+'python run_app.py','via-semi').decision,'deny');
  shell('PostToolUse','subagent',f.cwd,unconditional+'pytest -q','uncertain',pass);
  assert.equal(decision('parent',other),'deny','a semicolon does not prove that the directory change succeeded');
  edit('parent',f.cwd,'untested.py');
  shell('PreToolUse','subagent',f.cwd,prefix+'pytest -q','other-test');
  shell('PostToolUse','subagent',f.cwd,prefix+'pytest -q','other-test',pass);
  assert.equal(decision('parent',other),'allow');
  assert.equal(decision('parent',f.cwd),'deny');
});

test('old receipts survive upgrade and a nested repository verifies independently', t=>{
  const f = fixture(t);
  const nested = path.join(f.cwd,'nested');
  fs.mkdirSync(path.join(f.cwd,'.git'));
  fs.mkdirSync(path.join(nested,'.git'),{recursive:true});
  const now = new Date().toISOString();
  // Older releases could combine multiple files in the same volume-root row.
  fs.writeFileSync(f.gate, JSON.stringify({version:4, pending:{old:{
    projectRoot:path.parse(f.cwd).root, sessionId:'old-writer', lastEditTime:now, editCount:2,
    files:[path.join(f.cwd,'parent.py'),path.join(nested,'child.py')]
  }}}));
  const hook = (event, cwd, command, id, fields={}) => f.invoke(event,{
    conversationId:'new-verifier',cwd,...call('run_command',{CommandLine:command},id),...fields
  }).output;
  const check = cwd => hook('PreToolUse',cwd,'python run_app.py','run').decision;
  assert.equal(check(f.cwd),'deny');
  assert.equal(check(nested),'deny');
  hook('PreToolUse',nested,'pytest -q','verify-nested');
  hook('PostToolUse',nested,'pytest -q','verify-nested',{exitCode:0,stdout:'1 passed in 0.2s'});
  assert.equal(check(nested),'allow');
  assert.equal(check(f.cwd),'deny');
});

test('sibling folders in a declared markerless workspace share edits', t=>{
  const f = fixture(t);
  const src = path.join(f.cwd,'src');
  const tests = path.join(f.cwd,'tests');
  fs.mkdirSync(src);
  fs.mkdirSync(tests);
  const send = (event,session,cwd,tool,fields={}) => f.invoke(event,{
    cwd,workspacePaths:[f.cwd],conversationId:session,...tool,...fields
  });
  assert.equal(send('PostToolUse','editor',src,call('write_file',{Path:path.join(src,'a.py')})).status,0);
  const app = call('run_command',{CommandLine:'python run_app.py'});
  const verify = call('run_command',{CommandLine:'pytest -q'},'verify');
  assert.equal(send('PreToolUse','child',tests,app).output.decision,'deny');
  assert.equal(send('PreToolUse','child',tests,verify).output.decision,'allow');
  assert.equal(send('PostToolUse','child',tests,verify,{exitCode:0,stdout:'1 passed'}).status,0);
  assert.equal(send('PreToolUse','editor',src,app).output.decision,'allow');
});

test('normal controls, protected paths, junctions, and reset',t=>{
  const f=fixture(t);
  assert.equal(f.invoke('PreToolUse',call('run_command',{CommandLine:'Write-Output LP_REVIEW_CHECK'})).output.decision,'allow');
  const alias=path.join(f.cwd,'linked');
  fs.symlinkSync(__dirname,alias,'junction');
  for(const body of [call('write_file',{Path:path.join(alias,'new.cjs')}),call('read_file',{Path:'.env.local'}),
    call('run_command',{CommandLine:'Set-Content "'+f.gate+'" fixture'}),
    call('view_file',{AbsolutePath:path.join(f.cwd,'.ssh','fixture')}),
    call('write_to_file',{TargetFile:path.join(__dirname,'hooks.json')}),
    call('multi_replace_file_content',{TargetFile:f.gate}),
    call('run_command',{CommandLine:'node verification-gate.cjs reset'}),
    call('run_command',{CommandLine:'node verification-gate.cjs --reset'}),
    call('manage_task',{...terminal.toolCall.args,Input:'node verification-gate.cjs --reset'})]) {
    assert.equal(f.invoke('PreToolUse',body).output.decision,'deny');
  }
  for(const body of [call('read_file',{Path:'README.md'}),call('manage_task',{Action:'status',TaskId:'fixture'})]) {
    assert.equal(f.invoke('PreToolUse',body).output.decision,'allow');
  }
});

test('host matcher covers executable aliases and leaves ordinary read posts off the hot path',()=>{
  const config=require('./hooks.json')['logical-paradox'];
  const matcher=new RegExp('^(?:'+config.PostToolUse[0].matcher+')$');
  for(const name of ['call_mcp_tool','manage_task','mcp__matlab__run_matlab_file',
    'mcp_logical-paradox_matlab_evaluate_matlab_code','run_matlab_test_file','write_to_file','run_command','run_workflow','Workflow']) {
    assert.ok(matcher.test(name),name);
  }
  assert.equal(matcher.test('read_file'),false);
});

test('failed execution registers both declared projects, while a malformed post preserves state',t=>{
  const f=fixture(t);
  fs.mkdirSync(path.join(f.cwd,'.git'));
  const other=path.join(path.dirname(f.cwd),'other');
  fs.mkdirSync(path.join(other,'.git'),{recursive:true});
  const body=call('evaluate_matlab_code',{code:'disp(3)',project_path:other},'cross-project');
  assert.equal(f.invoke('PostToolUse',{...body,error:'fixture runtime error'}).status,0);
  const entries=Object.values(JSON.parse(fs.readFileSync(f.gate,'utf8')).pending);
  assert.deepEqual(new Set(entries.map(e=>e.projectRoot.toLowerCase())),new Set([f.cwd,other].map(v=>v.toLowerCase())));
  assert.notEqual(f.invoke('PostToolUse','{').status,0);
  assert.equal(f.count(),2);
});

test('38 original probe categories record four independent observations', t=>{
  const f=fixture(t);
  const archive=process.env.LP_AUDIT_BASELINE || path.join(os.homedir(),'.gemini','antigravity','brain',
    '731450f6-07c3-4ff0-9ca8-642138f4c4b5','.system_generated','tasks','task-464.log');
  if(!fs.existsSync(archive)) return t.skip('historical probe archive unavailable in clean-room checkout');
  const raw=fs.readFileSync(archive,'utf8');
  const original=JSON.parse(raw.slice(raw.indexOf('{'),raw.lastIndexOf('}')+1));
  const inputs=original.shellBypass;
  assert.equal(inputs.length,27);
  const toolInputs=surface(f);
  assert.deepEqual(original.toolSurface.map(probe=>probe.label),baseline.tool.map(probe=>probe.label));
  const cases=[...baseline.shell.map((row,i)=>{
    assert.equal(crypto.createHash('sha256').update(inputs[i].cmd).digest('hex'),row.sha256,row.id);
    return [row,call('run_command',{CommandLine:inputs[i].cmd})];
  }), ...baseline.tool.map((row,i)=>[row,toolInputs[i]])];
  const rows=[];
  for(const [row,body] of cases) {
    const before=f.count();
    const response=f.invoke('PreToolUse',body);
    assert.equal(response.status,0,row.id);
    const hookDecision=response.output.decision;
    const afterPre=f.count();
    let stateRegistration='no new pending entry';
    if(row.expected==='force_ask' && hookDecision==='force_ask') {
      assert.equal(f.invoke('PostToolUse',body).status,0,row.id);
      stateRegistration=f.count()===before+1?'pending after simulated PostToolUse':'missing after simulated PostToolUse';
    }
    rows.push({id:row.id,label:row.label,expected:row.expected,beforeP01:row.beforeP01,hookDecision,hostConfirmation:'not observed',
      actualExecution:'not dispatched',stateRegistration,preIncrement:afterPre-before,
      result:hookDecision===row.expected?'matched':'regression'});
  }
  assert.equal(rows.length,38);
  if(process.env.LP_PROBE_REPORT) fs.writeFileSync(process.env.LP_PROBE_REPORT,JSON.stringify(rows,null,2)+'\n');
  assert.deepEqual(rows.filter(r=>r.result==='regression' || r.preIncrement!==0 ||
    r.stateRegistration.startsWith('missing')),[]);
  t.diagnostic(JSON.stringify(Object.fromEntries(['matched','regression'].map(k=>[k,rows.filter(r=>r.result===k).length]))));
});
