'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const policy = require('./tool-policy.cjs');

// Decision fixtures only. No shell command is dispatched.
const fixture = path.join(os.tmpdir(), 'policy fixture');
const source = path.join(fixture, 'harness');
const guarded = path.join(source,'core','fixture.txt');
const outside = path.join(fixture,'work','file.txt');
const quote = value => '"' + value + '"';
function decision(command, cwd = null) {
  return policy.protect({tool_name:'Bash', tool_input:{command}, cwd:__dirname}, null,
    {source,state:path.join(fixture,'state'),cwd})?.decision || 'allow';
}

test('native and shell file operations preserve permissions across equivalent path forms', () => {
  const roots = {source, state:path.join(fixture,'state')};
  // A sibling with a shared name prefix exercises the directory boundary.
  const sibling = path.join(source, 'core-tools', 'fixture.txt');
  for (const [file, writeDecision] of [[guarded, 'deny'], [sibling, 'allow']]) {
    const relative = path.relative(fixture, file);
    for (const [target, cwd] of [[file, null], [file, fixture], [relative, fixture], [relative, null]]) {
      const expectedWrite = target === relative && !cwd ? 'force_ask' : writeDecision;
      for (const [tool, verb, expected] of [
        ['Read', 'Get-Content', 'allow'],
        ['Write', 'Set-Content', expectedWrite],
      ]) {
        const payload = {tool_name:tool, tool_input:{file_path:target}};
        const native = policy.protect(payload, null, {...roots, cwd})?.decision || 'allow';
        const cmd = verb + ' -LiteralPath ' + quote(target) + (tool === 'Write' ? ' -Value fixture' : '');
        assert.equal(native, expected, tool + ' ' + target + ' cwd=' + cwd);
        assert.equal(decision(cmd, cwd), expected, cmd + ' cwd=' + cwd);
      }
    }
  }
});

test('only real output targets and write operands are protected outside a workspace', () => {
  for (const suffix of [' 2>$null',' 2>&1',' >$null',' > NUL']) {
    assert.equal(decision('Get-ChildItem ' + quote(path.dirname(guarded)) + suffix),'allow');
  }
  assert.equal(decision('node -e "console.log([1].map(x => x + 1))"'),'allow');
  assert.equal(decision('Remove-Item -LiteralPath ' + quote(outside)), 'allow');
  assert.equal(decision('Set-Content -Path relative.txt -Value fixture'),'force_ask');
  assert.equal(decision('Get-ChildItem ' + quote(outside) + ' > ' + quote(guarded)),'deny');
  assert.equal(decision('Copy-Item ' + quote(guarded) + ' ' + quote(outside)), 'allow');
  assert.equal(decision('Set-Content -Encoding UTF8 -Value fixture '+quote(guarded),fixture),'deny');
  assert.equal(decision('Set-Content -Value fixture '+quote(outside),null),'allow');
  assert.equal(decision('Remove-Item '+quote(outside)+' '+quote(guarded),fixture),'deny');
  assert.ok(['force_ask','deny'].includes(decision('Set-Content -Path '+quote(outside)+','+quote(guarded)+' -Value fixture',fixture)));
  assert.equal(decision('> '+quote(guarded)+' echo fixture',fixture),'deny');
});

test('shell wrappers inspect inner redirection, scripts and computed write targets require review', () => {
  for (const command of ['cmd /c','powershell -Command','bash -c']) {
    assert.equal(decision(command + ' \'echo fixture > "' + guarded + '"\''),'deny');
  }
  assert.equal(decision('pwsh -File sample.ps1'),'force_ask');
  assert.equal(decision('.\\sample.ps1'),'force_ask');
  assert.equal(decision('pwsh -NoProfile sample.ps1'),'force_ask');
  assert.equal(decision('cmd /c "git status"',fixture),'allow');
  const nested = "cmd /c 'powershell -Command " + quote('Set-Content ' + quote(guarded) + ' fixture') + "'";
  assert.ok(['deny','force_ask'].includes(decision(nested,fixture)));
  assert.equal(decision("Set-Content ($prefix + 'file.txt') fixture", fixture),'force_ask');
});

test('git show accepts numeric reflog revisions while executable blocks still request review', () => {
  assert.equal(decision('git show HEAD@{1}', fixture), 'allow');
  assert.equal(decision('git log -n 1 HEAD@{1}', fixture), 'force_ask');
  assert.equal(decision('git -C ' + quote(source) + ' show refs/heads/topic@{12}', fixture), 'allow');
  assert.equal(decision('git show HEAD@{1} {fixture}', fixture), 'force_ask');
  assert.equal(decision('Get-ChildItem | Where-Object { $_.Length -gt 0 }', fixture), 'force_ask');
});

test('stream writer constructors and WebClient downloads bind only their destination', () => {
  for (const [destination, expected] of [[guarded, 'deny'], [outside, 'allow']]) {
    for (const expression of [
      'New-Object System.IO.StreamWriter ' + quote(destination),
      'New-Object -TypeName IO.StreamWriter -ArgumentList ' + quote(destination),
      '[System.IO.StreamWriter]::new(' + quote(destination) + ', $false)',
      '[System.Net.WebClient]::new().DownloadFile("https://example.invalid/data", ' + quote(destination) + ')',
    ]) assert.equal(decision(expression, fixture), expected);
  }
  assert.equal(decision('[IO.StreamWriter]::new($destination)', fixture), 'force_ask');
  assert.equal(decision('[Net.WebClient]::new().DownloadFile($source, $destination)', fixture), 'force_ask');
  assert.equal(decision("Write-Output '[IO.StreamWriter]::new(\"fixture\")'", fixture), 'allow');
});

test('New-Object file constructors bind the path before PowerShell overload arguments', () => {
  for (const [target, expected] of [[guarded, 'deny'], [outside, 'allow']]) {
    const directory = path.dirname(target);
    for (const input of [
      'New-Object System.IO.FileStream ' + quote(target) + ', Create',
      'New-Object -ArgumentList ' + quote(target) + ',Open,Read -TypeName IO.FileStream',
      'New-Object IO.FileInfo ' + quote(target),
      'New-Object -TypeName System.IO.DirectoryInfo -ArgumentList ' + quote(directory),
    ]) assert.equal(decision(input, fixture), expected, input);
  }
  assert.equal(decision('New-Object IO.FileStream $target, Create', fixture), 'force_ask');
  assert.equal(decision('New-Object IO.FileStream', fixture), 'force_ask');
  assert.equal(decision('New-Object System.Text.StringBuilder "IO.FileInfo"', fixture), 'allow');
  assert.equal(decision('[IO.File]::Exists(' + quote(guarded) + ')', fixture), 'allow');
});

test('repository worktree and archive/copy destinations are inspected', () => {
  for (const op of ['checkout -- core/fixture.txt','restore core/fixture.txt','stash','clean -n','reset','apply input.patch','pull']) {
    assert.equal(decision('git -C ' + quote(source) + ' ' + op), op === 'clean -n' ? 'allow' : 'deny',op);
  }
  assert.equal(decision('git -C '+quote(source)+' stash list'),'allow');
  for (const command of ['robocopy "from" '+quote(path.dirname(guarded))+' /MIR','xcopy "from" '+quote(path.dirname(guarded)),
    'Expand-Archive -Path example.zip -DestinationPath '+quote(path.dirname(guarded)),
    'tar -xf archive.tar -C '+quote(path.dirname(guarded))]) {
    assert.equal(decision(command,fixture), 'deny');
  }
});

test('relative writes follow literal directory changes and dynamic targets request review', () => {
  assert.equal(decision('cd '+quote(path.dirname(guarded))+'; Set-Content fixture.txt data', fixture),'deny');
  assert.equal(decision('cd '+quote(path.dirname(outside))+'; Set-Content fixture.txt data', fixture),'allow');
  assert.equal(decision('Set-Location $destination; Set-Content fixture.txt data', fixture),'force_ask');
});

test('PowerShell aliases use the same directory and operand rules as the full verb', () => {
  for (const alias of ['ri','sc','ac','clc','mi','ren','ni','rni']) {
    assert.equal(decision(alias + ' '+quote(guarded)), 'deny', alias);
  }
  assert.equal(decision('cpi '+quote(outside)+' '+quote(guarded)), 'deny');
  assert.equal(decision('cpi '+quote(guarded)+' '+quote(outside)), 'allow');
  assert.equal(decision('sl '+quote(path.dirname(guarded))+'; ni fixture.txt'), 'deny');
  assert.equal(decision('ri '+quote(outside)), 'allow');
});

test('inline data and in-memory operations do not turn unrelated path literals into writes', () => {
  const resource = guarded.split(path.sep).join('/');
  const sample = verb => 'node -e ' + quote(`require('${resource}'); ${verb}`);
  assert.equal(decision(sample("console.log('fs.rmSync(sample) .replace( .append( .copy(')"),fixture),'allow');
  assert.equal(decision(sample("'fixture'.replace('x','y')"),fixture),'allow');
  assert.equal(decision(sample("process.stdout.write('fixture')"),fixture),'allow');
  assert.equal(decision('python -c ' + quote(`label='${resource}'; items=[]; items.append(label); data={}; data.copy()`),fixture),'allow');
});

test('inline file APIs bind actual operands and request review for unresolved targets', () => {
  const resource = guarded.split(path.sep).join('/'), scratch = outside.split(path.sep).join('/');
  const inline = (runtime, program) => decision(runtime + ' ' + quote(program),fixture);
  assert.equal(inline('node -e', `require('${resource}'); fs.mkdirSync('${scratch}'); fs.rmSync('${scratch}')`),'allow');
  assert.equal(inline('node -e', `fs.writeFileSync('${scratch}', '${resource}')`),'allow');
  assert.equal(inline('node -e', `fs.copyFileSync('${scratch}', '${resource}')`),'deny');
  assert.equal(inline('node -e', `require('${resource}'); fs.rmSync(selectedPath)`),'force_ask');
  assert.equal(inline('python -c', `os.replace('${scratch}', '${resource}')`),'deny');
  assert.equal(inline('python -c', `open('${resource}', mode='w')`),'force_ask');
  assert.equal(inline('python -c', `import os as files; files.replace('${scratch}', '${resource}')`),'deny');
  assert.equal(inline('python -c', `p=Path(selectedPath); p.replace('${scratch}')`),'force_ask');
  assert.equal(inline('python -c', `Path('${resource}').open('w')`),'deny');
  assert.equal(inline('python -c', `Path('${resource}').open('r')`),'allow');
  assert.equal(inline('python -c', `shutil.copyfile('${resource}', '${scratch}')`),'allow');
  assert.equal(inline('node -e', `fs.readFileSync('${path.join(fixture,'.env').split(path.sep).join('/')}')`),'deny');
});

test('static file APIs and inline interpreter mutations require a policy decision', () => {
  // The synthetic directory has no real resources. Commands are decision input.
  for (const expression of [
    '[System.IO.File]::WriteAllText(' + quote(guarded) + ', "fixture")',
    "node -e " + quote("fs.renameSync('sample-a', 'sample-b')"),
    "python -c " + quote("shutil.copyfile('sample-a', 'sample-b')"),
  ]) assert.notEqual(decision(expression,fixture),'allow');
  assert.equal(decision('node helper.js',fixture),'allow');
  assert.equal(decision('python helper.py',fixture),'allow');
  assert.equal(decision('[IO.File]::ReadAllText(' + quote(guarded) + ')',fixture),'allow');
  assert.equal(decision('[IO.File]::ReadAllText(' + quote(path.join(fixture,'.env')) + ')',fixture),'deny');
  assert.equal(decision('node -e "console.log([1].map(x => x + 1))"',fixture),'allow');
});

test('uncertain shell evaluation is sent for review using inert marker expressions', () => {
  for (const sourceText of ['fixture\x60mark arg', 'fixture^mark arg',
    'Write-Output "$(Get-Date)"','ForEach-Object{Write-Output fixture}']) {
    assert.equal(decision(sourceText, fixture), 'force_ask');
  }
  assert.equal(decision("Write-Output 'literal {fixture}'", fixture),'allow');
});

test('git worktree and configuration queries remain available while mutations are checked', () => {
  const git = 'git -C' + quote(source) + ' ';
  for (const op of ['rm -- sample.txt','mv old.txt new.txt','config fixture.key fixture-value','worktree add sample']) {
    assert.equal(decision(git + op, fixture),'deny',op);
  }
  for (const op of ['status','config -l','config --get fixture.key','config fixture.key','worktree list']) {
    assert.equal(decision(git + op, fixture),'allow',op);
  }
});

test('download output options check the destination and keep standard output available', () => {
  for (const download of ['curl --output ', 'curl -o', 'wget -O ', 'Invoke-WebRequest -OutFile ', 'iwr -OutFile ']) {
    assert.equal(decision(download + quote(guarded) + ' https://example.invalid/fixture',fixture),'deny');
    assert.equal(decision(download + quote(outside) + ' https://example.invalid/fixture',fixture),'allow');
  }
  assert.equal(decision('curl https://example.invalid/fixture', fixture),'allow');
  assert.equal(decision('wget -qO- https://example.invalid/fixture', path.dirname(guarded)),'allow');
});

test('REST and curl aliases bind the output operand independently of flags and data', () => {
  const url = 'https://example.invalid/fixture';
  for (const [target, expected] of [[guarded,'deny'], [outside,'allow']]) {
    for (const cmd of ['irm','Invoke-RestMethod']) {
      assert.equal(decision(cmd+' '+url+' -OutFile '+quote(target),fixture), expected, cmd);
    }
    for (const flags of ['-vso','-4iLo','-6sD']) {
      assert.equal(decision('curl '+flags+' '+quote(target)+' '+url,fixture), expected, flags);
      assert.equal(decision('curl '+flags+quote(target)+' '+url,fixture), expected, flags);
    }
  }
  assert.equal(decision('irm '+url, fixture),'allow');
  assert.equal(decision('curl -vso- '+url,path.dirname(guarded)), 'allow');
  // The option's value can itself resemble an output option.
  for (const option of ['-vA','--user-agent']) {
    assert.equal(decision('curl '+option+' "-o" '+quote(guarded)+' '+url,fixture), 'allow');
  }
  const tempOutput = '--output-dir '+quote(path.dirname(outside))+' -o file.txt '+url;
  assert.equal(decision('curl '+tempOutput,path.dirname(guarded)), 'allow');
  assert.equal(decision('curl -o file.txt '+url+' --next '+tempOutput,path.dirname(guarded)), 'deny');
});

test('launcher aliases request review and rename binds names relative to the source', () => {
  for (const launcher of ['Start-Process','saps','start','Invoke-Command','icm','wsl','wsl.exe']) {
    assert.equal(decision(launcher+' fixture',fixture), 'force_ask',launcher);
  }
  const draft = path.join(source,'draft.txt');
  for (const cmd of ['rename','cmd /c rename','ren','Rename-Item']) {
    assert.equal(decision(cmd+' '+quote(guarded)+' draft.txt',fixture), 'deny',cmd);
    assert.equal(decision(cmd+' '+quote(draft)+' settings.json',fixture), 'deny',cmd);
    assert.equal(decision(cmd+' '+quote(outside)+' draft.txt',fixture), 'allow',cmd);
  }
});

test('curl diagnostic files resolve in the command directory independently of transfer output', () => {
  for (const option of ['--trace', '--trace-ascii', '--stderr']) {
    for (const separator of [' ', '=']) {
      for (const [file, expected] of [[guarded,'deny'], [outside,'allow'], ['$destination','force_ask']]) {
        assert.equal(decision('curl '+option+separator+quote(file),fixture), expected, option);
      }
    }
    const name = 'diagnostics.log';
    assert.equal(decision('curl --output-dir '+quote(path.dirname(outside))+' '+option+' '+name,path.dirname(guarded)), 'deny');
    assert.equal(decision('curl --output-dir '+quote(path.dirname(guarded))+' '+option+' '+name,path.dirname(outside)), 'allow');
    assert.equal(decision('curl '+option+' -',path.dirname(guarded)), 'allow');
    assert.equal(decision('curl --user-agent '+quote(option)+' '+quote(guarded),fixture), 'allow');
  }
  for (const option of ['--trace', '--trace-ascii']) {
    assert.equal(decision('curl '+option+' %',path.dirname(guarded)), 'allow');
  }
  assert.notEqual(decision('curl --stderr %',path.dirname(guarded)), 'allow');
});
