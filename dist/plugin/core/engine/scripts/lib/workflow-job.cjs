'use strict';

// Internal adapter API. Callers authorize the executable and its arguments before
// submission and choose a private state directory outside project-controlled inputs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const {spawn, spawnSync} = require('node:child_process');
const {atomicWriteJson} = require('./project-scope.cjs');

const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const digest = /^[a-f0-9]{64}$/;
const active = status => status === 'queued' || status === 'running';
const clock = () => new Date().toISOString();
const read = file => JSON.parse(fs.readFileSync(file,'utf8'));
const write = (file, data) => atomicWriteJson(file,data,{retryBusyRename:true});

function location(stateDir, id) {
  if (!path.isAbsolute(stateDir) || !digest.test(id)) throw new Error('Expected absolute job directory and SHA-256 job ID');
  return path.join(stateDir,id);
}

function workflowEnvironment(overrides = {}) {
  const env = {};
  const key = name => process.platform === 'win32' ? name.toUpperCase() : name;
  for (const name of ['PATH','SystemRoot','WINDIR','ComSpec','PATHEXT','PROCESSOR_ARCHITECTURE','PROCESSOR_ARCHITEW6432','TMPDIR','TEMP','TMP','HOME','USERPROFILE',
    'APPDATA','LOCALAPPDATA','LANG','LC_ALL']) {
    if (process.env[name] !== undefined) env[key(name)] = process.env[name];
  }
  if (process.platform === 'win32' && !env.PROCESSOR_ARCHITECTURE) {
    // A GUI host may omit the system variable; vendor batch launchers use the
    // process architecture and otherwise return an unexplained exit code 1.
    const native = {x86_64:'AMD64',arm64:'ARM64',aarch64:'ARM64',i386:'x86',i686:'x86'}[os.machine()];
    if (native) env.PROCESSOR_ARCHITECTURE = native;
  }
  for (const [name,value] of Object.entries(overrides)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof value !== 'string' || value.includes('\0') ||
        /^(?:NODE_OPTIONS|LD_PRELOAD|DYLD_INSERT_LIBRARIES)$/i.test(name)) throw new Error('Invalid workflow environment override');
    env[key(name)] = value;
  }
  return Object.fromEntries(Object.keys(env).sort().map(name => [name,env[name]]));
}

function submitJob({stateDir,cwd,action,executable,args = [],inputDigest,attempt = 1,timeoutMs = 0,env = {},evidenceScope,recoverDead = false}) {
  if (!path.isAbsolute(cwd) || !path.isAbsolute(executable) || !digest.test(inputDigest) ||
      typeof action !== 'string' || !action.trim() || !Number.isSafeInteger(attempt) || attempt < 1 ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2147483647 ||
      !Array.isArray(args) || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid workflow job specification');
  if (!fs.statSync(cwd).isDirectory()) throw new Error('Expected a working directory');
  const childEnv = workflowEnvironment(env);
  const request = {action,cwd:fs.realpathSync(cwd),executable:path.normalize(executable),args,inputDigest,attempt,timeoutMs,
    environmentDigest:sha(childEnv)};
  if (evidenceScope !== undefined) {
    if (!digest.test(evidenceScope) || Object.keys(childEnv).some(k => k.toUpperCase() === 'HARNESS_WORKFLOW_EVIDENCE')) {
      throw new Error('Invalid workflow evidence scope or reserved output override');
    }
    request.evidenceScope = evidenceScope;
  }
  const jobId = sha(request);
  const dir = location(stateDir,jobId);
  // Derive the output from the complete physical identity after hashing it.
  const evidencePath = evidenceScope && path.join(dir,'result','evidence.json');
  fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
  try { fs.mkdirSync(dir,{mode:0o700}); }
  catch (error) {
    if (error.code === 'EEXIST') {
      const existing = readJob(stateDir,jobId);
      if (!(recoverDead === true && ['lost','cancelled','timed_out'].includes(existing.status))) {
        return {...existing,reused:true};
      }
      const archiveDir = path.join(stateDir,'dead-'+jobId.slice(0,16)+'-'+Date.now()+'-'+process.pid);
      try { fs.renameSync(dir,archiveDir); }
      catch (renameErr) { if (renameErr.code !== 'ENOENT') throw renameErr; }
      try { fs.mkdirSync(dir,{mode:0o700}); }
      catch (retryErr) {
        if (retryErr.code === 'EEXIST') return {...readJob(stateDir,jobId),reused:true};
        throw retryErr;
      }
    } else throw error;
  }
  const receipt = {jobId,action,inputDigest,attempt,status:'queued',submittedAt:clock(),startedAt:null,finishedAt:null,
    exitCode:null,logPath:path.join(dir,'output.log')};
  if (evidencePath) receipt.evidencePath = evidencePath;
  const receiptFile = path.join(dir,'receipt.json');
  write(receiptFile,receipt);
  const failedLaunch = err => write(receiptFile,{...receipt,status:'failed',finishedAt:clock(),error:err.message});
  try {
    if (evidencePath) {
      fs.mkdirSync(path.dirname(evidencePath),{mode:0o700});
      childEnv.HARNESS_WORKFLOW_EVIDENCE = evidencePath;
    }
    write(path.join(dir,'request.json'),request);
    const worker = spawn(process.execPath,[__filename,'--supervise',stateDir,jobId],{
      stdio:'ignore',detached:true,windowsHide:true,env:{...childEnv},shell:false});
    worker.once('error',failedLaunch);
    worker.unref();
  } catch (error) { failedLaunch(error); }
  return {...readJob(stateDir,jobId),reused:false};
}

function readJob(stateDir,jobId) {
  const dir = location(stateDir,jobId);
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid workflow job directory');
  let entry;
  try { entry = read(path.join(dir,'receipt.json')); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // The winning submitter reserved its directory before publishing its receipt.
    entry = {jobId,status:'queued',submittedAt:stat.birthtime.toISOString(),exitCode:null,logPath:path.join(dir,'output.log')};
  }
  if (entry.jobId !== jobId || !['queued','running','succeeded','failed','cancelled','timed_out','lost'].includes(entry.status) ||
      !Number.isFinite(Date.parse(entry.submittedAt)) || (entry.status === 'running' && (!Number.isSafeInteger(entry.workerPid) ||
      entry.workerPid <= 0 || !Number.isFinite(Date.parse(entry.heartbeatAt)))) ||
      (entry.status === 'succeeded' && (entry.exitCode !== 0 || !Number.isFinite(Date.parse(entry.finishedAt)))))
    throw new Error('Invalid workflow receipt');
  let lost = entry.status === 'queued' && Date.now()-Date.parse(entry.submittedAt)>60000;
  if (entry.status === 'running') {
    try { process.kill(entry.workerPid,0); } catch (error) { if (error.code === 'ESRCH') lost = true; else if (error.code !== 'EPERM') throw error; }
    if (Date.now()-Date.parse(entry.heartbeatAt)>60000) lost = true;
  }
  if (!lost) return entry;
  // A supervisor may have written its final receipt and exited between the
  // first read and the liveness check. Prefer that durable result.
  try {
    const latest = read(path.join(dir,'receipt.json'));
    if (latest.status !== entry.status || latest.heartbeatAt !== entry.heartbeatAt) return readJob(stateDir,jobId);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Do not signal a recycled PID or silently start a replacement.
  return {...entry,status:'lost',exitCode:null,error:'No live supervisor receipt'};
}

function cancelJob(stateDir,jobId) {
  const receipt = readJob(stateDir,jobId);
  if (active(receipt.status)) fs.closeSync(fs.openSync(path.join(location(stateDir,jobId),'cancel'),'a',0o600));
  return receipt;
}

async function waitJob(stateDir,jobId) {
  const dir = location(stateDir,jobId);
  const initial = readJob(stateDir,jobId);
  if (!active(initial.status)) return initial;
  // Notifications are local. Only a terminal receipt resolves the host request.
  return new Promise((resolve,reject) => {
    let watcher;
    const timer = setInterval(check,2000); // Covers missed filesystem events and owner death.
    function finish(fn,value) { clearInterval(timer); watcher?.close(); fn(value); }
    function check() {
      try { const entry = readJob(stateDir,jobId); if (!active(entry.status)) finish(resolve,entry); }
      catch (error) { finish(reject,error); }
    }
    try {
      watcher = fs.watch(dir,(_event,name) => { if (!name || name === 'receipt.json') check(); });
      watcher.on('error',() => watcher.close());
    } catch {}
    check();
  });
}

async function supervise(stateDir,jobId) {
  const dir = location(stateDir,jobId);
  const file = path.join(dir,'receipt.json');
  const receipt = read(file);
  if (receipt.status !== 'queued' || receipt.jobId !== jobId) throw new Error('Job already claimed');
  const claim = path.join(dir,'supervisor');
  fs.closeSync(fs.openSync(claim,'wx',0o600));
  let log, heartbeat, deadline, watcher;
  try {
    const spec = read(path.join(dir,'request.json'));
    if (sha(spec) !== jobId) throw new Error('Job specification changed');
    log = fs.openSync(receipt.logPath,'wx',0o600);
    const cancelFile = path.join(dir,'cancel');
    if (fs.existsSync(cancelFile)) { receipt.status='cancelled'; return; }
    Object.assign(receipt,{status:'running',workerPid:process.pid,startedAt:clock(),heartbeatAt:clock()});
    write(file,receipt);
    const child = spawn(spec.executable,spec.args,{cwd:spec.cwd,env:process.env,stdio:['ignore',log,log],shell:false,
      windowsHide:true,detached:process.platform !== 'win32'});
    let interruption;
    function stop(status) {
      if (interruption || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
      interruption = status;
      if (process.platform === 'win32') {
        const sys = path.join(process.env.SystemRoot,'System32','taskkill.exe');
        const result = spawnSync(sys,['/PID',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true,timeout:10000});
        if (result.status !== 0) child.kill();
      } else {
        try { process.kill(-child.pid,'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') child.kill('SIGKILL'); }
      }
    }
    function checkCancel() { if (fs.existsSync(cancelFile)) stop('cancelled'); }
    heartbeat = setInterval(() => { receipt.heartbeatAt=clock(); write(file,receipt); checkCancel(); },5000);
    if (spec.timeoutMs) deadline = setTimeout(() => stop('timed_out'),spec.timeoutMs);
    try {
      watcher = fs.watch(dir,(_event,name) => { if (!name || name === 'cancel') checkCancel(); });
      watcher.on('error',() => watcher.close());
    } catch {}
    checkCancel();
    const result = await new Promise((resolve,reject) => {
      child.once('error',reject);
      child.once('close',(exitCode,signal) => resolve({exitCode,signal}));
    });
    Object.assign(receipt,result,{status:interruption || (result.exitCode === 0 ? 'succeeded' : 'failed')});
  } catch (error) {
    Object.assign(receipt,{status:'failed',error:error.message});
  } finally {
    clearInterval(heartbeat); clearTimeout(deadline); watcher?.close();
    if (log !== undefined) fs.closeSync(log);
    write(file,{...receipt,finishedAt:clock()});
  }
}

module.exports = {submitJob,readJob,waitJob,cancelJob,workflowEnvironment};
if (require.main === module) {
  if (process.argv.length !== 5 || process.argv[2] !== '--supervise') process.exitCode = 2;
  else supervise(process.argv[3],process.argv[4]).catch(() => { process.exitCode = 1; });
}
